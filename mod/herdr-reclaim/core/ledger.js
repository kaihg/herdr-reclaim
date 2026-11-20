// 城帳本：append-only journal + CAS + checkpoint（proposal §13.1，ticket #3／#4）。
//
// 這一層是純 JS：所有檔案 I/O 都走呼叫端給的 `io`（`read`／`write` 兩個非同步函式）。
//
// **儲存介面的契約**：`io.write(path, text, expected)` 只在快照不符（`expected` 不是現在
// 的內容，`expected === null` 代表建立新檔）時拒絕，而且**一律拒絕成 `CasConflict`**；
// 其他錯誤（權限、磁碟…）原樣往上丟。mod 端由 `core/host-io.js` 把 herdr 的原生錯誤
// 轉成 `CasConflict`；bun 測試的後端（test/fs-io.js）直接說同一種語言。
//
// **容量（ticket #4）**：herdr 讀一次檔案的上限是 1 MiB，帳本自訂**每個可成長的檔案都
// ≤ `SEGMENT_LIMIT`（256 KiB）**：
//   head.json                       固定欄位：schemaVersion、rulesVersion、cityId、segment、checkpoint
//   journal/<n>.json                ndjson；每段 ≤ limit，滿了就封段換下一段
//   blobs/<hash>.json               內容檔（core/blobs.js）；超過上限的內容切塊＋多層 manifest
//   checkpoints/<seq>/manifest.json 小型索引；衍生狀態放在同層的其他檔案
//   checkpoints/<seq>/ops|claims|expeditions|activities/   可延長前綴的雜湊分頁（core/pages.js）
//   checkpoints/<seq>/chunk-index/ + chunks/<cx>_<cy>.json 座標分塊（32×32 格）
//   acks/<sessionId>/<epoch>.json   adapter 的 ack；journal 成功之後才寫
//
// **沒有任何 listdir**：herdr 的 mod 只有 readTextFile／writeTextFile，所以走訪一律靠
// 根頁與拆分標記自己記的子前綴（pages.js），不掃資料夾。checkpoint 因此也不需要記住
// 檔名清單，只有固定大小的 manifest。
//
// 唯一完成依據是 journal entry：只有內容檔、沒有 entry 的操作不算完成（§13.1）。
//
// **這一票的語意邊界**：帳本只做「操作怎麼落帳、怎麼重播、怎麼查」。
//   - 收成的**點數與資源向量由 entry 自己帶**（§7.3 的規則屬於收成票）。帳本不會自己發明
//     一個固定值——S3 spike 的 `applyEntry()` 寫死 +100 就是這一條的反例。
//   - 土地生命週期（撤回／封存／重新派遣的條件）屬於 #7；這一票只提供 generation 的身份
//     與「一筆操作指定的 generation 必須是這支遠征的現役 generation」這個前提檢查。
import { BlobStore } from "./blobs.js";
import { byteLen, canonicalJson, hashText } from "./bytes.js";
import { casWrite, rejectUnlessConflict } from "./cas.js";
import { PrefixIndex } from "./pages.js";
import { BOOST_POINTS_PER_PARCHMENT, CLEAR_POINTS, RECIPES, RESEARCH_TOKENS_PER_PARCHMENT, RESOURCES, RULES_VERSION, TRADE_RATE, affordable } from "./rules.js";

export { byteLen, hashText };

/** 帳本目錄格式的版本（head.json 的 schemaVersion）。 */
export const SCHEMA = 2;
/** 活動紀錄的格式版本：`core/town.js` 的重播就是認這個號碼。 */
export const ACTIVITY_SCHEMA = 1;
/** 規則表版本（core/rules.js）：每一筆 entry 都存當時的版本（§8.2）。 */
export { RULES_VERSION };

/** §13.1：每段上限 256 KiB；herdr 單檔讀取上限是 1 MiB。 */
export const SEGMENT_LIMIT = 256 * 1024;

/** 每段預留封段行的空間，讓「封段」一定還在單段上限之內。 */
export const SEAL_RESERVE = 96;

/** §13.1：座標分塊的邊長（格）。 */
export const CHUNK_SIDE = 32;

/** 預設每幾筆 entry 就主動做一次 checkpoint（mod 開機時呼叫 `maybeCheckpoint`）。 */
export const CHECKPOINT_EVERY = 512;

/** CAS 失敗就重讀、重新檢查、再試；連續失敗到這個次數才放棄。 */
const MAX_ATTEMPTS = 8;

/**
 * 只有 CAS 衝突可以重試；`CasConflict`／`casConflictOf`／`casWrite` 由 core/cas.js 提供，
 * 帳本再轉出去給 host-io 與測試後端使用（它們只認這一個接縫）。
 */
export { CasConflict, casConflictOf } from "./cas.js";

/** 故障注入用：內容檔已寫、journal 還沒附加時中斷。 */
export class CrashAfterContent extends Error {
  constructor(opId) {
    super(`內容已寫、journal 未附加：${opId}`);
    this.name = "CrashAfterContent";
    this.opId = opId;
  }
}

/** 故障注入用：journal 已附加、還沒回覆時中斷。 */
export class CrashAfterJournal extends Error {
  constructor(opId) {
    super(`journal 已附加、回覆前中斷：${opId}`);
    this.name = "CrashAfterJournal";
    this.opId = opId;
  }
}

/** 城的目錄名：cityId 是絕對路徑，不能直接當檔名。 */
export function cityDir(baseDir, cityId) {
  return `${baseDir}/cities/${hashText(cityId)}`;
}

/** 一個 journal 段的內容：entry 陣列，最後可能有一行封段標記。 */
export function parseSegment(text) {
  const entries = [];
  let sealed = false;
  let sealSeq = null;
  let sealNext = null;
  for (const line of String(text ?? "").split("\n")) {
    if (line === "") continue;
    if (sealed) throw new Error("封段標記之後還有 entry");
    const parsed = JSON.parse(line);
    if (parsed.seal !== undefined) {
      sealed = true;
      sealSeq = parsed.seal;
      sealNext = parsed.next;
      continue;
    }
    entries.push(parsed);
  }
  return { entries, sealed, sealSeq, sealNext };
}

/** 一格座標在這座城的身分（佔位用）。 */
export const tileKey = (cityId, x, y) => `${cityId}@@${x},${y}`;
/** 一支遠征的一個 generation 的身分（格子鍵要含 generation，重新派遣才不會撞到上一代）。 */
export const tileId = (cityId, rootSessionId, generation) => `${cityId}@@${rootSessionId}@@${generation ?? 1}`;
/** §7.3 的城級去重鍵：同一座城同一份成果只發一次。 */
export const claimKey = (cityId, claim) => `${cityId}@@${claim}`;
export const activityKey = (record) => `${record.sessionId}@@${record.writerEpoch ?? ""}`;
/** 座標分塊的名字（32×32 格）。 */
export const chunkName = (x, y) => `${Math.floor(x / CHUNK_SIDE)},${Math.floor(y / CHUNK_SIDE)}`;

const zeroResources = () => Object.fromEntries(RESOURCES.map((key) => [key, 0]));

/**
 * 空狀態。`tiles`／`activities` 的順序就是 journal 的附加順序，重播結果因此可重現。
 * `opSeqs`／`claims` 是索引（§13.2）；`currentGen` 是每支遠征的現役 generation。
 * `research.tokens` 是這座城還沒換成羊皮卷的研究進度（餘數，§7.4）；
 * `market` 分開記錄市集轉入與轉出，跟 commit 的直接發放分開（§11）。
 */
export function emptyState(cityId) {
  return {
    cityId,
    rulesVersion: RULES_VERSION,
    lastSeq: -1,
    tiles: [],
    tileById: new Map(),
    currentGen: new Map(),
    taken: new Set(),
    activities: new Map(),
    opSeqs: new Map(),
    claims: new Map(),
    resources: zeroResources(),
    research: { tokens: 0 },
    market: { in: zeroResources(), out: zeroResources() },
  };
}

/** 一格的總開墾點：自然工作、收成與加速分開保存，再加總（§10）。 */
export function pointsOf(tile) {
  return Number(tile?.workPoints ?? 0) + Number(tile?.harvestPoints ?? 0) + Number(tile?.boostPoints ?? 0);
}

/** 一格現在的階段；舊 entry 沒有 `landStage` 時由點數推得（§10）。 */
export function stageOf(tile) {
  return tile?.landStage ?? (pointsOf(tile) >= CLEAR_POINTS ? "cleared" : "reserved");
}

/** 開墾點一滿就把階段推進到已開墾；已撤回／已封存／已建不覆寫。 */
function settleStage(tile) {
  if (!tile.landStage && pointsOf(tile) >= CLEAR_POINTS) tile.landStage = "cleared";
  return tile;
}

/** 操作指定的遠征 generation 必須是現役的那一代（#7 的身份規則）。 */
function targetTile(state, op) {
  const generation = op.generation ?? 1;
  if (state.currentGen.get(`${op.cityId}@@${op.rootSessionId}`) !== generation) return null;
  return state.tileById.get(tileId(op.cityId, op.rootSessionId, generation)) ?? null;
}

/** 實付資源必須就是規則表裡的那份配方，不能少扣或多扣（§7.6）。 */
function sameCosts(costs, recipe) {
  const entries = Object.entries(costs ?? {});
  const expected = Object.entries(recipe ?? {});
  return entries.length === expected.length &&
    expected.every(([key, need]) => Number(costs[key]) === Number(need));
}

/** 把一格放進狀態（順序由呼叫端決定；`tiles` 的順序就是重播順序）。 */
export function addTile(state, tile) {
  state.tiles.push(tile);
  state.tileById.set(tileId(tile.cityId, tile.rootSessionId, tile.generation), tile);
  if (tile.landStage !== "withdrawn") state.taken.add(tileKey(tile.cityId, tile.x, tile.y));
  const key = `${tile.cityId}@@${tile.rootSessionId}`;
  const current = state.currentGen.get(key) ?? 0;
  if ((tile.generation ?? 1) > current) state.currentGen.set(key, tile.generation ?? 1);
  return tile;
}

/**
 * 每一種 operation 的套用與前提檢查。之後的票（#5／#6／#7／#8）在這裡加新的 kind，
 * entry 只要帶上自己的欄位即可，格式不用改。
 */
const MINUTE_MS = 60_000;

/** Intervals clipped to a generation's activation window, then unioned. */
function naturalWorkPoints(state, tile) {
  const parentById = new Map([...state.activities.values()].map((record) => [record.sessionId, record.parentSessionId]));
  const rootOf = (sessionId) => {
    const seen = new Set();
    let current = sessionId;
    while (parentById.get(current) && !seen.has(current)) {
      seen.add(current);
      current = parentById.get(current);
    }
    return current;
  };
  const intervals = [];
  for (const record of state.activities.values()) {
    if (rootOf(record.sessionId) !== tile.rootSessionId) continue;
    let cityId = null;
    let opened = null;
    for (const event of record.events ?? []) {
      if (event.kind === "visit_start") cityId = event.visit?.commonDir ?? null;
      else if (event.kind === "visit_end") {
        if (opened !== null && cityId === tile.cityId) intervals.push([opened, event.at]);
        opened = null;
        cityId = null;
      } else if (event.kind === "interval_open") opened = event.at;
      else if (event.kind === "heartbeat" && opened !== null) {
        if (cityId === tile.cityId) intervals.push([opened, event.at]);
        opened = event.at;
      } else if (event.kind === "interval_close" && opened !== null) {
        if (cityId === tile.cityId) intervals.push([opened, event.at]);
        opened = null;
      }
    }
  }
  const start = Number(tile.activatedAt ?? 0);
  const end = tile.deactivatedAt == null ? Infinity : Number(tile.deactivatedAt);
  const clipped = intervals
    .map(([a, b]) => [Math.max(a, start), Math.min(b, end)])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let from = null;
  let to = null;
  for (const [a, b] of clipped) {
    if (from === null) [from, to] = [a, b];
    else if (a > to) {
      total += to - from;
      [from, to] = [a, b];
    } else to = Math.max(to, b);
  }
  if (from !== null) total += to - from;
  return Math.floor(total / MINUTE_MS);
}

export function generationAt(state, rootSessionId, at) {
  const timestamp = Number(at);
  return state.tiles.find((tile) =>
    tile.rootSessionId === rootSessionId &&
    Number(tile.activatedAt ?? 0) <= timestamp &&
    (tile.deactivatedAt == null || timestamp < Number(tile.deactivatedAt))
  ) ?? null;
}

export const KINDS = {
  /**
   * 遠征取得土地（§4 的自動選地）：座標由呼叫端在 `make` 裡用 BFS 算出來；
   * 前提是那一格還空著、這支遠征的這一代還沒有格、而且 generation 是現役的下一個
   * （重新派遣建立的下一代，#7 的規則）。
   */
  expedition: {
    precheck(state, op) {
      const generation = op.generation ?? 1;
      if (state.tileById.has(tileId(op.cityId, op.rootSessionId, generation))) return "tile_exists";
      if (state.taken.has(tileKey(op.cityId, op.x, op.y))) return "tile_taken";
      const current = state.currentGen.get(`${op.cityId}@@${op.rootSessionId}`);
      if (current === undefined ? generation !== 1 : generation !== current + 1) return "bad_generation";
      if (current !== undefined) {
        const previous = state.tileById.get(tileId(op.cityId, op.rootSessionId, current));
        if (!previous || !["withdrawn", "archived"].includes(previous.landStage)) return "generation_not_released";
      }
      return null;
    },
    apply(state, entry) {
      const tile = addTile(state, {
        seq: entry.journalSeq,
        cityId: entry.cityId,
        rootSessionId: entry.rootSessionId,
        generation: entry.generation ?? 1,
        x: entry.x,
        y: entry.y,
        activatedAt: Number(entry.activatedAt ?? entry.at ?? 0),
        deactivatedAt: null,
        landStage: null,
        workPoints: 0,
        harvestPoints: 0,
        boostPoints: 0,
        harvestedPaths: [],
        cli: entry.cli ?? null,
        repo: entry.repo ?? null,
        harvested: false,
      });
      tile.workPoints = naturalWorkPoints(state, tile);
      settleStage(tile);
    },
  },
  landAction: {
    precheck(state, op) {
      const generation = op.generation ?? 1;
      if (state.currentGen.get(`${op.cityId}@@${op.rootSessionId}`) !== generation) return "stale_generation";
      const tile = state.tileById.get(tileId(op.cityId, op.rootSessionId, generation));
      if (!tile) return "no_expedition";
      if (tile.harvested) return "has_commit_harvest";
      const stage = stageOf(tile);
      if (op.action === "withdraw" && stage !== "reserved") return "not_withdrawable";
      if (op.action === "archive" && stage !== "cleared") return "not_archivable";
      if (op.action !== "withdraw" && op.action !== "archive") return "invalid_action";
      return null;
    },
    apply(state, entry) {
      const generation = entry.generation ?? 1;
      const tile = state.tileById.get(tileId(entry.cityId, entry.rootSessionId, generation));
      tile.landStage = entry.action === "withdraw" ? "withdrawn" : "archived";
      tile.deactivatedAt = Number(entry.at);
      if (entry.action === "withdraw") state.taken.delete(tileKey(entry.cityId, tile.x, tile.y));
    },
  },
  /**
   * 蓋房（§7.6、§8.1）：只列庫存足以支付完整配方的建築；一次扣完整份配方，
   * 並把配方、實付資源與當時的規則版本存進那一格。已建好的格子不能再蓋。
   * 蓋房不影響收成：已建的格子之後 resume 又有新 commit，收成照常發生（§17.1 情境 7）。
   */
  build: {
    precheck(state, op) {
      if (op.cityId !== state.cityId) return "wrong_city";
      const tile = targetTile(state, op);
      if (!tile) return "stale_generation";
      const stage = stageOf(tile);
      if (stage === "withdrawn" || stage === "archived") return "inactive_expedition";
      if (stage === "built") return "already_built";
      if (stage !== "cleared") return "not_cleared";
      const recipe = RECIPES[op.recipe];
      if (!recipe) return "unknown_recipe";
      if (!sameCosts(op.costs, recipe.costs)) return "recipe_mismatch";
      if (!affordable(recipe.costs, state.resources)) return "insufficient_resources";
      return null;
    },
    apply(state, entry) {
      const tile = targetTile(state, entry);
      tile.landStage = "built";
      tile.building = { recipe: entry.recipe, costs: entry.costs, rulesVersion: entry.rulesVersion };
      for (const [key, amount] of Object.entries(entry.costs ?? {})) {
        state.resources[key] = Number(state.resources[key] ?? 0) - Number(amount);
      }
    },
  },
  /**
   * 加速（§7.6）：目標是「遠征身份 + generation」，不是座標。同城、現役、沒撤回或封存、
   * 還佔著原本的座標、未滿 100 點、庫存足夠 —— 只要有一項不符就整筆不扣卷、不加點。
   * 超過 100 的部分不退還，也不會轉到其他格。
   */
  boost: {
    precheck(state, op) {
      if (op.cityId !== state.cityId) return "wrong_city";
      const tile = targetTile(state, op);
      if (!tile) return "stale_generation";
      const stage = stageOf(tile);
      if (stage === "withdrawn" || stage === "archived") return "inactive_expedition";
      if (!state.taken.has(tileKey(op.cityId, tile.x, tile.y))) return "tile_released";
      const scrolls = Number(op.scrolls);
      if (!Number.isInteger(scrolls) || scrolls <= 0) return "invalid_scrolls";
      if (pointsOf(tile) >= CLEAR_POINTS) return "already_cleared";
      if (Number(state.resources.parchment ?? 0) < scrolls) return "insufficient_parchment";
      return null;
    },
    apply(state, entry) {
      const tile = targetTile(state, entry);
      const scrolls = Number(entry.scrolls);
      tile.boostPoints = Number(tile.boostPoints ?? 0) + scrolls * BOOST_POINTS_PER_PARCHMENT;
      tile.scrollsUsed = Number(tile.scrollsUsed ?? 0) + scrolls;
      state.resources.parchment = Number(state.resources.parchment ?? 0) - scrolls;
      settleStage(tile);
    },
  },
  /**
   * 市集（§7.6、§11）：同城任兩種資源 3 換 1，一次一筆 CAS。庫存不足時整筆不執行，
   * 不會產生部分交易。市集轉入與轉出另外記，跟 commit 的直接發放分開（§11）。
   */
  trade: {
    precheck(state, op) {
      if (op.cityId !== state.cityId) return "wrong_city";
      const amount = Number(op.amount);
      const invalid = !RESOURCES.includes(op.from) || !RESOURCES.includes(op.to) || op.from === op.to ||
        !Number.isInteger(amount) || amount <= 0;
      if (invalid) return "invalid_trade";
      if (Number(state.resources[op.from] ?? 0) < amount * TRADE_RATE) return "insufficient_resources";
      return null;
    },
    apply(state, entry) {
      const amount = Number(entry.amount);
      const spent = amount * TRADE_RATE;
      state.resources[entry.from] = Number(state.resources[entry.from] ?? 0) - spent;
      state.resources[entry.to] = Number(state.resources[entry.to] ?? 0) + amount;
      state.market.out[entry.from] = Number(state.market.out[entry.from] ?? 0) + spent;
      state.market.in[entry.to] = Number(state.market.in[entry.to] ?? 0) + amount;
    },
  },
  /**
   * 研究（§7.4）：沒有可歸屬 commit 的回合，把 non-cache input + output token 加進這座城的
   * 計量器；每滿 100,000 換 1 張羊皮卷，餘數按城保留。operation ID 由回合身份決定，
   * 重播不會再次發放；已經落帳的進度與已發的羊皮卷不會因為來源晚到而倒扣。
   */
  research: {
    precheck(_state, op) {
      return Number.isInteger(Number(op.tokens)) && Number(op.tokens) > 0 ? null : "invalid_research";
    },
    apply(state, entry) {
      const tokens = Number(entry.tokens);
      const total = Number(state.research.tokens ?? 0) + tokens;
      state.research.tokens = total % RESEARCH_TOKENS_PER_PARCHMENT;
      const scrolls = Math.floor(total / RESEARCH_TOKENS_PER_PARCHMENT);
      if (scrolls > 0) state.resources.parchment = Number(state.resources.parchment ?? 0) + scrolls;
    },
  },
  /**
   * 活動合併（§6.2）：以 (sessionId, writerEpoch) 為鍵。adapter 收到 ack 後會 compact
   * 磁碟快照，後續 entry 只含未 ack 的尾巴；帳本重播時必須把事件併回舊快照，不能覆蓋它。
   */
  activity: {
    precheck(state, op, blobs) {
      if (!blobs || !Array.isArray(blobs.events)) return "missing_events";
      const current = state.activities.get(activityKey(op));
      if (current && (current.lastEventSeq ?? -1) > (op.lastEventSeq ?? -1)) return "stale_activity";
      return null;
    },
    apply(state, entry, blobs) {
      const key = activityKey(entry);
      const current = state.activities.get(key);
      const bySeq = new Map((current?.events ?? []).map((event) => [event.eventSeq, event]));
      for (const event of blobs?.events ?? []) {
        const prior = bySeq.get(event.eventSeq);
        const resolvedVisit = prior?.kind === "visit_start" && prior.visit?.commonDir &&
          event.kind === "visit_start" && !event.visit?.commonDir;
        bySeq.set(event.eventSeq, resolvedVisit ? { ...event, visit: prior.visit } : event);
      }
      const events = [...bySeq.values()].sort((a, b) => a.eventSeq - b.eventSeq);
      state.activities.set(key, {
        schema: ACTIVITY_SCHEMA,
        seq: entry.journalSeq,
        sessionId: entry.sessionId,
        writerEpoch: entry.writerEpoch,
        role: entry.role ?? current?.role ?? "root",
        interactive: entry.interactive === true || current?.interactive === true,
        parentSessionId: entry.parentSessionId ?? current?.parentSessionId ?? null,
        cli: entry.cli ?? current?.cli ?? null,
        updatedAt: Math.max(current?.updatedAt ?? 0, entry.updatedAt ?? entry.at ?? 0),
        lastEventSeq: Math.max(current?.lastEventSeq ?? -1, entry.lastEventSeq ?? -1),
        events,
      });
      for (const tile of state.tiles) {
        if (tile.landStage) continue;
        tile.workPoints = naturalWorkPoints(state, tile);
        settleStage(tile);
      }
    },
  },
  /**
   * 收成（§7.3）：entry 自己帶 claim（城級去重）、資源向量與開墾點。
   * **前提包含 generation 時間窗**：即使目前已是新一代，晚到收成仍只能落到事件當時
   * 啟用的舊 generation；不會把舊 commit 加進新格。
   */
  harvest: {
    precheck(state, op) {
      const generation = op.generation ?? 1;
      const tile = state.tileById.get(tileId(op.cityId, op.rootSessionId, generation));
      if (!tile) return "no_expedition";
      if (generationAt(state, op.rootSessionId, op.at)?.generation !== generation) return "outside_generation";
      const claims = op.claims ?? (op.claim ? [op.claim] : []);
      if (claims.some((claim) => state.claims.has(claimKey(op.cityId, claim)))) return "claim_exists";
      return null;
    },
    apply(state, entry) {
      const tile = state.tileById.get(tileId(entry.cityId, entry.rootSessionId, entry.generation));
      if (!tile) throw new Error(`收成找不到遠征：${entry.rootSessionId}@${entry.generation}`);
      tile.harvestPoints = (tile.harvestPoints ?? 0) + Number(entry.points ?? 0);
      tile.harvestedPaths = [...new Set([...(tile.harvestedPaths ?? []), ...(entry.paths ?? [])])];
      tile.harvested = tile.harvested || (entry.paths ?? []).length > 0;
      settleStage(tile);
      for (const [name, amount] of Object.entries(entry.resources ?? {})) {
        state.resources[name] = (state.resources[name] ?? 0) + Number(amount);
      }
      for (const claim of entry.claims ?? (entry.claim ? [entry.claim] : [])) {
        state.claims.set(claimKey(entry.cityId, claim), entry.journalSeq);
      }
    },
  },
  /** Commit evidence is journaled even when no trustworthy session source is available. */
  commit: {
    precheck(_state, op) {
      return op.sha && typeof op.reason === "string" ? null : "invalid_commit_record";
    },
    apply() {},
  },
};

/** journal entry → 狀態。內容檔已經讀好（重播時讀、提交成功後直接用記憶體裡的那一份）。 */
function applyTo(state, entry, content) {
  const kind = KINDS[entry.kind];
  if (!kind) throw new Error(`未知的 entry kind：${entry.kind}`);
  kind.apply(state, entry, content);
  state.opSeqs.set(entry.opId, entry.journalSeq);
  state.lastSeq = entry.journalSeq;
}

export class CityLedger {
  /**
   * @param {object} options
   * @param {{ read(path: string): Promise<string|null>, write(path: string, text: string, expected: string|null): Promise<void> }} options.io
   * @param {string} options.dir 這個城的目錄
   * @param {string} options.cityId canonical git common dir
   * @param {number} [options.segmentLimit] 每個 journal 段的位元組上限
   * @param {number} [options.pageLimit] 內容檔、索引頁與座標分塊的上限（預設同 segmentLimit）
   */
  constructor({ io, dir, cityId, segmentLimit = SEGMENT_LIMIT, pageLimit, rulesVersion = RULES_VERSION }) {
    if (!io || typeof io.read !== "function" || typeof io.write !== "function") {
      throw new Error("帳本需要 { read, write } 的 io");
    }
    this.io = io;
    this.dir = dir;
    this.cityId = cityId;
    this.limit = segmentLimit;
    this.pageLimit = pageLimit ?? segmentLimit;
    this.rulesVersion = rulesVersion;
    this.blobs = new BlobStore({ io, dir: `${dir}/blobs`, limit: this.pageLimit });
    /** 讀取的快取：`{ state, head, headText, segment, tail:{index,text,entries}, stale }`。 */
    this.cache = null;
  }

  headPath() {
    return `${this.dir}/head.json`;
  }

  segmentPath(index) {
    return `${this.dir}/journal/${index}.json`;
  }

  checkpointDir(seq) {
    return `${this.dir}/checkpoints/${seq}`;
  }

  ackPath(sessionId, writerEpoch) {
    return `${this.dir}/acks/${sessionId}/${writerEpoch}.json`;
  }

  /** 第一次開這個城時建立 head 與第 0 段；已經有就沿用。 */
  async open() {
    const headText = await this.io.read(this.headPath());
    if (headText === null) {
      await this.create(
        this.headPath(),
        `${JSON.stringify({
          schemaVersion: SCHEMA,
          rulesVersion: this.rulesVersion,
          cityId: this.cityId,
          segment: 0,
          checkpoint: -1,
        })}\n`,
      );
    }
    if ((await this.io.read(this.segmentPath(0))) === null) await this.create(this.segmentPath(0), "");
    return this;
  }

  /**
   * expected = null 的建立；別人在前面建好了就沿用（不是錯）。
   * 只有 CAS 衝突才這樣處理：其他錯誤（權限、磁碟…）原樣丟出，不吞。
   */
  async create(path, text) {
    try {
      await this.io.write(path, text, null);
    } catch (error) {
      rejectUnlessConflict(error);
      if ((await this.io.read(path)) === null) throw error; // 衝突但檔案還是不在：讓呼叫端知道
    }
  }

  async head() {
    const text = await this.io.read(this.headPath());
    if (text === null) throw new Error(`帳本沒有 head：${this.headPath()}`);
    return { text, head: JSON.parse(text) };
  }

  /** head 指到的尾段；head 落後時跟著封段標記往前。 */
  async tailView() {
    const { text: headText, head } = await this.head();
    let index = head.segment;
    let text = await this.io.read(this.segmentPath(index));
    let parsed = parseSegment(text ?? "");
    let guard = 0;
    while (parsed.sealed) {
      if (guard++ > 4096) throw new Error("封段鏈太長");
      index = parsed.sealNext;
      text = await this.io.read(this.segmentPath(index));
      parsed = parseSegment(text ?? "");
    }
    return { head, headText, index, text, entries: parsed.entries };
  }

  /** 第 `from` 段起連續存在的所有段（讀取與 checkpoint 重播都走這裡）。 */
  async scanSegments(from = 0) {
    const segments = [];
    for (let index = from; ; index++) {
      const text = await this.io.read(this.segmentPath(index));
      if (text === null) break;
      if (byteLen(text) > this.limit) throw new Error(`第 ${index} 段超過上限`);
      segments.push({ index, text, ...parseSegment(text) });
    }
    return segments;
  }

  /** checkpoint + 之後的 journal → 狀態，並把讀取快取一起準備好。 */
  async rebuild() {
    const { text: headText, head } = await this.head();
    let state = emptyState(this.cityId);
    let from = 0;
    if (head.checkpoint >= 0) {
      const loaded = await this.loadCheckpoint(head.checkpoint);
      state = loaded.state;
      from = loaded.segment;
    }
    // checkpoint 指到的段被刪掉時不能靜靜地少讀後面的 entry。
    if (from > 0 && (await this.io.read(this.segmentPath(from))) === null) {
      throw new Error(`checkpoint 指到的第 ${from} 段不見了`);
    }
    let segment = from;
    for (const part of await this.scanSegments(from)) {
      for (const entry of part.entries) {
        if (entry.journalSeq <= state.lastSeq) continue;
        applyTo(state, entry, await this.contentOf(entry));
        segment = part.index;
      }
    }
    const view = await this.tailView();
    this.cache = {
      state,
      head,
      headText,
      segment,
      tail: { index: view.index, text: view.text ?? "", entries: view.entries.length },
      stale: false,
    };
    return { state, segment };
  }

  /** entry 引用的內容檔（沒有就回 null）。 */
  async contentOf(entry) {
    return entry.content ? this.blobs.getValue(entry.content) : null;
  }

  /**
   * 讀取快取同步：`state()` 一律重讀尾段（別人的寫入才看得到）；`submit()` 平常只信快取，
   * CAS 失敗時才標成 stale 強制重讀——所以一百萬筆操作的路徑上不是每筆都掃整個 journal。
   */
  async refresh({ force = false } = {}) {
    if (!this.cache) {
      await this.rebuild();
      return;
    }
    if (!force && !this.cache.stale) return;
    const view = await this.tailView();
    const from = Math.min(this.cache.segment, view.index);
    for (const part of await this.scanSegments(from)) {
      for (const entry of part.entries) {
        if (entry.journalSeq <= this.cache.state.lastSeq) continue;
        applyTo(this.cache.state, entry, await this.contentOf(entry));
        this.cache.segment = part.index;
      }
    }
    this.cache.head = view.head;
    this.cache.headText = view.headText;
    this.cache.tail = { index: view.index, text: view.text ?? "", entries: view.entries.length };
    this.cache.stale = false;
  }

  /** 讀取用：checkpoint 加後續 journal。 */
  async state() {
    await this.refresh({ force: true });
    return this.cache.state;
  }

  /**
   * 提交一筆操作（§13.1 的提交流程）：重建狀態 → `make(state)` 產生 op → 檢查前提
   * （含 operation ID 去重與 generation）→ 先寫內容檔 → CAS 附加 entry。
   * CAS 失敗或有別人先封段就重讀、重新 `make`（例如重新選地）再試。
   *
   * `make` 回 null 代表沒有事要做。回傳 `{ status, journalSeq?, reason?, attempts }`。
   */
  async submit(make, options = {}) {
    let last = { status: "nothing" };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.refresh();
      const { state, tail } = this.cache;
      const op = make(state);
      if (!op) return { status: "nothing", attempts: attempt };
      const blobs = op.blobs ?? null;
      if (state.opSeqs.has(op.opId)) {
        return { status: "duplicate", opId: op.opId, journalSeq: state.opSeqs.get(op.opId), attempts: attempt };
      }
      const reason = KINDS[op.kind]?.precheck?.(state, op, blobs);
      if (reason) return { status: "rejected", reason, attempts: attempt };

      const content = blobs ? (await this.writeBlob(blobs)).hash : null;
      if (options.crash === "after-content") throw new CrashAfterContent(op.opId);

      const { blobs: _ignored, ...fields } = op;
      const entry = {
        journalSeq: state.lastSeq + 1,
        at: op.at ?? Date.now(),
        rulesVersion: this.rulesVersion,
        ...fields,
        content,
      };
      const line = `${JSON.stringify(entry)}\n`;
      const current = tail.text ?? "";

      // 這一段放不下下一筆（封段行也算在裡面）：先 CAS 附加封段行，再換段；
      // 別人先封就重讀、重新檢查前提（§13.1）。
      if (byteLen(current) + byteLen(line) + SEAL_RESERVE > this.limit) {
        if (tail.entries === 0) throw new Error(`單筆 entry 超過單段上限：${op.opId}`);
        try {
          await this.io.write(
            this.segmentPath(tail.index),
            `${current}${JSON.stringify({ seal: state.lastSeq, next: tail.index + 1 })}\n`,
            current,
          );
        } catch (error) {
          rejectUnlessConflict(error);
          this.cache.stale = true;
          last = { status: "rotated" };
          continue;
        }
        await this.create(this.segmentPath(tail.index + 1), "");
        this.cache.head = { ...this.cache.head, segment: tail.index + 1 };
        this.cache.tail = { index: tail.index + 1, text: "", entries: 0 };
        await this.updateHead({ head: this.cache.head, headText: this.cache.headText }, { segment: tail.index + 1 });
        last = { status: "rotated" };
        continue;
      }

      // CAS：快照不符就重讀、重新檢查前提、再試（§13.1）。其他錯誤原樣丟出。
      try {
        await this.io.write(this.segmentPath(tail.index), `${current}${line}`, current);
      } catch (error) {
        rejectUnlessConflict(error);
        this.cache.stale = true;
        last = { status: "stale" };
        continue;
      }
      if (options.crash === "after-journal") throw new CrashAfterJournal(op.opId);
      // 這筆已經在 journal 裡了：直接套進快取，不用再讀一次。
      applyTo(state, entry, blobs);
      this.cache.segment = tail.index;
      this.cache.tail = { index: tail.index, text: `${current}${line}`, entries: tail.entries + 1 };
      return { status: "applied", journalSeq: entry.journalSeq, opId: entry.opId, attempts: attempt };
    }
    return { ...last, attempts: MAX_ATTEMPTS };
  }

  /** 內容檔以雜湊命名；已經有同樣的內容就沿用（重試不會多寫）。 */
  async writeBlob(content) {
    return this.blobs.putValue(content);
  }

  /** CAS 寫入：只有快照不符才失敗，交給呼叫端決定要不要重試。 */
  async write(path, text, expected) {
    await this.io.write(path, text, expected);
  }

  async updateHead(view, changes) {
    const head = { ...view.head, ...changes };
    try {
      await this.io.write(this.headPath(), `${JSON.stringify(head)}\n`, view.headText);
    } catch (error) {
      // head 只是快取：讀取端跟著封段標記走，下次提交會再更新一次。
      // 但只有 CAS 衝突可以吞；其他錯誤要讓呼叫端看到。
      rejectUnlessConflict(error);
    }
  }

  // ---- checkpoint（衍生狀態；每個檔案都 ≤ pageLimit） --------------------------------

  /** 衍生狀態快照；讀取時 = checkpoint + 之後的 journal（§13.1）。 */
  async checkpoint() {
    const { state, segment } = await this.rebuild();
    const seq = state.lastSeq;
    if (seq < 0) return { seq, segment };
    const dir = this.checkpointDir(seq);
    const index = (part) => new PrefixIndex({ io: this.io, dir: `${dir}/${part}`, limit: this.pageLimit });

    await index("ops").build([...state.opSeqs]);
    await index("claims").build([...state.claims]);
    // 格子紀錄整份存進索引（不是挑欄位），所以之後的票加欄位時，
    // 「checkpoint 重播 == 完整 journal 重播」不會因為少抄一個欄位而失效。
    const expeditions = index("expeditions");
    await expeditions.build(
      state.tiles.map((tile) => [tileId(tile.cityId, tile.rootSessionId, tile.generation), canonicalJson(tile)]),
    );
    const activities = index("activities");
    await activities.build(
      await Promise.all([...state.activities].map(async ([key, record]) => [key, await this.packRecord(record)])),
    );

    // 座標分塊：每塊 32×32 格，只記格子鍵（遠征資料在 expeditions 索引）。
    const chunks = new Map();
    for (const tile of state.tiles) {
      const name = chunkName(tile.x, tile.y);
      if (!chunks.has(name)) chunks.set(name, []);
      chunks.get(name).push(`${tile.rootSessionId}@@${tile.generation}`);
    }
    await index("chunk-index").build([...chunks].map(([name, ids]) => [name, ids.length]));
    for (const [name, ids] of chunks) {
      const text = JSON.stringify({ t: "chunk", name, tiles: ids });
      if (byteLen(text) >= this.pageLimit) throw new Error(`座標分塊超過上限：${name}`);
      await casWrite(this.io, `${dir}/chunks/${name}.json`, text);
    }

    const manifest = {
      t: "ckpt",
      schema: SCHEMA,
      rulesVersion: this.rulesVersion,
      cityId: this.cityId,
      seq,
      segment,
      resources: state.resources,
      research: state.research,
      market: state.market,
      counts: {
        tiles: state.tiles.length,
        activities: state.activities.size,
        ops: state.opSeqs.size,
        claims: state.claims.size,
        chunks: chunks.size,
      },
    };
    await casWrite(this.io, `${dir}/manifest.json`, JSON.stringify(manifest));
    const { text, head } = await this.head();
    await this.updateHead({ head, headText: text }, { checkpoint: seq });
    return { seq, segment, counts: manifest.counts };
  }

  /** mod 開機時用：journal 長到一個程度才真的做 checkpoint。 */
  async maybeCheckpoint(threshold = CHECKPOINT_EVERY) {
    const state = await this.state();
    if (state.lastSeq < 0) return null;
    const { head } = await this.head();
    if (state.lastSeq - (head.checkpoint ?? -1) < threshold) return null;
    return this.checkpoint();
  }

  /** checkpoint 的 manifest 太大時，紀錄本身放內容檔（切塊＋manifest 都能讀回來）。 */
  async packRecord(record) {
    const json = canonicalJson(record);
    if (byteLen(json) <= this.pageLimit / 4) return { inline: record };
    return { blob: (await this.blobs.putText(json)).hash };
  }

  async unpackRecord(packed) {
    if (packed?.blob) return this.blobs.getValue(packed.blob);
    return packed?.inline ?? null;
  }

  /** checkpoint → 狀態（不含 checkpoint 之後的 journal）。 */
  async loadCheckpoint(seq) {
    const dir = this.checkpointDir(seq);
    const text = await this.io.read(`${dir}/manifest.json`);
    if (text === null) throw new Error(`checkpoint 不見了：${seq}`);
    const manifest = JSON.parse(text);
    const index = (part) => new PrefixIndex({ io: this.io, dir: `${dir}/${part}`, limit: this.pageLimit });
    const state = emptyState(this.cityId);
    state.lastSeq = manifest.seq ?? seq;
    for (const [, record] of await index("expeditions").all()) addTile(state, JSON.parse(record));
    state.tiles.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    for (const [key, value] of await index("ops").all()) state.opSeqs.set(key, value);
    for (const [key, value] of await index("claims").all()) state.claims.set(key, value);
    for (const [key, packed] of await index("activities").all()) state.activities.set(key, await this.unpackRecord(packed));
    state.resources = manifest.resources ?? state.resources;
    state.research = manifest.research ?? state.research;
    state.market = manifest.market ?? state.market;
    return { state, segment: manifest.segment ?? 0 };
  }

  /** 最新的 checkpoint（有的話）：目錄、manifest 與代號。 */
  async checkpointInfo() {
    const { head } = await this.head();
    if (!head.checkpoint || head.checkpoint < 0) return null;
    const dir = this.checkpointDir(head.checkpoint);
    const text = await this.io.read(`${dir}/manifest.json`);
    if (text === null) return null;
    return { seq: head.checkpoint, dir, manifest: JSON.parse(text) };
  }

  // ---- 查詢介面（#9 接手用；不做畫面） ------------------------------------------------

  /**
   * operation ID → journalSeq。有 checkpoint 就查它的分頁，沒有（或 checkpoint 之後才
   * 寫入）就查「checkpoint + 後續 journal」重播出來的記憶體索引。
   */
  async lookupOp(opId) {
    const info = await this.checkpointInfo();
    if (info) {
      const hit = await new PrefixIndex({ io: this.io, dir: `${info.dir}/ops`, limit: this.pageLimit }).get(opId);
      if (hit !== null) return { seq: hit, source: "checkpoint" };
    }
    const seq = (await this.state()).opSeqs.get(opId);
    return seq === undefined ? null : { seq, source: "journal" };
  }

  /** claim（城級去重鍵）→ journalSeq。 */
  async lookupClaim(claim) {
    const key = claimKey(this.cityId, claim);
    const info = await this.checkpointInfo();
    if (info) {
      const hit = await new PrefixIndex({ io: this.io, dir: `${info.dir}/claims`, limit: this.pageLimit }).get(key);
      if (hit !== null) return { seq: hit, source: "checkpoint" };
    }
    const seq = (await this.state()).claims.get(key);
    return seq === undefined ? null : { seq, source: "journal" };
  }

  /** 一支遠征的一個 generation → 它的格子與流水號。 */
  async lookupExpedition(rootSessionId, generation = 1) {
    const id = tileId(this.cityId, rootSessionId, generation);
    const info = await this.checkpointInfo();
    if (info) {
      const hit = await this.expeditionIndex(info.dir).get(id);
      if (hit !== null) {
        const tile = JSON.parse(hit);
        return { tile, seq: tile.seq, source: "checkpoint" };
      }
    }
    const found = (await this.state()).tileById.get(id);
    return found ? { tile: found, seq: found.seq, source: "journal" } : null;
  }

  /** 一個座標分塊裡的格子（地圖用；32×32 格）：checkpoint 的分塊加上之後新增的。 */
  async tilesInChunk(x, y) {
    const name = chunkName(x, y);
    const info = await this.checkpointInfo();
    const tiles = [];
    if (info) {
      const text = await this.io.read(`${info.dir}/chunks/${name}.json`);
      const index = this.expeditionIndex(info.dir);
      for (const key of text === null ? [] : JSON.parse(text).tiles) {
        const [rootSessionId, generation] = key.split("@@");
        const hit = await index.get(tileId(this.cityId, rootSessionId, Number(generation)));
        if (hit !== null) tiles.push(JSON.parse(hit));
      }
    }
    // checkpoint 之後才落帳的格子也要在：查詢接點讀的是「checkpoint + 後續 journal」。
    const seen = new Set(tiles.map((tile) => tileId(tile.cityId, tile.rootSessionId, tile.generation)));
    for (const tile of (await this.state()).tiles) {
      if (chunkName(tile.x, tile.y) !== name) continue;
      const id = tileId(tile.cityId, tile.rootSessionId, tile.generation);
      if (seen.has(id)) continue;
      tiles.push(tile);
    }
    return tiles;
  }

  /** checkpoint 裡的遠征索引（key = tileId）。 */
  expeditionIndex(dir) {
    return new PrefixIndex({ io: this.io, dir: `${dir}/expeditions`, limit: this.pageLimit });
  }

  /**
   * 歷程查詢（§12）：一支遠征的一個 generation 的格子與它的每一筆操作。
   * journal 段不會被刪，所以 checkpoint 之前寫入的 entry 也查得到。
   */
  async historyOf(rootSessionId, generation = 1) {
    const located = await this.lookupExpedition(rootSessionId, generation);
    const entries = [];
    for (const segment of await this.scanSegments()) {
      for (const entry of segment.entries) {
        if (entry.rootSessionId !== rootSessionId) continue;
        if ((entry.generation ?? 1) !== generation) continue;
        entries.push({ journalSeq: entry.journalSeq, kind: entry.kind, at: entry.at, content: entry.content ?? null });
      }
    }
    return { expedition: located?.tile ?? null, journalSeq: located?.seq ?? null, entries };
  }

  // ---- adapter 的 ack（§6.2） --------------------------------------------------------

  /**
   * journal 提交成功之後才寫；內容只給 adapter 用來清掉已收的事件。
   * 帳本重播不讀它，所以 ack 延遲或重播都不會改變最終狀態。
   */
  async writeAck({ sessionId, writerEpoch, ackedEventSeq, journalSeq }) {
    const path = this.ackPath(sessionId, writerEpoch);
    const expected = await this.io.read(path);
    const body = `${JSON.stringify({ sessionId, writerEpoch, ackedEventSeq, journalSeq })}\n`;
    if (expected === body) return path; // 已經寫過同樣的內容
    try {
      if (expected === null) await this.create(path, body);
      else await this.write(path, body, expected);
    } catch (error) {
      rejectUnlessConflict(error); // 兩個視窗同時寫同一個 epoch 的 ack
      const current = await this.io.read(path);
      if (current === body) return path;
      if (current === null) await this.create(path, body);
      else await this.write(path, body, current);
    }
    return path;
  }

  async readAck(sessionId, writerEpoch) {
    const text = await this.io.read(this.ackPath(sessionId, writerEpoch));
    return text === null ? null : JSON.parse(text);
  }
}

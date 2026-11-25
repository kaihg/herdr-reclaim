// 共用城市的帳本：append-only journal + CAS + checkpoint（proposal §13.1，ticket #3／#4）。
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
//   checkpoints/<seq>/ops|claims|activities/   可延長前綴的雜湊分頁（core/pages.js）
//   acks/<sessionId>/<epoch>.json   adapter 的 ack；journal 成功之後才寫
//
// **沒有任何 listdir**：herdr 的 mod 只有 readTextFile／writeTextFile，所以走訪一律靠
// 根頁與拆分標記自己記的子前綴（pages.js），不掃資料夾。checkpoint 因此也不需要記住
// 檔名清單，只有固定大小的 manifest。
//
// 唯一完成依據是 journal entry：只有內容檔、沒有 entry 的操作不算完成（§13.1）。
//
// **這一版的語意邊界**（#22）：帳本只服務共用城市，entry kind 只有工作啟用邊界、收入、
// 成果收成、建設目標、開工、完工與活動合併。收成的資源向量由 entry 自己帶（§7.3），
// 帳本不會自己發明數字。舊版各 repo 城的遠征／收成／研究／市集 entry 已移除，程式不再
// 讀寫 `cities/`（使用者的舊目錄留在磁碟上，不遷移）。
import { BlobStore } from "./blobs.js";
import { byteLen, canonicalJson, hashText } from "./bytes.js";
import { casWrite, rejectUnlessConflict } from "./cas.js";
import { PrefixIndex } from "./pages.js";
import { ACHIEVEMENT_YIELD, CITY_BUILDINGS, RESOURCES, RULES_VERSION, WORK_TOKENS_PER_UNIT, affordable, workYieldOf } from "./rules.js";
import { siteCheck } from "./city-map.js";

export { byteLen, hashText };

/** 帳本目錄格式的版本（head.json 的 schemaVersion）。 */
export const SCHEMA = 2;
/** 活動紀錄的格式版本：帳本保存的那一份就是認這個號碼。 */
export const ACTIVITY_SCHEMA = 1;
/** 規則表版本（core/rules.js）：每一筆 entry 都存當時的版本（§8.2）。 */
export { RULES_VERSION };

/** §13.1：每段上限 256 KiB；herdr 單檔讀取上限是 1 MiB。 */
export const SEGMENT_LIMIT = 256 * 1024;

/** 每段預留封段行的空間，讓「封段」一定還在單段上限之內。 */
export const SEAL_RESERVE = 96;

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

/** 故障注入用：封段行已附加、下一段還沒建立時中斷（§13.1 的恢復情境）。 */
export class CrashAfterSeal extends Error {
  constructor(opId) {
    super(`封段已寫、下一段未建立：${opId}`);
    this.name = "CrashAfterSeal";
    this.opId = opId;
  }
}

/**
 * checkpoint（衍生索引）不完整：manifest 欄位、頁面存在與否或筆數對不上。
 * 呼叫端要整份丟棄、從 journal 重建——缺頁不能當成「沒有資料」。
 */
export class CheckpointIncomplete extends Error {
  constructor(seq, reason) {
    super(`checkpoint 不完整（${seq}）：${reason}`);
    this.name = "CheckpointIncomplete";
    this.seq = seq;
    this.reason = reason;
  }
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

/** §7.3 的城級去重鍵：同一座城同一份成果只發一次。 */
export const claimKey = (cityId, claim) => `${cityId}@@${claim}`;
/**
 * 共用城市一個建設目標的身分（#26）：建築、錨點與下令時間。開工與完工都綁這把鍵，
 * 所以同一個目標只開工一次、完工一次；之後在同一處再預定同一種建築是另一個目標。
 */
export const planKey = (plan) => `${plan.building}:${plan.x},${plan.y}:${plan.at}`;
export const activityKey = (record) => `${record.sessionId}@@${record.writerEpoch ?? ""}`;

const zeroResources = () => Object.fromEntries(RESOURCES.map((key) => [key, 0]));

/**
 * 空狀態。`activities` 的順序就是 journal 的附加順序，重播結果因此可重現；
 * `opSeqs`／`claims` 是索引（§13.2）；
 * `work.tokens` 是共用城市（#23）還沒換成建材的有效工作進度（餘數）；`work.stockedAt` 是入庫
 * 建材裡最晚的那一筆的時間（#26：材料到齊不會早於它，開工從這裡起算）；
 * `plan` 是共用城市唯一的建設目標（#25）：建築、錨點與整片占地；沒有目標時是 null。
 * 開工之後（#26）多出 `startedAt`／`buildMs`／`completesAt`。`buildings` 是共用城市已完工的建築。
 */
export function emptyState(cityId) {
  return {
    cityId,
    rulesVersion: RULES_VERSION,
    lastSeq: -1,
    activities: new Map(),
    opSeqs: new Map(),
    claims: new Map(),
    resources: zeroResources(),
    work: { tokens: 0, since: null, stockedAt: null },
    plan: null,
    buildings: [],
  };
}

/** 實付資源必須就是規則表裡的那份配方，不能少扣或多扣（§7.6）。 */
function sameCosts(costs, recipe) {
  const entries = Object.entries(costs ?? {});
  const expected = Object.entries(recipe ?? {});
  return entries.length === expected.length &&
    expected.every(([key, need]) => Number(costs[key]) === Number(need));
}

/**
 * 共用倉庫入庫（收入與成果加成共用）：加上 entry 帶的建材，並記下入庫建材裡最晚的時間。
 * 晚到的較早工作不會把它往回拉，所以用它起算的開工不會早於任何一筆被用掉的材料。
 */
function stockUp(state, entry) {
  for (const [name, amount] of Object.entries(entry.resources ?? {})) {
    state.resources[name] = Number(state.resources[name] ?? 0) + Number(amount);
  }
  const at = Number(entry.at);
  if (Number.isFinite(at) && !(Number(state.work.stockedAt) >= at)) state.work.stockedAt = at;
}

/**
 * 每一種 operation 的套用與前提檢查。entry 只要帶上自己的欄位即可，格式不用改。
 */
export const KINDS = {
  /**
   * 共用城市的啟用邊界（#23）：只寫一次，記下第一次啟用的時間。之後才結束的工作回合才入帳；
   * 時間跟著 entry 存進 journal，重播不會改變。
   */
  workStart: {
    precheck(state, op) {
      if (op.cityId !== state.cityId) return "wrong_city";
      if (state.work.since != null) return "already_started";
      return Number.isFinite(Number(op.at)) ? null : "invalid_work_start";
    },
    apply(state, entry) {
      state.work.since = Number(entry.at);
    },
  },
  /**
   * 共用城市的基本收入（#23）：一個結束的有效工作回合，把 non-cache input + output token
   * 加進共用倉庫的計量器；每滿 WORK_TOKENS_PER_UNIT 收成一份建材，餘數保留。
   *
   * entry 自己帶收成的資源向量（調整費率不改寫已落帳的結果）；`sources` 是這個回合用掉的
   * 用量來源鍵，寫進城級 claim 索引——兩個 space 或恢復對話後的另一個 epoch 重送同一份
   * 工作時，整筆不重複入帳。
   */
  income: {
    precheck(state, op) {
      if (op.cityId !== state.cityId) return "wrong_city";
      if (!(Number.isInteger(Number(op.tokens)) && Number(op.tokens) > 0)) return "invalid_income";
      if (!Array.isArray(op.sources) || op.sources.length === 0) return "missing_sources";
      // 收成要跟「這筆提交之前」的計量器餘數相符：CAS 重試重新計算，驗的也是同一條規則。
      const expected = workYieldOf(Number(state.work.tokens ?? 0) + Number(op.tokens));
      const paid = Object.entries(expected);
      const got = Object.entries(op.resources ?? {});
      if (got.length !== paid.length || !paid.every(([key, amount]) => Number(op.resources?.[key]) === amount)) {
        return "rate_mismatch";
      }
      if (op.sources.some((source) => state.claims.has(claimKey(op.cityId, source)))) return "source_exists";
      return null;
    },
    apply(state, entry) {
      const total = Number(state.work.tokens ?? 0) + Number(entry.tokens);
      state.work.tokens = total % WORK_TOKENS_PER_UNIT;
      stockUp(state, entry);
      for (const source of entry.sources ?? []) state.claims.set(claimKey(entry.cityId, source), entry.journalSeq);
    },
  },
  /**
   * 共用城市的成果收成（#24）：歸屬確定、且帶來新內容的 commit 另外發一份建材。`claims` 是這個
   * commit 改到的內容版本（路徑＋result blob），寫進城級 claim 索引——同一個 commit 從兩個 space
   * 抵達、重播、或 rebase／amend 後內容不變，都不會再發。
   */
  achievement: {
    precheck(state, op) {
      if (op.cityId !== state.cityId) return "wrong_city";
      if (!Array.isArray(op.claims) || op.claims.length === 0) return "missing_claims";
      const paid = Object.entries(ACHIEVEMENT_YIELD);
      const got = Object.entries(op.resources ?? {});
      if (got.length !== paid.length || !paid.every(([key, amount]) => Number(op.resources?.[key]) === amount)) {
        return "rate_mismatch";
      }
      if (op.claims.some((claim) => state.claims.has(claimKey(op.cityId, claim)))) return "claim_exists";
      return null;
    },
    apply(state, entry) {
      stockUp(state, entry);
      for (const claim of entry.claims ?? []) state.claims.set(claimKey(entry.cityId, claim), entry.journalSeq);
    },
  },

  /**
   * 建設目標（#25）：玩家選定建築與錨點，整片占地成為唯一的預定地。這筆**不動庫存**——
   * 材料夠不夠是備料與施工（#26）的事，缺料時照樣可以先指定位置。
   *
   * 前提：一次只有一個目標；建築、占地與配方要與規則表相符；每一格都必須已揭開、可建且
   * 沒有被別的建築或預定地占用（判準與畫面預覽同一個 `siteCheck`）。碰不到任何一格的
   * 第二個目標因此整筆被拒，不留下半片占地。
   */
  plan: {
    precheck(state, op) {
      if (op.cityId !== state.cityId) return "wrong_city";
      if (state.plan) return "plan_exists";
      const def = CITY_BUILDINGS[op.building];
      if (!def) return "unknown_building";
      if (Number(op.w) !== def.footprint.w || Number(op.h) !== def.footprint.h) return "footprint_mismatch";
      if (!sameCosts(op.costs, def.costs)) return "recipe_mismatch";
      const preview = siteCheck(state, op.building, { x: op.x, y: op.y });
      const blocked = preview.cells.find((cell) => cell.problem);
      return blocked ? `site_${blocked.problem}` : null;
    },
    apply(state, entry) {
      const def = CITY_BUILDINGS[entry.building];
      state.plan = {
        building: entry.building,
        label: def.label,
        x: entry.x,
        y: entry.y,
        w: entry.w,
        h: entry.h,
        costs: { ...entry.costs },
        cells: siteCheck({ plan: null }, entry.building, { x: entry.x, y: entry.y }).cells
          .map((cell) => ({ x: cell.x, y: cell.y })),
        at: Number(entry.at),
        rulesVersion: entry.rulesVersion,
      };
    },
  },

  /**
   * 開工（#26）：預定地的材料備齊時由城市自動送出，一次付清預定時的完整配方，從 `at` 起算工期。
   * 一個建設目標只開工一次：opId 綁住目標（`planKey`），兩個視窗同時達標、重開或重播都只扣一次。
   * 工期只看建築種類（規則表），不看占地上的植被或碎石。
   */
  construct: {
    precheck(state, op) {
      if (op.cityId !== state.cityId) return "wrong_city";
      const plan = state.plan;
      if (!plan || planKey(plan) !== op.plan) return "no_plan";
      if (plan.startedAt != null) return "already_started";
      if (!sameCosts(op.costs, plan.costs)) return "recipe_mismatch";
      if (Number(op.buildMs) !== CITY_BUILDINGS[plan.building]?.buildMs) return "duration_mismatch";
      if (!(Number(op.at) >= Number(plan.at))) return "before_plan";
      if (!affordable(plan.costs, state.resources)) return "insufficient_resources";
      return null;
    },
    apply(state, entry) {
      for (const [key, amount] of Object.entries(entry.costs ?? {})) {
        state.resources[key] = Number(state.resources[key] ?? 0) - Number(amount);
      }
      const startedAt = Number(entry.at);
      state.plan = { ...state.plan, startedAt, buildMs: Number(entry.buildMs), completesAt: startedAt + Number(entry.buildMs) };
    },
  },

  /**
   * 完工（#26）：工期到了就把建設目標變成一棟啟用中的建築，預定地交還給城市（沒有下一個目標）。
   * `at` 是開工時間加工期，不是看到完工的那一刻，所以晚開畫面不改變完工時間。`reveal` 是規則表
   * 當時的揭開半徑，跟著 entry 存進建築，調整規則不改寫已揭開的土地。不支付、也不選下一棟。
   */
  complete: {
    precheck(state, op) {
      if (op.cityId !== state.cityId) return "wrong_city";
      const plan = state.plan;
      if (!plan || planKey(plan) !== op.plan) return "no_plan";
      if (plan.startedAt == null) return "not_started";
      if (Number(op.at) !== Number(plan.completesAt)) return "completion_mismatch";
      if (Number(op.reveal) !== CITY_BUILDINGS[plan.building]?.reveal) return "reveal_mismatch";
      return null;
    },
    apply(state, entry) {
      const plan = state.plan;
      state.buildings.push({
        building: plan.building,
        label: plan.label,
        x: plan.x,
        y: plan.y,
        w: plan.w,
        h: plan.h,
        cells: plan.cells.map((cell) => ({ x: cell.x, y: cell.y })),
        costs: { ...plan.costs },
        reveal: Number(entry.reveal),
        startedAt: plan.startedAt,
        completedAt: Number(entry.at),
        rulesVersion: entry.rulesVersion,
      });
      state.plan = null;
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
    },
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
   * @param {string} options.dir 這座城的帳本目錄
   * @param {string} options.cityId 帳本身份（共用城市固定是 `shared`）
   * @param {number} [options.segmentLimit] 每個 journal 段的位元組上限
   * @param {number} [options.pageLimit] 內容檔與索引頁的上限（預設同 segmentLimit）
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

  /** 第一次開這個帳本時建立 head 與第 0 段；已經有就沿用。 */
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

  /**
   * 第 `from` 段起沿著封段標記走出來的段（讀取、重播與 checkpoint 都走這裡）。
   *
   * 讀到封段標記、它指的下一段還不存在時（封段 CAS 成功、建立下一段之前中斷），
   * 由讀到 seal 的寫入者補上（§13.1）。不是接在 seal 後面的缺口一律當損壞，不猜。
   */
  async scanSegments(from = 0) {
    const segments = [];
    let index = from;
    for (let guard = 0; ; guard++) {
      if (guard > 8192) throw new Error("封段鏈太長");
      let text = await this.io.read(this.segmentPath(index));
      if (text === null) {
        const previous = segments[segments.length - 1];
        if (!previous?.sealed || previous.sealNext !== index) break;
        await this.create(this.segmentPath(index), "");
        text = await this.io.read(this.segmentPath(index));
        if (text === null) throw new Error(`封段後的下一段建立不起來：${index}`);
      }
      if (byteLen(text) > this.limit) throw new Error(`第 ${index} 段超過上限`);
      const parsed = parseSegment(text);
      segments.push({ index, text, ...parsed });
      // 尾段之後還讀一段：正常情況下它是 null（就是「到這裡為止」的證明），
      // 也讓「掃描完成的讀取」跟「尾段是哪一段」由同一條讀取鏈決定。
      index = parsed.sealed && Number.isInteger(parsed.sealNext) ? parsed.sealNext : index + 1;
    }
    return segments;
  }

  /** 掃描結果的尾段：下一筆 entry 要附加的那一段。 */
  tailOf(segments, fallback) {
    const last = segments[segments.length - 1];
    return last
      ? { index: last.index, text: last.text, entries: last.entries.length }
      : { index: fallback, text: "", entries: 0 };
  }

  /** checkpoint + 之後的 journal → 狀態，並把讀取快取一起準備好。 */
  async rebuild() {
    const { text: headText, head } = await this.head();
    let state = emptyState(this.cityId);
    let from = 0;
    if (head.checkpoint >= 0) {
      try {
        const loaded = await this.loadCheckpoint(head.checkpoint, head.checkpointDigest);
        state = loaded.state;
        from = loaded.segment;
      } catch (error) {
        if (!(error instanceof CheckpointIncomplete)) throw error;
        // 衍生索引不完整：整份丟棄、從 authoritative journal 從頭重播（Issue #1），
        // 並把 head 的 checkpoint 歸零，之後不用每次讀取都再讀一次壞掉的快照。
        await this.discardCheckpoint();
        state = emptyState(this.cityId);
        from = 0;
      }
    }
    // checkpoint 指到的段被刪掉時不能靜靜地少讀後面的 entry。
    if (from > 0 && (await this.io.read(this.segmentPath(from))) === null) {
      throw new Error(`checkpoint 指到的第 ${from} 段不見了`);
    }
    // 重播與 CAS 前提必須來自**同一份掃描結果**：尾段直接取這份結果，不再另外重讀
    // 一次。否則別的寫入者在兩次讀取之間附加的 entry 會讓 state 停在 N−1、CAS 前提
    // 卻已經含著它，下一個 submit 就會對最新尾段寫出重複的序號（§13.1）。
    const parts = await this.scanSegments(from);
    for (const part of parts) {
      for (const entry of part.entries) {
        if (entry.journalSeq <= state.lastSeq) continue;
        applyTo(state, entry, await this.contentOf(entry));
      }
    }
    const tail = this.tailOf(parts, from);
    this.cache = { state, head, headText, segment: tail.index, tail, stale: false };
    return { state, segment: tail.index };
  }

  /** entry 引用的內容檔（沒有就回 null）。 */
  async contentOf(entry) {
    return entry.content ? this.blobs.getValue(entry.content) : null;
  }

  /**
   * 讀取快取同步：`state()` 一律重讀尾段（別人的寫入才看得到）；`submit()` 平常只信快取，
   * CAS 失敗時才標成 stale 強制重讀——所以一百萬筆操作的路徑上不是每筆都掃整個 journal。
   * 重讀的尾段同樣取自這份掃描結果（跟 rebuild 一樣的理由）。
   */
  async refresh({ force = false } = {}) {
    if (!this.cache) {
      await this.rebuild();
      return;
    }
    if (!force && !this.cache.stale) return;
    const { text: headText, head } = await this.head();
    const parts = await this.scanSegments(this.cache.segment);
    for (const part of parts) {
      for (const entry of part.entries) {
        if (entry.journalSeq <= this.cache.state.lastSeq) continue;
        applyTo(this.cache.state, entry, await this.contentOf(entry));
      }
    }
    const tail = this.tailOf(parts, this.cache.segment);
    this.cache.head = head;
    this.cache.headText = headText;
    this.cache.segment = tail.index;
    this.cache.tail = tail;
    this.cache.stale = false;
  }

  /** 讀取用：checkpoint 加後續 journal。 */
  async state() {
    await this.refresh({ force: true });
    return this.cache.state;
  }

  /**
   * 提交一筆操作（§13.1 的提交流程）：重建狀態 → `make(state)` 產生 op → 檢查前提
   * （含 operation ID 去重）→ 先寫內容檔 → CAS 附加 entry。
   * CAS 失敗或有別人先封段就重讀、重新 `make` 再試。
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
        if (options.crash === "after-seal") throw new CrashAfterSeal(op.opId);
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

    // 每一組索引寫完就拿到「這一組頁面的內容摘要」（build 回傳，不再多讀一次）；
    // 摘要寫進 manifest，載入時用來確認頁面內容沒被改過（筆數不變但內容換掉也要看得出來）。
    const built = {};
    built.ops = await index("ops").build([...state.opSeqs]);
    built.claims = await index("claims").build([...state.claims]);
    built.activities = await index("activities").build(
      await Promise.all([...state.activities].map(async ([key, record]) => [key, await this.packRecord(record)])),
    );

    const manifest = {
      t: "ckpt",
      schema: SCHEMA,
      rulesVersion: this.rulesVersion,
      cityId: this.cityId,
      seq,
      segment,
      resources: state.resources,
      work: state.work,
      plan: state.plan,
      // 共用城市的建築會一直增加：清單放內容檔（可切塊），manifest 只留固定長度的雜湊；
      // 沒有建築時就不寫內容檔。
      buildings: state.buildings.length > 0 ? (await this.blobs.putValue(state.buildings)).hash : null,
      // 每一組索引的內容摘要（固定幾個 16 進位字串；不隨資料量成長）。
      digests: Object.fromEntries(Object.entries(built).map(([part, result]) => [part, result.digest])),
      counts: {
        activities: state.activities.size,
        ops: state.opSeqs.size,
        claims: state.claims.size,
      },
    };
    const manifestText = JSON.stringify(manifest);
    await casWrite(this.io, `${dir}/manifest.json`, manifestText);
    const { text, head } = await this.head();
    // 摘要的根放在 head.json（帳本自己的檔，也是指出「現在用哪個 checkpoint」的那一份）：
    // manifest 自己不能證明自己，所以它的內容雜湊要跟 head 一起寫、載入時比對。
    await this.updateHead({ head, headText: text }, { checkpoint: seq, checkpointDigest: hashText(manifestText) });
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

  /**
   * checkpoint → 狀態（不含 checkpoint 之後的 journal）。
   *
   * checkpoint 是**衍生**索引：不只要驗結構（manifest 欄位、每一頁存在與筆數），也要驗
   * **內容**——manifest 的內容雜湊要等於 head 記下的根摘要，每一組索引頁的內容摘要要等於
   * manifest 記下的那一份。任一不符就丟 `CheckpointIncomplete`，由呼叫端整份丟棄、從
   * journal 重建（Issue #1）。缺頁不能當成「沒有資料」，被改過的頁面也不能當成資料。
   *
   * 驗證一次只在**載入**發生（每個帳本實例第一次 rebuild）；submit 的平常路徑只讀尾段。
   */
  async loadCheckpoint(seq, expectedDigest) {
    const dir = this.checkpointDir(seq);
    const incomplete = (reason) => new CheckpointIncomplete(seq, reason);
    const text = await this.io.read(`${dir}/manifest.json`);
    if (text === null) throw incomplete("manifest 不見了");
    // 摘要的根在 head.json：manifest 的內容雜湊不符（數字被改、JSON 被換掉）就整份丟棄。
    if (typeof expectedDigest !== "string" || expectedDigest === "" || hashText(text) !== expectedDigest) {
      throw incomplete("manifest 內容與 head 記下的摘要不符");
    }
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      throw incomplete("manifest 不是合法 JSON");
    }
    const counts = manifest?.counts;
    const digests = manifest?.digests;
    const parts = ["ops", "claims", "activities"];
    const shaped = manifest?.t === "ckpt" && manifest.schema === SCHEMA && Number.isInteger(manifest.seq) &&
      manifest.seq === seq && Number.isInteger(manifest.segment) &&
      counts && ["activities", "ops", "claims"].every((key) => Number.isInteger(counts[key])) &&
      digests && parts.every((part) => typeof digests[part] === "string" && digests[part] !== "");
    if (!shaped) throw incomplete("manifest 欄位不完整");
    const index = (part) => new PrefixIndex({ io: this.io, dir: `${dir}/${part}`, limit: this.pageLimit });
    try {
      const read = {};
      for (const part of parts) {
        read[part] = await index(part).scan({ strict: true });
        if (read[part].digest !== digests[part]) throw new Error(`索引內容與摘要不符：${part}`);
      }
      const mismatch = read.ops.entries.size !== counts.ops || read.claims.entries.size !== counts.claims ||
        read.activities.entries.size !== counts.activities;
      if (mismatch) throw new Error(`筆數不符（ops ${read.ops.entries.size}/${counts.ops}、claims ${read.claims.entries.size}/${counts.claims}、activities ${read.activities.entries.size}/${counts.activities}）`);
      const state = emptyState(this.cityId);
      state.lastSeq = manifest.seq;
      for (const [key, value] of read.ops.entries) state.opSeqs.set(key, value);
      for (const [key, value] of read.claims.entries) state.claims.set(key, value);
      for (const [key, packed] of read.activities.entries) state.activities.set(key, await this.unpackRecord(packed));
      state.resources = manifest.resources ?? state.resources;
      state.work = manifest.work ?? state.work;
      state.plan = manifest.plan ?? state.plan;
      state.buildings = manifest.buildings ? await this.blobs.getValue(manifest.buildings) : state.buildings;
      return { state, segment: manifest.segment };
    } catch (error) {
      // 內容不符、頁面壞掉、內容檔（blob）對不上雜湊…都是「這份 checkpoint 不可信」。
      throw incomplete(String(error?.message ?? error));
    }
  }

  /**
   * checkpoint 不可信時把它從 head 拿掉（連根摘要一起）：之後不會每次讀取都再讀一次壞掉的
   * 快照，下一次做 checkpoint 會重新寫一份。記憶體裡的 `head` 也要同步，否則之後的換段寫入
   * 會把已經丟棄的 checkpoint 又寫回去。
   */
  async discardCheckpoint() {
    const { text, head } = await this.head();
    if (!(head.checkpoint >= 0)) return;
    const next = { ...head, checkpoint: -1, checkpointDigest: null };
    const nextText = `${JSON.stringify(next)}\n`;
    try {
      await this.io.write(this.headPath(), nextText, text);
      if (this.cache) this.cache.headText = nextText;
    } catch (error) {
      rejectUnlessConflict(error); // head 只是快取：寫不進去也不影響這次的重建
    }
    if (this.cache) this.cache.head = next;
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

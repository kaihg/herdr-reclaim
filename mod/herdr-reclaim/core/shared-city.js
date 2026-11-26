// 共用城市（#23）：同一份本機使用者資料共用一座城、一個倉庫（ADR-0001、CONTEXT.md）。
//
// 工作來源（repo、space、session、provider）只決定「這是不是有效工作」，不決定城市或庫存：
// 每一次有效工作都讓同一個倉庫累積基本建材，所以換專案、`/new`、恢復對話與換 provider
// 都不會另開工地，也不會改變收入——同樣的有效工作切成長短不同的對話，收成相同。
//
// 有效工作的判準沿用研究（§7.4）：互動的 root／fork 樹、已結束的回合、只算 non-cache
// input + output、用量未知的回合不結算、child 併進同一棵樹。差別只在這裡不限哪一座舊城：
// 所有 repo 的工作都進同一個計量器；commit 不再另外加碼（#28、ADR 0002）。
//
// 這一票交付「工作 → 基本建材 + 常駐庫存」。
// 選址與佇列見 #25／#26、ADR 0003；#33 起，入庫、工地進度與隊首付料是同一筆帳。
// 舊版各城帳本留在磁碟上，不讀也不改。
import { claimKey, planKey } from "./ledger.js";
import { needs, roadsideSites } from "./roadside.js";
import { BUILD_QUEUE_LIMIT, BUILDINGS_V12, CITY_BUILDINGS, POPULATION_VERSION, START_RESOURCES, START_ROAD_LENGTH, TERRAIN_VERSION, WORK_TOKENS_PER_UNIT, WORK_YIELD, isBuilding, recipeOf } from "./rules.js";
import { buildingCount, maintenanceRate, workforce } from "./economy.js";
import { missingOf } from "./city-map.js";
import { createsTile, rootOf, roundsOf, sessionIndex } from "./research.js";

/**
 * 共用城市的帳本身份。它不是 git common dir，所以不會與任何舊城（repo 路徑）相撞；
 * `sharedCityDir` 也刻意放在 `cities/` 之外，掃舊目錄的地方不會把共用帳本當成一座舊城。
 */
export const SHARED_CITY_ID = "shared-v2";

/** 城市識別碼也是帳本目錄名；不開啟舊版的 shared/ 或 cities/。 */
export function sharedCityDir(baseDir) {
  return `${baseDir}/${SHARED_CITY_ID}`;
}

/**
 * 一個用量來源的身份：一份工作只入帳一次。
 * adapter 有給 `sourceKey` 時用它（同一支 session 恢復後的新 epoch 會回報同一把 key）；
 * 沒給時用（session、writer epoch、事件序號）當身份——兩支 session 的同一個序號仍是兩份工作。
 */
function sourceKeyOf(record, event, provider, usage) {
  if (typeof usage.sourceKey === "string" && usage.sourceKey !== "") return `${provider}#${usage.sourceKey}`;
  return `${provider}#${record.sessionId}@@${record.writerEpoch ?? ""}@@${event.eventSeq}`;
}

/**
 * 把活動紀錄裡已結束的有效工作回合換成收入結算（純函式：不碰 I/O，回傳要寫進帳本的操作）。
 * `claims` 是這座城已入帳的 claim 索引（`state.claims`）：來源鍵已在帳本裡的用量不再計算，
 * 所以兩個 space、兩個視窗或恢復對話後重送同一份紀錄都只入帳一次。
 */
export function planIncome({ activities = [], cityId = SHARED_CITY_ID, claims = new Map(), since = null } = {}) {
  const byId = sessionIndex(activities);
  const claimed = new Set(claims.keys());
  const settlements = [];
  for (const record of activities ?? []) {
    const root = rootOf(byId, record.sessionId);
    if (!createsTile(root)) continue; // print／headless 與沒有 root 的孤兒紀錄不算工作
    const { rounds } = roundsOf(record); // 沒有結束的回合（沒有 close）不結算
    for (const round of rounds) {
      // 啟用邊界：共用城市從第一次啟用那一刻起計收入，之前已結束的舊城歷史不重發（#22：
      // 舊城資料的轉換另行規劃，這張票不授權把既有歷史倒進新帳本）。
      if (since != null && Number(round.closeAt) < Number(since)) continue;
      // 同一把來源 key 在回合內可能被修正多次（例如 Claude 的 PreCompact 缺欄位快照 → 完整快照 →
      // Stop）：以最後一份為準，再判斷未知欄位與 token，與 adapter「修正保留 sourceKey、最後一份
      // 快照為準」的約定一致。事件已依 eventSeq 排序，後到的覆蓋先到的。
      const latest = new Map();
      for (const event of round.usage) {
        for (const [provider, usage] of Object.entries(event.usage ?? {})) latest.set(sourceKeyOf(record, event, provider, usage), usage);
      }
      const sources = [];
      let unknown = false;
      for (const [key, usage] of latest) {
        // 用量未知的回合整回合不結算（與研究同一條規則）：不發不該給的建材，重播結果也一樣。
        if (Array.isArray(usage.unknownFields) && usage.unknownFields.length > 0) { unknown = true; continue; }
        const tokens = Number(usage.inputNonCache ?? 0) + Number(usage.output ?? 0);
        if (tokens <= 0) continue; // cache read／write 不算工作
        sources.push({ key, tokens });
      }
      if (unknown) continue;
      // 同一個回合內重複回報的來源只算一次；已入帳的來源不再算。
      const fresh = [];
      for (const source of sources) {
        const claim = claimKey(cityId, source.key);
        if (claimed.has(claim)) continue;
        claimed.add(claim);
        fresh.push(source);
      }
      if (fresh.length === 0) continue;
      const tokens = fresh.reduce((sum, source) => sum + source.tokens, 0);
      settlements.push({
        opId: `income:${cityId}:${record.sessionId}@@${record.writerEpoch ?? ""}@@${round.openSeq}`,
        at: round.closeAt,
        openAt: round.openAt,
        cityId,
        rootSessionId: root.sessionId,
        sessionId: record.sessionId,
        writerEpoch: record.writerEpoch ?? null,
        round: `${record.sessionId}@@${record.writerEpoch ?? ""}@@${round.openSeq}`,
        tokens,
        sources: fresh.map((source) => source.key),
      });
    }
  }
  settlements.sort((a, b) => a.at - b.at || a.opId.localeCompare(b.opId));
  return settlements;
}

/** 記下共用城市的啟用時間（只寫一次）：之後每次開帳本都沿用同一筆，重播結果不變。 */
async function startWork(ledger, at) {
  const since = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  await ledger.submit(() => ({
    opId: `work-start:${ledger.cityId}`,
    kind: "workStart",
    at: since,
    cityId: ledger.cityId,
    terrainVersion: TERRAIN_VERSION,
    terrainSeed: since >>> 0,
    roadArmLength: START_ROAD_LENGTH,
    resources: START_RESOURCES,
  }));
  return since;
}

/**
 * 把可以結算的工作回合寫進共用帳本。`activities` 要用帳本保存的那一份（adapter 的磁碟快照
 * 會被 ack compact，帳本不會）；重複呼叫、重播或兩個視窗同時送，都不會重複入帳。
 * `activateAt` 只給測試用：正式 runtime 由第一次啟用的當下決定，之前的舊城歷史不重發。
 */
export async function ingestIncome(ledger, { activities = [], activateAt } = {}) {
  // 啟用邊界只寫一次：第一次開共用帳本時記下「現在」（或呼叫端給的固定時間，測試用）。
  const state = await ledger.state();
  const since = state.work?.since ?? await startWork(ledger, activateAt);
  const settlements = planIncome({ activities, cityId: ledger.cityId, claims: state.claims, since });
  const results = [];
  for (const settlement of settlements) {
    // 收成依「提交當下」的計量器餘數計算（不是單一回合的 token）：CAS 重試時重新讀到最新餘數，
    // 兩個視窗同時提交也不會有人把別人的餘數吃掉。entry 存的是實際發出的建材。
    const result = await ledger.submit(() => ({ ...settlement, kind: "income" }));
    results.push(result);
  }
  return { settlements, results };
}

/**
 * 公開的共用城市讀取模型：庫存、工作進度、建設佇列與已完工的建築。
 * 各 space 讀到的是同一份資料（同一個帳本），所以切 repo 或重開 herdr 庫存與佇列都一樣。
 * `queue` 依開工順序排列；施工中的一項以 `remainingUnits` 表示還需幾份進帳。
 *
 * `missing` 沿佇列累計：排在前面的項目會先用掉庫存，所以第二項的「還缺」是扣掉前面幾項配方
 * 之後的差額，不是「現在庫存夠不夠」。付款只在隊首發生，這個數字就是它還要等多少材料。
 */
export function readSharedCity(state = {}) {
  const pool = Object.fromEntries(Object.entries(state.resources ?? {}).map(([key, amount]) => [key, Number(amount ?? 0)]));
  const queue = (state.queue ?? []).map((item) => {
    const copy = { ...item, costs: { ...item.costs }, cells: (item.cells ?? []).map((cell) => ({ ...cell })) };
    const running = isBuilding(item);
    copy.stage = running ? "building" : "queued";
    copy.missing = running ? {} : missingOf(copy.costs, pool);
    if (running) {
      const elapsed = item.startedUnit == null ? 0 : (state.work?.units ?? 0) - item.startedUnit;
      const defs = item.rulesVersion >= POPULATION_VERSION ? CITY_BUILDINGS : BUILDINGS_V12;
      copy.remainingUnits = defs[item.building].buildUnits - elapsed;
    }
    // 這一項之後就輪到下一項：排隊中的配方先從池子裡扣掉（已開工的那一項早就付過了）。
    if (!running) for (const [key, amount] of Object.entries(copy.costs)) pool[key] = Number(pool[key] ?? 0) - Number(amount);
    return copy;
  });
  const buildings = state.buildings ?? [];
  const { capacity, assigned, understaffed } = workforce(buildings);
  const resources = Object.fromEntries(Object.keys(WORK_YIELD).map(k => [k, Number(state.resources?.[k] ?? 0)]));
  const city = { ...state, buildings, queue, resources };
  const priority = needs(city);
  return {
    schema: 2,
    lastSeq: state.lastSeq ?? -1,
    city: {
      cityId: state.cityId ?? SHARED_CITY_ID,
      name: "共用城市",
      terrainVersion: state.terrainVersion,
      terrainSeed: state.terrainSeed,
      roadArmLength: state.roadArmLength,
      resources,
      shortage: priority[0],
      roadsideFull: !isBuilding(queue[0] ?? {}) && state.work?.roadsideFull === true,
      work: { units: state.work?.units ?? 0, tokens: Number(state.work?.tokens ?? 0), unitTokens: WORK_TOKENS_PER_UNIT },
      population: { assigned, capacity },
      maintenance: maintenanceRate(buildingCount(buildings)),
      queue,
      queueLimit: BUILD_QUEUE_LIMIT,
      buildings: buildings.map((building) => ({
        ...building,
        understaffed: understaffed.has(building),
        costs: { ...building.costs },
        cells: building.cells.map((cell) => ({ ...cell })),
      })),
    },
  };
}

/**
 * 在佇列尾端預定一項（#25、ADR 0003）：選一棟建築與錨點，整片占地先保留、**不動庫存**；
 * 排到隊首、庫存足以支付整份配方時才一次付清開工。兩個視窗同時送出時由帳本的前提檢查裁決
 * （佇列上限、占地），被拒的一邊不會留下半片占地；opId 綁住建築與錨點，同一處重送是重播，
 * 不同處才是新的項目。預定成功之後立刻推進：佇列本來是空的、材料又夠，這一項就當場開工。
 */
export async function placePlan(ledger, { building, x, y, at } = {}) {
  const def = CITY_BUILDINGS[building];
  const when = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  return ledger.submit((current) => ({
    opId: `plan:${ledger.cityId}:${building}:${x},${y}:${when}`,
    kind: "plan",
    at: when,
    cityId: ledger.cityId,
    building,
    x,
    y,
    w: def?.footprint.w ?? 0,
    h: def?.footprint.h ?? 0,
    costs: recipeOf(current, building),
  }));
}

/**
 * 取消佇列裡還沒開工的一項（ADR 0003）：那一項還沒付款，所以只是把占地與名額交還，庫存不動
 * （舊帳本裡預定時就扣過料的項目由帳本全額退回）。
 * 已開工的項目不能取消（`already_started`）；被拒的取消不寫任何東西，帳本與庫存都不動。
 */
export async function cancelPlan(ledger, item) {
  const plan = planKey(item);
  return ledger.submit(current => ({
    opId: `cancel:${ledger.cityId}:${plan}`,
    kind: "cancel",
    at: Date.now(),
    cityId: ledger.cityId,
    plan,
    // 只有已停工才需要重新判斷釋出的土地；重播沿用取消時的答案。
    ...(current.work.roadsideFull ? { roadsideFull: !roadsideSites({
      ...current, queue: current.queue.filter(p => planKey(p) !== plan),
    })(["people"]) } : {}),
  }));
}

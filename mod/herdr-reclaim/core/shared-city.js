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
// 選址與預定地是 #25；備料到齊自動開工、到期完工是 #26（`advanceConstruction`）。#22 之後
// 程式只讀寫這一本帳本：舊版各城帳本（`cities/<hash>/`）原封不動留在磁碟上，不讀也不改它們。
import { claimKey, planKey } from "./ledger.js";
import { CITY_BUILDINGS, WORK_TOKENS_PER_UNIT, WORK_YIELD, affordable, workYieldOf } from "./rules.js";
import { missingOf } from "./city-map.js";
import { createsTile, rootOf, roundsOf, sessionIndex } from "./research.js";

/**
 * 共用城市的帳本身份。它不是 git common dir，所以不會與任何舊城（repo 路徑）相撞；
 * `sharedCityDir` 也刻意放在 `cities/` 之外，掃舊目錄的地方不會把共用帳本當成一座舊城。
 */
export const SHARED_CITY_ID = "shared";

/** 共用帳本的目錄：`<adapterRoot>/shared`（`<adapterRoot>/cities/` 是舊版各城帳本）。 */
export function sharedCityDir(baseDir) {
  return `${baseDir}/shared`;
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
    const result = await ledger.submit((current) => ({
      opId: settlement.opId,
      kind: "income",
      at: settlement.at,
      openAt: settlement.openAt,
      cityId: settlement.cityId,
      rootSessionId: settlement.rootSessionId,
      sessionId: settlement.sessionId,
      writerEpoch: settlement.writerEpoch,
      round: settlement.round,
      tokens: settlement.tokens,
      sources: settlement.sources,
      resources: workYieldOf(Number(current.work?.tokens ?? 0) + settlement.tokens),
    }));
    results.push(result);
    // 這一筆收成可能剛好補齊預定地的材料：入帳之後立刻檢查，不等畫面推進。
    if (result.status === "applied") await startIfReady(ledger);
  }
  return { settlements, results };
}

/**
 * 備料到齊就開工（#26）：有預定地、還沒開工、庫存足以支付預定時的完整配方，才送出一筆 construct。
 * 開工時間是材料到齊的那一刻：下令時間與入庫建材裡最晚那一筆（`work.stockedAt`）取晚者——晚到的
 * 較早工作不會讓工期回溯，關著畫面的那段時間也照算。opId 綁住目標，兩個視窗同時達標、重播或重開
 * 都只扣一次；沒有預定地時什麼都不做——不替玩家選下一棟。
 */
async function startIfReady(ledger) {
  return ledger.submit((current) => {
    const plan = current.plan;
    if (!plan || plan.startedAt != null || !affordable(plan.costs, current.resources)) return null;
    return {
      opId: `construct:${ledger.cityId}:${planKey(plan)}`,
      kind: "construct",
      at: Math.max(Number(plan.at), Number(current.work?.stockedAt ?? plan.at)),
      cityId: ledger.cityId,
      plan: planKey(plan),
      building: plan.building,
      costs: { ...plan.costs },
      buildMs: CITY_BUILDINGS[plan.building]?.buildMs,
    };
  });
}

/**
 * 推進唯一的建設目標（#26）：材料齊了就開工（入帳中斷而漏開的那一筆由這裡補上），工期到了就
 * 完工。完工的時間是開工加工期，不是 `now`；完工之後只存料，不支付下一棟。
 * 畫面每次重載與施工計時到期時呼叫；多個視窗同時呼叫只會有一筆開工、一筆完工。
 */
export async function advanceConstruction(ledger, { now = Date.now() } = {}) {
  const started = await startIfReady(ledger);
  const completed = await ledger.submit((current) => {
    const plan = current.plan;
    if (!plan || plan.startedAt == null || Number(plan.completesAt) > Number(now)) return null;
    return {
      opId: `complete:${ledger.cityId}:${planKey(plan)}`,
      kind: "complete",
      at: Number(plan.completesAt),
      cityId: ledger.cityId,
      plan: planKey(plan),
      building: plan.building,
      reveal: CITY_BUILDINGS[plan.building]?.reveal,
    };
  });
  return { started, completed };
}

/**
 * 公開的共用城市讀取模型：庫存、工作進度、唯一的建設目標與已完工的建築。
 * 各 space 讀到的是同一份資料（同一個帳本），所以切 repo 或重開 herdr 庫存與預定地都一樣。
 * `plan.stage` 是 `reserved`（預定地，備料中）或 `building`（已付料施工中，`completesAt` 完工）；
 * `plan.missing` 只在備料中有意義：配方減掉現在庫存的差額，開工之後已經付清，是空的。
 */
export function readSharedCity(state = {}) {
  const plan = state.plan
    ? { ...state.plan, costs: { ...state.plan.costs }, cells: (state.plan.cells ?? []).map((cell) => ({ ...cell })) }
    : null;
  if (plan) {
    plan.stage = plan.startedAt != null ? "building" : "reserved";
    plan.missing = plan.stage === "reserved" ? missingOf(plan.costs, state.resources) : {};
  }
  return {
    schema: 1,
    city: {
      cityId: state.cityId ?? SHARED_CITY_ID,
      name: "共用城市",
      resources: Object.fromEntries(Object.keys(WORK_YIELD).map((key) => [key, Number(state.resources?.[key] ?? 0)])),
      work: { tokens: Number(state.work?.tokens ?? 0), unitTokens: WORK_TOKENS_PER_UNIT },
      plan,
      buildings: (state.buildings ?? []).map((building) => ({
        ...building,
        costs: { ...building.costs },
        cells: building.cells.map((cell) => ({ ...cell })),
      })),
    },
  };
}

/**
 * 指定建設目標（#25）：選一棟建築與錨點，整片占地成為唯一的預定地。不預扣庫存——缺料也能先指定；
 * 下令當下庫存已經夠，就在同一刻開工（#26）。兩個視窗同時送出時由帳本的前提檢查裁決：最多一個
 * 生效，另一個整筆被拒，不會留下半片占地；opId 綁住建築與錨點，同一處重送是重播，不同處才是第二個目標。
 */
export async function placePlan(ledger, { building, x, y, at } = {}) {
  const def = CITY_BUILDINGS[building];
  const when = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  const result = await ledger.submit(() => ({
    opId: `plan:${ledger.cityId}:${building}:${x},${y}:${when}`,
    kind: "plan",
    at: when,
    cityId: ledger.cityId,
    building,
    x,
    y,
    w: def?.footprint.w ?? 0,
    h: def?.footprint.h ?? 0,
    costs: { ...(def?.costs ?? {}) },
  }));
  if (result.status === "applied") await startIfReady(ledger);
  return result;
}


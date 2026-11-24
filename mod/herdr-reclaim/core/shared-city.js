// 共用城市（#23）：同一份本機使用者資料共用一座城、一個倉庫（ADR-0001、CONTEXT.md）。
//
// 工作來源（repo、space、session、provider）只決定「這是不是有效工作」，不決定城市或庫存：
// 每一次有效工作都讓同一個倉庫累積基本建材，所以換專案、`/new`、恢復對話與換 provider
// 都不會另開工地，也不會改變收入——同樣的有效工作切成長短不同的對話，收成相同。
//
// 有效工作的判準沿用研究（§7.4）：互動的 root／fork 樹、已結束的回合、只算 non-cache
// input + output、用量未知的回合不結算、child 併進同一棵樹。差別只在這裡不限哪一座舊城：
// 所有 repo 的工作都進同一個計量器，而且沒有可歸屬 commit 的限制（那是 #24 的額外收成）。
//
// 這一票只交付「工作 → 基本建材 + 常駐庫存」。選址、預定地與自動施工是 #25–#27；
// 舊版各城帳本（`cities/<hash>/`）原封不動：共用帳本放在別的目錄，不讀也不改它們。
import { claimKey } from "./ledger.js";
import { WORK_TOKENS_PER_UNIT, WORK_YIELD, workYieldOf } from "./rules.js";
import { createsTile, rootOf, roundsOf, sessionIndex } from "./research.js";

/**
 * 共用城市的帳本身份。它不是 git common dir，所以不會與任何舊城（repo 路徑）相撞；
 * `sharedCityDir` 也刻意放在 `cities/` 之外，掃舊城的地方（main.js 的 cityIdsFromLedgers）
 * 因此不會把共用帳本當成一座舊城。
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
      const sources = [];
      let unknown = false;
      for (const event of round.usage) {
        for (const [provider, usage] of Object.entries(event.usage ?? {})) {
          // 用量未知的回合整回合不結算（與研究同一條規則）：不發不該給的建材，重播結果也一樣。
          if (Array.isArray(usage.unknownFields) && usage.unknownFields.length > 0) { unknown = true; continue; }
          const tokens = Number(usage.inputNonCache ?? 0) + Number(usage.output ?? 0);
          if (tokens <= 0) continue; // cache read／write 不算工作
          sources.push({ key: sourceKeyOf(record, event, provider, usage), tokens });
        }
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
    results.push(await ledger.submit((current) => ({
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
    })));
  }
  return { settlements, results };
}

/**
 * 公開的共用城市讀取模型：只有庫存與工作進度，沒有工地。
 * 各 space 讀到的是同一份資料（同一個帳本），所以切 repo 或重開 herdr 庫存都一樣。
 */
export function readSharedCity(state = {}) {
  return {
    schema: 1,
    city: {
      cityId: state.cityId ?? SHARED_CITY_ID,
      name: "共用城市",
      resources: Object.fromEntries(Object.keys(WORK_YIELD).map((key) => [key, Number(state.resources?.[key] ?? 0)])),
      work: { tokens: Number(state.work?.tokens ?? 0), unitTokens: WORK_TOKENS_PER_UNIT },
    },
  };
}

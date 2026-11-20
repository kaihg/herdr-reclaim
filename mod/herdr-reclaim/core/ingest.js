// 把 adapter 的活動紀錄（§6.1）與「遠征取得土地」寫進城帳本（ticket #3）。
//
// 每城各有一份帳本（§13），所以呼叫端給 cityId，只寫碰到這座城的活動與取得土地操作。
// adapter 的快照會依 ack compact；同一 writer 的新尾巴要接回 journal 已保存的 visit。
import { bfsNextTile, keyOf } from "./grid.js";
import { planExpeditions } from "./town.js";
import { activityKey } from "./ledger.js";
import { planResearch } from "./research.js";
import { RECIPES, TRADE_RATE } from "./rules.js";

/** 這支 session 的紀錄有沒有碰到這座城（含 compact 前已在帳本保存的 visit）。 */
function touchesCity(record, cityId) {
  return (record?.events ?? []).some((event) => event.visit?.commonDir === cityId);
}

/** 一個 writer epoch 的紀錄寫成一筆 activity entry（內容是事件陣列）。 */
export async function ingestActivities(ledger, activities, cityId) {
  const results = [];
  const previous = await ledger.state();
  for (const record of activities ?? []) {
    const events = record.events ?? [];
    if (events.length === 0) continue; // 已全部 ack 的 compacted 快照沒有新操作
    const existing = previous.activities.get(activityKey(record));
    if (cityId && !touchesCity(record, cityId) && !touchesCity(existing, cityId)) continue;
    const lastEventSeq = events.reduce((latest, event) => Math.max(latest, event.eventSeq ?? 0), 0);
    const result = await ledger.submit(() => ({
      opId: `activity:${record.sessionId}:${record.writerEpoch}:${lastEventSeq}`,
      kind: "activity",
      at: record.updatedAt ?? events[events.length - 1]?.at ?? 0,
      sessionId: record.sessionId,
      writerEpoch: record.writerEpoch,
      role: record.role ?? "root",
      interactive: record.interactive === true,
      parentSessionId: record.parentSessionId ?? null,
      cli: record.cli ?? null,
      updatedAt: record.updatedAt ?? 0,
      lastEventSeq,
      blobs: { events },
    }));
    results.push(result);
    // §6.2：ack 在 journal 提交成功之後才寫。上一次中斷或重播時 entry 已經在，
    // 這裡補上同一筆（journalSeq 是 entry 的位置，不是這次嘗試的位置）。
    if (result.status === "applied" || result.status === "duplicate") {
      await ledger.writeAck({
        sessionId: record.sessionId,
        writerEpoch: record.writerEpoch,
        ackedEventSeq: lastEventSeq,
        journalSeq: result.journalSeq,
      });
    }
  }
  return results;
}

/**
 * 「遠征取得土地」：座標在 `make` 裡依當下的帳本狀態重新用 BFS 算，
 * CAS 失敗重讀時就會拿到新的空格（§13.1 的重新檢查前提）。
 */
export async function ingestExpeditions(ledger, scenario, cityId) {
  const results = [];
  for (const plan of planExpeditions(scenario)) {
    if (cityId && plan.cityId !== cityId) continue;
    results.push(await ledger.submit((state) => expeditionOp(state, plan)));
  }
  return results;
}

export async function ingestScenario(ledger, scenario, cityId) {
  const results = {
    activities: await ingestActivities(ledger, scenario.activities, cityId),
    expeditions: await ingestExpeditions(ledger, scenario, cityId),
  };
  // 沒有進 journal 的操作不能當成完成：寧可讓畫面說讀取失敗，也不要畫一座少了格子的城。
  for (const result of [...results.activities, ...results.expeditions]) {
    if (result.status !== "applied" && result.status !== "duplicate") {
      throw new Error(`帳本沒有接受這筆操作：${result.status}${result.reason ? `（${result.reason}）` : ""}`);
    }
  }
  return results;
}

/** 這一座城已經被佔用的座標。 */
function takenOf(state, cityId) {
  const taken = new Set();
  for (const tile of state.tiles) {
    if (tile.cityId === cityId && tile.landStage !== "withdrawn") taken.add(`${tile.x},${tile.y}`);
  }
  return taken;
}


export function expeditionOp(state, plan) {
  const taken = takenOf(state, plan.cityId);
  const spot = bfsNextTile((candidate) => taken.has(keyOf(candidate)));
  return {
    opId: `expedition:${plan.cityId}:${plan.rootSessionId}:${plan.generation}`,
    kind: "expedition",
    at: plan.at ?? 0,
    cityId: plan.cityId,
    rootSessionId: plan.rootSessionId,
    generation: plan.generation,
    activatedAt: plan.activatedAt ?? plan.at ?? 0,
    x: spot.x,
    y: spot.y,
    cli: plan.cli ?? null,
    repo: plan.repo ?? null,
  };
}

/** 撤回／封存：資格檢查和操作以一筆 journal CAS 原子完成。 */
export async function processLand(ledger, { rootSessionId, generation, action, at }) {
  return ledger.submit(() => ({
    opId: `${action}:${ledger.cityId}:${rootSessionId}:${generation}`,
    kind: "landAction",
    at,
    cityId: ledger.cityId,
    rootSessionId,
    generation,
    action,
  }));
}

/** 重新派遣以當下帳本重新 BFS，generation、工作點與加速點重新起算。 */
export async function redispatch(ledger, { rootSessionId, at }) {
  return ledger.submit((state) => {
    const previousGeneration = state.currentGen.get(`${ledger.cityId}@@${rootSessionId}`);
    if (previousGeneration === undefined) return null;
    const previous = state.tileById.get(`${ledger.cityId}@@${rootSessionId}@@${previousGeneration}`);
    if (!previous || !["withdrawn", "archived"].includes(previous.landStage)) return null;
    return expeditionOp(state, {
      cityId: ledger.cityId,
      rootSessionId,
      generation: previousGeneration + 1,
      at,
      activatedAt: at,
      cli: previous.cli,
      repo: previous.repo,
    });
  });
}

/**
 * 加速（§7.6）：目標用「遠征身份 + generation」指定，不用座標。前提不符就整筆不扣卷、不加點。
 * `opId` 由呼叫端決定，同一次操作重送（中斷後重試）要沿用同一個 ID 才不會重複扣卷。
 */
export async function processBoost(ledger, { rootSessionId, generation, scrolls, at, opId }) {
  return ledger.submit(() => ({
    opId: opId ?? `boost:${ledger.cityId}:${rootSessionId}:${generation}:${at}`,
    kind: "boost",
    at,
    cityId: ledger.cityId,
    rootSessionId,
    generation,
    scrolls,
  }));
}

/** 市集（§7.6、§11）：同城任兩種資源 3 換 1；庫存不足時整筆不執行，不會有部分交易。 */
export async function processTrade(ledger, { from, to, amount, at, opId }) {
  return ledger.submit(() => ({
    opId: opId ?? `trade:${ledger.cityId}:${from}:${to}:${amount}:${at}`,
    kind: "trade",
    at,
    cityId: ledger.cityId,
    from,
    to,
    amount,
    rate: TRADE_RATE,
  }));
}

/**
 * 蓋房（§7.6、§8.1）：配方由規則表決定，實付資源跟著 entry 一起存下來。
 * 呼叫端只指定配方名稱；`costs` 在這裡從規則表複製，precheck 會核對它跟規則表一致。
 */
export async function processBuild(ledger, { rootSessionId, generation, recipe, at, opId }) {
  const definition = RECIPES[recipe];
  return ledger.submit(() => ({
    opId: opId ?? `build:${ledger.cityId}:${rootSessionId}:${generation}:${recipe}:${at}`,
    kind: "build",
    at,
    cityId: ledger.cityId,
    rootSessionId,
    generation,
    recipe,
    costs: definition ? { ...definition.costs } : null,
  }));
}

/**
 * 研究（§7.4）：把可以結算的回合寫成帳本的一筆 entry。operation ID 由回合身份決定，
 * 所以重播同一份活動與證據不會再次發放；已經落帳的進度不因為來源晚到而倒扣。
 * `activities` 要用帳本裡保存的活動紀錄（adapter 的快照會被 ack compact，帳本不會）。
 */
export async function ingestResearch(ledger, { activities, commits, cityId = ledger.cityId }) {
  const plan = planResearch({ activities, commits, cityId });
  const state = await ledger.state();
  const results = [];
  for (const settlement of plan.settlements) {
    if (state.opSeqs.has(settlement.opId)) continue;
    results.push(await ledger.submit(() => ({
      opId: settlement.opId,
      kind: "research",
      at: settlement.at,
      cityId,
      rootSessionId: settlement.rootSessionId,
      sessionId: settlement.sessionId,
      writerEpoch: settlement.writerEpoch,
      round: settlement.round,
      tokens: settlement.tokens,
    })));
  }
  return { ...plan, results };
}

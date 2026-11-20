// 把 adapter 的活動紀錄（§6.1）與「遠征取得土地」寫進城帳本（ticket #3）。
//
// 一個帳本只管一座城（§13：每個城有自己的目錄），所以呼叫端要給 cityId：
// 只寫「visit 碰到這座城」的活動紀錄，以及屬於這座城的取得土地操作。
// 這一票的來源是固定事件情境（scenarios/first-expedition.js）；#5 之後改成 adapter
// 寫的活動檔，接點不變。寫入順序與 readTown 建格的順序相同，重播結果才會一致。
import { bfsNextTile, keyOf } from "./grid.js";
import { planExpeditions } from "./town.js";

/** 這支 session 的紀錄有沒有碰到這座城（附錄 §6.1 的 visit 帶 commonDir）。 */
function touchesCity(record, cityId) {
  return (record.events ?? []).some((event) => event.visit?.commonDir === cityId);
}

/** 一個 writer epoch 的紀錄寫成一筆 activity entry（內容是事件陣列）。 */
export async function ingestActivities(ledger, activities, cityId) {
  const results = [];
  for (const record of activities ?? []) {
    if (cityId && !touchesCity(record, cityId)) continue;
    const events = record.events ?? [];
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
    if (tile.cityId === cityId) taken.add(`${tile.x},${tile.y}`);
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
    x: spot.x,
    y: spot.y,
    cli: plan.cli ?? null,
    repo: plan.repo ?? null,
  };
}

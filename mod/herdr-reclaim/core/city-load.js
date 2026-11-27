// 正式載入路徑（#22）：活動檔 → 共用帳本 → 公開的共用城市讀取模型。
//
// 只有這條路：沒有各 repo 的舊帳本（`cities/`）、沒有遠征建格、也沒有 commit 收成
// （#28、ADR 0002：收入只看工作量）。`loadCity` 是 main.js 開機與 watch 變更時呼叫的
// 那一個函式，也是測試走的那一個——兩者不能各自拼一條「差不多」的流程，否則整合層的
// 行為沒有被任何測試釘住。
//
// 主機相依的部分由呼叫端注入：
//   `list(dir)`  列檔案（herdr 的 mod 沒有 listdir）
import { loadActivities, mergeActivities } from "./adapter.js";
import { CityLedger, activityDelta, activityKey } from "./ledger.js";
import { SHARED_CITY_ID, ingestIncome, readSharedCity, sharedCityDir } from "./shared-city.js";

/**
 * 一次完整的重讀：adapter 的活動檔寫進帳本（§6.2），與帳本保存的那一份合併之後入帳，
 * 每筆收入同時推進對應的工期，最後回傳公開讀取模型。
 *
 * `activities` 可以覆寫（測試給固定的事件）；沒有給就讀磁碟。
 * `ledger` 可傳入這座城已開啟的實例，讓同一視窗後續重讀只重播新 entry。
 * `activateAt` 只給測試：正式 runtime 由第一次啟用的當下決定。
 */
export async function loadCity(io, { root, list, activities: given = null, activateAt, ledger } = {}) {
  const fromDisk = given ?? await loadActivities({ ...io, list }, `${root}/activity`);
  ledger ??= await new CityLedger({ io, dir: sharedCityDir(root), cityId: SHARED_CITY_ID }).open();
  await ledger.maybeCheckpoint();
  // 磁碟上的新事件先寫進 journal，成功之後才寫 ack（adapter 下一次才敢 compact）。
  await recordActivities(ledger, fromDisk);
  const state = await ledger.state();
  // adapter 的磁碟快照會被 ack compact；帳本保存的那一份才是完整的，兩邊取聯集。
  const activities = mergeActivities([...state.activities.values(), ...fromDisk]);
  await ingestIncome(ledger, { activities, activateAt });
  return { city: readSharedCity(await ledger.state()), activities };
}

/**
 * 畫面讀的模型：公開的共用城市放在 `town.shared`（render 與所有操作都從這裡讀，操作之後的
 * 重讀也是 `{ ...town, shared }`）。`loadCity` 回傳的 `city` 是同一份，這裡只是把它放到畫面
 * 認得的鍵上；獨立成函式，是因為 main.js 匯入 host API、bun 測不到，形狀不對時整個畫面會
 * 永遠停在「還沒啟用」，單元測試與 `herdr-app check`（用固定情境）都看不出來。
 */
export function townOf(loaded, quotas) {
  const { city: shared, ...rest } = loaded;
  return { ...rest, shared, quotas };
}

/**
 * adapter 磁碟上的活動尾巴 → `activity` entry，並在 entry 成立之後寫 ack（§6.2）。
 *
 * 在 submit 的 CAS 前提內計算差異；其他視窗搶先提交時，重試會看到它剛保存的事件。
 * ack 依據整份磁碟尾巴，而非這一次新增的事件；即使上次提交後沒寫到 ack 也能補回。
 */
export async function recordActivities(ledger, activities) {
  const results = [];
  for (const record of activities ?? []) {
    const events = record.events ?? [];
    if (events.length === 0) continue; // 已全部 ack 的 compacted 快照沒有新事件
    const lastEventSeq = events.reduce((latest, event) => Math.max(latest, event.eventSeq ?? 0), 0);
    const key = activityKey(record);
    const baseId = `activity:${ledger.cityId}:${key}@@${lastEventSeq}`;
    let saved;
    const result = await ledger.submit(state => {
      saved = state.activities.get(key);
      const delta = activityDelta(saved, events);
      if (!delta.length) return null;
      return {
        // 只修正內容時最大序號不變。綁定被修正的版本，避免撞上舊 opId，也允許改回原值。
        opId: saved?.lastEventSeq === lastEventSeq ? `${baseId}:after:${saved.seq}` : baseId,
        kind: "activity",
        at: record.updatedAt ?? events[events.length - 1]?.at ?? 0,
        cityId: ledger.cityId,
        sessionId: record.sessionId,
        writerEpoch: record.writerEpoch,
        role: record.role ?? "root",
        interactive: record.interactive === true,
        parentSessionId: record.parentSessionId ?? null,
        cli: record.cli ?? null,
        updatedAt: record.updatedAt ?? 0,
        lastEventSeq,
        blobs: { events: delta },
      };
    });
    results.push(result);
    // §6.2：ack 在 journal 提交成功之後才寫。上一次中斷或重播時 entry 已經在，這裡補上同一筆
    // （journalSeq 是 entry 的位置，不是這次嘗試的位置）。
    if (result.status === "applied" || result.status === "duplicate" || result.status === "nothing") {
      await ledger.writeAck({
        sessionId: record.sessionId,
        writerEpoch: record.writerEpoch,
        ackedEventSeq: lastEventSeq,
        journalSeq: result.journalSeq ?? saved.seq,
      });
    }
  }
  return results;
}


// 正式載入路徑（#22）：活動檔 → 共用帳本 → 公開的共用城市讀取模型。
//
// 只有這條路：沒有各 repo 的舊帳本（`cities/`）、沒有遠征建格、也沒有 commit 收成
// （#28、ADR 0002：收入只看工作量）。`loadCity` 是 main.js 開機與 watch 變更時呼叫的
// 那一個函式，也是測試走的那一個——兩者不能各自拼一條「差不多」的流程，否則整合層的
// 行為沒有被任何測試釘住。
//
// 主機相依的部分由呼叫端注入：
//   `list(dir)`  列檔案（herdr 的 mod 沒有 listdir）
//   `now`        推進施工用的現在時刻（測試給固定值）
import { loadActivities, mergeActivities } from "./adapter.js";
import { CityLedger } from "./ledger.js";
import { SHARED_CITY_ID, advanceConstruction, ingestIncome, readSharedCity, sharedCityDir } from "./shared-city.js";

/**
 * 一次完整的重讀：adapter 的活動檔寫進帳本（§6.2），與帳本保存的那一份合併之後入帳，
 * 再推進工期已到的完工，最後回傳公開讀取模型。
 *
 * `activities` 可以覆寫（測試給固定的事件）；沒有給就讀磁碟。
 * `activateAt` 只給測試：正式 runtime 由第一次啟用的當下決定。
 */
export async function loadCity(io, { root, list, activities: given = null, now = Date.now(), activateAt } = {}) {
  const fromDisk = given ?? await loadActivities({ ...io, list }, `${root}/activity`);
  const ledger = await new CityLedger({ io, dir: sharedCityDir(root), cityId: SHARED_CITY_ID }).open();
  await ledger.maybeCheckpoint();
  // 磁碟上的新事件先寫進 journal，成功之後才寫 ack（adapter 下一次才敢 compact）。
  await recordActivities(ledger, fromDisk);
  const state = await ledger.state();
  // adapter 的磁碟快照會被 ack compact；帳本保存的那一份才是完整的，兩邊取聯集。
  const activities = mergeActivities([...state.activities.values(), ...fromDisk]);
  await ingestIncome(ledger, { activities, activateAt });
  await advanceConstruction(ledger, { now });
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
 * 只送磁碟上的那一份（adapter ack 後會 compact 掉已入帳的事件）；帳本把事件併回舊快照，
 * 所以 journal 保存的仍是完整的事件序列，重播看得到原本的 visit、區間與用量。同一份尾巴
 * 重送是 duplicate（opId 含 writer epoch 與最後的 eventSeq），不會重寫內容檔；ack 補在同一個
 * journal 位置。
 */
export async function recordActivities(ledger, activities) {
  const results = [];
  for (const record of activities ?? []) {
    const events = record.events ?? [];
    if (events.length === 0) continue; // 已全部 ack 的 compacted 快照沒有新事件
    const lastEventSeq = events.reduce((latest, event) => Math.max(latest, event.eventSeq ?? 0), 0);
    const result = await ledger.submit(() => ({
      opId: `activity:${ledger.cityId}:${record.sessionId}@@${record.writerEpoch ?? ""}@@${lastEventSeq}`,
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
      blobs: { events },
    }));
    results.push(result);
    // §6.2：ack 在 journal 提交成功之後才寫。上一次中斷或重播時 entry 已經在，這裡補上同一筆
    // （journalSeq 是 entry 的位置，不是這次嘗試的位置）。
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


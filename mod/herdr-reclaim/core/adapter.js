// 讀 OMP adapter（omp-extension/herdr-reclaim.ts）寫的活動檔，交給 ingest 寫進城帳本（#5）。
//
// adapter 與 mod 共用一個根目錄（§6.1）：adapter 寫 activity/，mod 在帳本提交成功之後
// 才在自己的城目錄寫 acks/。路徑由 appHome 決定，所以兩邊在隔離的 HERDR_APP_HOME 下
// 也看到同一份資料。
//
// mod 的 io 只有 read／write，沒有列目錄（herdr 的 readTextFile／writeTextFile），
// 所以列檔由 host 層提供：`io.list(dir)` 回該目錄底下所有活動檔的絕對路徑。
import { mergeActivities } from "./town.js";

/** 活動檔的目錄名（相對 appHome）。 */
export const ADAPTER_DIR = "data/herdr-reclaim";
export const ACTIVITY_DIR = "activity";

export function adapterRoot(appHomeDir) {
  return `${appHomeDir}/${ADAPTER_DIR}`;
}

export function activityDir(appHomeDir) {
  return `${adapterRoot(appHomeDir)}/${ACTIVITY_DIR}`;
}

/**
 * 讀出 adapter 目前所有的活動紀錄。同一個 epoch 的活動檔在磁碟上只有一份，
 * 但寫到一半、或同一份被讀兩次都要能重播出一樣的結果，所以走 mergeActivities：
 * 事件取聯集、重複的 eventSeq 只留一筆（§6.2）。
 */
export async function loadActivities(io, dir) {
  const records = [];
  for (const file of await io.list(dir)) {
    const text = await io.read(file);
    if (text === null) continue;
    let record = null;
    try {
      record = JSON.parse(text);
    } catch {
      continue; // 寫到一半的檔案：下一次重播再讀
    }
    if (record?.schema !== 1 || typeof record.sessionId !== "string") continue;
    records.push(record);
  }
  return mergeActivities(records);
}

/** 這些活動碰到的城（§13：一個帳本只管一座城）。 */
export function citiesOf(activities) {
  const ids = new Set();
  for (const record of activities ?? []) {
    for (const event of record.events ?? []) {
      if (event.visit?.commonDir) ids.add(event.visit.commonDir);
    }
  }
  return [...ids].sort();
}

/**
 * 開城時問 repo 有沒有 HEAD：舊城區與新村的唯一差別（§4）。
 * 這是設定檔等級的唯讀事實，拿不到就不猜（顯示「城鎮中心」）。
 */
export async function repoFactsOf(io, cityIds) {
  const facts = {};
  for (const cityId of cityIds) {
    facts[cityId] = { hadHead: (await io.read(`${cityId}/logs/HEAD`)) !== null };
  }
  return facts;
}

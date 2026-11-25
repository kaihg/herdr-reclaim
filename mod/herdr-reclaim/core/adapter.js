// 讀 OMP adapter（omp-extension/herdr-reclaim.ts）寫的活動檔，交給共用城市入帳（#5、#23）。
//
// adapter 與 mod 共用一個根目錄（§6.1）：adapter 寫 activity/，mod 在帳本提交成功之後
// 才在自己的帳本目錄寫 acks/。路徑由 appHome 決定，所以兩邊在隔離的 HERDR_APP_HOME 下
// 也看到同一份資料。
//
// mod 的 io 只有 read／write，沒有列目錄（herdr 的 readTextFile／writeTextFile），
// 所以列檔由 host 層提供：`io.list(dir)` 回該目錄底下所有檔案的絕對路徑。
//
// 活動按 (sessionId, writerEpoch) 分檔；工作來源（repo、space、session）只決定「這是不是
// 有效工作」，不決定城市——所有活動都進同一個共用城市（#22、ADR-0001）。

/** 資料根目錄名（相對 appHome）。 */
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

/**
 * 同一支 session 同一個 writer epoch 的活動併成一份：事件取聯集（重複的 eventSeq 留時間較晚的），
 * 名稱取最後更新那一份。帳本保存的那一份與磁碟快照（adapter ack 後會 compact）也會走這裡，
 * 所以重播、重讀與 ack 後的尾巴不會互相覆蓋。
 */
export function mergeActivities(records) {
  const byWriter = new Map();
  for (const record of records ?? []) {
    if (!record || record.schema !== 1 || typeof record.sessionId !== "string") continue;
    const key = `${record.sessionId}@@${record.writerEpoch ?? ""}`;
    const merged = byWriter.get(key);
    const events = dedupeEvents(record.events ?? []);
    if (!merged) {
      byWriter.set(key, { ...record, events });
      continue;
    }
    merged.events = dedupeEvents([...merged.events, ...events]);
    if ((record.updatedAt ?? 0) >= (merged.updatedAt ?? 0) && record.sessionName) merged.sessionName = record.sessionName;
    merged.updatedAt = Math.max(merged.updatedAt ?? 0, record.updatedAt ?? 0);
  }
  return [...byWriter.values()].sort((a, b) =>
    a.sessionId === b.sessionId
      ? String(a.writerEpoch ?? "").localeCompare(String(b.writerEpoch ?? ""))
      : a.sessionId.localeCompare(b.sessionId),
  );
}

/** 同一個 epoch 內 eventSeq 不會重複；重複出現時留時間較晚的那一筆。 */
function dedupeEvents(events) {
  const bySeq = new Map();
  for (const event of events) {
    const previous = bySeq.get(event.eventSeq);
    if (!previous || (event.at ?? 0) >= (previous.at ?? 0)) bySeq.set(event.eventSeq, event);
  }
  return [...bySeq.values()].sort((a, b) => a.eventSeq - b.eventSeq);
}

// 活動紀錄的回合（#23）：共用城市的收入、成果收成與研究判定都從這裡讀。
//
// 回合 = 活動紀錄裡一次 `interval_open` 到它對應的 `interval_close`（adapter 在 agent_start
// 開、agent_end 關）。一個回合結束之後才結算；沒有結束的回合不結算。
//
// 只算互動的 root（含互動 fork）：print／headless 這些非互動 session 不納入（§16 排除）；
// role=child 的 session 併進它的 parent（§7.4 的「root 加 child」），所以 child 的回合算在
// 同一棵樹上。這一支是純函式，不碰 I/O，也不管帳本怎麼落帳。

/** 目前的 session → 紀錄（同一支 session 可能有多個 writer epoch；身份取第一筆）。 */
export function sessionIndex(activities) {
  const byId = new Map();
  const ordered = [...(activities ?? [])].sort((a, b) => a.sessionId === b.sessionId
    ? String(a.writerEpoch ?? "").localeCompare(String(b.writerEpoch ?? ""))
    : a.sessionId.localeCompare(b.sessionId));
  for (const record of ordered) {
    if (byId.has(record.sessionId)) continue;
    byId.set(record.sessionId, record);
  }
  return byId;
}

/** child → 上層 → … → 實際建格的 root（§1、§6.1）。 */
export function rootOf(byId, sessionId) {
  const seen = new Set();
  let current = byId.get(sessionId);
  while (current?.role === "child" && current.parentSessionId && !seen.has(sessionId)) {
    seen.add(sessionId);
    sessionId = current.parentSessionId;
    current = byId.get(sessionId);
  }
  return current ?? null;
}

/** §1、§6.1：只有互動的 root 與互動的 fork 算工作；child 併進它的 parent。 */
export function createsTile(record) {
  return record?.interactive === true && record.role !== "child";
}

/**
 * 一支 session（一個 writer epoch）的回合：用 eventSeq 判斷哪些事件屬於哪個回合，
 * 所以同一個時間戳開關兩次也不會分錯。
 */
export function roundsOf(record) {
  const events = [...(record.events ?? [])].sort((a, b) => a.eventSeq - b.eventSeq);
  const rounds = [];
  let cityId = null;
  let open = null;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.kind === "visit_start") cityId = event.visit?.commonDir ?? null;
    else if (event.kind === "visit_end") cityId = null;
    else if (event.kind === "interval_open" && open === null) open = { index, eventSeq: event.eventSeq, at: Number(event.at), cityId };
    else if (event.kind === "interval_close" && open !== null) {
      rounds.push({
        openSeq: open.eventSeq,
        openAt: open.at,
        closeAt: Number(event.at),
        cityId: open.cityId,
        usage: events.slice(open.index + 1, index).filter((candidate) => candidate.kind === "usage"),
      });
      open = null;
    }
  }
  return { rounds, open: open ? { openSeq: open.eventSeq, openAt: open.at } : null };
}

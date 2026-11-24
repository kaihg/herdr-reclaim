// 研究羊皮卷（proposal §7.4）：回合結算的自動規則。
//
// 回合 = 活動紀錄裡一次 `interval_open` 到它對應的 `interval_close`（adapter 在 agent_start
// 開、agent_end 關）。一個回合結束之後才結算；沒有結束的回合不結算。
//
// 只算互動遠征樹的回合：root 必須是互動、會建格的 session，child 的回合併進同一座城的計量器
// （§7.4 的「root 加 child」）；print／headless 這些非互動 session 不納入（§16 排除）。
//
// 一個回合算不算研究：
//   - 這個回合所屬的遠征樹，在這段時間內有任何 **歸屬確定的** commit → 不算研究（就算那個
//     commit 沒有產生新單位）。
//   - 這段時間內有 **待核對來源** 的 commit（hook 已有紀錄，但來源證據還可能晚到）→ 暫不結算。
//   - 用量未知（`usage.unknownFields` 非空）的回合不計。
//   - cache read／write 不算；只累加 non-cache input + output。
// 這座城的計量器每滿 100,000 換 1 張羊皮卷，餘數按城保留；換算與落帳在帳本的 `research`
// entry 裡，所以重播不會再次發放，晚到的來源也不會倒扣（§7.4 的遲到來源例外）。

/** 回合的身份：sessionId、writer epoch 與開啟事件的 eventSeq 決定一筆操作（重播去重）。 */
export function roundKey(record, round) {
  return `${record.sessionId}@@${record.writerEpoch ?? ""}@@${round.openSeq}`;
}

export function researchOpId(cityId, record, round) {
  return `research:${cityId}:${roundKey(record, round)}`;
}

/** 目前的 session → 紀錄（同一支 session 可能有多個 writer epoch；身份取第一筆）。 */
export function sessionIndex(activities) {
  const byId = new Map();
  for (const record of activities ?? []) {
    if (!byId.has(record.sessionId)) byId.set(record.sessionId, record);
  }
  return byId;
}

/** child → 上層 → … → 實際建格的 root（§1、§6.1）。 */
export function rootOf(byId, sessionId) {
  const seen = new Set();
  let current = byId.get(sessionId);
  let root = current ?? null;
  while (current && current.role === "child" && current.parentSessionId && !seen.has(current.sessionId)) {
    seen.add(current.sessionId);
    current = byId.get(current.parentSessionId) ?? null;
    if (current) root = current;
  }
  return root;
}

/** §1、§6.1：只有互動的 root 與互動的 fork 建格；它們的樹才算遠征。 */
export function createsTile(record) {
  return record?.interactive === true && record.role !== "child";
}

/**
 * 一支 session（一個 writer epoch）的回合：用 eventSeq 判斷哪些事件屬於哪個回合，
 * 所以同一個時間戳開關兩次也不會分錯。用量事件依當時的 visit 記在它發生的那座城。
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

/** 一個回合的合格 token：non-cache input + output，同一把來源 key 只算一次，unknown 就不計。 */
function tokenUsage(round, { cityId, seen }) {
  let tokens = 0;
  let unknown = false;
  for (const event of round.usage) {
    if (round.cityId !== cityId) continue; // 跨城工作不加到這座城的計量器
    for (const [provider, usage] of Object.entries(event.usage ?? {})) {
      const key = `${usage.sourceKey ?? `entry:${event.eventSeq}`}#${provider}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (Array.isArray(usage.unknownFields) && usage.unknownFields.length > 0) unknown = true;
      tokens += Number(usage.inputNonCache ?? 0) + Number(usage.output ?? 0);
    }
  }
  return { tokens, unknown };
}

/**
 * 一條 commit 在這一回合裡的角色：
 *   attributed  commit 歸屬確定、而且歸到這個遠征樹 → 這個回合不算研究
 *   pending     來源證據還可能晚到 → 暫不結算
 *   none        與這一回合無關（來源不明的 commit 視為沒有歸屬）
 */

function commitRole(commit, { cityId, rootSessionId, openAt, closeAt }) {
  if (commit.cityId !== cityId) return "none"; // 別的城的提交跟這座城的計量器無關
  // 沒有可信時間的證據（舊 recorder）判不出落在哪個回合：若它確定屬於這棵樹，保守地
  // 暫不結算（不發不該給的羊皮卷，而且每次重播的結果都一樣）。
  if (commit.at === null) return commit.attributed && commit.rootId === rootSessionId ? "pending" : "none";
  if (!(Number(commit.at) >= openAt && Number(commit.at) <= closeAt)) return "none";
  if (commit.attributed && commit.rootId === rootSessionId) return "attributed";
  if (commit.pending) return "pending";
  return "none";
}

/**
 * §5.3：一段工作要落在這支遠征某一代**現役**的時間窗裡才算成績。判斷方式與
 * `core/town.js` 計算工時一樣（把區間裁到 generation 的時間窗）：完全落在撤回／封存
 * 空窗裡的回合不算——研究是城級的計量器，但不能繞過工作資格。
 */
function withinGeneration(windows, openAt, closeAt) {
  return (windows ?? []).some((window) => window.activatedAt <= closeAt && openAt <= window.deactivatedAt);
}

export function planResearch({ activities = [], commits = [], cityId, generations = null } = {}) {
  const byId = sessionIndex(activities);
  const seenBySession = new Map();
  const settlements = [];
  const deferred = [];
  const open = [];
  for (const record of activities ?? []) {
    const root = rootOf(byId, record.sessionId);
    if (!createsTile(root)) continue;
    const { rounds, open: running } = roundsOf(record);
    if (running) open.push({ sessionId: record.sessionId, writerEpoch: record.writerEpoch ?? null, ...running });
    // 同一把來源 key 在一支 session 內只算一次；跨 epoch 重複回報的用量因此不重複計算。
    if (!seenBySession.has(record.sessionId)) seenBySession.set(record.sessionId, new Set());
    const seen = seenBySession.get(record.sessionId);
    for (const round of rounds) {
      // 撤回／封存空窗中的回合不計：連來源 key 都不進 seen（這個回合本來就沒有資格）。
      if (generations && !withinGeneration(generations.get(root.sessionId), Number(round.openAt), Number(round.closeAt))) continue;
      const { tokens, unknown } = tokenUsage(round, { cityId, seen });
      if (tokens <= 0 || unknown) continue;
      const context = { cityId, rootSessionId: root.sessionId, ...round };
      let role = "none";
      for (const commit of commits ?? []) {
        const candidate = commitRole(commit, context);
        if (candidate === "attributed") { role = "attributed"; break; }
        if (candidate !== "none") role = "pending";
      }
      if (role === "attributed") continue;
      const entry = {
        opId: researchOpId(cityId, record, round),
        sessionId: record.sessionId,
        rootSessionId: root.sessionId,
        writerEpoch: record.writerEpoch ?? null,
        round: roundKey(record, round),
        openAt: round.openAt,
        tokens,
        at: round.closeAt,
      };
      if (role === "pending") deferred.push(entry);
      else settlements.push(entry);
    }
  }
  settlements.sort((a, b) => a.at - b.at || a.opId.localeCompare(b.opId));
  return { settlements, deferred, open };
}

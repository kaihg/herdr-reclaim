// 外部 CLI（Codex #10、Claude Code #11）的 commit 來源核對（§7.2）。
//
// 這兩個 adapter 的 hook 分別可在 commit 當下讀到 `CODEX_THREAD_ID` 與
// `CLAUDE_CODE_SESSION_ID`，adapter 的活動檔則以同一把 session id 當 `sessionId`。
// 本模組只做一件事：**要求兩者完全相等**。對不到就是來源不明，不用 terminal ID、
// 時間接近或 HEAD 差異補猜（§7.2、§7.5），也不在對不到時發資源。
//
// 這裡只讀 adapter 已經寫好的活動紀錄，不修改 adapter 本身。

/** 需要與 adapter 活動檔核對來源的 CLI。OMP 走自己的 session 歸屬，不在這裡。 */
export const ADAPTER_CLIS = ["codex", "claude"];

/**
 * 這個 (cli, sessionId) 是否精確對應到一筆 adapter 活動紀錄。
 * `cli` 必須相同：兩個 CLI 的 session id 巧合相同時不能互相配對（多重證據衝突）。
 * 活動紀錄沒有寫 cli 時，只有單一候選可由呼叫端的 identity 決定，這裡不代替它猜。
 */
export function hasAdapterSession(activities, cli, sessionId) {
  if (!ADAPTER_CLIS.includes(cli) || typeof sessionId !== "string" || sessionId === "") return false;
  return (activities ?? []).some((record) => record?.sessionId === sessionId && (record.cli ?? cli) === cli);
}

/**
 * 候選來源（hook 環境變數或 session artifact）是否需要核對，以及核對結果。
 * 回傳 `null` 代表可以採用；回傳字串代表不收成的理由（保留紀錄，不發資源）。
 */
export function unverifiedReason(identity, activities) {
  if (!identity || !ADAPTER_CLIS.includes(identity.cli)) return null;
  return hasAdapterSession(activities, identity.cli, identity.sessionId) ? null : "no-matching-adapter-session";
}

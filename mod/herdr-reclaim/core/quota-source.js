// 額度自動來源（proposal §15.2、§15.5；ticket #13）。
//
// 唯一允許的來源是官方 CLI 的去識別 JSON 輸出：`omp usage --json --redact --no-extensions`
// （QUOTA_SOURCE）。整合層用 exec 跑它，把 stdout 交給 parseQuotaReport 驗證，再寫成
// `<appHome>/data/herdr-reclaim/quotas.json`，由 main.js 讀給 provider-stats.js 的 readQuotas。
//
// 這一層**不讀任何 provider 憑證檔**（~/.codex、~/.claude 等）、不看 token、不向 provider
// 查詢、也不改任何設定：只讀那一支 CLI 已經 redact 過的 stdout（§15.2、§15.5）。
// 拿不到或驗證失敗一律回報錯誤／未知，不推算數字、不補 0（§9）。
//
// 純函式模組＋注入的 io：不 import host API、不直接碰檔案系統，行程啟動與寫檔時機由整合層決定。
import { CasConflict } from "./cas.js";

/**
 * 唯一允許的額度來源：官方 CLI 的 redacted JSON（stdout）。
 * 執行方式：`exec(QUOTA_SOURCE.command, QUOTA_SOURCE.args)`；只讀 stdout，不讀憑證檔、不改設定。
 */
export const QUOTA_SOURCE = {
  command: "omp",
  args: ["usage", "--json", "--redact", "--no-extensions"],
};

/** 有效的時間戳：JSON 數字（不是字串、不是 NaN／Infinity）。 */
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** 逐筆檢查一份 provider report 的必填欄位；回傳不合格的原因（空陣列＝合格）。 */
function faultsOf(report, position) {
  const faults = [];
  if (typeof report?.provider !== "string" || report.provider === "") faults.push("沒有 provider");
  if (!isFiniteNumber(report?.fetchedAt)) faults.push("沒有 fetchedAt");
  if (!Array.isArray(report?.limits)) faults.push("limits 不是陣列");
  return faults.length === 0 ? null : `第 ${position} 筆 report ${faults.join("、")}`;
}

/**
 * 官方 CLI 的 stdout → 可直接餵給 `readQuotas(snapshot, { now })` 的快照。
 *
 * 一律回傳 `{ snapshot }` 或 `{ error }`，不 throw：
 *   * stdout 不是字串／不是 JSON、最上層不是物件、缺可用的 `generatedAt`、`reports` 不是陣列
 *     → `{ error }`（沒有時間戳的報告不能進 UI：TTL 判斷要靠它）。
 *   * `reports[]` 逐筆驗證 `provider`／`fetchedAt`／`limits`；不合格的整筆剔除，並在
 *     `warnings` 記一筆給人看的說明，合格的原樣保留（不補 0、不改數字）。
 *   * `accountsWithoutUsage`／`disabledCredentials` 不是陣列時當空陣列，並記一筆 warning。
 *
 * 回傳的快照除了 `warnings` 之外與輸入同形（spikes/s5/observed.json 的形狀）。
 */
export function parseQuotaReport(stdout) {
  if (typeof stdout !== "string") return { error: "額度來源沒有輸出文字（stdout 不是字串）" };
  let parsed;
  try {
    parsed = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  } catch (cause) {
    return { error: `額度來源的輸出不是 JSON：${cause.message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "額度來源的輸出最上層不是物件" };
  }
  if (!isFiniteNumber(parsed.generatedAt)) {
    return { error: "額度回報沒有可用的 generatedAt（無法判斷是否過期）" };
  }
  if (!Array.isArray(parsed.reports)) {
    return { error: "額度回報的 reports 不是陣列" };
  }
  const warnings = [];
  const reports = [];
  parsed.reports.forEach((report, index) => {
    const fault = faultsOf(report, index + 1);
    if (fault !== null) {
      warnings.push(fault);
      return;
    }
    reports.push(report);
  });
  const accountsOf = (value, name) => {
    if (Array.isArray(value)) return value;
    warnings.push(`${name} 不是陣列，當成空陣列`);
    return [];
  };
  return {
    snapshot: {
      ...parsed,
      generatedAt: parsed.generatedAt,
      reports,
      accountsWithoutUsage: accountsOf(parsed.accountsWithoutUsage, "accountsWithoutUsage"),
      disabledCredentials: accountsOf(parsed.disabledCredentials, "disabledCredentials"),
      warnings,
    },
  };
}

/** 自動重取的間隔：全域（所有視窗、所有 workspace 共用同一個帳號額度）每 5 分鐘最多一次。 */
export const QUOTA_REFRESH_MS = 5 * 60_000;

/** 上一次「嘗試」抓額度的時間（檔案內容 `{ "attemptedAt": <ms> }`）；壞掉、缺欄位都當作沒有。 */
function attemptedAtOf(text) {
  if (typeof text !== "string") return null;
  try {
    const value = JSON.parse(text)?.attemptedAt;
    return isFiniteNumber(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 要不要現在抓：距離上次嘗試滿 `intervalMs` 才算到期（剛好滿算到期）。
 * 沒有紀錄、或紀錄在未來（時鐘被調回）→ 到期，不然會一直被擋到時鐘追上。
 */
export function refreshDue(attemptedAt, now = Date.now(), intervalMs = QUOTA_REFRESH_MS) {
  if (!isFiniteNumber(attemptedAt) || attemptedAt > now) return true;
  return now - attemptedAt >= intervalMs;
}

/**
 * 全域的抓取名額：所有視窗共用 `path` 這一個檔案，用 CAS 搶「這一輪由誰去抓」。
 * 回傳 true＝這個呼叫者拿到名額、該去跑 CLI；false＝還沒到期，或另一個視窗剛搶到。
 *
 * 失敗也算一次嘗試（先記下才抓）：CLI 不存在、沒登入、網路掛掉時，也是每 5 分鐘才再試一次，
 * 不會每個視窗各自重試。`force`（使用者按「更新額度」）略過到期判斷，但仍然登記這一次嘗試，
 * 所以按完之後自動更新會從現在起算 5 分鐘。
 *
 * @param {{ read: (path: string) => Promise<string|null>, write: (path: string, text: string, expected: string|null) => Promise<unknown> }} io
 */
export async function claimQuotaAttempt(io, path, now = Date.now(), { force = false } = {}) {
  const before = await io.read(path);
  if (!force && !refreshDue(attemptedAtOf(before), now)) return false;
  try {
    await io.write(path, `${JSON.stringify({ attemptedAt: now })}\n`, before);
    return true;
  } catch (error) {
    if (!(error instanceof CasConflict)) throw error;
    return force; // 另一個視窗同時搶：自動輪讓給它；使用者明確要求的照抓
  }
}

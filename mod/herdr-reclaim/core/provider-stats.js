// 額度顯示模型（proposal §9；ticket #12）。
//
// 這一層是純資料，不碰 host API、也不寫帳本：把 provider 明確回報的原始值、重置週期與
// 擷取時間讀成顯示模型。拿不到、沒有 report、帳號沒有額度，或資料過期，一律是「未知」——
// 不推算、不填 0 或 100。
//
// 額度來源是「已經正規化過的 provider 回報」檔案（spikes/s5/observed.json 的形狀，
// `omp usage --json --redact` 的輸出）。mod 不讀任何 provider 憑證，也不自己向 provider 查詢。
//
// 舊版各 repo 城的投入排行與建築派系（依遠征格分開）已隨遠征玩法移除（#22）。

/** 額度回報的保存期限；超過就當成過期（§9：拿不到或過期時顯示未知）。 */
export const QUOTA_TTL_MS = 15 * 60_000;

/** 台北時間（§10 的時區）；不依賴執行環境的 TZ，所以重播與測試都一致。 */
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
export function formatClock(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return "未知";
  const date = new Date(Number(ms) + TAIPEI_OFFSET_MS);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/**
 * S5 的 provider report（spikes/s5/observed.json）→ 顯示模型。
 * 原始 used／limit／remaining／unit、window 的重置週期與 resetsAt、report 的 fetchedAt 都保留；
 * 拿不到剩餘量、report 或整份快照過期、窗口已經過 reset 時間，都只標成未知，不推算數字。
 */
export function readQuotas(snapshot, { now = Date.now(), ttlMs = QUOTA_TTL_MS } = {}) {
  if (!snapshot || typeof snapshot !== "object") {
    return { available: false, reason: "拿不到額度回報", generatedAt: null, stale: false, ttlMs, entries: [], unknowns: [] };
  }
  const generatedAt = Number(snapshot.generatedAt) || null;
  const snapshotStale = generatedAt !== null && now - generatedAt > ttlMs;
  const entries = [];
  const unknowns = [];
  for (const report of snapshot.reports ?? []) {
    const provider = typeof report?.provider === "string" ? report.provider : "unknown";
    const fetchedAt = Number(report?.fetchedAt) || null;
    const reportStale = fetchedAt !== null && now - fetchedAt > ttlMs;
    const limits = Array.isArray(report?.limits) ? report.limits : [];
    if (limits.length === 0) {
      unknowns.push({ provider, reason: "沒有回報額度項目", fetchedAt });
      continue;
    }
    for (const limit of limits) {
      const window = limit?.window ?? {};
      const amount = limit?.amount ?? {};
      const resetsAt = Number(window.resetsAt) || null;
      const rolledOver = resetsAt !== null && now >= resetsAt;
      const stale = snapshotStale || reportStale || rolledOver;
      const remaining = typeof amount.remaining === "number" ? amount.remaining : null;
      entries.push({
        provider,
        windowId: window.id ?? limit?.id ?? null,
        windowLabel: window.label ?? window.id ?? null,
        durationMs: Number(window.durationMs) || null,
        resetsAt,
        fetchedAt,
        // 原始回報原樣保留（§9）；畫面上不換算、不推算。
        raw: {
          used: typeof amount.used === "number" ? amount.used : null,
          limit: typeof amount.limit === "number" ? amount.limit : null,
          remaining,
          unit: amount.unit ?? null,
        },
        unknown: stale || remaining === null,
        reason: stale
          ? rolledOver ? "已過重置時間" : "資料過期"
          : remaining === null ? "沒有回報剩餘量" : null,
      });
    }
  }
  // 帳號沒有回報額度：與同一個 provider 的已知回報分開列，不合併、也不解讀成 0 或 100（§15.2）。
  for (const account of snapshot.accountsWithoutUsage ?? []) {
    unknowns.push({
      provider: typeof account?.provider === "string" ? account.provider : "unknown",
      reason: "帳號沒有回報額度",
      fetchedAt: null,
    });
  }
  for (const account of snapshot.disabledCredentials ?? []) {
    unknowns.push({
      provider: typeof account?.provider === "string" ? account.provider : "unknown",
      reason: "憑證停用",
      fetchedAt: null,
    });
  }
  return {
    available: true,
    reason: null,
    generatedAt,
    stale: snapshotStale,
    ttlMs,
    entries,
    unknowns,
  };
}

/**
 * 畫面用的額度清單（§9）：已知的回報一行，未知的帳號另起一行，
 * 用量出現過但整份快照沒有 report 的 provider 再補一行「沒有 provider report」。
 * 完全拿不到回報檔時只回一行未知；不捏造任何數字。
 */
export function quotaLines(quotas, { providers = [] } = {}) {
  const lines = [];
  for (const entry of quotas?.entries ?? []) {
    const windowPart = entry.windowLabel ?? entry.windowId;
    const amount = entry.unknown
      ? `未知（${entry.reason}）`
      : `${entry.raw.remaining} / ${entry.raw.limit}${entry.raw.unit ? ` ${entry.raw.unit}` : ""}`;
    lines.push({
      provider: entry.provider,
      known: !entry.unknown,
      text: [
        entry.provider,
        windowPart,
        amount,
        entry.resetsAt ? `重置 ${formatClock(entry.resetsAt)}` : null,
        entry.fetchedAt ? `擷取 ${formatClock(entry.fetchedAt)}` : null,
      ].filter(Boolean).join(" · "),
    });
  }
  for (const unknown of quotas?.unknowns ?? []) {
    lines.push({ provider: unknown.provider, known: false, text: `${unknown.provider} · 未知（${unknown.reason}）` });
  }
  const covered = new Set([
    ...(quotas?.entries ?? []).map((entry) => entry.provider),
    ...(quotas?.unknowns ?? []).map((unknown) => unknown.provider),
  ]);
  for (const provider of providers) {
    if (covered.has(provider)) continue;
    lines.push({ provider, known: false, text: `${provider} · 未知（沒有 provider report）` });
  }
  if (lines.length === 0) {
    lines.push({ provider: null, known: false, text: `未知（${quotas?.reason ?? "拿不到額度回報"}）` });
  }
  return lines;
}

// 額度、投入與建築派系（proposal §9、§14；ticket #12）。
//
// 這一層是純資料，不碰 host API、也不寫帳本：
//   * 額度：把 provider 明確回報的原始值、重置週期與擷取時間讀成顯示模型（§9）。
//     拿不到、沒有 report、帳號沒有額度，或資料過期，一律是「未知」——不推算、不填 0 或 100。
//   * 投入：把一格遠征的用量依 provider 分開（§9 的投資），child 歸到它追到的 root。
//   * 派系：投入最多的 provider（§9）。費用全部已知時以 API 等值比較；有任何未知時，
//     改用不含 cache 的 input 加 output，並在畫面上標示這個限制。
//
// 這裡的結果只影響顯示與統計：不改變開墾點、資源、匯率或建築配方（§9「不影響數值」）。
//
// 額度來源是「已經正規化過的 provider 回報」檔案（spikes/s5/observed.json 的形狀，
// `omp usage --json --redact` 的輸出）。mod 不讀任何 provider 憑證，也不自己向 provider 查詢。

/** 額度回報的保存期限；超過就當成過期（§9：拿不到或過期時顯示未知）。 */
export const QUOTA_TTL_MS = 15 * 60_000;

/** §14 的派系風格：provider → 派系名稱。沒對到的 provider 就用原始名稱。 */
const FACTION_NAMES = {
  anthropic: "Anthropic",
  "openai-codex": "OpenAI",
  openai: "OpenAI",
  google: "Google",
  gemini: "Google",
  databricks: "Databricks",
};

/** 沒有可歸戶的 provider 用量時的派系（§9）。 */
export const NO_FACTION = "無派系";

export function factionOfProvider(provider) {
  if (typeof provider !== "string" || provider === "") return NO_FACTION;
  return FACTION_NAMES[provider.toLowerCase()] ?? provider;
}

/** 用量加總的起點；與 town.js 的欄位一致。 */
const ZERO = { inputNonCache: 0, cacheRead: 0, cacheWrite: 0, output: 0, costKnown: 0, costUnknownEntries: 0 };
const ZERO_KEYS = Object.keys(ZERO);

/** 比較用：不含 cache 的 input 加 output（§9 的備援基準）。 */
const tokensOf = (entry) => entry.inputNonCache + entry.output;
const metricOf = (entry, basis) => (basis === "cost" ? entry.costKnown : tokensOf(entry));

/** 這一筆的費用與欄位都齊全，才算「已知」（§9：有任何未知就換基準）。 */
const costsKnownOf = (entry) => entry.costUnknownEntries === 0 && (entry.unknownFields?.length ?? 0) === 0;

function summarize(byProvider) {
  const providers = [...byProvider.values()].map((bucket) => {
    const { unknownFields, ...rest } = bucket;
    return unknownFields?.size ? { ...rest, unknownFields: [...unknownFields].sort() } : rest;
  });
  // 全部已知才敢用 API 等值比較；有任何一筆未知就整組改用 token 基準（§9）。
  const basis = providers.length > 0 && providers.every(costsKnownOf) ? "cost" : "tokens";
  providers.sort((a, b) =>
    metricOf(b, basis) - metricOf(a, basis) ||
    tokensOf(b) - tokensOf(a) ||
    String(a.provider).localeCompare(String(b.provider)),
  );
  const total = { ...ZERO };
  for (const entry of providers) for (const key of ZERO_KEYS) total[key] += entry[key];
  const unknownFields = [...new Set(providers.flatMap((entry) => entry.unknownFields ?? []))].sort();
  if (unknownFields.length) total.unknownFields = unknownFields;
  return { providers, total, basis };
}

/**
 * 一格（或整座城）依 provider 分開的用量（§9 的投資）。
 * `sources` 是一組 session（root 與可歸戶的 child），每筆用量都帶著發生當時的 cityId 與 provider；
 * 只有落在這座城、這一段時間內的用量才算。同一把來源 key 已在 town.js 去重，這裡不再重複計算。
 */
export function investmentsOf(sources, cityId, startedAt = -Infinity, endedAt = Infinity) {
  const byProvider = new Map();
  for (const session of sources ?? []) {
    for (const usage of session.usage.values()) {
      if (usage.cityId !== cityId || usage.at < startedAt || usage.at >= endedAt) continue;
      const provider = typeof usage.provider === "string" && usage.provider !== "" ? usage.provider : "unknown";
      const bucket = byProvider.get(provider) ?? { provider, ...ZERO, unknownFields: new Set() };
      for (const key of ZERO_KEYS) bucket[key] += Number(usage[key]) || 0;
      for (const field of usage.unknownFields ?? []) bucket.unknownFields.add(field);
      byProvider.set(provider, bucket);
    }
  }
  return summarize(byProvider);
}

/** 把多筆投資併成一份（城的「主要行會」用得到）：同一個 provider 的數字相加。 */
export function mergeInvestments(list) {
  const byProvider = new Map();
  for (const investments of list ?? []) {
    for (const entry of investments?.providers ?? []) {
      const bucket = byProvider.get(entry.provider) ?? { provider: entry.provider, ...ZERO, unknownFields: new Set() };
      for (const key of ZERO_KEYS) bucket[key] += entry[key];
      for (const field of entry.unknownFields ?? []) bucket.unknownFields.add(field);
      byProvider.set(entry.provider, bucket);
    }
  }
  return summarize(byProvider);
}

/**
 * §9 的派系風格：投入最多的 provider 決定派系；同分時取 root session 的 provider；
 * 完全沒有 provider 用量時用「無派系」。
 */
export function factionOf(investments, rootProvider = null) {
  const providers = investments?.providers ?? [];
  const basis = investments?.basis ?? "tokens";
  if (!providers.length) {
    return { id: "none", name: NO_FACTION, provider: null, basis, reason: "沒有 provider 用量" };
  }
  const top = Math.max(...providers.map((entry) => metricOf(entry, basis)));
  const tied = providers.filter((entry) => metricOf(entry, basis) === top).map((entry) => entry.provider).sort();
  const provider = typeof rootProvider === "string" && tied.includes(rootProvider) ? rootProvider : tied[0];
  return { id: provider, name: factionOfProvider(provider), provider, basis, reason: null };
}

/** 派系在畫面上的一行：有 provider 就寫派系與 provider，沒有就用「無派系」與原因。 */
export function formatFaction(faction) {
  if (!faction || !faction.provider) return `${NO_FACTION}（${faction?.reason ?? "沒有 provider 用量"}）`;
  return `${faction.name}（${faction.provider}）`;
}

/** 比較基準的一行：限制要在畫面上說清楚（§9）。 */
export function basisNote(investments) {
  if (!investments || (investments.providers ?? []).length === 0) return "還沒有可歸戶的 provider 用量";
  return investments.basis === "cost"
    ? "費用以 API 等值比較"
    : "成本未知：改用 non-cache input + output 比較";
}

/** 一個 provider 的投資值；畫面與派系都用同一個基準。 */
export function formatInvestment(investments, entry) {
  return investments?.basis === "cost"
    ? `API 等值 ${Number(entry.costKnown).toFixed(4)}`
    : `進 ${entry.inputNonCache} + 出 ${entry.output}`;
}

/** 這一筆投資占這一組的比例（基準相同才可比）。 */
export function investmentShare(investments, entry) {
  const total = (investments?.providers ?? []).reduce((sum, row) => sum + metricOf(row, investments.basis), 0);
  if (total <= 0) return 0;
  return Math.round((metricOf(entry, investments.basis) / total) * 100);
}

/** 表格的每一列；`unknownFields` 就是 #11 留下的未知欄位，畫面上要明示。 */
export function investmentRows(investments) {
  return (investments?.providers ?? []).map((entry) => ({
    provider: entry.provider,
    name: factionOfProvider(entry.provider),
    value: formatInvestment(investments, entry),
    share: investmentShare(investments, entry),
    unknownFields: entry.unknownFields ?? [],
  }));
}

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
 * 畫面用的行會人力清單（§9）：已知的回報一行，未知的帳號另起一行，
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

/** 主要行會的額度一行（上方那條）；只找得到這個 provider 的回報就顯示它。 */
export function guildQuotaLine(quotas, provider) {
  if (!provider) return null;
  const lines = quotaLines(quotas, { providers: [provider] });
  return lines.find((line) => line.provider === provider) ?? lines[0] ?? null;
}

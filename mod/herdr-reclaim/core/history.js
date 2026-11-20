const LABELS = {
  expedition: "遠征開始", activity: "活動", commit: "提交", harvest: "收成",
  landAction: "土地變更", build: "蓋房", boost: "加速", trade: "市集", research: "研究",
};

const REASON_LABELS = {
  "no-session-source": "沒有 session 證據",
  "terminal-only": "只有 terminal ID",
  "ambiguous-session-source": "session 證據不唯一",
  "ambiguous-repository": "repo 證據不唯一",
  "no-hook-repository-evidence": "沒有 repo 證據",
  "no-matching-expedition": "沒有匹配遠征",
  "no-matching-adapter-session": "對不到 adapter session",
  "no-eligible-changes": "沒有可收成變更",
  "unknown-commit-time": "提交沒有可信時間",
  "outside_generation": "不在現役時間窗內",
  "remote-merge": "遠端合併",
  unresolved: "活動尚未解析",
};

/** 可見結果列投影：摘要只留短 SHA；未收成原因獨立一欄，避免被摘要截斷。 */
export function historyResultLines(item) {
  const sha = typeof item.sha === "string" && item.sha ? item.sha.slice(0, 8) : null;
  const summary = [item.subject, sha].filter(Boolean).join(" · ") ||
    (item.paths ?? []).join(", ") || item.sessionId || item.rootSessionId || "";
  const reasonLine = item.reason && item.reason !== "verified"
    ? item.reason === "unresolved"
      ? REASON_LABELS.unresolved
      : `未收成原因：${REASON_LABELS[item.reason] ?? item.reason}`
    : null;
  return { summary, reasonLine };
}

/**
 * 時間戳記的安全讀法。舊的 hook 證據檔出現過 20 位數的 `at`（1.8e19，超出 Date 的可表示
 * 範圍），`new Date(1.8e19).toISOString()` 會直接丟 RangeError，把整個歷程搜尋打斷——UI 上
 * 看起來就是「每一種查詢都 0 筆」。這裡只接受合理的毫秒 epoch，其餘一律當成時間未知。
 */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

export function usableTime(at) {
  const value = Number(at);
  return Number.isFinite(value) && value > 0 && value <= MAX_EPOCH_MS ? value : null;
}

const isoDate = (at) => {
  const value = usableTime(at);
  return value === null ? "" : new Date(value).toISOString().slice(0, 10);
};

/** 結果列的時間；壞掉的時間戳記顯示「時間未知」，不讓 render 丟例外。 */
export function formatHistoryTime(at) {
  const value = usableTime(at);
  return value === null ? "時間未知" : new Date(value).toLocaleString("zh-TW");
}

/** Compact journal projection stored in the rebuildable checkpoint search index. */
export function historyRecordOf(entry) {
  return {
    seq: entry.journalSeq,
    at: usableTime(entry.at) ?? 0,
    kind: entry.kind,
    cityId: entry.cityId ?? null,
    rootSessionId: entry.rootSessionId ?? null,
    sessionId: entry.sessionId ?? null,
    generation: entry.generation ?? null,
    x: Number.isFinite(entry.x) ? entry.x : null,
    y: Number.isFinite(entry.y) ? entry.y : null,
    sha: entry.sha ?? null,
    subject: entry.subject ?? null,
    reason: entry.reason ?? null,
    rulesVersion: entry.rulesVersion ?? null,
    resources: entry.resources ?? null,
    points: entry.points ?? null,
    claims: (entry.claims ?? (entry.claim ? [entry.claim] : [])).slice(0, 64),
    claimCount: (entry.claims ?? (entry.claim ? [entry.claim] : [])).length,
    paths: Array.isArray(entry.paths) ? entry.paths.slice(0, 64) : [],
    pathCount: Array.isArray(entry.paths) ? entry.paths.length : 0,
    content: entry.content ?? null,
  };
}

function queryParts(value) {
  const out = { terms: [], date: [], city: [], session: [], commit: [], path: [], kind: [] };
  for (const part of String(value ?? "").trim().split(/\s+/).filter(Boolean)) {
    const match = /^(date|city|session|commit|path|kind):(.*)$/i.exec(part);
    if (match) out[match[1].toLowerCase()].push(match[2].toLocaleLowerCase());
    else out.terms.push(part.toLocaleLowerCase());
  }
  return out;
}

const has = (value, terms) => terms.every((term) => String(value ?? "").toLocaleLowerCase().includes(term));

/** Search durable journal records and harvested tile paths; results carry generation-safe jump targets. */
export function searchHistory({ records = [], tiles = [], unresolvedActivities = [], cityNames = {}, query = "", limit = 100 } = {}) {
  const filter = queryParts(query);
  const results = [];
  const matches = (record, tilePaths = []) => {
    const date = isoDate(record.at);
    const city = `${record.cityId ?? ""} ${cityNames[record.cityId] ?? ""}`;
    const session = `${record.rootSessionId ?? ""} ${record.sessionId ?? ""}`;
    const commit = `${record.subject ?? ""} ${record.sha ?? ""}`;
    const paths = `${(record.paths ?? []).join(" ")} ${tilePaths.join(" ")}`;
    const fields = `${date} ${city} ${session} ${commit} ${paths} ${record.reason ?? ""} ${LABELS[record.kind] ?? record.kind ?? ""}`.toLocaleLowerCase();
    return filter.date.every((term) => date.startsWith(term)) && has(city, filter.city) &&
      has(session, filter.session) && has(commit, filter.commit) && has(paths, filter.path) &&
      has(record.kind, filter.kind) && filter.terms.every((term) => fields.includes(term));
  };
  for (const record of records) {
    if (!matches(record)) continue;
    const tile = record.rootSessionId == null ? null : tiles.find((candidate) =>
      candidate.cityId === record.cityId && candidate.rootSessionId === record.rootSessionId &&
      (candidate.generation ?? 1) === (record.generation ?? 1));
    results.push({
      ...record,
      label: LABELS[record.kind] ?? record.kind,
      cityName: cityNames[record.cityId] ?? record.cityId ?? "",
      jump: tile ? { kind: "expedition", cityId: tile.cityId, rootSessionId: tile.rootSessionId, generation: tile.generation } :
        record.rootSessionId != null && Number.isFinite(record.x) && Number.isFinite(record.y)
          ? { kind: "expedition", cityId: record.cityId, rootSessionId: record.rootSessionId, generation: record.generation ?? 1 }
          : null,
    });
  }
  for (const tile of tiles) {
    const paths = tile.harvestedPaths ?? [];
    if (!paths.length || !matches({ kind: "harvest", cityId: tile.cityId, rootSessionId: tile.rootSessionId,
      generation: tile.generation, at: tile.activatedAt, paths })) continue;
    results.push({ seq: tile.seq, at: tile.activatedAt, kind: "path", label: "成果路徑", cityId: tile.cityId,
      cityName: cityNames[tile.cityId] ?? tile.cityId, rootSessionId: tile.rootSessionId,
      generation: tile.generation, paths, jump: { kind: "expedition", cityId: tile.cityId,
        rootSessionId: tile.rootSessionId, generation: tile.generation } });
  }
  for (const activity of unresolvedActivities) {
    const record = { kind: "unresolved", at: activity.at, cityId: activity.cityId ?? null,
      sessionId: activity.sessionId, rootSessionId: activity.sessionId, generation: null,
      subject: activity.cwd, reason: "unresolved", paths: [] };
    if (matches(record)) results.push({ ...record, label: "未解析活動", cityName: "", jump: null });
  }
  results.sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0) || Number(b.seq ?? -1) - Number(a.seq ?? -1));
  return { results: results.slice(0, Math.max(0, limit)), total: results.length };
}

/** Per-expedition audit data; the caller supplies the journal records and activity snapshots. */
export function expeditionHistory({ tile, records = [], activities = [], providerUsage = [] } = {}) {
  const related = records.filter((record) => record.cityId === tile?.cityId && record.rootSessionId === tile?.rootSessionId &&
    (record.generation ?? 1) === (tile?.generation ?? 1));
  const harvests = related.filter((record) => record.kind === "harvest");
  const commits = related.filter((record) => record.kind === "commit");
  const sources = activities.filter((record) => record.sessionId === tile?.rootSessionId || record.parentSessionId === tile?.rootSessionId);
  return {
    visits: sources.flatMap((record) => (record.events ?? []).filter((event) => event.kind === "visit_start").map((event) => ({
      visitId: event.visit?.visitId ?? null, cwd: event.visit?.cwd ?? null,
      checkout: event.visit?.checkout ?? null, commonDir: event.visit?.commonDir ?? null, at: event.at,
    }))),
    checkout: tile?.repo?.checkout ?? null,
    workInterval: { start: tile?.activatedAt ?? null, end: tile?.deactivatedAt ?? null, workMs: tile?.workMs ?? 0 },
    points: { work: tile?.workPoints ?? 0, harvest: tile?.harvestPoints ?? 0, boost: tile?.boostPoints ?? 0 },
    commits: commits.map((record) => ({ sha: record.sha, subject: record.subject, reason: record.reason, at: record.at })),
    harvests: harvests.map((record) => ({ sha: record.sha, at: record.at, claims: record.claims ?? [],
      paths: record.paths ?? [], resources: record.resources ?? {}, rulesVersion: record.rulesVersion, points: record.points ?? 0 })),
    resources: harvests.reduce((sum, record) => {
      for (const [key, amount] of Object.entries(record.resources ?? {})) sum[key] = (sum[key] ?? 0) + Number(amount);
      return sum;
    }, {}),
    rulesVersions: [...new Set(related.map((record) => record.rulesVersion).filter((value) => value != null))],
    providerUsage,
    building: tile?.building ?? null,
    unresolved: [],
  };
}

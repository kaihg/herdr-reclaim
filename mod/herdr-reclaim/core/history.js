const LABELS = {
  expedition: "遠征開始", activity: "活動", commit: "提交", harvest: "收成",
  landAction: "土地變更", build: "蓋房", boost: "加速", trade: "市集", research: "研究",
};

const isoDate = (at) => Number.isFinite(Number(at)) && Number(at) > 0
  ? new Date(Number(at)).toISOString().slice(0, 10)
  : "";

/** Compact journal projection stored in the rebuildable checkpoint search index. */
export function historyRecordOf(entry) {
  return {
    seq: entry.journalSeq,
    at: Number(entry.at ?? 0),
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

import { harvestForCommit } from "./harvest.js";

export const COMMIT_DIR = "commits";
export const SOURCE_DIR = "sources";

export async function loadCommitEvidence(io, root, list) {
  const hooks = [];
  const sources = [];
  for (const [dir, output] of [[`${root}/${COMMIT_DIR}`, hooks], [`${root}/${SOURCE_DIR}`, sources]]) {
    for (const file of await list(dir)) {
      const text = await io.read(file);
      if (!text) continue;
      try {
        const record = JSON.parse(text);
        if (record?.schema === 1 && /^[0-9a-f]{40,64}$/i.test(record.sha ?? "")) output.push(record);
      } catch { /* incomplete atomic write is ignored and retried on the next replay */ }
    }
  }
  return { hooks, sources };
}

/** Parse `git diff-tree --raw -z` without decoding file contents. */
export function parseRawDiff(output) {
  const fields = output.split("\0");
  const changes = [];
  for (let i = 0; i < fields.length;) {
    const header = fields[i++];
    if (!header) continue;
    const match = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(header);
    if (!match) continue;
    const [, , , oldBlob, resultBlob, kind, score] = match;
    const firstPath = fields[i++];
    if (kind === "R" || kind === "C") {
      const path = fields[i++];
      if (kind === "R" && score === "100") {
        changes.push({ status: "R100", oldPath: firstPath, path, oldBlob, resultBlob });
      } else {
        changes.push({ status: `${kind}${score}`, oldPath: firstPath, path, oldBlob, resultBlob });
      }
    } else {
      changes.push({ status: kind, path: firstPath, oldBlob: kind === "A" ? null : oldBlob, resultBlob: kind === "D" ? null : resultBlob });
    }
  }
  return changes;
}

const sessionIdFromHook = (record) => record.env?.PI_SESSION_ID || record.env?.CODEX_THREAD_ID || record.env?.CLAUDE_SESSION_ID || null;

function attributionFor(sha, hooks, sources) {
  const hookHits = hooks.filter((record) => record.sha === sha);
  const dirs = [...new Set(hookHits.map((record) => record.commonDir).filter(Boolean))];
  const sourcesForSha = sources.filter((record) => record.sha === sha);
  const identities = [];
  for (const record of hookHits) {
    const sessionId = sessionIdFromHook(record);
    if (sessionId) identities.push({ sessionId, cli: record.env?.CODEX_THREAD_ID ? "codex" : record.env?.CLAUDE_SESSION_ID ? "claude" : "omp", basis: "hook-env" });
  }
  for (const record of sourcesForSha) {
    if (record.sessionId) identities.push({ sessionId: record.sessionId, cli: record.cli ?? "omp", basis: "session-artifact" });
  }
  const unique = new Map(identities.map((identity) => [`${identity.cli}:${identity.sessionId}`, identity]));
  if (dirs.length !== 1) return { cityId: dirs[0] ?? null, identity: null, reason: dirs.length > 1 ? "ambiguous-repository" : "no-hook-repository-evidence" };
  if (unique.size !== 1) {
    const terminalOnly = hookHits.some((record) => record.env?.HC_TERMINAL_ID) && unique.size === 0;
    return { cityId: dirs[0], identity: null, reason: terminalOnly ? "terminal-only" : unique.size ? "ambiguous-session-source" : "no-session-source" };
  }
  return { cityId: dirs[0], identity: [...unique.values()][0], reason: null };
}

function rootSession(sessionId, activities) {
  const byId = new Map();
  for (const record of activities ?? []) byId.set(record.sessionId, record);
  let current = sessionId;
  const visited = new Set();
  for (let i = 0; i < 32 && current && !visited.has(current); i++) {
    visited.add(current);
    const record = byId.get(current);
    if (!record || record.role !== "child" || !record.parentSessionId) return current;
    current = record.parentSessionId;
  }
  return current;
}

export async function ingestCommits({ ledger, hooks, sources, activities, diffForCommit }) {
  const state = await ledger.state();
  const results = [];
  const shas = new Set([...hooks, ...sources].map((record) => record.sha));
  for (const sha of shas) {
    const attribution = attributionFor(sha, hooks, sources);
    if (!attribution.cityId || attribution.cityId !== ledger.cityId) continue;
    const rootId = attribution.identity ? rootSession(attribution.identity.sessionId, activities) : null;
    const generation = rootId ? state.currentGen.get(`${ledger.cityId}@@${rootId}`) ?? 1 : 1;
    const tile = rootId ? state.tileById.get(`${ledger.cityId}@@${rootId}@@${generation}`) : null;
    const reason = attribution.reason ?? (!tile ? "no-matching-expedition" : null);
    const records = [...hooks, ...sources].filter((record) => record.sha === sha);
    const commitOp = {
      opId: `commit:${sha}:${reason ?? "verified"}:${attribution.identity?.sessionId ?? "unknown"}`,
      kind: "commit",
      cityId: ledger.cityId,
      sha,
      repo: attribution.cityId,
      at: Math.min(...records.map((record) => Number(record.at) || Date.now())),
      reason: reason ?? "verified",
      sessionId: attribution.identity?.sessionId ?? null,
      cli: attribution.identity?.cli ?? null,
      basis: attribution.identity?.basis ?? null,
      hookKinds: hooks.filter((record) => record.sha === sha).map((record) => record.hook),
    };
    if (!state.opSeqs.has(commitOp.opId)) results.push(await ledger.submit(() => commitOp));
    if (reason) continue;
    const hook = hooks.find((record) => record.sha === sha && record.commonDir === attribution.cityId);
    const changes = await diffForCommit(sha, hook);
    const harvest = harvestForCommit({ cityId: ledger.cityId, rootSessionId: rootId, generation, sha, changes, state, tile });
    if (!harvest.units.length) continue;
    const result = await ledger.submit(() => ({
      opId: harvest.opId,
      kind: "harvest",
      at: commitOp.at,
      cityId: ledger.cityId,
      rootSessionId: rootId,
      generation: harvest.generation,
      claims: harvest.claims,
      paths: harvest.paths,
      points: harvest.points,
      resources: harvest.resources,
      blobs: { sha, hookKinds: commitOp.hookKinds, attribution: commitOp.basis, paths: harvest.units },
    }));
    results.push(result);
    if (result.status === "applied") {
      tile.harvestedPaths = harvest.paths;
      for (const claim of harvest.claims) state.claims.set(`${ledger.cityId}@@${claim}`, true);
    }
  }
  return results;
}

import { harvestForCommit } from "./harvest.js";
import { unverifiedReason } from "./session-evidence.js";
import { generationAt } from "./ledger.js";

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
/** Extract SHA/repository evidence from reflog only; messages never establish session attribution. */
export function parseReflogEvidence(output, cityId, checkout) {
  const records = [];
  const remoteMerges = new Set();
  for (const line of output.split(/\r?\n/)) {
    const [sha, ...parts] = line.split("\t");
    if (!/^[0-9a-f]{40,64}$/i.test(sha ?? "")) continue;
    const reflog = parts.join("\t");
    if (/^(?:pull(?:\s|:)|merge (?:remote-tracking branch|(?:origin|upstream)[/ ])|reset: moving to (?:origin|upstream)\/|commit: Merge pull request\b)/i.test(reflog)) remoteMerges.add(sha);
    records.push({ schema: 1, sha, hook: "reflog", commonDir: cityId, toplevel: checkout, at: 0, env: {}, reflog });
  }
  return { records, remoteMerges };
}

// 每個 CLI 的 session 變數各自成一個候選：session id 與 cli 一定來自同一支變數，
// 不會出現「用 omp 的 id 配上 claude 的 cli」這種混搭。同一個紀錄裡有多個變數
// （例如 OMP 的 bash 底下又開了別的 CLI）就是多個候選 → 衝突 → 不收成。
const SESSION_ENV = [
  { key: "PI_SESSION_ID", cli: "omp" },
  { key: "CODEX_THREAD_ID", cli: "codex" },
  { key: "CLAUDE_CODE_SESSION_ID", cli: "claude" },
];

function attributionFor(sha, hooks, sources, activities) {
  const hookHits = hooks.filter((record) => record.sha === sha);
  const dirs = [...new Set(hookHits.map((record) => record.commonDir).filter(Boolean))];
  const sourcesForSha = sources.filter((record) => record.sha === sha);
  const identities = [];
  for (const record of hookHits) {
    for (const { key, cli } of SESSION_ENV) {
      const sessionId = record.env?.[key];
      if (typeof sessionId === "string" && sessionId !== "") identities.push({ sessionId, cli, basis: "hook-env" });
    }
  }
  for (const record of sourcesForSha) {
    if (record.sessionId) identities.push({ sessionId: record.sessionId, cli: record.cli ?? "omp", basis: "session-artifact" });
  }
  const unique = new Map(identities.map((identity) => [`${identity.cli}:${identity.sessionId}`, identity]));
  if (dirs.length !== 1) return { cityId: dirs[0] ?? null, identity: null, reason: dirs.length > 1 ? "ambiguous-repository" : "no-hook-repository-evidence" };
  if (unique.size !== 1) {
    const terminalOnly = hookHits.some((record) => record.reason === "terminal-only" || record.env?.HC_TERMINAL_ID) && unique.size === 0;
    return { cityId: dirs[0], identity: null, reason: terminalOnly ? "terminal-only" : unique.size ? "ambiguous-session-source" : "no-session-source" };
  }
  const only = [...unique.values()][0];
  // Codex／Claude 的 hook 環境變數要與 adapter 活動檔的 sessionId 完全相等（#10／#11）。
  const unverified = unverifiedReason(only, activities);
  if (unverified) return { cityId: dirs[0], identity: null, reason: unverified };
  return { cityId: dirs[0], identity: only, reason: null };
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

export async function ingestCommits({ ledger, hooks, sources, activities, diffForCommit, remoteMerges = new Set() }) {
  const state = await ledger.state();
  const results = [];
  const shas = new Set([...hooks, ...sources].map((record) => record.sha));
  for (const sha of shas) {
    const attribution = attributionFor(sha, hooks, sources, activities);
    const isRemoteMerge = remoteMerges.has(sha);
    const rootId = !isRemoteMerge && attribution.identity ? rootSession(attribution.identity.sessionId, activities) : null;
    const records = [...hooks, ...sources].filter((record) => record.sha === sha);
    const commitAt = Math.min(...records.map((record) => Number(record.at) || Date.now()));
    const tile = rootId ? generationAt(state, rootId, commitAt) : null;
    const generation = tile?.generation ?? null;
    const reason = isRemoteMerge ? "remote-merge" : attribution.reason ?? (!tile ? "no-matching-expedition" : null);
    const commitOp = {
      opId: `commit:${sha}:${reason ?? "verified"}:${isRemoteMerge ? "unknown" : attribution.identity?.sessionId ?? "unknown"}`,
      kind: "commit",
      cityId: ledger.cityId,
      sha,
      repo: attribution.cityId,
      at: commitAt,
      reason: reason ?? "verified",
      ...(reason ? {} : {
        sessionId: attribution.identity?.sessionId ?? null,
        cli: attribution.identity?.cli ?? null,
        basis: attribution.identity?.basis ?? null,
        hookKinds: hooks.filter((record) => record.sha === sha).map((record) => record.hook),
      }),
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
export function unharvestedCommitReasons({ cityId, hooks, sources, activities, remoteMerges = new Set(), state }) {
  const reasons = [];
  const shas = new Set([...hooks, ...sources].map((record) => record.sha));
  for (const sha of shas) {
    const attribution = attributionFor(sha, hooks, sources, activities);
    if (attribution.cityId !== cityId) continue;
    let reason = remoteMerges.has(sha) ? "remote-merge" : attribution.reason;
    if (!reason) {
      const rootId = rootSession(attribution.identity.sessionId, activities);
      const generation = state.currentGen.get(`${cityId}@@${rootId}`) ?? 1;
      if (!state.tileById.has(`${cityId}@@${rootId}@@${generation}`)) reason = "no-matching-expedition";
      else if (!state.opSeqs.has(`harvest:${sha}`)) reason = "no-eligible-changes";
    }
    if (reason) reasons.push({ sha, repo: cityId, reason });
  }
  return reasons.sort((a, b) => a.sha.localeCompare(b.sha));
}

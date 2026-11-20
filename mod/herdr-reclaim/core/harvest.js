// Git tree diff classification and deterministic harvest calculation (§7–§8).
const TEST = /(?:^|\/)(?:tests|__tests__)(?:\/|$)|(?:^|\/)test_[^/]*$|(?:^|\/)[^/]*_test\.[^/]*$|\.(?:spec|test)\.[^/]+$/i;
const DOCUMENT = /\.md$|\.rst$|(?:^|\/)docs(?:\/|$)/i;
const CONFIG = /\.json$|\.ya?ml$|\.toml$|(?:^|\/)\.[^/]+$/i;
const EXCLUDED_DIR = /(?:^|\/)(?:vendor|node_modules|bower_components|third_party|third-party|dist|build|coverage|generated)(?:\/|$)/i;
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|composer\.lock|poetry\.lock|Pipfile\.lock|flake\.lock|.*\.lock)$/i;
const GENERATED = /(?:\.generated\.|\.min\.(?:js|css)$|\.snap$|\.map$)/i;

export function classifyPath(path) {
  const normalized = String(path ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return null;
  if (EXCLUDED_DIR.test(normalized) || LOCKFILE.test(normalized) || GENERATED.test(normalized)) return null;
  if (TEST.test(normalized)) return "test";
  if (DOCUMENT.test(normalized)) return "document";
  if (CONFIG.test(normalized)) return "config";
  return "code";
}

const EMPTY_RESOURCES = () => ({ wood: 0, stone: 0, iron: 0, parchment: 0 });
const claimKey = (cityId, claim) => `${cityId}@@${claim}`;

/**
 * Computes only units not already claimed by the city or counted in this generation.
 * `changes` are first-parent tree changes; deletions carry their first-parent blob.
 */
export function harvestForCommit({ cityId, rootSessionId, generation, sha, changes, state, tile }) {
  const seenPaths = new Set(tile?.harvestedPaths ?? []);
  const seenThisCommit = new Set();
  const claims = [];
  const units = [];
  const resources = EMPTY_RESOURCES();
  for (const change of changes ?? []) {
    if (change.status === "R100" || (String(change.status).startsWith("R") && change.oldBlob && change.resultBlob === change.oldBlob)) continue;
    const path = change.path;
    const category = classifyPath(path);
    if (!category || seenPaths.has(path) || seenThisCommit.has(path)) continue;
    seenThisCommit.add(path);
    const resultBlob = change.status === "D" ? change.oldBlob : change.resultBlob;
    const claim = `${path}|${resultBlob ?? ""}`;
    if (state?.claims?.has(claimKey(cityId, claim))) continue;
    seenPaths.add(path);
    claims.push(claim);
    units.push({ path, category, claim, resultBlob: change.resultBlob ?? null, firstParentBlob: change.oldBlob ?? null });
    if (category === "test") resources.stone += 10;
    else if (category === "document") resources.parchment += 1;
    else if (category === "config") resources.iron += 5;
    else resources.wood += 10;
  }
  return {
    opId: `harvest:${sha}`,
    cityId,
    rootSessionId,
    generation,
    sha,
    claims,
    paths: [...seenPaths],
    units,
    resources,
    points: units.length ? 20 : 0,
  };
}

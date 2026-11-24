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
 * 一個 commit 的首見路徑與內容 claim（收成與成果收成共用同一條分類與 claim 規則）：
 * 同一路徑只算一次；純改名不換內容不算新版本；排除路徑（lockfile、生成物、vendor）沒有 claim。
 */
export function changesOfCommit(changes = []) {
  const seen = new Set();
  const units = [];
  for (const change of changes ?? []) {
    if (change.status === "R100" || (String(change.status).startsWith("R") && change.oldBlob && change.resultBlob === change.oldBlob)) continue;
    const path = change.path;
    const category = classifyPath(path);
    if (!category || seen.has(path)) continue;
    seen.add(path);
    // §7.3 的城級 claim key：刪除是 cityId+path+"deleted"+firstParentBlob，與新增的
    // cityId+path+resultBlob 不同；同一份內容版本的新增與刪除因此各自只發一次。
    const claim = change.status === "D"
      ? `${path}|deleted|${change.oldBlob ?? ""}`
      : `${path}|${change.resultBlob ?? ""}`;
    units.push({ path, category, claim, resultBlob: change.resultBlob ?? null, firstParentBlob: change.oldBlob ?? null });
  }
  return units;
}

/**
 * Computes only units not already claimed by the city or counted in this generation.
 * `changes` are first-parent tree changes; deletions carry their first-parent blob.
 */
export function harvestForCommit({ cityId, rootSessionId, generation, sha, changes, state, tile }) {
  const seenPaths = new Set(tile?.harvestedPaths ?? []);
  const claims = [];
  const units = [];
  const resources = EMPTY_RESOURCES();
  for (const unit of changesOfCommit(changes ?? [])) {
    if (seenPaths.has(unit.path)) continue;
    if (state?.claims?.has(claimKey(cityId, unit.claim))) continue;
    seenPaths.add(unit.path);
    claims.push(unit.claim);
    units.push(unit);
    if (unit.category === "test") resources.stone += 10;
    else if (unit.category === "document") resources.parchment += 1;
    else if (unit.category === "config") resources.iron += 5;
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

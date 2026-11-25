// Git tree diff classification 與 commit 的內容 claim（共用城市的成果收成 #24 用）。
// 一個 commit 只看首見的路徑與內容：純改名不換內容不算、排除路徑（lockfile、生成物、vendor）不算。
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


/**
 * 一個 commit 的首見路徑與內容 claim：同一路徑只算一次；純改名不換內容不算新版本；
 * 排除路徑（lockfile、生成物、vendor）沒有 claim。
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
    // §7.3 的城級 claim key：刪除是 path+"deleted"+firstParentBlob，與新增的
    // path+resultBlob 不同；同一份內容版本的新增與刪除因此各自只發一次。
    const claim = change.status === "D"
      ? `${path}|deleted|${change.oldBlob ?? ""}`
      : `${path}|${change.resultBlob ?? ""}`;
    units.push({ path, category, claim, resultBlob: change.resultBlob ?? null, firstParentBlob: change.oldBlob ?? null });
  }
  return units;
}

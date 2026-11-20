// 目前的 space 對應哪一座城（§4：Space 所在的 Git repo 就是城鎮；同一個 repo 的 space 共用一座城）。
//
// 畫面一次只顯示一座城；切換 space 時城要跟著換。這裡只做「資料夾 → 城」的純比對，
// 不開 git：城的身份是 canonical common dir（`<repo>/.git`），而一座城認得的資料夾有
// repo 本身，以及它的 worktree／其他 checkout（帳本裡每一格與每次 visit 都記著）。

const trimEnd = (path) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

/** `<repo>/.git` → `<repo>`；bare repo 等不是以 `/.git` 結尾的就用它自己。 */
function repoPathOf(cityId) {
  return cityId.endsWith("/.git") ? cityId.slice(0, -"/.git".length) : cityId;
}

/** 這座城認得的根資料夾：repo 本身、各格的 checkout、各次 visit 的 checkout。 */
export function cityRoots(city) {
  const roots = new Set([repoPathOf(city.cityId)]);
  for (const tile of city.tiles ?? []) {
    if (tile.repo?.checkout) roots.add(tile.repo.checkout);
    for (const visit of tile.visits ?? []) if (visit.checkout) roots.add(visit.checkout);
  }
  return [...roots].map(trimEnd).filter(Boolean);
}

/** `folder` 在 `root` 底下（含相等）；用路徑段比對，`/a/repo-2` 不算在 `/a/repo` 底下。 */
function within(folder, root) {
  return folder === root || folder.startsWith(root === "/" ? "/" : `${root}/`);
}

/**
 * 依序看每個候選資料夾（優先序由呼叫端排好），第一個落在某座城底下的就是答案；
 * 同一個資料夾落在好幾座城底下（巢狀 repo）時取最深的根。都對不上回 null。
 */
export function cityForFolders(cities, folders) {
  const rooted = (cities ?? []).map((city) => ({ city, roots: cityRoots(city) }));
  for (const raw of folders ?? []) {
    if (typeof raw !== "string" || !raw) continue;
    const folder = trimEnd(raw);
    let best = null;
    for (const { city, roots } of rooted) {
      for (const root of roots) {
        if (within(folder, root) && (!best || root.length > best.depth)) best = { city, depth: root.length };
      }
    }
    if (best) return best.city;
  }
  return null;
}

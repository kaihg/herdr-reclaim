// 一次性移除舊版 commit 收成裝在各 repo 的記錄器（#28、ADR 0002）。
//
// 新版不再安裝任何 hook，也不再產生 commit 收成；這裡只負責「清掉還留著的記錄器」：
// 有 `*.herdr-reclaim-original` 的把原 hook 搬回去，沒有的直接刪掉記錄器。沒按就不動任何 repo；
// 殘留的記錄器一律 `exit 0`，不影響 commit。

export const HOOK_NAMES = ["post-commit", "post-merge", "post-rewrite"];
export const HOOK_MARKER = "HERDR_RECLAIM_HOOK_V1";
const ORIGINAL_SUFFIX = ".herdr-reclaim-original";

const successful = (result) => result && result.code === 0;

async function command(exec, name, args, options = {}) {
  try { return await exec(name, args, options); } catch { return { code: 1, stdout: "", stderr: "" }; }
}

/** repo 的有效 hooks 目錄；不是 git repo（或被移走）就回 null。 */
async function repoInfo(repo, exec) {
  const [hooks, top] = await Promise.all([
    command(exec, "git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-path", "hooks"]),
    command(exec, "git", ["-C", repo, "rev-parse", "--show-toplevel"]),
  ]);
  if (![hooks, top].every(successful)) return null;
  return { hooksPath: hooks.stdout.trim(), top: top.stdout.trim() };
}

/**
 * 清單：這些 repo 裡還留著記錄器的那幾個（依傳入順序）。範圍由呼叫端決定——活動紀錄裡
 * 出現過的 checkout，也就是舊版會詢問的那些 repo。
 *
 * 一個 repo 的 hook 目錄讀不到（權限、被移走）不影響其他 repo：那一座照樣列進清單，
 * 由移除步驟回報真正的原因，而不是讓整個掃描失敗、其他殘留的入口一起消失。
 */
export async function leftoverHooks({ repos = [], io, exec }) {
  const found = [];
  for (const repo of repos) {
    const info = await repoInfo(repo, exec);
    if (!info) continue;
    try {
      for (const hook of HOOK_NAMES) {
        const text = await io.read(`${info.hooksPath}/${hook}`);
        if (typeof text === "string" && text.includes(HOOK_MARKER)) {
          found.push({ repo, hooksPath: info.hooksPath });
          break;
        }
      }
    } catch {
      found.push({ repo, hooksPath: info.hooksPath }); // 讀不到就不能保證乾淨
    }
  }
  return found;
}

/**
 * 逐一移除。結果逐 repo 列出：成功 `{ repo, ok: true }`，失敗 `{ repo, ok: false, reason }`
 * （原因是 git 的 stderr，沒有就說哪一個 hook 沒搬成）。一個 repo 失敗不影響其他 repo。
 */
export async function removeLeftoverHooks({ repos = [], exec }) {
  const results = [];
  for (const repo of repos) {
    const info = await repoInfo(repo, exec);
    if (!info) {
      results.push({ repo, ok: false, reason: "不是 git 工作目錄（可能已移走）" });
      continue;
    }
    let failure = null;
    for (const hook of HOOK_NAMES) {
      const file = `${info.hooksPath}/${hook}`;
      const original = `${file}${ORIGINAL_SUFFIX}`;
      const read = await command(exec, "cat", [file]);
      if (!successful(read) || !read.stdout.includes(HOOK_MARKER)) continue;
      const backup = await command(exec, "test", ["-e", original]);
      const done = successful(backup)
        ? await command(exec, "mv", [original, file])
        : await command(exec, "rm", ["-f", file]);
      if (!successful(done)) {
        failure = done.stderr.trim() || `${hook} 無法移除`;
        break;
      }
    }
    results.push(failure === null ? { repo, ok: true } : { repo, ok: false, reason: failure });
  }
  return results;
}

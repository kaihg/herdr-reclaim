export const HOOK_NAMES = ["post-commit", "post-merge", "post-rewrite"];
export const HOOK_MARKER = "HERDR_RECLAIM_HOOK_V1";
const ORIGINAL_SUFFIX = ".herdr-reclaim-original";

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
const successful = (result) => result && result.code === 0;

export function hookScript({ hook, appHome }) {
  if (!HOOK_NAMES.includes(hook)) throw new Error(`不支援的 hook：${hook}`);
  const root = `${appHome}/data/herdr-reclaim/commits`;
  return `#!/bin/sh\n# ${HOOK_MARKER}\nHOOK=${shellQuote(hook)}\nROOT=${shellQuote(root)}\n` +
`set +e\n` +
`input=\nif [ "$HOOK" = post-rewrite ]; then input=$(cat); fi\n` +
`original="$0${ORIGINAL_SUFFIX}"\n` +
`if [ -x "$original" ]; then\n  if [ "$HOOK" = post-rewrite ]; then printf '%s\\n' "$input" | "$original" "$@"; else "$original" "$@"; fi\nfi\n` +
`facts=$(git rev-parse --path-format=absolute --git-common-dir --show-toplevel HEAD 2>/dev/null) || exit 0\n` +
`{ IFS= read -r common; IFS= read -r top; IFS= read -r sha; } <<HERDR_RECLAIM_FACTS\n$facts\nHERDR_RECLAIM_FACTS\n` +
`at=0\n` +
`mkdir -p "$ROOT" 2>/dev/null || exit 0\n` +
`repo_hash=$(printf '%s' "$common" | cksum)\nrepo_key=\${repo_hash%% *}\n` +
`tmp="$ROOT/.$sha.$HOOK.$repo_key.$$"\n` +
`printf '%s\\n' "$sha" "$HOOK" "$common" "$top" "$at" | REWRITE="$input" awk '\n` +
`function esc(s) { gsub(/\\\\/, "\\\\\\\\", s); gsub(/\\\"/, "\\\\\\\"", s); gsub(/\\t/, "\\\\t", s); gsub(/\\r/, "\\\\r", s); gsub(/\\n/, "\\\\n", s); return s }\n` +
`NR==1 { sha=$0 } NR==2 { hook=$0 } NR==3 { common=$0 } NR==4 { top=$0 } NR==5 { at=$0 } END {\n` +
`  printf "{\\\"schema\\\":1,\\\"sha\\\":\\\"%s\\\",\\\"hook\\\":\\\"%s\\\",\\\"commonDir\\\":\\\"%s\\\",\\\"toplevel\\\":\\\"%s\\\",\\\"at\\\":%s,\\\"rewrite\\\":\\\"%s\\\",\\\"env\\\":{\\\"PI_SESSION_ID\\\":\\\"%s\\\",\\\"PI_TOOL_CALL_ID\\\":\\\"%s\\\",\\\"CODEX_THREAD_ID\\\":\\\"%s\\\",\\\"HC_TERMINAL_ID\\\":\\\"%s\\\"}}\\n", sha, esc(hook), esc(common), esc(top), at, esc(ENVIRON["REWRITE"]), esc(ENVIRON["PI_SESSION_ID"]), esc(ENVIRON["PI_TOOL_CALL_ID"]), esc(ENVIRON["CODEX_THREAD_ID"]), esc(ENVIRON["HC_TERMINAL_ID"])\n` +
`}\n' > "$tmp"\n` +
`if [ -s "$tmp" ]; then mv -f "$tmp" "$ROOT/$sha.$HOOK.$repo_key.json" 2>/dev/null; else rm -f "$tmp"; fi\n` +
`exit 0\n`;
}

async function command(exec, name, args, options = {}) {
  try { return await exec(name, args, options); } catch { return { code: 1, stdout: "", stderr: "" }; }
}

async function repoInfo(repo, exec) {
  const [hooks, top, common, configured] = await Promise.all([
    command(exec, "git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-path", "hooks"]),
    command(exec, "git", ["-C", repo, "rev-parse", "--show-toplevel"]),
    command(exec, "git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
    command(exec, "git", ["-C", repo, "config", "--local", "--get", "core.hooksPath"]),
  ]);
  if (![hooks, top, common].every(successful)) return null;
  return {
    hooksPath: hooks.stdout.trim(), top: top.stdout.trim(), commonDir: common.stdout.trim(),
    configuredHooksPath: successful(configured) ? configured.stdout.trim() : null,
  };
}

async function trackedHooks(repo, hooksPath, top, exec) {
  const result = await command(exec, "git", ["-C", repo, "ls-files", "--full-name"]);
  if (!successful(result)) return false;
  const prefix = `${hooksPath.replace(/\/$/, "")}/`;
  return result.stdout.split(/\r?\n/).some((file) => {
    const absolute = file.startsWith("/") ? file : `${top}/${file}`;
    return absolute.startsWith(prefix);
  });
}

export async function installHooks({ repo, io, exec, appHome }) {
  const info = await repoInfo(repo, exec);
  if (!info) return { status: "not-git-repository" };
  const husky = /(^|[/.])husky([/.]|$)/i.test(info.configuredHooksPath ?? info.hooksPath) ||
    await command(exec, "test", ["-d", `${info.top}/.husky`]).then(successful);
  const tracked = await trackedHooks(repo, info.hooksPath, info.top, exec);
  if (husky || tracked) return { status: "needs-confirmation", hooksPath: info.hooksPath, reason: husky ? "husky" : "tracked-hooks" };
  const mkdir = await command(exec, "mkdir", ["-p", info.hooksPath]);
  if (!successful(mkdir)) return { status: "error", reason: "cannot-create-hooks-directory" };
  const chained = [];
  for (const hook of HOOK_NAMES) {
    const file = `${info.hooksPath}/${hook}`;
    const original = `${file}${ORIGINAL_SUFFIX}`;
    const existing = await io.read(file);
    if (existing !== null) {
      if ((await io.read(original)) !== null) return { status: "needs-confirmation", hooksPath: info.hooksPath, reason: "backup-exists" };
      const moved = await command(exec, "mv", [file, original]);
      if (!successful(moved)) return { status: "error", hooksPath: info.hooksPath, reason: `cannot-preserve-${hook}` };
      chained.push(hook);
    }
    await io.write(file, hookScript({ hook, appHome }), null);
    const chmod = await command(exec, "chmod", ["700", file]);
    if (!successful(chmod)) return { status: "error", hooksPath: info.hooksPath, reason: `cannot-enable-${hook}` };
  }
  return { status: "installed", hooksPath: info.hooksPath, chained };
}

export async function removeHooks({ repo, exec }) {
  const info = await repoInfo(repo, exec);
  if (!info) return { status: "not-git-repository" };
  let removed = 0;
  for (const hook of HOOK_NAMES) {
    const file = `${info.hooksPath}/${hook}`;
    const original = `${file}${ORIGINAL_SUFFIX}`;
    const read = await command(exec, "cat", [file]);
    if (!successful(read) || !read.stdout.includes(HOOK_MARKER)) continue;
    const backup = await command(exec, "test", ["-e", original]);
    if (successful(backup)) {
      await command(exec, "mv", [original, file]);
    } else {
      await command(exec, "rm", ["-f", file]);
    }
    removed++;
  }
  return { status: removed ? "removed" : "not-installed", removed };
}

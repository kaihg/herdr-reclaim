#!/bin/sh
# herdr-reclaim：把 Codex 遠征 adapter 裝進指定的 CODEX_HOME（ticket #10）。
#
# 專案規定不得修改使用者的真實 Codex 設定，所以要明確指定 `--codex-home`；
# 沒有指定、或指到 `$HOME/.codex` 一律拒絕。
#
#   codex-adapter/install.sh --codex-home DIR          安裝
#   codex-adapter/install.sh --codex-home DIR --uninstall
#
# 安裝內容：
#   1. <DIR>/herdr-reclaim/codex-activity.sh         adapter 程式
#   2. <DIR>/hooks.json                              合併 12 個生命週期 hook
#                                                      （只附加、不動既有項目）
# 另外要使用者自己做兩件事（不代改設定）：
#   * `config.toml` 設 `[features] hooks = true`
#   * 讓 Codex 信任這些 hook（第一次跑會問；自動化可用
#     `--dangerously-bypass-hook-trust`）
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
CODEX_HOME_ARG=""
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --codex-home) CODEX_HOME_ARG="${2:-}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[ -n "$CODEX_HOME_ARG" ] || { printf 'usage: install.sh --codex-home DIR [--uninstall]\n' >&2; exit 2; }
[ -d "$CODEX_HOME_ARG" ] || { printf 'codex home does not exist: %s\n' "$CODEX_HOME_ARG" >&2; exit 2; }
TARGET=$(cd "$CODEX_HOME_ARG" && pwd -P)
if [ "$TARGET" = "$HOME/.codex" ] || [ "$TARGET" = "$HOME/.codex/" ]; then
  printf 'refusing to install into the real Codex home: %s\n' "$TARGET" >&2
  printf 'use an isolated CODEX_HOME instead.\n' >&2
  exit 2
fi
command -v jq >/dev/null 2>&1 || { printf 'jq is required\n' >&2; exit 2; }

SCRIPT="$TARGET/herdr-reclaim/codex-activity.sh"
HOOKS="$TARGET/hooks.json"
MARKER="herdr-reclaim/codex-activity.sh"

merge_hooks() { # $1 install 或 uninstall
  current=$([ -f "$HOOKS" ] && cat "$HOOKS" || printf '{}')
  if [ "$1" = install ]; then
    jq -n --argjson cur "$current" --arg script "$SCRIPT" --arg marker "$MARKER" --slurpfile tpl "$HERE/hooks.json" '
      ($cur // {}) as $c
      | ([ $tpl[0].hooks | to_entries[]
           | { key: .key,
               entry: (.value[0] | walk(if type == "string" then gsub("__SCRIPT__"; $script) else . end)) } ]) as $add
      | $c
      | .hooks = (reduce $add[] as $a (($c.hooks // {});
          (.[$a.key] // []) as $existing
          | .[$a.key] = (if any($existing[]?.hooks[]?; (.command // "") | contains($marker))
                         then $existing else $existing + [$a.entry] end)))' >"$HOOKS.tmp"
  else
    jq -n --argjson cur "$current" --arg marker "$MARKER" '
      ($cur // {})
      | .hooks = ((.hooks // {})
          | with_entries(.value = [ .value[] | select(any(.hooks[]?; (.command // "") | contains($marker)) | not) ])
          | with_entries(select((.value | length) > 0)))' >"$HOOKS.tmp"
  fi
  [ -s "$HOOKS.tmp" ] || { printf 'failed to merge hooks.json\n' >&2; rm -f "$HOOKS.tmp"; exit 3; }
  mv "$HOOKS.tmp" "$HOOKS"
}

if [ "$UNINSTALL" = 1 ]; then
  [ -f "$HOOKS" ] && merge_hooks uninstall
  rm -f "$SCRIPT"
  rmdir "$TARGET/herdr-reclaim" 2>/dev/null || true
  printf 'uninstalled: %s\n' "$TARGET"
  exit 0
fi

mkdir -p "$TARGET/herdr-reclaim"
cp "$HERE/codex-activity.sh" "$SCRIPT"
chmod +x "$SCRIPT"
merge_hooks install
printf 'installed: %s\n' "$SCRIPT"
printf 'installed: %s (12 個生命週期 hook)\n' "$HOOKS"
printf 'next: 在 %s/config.toml 設 [features] hooks = true，並讓 Codex 信任這些 hook\n' "$TARGET"

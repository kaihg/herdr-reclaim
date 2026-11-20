#!/bin/sh
# herdr-reclaim：把 Codex 遠征 adapter 裝進指定的 CODEX_HOME（ticket #10）。
#
# 專案規定不得修改使用者的真實 Codex 設定，所以要明確指定 `--codex-home`，
# 而且指到真實使用者的 `~/.codex`、有效 `$HOME/.codex` 或 `$CODEX_HOME` 一律拒絕。
# 比對前兩邊都先正規化（展開 `~`／`~user`、去尾斜線、解析 symlink），所以
# `/tmp` ↔ `/private/tmp`、`/System/Volumes/Data` 這類等價路徑繞不過去。
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

# 把 `~`／`~user` 展開；其餘原樣回傳。
expand_home() {
  case "$1" in
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s/%s' "${HOME%/}" "${1#\~/}" ;;
    "~"*)
      _user=${1#\~}
      _user=${_user%%/*}
      _rest=${1#\~"$_user"}
      _user_home=$(home_of_user "$_user")
      if [ -n "$_user_home" ]; then printf '%s%s' "${_user_home%/}" "$_rest"; else printf '%s' "$1"; fi ;;
    *) printf '%s' "$1" ;;
  esac
}

# 真實使用者的 home：$HOME 可能被改到別處，所以問系統（dscl → getent → ~user）。
home_of_user() {
  _lookup_user=${1:-$(id -un 2>/dev/null || printf '')}
  [ -n "$_lookup_user" ] || return 0
  _lookup_home=""
  if command -v dscl >/dev/null 2>&1; then
    _lookup_home=$(dscl . -read "/Users/$_lookup_user" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
  fi
  [ -n "$_lookup_home" ] || _lookup_home=$(getent passwd "$_lookup_user" 2>/dev/null | cut -d: -f6)
  [ -n "$_lookup_home" ] || _lookup_home=$(eval printf '%s' "~$_lookup_user" 2>/dev/null || true)
  printf '%s' "$_lookup_home"
}

# 正規化路徑：展開 ~、去尾斜線、解析 symlink。路徑還不存在時也盡量解析——
# 往上找到第一個存在的祖先 `pwd -P`，再把其餘接回去。
real_path() {
  _path=$(expand_home "$1")
  while [ "$_path" != "/" ] && [ "${_path%/}" != "$_path" ]; do _path=${_path%/}; done
  _suffix=""
  _probe=$_path
  while [ -n "$_probe" ] && [ "$_probe" != "/" ] && [ ! -e "$_probe" ]; do
    _suffix="/$(basename "$_probe")$_suffix"
    _parent=$(dirname "$_probe")
    [ "$_parent" = "$_probe" ] && break
    _probe=$_parent
  done
  if [ -n "$_probe" ] && [ -d "$_probe" ]; then
    printf '%s%s' "$(cd "$_probe" && pwd -P)" "$_suffix"
  elif [ -n "$_probe" ] && [ "$_probe" != "/" ]; then
    printf '%s/%s%s' "$(cd "$(dirname "$_probe")" && pwd -P)" "$(basename "$_probe")" "$_suffix"
  else
    printf '%s%s' "$_probe" "$_suffix"
  fi
}

refuse_real_codex() {
  printf 'refusing to install into the real Codex home: %s\n' "$TARGET" >&2
  printf 'use an isolated CODEX_HOME outside $HOME/.codex instead.\n' >&2
  exit 2
}

CODEX_HOME_ARG=""
UNINSTALL=0
ALLOW_REAL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --codex-home) CODEX_HOME_ARG="${2:-}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --allow-real-codex-home) ALLOW_REAL=1; shift ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[ -n "$CODEX_HOME_ARG" ] || { printf 'usage: install.sh --codex-home DIR [--uninstall] [--allow-real-codex-home]\n' >&2; exit 2; }
CODEX_HOME_ARG=$(expand_home "$CODEX_HOME_ARG")
[ -d "$CODEX_HOME_ARG" ] || { printf 'codex home does not exist: %s\n' "$CODEX_HOME_ARG" >&2; exit 2; }
TARGET=$(real_path "$CODEX_HOME_ARG")

REAL_HOME=$(home_of_user)
REAL_CODEX=""
[ -n "$REAL_HOME" ] && REAL_CODEX=$(real_path "$REAL_HOME/.codex")
HOME_CODEX=$(real_path "$HOME/.codex")
ENV_CODEX=""
[ -n "${CODEX_HOME:-}" ] && ENV_CODEX=$(real_path "$CODEX_HOME")

# 真實使用者的 ~/.codex（即使 $HOME 被改掉）、有效 $HOME/.codex、$CODEX_HOME
# 預設都不能碰；子路徑也一樣拒絕。使用者明確要裝進真實 Codex 時，必須自己傳
# `--allow-real-codex-home`（測試與自動化流程不得傳）。
if [ "$ALLOW_REAL" != 1 ]; then
  for candidate in "$REAL_CODEX" "$HOME_CODEX" "$ENV_CODEX"; do
    [ -n "$candidate" ] || continue
    if [ "$TARGET" = "$candidate" ]; then refuse_real_codex; fi
    case "$TARGET" in "$candidate"/*) refuse_real_codex ;; esac
  done
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
printf '      信任項由 Codex 自己記在 %s/config.toml 的 [hooks.state]，鍵是 "<hooks.json 路徑>:<事件>:<索引>:0"\n' "$TARGET"
printf '      第一次跑 Codex 會問；自動化可用 codex --dangerously-bypass-hook-trust（本安裝器不代寫信任）\n' "$TARGET"

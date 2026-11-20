#!/bin/sh
# herdr-reclaim：Claude Code hook 的進入點（ticket #11）。
#
# settings.json 只呼叫這支；它不解析 stdin，只負責找到 bun 再把 stdin 原樣交給 adapter。
# 找不到 bun 就安靜結束（exit 0），不能讓 hook 擋住 claude。
set -u

[ "${HERDR_RECLAIM_DISABLE:-}" = "1" ] && exit 0

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

bun_bin="${HERDR_RECLAIM_BUN:-}"
if [ -z "$bun_bin" ]; then
  for candidate in "$(command -v bun 2>/dev/null)" "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      bun_bin="$candidate"
      break
    fi
  done
fi

if [ -z "$bun_bin" ]; then
  root="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/data/herdr-reclaim"
  mkdir -p "$root" 2>/dev/null && printf '%s claude:hook bun not found\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$root/errors.log" 2>/dev/null
  exit 0
fi

exec "$bun_bin" "$here/herdr-reclaim-hook.ts"

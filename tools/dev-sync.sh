#!/bin/bash
# 開發迴圈：把 repo 裡的 mod 同步到 herdr 真正載入的位置。存檔就重載，不用重開 app。
#
# herdr 只從自己 home 裡的真實檔案熱重載 mod（symlink 不會重載，見 tools/install.sh），
# 所以這裡是真的 rsync 檔案，不是連結。
#
# 順序刻意是「先 check 再同步」：改壞的那一版不會蓋掉正在跑的舊版（herdr 也會保留舊版
# 繼續跑並回報錯誤，但畫面上會有一個紅字，開發時很吵）。
#
#   tools/dev-sync.sh              # 一次：check → rsync → 印 status 的錯誤
#   tools/dev-sync.sh --watch      # 一直跑：repo 有變就同步（0.5 秒輪詢，不需額外套件）
#   tools/dev-sync.sh --no-check   # 跳過 check（快，但壞掉的版本會被同步進去）
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TARGET="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/herdr-reclaim"
DO_CHECK=1
QUIET=0
WATCH=0
DELETE=1
INTERVAL="${DEV_SYNC_INTERVAL:-0.5}"

usage() {
  cat <<'EOF'
用法：tools/dev-sync.sh [--target DIR] [--no-check] [--no-delete] [--watch] [--quiet]

  --target DIR   同步到哪（預設 $HERDR_APP_HOME/mods/herdr-reclaim 或 ~/.config/herdr-app/...）
  --no-check     不先跑 herdr-app check（改壞的版本也會同步進去）
  --no-delete    不刪目標裡多出來的檔案
  --watch        持續輪詢 repo，有變更就同步（Ctrl-C 結束）
  --quiet        只在有事時輸出（給 git hook 用）
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET=${2:-}; shift 2 ;;
    --no-check) DO_CHECK=0; shift ;;
    --no-delete) DELETE=0; shift ;;
    --watch) WATCH=1; shift ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知的參數：$1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { [ "$QUIET" -eq 1 ] || printf '%s\n' "$*"; }

RSYNC_FLAGS=(-a -c --exclude '*.d.ts' --exclude jsconfig.json)
if [ "$DELETE" -eq 1 ]; then RSYNC_FLAGS+=(--delete); fi

# 同步一次。回傳 0 成功、1 check 失敗、2 rsync 失敗。靜音模式下失敗也要說話。
sync_once() {
  if [ "$DO_CHECK" -eq 1 ]; then
    if ! out=$(herdr-app check "$ROOT/mod/herdr-reclaim" 2>&1); then
      printf 'dev-sync: check 失敗，沒有同步（正在跑的版本不動）\n%s\n' "$out" >&2
      return 1
    fi
  fi
  if ! out=$(rsync "${RSYNC_FLAGS[@]}" --itemize-changes "$ROOT/mod/herdr-reclaim/" "$TARGET/" 2>&1); then
    printf 'dev-sync: rsync 失敗（目標 %s）\n%s\n' "$TARGET" "$out" >&2
    return 2
  fi
  # 重載後 mod 自己回報的錯誤（空陣列＝沒有）。
  errors=$(herdr-app status 2>/dev/null | jq -c '.errors // []' 2>/dev/null)
  if [ -n "$errors" ] && [ "$errors" != "[]" ]; then
    printf 'dev-sync: 已同步到 %s，但 herdr 回報錯誤：%s\n' "$TARGET" "$errors" >&2
    return 0
  fi
  if [ -z "$out" ]; then
    say "dev-sync: ${TARGET} 已是最新"
  else
    say "dev-sync: ${TARGET} 已更新（$(date '+%H:%M:%S')）"
  fi
}

if [ "$WATCH" -eq 0 ]; then
  sync_once
  exit $?
fi

# 輪詢而不是 inotify：macOS 沒有內建的 watcher，而這個 mod 只有幾十個小檔案，
# 0.5 秒掃一次的成本遠低於多裝一個工具。變更偵測用 rsync 自己的 dry-run（含 checksum）。
scan() { rsync "${RSYNC_FLAGS[@]}" --dry-run --itemize-changes "$ROOT/mod/herdr-reclaim/" "$TARGET/" 2>/dev/null; }
say "dev-sync: 監看 ${ROOT}/mod/herdr-reclaim → ${TARGET}（Ctrl-C 結束）"
sync_once || true
last=$(scan)
while :; do
  sleep "$INTERVAL"
  now=$(scan)
  if [ "$now" != "$last" ]; then
    sync_once || true
    last=$(scan)   # 同步完就等於來源，避免下一輪再跑一次 no-op
  fi
done

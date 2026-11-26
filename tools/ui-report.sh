#!/bin/bash
# 視覺驗收報告：在完全隔離的 herdr（自己的 app home、自己的 core）裡開一個 mod pane，
# 取三個寬度的截圖，順便跑 bun 測試與 `herdr-app check`，最後產出一份 report.html。
#
# 這一支只負責「人眼才看得到」的那一層（排版、重疊、文字被切掉）。畫面是否接對資料、
# 按下去狀態怎麼變，由 `bun test mod/herdr-reclaim` 的 view／pipeline 測試斷言，不需要視窗。
#
# 隔離的是兩層：
#   HERDR_APP_HOME   mods、settings、資料
#   XDG_CONFIG_HOME  herdr-core 的 session（spaces／tabs／panes）與 socket
# 所以不會動到正在用的 Herdr，也不會在別人的 space 裡開 pane。收尾時關 space、關視窗、
# 停掉這顆 core；截圖與 log 留在報告目錄，方便事後看。
#
# 螢幕鎖定、沒有視窗、app 起不來都不會讓它失敗：截圖那一段標成「視覺未驗」，
# 報告照樣產出。測試與 `herdr-app check` 失敗才回傳非 0。
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=""

usage() {
  cat <<'EOF'
用法：tools/ui-report.sh [--out DIR]

  --out DIR   報告目錄（預設 /tmp/herdr-reclaim-ui-report/<時間>）

產出 DIR/report.html：三個寬度的畫面、bun 測試與 herdr-app check 的輸出。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT=${2:-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知的參數：$1" >&2; usage >&2; exit 2 ;;
  esac
done

OUT=${OUT:-/tmp/herdr-reclaim-ui-report/$(date +%Y%m%d-%H%M%S)}
mkdir -p "$OUT" || exit 1

# 兩個 home 都要隔離：app 的資料與 core 的 session 是分開的兩份檔案。
export HERDR_APP_HOME="$OUT/home"
export XDG_CONFIG_HOME="$OUT/xdg"
export XDG_STATE_HOME="$OUT/xdg-state"
export XDG_RUNTIME_DIR="$OUT/run"
mkdir -p "$HERDR_APP_HOME/mods" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

APP_PID=""
SPACE=""
MOD_PANE=""

cleanup() {
  if [ -n "$SPACE" ]; then
    herdr-app do space.close --id "$SPACE" --confirmed true >/dev/null 2>&1
  fi
  herdr-app do window.close '{}' >/dev/null 2>&1
  if [ -n "$APP_PID" ]; then
    kill "$APP_PID" 2>/dev/null
    wait "$APP_PID" 2>/dev/null
  fi
  # 只停這一顆（XDG 指到這裡）core；使用者的 core 不在這個 XDG 底下。
  hc server stop >/dev/null 2>&1
  rm -rf "$XDG_RUNTIME_DIR"
}
trap cleanup EXIT

say() { printf '%s\n' "$*"; }

# --- 不需要視窗的兩層 -------------------------------------------------------
cd "$ROOT" || exit 1

say "跑 bun test mod/herdr-reclaim …"
if bun test mod/herdr-reclaim >"$OUT/bun-test.log" 2>&1; then
  echo pass >"$OUT/bun-test.status"
else
  echo fail >"$OUT/bun-test.status"
fi

say "跑 herdr-app check mod/herdr-reclaim …"
if herdr-app check mod/herdr-reclaim >"$OUT/mod-check.log" 2>&1; then
  echo pass >"$OUT/mod-check.status"
else
  echo fail >"$OUT/mod-check.status"
fi

# --- 視覺：隔離的 app + core ------------------------------------------------
say "啟動隔離的 herdr（${OUT}）…"
rsync -a --exclude '*.d.ts' --exclude jsconfig.json \
  "$ROOT/mod/herdr-reclaim/" "$HERDR_APP_HOME/mods/herdr-reclaim/"
# 不然第一次開會停在歡迎畫面，截圖裡看不到 mod。
printf '{"frame.welcomed":"finished"}\n' >"$HERDR_APP_HOME/shared.json"

nohup herdr-app >"$OUT/app.log" 2>&1 &
APP_PID=$!

VISUAL=unverified
NOTE=""

ready=0
for _ in $(seq 1 80); do
  if herdr-app status >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.25
done
if [ "$ready" -ne 1 ]; then
  NOTE="app 在 20 秒內沒有回應（見 app.log）"
fi

if [ "$ready" -eq 1 ]; then
  # 自己的 space，`--focus false` 不搶目前畫面；截圖前才切過去。
  new_space=$(herdr-app do space.new --name "ui report $(basename "$OUT")" --focus false 2>"$OUT/space.err")
  SPACE=$(printf '%s' "$new_space" | jq -r '.space // empty' 2>/dev/null)
  TERMINAL=$(printf '%s' "$new_space" | jq -r '.terminal // empty' 2>/dev/null)
  if [ -z "$SPACE" ]; then
    NOTE="開不了 space（見 space.err）"
  fi
fi

if [ -n "$SPACE" ]; then
  # 先把 mod 放在右半邊；左邊留一個 terminal，才有分隔線可以拉。
  pane_of_terminal=$(herdr-app ls | jq -r --arg t "$TERMINAL" \
    '[.spaces[].tabs[].terminals[] | select(.terminal == $t) | .pane][0] // empty')
  split=$(herdr-app do pane.split --direction right --pane "$pane_of_terminal" --mod herdr-reclaim 2>"$OUT/split.err")
  MOD_PANE=$(printf '%s' "$split" | jq -r '.pane // empty' 2>/dev/null)
  if [ -z "$MOD_PANE" ]; then
    NOTE="開不了 mod pane（見 split.err）"
  fi
fi

if [ -n "$MOD_PANE" ]; then
  herdr-app do space.select --id "$SPACE" >/dev/null 2>&1
  herdr-app do tab.select --id "$(printf '%s' "$new_space" | jq -r '.tab')" >/dev/null 2>&1
  # 更新提示或對話框會壓在畫面上，關掉它（沒有就當成成功）。
  herdr-app do overlay.close '{}' >/dev/null 2>&1

  # 等 mod 第一次載入完成：帳本頭檔出現之後它就會重繪。
  for _ in $(seq 1 60); do
    [ -f "$HERDR_APP_HOME/data/herdr-reclaim/shared-v2/head.json" ] && break
    sleep 0.25
  done
  sleep 0.5

  # 畫面靜下來才拍：連續兩張一樣才算（時間、動畫不會讓每一輪都不同）。
  settled_shot() {
    local file=$1 tmp="${1%.png}.tmp.png"
    for _ in $(seq 1 12); do
      herdr-app shot "$tmp" >/dev/null 2>&1 || { rm -f "$tmp"; return 1; }
      sleep 0.3
      herdr-app shot "$file" >/dev/null 2>&1 || { rm -f "$tmp"; return 1; }
      if cmp -s "$tmp" "$file"; then rm -f "$tmp"; return 0; fi
    done
    rm -f "$tmp"
    return 1
  }

  shots_ok=1
  settled_shot "$OUT/shot-default.png" || shots_ok=0
  if herdr-app do pane.resize --pane "$MOD_PANE" --direction left --px 240 >/dev/null 2>&1; then
    settled_shot "$OUT/shot-wide.png" || shots_ok=0
  else
    shots_ok=0
  fi
  if herdr-app do pane.resize --pane "$MOD_PANE" --direction right --px 720 >/dev/null 2>&1; then
    settled_shot "$OUT/shot-narrow.png" || shots_ok=0
  else
    shots_ok=0
  fi
  if [ "$shots_ok" -eq 1 ]; then VISUAL=ok; fi
  if [ "$shots_ok" -eq 0 ] && [ -z "$NOTE" ]; then
    NOTE="截圖失敗（常見原因：螢幕鎖定或休眠；先解鎖再跑一次）"
  fi
fi

# --- 報告 -------------------------------------------------------------------
escape() { python3 -c 'import html,sys;sys.stdout.write(html.escape(sys.stdin.read()))'; }

status_of() { cat "$OUT/$1.status" 2>/dev/null || echo "missing"; }

{
  cat <<EOF
<!doctype html>
<meta charset="utf-8">
<title>herdr-reclaim 驗收報告</title>
<style>
  body { font: 14px/1.5 -apple-system, "Helvetica Neue", sans-serif; margin: 24px; max-width: 1200px; }
  h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 28px; }
  table { border-collapse: collapse; } td, th { border: 1px solid #ccc; padding: 4px 10px; text-align: left; }
  .pass { color: #0a7a33; } .fail { color: #b00020; } .warn { color: #a15c00; }
  figure { margin: 12px 0; } img { max-width: 100%; border: 1px solid #ccc; }
  pre { background: #f6f6f6; padding: 10px; overflow: auto; max-height: 420px; }
</style>
<h1>herdr-reclaim 驗收報告</h1>
<p>時間：$(date '+%Y-%m-%d %H:%M:%S')　·　herdr-app：$(herdr-app --version 2>/dev/null || echo unknown)　·　目錄：<code>$OUT</code></p>
<table>
  <tr><th>bun test mod/herdr-reclaim</th><td class="$(status_of bun-test)">$(status_of bun-test)</td></tr>
  <tr><th>herdr-app check mod/herdr-reclaim</th><td class="$(status_of mod-check)">$(status_of mod-check)</td></tr>
  <tr><th>畫面（三個寬度）</th><td class="$([ "$VISUAL" = ok ] && echo pass || echo warn)">$VISUAL</td></tr>
</table>
EOF
  if [ -n "$NOTE" ]; then
    printf '<p class="warn">%s</p>\n' "$(printf '%s' "$NOTE" | escape)"
  fi
  cat <<'EOF'
<p>測試與 <code>check</code> 綠就代表：render 不炸、畫面接對資料、按下去會改變狀態且真的寫進帳本。
下面三張圖只給人看排版與截斷；像素本身不是 gate（時間文字與動畫會抖）。</p>
EOF
  for pair in "shot-default.png:預設寬度" "shot-wide.png:加寬" "shot-narrow.png:縮窄（窄 pane）"; do
    file=${pair%%:*}; label=${pair#*:}
    if [ -f "$OUT/$file" ]; then
      printf '<figure><figcaption>%s</figcaption><img src="%s" alt="%s"></figure>\n' "$label" "$file" "$label"
    else
      printf '<figure><figcaption>%s — 沒有截圖</figcaption></figure>\n' "$label"
    fi
  done
  for log in bun-test mod-check app; do
    if [ -s "$OUT/$log.log" ]; then
      printf '<h2>%s.log</h2>\n<pre>' "$log"
      escape <"$OUT/$log.log" | tail -c 20000
      printf '</pre>\n'
    fi
  done
} >"$OUT/report.html"

say ""
say "報告：${OUT}/report.html"
say "測試：$(status_of bun-test)　check：$(status_of mod-check)　畫面：$VISUAL"
[ -n "$NOTE" ] && say "注意：$NOTE"

[ "$(status_of bun-test)" = pass ] && [ "$(status_of mod-check)" = pass ]

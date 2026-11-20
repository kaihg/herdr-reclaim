#!/bin/sh
# herdr-reclaim：Codex 遠征 adapter（proposal §6.1／§6.2／§6.3；ticket #10）。
#
# 生命週期來源＝**Codex hooks**（`hooks.json` 的 SessionStart／UserPromptSubmit／
# PreToolUse／PostToolUse／PermissionRequest／PreCompact／PostCompact／
# SubagentStart／SubagentStop／Stop／Interrupt／SessionEnd）。Codex 在每個事件把
# 一份 JSON 從 stdin 交給 hook；這是唯一可靠的生命週期訊號。
# rollout 檔（`transcript_path`）只拿來讀**身分**（session_meta）與**用量**
# （token_usage_record），不當成「回合結束」的證據：讀到 transcript 不代表活動
# 完成。`notify` 只有回合層級、沒有用量，也不採用。
#
# 事件對應（§6.1 的 kind）：
#   SessionStart                     → visit_start（並記下用量基線，不發用量）
#   UserPromptSubmit                 → interval_open（一個回合開始）
#   PreToolUse／PostToolUse／…       → heartbeat（回合進行中的可證明活動）
#   PostToolUse                      → 另外補一次用量（一個 response 剛寫完）
#   Stop                             → usage、turn_end、interval_close
#   Interrupt                        → usage、interval_close（中止只算到這裡）
#   SessionEnd                       → usage、interval_close、visit_end
# 被 SIGINT／SIGKILL 打斷的回合不會有 Stop：區間停在最後一次寫入磁碟的事件，
# 沒有 heartbeat 就不算時間（§6.2「只保證不多算」）。實測 `codex exec` 收到
# SIGINT 時一個 hook 都不會補，符合這條規則。
#
# 一次 hook 呼叫是一個新 process，所以 writer epoch 用**呼叫者的父行程**
# （Codex 本體）的 pid + 啟動時間當基底；同一支 Codex process 的事件才寫進同一個檔案。
#
# 寫入位置與 mod 共用（§6.1）：
#   $HERDR_APP_HOME/data/herdr-reclaim/activity/<sessionId>/<writerEpoch>.json
#   $HERDR_APP_HOME/data/herdr-reclaim/activity/<sessionId>/identity.state
#     （`.state` 不是 `.json`：mod 列活動檔時用的是 `find -name '*.json'`）
# mod 在帳本提交成功之後寫 `cities/<city>/acks/<sessionId>/<epoch>.json`；
# 這一支只讀自己的 ack，砍掉 `eventSeq ≤ ackedEventSeq` 的事件（§6.2），
# 並把被砍掉的用量 id 從 usageSeen 移除，讓狀態不會無限長大。
#
# 只依賴 POSIX sh 與 `jq`（原生執行檔）；不啟動 Node／Python 直譯器。
# 這一支只寫檔、絕不讓例外跑進 agent：所有錯誤都寫進 errors.log 並 exit 0。
#
# 隔離／測試用的覆寫（正式使用不需要）：
#   HERDR_RECLAIM_DISABLE=1   完全不動作
#   HERDR_RECLAIM_EPOCH=…     指定 writer epoch（模擬不同 Codex process）
#   HERDR_RECLAIM_NOW_MS=…    指定事件時間（毫秒）
#   HERDR_APP_HOME=…          mod 與 adapter 共用的根目錄

ROOT="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/data/herdr-reclaim"
ACTIVITY="$ROOT/activity"
CITIES="$ROOT/cities"
CLI="codex"
TAB=$(printf '\t')

log_error() {
  mkdir -p "$ROOT" 2>/dev/null || true
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf 'unknown-time')" "$*" >>"$ROOT/errors.log" 2>/dev/null || true
}

safe() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }

now_ms() {
  if [ -n "${HERDR_RECLAIM_NOW_MS:-}" ]; then printf '%s' "$HERDR_RECLAIM_NOW_MS"; return; fi
  jq -rn 'now*1000|floor'
}

# §6.1／§6.2：writerEpoch＝pid + 啟動時間。hook 的 PPID 就是 Codex 本體。
writer_epoch() {
  if [ -n "${HERDR_RECLAIM_EPOCH:-}" ]; then printf '%s' "$HERDR_RECLAIM_EPOCH"; return; fi
  started=$(ps -o lstart= -p "$PPID" 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]\{1,\}/_/g')
  printf '%s-%s' "$PPID" "$(safe "${started:-unknown}")"
}

# mod 的 ack：只讀自己 epoch 的。ack 在每座城的目錄底下，所以要掃 cities/。
acked_event_seq() {
  acked=0
  [ -d "$CITIES" ] || { printf '0'; return; }
  for ack in "$CITIES"/*/acks/"$1"/"$2".json; do
    [ -f "$ack" ] || continue
    value=$(jq -r '.ackedEventSeq // 0' "$ack" 2>/dev/null || printf '0')
    [ "$value" -gt "$acked" ] 2>/dev/null && acked=$value
  done
  printf '%s' "$acked"
}

# visit 開始當下自己問 git：之後 worktree 被刪掉，mod 仍能歸到正確的城（§6.1）。
git_facts() {
  COMMON_DIR=""
  CHECKOUT=""
  [ -n "$1" ] && [ -d "$1" ] || return 0
  CHECKOUT=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null || true)
  COMMON_DIR=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  if [ -z "$COMMON_DIR" ]; then
    COMMON_DIR=$(git -C "$1" rev-parse --git-common-dir 2>/dev/null || true)
    case "$COMMON_DIR" in
      "" | /*) ;;
      *) COMMON_DIR="$1/$COMMON_DIR" ;;
    esac
  fi
}

# 身分只讀 rollout 的第一行 session_meta；讀不到就先留 null，之後再補。
#   child：subagent／guardian 執行緒（thread_source）或帶 parent_thread_id
#   fork ：帶 forked_from_id（複製來源歷史，但不會複製來源的用量紀錄）
#   interactive：source 是 cli／vscode／appServer／custom；exec／mcp／internal 不是
read_identity() {
  IDENT_JSON="null"
  [ -n "$1" ] && [ -f "$1" ] || return 0
  line=$(head -n 1 "$1" 2>/dev/null || true)
  [ -n "$line" ] || return 0
  IDENT_JSON=$(printf '%s' "$line" | jq -c '
    if .type != "session_meta" then empty else
      ((.payload.source // null)
        | if type == "object" then ((keys[0]) // "unknown")
          elif type == "string" then . else "unknown" end) as $src
      | (.payload.thread_source // "") as $ts
      | (.payload.parent_thread_id // "") as $pt
      | (.payload.forked_from_id // "") as $ff
      | (if ($ts == "subagent") or ($ts == "guardian_review") or ($src == "subagent") or ($pt != "")
           then "child"
           elif $ff != "" then "fork"
           else "root" end) as $role
      | { role: $role,
          interactive: (($role != "child")
            and (($src == "cli") or ($src == "vscode") or ($src == "appServer") or ($src == "custom"))),
          parentSessionId: (if $role == "root" then null elif $pt != "" then $pt else $ff end),
          source: $src,
          cliVersion: (.payload.cli_version // "unknown") }
    end' 2>/dev/null || true)
  [ -n "$IDENT_JSON" ] || IDENT_JSON="null"
}

# 掃 rollout 的 token_usage_record：一個 response_id 一筆，去重後才算（S7 的結論）。
# Codex 的 input 已含 cached（與 cache write），要扣掉；任一欄位缺漏或不是
# 非負整數就是「未知」，不補零、直接不發這一筆（S7 樣本以 cumulative 對帳過）。
# 印出 {"events": [...], "ids": [...], "unknown": [...]}。
scan_usage() { # $1 transcript, $2 已看過的 id（JSON 陣列）, $3 是否產生用量事件, $4 at
  [ -n "$1" ] && [ -f "$1" ] || { printf '{"events":[],"ids":[],"unknown":[]}'; return 0; }
  source_file="$1"
  # 最後一行還沒寫完就先不讀它（下一次 hook 再讀），避免整份解析失敗。
  if [ -n "$(tail -c 1 "$source_file" 2>/dev/null || true)" ]; then
    source_file="$ROOT/incomplete.$$.jsonl"
    if ! sed '$d' "$1" >"$source_file" 2>/dev/null; then
      cp "$1" "$source_file" 2>/dev/null || source_file="$1"
    fi
  fi
  result=$(jq -cn --argjson seen "$2" --arg session "$SESSION_ID" --argjson emit "$3" --argjson at "$4" '
    def num(x): if ((x | type) == "number") and (x >= 0) and ((x | floor) == x) then x else null end;
    [ inputs
      | select(.type == "token_usage_record")
      | (.payload.usage // {}) as $u
      | (.payload.response_id // "") as $id
      | select($id != "")
      | (num($u.input_tokens)) as $in
      | (num($u.cached_input_tokens)) as $cr
      | (num($u.cache_write_input_tokens)) as $cw
      | (num($u.output_tokens)) as $out
      | { id: $id,
          ok: (($in != null) and ($cr != null) and ($cw != null) and ($out != null) and (($cr + $cw) <= $in)),
          inputNonCache: (($in // 0) - ($cr // 0) - ($cw // 0)),
          cacheRead: ($cr // 0), cacheWrite: ($cw // 0), output: ($out // 0) }
      | select(($seen | index($id)) == null) ] as $rows
    | { events: (if $emit then
          [ $rows[] | select(.ok)
            | { kind: "usage", at: $at, sourceEntryId: .id,
                usage: { codex: {
                  sourceKey: ("codex#" + $session + "#" + .id),
                  inputNonCache: .inputNonCache, cacheRead: .cacheRead,
                  cacheWrite: .cacheWrite, output: .output,
                  costKnown: 0, costUnknownEntries: 1 } } } ]
        else [] end),
        ids: ([ $rows[].id ] | unique),
        unknown: ([ $rows[] | select(.ok | not) | .id ] | unique) }' "$source_file" 2>>"$ROOT/errors.log")
  [ "$source_file" = "$1" ] || rm -f "$source_file" 2>/dev/null
  [ -n "$result" ] || result='{"events":[],"ids":[],"unknown":[]}'
  printf '%s' "$result"
}

# 記錄的狀態：eventSeq 起點、區間是否開著、visit 是否開著與它的 cwd、已看過的用量 id。
read_state() { # $1 現有紀錄
  printf '%s' "$1" | jq -r '
    (.events // []) as $e
    | [ ([$e[].eventSeq] | max // 0),
        (([$e[] | select(.kind == "interval_open" or .kind == "interval_close")][-1].kind // "") == "interval_open"),
        (([$e[] | select(.kind == "visit_start" or .kind == "visit_end")][-1].kind // "") == "visit_start"),
        ([$e[] | select(.kind == "visit_start")][-1].visit.cwd // ""),
        ([$e[] | select(.kind == "visit_start")][-1].visit.checkout // ""),
        ([$e[] | select(.kind == "visit_start")][-1].visit.visitId // "") ]
    | .[]' 2>/dev/null || printf '0\nfalse\nfalse\n\n\n\n'
}

main() {
  event=""
  SESSION_ID=""
  TRANSCRIPT=""
  CWD=""
  TURN_ID=""
  AT=0
  # 一次 jq 取出這個 adapter 要的欄位 + 時間。欄位逐行輸出：tab 當 IFS 時連續的
  # tab 會被當成同一個分隔符（空欄位消失），換行沒有這個問題。
  fields=$(jq -r '[ (.hook_event_name // ""), (.session_id // ""), (.transcript_path // ""),
                    (.cwd // ""), (.turn_id // ""),
                    ((.source // "") | if type == "string" then . else "" end),
                    ((now * 1000) | floor | tostring) ] | .[]' 2>/dev/null) || return 0
  [ -n "$fields" ] || return 0
  _i=0
  while IFS= read -r _line; do
    case $_i in
      0) event=$_line ;;
      1) SESSION_ID=$_line ;;
      2) TRANSCRIPT=$_line ;;
      3) CWD=$_line ;;
      4) TURN_ID=$_line ;;
      6) AT=$_line ;;
    esac
    _i=$((_i + 1))
  done <<EOF
$fields
EOF
  # hooks.json 也把事件名稱當參數傳進來；stdin 的 hook_event_name 是主要來源，
  # 這個參數只是萬一 payload 沒有它時的後備。
  [ -n "$event" ] || event="${1:-}"
  [ -n "$SESSION_ID" ] && [ -n "$event" ] && [ -n "$AT" ] || return 0

  act_visit=false
  act_open=false
  act_beat=false
  act_turn=false
  act_close=false
  act_endvisit=false
  act_use=false
  case "$event" in
    SessionStart) act_visit=true; act_use=true ;;
    UserPromptSubmit) act_visit=true; act_open=true ;;
    Stop) act_visit=true; act_turn=true; act_close=true; act_use=true ;;
    Interrupt) act_visit=true; act_close=true; act_use=true ;;
    SessionEnd) act_close=true; act_endvisit=true; act_use=true ;;
    PostToolUse)
      act_visit=true; act_beat=true; act_use=true ;;
    PreToolUse | PermissionRequest | PreCompact | PostCompact | SubagentStart | SubagentStop)
      act_visit=true; act_beat=true ;;
    *) return 0 ;;
  esac
  [ -n "${HERDR_RECLAIM_NOW_MS:-}" ] && AT="$HERDR_RECLAIM_NOW_MS"

  EPOCH=$(writer_epoch)
  SESSION_SAFE=$(safe "$SESSION_ID")
  EPOCH_SAFE=$(safe "$EPOCH")
  DIR="$ACTIVITY/$SESSION_SAFE"
  FILE="$DIR/$EPOCH_SAFE.json"
  mkdir -p "$DIR" 2>/dev/null || return 0

  OLD_JSON="null"
  if [ -f "$FILE" ]; then OLD_JSON=$(cat "$FILE" 2>/dev/null || printf 'null'); fi
  case "$OLD_JSON" in "" | null) OLD_JSON="null" ;; esac
  [ "$OLD_JSON" = "null" ] || printf '%s' "$OLD_JSON" | jq -e '.schema == 1' >/dev/null 2>&1 || OLD_JSON="null"

  ACKED=$(acked_event_seq "$SESSION_SAFE" "$EPOCH_SAFE")

  # 身分：先用同一支 session 的 identity.state（rollout 還沒出現時也拿得到）。
  IDENT_JSON="null"
  if [ -f "$DIR/identity.state" ]; then IDENT_JSON=$(cat "$DIR/identity.state" 2>/dev/null || printf 'null'); fi
  case "$IDENT_JSON" in "" | null)
    read_identity "$TRANSCRIPT"
    case "$IDENT_JSON" in "" | null) IDENT_JSON="null" ;; *)
      if printf '%s' "$IDENT_JSON" >"$DIR/identity.$$.tmp" 2>/dev/null; then
        mv -f "$DIR/identity.$$.tmp" "$DIR/identity.state" 2>/dev/null || rm -f "$DIR/identity.$$.tmp" 2>/dev/null
      fi ;;
    esac ;;
  esac

  # 需要新 visit 嗎（§6.3：cwd 改變就切一段新的，即使同一座城）。
  VISIT_CWD=""
  VISIT_OPEN=false
  SEEN_JSON="[]"
  if [ "$OLD_JSON" != "null" ]; then
    state=$(read_state "$OLD_JSON")
    _i=0
    while IFS= read -r _line; do
      case $_i in
        2) VISIT_OPEN=$_line ;;
        3) VISIT_CWD=$_line ;;
      esac
      _i=$((_i + 1))
    done <<EOF
$state
EOF
    SEEN_JSON=$(printf '%s' "$OLD_JSON" | jq -c '.usageSeen // []' 2>/dev/null || printf '[]')
  fi
  visit_new=false
  if [ "$act_visit" = true ]; then
    if [ "$VISIT_OPEN" != "true" ] || [ "$VISIT_CWD" != "$CWD" ]; then visit_new=true; fi
  fi

  VISIT_JSON="null"
  if [ "$visit_new" = true ]; then
    git_facts "$CWD"
    VISIT_JSON=$(jq -cn --arg visitId "$EPOCH_SAFE-$AT" --arg cwd "$CWD" \
      --arg common "${COMMON_DIR:-}" --arg checkout "${CHECKOUT:-}" \
      '{visitId: $visitId, cwd: $cwd,
        commonDir: (if $common == "" then null else $common end),
        checkout: (if $checkout == "" then null else $checkout end)}' 2>/dev/null || printf 'null')
    [ "$VISIT_JSON" != "null" ] || visit_new=false
  fi

  # 用量：SessionStart 只記基線（不發），其餘事件把沒看過的來源補上。
  emit_usage=false
  [ "$event" = "SessionStart" ] || emit_usage=true
  scan=$(scan_usage "$TRANSCRIPT" "$SEEN_JSON" "$emit_usage" "$AT")
  SEEN_ADD=$(printf '%s' "$scan" | jq -c '.ids' 2>/dev/null || printf '[]')
  NEW_EVENTS=$(printf '%s' "$scan" | jq -c '.events' 2>/dev/null || printf '[]')
  unknown=$(printf '%s' "$scan" | jq -r '.unknown | join(",")' 2>/dev/null || true)
  [ -n "$unknown" ] && log_error "usage-unknown session=$SESSION_ID ids=$unknown"

  tmp="$DIR/$EPOCH_SAFE.json.$$"
  if jq -cn --argjson old "$OLD_JSON" \
      --argjson visitNew "$visit_new" --argjson open "$act_open" --argjson beat "$act_beat" \
      --argjson turn "$act_turn" --argjson close "$act_close" --argjson endVisit "$act_endvisit" \
      --argjson visit "$VISIT_JSON" \
      --argjson newEvents "$NEW_EVENTS" --argjson seenAdd "$SEEN_ADD" --argjson ident "$IDENT_JSON" \
      --argjson acked "$ACKED" --argjson at "$AT" --arg sessionId "$SESSION_ID" --arg epoch "$EPOCH" \
      --arg cli "$CLI" --arg turnId "$TURN_ID" '
      ($old // {}) as $o
      | ([($o.events // [])[] | select(.eventSeq > $acked)]) as $kept
      | ([($o.events // [])[] | select(.eventSeq <= $acked) | .sourceEntryId // empty]) as $dropped
      | ([$kept[] | select(.kind == "interval_open" or .kind == "interval_close")][-1].kind // "") as $lastInt
      | ([$kept[] | select(.kind == "visit_start" or .kind == "visit_end")][-1].kind // "") as $lastVis
      | ($lastInt == "interval_open") as $openNow
      | ($lastVis == "visit_start") as $visitNow
      | ([ (if $visitNew then
             [ (if $openNow then [{kind: "interval_close"}] else [] end),
               (if $visitNow then [{kind: "visit_end"}] else [] end),
               [{kind: "visit_start", visit: $visit}] ] | add
           else [] end),
           (if ($open and ((($openNow | not)) or $visitNew)) then [{kind: "interval_open"}] else [] end),
           (if ($beat and $openNow and (($visitNew | not))) then [{kind: "heartbeat"}] else [] end)
         ] | add) as $openers
      | ([ (if ($close and $openNow and (($visitNew | not))) then [{kind: "interval_close"}] else [] end),
           (if ($turn and ($turnId != "")) then [{kind: "turn_end", turnId: $turnId}] else [] end),
           (if ($endVisit and $visitNow and (($visitNew | not))) then [{kind: "visit_end"}] else [] end)
         ] | add) as $closers
      | ([$kept[].eventSeq] | max // 0) as $base
      | ([ ($openers + $newEvents + $closers)[] | . + {at: $at} ]) as $made
      | ([$made[]] | to_entries | map(.value + {eventSeq: ($base + .key + 1)})) as $numbered
      | ($kept + $numbered) as $all
      | { schema: 1, cli: $cli,
          cliVersion: (($ident.cliVersion // $o.cliVersion) // "unknown"),
          capabilities: {usage: true, parent: true, heartbeat: true, commitEnv: true},
          sessionId: $sessionId,
          role: (($ident.role // $o.role) // "root"),
          parentSessionId: (($ident.parentSessionId // $o.parentSessionId) // null),
          interactive: (($ident.interactive // $o.interactive) // false),
          writerEpoch: $epoch,
          events: $all,
          updatedAt: ([($o.updatedAt // 0), $at] | max),
          usageSeen: (((($o.usageSeen // []) - $dropped) + $seenAdd) | unique) }
    ' >"$tmp" 2>>"$ROOT/errors.log"; then
    mv -f "$tmp" "$FILE" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  else
    rm -f "$tmp" 2>/dev/null
    log_error "write-failed session=$SESSION_ID event=$event"
  fi
}

if [ "${HERDR_RECLAIM_DISABLE:-}" = "1" ]; then exit 0; fi
if ! command -v jq >/dev/null 2>&1; then log_error "jq-missing"; exit 0; fi
mkdir -p "$ROOT" 2>/dev/null || true
main </dev/stdin || log_error "fail event=$event session=$SESSION_ID"
exit 0

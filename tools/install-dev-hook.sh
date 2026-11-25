#!/bin/bash
# 讓「commit 完就是最新版」：在 .git/hooks/post-commit 裝一行呼叫 tools/dev-sync.sh。
#
# 這是 opt-in（不會被 tools/install.sh 順手裝上）：它會改 .git/hooks，也可能和其他 hook
# 管理工具（husky、pre-commit）搶同一個檔案。要移除就跑 --remove。
#
# 只同步 worktree 的現況，不看這次 commit 的內容——開發迴圈要的是「我現在改的這一版」。
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOOKS=$(cd "$ROOT" && git rev-parse --git-path hooks 2>/dev/null) || { echo "這裡不是 git repo" >&2; exit 1; }
HOOK="$HOOKS/post-commit"
MARK="# herdr-reclaim dev-sync (installed by tools/install-dev-hook.sh)"

usage() {
  cat <<'EOF'
用法：tools/install-dev-hook.sh [--remove] [--force]

  --remove   拿掉這個 hook（沒有就什麼都不做）
  --force    覆蓋已存在、但不是這裡裝的 post-commit
EOF
}

MODE=install
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --remove) MODE=remove; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知的參數：$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$MODE" = remove ]; then
  if [ -f "$HOOK" ] && grep -qF "$MARK" "$HOOK"; then
    rm -f "$HOOK"
    echo "removed: $HOOK"
  else
    echo "沒有這裡裝的 hook：$HOOK"
  fi
  exit 0
fi

mkdir -p "$HOOKS"
if [ -f "$HOOK" ] && ! grep -qF "$MARK" "$HOOK" && [ "$FORCE" -ne 1 ]; then
  echo "已存在別人的 post-commit：$HOOK" >&2
  echo "先看一下內容；確定要覆蓋再跑 --force（原本的內容不會自動備份）。" >&2
  exit 1
fi

# 用 git 自己解析 repo 根目錄：搬動 repo 之後 hook 還活著。
cat > "$HOOK" <<EOF
#!/bin/sh
$MARK
root=\$(git rev-parse --show-toplevel) || exit 0
exec "\$root/tools/dev-sync.sh" --quiet
EOF
chmod +x "$HOOK"

cat <<EOF
installed: $HOOK
每次 commit 之後會把 worktree 的 mod 同步到 ${HERDR_APP_HOME:-\$HOME/.config/herdr-app}/mods/herdr-reclaim。
存檔就要更新（不等 commit）用：tools/dev-sync.sh --watch
移除：tools/install-dev-hook.sh --remove
EOF

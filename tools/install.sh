#!/bin/sh
# Copies the mod and the omp extension into place as real files (herdr loads and
# hot-reloads mods only from real paths inside its home; symlinks don't reload).
set -eu
cd "$(dirname "$0")/.."
H="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
OMP_EXT="${OMP_EXTENSIONS_DIR:-$HOME/.omp/agent/extensions}"

mkdir -p "$H/mods/herdr-reclaim" "$OMP_EXT"
rsync -a --delete mod/herdr-reclaim/ "$H/mods/herdr-reclaim/"
cp omp-extension/herdr-reclaim.ts "$OMP_EXT/herdr-reclaim.ts"
herdr-app check "$H/mods/herdr-reclaim"
echo "installed: $H/mods/herdr-reclaim, $OMP_EXT/herdr-reclaim.ts (new omp sessions load it)"

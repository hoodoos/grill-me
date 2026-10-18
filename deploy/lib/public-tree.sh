#!/usr/bin/env bash
# Public runtime/static files only; never DATA or the secret env directory. Physical find
# does not follow workspace symlinks. Preserve existing executable bits; add none to data.
# Usage: public-tree.sh <selected-tree> [...]
set -euo pipefail
[ $# -gt 0 ] || { echo "usage: public-tree.sh <selected-tree> [...]" >&2; exit 2; }
for TREE in "$@"; do
  [ -d "$TREE" ] && [ ! -L "$TREE" ] || { echo "not a physical public tree: $TREE" >&2; exit 1; }
  if [ "$(id -u)" = 0 ]; then
    find -P "$TREE" \( -type d -o -type f -o -type l \) -exec chown -h root:root {} +
  fi
  find -P "$TREE" -type d -exec chmod 755 {} +
  find -P "$TREE" -type f -exec chmod u=rwX,go=rX {} +
done

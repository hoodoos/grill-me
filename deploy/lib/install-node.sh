#!/usr/bin/env bash
# Install the official archive's directory, then select it only after Node runs successfully.
# The optional distribution URL also lets fixture tests run this exact code without a network.
# Usage: install-node.sh <opt-directory> <x64|arm64> [distribution-url]
set -euo pipefail
umask 022
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ $# -ge 2 ] && [ $# -le 3 ] || { echo "usage: install-node.sh <opt-directory> <x64|arm64> [distribution-url]" >&2; exit 2; }
OPT="$1"
ARCH="$2"
DIST="${3:-https://nodejs.org/dist/latest-v24.x}"
case "$ARCH" in x64|arm64) ;; *) echo "unsupported arch $ARCH" >&2; exit 1 ;; esac
mkdir -p "$OPT"
chmod 755 "$OPT"
SHASUMS=$(curl -fsSL "$DIST/SHASUMS256.txt")
TARBALL=$(awk -v suffix="-linux-$ARCH.tar.xz" 'substr($2, length($2)-length(suffix)+1) == suffix { print $2 }' <<<"$SHASUMS")
[[ "$TARBALL" =~ ^node-v24\.[0-9]+\.[0-9]+-linux-$ARCH\.tar\.xz$ ]] || { echo "no unique Node 24 linux-$ARCH tarball" >&2; exit 1; }
VER=${TARBALL#node-}; VER=${VER%%-linux-*}
TARGET="$OPT/${TARBALL%.tar.xz}"
if [ "$(readlink "$OPT/node" || true)" = "$TARGET" ] &&
   [ -x "$TARGET/bin/node" ] && [ "$("$TARGET/bin/node" --version)" = "$VER" ]; then
  echo "node $VER already current"
  bash "$HERE/public-tree.sh" "$TARGET"
  exit 0
fi
echo "installing node $VER ($ARCH)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$DIST/$TARBALL" -o "$TMP/$TARBALL"
(cd "$TMP" && awk -v name="$TARBALL" '$2 == name' <<<"$SHASUMS" | sha256sum -c -)
tar -xJf "$TMP/$TARBALL" -C "$OPT"
[ -x "$TARGET/bin/node" ] && [ "$("$TARGET/bin/node" --version)" = "$VER" ] || {
  echo "extracted Node $VER is not executable or reports the wrong version" >&2
  exit 1
}
bash "$HERE/public-tree.sh" "$TARGET"
ln -sfn "$TARGET" "$OPT/node"

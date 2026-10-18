#!/usr/bin/env bash
# Stage the four nginx files as one transaction. On any failure, restore prior bytes/absence.
# Only the plain site.bak-<digits> backup is persistent; other snapshots live outside nginx.
# Usage: configure-nginx.sh <release> <site> <snippet> <http-conf> <legacy-logformat-conf>
set -euo pipefail
[ $# -eq 5 ] || { echo "usage: configure-nginx.sh <release> <site> <snippet> <http-conf> <legacy-logformat-conf>" >&2; exit 2; }
REL="$1"
SITE="$2"
SNIPPET="$3"
HTTPCONF="$4"
LEGACY="$5"
FILES=("$SITE" "$SNIPPET" "$HTTPCONF" "$LEGACY")
TMP=$(mktemp -d)
# Finish every snapshot before arming rollback or touching any live config.
for i in "${!FILES[@]}"; do
  if [ -e "${FILES[$i]}" ]; then cp -p "${FILES[$i]}" "$TMP/$i"; fi
done
COMMITTED=0
cleanup() {
  status=$?
  trap - EXIT
  if [ "$COMMITTED" = 0 ]; then
    echo "nginx configuration failed; restoring all previous nginx files" >&2
    for i in "${!FILES[@]}"; do
      if [ -f "$TMP/$i" ]; then cp -p "$TMP/$i" "${FILES[$i]}"; else rm -f "${FILES[$i]}"; fi
    done
  fi
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT
BAK="$SITE.bak-$(date +%Y%m%d%H%M%S%N)"
cp -p "$SITE" "$BAK"
mkdir -p "$(dirname "$SNIPPET")"
rm -f "$LEGACY"
cp "$REL/deploy/nginx/grill-me-http.conf" "$HTTPCONF"
cp "$REL/deploy/nginx/grill-me.ai-locations.conf" "$SNIPPET"
if ! grep -q 'grill-me\.ai-locations\.conf' "$SITE"; then
  bash "$REL/deploy/lib/patch-site.sh" "$SITE"
  diff -u "$BAK" "$SITE" || true
fi
if [ "$(grep -c 'grill-me\.ai-locations\.conf' "$SITE" || true)" != 1 ]; then
  echo "the include wasn't added exactly once" >&2
  exit 1
fi
nginx -t
COMMITTED=1

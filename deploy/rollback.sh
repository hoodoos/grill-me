#!/usr/bin/env bash
# Grill Me rollback / removal. Run as root.
#   bash deploy/rollback.sh              → point current back at previous, re-sync static, restart, check
#   bash deploy/rollback.sh --remove     → take Grill Me off the box (placeholder site comes back)
#   bash deploy/rollback.sh --remove --purge-data   → also delete /var/lib/grill-me
set -euo pipefail

OPT=/opt/grill-me
DATA=/var/lib/grill-me
WWW=/var/www/grill-me.ai
SITE=/etc/nginx/sites-available/grill-me.ai
SNIPPET=/etc/nginx/snippets/grill-me.ai-locations.conf
UNIT=/etc/systemd/system/grill-me.service
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step() { printf '\n== %s\n' "$*"; }
die() { echo "FAIL: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root"

if [ "${1:-}" = "--remove" ]; then
  step "remove grill-me"
  systemctl stop grill-me 2>/dev/null || true
  systemctl disable grill-me 2>/dev/null || true
  rm -f "$UNIT"
  systemctl daemon-reload
  # Restore the site file: the newest backup WITHOUT our include, or strip the include and put
  # the bare location / back (a backup made by a re-deploy already contains the include).
  bash "$HERE/lib/restore-site.sh" "$SITE"
  rm -f "$SNIPPET" /etc/nginx/conf.d/grill-me-logformat.conf
  nginx -t
  systemctl reload nginx
  if [ -d "$WWW.placeholder" ]; then
    rm -rf "$WWW"
    mv "$WWW.placeholder" "$WWW"
    echo "placeholder site is back"
  fi
  rm -f "$OPT/current" "$OPT/previous"
  if [ "${2:-}" = "--purge-data" ]; then
    rm -rf "$DATA"
    echo "data purged"
  else
    echo "data kept in $DATA (use --purge-data to delete it)"
  fi
  echo "grill-me removed"
  exit 0
fi

step "rollback to previous release"
[ -f "$OPT/previous" ] || die "no previous release recorded"
PREV=$(cat "$OPT/previous")
[ -d "$PREV" ] || die "previous release $PREV is gone"
readlink "$OPT/current" > "$OPT/previous.tmp" && mv "$OPT/previous.tmp" "$OPT/previous.now"
ln -sfn "$PREV" "$OPT/current"
mv "$OPT/previous.now" "$OPT/previous"
# Keep the .grill-me marker: without the exclude, --delete removes it and the next deploy
# mistakes this for a first install and moves the live folder into the placeholder.
rsync -a --delete --exclude=.grill-me "$PREV/static/" "$WWW/"
systemctl restart grill-me
sleep 2
systemctl is-active --quiet grill-me || die "grill-me didn't come up after rollback"
GRILL_ME_NODE="${GRILL_ME_NODE:-$OPT/node/bin/node}" CHECK_LIVE="$PREV/packages/server/scripts/check-live.mjs" \
  bash "$HERE/check.sh" "$OPT/before"
echo "rolled back to $PREV"

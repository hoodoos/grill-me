#!/usr/bin/env bash
# Opt-in LOCAL Linux root/systemd test. All code/Node/static fixtures are under /srv so
# PrivateTmp stays enabled. StateDirectory is mapped into an isolated /var/lib test subtree.
set -euo pipefail
SRC="$(cd "$1" && pwd -P)"; REALNODE="$2"
[ "$(id -u)" = 0 ] || { echo "requires local Linux root" >&2; exit 1; }
install -d -m 755 /srv/grill-me-fixtures /var/lib/grill-me-fixtures
BASE=$(mktemp -d /srv/grill-me-fixtures/startup-smoke.XXXXXXXX)
chmod 755 "$BASE"
TAG=$(basename "$BASE" | tr . -)
UNIT=""; DATA=""
cleanup_case() {
  if [ -n "$UNIT" ]; then
    systemctl stop "$UNIT" >/dev/null 2>&1 || true
    systemctl reset-failed "$UNIT" >/dev/null 2>&1 || true
    rm -f "/run/systemd/system/$UNIT"
    systemctl daemon-reload
  fi
  if [[ "$DATA" = /var/lib/grill-me-fixtures/"$TAG"-* ]]; then rm -rf "$DATA"; fi
  UNIT=""; DATA=""
}
cleanup() {
  cleanup_case
  [[ "$BASE" = /srv/grill-me-fixtures/startup-smoke.* ]] && rm -rf "$BASE"
}
trap cleanup EXIT
VER=$("$REALNODE" --version)
ARCH=x64
[ "$(uname -m)" != aarch64 ] || ARCH=arm64
NAME="node-$VER-linux-$ARCH"
mkdir -p "$BASE/dist" "$BASE/archive/$NAME/bin"
cp "$REALNODE" "$BASE/archive/$NAME/bin/node"
chmod 755 "$BASE/archive/$NAME/bin/node"
XZ_OPT=-0 tar -cJf "$BASE/dist/$NAME.tar.xz" -C "$BASE/archive" "$NAME"
(cd "$BASE/dist"; sha256sum --text "$NAME.tar.xz" > SHASUMS256.txt)
git -c safe.directory="$SRC" -C "$SRC" bundle create "$BASE/source.bundle" HEAD
for CASE in fresh022 fresh077 complete077; do
  echo "== $CASE: inherited mask, real Node/main + actual unit hardening"
  MASK=077; [ "$CASE" != fresh022 ] || MASK=022
  umask "$MASK"
  OPT="$BASE/$CASE/opt"; REL="$OPT/releases/candidate"; WWW="$BASE/$CASE/www"
  ENVFILE="$BASE/$CASE/etc/env"
  DATA="/var/lib/grill-me-fixtures/$TAG-$CASE"
  UNIT="grill-me-$TAG-$CASE.service"
  mkdir -p "$OPT/releases" "$(dirname "$ENVFILE")"
  # The real install helper must handle restrictive input, then repair its already-current
  # branch without downloading. Its executable/version validation runs before mode repair.
  bash "$SRC/deploy/lib/install-node.sh" "$OPT" "$ARCH" "file://$BASE/dist"
  NODE="$OPT/node/bin/node"
  git -c advice.detachedHead=false clone --quiet "$BASE/source.bundle" "$REL"
  (cd "$REL" && "$NODE" packages/server/scripts/build-static.mjs "$REL/static")
  printf '%s\n' fixture-complete-marker > "$REL/.release-sha"
  BEFORE_MARKER=$(sha256sum "$REL/.release-sha")
  install -d -o nobody -g nogroup -m 700 "$DATA"
  (umask 077; printf '%s\n' 'STATS_TOKEN=local-fixture-token-not-a-production-secret' > "$ENVFILE")
  chown root:nogroup "$(dirname "$ENVFILE")" "$ENVFILE"
  chmod 750 "$(dirname "$ENVFILE")"; chmod 640 "$ENVFILE"
  mkdir -p "$BASE/$CASE/private-sentinel"
  printf private > "$BASE/$CASE/private-sentinel/secret"
  chown -R nobody:nogroup "$BASE/$CASE/private-sentinel"
  chmod 700 "$BASE/$CASE/private-sentinel"; chmod 600 "$BASE/$CASE/private-sentinel/secret"
  SENTINEL=$(stat -c '%a %u %g' "$BASE/$CASE/private-sentinel/secret")
  ln -s "$BASE/$CASE/private-sentinel" "$REL/workspace-link"
  if [ "$CASE" = complete077 ]; then
    # Simulate the already-built state that a failed old deployment leaves behind.
    chmod 700 "$OPT" "$OPT/releases"
    find -P "$OPT/$NAME" -type d -exec chmod 700 {} +
    NODE_INODE=$(stat -c '%i' "$OPT/$NAME/bin/node")
    mv "$BASE/dist/$NAME.tar.xz" "$BASE/dist/$NAME.saved"
    bash "$SRC/deploy/lib/install-node.sh" "$OPT" "$ARCH" "file://$BASE/dist"
    mv "$BASE/dist/$NAME.saved" "$BASE/dist/$NAME.tar.xz"
    [ "$(stat -c '%i' "$OPT/$NAME/bin/node")" = "$NODE_INODE" ]
  fi
  # These are deploy.sh's actual mode helpers/parent repairs, including the complete branch.
  chmod 755 "$OPT" "$OPT/releases" "$BASE/$CASE"
  bash "$SRC/deploy/lib/public-tree.sh" "$REL"
  ln -s "$REL" "$OPT/current"
  mkdir -p "$WWW"; cp -a "$REL/static/." "$WWW/"
  # cp -a can preserve stale private modes; test WWW's independent normalization explicitly.
  chmod 700 "$WWW"; chmod 600 "$WWW/index.html"
  bash "$SRC/deploy/lib/public-tree.sh" "$WWW"
  [ "$(sha256sum "$REL/.release-sha")" = "$BEFORE_MARKER" ]
  [ "$(stat -c '%a %u %g' "$BASE/$CASE/private-sentinel/secret")" = "$SENTINEL" ]
  if bash "$SRC/deploy/lib/public-tree.sh" "$REL/workspace-link"; then echo 'symlink tree was accepted' >&2; exit 1; fi
  [ "$(stat -c '%a' "$DATA")" = 700 ]; [ "$(stat -c '%a' "$ENVFILE")" = 640 ]
  runuser -u www-data -- test -r "$WWW/index.html"
  runuser -u www-data -- cat "$WWW/index.html" > /dev/null
  runuser -u www-data -- cat "$WWW/ui/grill.js" > /dev/null
  if runuser -u www-data -- test -r "$ENVFILE"; then echo 'nginx could read env' >&2; exit 1; fi
  if runuser -u www-data -- test -r "$DATA"; then echo 'nginx could read data' >&2; exit 1; fi
  runuser -u nobody -- "$NODE" --version
  PORT=$("$NODE" -e 'let s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
  sed -e "s|/opt/grill-me|$OPT|g" -e "s|/var/lib/grill-me|$DATA|g" \
    -e 's/^User=.*/User=nobody/' -e 's/^Group=.*/Group=nogroup/' \
    -e "s|^StateDirectory=.*|StateDirectory=grill-me-fixtures/$TAG-$CASE|" \
    -e "s|^EnvironmentFile=.*|EnvironmentFile=$ENVFILE|" \
    -e "s/^Environment=PORT=.*/Environment=PORT=$PORT/" \
    "$SRC/deploy/grill-me.service" > "/run/systemd/system/$UNIT"
  systemctl daemon-reload
  SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  systemctl start "$UNIT"
  OK=0
  for i in $(seq 1 80); do
    if curl -fsS --connect-timeout 1 --max-time 1 "http://127.0.0.1:$PORT/healthz" > "$BASE/health.json" 2>/dev/null; then OK=1; break; fi
    sleep .1
  done
  if [ "$OK" != 1 ]; then
    bash "$SRC/deploy/lib/startup-diagnostics.sh" "$UNIT" "$SINCE" "$OPT" "$REL" "$WWW" "$DATA" "$ENVFILE"
    exit 1
  fi
  grep -q '"ok":true' "$BASE/health.json"
  systemctl is-active --quiet "$UNIT"
  systemctl show "$UNIT" -p ActiveState -p SubState -p Result -p ExecMainCode -p ExecMainStatus \
    -p User -p Group -p UMask -p StateDirectoryMode -p PrivateTmp -p ProtectHome -p ProtectSystem \
    -p MemoryMax -p CPUQuotaPerSecUSec -p Nice -p IOSchedulingClass
  [ "$(stat -c '%a' "$DATA/grill-me.db")" = 600 ]
  stat -c '%a %U:%G %n' "$OPT" "$OPT/releases" "$REL" "$REL/packages/server/src/main.js" \
    "$OPT/$NAME/bin/node" "$WWW" "$WWW/index.html" "$ENVFILE" "$DATA" "$DATA/grill-me.db"
  echo "PASS $CASE: real service health, nginx reads, marker/repeat, symlink sentinel, env/data privacy"
  cleanup_case
done
echo 'PASS all local startup fixtures (remote startup cause remains unknown)'

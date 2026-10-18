#!/usr/bin/env bash
# Grill Me: install or update on the DigitalOcean box. One script for both; safe to re-run.
# Run it as root:   bash deploy.sh [git-ref-or-full-sha]      (default: main)
#
# What it does, in order:
#   1. Preflight (changes nothing) + a "before" snapshot of the neighbours for check.sh
#   2. Node 24 under /opt/grill-me/node (the system Node is never touched)
#   3. The grill-me system user
#   4. Clone the ref into /opt/grill-me/releases/<short-sha>, npm ci, run the tests, build static
#   5. nginx: http config (log format + markdown map) + locations snippet + one include line in
#      the 443 block, then reload —
#      before anything is switched, so a failed `nginx -t` leaves the box exactly as it was
#   6. Point /opt/grill-me/current at the release; sync the static tree into /var/www/grill-me.ai
#   7. systemd unit; wait for the API to answer
#   8. the release's deploy/check.sh (site, long poll through nginx, neighbours unchanged)
set -euo pipefail

REF="${1:-main}"
REPO="https://github.com/hoodoos/grill-me"
OPT=/opt/grill-me
DATA=/var/lib/grill-me
WWW=/var/www/grill-me.ai
SITE=/etc/nginx/sites-available/grill-me.ai
SNIPPET=/etc/nginx/snippets/grill-me.ai-locations.conf
HTTPCONF=/etc/nginx/conf.d/grill-me-http.conf
UNIT=/etc/systemd/system/grill-me.service
BEFORE="$OPT/before"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step() { printf '\n== %s\n' "$*"; }
die() { echo "FAIL: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root"

# ---------- 1. preflight (changes nothing) ----------
step "preflight"
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || die "not Ubuntu ($ID)"
case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64) ARCH=arm64 ;; *) die "unsupported arch $(uname -m)" ;; esac
command -v rsync >/dev/null || die "rsync is required"
command -v git >/dev/null || die "git is required"
nginx -t
if ss -ltn | grep -q '127\.0\.0\.1:8787 '; then
  systemctl is-active --quiet grill-me || die "port 8787 is held by something that isn't grill-me"
fi
[ -f "$SITE" ] || die "site file $SITE missing"
[ -L /etc/nginx/sites-enabled/zz-grill-me.ai ] || die "the zz-grill-me.ai link is missing"

step "before snapshot → $BEFORE"
mkdir -p "$BEFORE"
ss -ltnu > "$BEFORE/ports"
systemctl list-units --type=service --state=active --no-legend | awk '{print $1}' | sort > "$BEFORE/units"
echo | openssl s_client -connect cor.ryaboshtan.com:443 -servername cor.ryaboshtan.com 2>/dev/null | openssl x509 -noout -subject > "$BEFORE/neighbour-cor.subject" || true
curl -k -s -o /dev/null -m 10 -w '%{http_code}' https://cor.ryaboshtan.com/ > "$BEFORE/neighbour-cor.code" || true
echo | openssl s_client -connect 46-101-88-204.sslip.io:443 -servername 46-101-88-204.sslip.io 2>/dev/null | openssl x509 -noout -subject > "$BEFORE/neighbour-sslip.subject" || true
curl -k -s -o /dev/null -m 10 -w '%{http_code}' https://46-101-88-204.sslip.io/ > "$BEFORE/neighbour-sslip.code" || true
echo | openssl s_client -connect 46.101.88.204:443 -servername 46.101.88.204 2>/dev/null | openssl x509 -noout -subject > "$BEFORE/neighbour-ip.subject" || true
curl -k -s -o /dev/null -m 10 -w '%{http_code}' https://46.101.88.204/ > "$BEFORE/neighbour-ip.code" || true
echo | openssl s_client -connect 46.101.88.204:443 -noservername 2>/dev/null | openssl x509 -noout -subject > "$BEFORE/default-cert.subject" || true
curl -k -s -o /dev/null -m 10 -w '%{http_code}' https://www.grill-me.ai/ > "$BEFORE/www.code" || true

# ---------- 2. Node 24 under /opt/grill-me (system Node untouched) ----------
step "node 24"
mkdir -p "$OPT"
bash "$HERE/lib/install-node.sh" "$OPT" "$ARCH"
NODE="$OPT/node/bin/node"
"$NODE" --version

# ---------- 3. the grill-me system user ----------
step "user"
if ! id grill-me >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin grill-me
fi
mkdir -p "$DATA"
chown grill-me:grill-me "$DATA"

# ---------- 4. the release ----------
step "release ($REF)"
mkdir -p "$OPT/releases"
if [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then
  SHA=$REF # an exact commit; GitHub serves reachable shas
else
  SHA=$(git ls-remote "$REPO" "$REF" "$REF^{}" | head -1 | awk '{print $1}')
  [ -n "$SHA" ] || die "ref $REF not found in $REPO"
fi
SHORT=${SHA:0:12}
REL="$OPT/releases/$SHORT"
# .release-sha is the completion marker, written last: a half-built release folder (npm ci, the
# tests or build-static died midway) is wiped and rebuilt instead of being deployed.
if [ ! -f "$REL/.release-sha" ]; then
  rm -rf "$REL"
  if [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then
    git clone --quiet --depth 1 "$REPO" "$REL"
    git -C "$REL" fetch --quiet --depth 1 origin "$SHA"
    git -C "$REL" checkout --quiet FETCH_HEAD
  else
    git clone --quiet --depth 1 --branch "$REF" "$REPO" "$REL" 2>/dev/null || {
      git clone --quiet --depth 1 "$REPO" "$REL"
      git -C "$REL" fetch --quiet --depth 1 origin "$SHA"
      git -C "$REL" checkout --quiet FETCH_HEAD
    }
  fi
  (cd "$REL" && PATH="$OPT/node/bin:$PATH" npm ci --omit=dev)
  # Tests at the lowest priority, and without the CLI's pack test: the game always wins.
  (cd "$REL" && nice -n 19 env GRILL_ME_SKIP_PACK=1 "$NODE" --test)
  (cd "$REL" && "$NODE" packages/server/scripts/build-static.mjs "$REL/static")
  echo "$SHA" > "$REL/.release-sha" # the service shows this as GRILL_ME_VERSION on /stats
  chown -R root:root "$REL"
else
  echo "release $SHORT already built"
fi

# ---------- 5. nginx (before the switch: a failed nginx -t leaves the box as it was) ----------
step "nginx"
bash "$REL/deploy/lib/configure-nginx.sh" "$REL" "$SITE" "$SNIPPET" "$HTTPCONF" \
  /etc/nginx/conf.d/grill-me-logformat.conf
systemctl reload nginx

# ---------- 6. switch ----------
step "switch to $SHORT"
if [ -L "$OPT/current" ]; then readlink "$OPT/current" > "$OPT/previous"; fi
ln -sfn "$REL" "$OPT/current"
if [ ! -e "$WWW/.grill-me" ]; then
  [ -d "$WWW" ] && mv "$WWW" "$WWW.placeholder"
  mkdir -p "$WWW"
  cp -a "$REL/static/." "$WWW/"
  touch "$WWW/.grill-me"
else
  rsync -a --delete --exclude=.grill-me "$REL/static/" "$WWW/"
fi

# ---------- 7. systemd ----------
step "systemd"
# /etc/grill-me/env: created once with a random stats token; GRILL_ME_VERSION updated every
# deploy. The token is never printed.
mkdir -p /etc/grill-me
if [ ! -f /etc/grill-me/env ]; then
  TOKEN=$(openssl rand -base64 48 | tr -d '/+=' | head -c 48)
  printf 'STATS_TOKEN=%s\nMEMORY_MAX_BYTES=268435456\n' "$TOKEN" > /etc/grill-me/env
  chown root:grill-me /etc/grill-me/env
  chmod 640 /etc/grill-me/env
  echo "created /etc/grill-me/env — read the stats token with: sudo cat /etc/grill-me/env"
fi
if grep -q '^GRILL_ME_VERSION=' /etc/grill-me/env; then
  sed -i "s/^GRILL_ME_VERSION=.*/GRILL_ME_VERSION=$SHORT/" /etc/grill-me/env
else
  echo "GRILL_ME_VERSION=$SHORT" >> /etc/grill-me/env
fi
cp "$REL/deploy/grill-me.service" "$UNIT"
systemctl daemon-reload
systemctl enable grill-me >/dev/null
systemctl restart grill-me
RID=$("$NODE" -e 'console.log(require("crypto").randomBytes(12).toString("base64url"))')
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8787/api/g/$RID" || true)
  [ "$code" = "404" ] && break
  sleep 1
done
[ "$code" = "404" ] || die "the API didn't come up on 127.0.0.1:8787"
echo "API answers on 127.0.0.1:8787"

# ---------- 8. checks ----------
# The checks come from the release itself, so an older operator clone can't run older checks
# against a newer release.
step "checks"
if GRILL_ME_NODE="$NODE" CHECK_LIVE="$REL/packages/server/scripts/check-live.mjs" \
  bash "$REL/deploy/check.sh" "$BEFORE"; then
  # Record the release only once the checks pass, so RELEASE is always a working deploy.
  echo "$SHA $REF $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OPT/RELEASE"
  echo "DEPLOYED $SHA ($REF)"
else
  echo "checks failed; the last good release is:" >&2
  cat "$OPT/RELEASE" 2>/dev/null >&2 || echo "(none recorded)" >&2
  echo "run: bash deploy/rollback.sh" >&2
  exit 1
fi

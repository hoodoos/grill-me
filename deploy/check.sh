#!/usr/bin/env bash
# Grill Me post-deploy checks. Run by deploy.sh (with the "before" snapshot dir as $1), or on
# their own:  bash deploy/check.sh [snapshot-dir]
# Env: BASE (default https://grill-me.ai), GRILL_ME_NODE (default: node), CHECK_LIVE (default:
# the repo's packages/server/scripts/check-live.mjs). Prints PASS/FAIL per check, exits
# non-zero on any failure.
set -uo pipefail

BEFORE="${1:-/opt/grill-me/before}"
BASE="${BASE:-https://grill-me.ai}"
NODE="${GRILL_ME_NODE:-node}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_LIVE="${CHECK_LIVE:-$HERE/../packages/server/scripts/check-live.mjs}"

FAILURES=0
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; FAILURES=$((FAILURES + 1)); }
check() { # name command...
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi
}

RID=$("$NODE" -e 'console.log(require("crypto").randomBytes(12).toString("base64url"))' 2>/dev/null)

# ---------- the site ----------
url_check() { # path expected-status expected-content-type-prefix
  local path="$1" want="$2" ctype="$3"
  local hdrs code
  hdrs=$(curl -sS -m 15 -D - -o /dev/null "$BASE$path") || { fail "GET $path (request failed)"; return; }
  code=$(head -1 <<<"$hdrs" | awk '{print $2}')
  [ "$code" = "$want" ] || { fail "GET $path → $code, want $want"; return; }
  if [ -n "$ctype" ] && ! grep -qi "^content-type: $ctype" <<<"$hdrs"; then fail "GET $path content-type"; return; fi
  for h in content-security-policy referrer-policy x-content-type-options cross-origin-opener-policy permissions-policy; do
    grep -qi "^$h:" <<<"$hdrs" || { fail "GET $path missing $h"; return; }
  done
  pass "GET $path → $code"
}
url_check / 200 "text/html"
url_check /demo 200 "text/html"
url_check /hub 200 "text/html"
url_check /ui/grill.js 200 "text/javascript"
url_check /core/index.js 200 "text/javascript"
url_check "/g/$RID" 200 "text/html"

hdrs=$(curl -sS -m 15 -D - -o /dev/null "$BASE/api/g/$RID")
code=$(head -1 <<<"$hdrs" | awk '{print $2}')
if [ "$code" = "404" ] && grep -qi '^content-type: application/json' <<<"$hdrs"; then pass "GET /api/g/<random> → 404 JSON"; else fail "GET /api/g/<random> → $code"; fi

if [ -f "$BEFORE/www.code" ]; then
  now_code=$(curl -k -s -o /dev/null -m 10 -w '%{http_code}' https://www.grill-me.ai/ || true)
  if [ "$now_code" = "$(cat "$BEFORE/www.code")" ]; then pass "www.grill-me.ai unchanged"; else fail "www.grill-me.ai: $(cat "$BEFORE/www.code") → $now_code"; fi
fi

# ---------- the long poll through nginx ----------
if "$NODE" "$CHECK_LIVE" "$BASE"; then pass "long poll"; else fail "long poll"; fi

# ---------- the neighbours are unchanged ----------
if [ -d "$BEFORE" ] && [ -f "$BEFORE/ports" ]; then
  neighbour() { # name url connect servername
    local name="$1" url="$2" connect="$3" sni="$4"
    local code subject
    code=$(curl -k -s -o /dev/null -m 10 -w '%{http_code}' "$url" || true)
    subject=$(echo | openssl s_client -connect "$connect" -servername "$sni" 2>/dev/null | openssl x509 -noout -subject 2>/dev/null || true)
    local ok=1
    [ "$code" = "$(cat "$BEFORE/neighbour-$name.code")" ] || ok=0
    [ "$subject" = "$(cat "$BEFORE/neighbour-$name.subject")" ] || ok=0
    if [ "$ok" = 1 ]; then pass "neighbour $name unchanged"; else fail "neighbour $name changed (code '$code', subject '$subject')"; fi
  }
  neighbour cor https://cor.ryaboshtan.com/ cor.ryaboshtan.com:443 cor.ryaboshtan.com
  neighbour sslip https://46-101-88-204.sslip.io/ 46-101-88-204.sslip.io:443 46-101-88-204.sslip.io
  neighbour ip https://46.101.88.204/ 46.101.88.204:443 46.101.88.204

  subject=$(echo | openssl s_client -connect 46.101.88.204:443 -noservername 2>/dev/null | openssl x509 -noout -subject 2>/dev/null || true)
  if [ "$subject" = "$(cat "$BEFORE/default-cert.subject")" ]; then pass "default certificate unchanged (sslip.io)"; else fail "default certificate changed: $subject"; fi

  # Ports: the same set as before, plus 127.0.0.1:8787 only.
  if diff <(ss -ltnu | grep -v '127\.0\.0\.1:8787 ') <(grep -v '127\.0\.0\.1:8787 ' "$BEFORE/ports") >/dev/null; then
    pass "listening ports unchanged (plus 127.0.0.1:8787)"
  else
    fail "listening ports changed:"; diff <(ss -ltnu) "$BEFORE/ports" | head -20
  fi

  # Every systemd unit that was active before still is.
  gone=$(comm -13 <(systemctl list-units --type=service --state=active --no-legend | awk '{print $1}' | sort) "$BEFORE/units")
  if [ -z "$gone" ]; then pass "all previously active units still active"; else fail "units no longer active: $gone"; fi
else
  echo "SKIP neighbour/ports/units checks (no snapshot at $BEFORE)"
fi

echo
if [ "$FAILURES" = 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILURES CHECK(S) FAILED"; exit 1; fi

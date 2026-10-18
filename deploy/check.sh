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

# /healthz (public), /go/hub (counted redirect), /stats (private)
body=$(curl -sS -m 15 "$BASE/healthz")
if [ "$body" = '{"ok":true}' ]; then pass "/healthz → 200 {\"ok\":true}"; else fail "/healthz → $body"; fi
read -r code redir <<<"$(curl -sS -m 15 -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE/go/hub")"
if [ "$code" = "302" ] && [ "$redir" = "$BASE/hub" ]; then pass "/go/hub → 302 /hub"; else fail "/go/hub → $code $redir"; fi

stats_body=$(curl -sS -m 15 "$BASE/stats")
if grep -q 'type="password"' <<<"$stats_body" && ! grep -q 'data.json' <<<"$stats_body"; then
  pass "/stats without auth shows the login page and no data"
else
  fail "/stats without auth didn't show the login page"
fi
code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$BASE/stats/data.json")
[ "$code" = "401" ] && pass "/stats/data.json without auth → 401" || fail "/stats/data.json without auth → $code"
STATS_TOKEN="${STATS_TOKEN:-$(grep -s '^STATS_TOKEN=' /etc/grill-me/env | cut -d= -f2- || true)}"
if [ -n "$STATS_TOKEN" ]; then
  code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $STATS_TOKEN" "$BASE/stats/data.json")
  [ "$code" = "200" ] && pass "/stats/data.json with the token → 200" || fail "/stats/data.json with the token → $code"
else
  echo "SKIP /stats/data.json with token (no STATS_TOKEN env and no /etc/grill-me/env)"
fi

# ---------- the install guide (content negotiation on /) ----------
GUIDE="$(cat "$HERE/../site/install.md" 2>/dev/null || true)"
body=$(curl -sS -m 15 "$BASE/" || true) # curl's defaults: UA curl/*, Accept */*
if [ -n "$GUIDE" ] && [ "$body" = "$GUIDE" ]; then pass "GET / (curl defaults) → the guide"; else fail "GET / (curl defaults) → the guide"; fi

CHROME_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
CHROME_ACCEPT='text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
body=$(curl -sS -m 15 -H "Accept: $CHROME_ACCEPT" -A "$CHROME_UA" "$BASE/" || true)
ctype=$(curl -sS -m 15 -o /dev/null -w '%{content_type}' -H "Accept: $CHROME_ACCEPT" -A "$CHROME_UA" "$BASE/" || true)
if [[ "$body" == *"<html"* && "$ctype" == text/html* ]]; then pass "GET / (browser) → HTML"; else fail "GET / (browser) → HTML"; fi

body=$(curl -sS -m 15 -H 'Accept: text/markdown' "$BASE/" || true)
if [ -n "$GUIDE" ] && [ "$body" = "$GUIDE" ]; then pass "GET / (Accept: text/markdown) → the guide"; else fail "GET / (Accept: text/markdown) → the guide"; fi

for p in /install /llms.txt; do
  hdrs=$(curl -sS -m 15 -D - -o /dev/null "$BASE$p" || true)
  code=$(head -1 <<<"$hdrs" | awk '{print $2}')
  if [ "$code" = "200" ] && grep -qi '^content-type: text/plain' <<<"$hdrs"; then pass "GET $p → 200 text/plain"; else fail "GET $p → $code"; fi
done

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

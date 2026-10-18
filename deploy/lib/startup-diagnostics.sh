#!/usr/bin/env bash
# Bounded, startup-attempt-only diagnostics. Never dump Environment or file contents.
# Usage: startup-diagnostics.sh <unit> <since-UTC> <opt> <release> <www> <data> <env-file>
set -uo pipefail
[ $# -eq 7 ] || { echo "usage: startup-diagnostics.sh <unit> <since-UTC> <opt> <release> <www> <data> <env-file>" >&2; exit 2; }
UNIT="$1"; SINCE="$2"; OPT="$3"; REL="$4"; WWW="$5"; DATA="$6"; ENVFILE="$7"
echo "== startup diagnostics (this attempt only; metadata and bounded journal)"
timeout -k 1s 4s systemctl show "$UNIT" --no-pager \
  -p ActiveState -p SubState -p Result -p ExecMainCode -p ExecMainStatus || true
echo "-- journal since $SINCE (last 30 entries, at most 12 KiB)"
# Redact the stats token if a future startup exception ever includes it. Read only its value
# internally; never print the env file. Drop access-log messages, which are not startup errors.
timeout -k 1s 4s journalctl -u "$UNIT" --since "$SINCE" -n 30 --no-pager -o short-iso 2>&1 |
  awk 'FILENAME != "-" { if ($0 ~ /^STATS_TOKEN=/) token = substr($0, 13); next }
    / (GET|HEAD|POST|DELETE) \/[^ ]* [0-9][0-9][0-9] [0-9]+ms$/ { next }
    { if (length(token)) { while ((i = index($0, token)) > 0) $0 = substr($0, 1, i-1) "[redacted]" substr($0, i+length(token)) }; print }' \
    <(if [ -r "$ENVFILE" ]; then cat "$ENVFILE"; fi) - |
  head -c 12288 || true
echo "-- selected path owners/modes (no contents)"
timeout -k 1s 4s stat -c '%a %U:%G %n' "$OPT" "$OPT/releases" "$OPT/node" "$OPT/node/bin/node" \
  "$REL" "$REL/packages/server/src/main.js" "$WWW" "$WWW/index.html" "$DATA" "$ENVFILE" || true
timeout -k 1s 4s namei -l "$OPT/node/bin/node" "$REL/packages/server/src/main.js" "$WWW/index.html" "$DATA" "$ENVFILE" || true
exit 0

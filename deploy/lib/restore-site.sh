#!/usr/bin/env bash
# Undoes patch-site.sh for rollback --remove:
#  1. If a <site>.bak-* backup without the include exists, restore the newest such backup.
#  2. Otherwise remove the include line from the grill-me.ai 443 block and put back a bare
#     "location / { try_files $uri $uri/ =404; }".
# Usage: restore-site.sh <site-file>
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: restore-site.sh <site-file>" >&2; exit 2; }
SITE="$1"

if grep -q 'grill-me\.ai-locations\.conf' "$SITE"; then
  newest_clean=""
  for b in $(ls -1t "$SITE".bak-* 2>/dev/null || true); do
    if ! grep -q 'grill-me\.ai-locations\.conf' "$b"; then newest_clean="$b"; break; fi
  done
  if [ -n "$newest_clean" ]; then
    cp "$newest_clean" "$SITE"
    exit 0
  fi
  awk '
  function braces(s, ch,   n, i) { n = 0; for (i = 1; i <= length(s); i++) if (substr(s, i, 1) == ch) n++; return n }
  {
    if (!inblock) {
      if ($0 ~ /^[ \t]*server[ \t]*[{]/) {
        inblock = 1
        depth = braces($0, "{") - braces($0, "}")
        buf = $0 "\n"
        has443 = 0
        next
      }
      print
      next
    }
    if ($0 !~ /grill-me\.ai-locations\.conf/) buf = buf $0 "\n"
    depth += braces($0, "{") - braces($0, "}")
    if ($0 ~ /listen[ \t]+443[ \t]+ssl/) has443 = 1
    if (depth > 0) next
    inblock = 0
    if (has443 && buf ~ /server_name[ \t]+[^;]*grill-me\.ai/ && buf !~ /location[ \t]+\/[ \t]*[{]/) {
      sub(/\n[ \t]*[}]\n$/, "\n    location / {\n        try_files $uri $uri/ =404;\n    }\n}\n", buf)
    }
    printf "%s", buf
    next
  }
  ' "$SITE" > "$SITE.restored"
  mv "$SITE.restored" "$SITE"
fi

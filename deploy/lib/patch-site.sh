#!/usr/bin/env bash
# Adds "include /etc/nginx/snippets/grill-me.ai-locations.conf;" to the grill-me.ai 443 server
# block of a site file: the block's bare "location / { ... }" is dropped and any access_log
# lines in it are commented out (the IP-free log format in the snippet is the only one for this
# site). Idempotent: an already-patched file is left byte-identical. Edits in place.
# Usage: patch-site.sh <site-file>
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: patch-site.sh <site-file>" >&2; exit 2; }
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
  buf = buf $0 "\n"
  depth += braces($0, "{") - braces($0, "}")
  if ($0 ~ /listen[ \t]+443[ \t]+ssl/) has443 = 1
  if (depth > 0) next
  # end of the server block
  inblock = 0
  if (has443 && buf ~ /server_name[ \t]+[^;]*grill-me\.ai/ && buf !~ /grill-me\.ai-locations\.conf/) {
    gsub(/[ \t]*location[ \t]+\/[ \t]*[{][^{}]*[}]\n/, "", buf)
    gsub(/\n[ \t]*access_log[ \t]+/, "\n    # grill-me: the IP-free access log lives in the snippet\n    # access_log ", buf)
    sub(/\n[ \t]*[}]\n$/, "\n    include /etc/nginx/snippets/grill-me.ai-locations.conf;\n}\n", buf)
  }
  printf "%s", buf
  next
}
' "$1" > "$1.patched"
mv "$1.patched" "$1"

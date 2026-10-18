# Deploying Grill Me to grill-me.ai

Everything here is applied by a person with root on the DigitalOcean box. The box also runs a
live game server and other sites, so Grill Me stays light (capped CPU/memory, idle I/O) and
never restarts nginx (only `nginx -t` + `systemctl reload nginx`).

## Files

| File | Installed as | What it is |
|---|---|---|
| `deploy.sh` | run from a clone | One script for install and update: `bash deploy.sh [ref-or-full-sha]`. Readable top to bottom; safe to re-run. Ends with `DEPLOYED <sha> (<ref>)` and records `/opt/grill-me/RELEASE` once the checks pass. |
| `check.sh` | run from a clone | Post-deploy checks (site, security headers, long poll through nginx, neighbours unchanged). Also runs standalone. |
| `rollback.sh` | run from a clone | `bash rollback.sh` back to the previous release; `bash rollback.sh --remove` takes Grill Me off the box (`--purge-data` also deletes `/var/lib/grill-me`). |
| `nginx/grill-me.ai-locations.conf` | `/etc/nginx/snippets/grill-me.ai-locations.conf` | `/api/` and `/g/` proxy to `127.0.0.1:8787`; `/` negotiates between the install guide and the homepage; `/install` and `/llms.txt` serve the guide as plain text; everything else from `/var/www/grill-me.ai` with the same security headers Node sets. |
| `nginx/grill-me-http.conf` | `/etc/nginx/conf.d/grill-me-http.conf` | The `grillme_noip` access-log format (no IPs, user agents, referrers or query strings) and the `$grillme_markdown` map behind the `/` negotiation (same rule as the server's `wantsMarkdown`). |
| `nginx/site-443.patch` | — (illustrative) | The one-line change to the site file's 443 block. `deploy.sh` applies it by pattern, not with `patch`. |
| `grill-me.service` | `/etc/systemd/system/grill-me.service` | The systemd unit: user `grill-me`, Node 24 from `/opt/grill-me/node`, caps and hardening. |

## Order

1. `bash deploy/deploy.sh <ref-or-full-sha>` from any clone (default `main`) — it does everything
   and ends with the release's own `check.sh`.
2. If checks fail on a new release: `bash rollback.sh`.

If the tests (or `npm ci`, or the static build) fail during a deploy, just run `deploy.sh` again:
`.release-sha` is written last, so a half-built release is wiped and rebuilt, never deployed.

Node is installed into the official archive directory (`node-v24.<minor>.<patch>-linux-<arch>`).
The `node` link changes only after the extracted executable reports the expected version.
Before nginx validation, the site, snippet, http config and legacy log-format file are all
snapshotted. A patch or validation failure restores their prior bytes, including leaving
previously absent files absent. Only numeric `site.bak-<timestamp>` backups are eligible for
site restoration; snippet/http snapshots cannot be mistaken for a site file.

Deployment normalizes public Node, release and copied static trees independently of an
operator's inherited umask. An already-complete release is repaired too. Physical traversal
does not follow workspace symlinks, and executable bits are preserved; Node must validate
before its tree is repaired. Data stays service-owned `0700`, the env file root/service-group
`0640`, and the unit uses `UMask=0077` with `StateDirectoryMode=0700`.

Startup/restart failure prints bounded state/exit fields, the current attempt's journal tail
(stats token redacted before truncation), and selected path owners/modes. It never dumps the
environment. Local readiness requests have connection and total timeouts.

For the real unit regression, use an **isolated local Linux systemd machine**, as root with
Node 24: `GRILL_ME_SYSTEMD_SMOKE=1 node --test packages/server/test/startup.test.js`.
It stages fresh `022`, fresh `077` and already-complete `077` releases, runs real Node under
the shipped hardening, checks nginx-user reads and data/env privacy, then removes its units
and fixtures. This opt-in test is skipped in ordinary suites; Linux mode/diagnostic tests run
without it. Windows skips those POSIX tests.

The site file is `/etc/nginx/sites-available/grill-me.ai`, enabled as
`/etc/nginx/sites-enabled/zz-grill-me.ai`. Keep the `zz-` link name: it keeps the other sites as
the per-port defaults. Never add `default_server`.

## Operating

- Logs: `journalctl -u grill-me`
- The deployed commit: `deploy.sh` ends with `DEPLOYED <sha> (<ref>)` and records it in
  `/opt/grill-me/RELEASE` (`<sha> <ref> <UTC time>`, written only after the checks pass). The
  service shows the sha as `GRILL_ME_VERSION` on `/stats`, from `.release-sha` in the release
  folder.
- Daily counters (created / answered / deleted / expired; nothing else is counted):
  `/opt/grill-me/node/bin/node /opt/grill-me/current/packages/server/src/stats.js /var/lib/grill-me/grill-me.db`
- Layout: releases in `/opt/grill-me/releases/<sha>`, `current` symlink, `previous` file, Node 24
  in `/opt/grill-me/node`, data in `/var/lib/grill-me`, static tree in `/var/www/grill-me.ai`.

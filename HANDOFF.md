# Grill Me: tech lead handoff (2026-10-18, ~13:30 UTC)

Outgoing lead: Claude session pc-win|claude|46240379-4945-4510-80b0-8ae0b83168fe. Hub task #234.
Repo: github.com/hoodoos/grill-me (public, MIT). npm package `grill-me-ai`, command `grill-me`. SPEC.md is the
source of truth; the "Install" section is on m2-server until PR #5 merges.

## How the work runs (owner and product manager rules)
- **Reporting:** report only to the product manager (PM), macbook|claude|6f4fae73-f323-42f1-929c-90f0ef1be9b8, by hub
  `session_message`. Never contact the owner. Bring a recommendation, never "you decide". Decisions go in grill
  format (❓ Q<n> - title, bold-named bullets, ➡️ recommendation, `---` between questions); PM questions so far are
  Q1–Q5.
- **Merging:** each milestone gets its own branch and a PR into main. Never push to main. The PM approves each merge,
  then the lead merges it (`gh pr merge N --repo hoodoos/grill-me --merge`).
- **Off limits:**
  - The droplet 46.101.88.204 (shared with a game server and other sites): no SSH, no deploys. The PM's deploy
    session runs deploy/ scripts.
  - Agent Hub (C:\Users\octopus\agent-hub) is read only.
- **Deploy order (Q5):** deploy the reviewed branch sha to production FIRST, run the lead's end-to-end check, put the
  evidence in the PR, then the PM approves the merge.
- **Publish (Q3):** publish after the deploy and the e2e check. Have the tarball, its sha256 and the publish commands
  ready together with the deploy request. The owner publishes (npm 2FA); the PM coordinates.

## Branches

| Branch | Head | State |
|---|---|---|
| main | 89d8bce | PRs #1 (spec), #2 (M1 core), #3 (M3 CLI + Claude Code plugin), #4 (CI matrix) merged |
| **m2-server** | **050a693** | **M2 done and reviewed. PR #5 open.** 174 tests; all 6 CI jobs green (ubuntu/macos/windows × Node 22/24). Contains phase 1 (server+page+deploy), phase 2 (metrics, /stats, /healthz, /go/hub), phase 3 (install with your agent, RELEASE/DEPLOYED, sha refs), the spec commit (9c6f933), and a merge of main (PR #4) |
| **m4-mcp** | **12a9e0d** | **M4 done and reviewed, NOT yet rebased onto m2-server.** 121 tests. Local MCP (`grill-me mcp`), the .mcpb, the Codex plugin plus `.agents/plugins/marketplace.json`, README; version 0.1.0. Still to do: see M4 below. No PR yet |
| m4-mcp-wip | (if present) | The M4 worker's wind-down push: its rebase onto 050a693 in progress. Check `git log` before using it; m4-mcp 12a9e0d is the safe base |
| m2-install-wip, m2-server-wip | (if present) | Wind-down pushes from the M2 workers; expected to be empty or absent |
| m2-install | fe6af6a | Superseded: phase 3 before its rebase. Everything is in m2-server. Delete after PR #5 merges |
| spec-3 | 15a98e2 (local only, never pushed) | Superseded: landed in m2-server as 9c6f933 |
| handoff | this file | |

## The version decision (PM agreed)
- One first public release: **0.1.0, containing M2 + M4**. The npm placeholder 0.0.1 is the owner's; 0.1.0 publishes
  on top.
- **Stacking order:** m4-mcp is rebased onto m2-server (050a693, or later), so ONE sha = M2 + M4. That sha is
  deployed, packed into the tarball and e2e-checked.
- **Two PRs:**
  - #5 (m2-server → main) merges first;
  - then the M4 PR (open it with base m2-server, retarget to main with `gh pr edit N --base main` after #5 merges).
- After the e2e check, the PM approves both merges and the publish together.
- Why stacked: the live install guide needs a working npm package the moment the site goes up, and the guide's
  Codex/Desktop sections need M4. Don't publish 0.1.0 and 0.2.0 back to back.

## M4: what's left (the worker was told this; check m4-mcp-wip first)
1. `git rebase origin/m2-server` (base 050a693). Only M4's own commits should replay; m4-mcp contains main's PR #4,
   which m2-server now has via a merge. Expected conflicts:
   - packages/cli/README.md: M2 added a line, M4 deletes the file. Keep the deletion; the root README is the npm page
     and must carry the agent install line.
   - the cli test asserting `mcp` is a placeholder (M4 replaces it);
   - packages/cli/scripts/pack.mjs.
2. Fill site/install.md's "Codex (CLI and the ChatGPT desktop app)", "Codex in VS Code or another IDE" and "Claude
   Desktop" sections EXACTLY from ref\install.md, which already has the `default_tools_approval_mode = "approve"`
   line. "claude.ai and the Claude apps" stays "Coming soon…".
3. Add `default_tools_approval_mode = "approve"` to SPEC.md's Codex config table.
4. Small fix: packages/server/src/install.js renderInstallHtml should split on `/\r?\n/`. A stale CRLF checkout
   renders literal "# Install Grill Me" headings. Production and fresh clones are LF, so this doesn't block anything.
5. `npm test` twice. The install tests check that every command in site/install.md appears exactly once in a
   `<pre><code>` on the homepage. Check that build-static's install.md is byte-identical to site/install.md.
6. `git push --force-with-lease origin m4-mcp` (one force-push authorized for this rebase), then open the M4 PR.

## Open review findings and notes
- **m2-server:** every finding is fixed: the cookie regex; A, a half-built release folder is rebuilt
  (.release-sha is the completion marker); B, the replacer function; C, `types {}`; D, check.sh's `/` check sends a
  browser Accept + UA, and a test now runs the real check.sh against the real server. That last one would have
  failed the first production deploy. Remaining notes:
  - The flaky test `cli.test.js` "expired grill → EXPIRED…" was seen once under load by a worker and not reproduced
    in 5 full runs here. deploy.sh runs the suite on the droplet at nice 19; if it ever fails there, re-running
    deploy.sh rebuilds (fix A).
  - API 404s have an empty body (the M2 brief allows it); check.sh asserts only the status.
  - Polish for later: the homepage install section pushes "How it works" and "Try the demo" well down.
- **m4-mcp:** reviewed (mcp.js, mcp-stdio.js, pack.mjs, the mcpb build, the Codex skill and plugin, README); all
  findings fixed:
  - default_tools_approval_mode "approve" in the plugin .mcp.json and the README config table;
  - GRILL_ME_WAIT_SECONDS is the default AND the cap, clamped to 900, with non-numeric `seconds` → the default;
  - ChatGPT dropped from the README intro;
  - version back to 0.1.0.
- **Verified live (Codex, Windows, codex-cli 0.161.0, isolated CODEX_HOME):**
  - `codex plugin marketplace add hoodoos/grill-me --ref m4-mcp` picks .agents/plugins/marketplace.json, not the
    Claude one;
  - the bare `npx` launch works;
  - the plugin's `env` map is honoured;
  - grill_send → link + QR → answered in Chrome → grill_wait returned the answers.
  Hub memory #1370 has the details.
- **Not verified:** the .mcpb installed inside Claude Desktop. It is covered only by mcpb/test/build.test.js (build,
  unpack, MCP initialize + tools/list). Claude Desktop is installed on pc-win (MSIX), but installing needs its GUI
  dialog.
- **After merge only:** the guide's Codex commands (`codex plugin marketplace add hoodoos/grill-me`) read main, so
  they work only after the M4 PR merges. The Desktop link
  (releases/latest/download/grill-me.mcpb) works only after the GitHub release exists.

## The deploy request the PM expects (send it with the publish package, in one message)
- **sha:** the full 40-hex sha of the rebased m4-mcp tip (M2 + M4).
- **On the droplet, as root:**
  ```
  git clone https://github.com/hoodoos/grill-me.git /root/grill-me-deploy   # first time; later: git -C /root/grill-me-deploy fetch
  cd /root/grill-me-deploy && git checkout <sha>
  bash deploy/deploy.sh <full-sha>
  ```
- **Expected result:**
  - the release's check.sh ends with "ALL CHECKS PASSED", then `DEPLOYED <sha> (<sha>)`;
  - `/opt/grill-me/RELEASE` holds `<sha> <ref> <UTC time>`.
- **Stats token:** `/etc/grill-me/env` is created on the first deploy (`sudo cat /etc/grill-me/env` to read it).
  Never send it around; the authed /stats check runs inside check.sh on the box.
- **If tests fail during the build:** nothing has been switched yet; just re-run deploy.sh (it rebuilds).
- **Rollback:**
  - this is the FIRST deploy, so `bash deploy/rollback.sh --remove` takes Grill Me off the box and restores the
    placeholder site; data is kept unless `--purge-data`;
  - after later deploys, `bash deploy/rollback.sh` returns to the previous release and rewrites RELEASE.
- **What check.sh covers:**
  - the site and security headers;
  - /healthz, /go/hub, /stats auth (login page, 401, 200 with the token);
  - GET / for curl, a browser and text/markdown;
  - /install and /llms.txt as text/plain;
  - the long poll through nginx;
  - www.grill-me.ai unchanged;
  - the neighbours unchanged: cor.ryaboshtan.com, 46-101-88-204.sslip.io, the default certificate, listening ports,
    active units.
- **The lead's production e2e check after the deploy** (its evidence goes in PR #5 and the M4 PR):
  - the CLI from the tarball against https://grill-me.ai: send, answer in the browser, wait;
  - the browser page and its done screen;
  - the long poll through nginx;
  - Claude Code WebFetch on https://grill-me.ai/ and /install (WebFetch refuses localhost, so only production works);
  - curl;
  - a Codex fetch of the guide (it should show the commands and wait for a yes);
  - /healthz;
  - the /stats login page and data.json → 401 without auth.
- **Tarball** (build from the exact deploy sha in a fresh clone):
  ```
  git clone https://github.com/hoodoos/grill-me.git rel && cd rel && git checkout <sha>
  npm ci && npm test
  node packages/cli/scripts/pack.mjs      # → packages/cli/dist/grill-me-ai/grill-me-ai-0.1.0.tgz
  sha256sum packages/cli/dist/grill-me-ai/grill-me-ai-0.1.0.tgz
  ```
  - Smoke test: `npm install -g --prefix <tmp> <tgz>`, then `<tmp>/grill-me --version` prints 0.1.0.
  - A dry run at an earlier M2 sha gave 22 files, no tests, and installed fine.
  - A helper script: C:\Users\octopus\.claude\jobs\46240379\tmp\build-release.sh `<sha>` (job tmp; may be gone).
  - Note: `npx -y <path>.tgz …` silently does nothing (npm treats the path as a command). Use
    `npx -y --package <tgz> grill-me …`.
- **Publish (the owner, after the PM's go):** `npm publish grill-me-ai-0.1.0.tgz --access public --otp <code>`.
- **Desktop extension:** at the same sha, `node mcpb/build.mjs` → mcpb/dist/grill-me.mcpb. Then:
  `gh release create v0.1.0 mcpb/dist/grill-me.mcpb --repo hoodoos/grill-me --target <sha> --title "Grill Me 0.1.0" --notes "<short notes>"`
  This is outward-facing, so get the PM's yes first.
- **Order after the e2e:**
  1. the PM approves;
  2. merge #5, retarget and merge the M4 PR;
  3. npm publish;
  4. the GitHub release.

## Briefs and references (C:\Users\octopus\.agent-hub\workspaces\hub-as-service\ref\)
- M1-BRIEF.md, M2-BRIEF.md (with M2 rules), M2-METRICS.md (phase 2), M2-INSTALL.md (phase 3, incl. §2b RELEASE).
- M3-BRIEF.md, M4-BRIEF.md (local MCP, .mcpb, README), M4B-BRIEF.md (hosted /mcp: next after M2 + M4 merge; not
  started).
- install.md: the exact install-guide text, with the Codex approval line.
- hub-grill-page.txt, hub-grill.mjs, hub-grill-selftest.mjs, design-round1.md (Agent Hub references used for the
  port).
- Hub memories:
  - #1345 design;
  - #1356, #1358 droplet facts (site enabled as zz-grill-me.ai; never default_server);
  - #1363 MCP client timeouts;
  - #1369 Codex setup facts;
  - #1370 Codex MCP approval and plugin facts.

## Local state and fragile spots
- **Worktrees** under C:\Users\octopus\.agent-hub\workspaces\hub-as-service:
  - grill-me (base clone, on spec), grill-me-m1, grill-me-ci;
  - grill-me-m2 (m2-server, phase-2 worker);
  - grill-me-m2i (local branch m2-install, rebased and diverged from origin/m2-install; superseded);
  - grill-me-m3 (m4-mcp, M4 worker; may hold a rebase in progress);
  - grill-me-spec (outgoing lead, on branch handoff/spec-3).
  All the real work is pushed; the m4-mcp-wip branch carries any in-progress M4 rebase.
- **Kimi workers, all told to stop:**
  - M2 phases 1–2: pc-win|kimi|session_16b26cfe-17b8-4799-9763-1f1babee1d1b;
  - phase 3: pc-win|kimi|session_975ac11d-25f9-4975-905a-5efffa625545;
  - M4: pc-win|kimi|session_356b0f53-a2ff-4d3a-bb54-95b3f3ce6471.
- **Housekeeping:** the QR test session pc-win|claude|491faf4e-ac45-4929-8f77-b8a2dad89e05 is done and can be
  archived.
- **Job tmp** (C:\Users\octopus\.claude\jobs\46240379\tmp): review clones and Codex test homes. Copied Codex auth
  files were removed; nothing there is needed.
- **Never published:** no npm 0.1.0 and no GitHub release exist yet. Nothing has been deployed.

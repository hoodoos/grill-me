# Grill Me acceptance checklist

**2026-10-18: 0.1.0 is NOT released. Release, merges and publishing remain on HOLD
for direct Agent Hub UI and interaction parity review and fixes.** This is a checklist
with pending gates, not a statement that the product is ready or acceptance is complete.

## What to test now

Only the **two read-only WebFetch calls in an existing Claude Code session** below are
requested now. No installation, configuration changes, tokens or credentials are needed.
The client matrix and remaining checklists are for release reviewers and testing after a
corrected candidate is deployed; the owner does not need to run every client.

Paste this exact prompt into the existing Claude Code session:

```text
Use WebFetch once for https://grill-me.ai/ and once for https://grill-me.ai/install.
For each URL, quote the actual client installation commands returned by WebFetch and
report the HTTP/tool result. The expected result is the plaintext install guide with
commands. If the tool fails, report the actual failure honestly; do not substitute curl,
another fetch tool, remembered commands or an agreement from this conversation.
Show the returned commands and await my explicit yes before any later installation.
This request authorizes reading only: do not install anything, run the returned commands,
change configuration, or request tokens or npm credentials.
```

**Actual Claude Code WebFetch: PENDING.** A curl or Codex fetch is not WebFetch evidence;
agreement to a prompt is not returned tool output. Record each actual result separately.

## Current evidence and client matrix

Recorded technical evidence belongs to candidate
`624c2b8127ae15861c6d58608c3a50f0385780e8` (2026-10-18), not to later UI changes.
API/CLI/MCP and real mobile-browser checks passed, but these do not prove installation in
each actual client or Hub parity. Changed UI requires fresh browser and parity checks.

**TESTED** means only the named evidence passed. **PENDING** needs the actual client or
reviewer check. **NOT AVAILABLE IN 0.1.0** means the hosted integration is not implemented
in milestones 1–4 (M4b is separate).

| Client/path | Status and limit of evidence |
| --- | --- |
| Standalone CLI | **TESTED** on the exact candidate artifact: CLI/API roundtrip with simulated phone answers. Actual owner phone swipe acceptance **PENDING** after corrected deployment. |
| Claude Code plugin | CLI/background wait, **not MCP**. CLI transport **TESTED**; current actual plugin install, background completion/resumption and WebFetch **PENDING**. |
| Codex CLI/plugin; Codex in the desktop app where the reviewed guide applies | Prior branch-isolated Codex plugin roundtrip **TESTED**. Public/main installation and current real app checks **PENDING**. The desktop app brand does not establish plugin support in an ordinary ChatGPT conversation. |
| Codex IDE local MCP | Actual stdio transport **TESTED**; IDE installation, tool discovery and roundtrip **PENDING**. The IDE extension uses local MCP, not the plugin. |
| Claude Desktop local `.mcpb` | Bundled local MCP transport has technical evidence; actual GUI download/open/install/tool discovery/roundtrip **PENDING**. |
| Other stdio MCP clients | Transport **TESTED**; acceptance for each named client/version **PENDING**. |
| claude.ai / Claude mobile hosted connector | **NOT AVAILABLE IN 0.1.0**: M4b hosted connector is not implemented. |
| ChatGPT web/mobile hosted MCP | **NOT AVAILABLE IN 0.1.0**: M4b is not implemented. This checklist makes no promise of ChatGPT mobile support. |

Other recorded evidence: real Chrome 155, 390 × 844 touch viewport, passed transport,
resume and browser error scenarios with zero page errors; actual Codex guide reading
passed **without installation**. These runs did not establish direct Hub UI parity.
Claude Desktop GUI and owner phone acceptance remain pending. The earlier owner fixture
without recommendations was cancelled; absence of a recommendation can legitimately open
typing mode and is not evidence that a recommendation-bearing right swipe works.

## Release and installation prerequisites

All public client setup commands in the README and the reviewed
[install guide](../site/install.md) are gated on **M4 merged to main and npm
`grill-me-ai@0.1.0` published**. The Claude Desktop latest-download link additionally
requires the GitHub `v0.1.0` release asset. Do not use the public commands, an unversioned
`latest` download, or `npx` against a placeholder package before these gates pass.
After publication, a version-pinned public CLI invocation uses `npx -y grill-me-ai@0.1.0`.
Show installation commands and obtain the user's explicit yes before installing.

Before publication, the release reviewer privately supplies the **exact reviewed** `.tgz`
and `.mcpb`; do not rebuild or substitute another file with the same version number.
The hashes below identify the **HELD 624 candidate**, not corrected release artifacts.
After UI correction, the reviewer must review the new artifacts and replace these hashes
before accepting the corrected candidate; the old hashes do not transfer to a new build.

| HELD 624 candidate artifact | Reviewed SHA-256 |
| --- | --- |
| `grill-me-ai` 0.1.0 `.tgz` | `ba0ee43a75a3fd7b158946b1257f5a49430ea6af594aa314496f2009f8730389` |
| `grill-me.mcpb` 0.1.0 | `d6d4163e1dc2383c5dd9dc50be8aa4f2d165c1f00b62b321aa925377b5491a6e` |

Use Node 22+ for the local CLI/MCP setup. Replace the quoted artifact paths below with
the reviewer's actual absolute paths (forward slashes also work with Node on Windows).
This read-only command prints the hashes; compare both with the table before installation:

```sh
node -e "const fs=require('node:fs'),c=require('node:crypto'); for(const p of process.argv.slice(1)) console.log(c.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),p)" "/absolute/path/grill-me-ai-0.1.0.tgz" "/absolute/path/grill-me.mcpb"
```

After explicit installation consent, from a disposable working directory use a **new,
empty** prefix. This installs the supplied tarball locally, without a global install:

```sh
npm install --prefix "./grill-me-acceptance" --no-save --package-lock=false --ignore-scripts "/absolute/path/grill-me-ai-0.1.0.tgz"
node -e "require('node:fs').accessSync(process.argv[1]); console.log('CLI path exists')" "./grill-me-acceptance/node_modules/grill-me-ai/packages/cli/bin/grill-me.js"
node "./grill-me-acceptance/node_modules/grill-me-ai/packages/cli/bin/grill-me.js" --version
```

Expected version: `0.1.0`. The staged package preserves `packages/cli/bin/grill-me.js`
under the installed package; it is not `bin/grill-me.js` at the package root.
For this private run, use that same installed Node entry point for `send`, `wait`,
`fetch`, `resend` and `cancel`, rather than downloading a public package.

For an isolated local stdio setup, the server launch command is:

```sh
node "/absolute/path/grill-me-acceptance/node_modules/grill-me-ai/packages/cli/bin/grill-me.js" mcp
```

Configure an unused server name in a disposable client profile/configuration after
consent. For Codex, use the reviewed configuration shape with the private entry point:

```toml
[mcp_servers.grill-me-acceptance]
command = "node"
args = ["/absolute/path/grill-me-acceptance/node_modules/grill-me-ai/packages/cli/bin/grill-me.js", "mcp"]
startup_timeout_sec = 60
tool_timeout_sec = 900
default_tools_approval_mode = "approve"
env = { GRILL_ME_WAIT_SECONDS = "840" }
```

Replace the absolute path before use, confirm it exists, and restart the client/extension.
Do not overwrite an existing server table or configuration file. Other stdio clients use
the same `node` command and argument array, with a wait duration below their tool timeout
(the server default is 45 seconds). Do not enable a second copy of the same server in a
client that already has the plugin. Public plugin installation steps remain in the
[reviewed install guide](../site/install.md), subject to the release gates above.

## Disposable phone swipe acceptance after the fix

**PENDING after corrected deployment.** Paste this exact prompt into the selected,
already installed client. Both questions must retain their recommendations. For private
artifact/plugin runs, first prepend the following instruction, replacing the absolute
path with the verified installed entry point:

```text
This is a private artifact acceptance run. Override any skill's public npx instructions:
for every CLI operation invoke node "/absolute/path/grill-me-acceptance/node_modules/grill-me-ai/packages/cli/bin/grill-me.js"
followed by the operation and arguments. Do not run npx or download a public package.
For MCP, use only the server configured with that exact installed Node entry point;
do not start the plugin's public npx server. If unavailable, stop and report it.
```

```text
Use the installed Grill Me to send exactly the two disposable questions below. Show the
returned link on its own line and the returned QR in a code block. Wait through this
client's correct transport: Claude Code uses CLI wait as a background command and resumes
when it exits; a local MCP client uses grill_send then grill_wait, repeating on WAITING.
Return the actual answer lines. Do not carry out any snack/place decision or other real
action after the answers; this is only an acceptance test.

❓ Q1 - Snack drink
Choose a drink for this disposable test.
- **Tea**: a cup of tea.
- **Coffee**: a cup of coffee.
➡️ Tea: a simple test recommendation.

---

❓ Q2 - Place
Choose a place for this disposable test.
- **Indoors**: stay inside.
- **Outdoors**: go outside.
➡️ Indoors: a simple test recommendation.
```

On the phone, **swipe the first card right** to agree. **Swipe the second card left**,
type `production acceptance own answer`, then use Next and Send. Both swipes must be real
finger gestures or Chrome CDP touch sequences; button taps and mouse drags are not swipe
evidence. Record rotation/stamps during the gestures as well as the resulting answers.

The agent must actually receive these exact lines:

```text
Q1 - agree
Q2 - production acceptance own answer
```

For a separate optional choice run, resend the same two questions, agree to Q1 and tap
the **Outdoors** chip on Q2, then Send. Expected lines are `Q1 - agree` and
`Q2 - Outdoors`. This checks choice selection; it does not satisfy the swipe gate.

## Steps for each client being reviewed

Run only the relevant client path, recording its actual version and artifact hash.
Do not ask for WebFetch in a client that does not provide it.

| Path | Reviewer steps after the applicable installation gate/consent |
| --- | --- |
| CLI | Save the exact two-question payload as `questions.md`. Invoke the installed Node entry point with `send questions.md`, display its link and QR, then `wait <id>`. Check the two returned lines and `STATUS: ANSWERS`. Use `fetch <id>` for one check; `cancel <id>` for a discarded run; `resend <id>` only for an expired run. |
| Claude Code plugin | Confirm the installed skill is available. In a private run, apply the prompt prefix above so all skill CLI commands use the exact installed Node entry point, overriding public `npx`. Send the fixture; show link and QR. Run CLI `wait <id>` **in the background**, end the turn, and verify Claude Code resumes with the actual answer lines. If answers arrive in chat instead, stop that background wait and run CLI `cancel <id>`. |
| Codex plugin / Codex IDE / other local MCP | Confirm `grill_send`, `grill_wait` and `grill_cancel` are visible. Send the exact fixture as `text`, show link and QR, then call `grill_wait` with the returned `id`. `WAITING` is normal: repeat with the same `id` until `ANSWERS`. Verify the actual lines. Use `grill_cancel` for a discarded run or answers given in chat. |
| Claude Desktop `.mcpb` | Obtain the exact private bundle and verify its hash/version, or after release download the exact `v0.1.0` asset. Open it, inspect the Install dialog, install only after yes, and restart if the app requests it. Verify all three tools are visible, then run the same MCP two-question roundtrip. Record the GUI/tool evidence; GUI acceptance stays **PENDING** until actually observed. |

For `EXPIRED`, offer a fresh send of the same questions. For `OFFLINE`, retain answers and
use Copy answers or check again when reachable. A successful send on the phone alone does
not prove agent collection: verify the actual agent result and subsequent pickup state.

## Direct browser and Hub parity gate

**Fix and direct review PENDING; this blocks release readiness.** The observed long-body
fixture made standalone content 2433 px tall in an 844 px viewport, with bottom controls
offscreen; Hub kept the viewport contract with internal scrolling. A touch gesture over
a standalone full choice-detail button was excluded from swipe handling, while the same
body gesture advanced the Hub card. Recheck these after the viewport and compact
single-choice-chip fix; preserve safe text rendering and multi-choice behavior.

Compare the **same recommendation-bearing fixture** directly in Hub and standalone,
at **390 × 844**, short **390 × 600**, and desktop **1280 × 800** viewports. Include
viewport and keyboard resizing. Distinguish evidence with an actual software keyboard
from simulated viewport resizing; a simulated resize does not prove keyboard behavior.
Do not claim they are identical until the
baseline comparison is measured. Record the candidate, viewport, gesture coordinates and
timing, expected/actual results and redacted screenshots where useful.

- [ ] Body, recommendation and choices: same content and safe bold/code rendering;
  long descriptions scroll internally and bottom controls stay reachable. Descriptions
  and ordinary card body are swipeable; compact choice chips and other controls are
  excluded from card swipes. Check single-choice and multi-choice independently.
- [ ] Actual finger or Chrome CDP touch sequences: right swipe agrees, left swipe opens
  own-answer typing; visible card rotation and AGREE/MY OWN stamps match the baseline.
  Short drags cancel/reset without an answer. Vertical scrolling produces no answer.
  Test fast flicks on both sides of the measured distance/time thresholds and compare
  with Hub. Button clicks, keyboard actions and mouse drags cannot replace this evidence.
- [ ] Buttons and keyboard remain accessible alongside touch gestures. Test taps on
  chips, own-answer input, Next and other controls without accidental card swipes.
  At each viewport and during viewport/keyboard resize, keep the textarea, Next, bottom
  bar and Copy answers reachable; record actual software-keyboard evidence separately.
- [ ] Skip twice, Undo, Questions/list navigation and summary editing preserve the
  expected question/answer state; copying before and after sending returns the correct
  answer lines.
- [ ] Link fragment is removed after opening; reload resumes; a new ID with the same
  fixture resumes progress. Confirm send failure retains answers and enables retry;
  offline/expiry still allows copying. Verify pickup only after actual agent collection.
- [ ] Rerun the primary phone swipe roundtrip on the corrected candidate and record the
  two exact returned lines. Owner phone acceptance is still pending until this happens.

Record intentional standalone host differences separately from card parity: its done
screen, sent versus picked-up state, Copy answers, local-mode privacy/key handling, and
standalone localStorage progress/resume/expiry behavior. These need their own acceptance;
they are not proof of card interaction parity or grounds to call the whole UI identical.
The safety renderer intentionally stays limited to bold/code and plain, non-clickable
URLs. Matching Hub's unsafe/full HTML or link Markdown rendering is **not** an acceptance
requirement; preserve the safe renderer while comparing layout and interaction.

The Hub baseline is read-only: **no Hub changes** for this work. Keep the baseline harness,
ZIP and screenshots private, outside the public repository. Do not embed or link private
Hub source, whole-page HTML, global CSS, unrelated helpers or bundled baseline source in
this checklist or public fixtures. A public regression may use only public app code and
a scoped grill-only fixture/expected behavior; private comparison can read the local Hub
baseline without copying it into the repository.

## Evidence to return to the release reviewer

- Client name/version, candidate commit, artifact version and SHA-256.
- Actual tool/CLI result (including status), exact expected versus returned answer lines,
  and separate WebFetch results for both URLs when that client provides WebFetch.
- Browser/device/version, viewport, real finger or CDP touch method, gesture results,
  and redacted screenshots as applicable. Keep private Hub baseline evidence private.
- Each gate's TESTED/PENDING/NOT AVAILABLE status; do not promote API or simulated-phone
  evidence into actual installation, touch or parity acceptance.

Redact full grill links, QR contents, URL fragments and keys from reports/screenshots.
No credentials are needed for these acceptance tests. npm token delivery is a separate
publish process: never put an npm token or `STATS_TOKEN` in a phone grill, WebFetch prompt,
transcript or this document. Release remains held until the required review gates pass.

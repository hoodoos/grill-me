# Persistent interview sessions — 0.2.0 contract

This extension starts from main `d1fb2110565426ca450f57ea215cf92e7cd60b92`.
The 0.1.0 one-shot API, crypto vectors, library defaults and CLI commands remain compatible.
The complete pinned Matt Pocock skill and upstream license stay byte-unchanged.

## Identity and retention

A session has one random 16-character id and one 22-character secret throughout the interview.
Its stable link is `/g/<id>?session=2#<secret>`; fragment stripping preserves the query.
There is no global/latest session, implicit cross-agent attachment, history table or history endpoint.
The agent must explicitly supply its known id to publish another frontier round.

Each session has positive integer `round` and monotonically increasing `revision` (safe integers,
maximum 2147483647). The first pending round is round1/revision1. Every state transition increments
revision. The only live states are `pending`, `answered`, `idle`:

`create -> pending -> answered -> idle -> pending(next round) ... -> finish`

The relay stores only the current encrypted grill, any uncollected encrypted answers, authentication
hash, current operation identities/digests and minimal version/expiry metadata. Acknowledgement clears
both ciphertext slots. Next publication replaces current operation metadata; it cannot replace pending
questions or uncollected answers. It never stores readable questions, answers, secrets or round history.
SQLite encrypted remnants are not a promise of secure physical disk erasure.

An authenticated transition refreshes expiry to one hour; reads/polls do not extend retention.
Expiry deletes the session and wakes polls. Finish requires idle; cancel may explicitly abort any state.
Deletion still returns404. A successful finish, explicit cancel, or observed live expiry atomically
records a short-lived receipt with only `id`, `reason` (`finished`, `cancelled`, `expired`) and
`expires_at`, alongside deletion of the current session. Receipts last ten minutes, are pruned by
the sweeper and on insertion, and are capped at10000 rows. They contain no questions, answers,
ciphertexts, key/hash, operation/version data or round history. A same-id replacement atomically
clears the prior receipt. Authenticated mutation conditions and exact winner semantics are unchanged.
Known expiry is recorded even before the sweeper runs. A404 JSON body includes `{error:"gone",reason}`
while a receipt is live; unknown/aged-out IDs remain `{error:"gone"}` without an invented reason.
The phone displays "All done—your agent has finished this grill.", "This grill was cancelled.",
or "This session expired." only for the matching known reason; unknown remains generic.
End receipts need no key, so key/plaintext purge is preserved while reload/reconnect and other open
tabs can still recover the authoritative message. No offline remote-erasure promise is made.
Aggregated daily metrics are allowed, never per-session history. Existing rate/wait/IP caps apply jointly
to legacy and session traffic, including phone update polls and agent answer polls.
Answer-collection waits take priority over passive session-update polls: at capacity, the
relay ends one same-interview view poll early and admits the answer wait within the existing
per-interview and per-IP caps. It never displaces an answer wait or another interview.
This is operation priority, not caller identity inferred from a header. Existing public
encrypted-read and hosted capability-authentication rules remain unchanged. A phone whose
held poll is rate-limited keeps its draft and checks revisions without waiting every1–1.3s,
then retries long polling after10s. Ready answers remain immediately readable regardless
of held-poll capacity; no retry acknowledges them.

## Crypto (new module, legacy unchanged)

Implement `packages/core/src/session.js`, browser-safe and dependency-free. It may import unchanged
legacy crypto/format helpers but must not alter legacy v1 derivation/AAD/vectors. Export through core
index for Node clients; browser imports the new module path directly, never a previously cached index.

- `deriveSessionKeys(secret)`: HKDF-SHA256(empty salt), info `grill-me/v2/enc` (AES256GCM) and
  `grill-me/v2/write` (32byte bearer token and SHA256 hash), same result shape as deriveKeys.
- Random12byte IV per encryption. AAD UTF8 exactly
  `grill-me/session/v2:<id>:<round>:<slot>` with slot `grill` or `answers`.
- `sealRound(grill,{id,secret,round}) -> {ct,iv,writeHash}` / `openRound(blob,ids) -> grill`.
- `sealRoundAnswers(answers,grill,ids) -> {ct,iv}` / `openRoundAnswers(blob,grill,ids) -> answers`.
- Validate ids, secret, round and existing normalized grill/answer schemas/byte limits.
- `makeSessionLink(id,secret,base)` / `parseSessionLink(url)` preserve explicit protocol marker.
- Replays across session ids, round numbers, slots or legacy crypto fail authentication.

## Relay API (existing /api/ and /g/ routing, no nginx change)

`operationId` and `submissionId` are random canonical16character ids, scoped to the current round.
All blobs use existing canonical base64url/size validation. Authentication errors retain legacy401/403.
All state writes recheck authenticated hash/live expiry/current state synchronously after async auth;
conditional SQL changes and wake/count occur only for the winning transition. Shared poll limits include
both channels. Retrying the exact operation is idempotent, not another winner or duplicate metric.

After an authoritative idle/ACK snapshot, the standalone phone shows a decorative shuffling-card
stack and "Your agent is thinking. Keep this page open—your next questions will appear here."
A secondary "Back to Grill Me" link points to `/`; it never navigates automatically. Reduced-motion
uses a static stack. Sent-before-pickup, errors, current questions and terminal screens do not show
the thinking animation. The next frontier replaces it automatically; reconnect first rechecks state.

| Request | Result/conditions |
| --- | --- |
| `POST /api/s` `{id,round:1,operationId,ct,iv,writeHash,qb?}` |201snapshot; exact same current operation/hash/blob retry200snapshot; conflicting id409. Persist local create intent before first upload. |
| `GET /api/s/:id?after=<revision>&wait=<0..50>` |200snapshot immediately if no after or revision differs; otherwise hold then204;404ended. Snapshot `{v:2,id,round,revision,state,expiresAt,operationId,submissionId?,ct?,iv?}`. Current grill ciphertext available pending/answered; none idle. Never readable content or old slots. |
| `POST /api/s/:id/rounds` `{round,expectedRevision,operationId,ct,iv,qb?}` Bearer |201snapshot only from idle with exactrevision and round=current+1; exact same current operation+request retry200snapshot even if current state advanced to answered/idle (keep only current operation digest). Otherwise409. A different request with same operationId409. |
| `POST /api/s/:id/rounds/:round/answers` `{expectedRevision,submissionId,ct,iv}` Bearer |204winner pending->answered; identical saved submission/blob retry200 (no mutation); conflicting/different/stale submission409. Current round required; no cross-round acceptance. |
| `GET /api/s/:id/rounds/:round/answers?wait=<0..50>` |200`{round,revision,submissionId,ct,iv}` if answered;204pending/idle same round;409if different current round;404ended. Agent has local ciphertext replay if relay already acknowledged/deleted. |
| `POST /api/s/:id/rounds/:round/ack` `{expectedRevision,submissionId}` Bearer |204only matching answered round/revision/submission ->idle, erase bothslots. On the same current idle round, only the exact saved expectedRevision/submissionId request retries204; changed version/submission409. A lower round after advancement is separately204no-op and never touches the newerround. |
| `POST /api/s/:id/finish` `{expectedRevision}` Bearer |204delete only idle/exactrevision;409pending/answered/wrongversion. |
| `DELETE /api/s/:id` Bearer |204explicit cancel any state;404alreadyended. |

Idempotency metadata contains ciphertext digests, not retained ciphertext/history after ack.
An exact publish retry matches its originally supplied expectedRevision, round, operationId and blob
digest; it returns current state without incrementing round/revision or overwriting anything.
An exact answer retry similarly matches its original request after ack; after a newer round it409s.
Existing body/creation/response security limits apply. New and old namespaces reject duplicate ids
across both tables so a phone never ambiguously falls back into another protocol.

## Agent library / CLI / MCP

Legacy `send()` and ordinary CLI `send` stay one-shot. Add library `sendRound(input,options)` and
`finish(id,options)`; existing wait/check/cancel detect an explicitly addressed local session record.
Session records are separate from legacy current pending state and identified by protocol v2.

- `sendRound(input,{id?,round?,expectedRevision?,...})`: without id createsround1; with id requires
  explicit next round. Resolve any preceding ack recovery, read the current idle revision and always
  send it as expectedRevision; an optional caller-supplied expectedRevision must match that value.
  (The answered revision returned before async ack is not falsely reported as an acknowledged revision.)
  Persist one exact encrypted
  publication intent (id/key/operation/blob/round) atomically BEFORE request; retry/recovery reuses it.
  Never generate duplicate rounds after a lost reply or overwrite another pending publication/cache.
  An explicit id/round with a saved publication intent resumes that exact request (including initial
  round1); different input is a conflict. If confirmation remains ambiguous after bounded retries,
  expose `PUBLISHING` plus that id/round/link and retry guidance, not a successful-send claim or an
  instruction to create a new session. Never recover through a global/latest-session heuristic.
- CLI `send --session` creates; `send --id ID --round N [--revision V]` publishes on that explicit session.
  `wait/fetch/cancel ID` work for both. Add `finish ID` for idle sessions. No automatic QR.
- MCP `grill_send` adds optional `session:boolean` (defaultfalse for compatibility), `id`, `round`,
  `expectedRevision`. New wrappers explicitly use `session:true`, save returned id/identity and reuse it.
  An id means session reuse, never arbitrary legacy replacement. Add exactly one `grill_finish` tool.
  `grill_wait` may accept explicitround; if omitted use that id's current localrecord, not global latest.
- Session send/wait results include `{id,round,revision,state}` as applicable, stable link/count/expiry
  on send. ANSWERS adds round/revision/submissionId to existing status/answerlines. Idle status is
  `IDLE` with current identity. Next publication uses the post-ack idle revision, not answeredrevision.
  To obtain it, sendRound reads current authenticated local/session state after ensuring recovery ack;
  the model may omit expectedRevision, but cannot omit the explicit reused id/next round.
- Keep full formatted frontier rounds visible in chat. Show stable phone link initially; later rounds
  update the open phone automatically. No new id/key/link, no QR, no automatic attach across agents.
- Preserve complete unchanged upstream skill body in both references and MCP-only instructions.

Collect -> durable encrypted cache -> successful stdout/MCP callback -> round-scoped acknowledgement.
Cache is keyed by session+round and cannot be overwritten/unlinked by a late older acknowledgement.
Do not acknowledge on cancelled/failed output; do not remove recovery in an unconditional finally.
A committed ack with lost response replays the encrypted local cache without requiring old serverdata;
exact ack retry clears only that round. After confirmed ack, retain only idle id/key/currentidentity,
not prior round plaintext. Finish refuses any unconfirmed publication/answer cache. Per-id serialized
mutations and version-aware local writes prevent stale async cleanup from clobbering the next round.
This protection covers independent CLI/MCP processes sharing a state home, not only a process-local
Promise map: use an interprocess mutation lock and/or atomic version/file conflict detection. Persist
the original acknowledgement expectedRevision and submissionId for exact retries after a lost reply.
The successful output callback durably marks that cached delivery before attempting ACK. Only that
mark permits a later send to retry cleanup automatically. An unmarked cache must first be replayed
through wait/fetch and successfully output; publication cannot acknowledge undelivered answers.
All bounded MCP paths include sleeps/fetch/body/output/ack in their original deadline/signal. Unbounded
CLI polling remains supported. Output does not block on cleanup; next send resolves ack recovery first.

## Browser state / transport cache / UI

Use a unique new entry module `/entry-020.js`: dispatch `?session=2` to new `/session-app.js`; legacy
routes import the compatible one-shot `/app.js` adapter. HTML points to the new entry path. New session app imports the new
`/core/session.js` directly, avoiding cached0.1 `/app.js`/coreindex. Entry query alone is insufficient to
invalidate relative imports. Require warm0.1 cache ->0.2 in SAME browser context with no cacheclear/hardreload.
Card geometry, CSS and gesture thresholds remain unchanged. Answer-correctness fixes now bind
each delayed swipe to its original card, briefly lock overlapping answer actions during commit,
and cancel gesture/focus timers on destroy. Partial multi-choice selections are part of the
current-round draft and are restored when editing an existing answer. Changed shared UI/state,
legacy adapter and session-entry URLs are versioned together to avoid warm stale modules.
Phone and embedded hosts supply the wire budget to the shared UI: no more than4000characters
per own answer, and8192bytes for the complete encrypted answer object (including its16byte
GCM tag). Preflight checks use UTF8 JSON bytes, preserve all text and selections, and ask the
user to shorten an oversized answer before any POST. Copy answers remains available on the phone.

Only current session key, currentround/grill/unconfirmed draft and exact encrypted outgoing submission
intent are retained locally under session+round identity, not contentHash. Identical questions in a
later round start unanswered. Key survives reload during a live session;3day expiry bounds abandoned
local state. Current offline unconfirmed draft remains usable, including Copy answers.

Confirmed winning submission clears local readable grill/draft/answers and old mounted DOM; wait on
state changes. A different submission winning409 must say another device answered, never claim local
answers were delivered; retain unsent current draft only until ack/advance, then purge it. Unknown/lost
response reuses same submissionId/blob and inspects state; do not silently submit a fresh ciphertext.
An ambiguous outgoing submission freezes its saved draft and answer digest. A later edited retry is
refused with recovery guidance, rather than silently sending the old ciphertext as the edited answer.
Idle page waits and automatically mounts next round. Never replace a current unconfirmed draft with
another round unless relay state proves previous submission/ack; reject unexpected contradictory state.

Generation guards AFTER every asynchronous decrypt/hash/fetch/onChange prevent stale roundN work from
rendering or recreating storage afterN+1/purge. Cancel old polls/mount callbacks on transition; use
bounded fetch/poll retry and reload/online/visibility recovery. On observed finish/404/expiry purge
session local plaintext/key and show generic ended/expired. Offline browsers cannot be remotely erased;
do not claim otherwise. No round history is displayed or retained.

## Required proof

Legacy vectors/routes/CLI/deadline/delivery tests remain green. Add v2 domain/round/slot replay rejection;
real HTTP concurrent publish/answer/ack/finish/auth-window races and exactly-once metrics/wake;
idempotent operation/digest mismatch and lost-reply recovery; current-only storage; cache/delivery/
cancel/ack-loss and stale local cleanup races. Actual browser: same link round1->waiting->round2,
reload/reconnect/current draft, identical text newround reset, late async purge safety, swipes/mobile350,
conflicting submission guidance, finish and warm oldcache transition. No owner phone fixture or production
access. Reviewer must get source, raw proof and a PR, followed by one pinned deployment request.

### Running the actual-browser regression

`packages/server/test/session-browser.test.js` is opt-in: provide an installed Playwright-compatible
`playwright-core` module and Chrome. Set `GRILL_ME_BROWSER_TEST=1`,
`GRILL_ME_PLAYWRIGHT_MODULE=file:///absolute/path/to/playwright-core/index.mjs` and optionally
`GRILL_ME_BROWSER_EXECUTABLE` to the Chrome executable, then run:

```sh
node --test packages/server/test/session-browser.test.js
```

The pinned 0.1 base commit must exist locally. The test uses the actual relay and library, real CDP
touch, and a single browser context/origin with ordinary HTTP caching. It proves warm legacy graph
reuse and new module fetches without cache clearing or browser request routing. Further cases cover
API-offline reload/draft recovery, immutable outgoing retry, a losing device's copy after reload,
same-browser stale tab callbacks, delayed actual WebCrypto/gesture callbacks, and finish/cancel purge.
The 350px viewport is simulated resizing, not physical software-keyboard evidence. Reload retains
an unconfirmed own-answer draft; reopen the own-answer form to continue editing it.

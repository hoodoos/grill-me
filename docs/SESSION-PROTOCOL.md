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
Deletion returns404 thereafter: the phone says "Session ended or expired", not invented finish success.
Aggregated daily metrics are allowed, never per-session history. Existing rate/wait/IP caps apply jointly
to legacy and session traffic, including phone update polls and agent answer polls.

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

| Request | Result/conditions |
| --- | --- |
| `POST /api/s` `{id,round:1,operationId,ct,iv,writeHash,qb?}` |201snapshot; exact same current operation/hash/blob retry200snapshot; conflicting id409. Persist local create intent before first upload. |
| `GET /api/s/:id?after=<revision>&wait=<0..50>` |200snapshot immediately if no after or revision differs; otherwise hold then204;404ended. Snapshot `{v:2,id,round,revision,state,expiresAt,operationId,submissionId?,ct?,iv?}`. Current grill ciphertext available pending/answered; none idle. Never readable content or old slots. |
| `POST /api/s/:id/rounds` `{round,expectedRevision,operationId,ct,iv,qb?}` Bearer |201snapshot only from idle with exactrevision and round=current+1; exact same current operation+request retry200snapshot even if current state advanced to answered/idle (keep only current operation digest). Otherwise409. A different request with same operationId409. |
| `POST /api/s/:id/rounds/:round/answers` `{expectedRevision,submissionId,ct,iv}` Bearer |204winner pending->answered; identical saved submission/blob retry200 (no mutation); conflicting/different/stale submission409. Current round required; no cross-round acceptance. |
| `GET /api/s/:id/rounds/:round/answers?wait=<0..50>` |200`{round,revision,submissionId,ct,iv}` if answered;204pending/idle same round;409if different current round;404ended. Agent has local ciphertext replay if relay already acknowledged/deleted. |
| `POST /api/s/:id/rounds/:round/ack` `{expectedRevision,submissionId}` Bearer |204only matching answered round/revision/submission ->idle, erase bothslots. Same already-acked round, or lower round after advancement,204no-op; never touch newerround. Wrong current submission/version409. |
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
All bounded MCP paths include sleeps/fetch/body/output/ack in their original deadline/signal. Unbounded
CLI polling remains supported. Output does not block on cleanup; next send resolves ack recovery first.

## Browser state / transport cache / UI

Use a unique new entry module `/entry-020.js`: dispatch `?session=2` to new `/session-app.js`; legacy
routes import unchanged `/app.js`. HTML points to the new entry path. New session app imports the new
`/core/session.js` directly, avoiding cached0.1 `/app.js`/coreindex. Entry query alone is insufficient to
invalidate relative imports. Require warm0.1 cache ->0.2 in SAME browser context with no cacheclear/hardreload.
No CSS/gesture changes: use existing mountGrill and hard viewport/touch styling unchanged.

Only current session key, currentround/grill/unconfirmed draft and exact encrypted outgoing submission
intent are retained locally under session+round identity, not contentHash. Identical questions in a
later round start unanswered. Key survives reload during a live session;3day expiry bounds abandoned
local state. Current offline unconfirmed draft remains usable, including Copy answers.

Confirmed winning submission clears local readable grill/draft/answers and old mounted DOM; wait on
state changes. A different submission winning409 must say another device answered, never claim local
answers were delivered; retain unsent current draft only until ack/advance, then purge it. Unknown/lost
response reuses same submissionId/blob and inspects state; do not silently submit a fresh ciphertext.
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

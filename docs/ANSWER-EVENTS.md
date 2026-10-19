# Answer-ready continuation contract (task264)

The phone stays on the same interview page. A committed answer wakes a capable host;
that host reads and retains answers, acknowledges the exact receipt, recomputes Matt's
design-tree frontier, and publishes the next round on the same link. Final shared-
understanding confirmation is another phone round. No "answered" or "done" chat nudge.

## Protocol and authorization

`/mcp` supports legacy2025 initialization/SDK clients unchanged and modern MCP2.0
`2026-07-28`: per-request `_meta` version/client capabilities, matching protocol/method/
name headers, `resultType: complete`, server identity metadata and `server/discover`.
Modern discovery advertises `tools` and `events`. No transport connection is an identity.

`events/list` advertises `grill.answers_ready`, webhook delivery, input `{link}` where
link is the existing private capability. Subscribe/unsubscribe follow the published
event-method shape: `{name, arguments:{link}, delivery:{mode:"webhook",url,secret?},
ttlMs?,cursor?}`. Possession is checked transiently; only the derived authorization
digest persists. Initial registration can precede round1 during the10-minute capability
preparation lease. An existing session must have the same authorization digest.

One active destination per session (a different destination conflicts until unsubscribe).
Subscription identity is deterministic over capability principal, canonical destination,
event and session. TTL is finite, maximum1hour; refresh retains identity. `cursor:null`,
no historical replay. Current uncollected answers are caught up atomically at registration.
ChatGPT callback verification sends a signed fresh random challenge and requires an exact
constant-time echo on2xx. Verification failure never activates or replaces a subscription.
Replacement secrets retain the previous key for5minutes and sign with both during rotation.

Grok uses `grill_subscribe`/`grill_unsubscribe` hosted tools with the same private link,
webhook URL/secret, and a `contextReference` to a durable host-owned interview checkpoint.
No verification POST is sent to Grok: its202 trigger does not implement challenge echo,
and registration must not trigger a paid run. Registration is explicitly unverified
receiver configuration. Before registering, save the capability, full Matt workflow and
design tree in the automation's durable host context. Every fresh Grok run must read that
checkpoint, collect the indicated current answers, write the updated tree/answers back,
then supply `contextReceipt:{reference,revision}` to `grill_ack`. Reference must match;
checkpoint revision must advance for a new ACK. Exact lost-ACK retries keep the same
receipt. This is a host checkpoint attestation, not server verification of Grok's storage.
If the account cannot read/update durable context with tools, automatic Grok continuation
is unavailable: do not ACK, claim old-chat resume, or discard answers. Receiver delivery
and actual account/model/context continuity are distinct acceptance results.

## Durable current-only state

`event_subscriptions`: opaque ID, session ID, authorization digest, provider, encrypted
callback configuration, secret-rotation deadline, finite expiry and prepared/bound state.
The sealed configuration contains callback URL/signing keys and, for Grok, context
reference/current checkpoint revision and exact latest ACK checkpoint digest. No interview
body, questions, answers, phone secret/link or design tree is stored here.

`event_outbox`: subscription ID, stable opaque event ID (keyed over subscription/winner), session ID, round/revision/
submission ID, occurrence time, expiry, attempts/next attempt/lease/delivered state. At
most one current event per subscription/round. Winning answer CAS and outbox enqueue
commit in one SQLite transaction; losers/retries enqueue nothing. Register-vs-answer
catch-up uses the same write transaction. ACK removes that current outbox entry; finish,
cancel, expiry and unsubscribe remove subscription/outbox metadata. No round history.

Callback configuration is AES256GCM-sealed under a separate32-byte server key, generated
atomically with0600 inside the existing0700 DATA directory. The key and SQLite/WAL must
survive restart/rollback and remain host-only. Losing a key with existing subscriptions
is an explicit startup error, never silent configuration replacement. In-memory tests
use an ephemeral key. Existing frozen0.2 artifacts remain byte-identical.

## Delivery and bounds

Body `{eventId,name:"grill.answers_ready",timestamp,data:{sessionId,round,revision,
submissionId},cursor:null}` has no instructions, link, keys or answer plaintext. Standard
Webhooks HMAC signs exact body bytes with stable event ID, fresh Unix timestamp per
attempt, `webhook-id`, `webhook-timestamp`, `webhook-signature`, and subscription header.
2xx marks callback delivered only, never acknowledges the answer. At-least-once delivery
can duplicate after an interrupted response; consumers deduplicate by event ID and use
idempotent wait/ACK/publish.410/413 stop retrying; transient errors retry with bounded
exponential backoff (maximum8attempts, bounded by subscription/session expiry).

Maximum1000 subscriptions/outbox rows,4outbound connections,10-second connection/body
deadline,8KB response cap,4KB event cap; subscription/challenge attempts are rate-limited.
Callbacks must be HTTPS443, no credentials/fragment, public globally routable IPs only.
Resolve all addresses at every connection, reject any non-public result, pin the selected
validated address and preserve the original TLS hostname. No redirects, ambient proxy,
cookies or arbitrary capability fetching. Apply identically to challenge and delivery.
No URL/secret/body/exception logging or evidence export; aggregate counters only.

Hosts without wake support retain efficient45/50-second waits: make the phone link
visible before waiting, repeat WAITING while the host keeps its turn alive. Long polling
does not wake an already-ended host turn. Never ask for a manual chat nudge.

## Sources and acceptance boundary

- https://developers.openai.com/plugins/build/mcp-events.md (same subscribed ChatGPT
  Work chat, MCP2.0 discovery/events/signed callbacks; account/workspace controls apply)
- https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://docs.x.ai/grok/automations/webhooks (Standard Webhooks,202 accepted only)
- https://x.ai/news/grok-automations (each run is fresh, saved instructions/current data)

Local real receiver+Chrome proof is not actual provider/model acceptance. No account
setup, paid model calls or owner phone fixture is needed for implementation verification.

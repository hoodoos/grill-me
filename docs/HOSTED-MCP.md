# Hosted interview protocol (M4b)

Endpoint: `https://grill-me.ai/mcp`, authless stateless Streamable HTTP. No MCP session
identifier or local pending files. The private phone link is the capability; accept only
the exact own-origin `/g/<16-char-id>?session=2#<22-char-secret>` form. Never fetch a
model-supplied URL. App mode handles keys/questions/answers transiently on the server;
only the existing encrypted current-round relay persists content. Local mode is unchanged.

1. `grill_start({})` returns `PREPARED`, `link`, `round:1`, `expectedRevision:0`.
   The result also includes the complete unchanged Matt skill in `grillingInstructions`
   and literal text content. Read it BEFORE drafting questions: some app hosts do not
   expose `initialize.instructions` to their model. The tool description summarizes the
   design tree/frontier, recommendations, fact-finding and shared-understanding rules.
   It creates no relay row. Retain this capability BEFORE publishing. If this allocation
   reply is lost, no questions have been published and allocating another is harmless.
   Preparation is valid for10minutes before first publication (`publishBefore`). Its
   issue time is encoded in the existing opaque id, not retained in a preparation table.
   Once published, ordinary refreshed1hour session expiry applies. A very late first-round
   retry cannot recreate a dead interview after its10minute end receipt has been pruned.
2. `grill_send({link,round,expectedRevision,grill? | text?,title?})` publishes a frontier.
   Prefer the original numbered question/➡️ recommendation text format. Equivalent structured
   input remains supported; hosted publishing rejects questions without recommendations.
   Show its complete questions, then “Grill it on your phone” and the link. All rounds
   reuse this link. First round uses revision0; later rounds require the current idle
   revision. Never replace pending questions or uncollected answers.
3. `grill_wait({link,round,seconds?})` uses immediate SSE headers/comments; default45s,
   maximum50s, including preparation/decryption. `WAITING` repeats with the same arguments.
   `ANSWERS` includes answer lines and `receipt:{round,expectedRevision,submissionId}`.
   Merely returning/writing these answers NEVER acknowledges or clears them.
4. Only AFTER the model receives and retains those answer lines,
   `grill_ack({link,receipt})` clears that round's ciphertexts. Keep the ORIGINAL receipt
   for an exact lost-reply retry. `ACKNOWLEDGED` includes the current round/revision/state.
   A late old-round ACK cannot mutate a newer round. Unacknowledged answers can be read again.
   Its result reminds the model to recompute the next frontier and continue the interview
   on the same link, rather than asking permission merely to continue the requested grilling.
5. Publish the next frontier with the same link, next round and idle revision. After Matt's
   shared-understanding confirmation, `grill_finish({link,expectedRevision})` requires idle
   state; pending/uncollected content conflicts. `grill_cancel({link})` explicitly aborts.
   `ENDED` returns only a known terminal reason or `unknown`, never invented success.

Publish idempotency: canonical normalized input is MACed using the derived write capability
and domain `grill-me/hosted/publish/v1`, binding session, round, ORIGINAL expected revision
and full normalized questions. The opaque16-character operation identity is persisted by
the existing relay; plaintext/key are not. An exact retry first checks that authenticated
operation snapshot. Concurrent identical calls may produce different random AES nonces;
the losing write rechecks the winning operation identity and returns that same snapshot.
Different questions/revision/round cannot overwrite it. AES-GCM and v2 AAD remain unchanged.
No network stdout callback is treated as proof of model receipt: explicit ACK is required.

Separate bounded in-memory hosted quotas:600new sessions/hour,200concurrent waits;
30new sessions/hour/conversation when `params._meta["openai/session"]` is a bounded string.
Only a SHA256 conversation digest is kept in memory. No platform-wide per-IP quota applies;
the existing per-session waiter cap still applies and is shared with phone/local polls.
Private stats expose headroom and aggregate rejection counts, never capabilities/arguments.

Origin allowlist (when present):`https://claude.ai`, `https://chatgpt.com`,
`https://grill-me.ai`. POST requires both JSON and event-stream Accept types, JSON content,
bounded body/strict JSON-RPC; GET/DELETE405, notifications202, no batch/session transport.
Client response closure aborts work and frees waiters. Errors never echo tool names,
unknown methods, arguments, exception text or links. Only outer `/mcp` status/latency is
logged. Exact nginx location disables access/error logs, rejects query parameters,
proxies with response AND request buffering off, HTTP1.1,32KB client body buffer,
`client_body_in_file_only off`,15s body inactivity timeout and75s upstream timeout.
The Node upload reader also has a15s wall deadline and32KB cap, drains oversized bodies
and rejects malformed UTF8. This prevents plaintext/key request bodies spooling to nginx
temporary files. Other locations remain unchanged.

Hosted tool definitions/instructions are server-only. The complete pinned original Matt
skill is read unchanged into initialize instructions; the first512characters contain the
essential hosted delivery/ACK workflow. Local core/CLI/plugin files and frozen0.2 artifacts
remain byte-identical; website/deployment source binding advances independently.

Actual Claude/ChatGPT account setup and model behavior require separate observation after
deployment. SDK/HTTP/Chrome tests establish transport/phone behavior, not account support.

## Current official setup references (checked2026-10-19)

- [ChatGPT custom MCP guide](https://developers.openai.com/api/docs/guides/custom-mcp-server)
  and [plugin quickstart](https://developers.openai.com/plugins/quickstart): ChatGPT web,
  Plugins → plus → Add custom MCP server → No authentication → Create as a plugin.
  Install the personal plugin, use a new Work chat and select it with `@`. Account/workspace
  policies apply. Do not infer ChatGPT mobile/desktop or a particular plan from this.
- [Claude custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp):
  Customize/Settings → Connectors → Add custom connector, URL `/mcp`, No sign in.
  Individual/workspace controls differ. Requests come from Claude's cloud across web,
  Desktop and mobile; local Desktop stdio is a different mode.
- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

Custom connection only: no public-directory submission. No npm publish prerequisite for
the hosted endpoint. Actual app-account connection/tool selection remains separately
unverified until observed; no model API key or paid API call is used for transport tests.

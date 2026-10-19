# Hosted swipe cards (MCP Apps)

This additive, stateless hosted transport uses the existing shared cards, CSS, gestures
and session encryption. Local CLI/stdio tools and the phone page are unchanged.

After `grill_start` and a successful `grill_send`, the agent can call the separate
read-only `grill_show({link})` render tool. Its `_meta.ui.resourceUri` identifies one
immutable, self-contained `text/html;profile=mcp-app` resource. The URI and HTML have
no interview link/key. The completed tool result carries the private view capability
only in `_meta["ai.grill-me/view"]`; model-facing text has a same-phone-link fallback.
Input/partial notifications do not mount cards. Repeated results do not reset a draft.

The catalog explicitly marks start/send/wait/ACK/finish/cancel/subscription/show as
`visibility:["model"]`. Only `grill_ui_state` and `grill_ui_submit` are
`visibility:["app"]`. The host MUST enforce this catalog boundary when proxying view
tool calls. Metadata is not authentication; every operation also authenticates the
existing private session capability. The widget cannot collect/ACK through its allowed
tools. Stateless legacy hosts may ignore UI metadata and retain the normal phone link;
there is no remembered initialization session, user-agent guess or new MCP session ID.

App tools:

- `grill_ui_state({link,afterRevision?,seconds?})`: authenticated current encrypted
  snapshot, or bounded wait (default/max25 seconds), `STATE`, `WAITING`, or `ENDED`.
- `grill_ui_submit({link,round,expectedRevision,submissionId,ct,iv})`: the existing
  exact single-winner CAS. Returns `SUBMITTED` only for the winner or its exact retry;
  a different loser returns `CONFLICT`. Never ACKs.

The view uses the official MCP Apps SDK2.0.3 and host bridge exclusively: no direct API,
CDN, nested iframe, arbitrary network or persistent browser history. Current plaintext,
draft and capability are memory-only in this open view, purged on confirmed submission,
advance and terminal state; re-opening can recover the current encrypted round, but an
unsubmitted draft does not survive destruction of the iframe. Same-revision snapshots
preserve the draft, and asynchronous work is generation-guarded with retired mount nodes.
The exact sealed submission intent is retained for uncertain POST retries, never resealed.

After authenticated submission success, or when its authenticated current-state poll
observes an `answered` snapshot from the phone/another view, a host supporting `message.text` receives
`ui/message` with a text-content ARRAY containing fixed continuation instructions and
round/submission metadata, no key/questions/answers. Rejection (including resolved
`isError:true`) remains retryable. Acceptance is NOT model receipt or ACK. Lost replies
can produce at-least-once follow-ups; per-view intent deduplication and relay CAS protect
rounds, not a claim of globally exactly-once model processing. The agent still waits,
reads/retains, explicitly ACKs the original receipt, and publishes the next frontier.
The notice identifies the actual server-confirmed winning round/submission, independently
of the view's own sealed submit intent. Own-submit success and its snapshot share that
notice. A losing view keeps its explicit non-delivery copy; it may request collection
of the actual winner, never claim its losing answers were delivered. The current-only
notice is purged on ACK/advance/end; no round history is introduced. Host message latency
does not block the state poll, and a late response cannot suppress a newer round's notice.
After rendering the first inline view, the agent ends its turn instead of blocking in
`grill_wait`. A submitted-answers UI follow-up gets one `grill_wait({seconds:1})` read;
after read/retain/ACK and the next publish it yields again, keeping the same view.
Unexpected `WAITING` does not authorize an inline polling loop, ACK or replacement round.
Phone polling is a separate active-turn path. Automatic phone wake requires a host that
supports it and a successfully registered subscription; advertising events does not
establish one. Neither a queued UI message nor an absent subscription proves that a
provider will resume the model. This workflow correction does not establish actual
provider scheduling, iframe lifetime or model adherence.

This phone-to-host bridge requires the inline view to remain alive and expose
`message.text`. A closed view or unsupported host still needs an actual registered
host wake; this is not a durable subscription by itself. Already-open older resource
versions do not gain this bridge after a server upgrade. Refresh the connector's tool
catalog/resource and reopen the SAME saved interview view only if the old view is gone
or has no unsubmitted draft. Never allocate a replacement session to recover uncollected
answers, or discard a partial draft merely to refresh the view.

Actual `ui/initialize` capabilities determine bridge/message/display-mode support.
Both fixed container height and maxHeight are honored; the unchanged560px card remains
inside a full-width bounded swipe stage. Unsupported hosts get the existing phone path.
ChatGPT and Claude document MCP Apps support; Grok inline rendering remains UNVERIFIED.
SDK/sandbox tests do not establish actual account/model behavior or hardware acceptance.

The compiled HTML includes the actual LICENSE/NOTICE files for every bundled dependency
as inert nonrendered JSON, plus retained inline legal comments. This includes the SDK's
mixed Apache/MIT transition text rather than inferring a license from its manifest.

The public compiled template is cached once/process. Resource reads are limited to four
in flight, sixty/minute globally, with ten-second slow-reader cutoff. Private server
dependencies are pinned; none of the frozen29 published payload bytes are changed.

References: [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview),
[ChatGPT UI](https://developers.openai.com/plugins/build/chatgpt-ui). The installed
official2.0.3 schemas/types govern the content-array message and host capability contract.

## Current-only event timestamp correction

The relay retains `sessions.ans_at` only while the current winning answer is uncollected.
It is set atomically with answer CAS and cleared by ACK/advance/deletion. Catch-up after
unsubscribe/resubscribe uses that same occurrence time, so stable event ID means stable
body. A migrated already-answered row without a recorded time gets one first-observed
timestamp, never a round history or additional ciphertext/plaintext retention.

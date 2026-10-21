# Timeouts and resuming an interview

If the agent stops waiting or the next round does not arrive, type **Resume Grill Me** in
**the same agent chat**. The phone page and embedded cards have **Timeout & resume** help.
An open, message-capable widget can send that request with **Resume interview**. A host
accepting the request is not proof that it ran the model. If rejected or unavailable,
copy the resume message or type it in the chat. A closed widget cannot wake the agent.

| Integration | Our answer-wait budget | Recovery after it ends |
| --- | --- | --- |
| Hosted phone / Grok without cards | 45 seconds per call by default, at most 50 | Use the saved link; type **Resume Grill Me** if the host stops polling. |
| Embedded cards | No active agent answer-wait while you answer; the submission follow-up reads once for 1 second | Use **Resume interview** or type the command. Bridge requests are bounded at 30 seconds and follow-up confirmation at 15 seconds. |
| Codex plugin | 840 seconds (14 minutes) per call, inside its configured 900-second tool budget | Type the command in the same chat. |
| Claude Desktop bundle | 180 seconds per call | Type the command in the same chat. |
| Generic local MCP | 45 seconds by default; the tool advertises the configured limit | The send result shows the default; a timed-out read shows the effective selected duration. |
| Background CLI | No fixed total wait timeout; network polls last at most 50 seconds | Resume with `npx -y grill-me-ai fetch <saved-id>`; the agent uses the result to continue. |

These are **our budgets**, not a guarantee of a provider's turn lifetime. A host can stop
or remove a view earlier. Successful relay polling does not establish that the model is
still listening. A wait timeout does not delete questions or answers.

The relay retains pending questions for **one hour after publication** and uncollected
answers for **one hour after submission**. Collection refreshes the idle interview for
one hour. Opening/reloading/polling a page does not extend this. The phone and widget help
show the current server expiry when available. Only a server response establishes that
an interview ended; a device clock never invents expiry.

On resume, the agent first checks for saved answers. It retains real answers before normal
acknowledgement. A pending round keeps its link, question numbers and partial draft.
An idle interview continues from answers already in the agent's conversation. Only after
expiry may the agent resend the last unanswered frontier from that conversation on a
fresh link. The expired page cannot automatically follow the new link. Missing context
must be requested, never invented; an explicitly finished/cancelled interview stays ended.
A new embedded view cannot inherit an old view's memory-only draft: copy it before closing
an otherwise live view. A normal phone reload preserves its current local draft.

**Copy answers** is a manual fallback, not an acknowledgement. It copies current committed
answers plus unfinished text/choice drafts. After a successful phone submission, copying
uses the saved current encrypted question and encrypted submission intent; submitted
plaintext is not persisted. Those encrypted recovery records are cleared on collection,
advance or explicit end. The widget's own current answer copy is memory-only. If expiry is
observed, an available current draft/copy is kept only in that open page's memory so it can
be copied; the key and local storage are purged immediately. That last recovery copy is
lost on close/reload, and no interview history or additional server retention is added.

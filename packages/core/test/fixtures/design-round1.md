I've read tasks #19 and #18, the code, and both grilling skill copies. Shared memory had nothing about grilling, swipes or the review loop; the searches only returned unrelated records. Three things in the code change the draft in #19:
- **Drafts only live in page memory.** If the phone app reloads or Android closes it, they're lost.
- **Notifications always open the home page.** If the app is already open, tapping one only brings it to the front.
- **Codex questions can lose answers.** When one Codex request asks several questions, a tap replies to the whole request with only that one answer.

---

❓ Q1 - How the hub spots a grilling

Nothing reads agent messages for questions today. There are three ways to do it:
- **Parse the text you already see.** A question starts on a line beginning with "❓ Q<number>", and its recommendation is the line beginning with "➡️". The parser accepts small variations: bold or not, "-" or ":" after the number. It works on every grilling already in your transcripts and adds nothing to the terminal or the Claude app. If an agent drifts from the format, the button just doesn't appear and a normal reply still works.
- **A structured block.** Agents add a fenced JSON block (ids, titles, bodies, recommendations, options) to the end of the message. It's exact, but it repeats the whole message, clutters the terminal and the Claude app, and agents forget it or break the JSON about as often as they drift from a text format.
- **Both,** with the block preferred and the text as a fallback. That means two formats to keep working.

➡️ Parse the text only, with variations allowed, and keep the parser in one place with tests built from real grillings. The button appears whenever the last message has at least one "❓ Q<n>" question with its body. No JSON block.

---

❓ Q2 - Getting the full message (shared with the review loop's Forward button)

Each machine cuts the last message of a Claude or Codex session at 6000 characters before sending it to the hub. A 10-question grilling runs 6–10K. The review loop's "Forward to…" button (task #18) needs the same full text. Three options:
- **Raise the limit,** for example to 30K. It's a one-line change, but every report, every few seconds, then carries every session's long message.
- **Fetch on demand.** A new machine command returns the full last message, served through one hub endpoint that Forward also uses. Opening the screen costs the same kind of round trip as Send, and it fails if the machine is offline.
- **Send the full text only when it changes,** stored by the hub apart from the card text. There's no wait, but it needs the most new code.

➡️ Fetch on demand through one shared endpoint, limited to about 200K, and cache it in the browser for that message. Cards keep the 6000-character text. If the machine is offline, the screen opens on the shortened text and says that later questions may be missing.

---

❓ Q3 - Where the way in appears

Cards appear in Needs you (when a session is "finished · your turn") and in the project tree. A "finished" notification always opens the home page, or just brings an already open app to the front. Notifications for work sessions carry no names or content.

➡️ When the session is idle and its last message has questions, the card everywhere gets a "❓ 9 questions" chip and a main "Answer questions" button. The button is hidden while the session is working or waiting for an approval. For such a message, the "finished" notification says "Claude has 9 questions: <title>" (just the count for work sessions), and tapping it opens the swipe screen for that session directly. If the app is already open, the service worker tells it which session to open.

---

❓ Q4 - Gestures, accidental swipes, Undo and skipping

A card can hold a long body you scroll, Android's edge-swipe means Back, and one wrong flick shouldn't cost an answer.

➡️
- **Swipes:** a swipe counts past about 35% of the card width, or past about 20% if flicked fast. Anything shorter springs back. The card tilts and shows "AGREE" or "MY OWN" as you drag, with a short vibration at the threshold.
- **Scrolling vs swiping:** the first ~10 px decide the direction. Mostly vertical means the body scrolls; mostly horizontal means a swipe.
- **Edges:** the card keeps clear of the screen edges so Android's Back gesture doesn't fire. Android Back closes the screen and keeps your progress.
- **Swipe left:** the card turns into a text box with the recommendation still visible, and the keyboard opens. "Next" saves the answer. Leaving it empty leaves the question unanswered.
- **Buttons:** ✓ and ✗ do the same as the swipes. Undo is always visible, goes back as many steps as you like, and brings the earlier card back with your answer filled in.
- **Skip:** a button, not a gesture. A skipped card moves to the end once. If it's still skipped at the summary, it's sent as "Qn - skip for now, ask again later" so the agent never reads silence as agreement.

---

❓ Q5 - Questions with several options instead of one recommendation

Many questions list choices in the body, and some have no ➡️ at all. Three options:
- **Treat the body as plain text:** right accepts the ➡️, left means typing.
- **Make choices tappable:** choice lines in the body become chips on the card.
- **Fix the shape in the skill** so those choice lines are reliable.

➡️ Do the second and third together:
- **Skill:** choices are written as bullets, each starting with a short bold name, never lettered.
- **Card:** the choices show as chips. Tapping one answers "Qn - <name>" and moves on. Right still accepts the ➡️; left still means typing, which is also how you add "<name>, but…".
- **No ➡️:** the card has no right swipe and opens with the chips and the text box.
- **Multi-select:** no special handling, since typing covers it.

---

❓ Q6 - Codex's own structured questions, and Claude's AskUserQuestion

When Codex asks for input, its questions arrive structured: id, header, options and "other" allowed. Today they show as buttons on the card. When one request asks two or more questions, one tap sends the reply for the whole request with only that question answered. Claude's AskUserQuestion shows on the card but can't be answered from the hub at all. Only the Claude app or the terminal can answer it.

➡️ Codex requests with two or more questions open the same swipe screen:
- Options show as chips.
- "Other" is the left swipe.
- An option labelled "(Recommended)" counts as the ➡️.
- Send replies once with every answer.

Requests with one question keep the buttons on the card, and multi-question requests lose them, which fixes the lost answers. Claude's AskUserQuestion stays as it is, with no answering from the hub.

---

❓ Q7 - The summary and Send

You often type "agree with all" after the first few questions. The message has to read like what you type today.

➡️
- **Agree to the rest:** every card has this button. It marks the remaining questions "agree" and jumps to the summary.
- **Summary:** one row per question ("Q3 · Title — agree"). Tapping a row reopens that card. An optional "Anything else" box goes at the end.
- **The message:** Send posts one message, one line per question, in your format: "Q1 - agree", "Q2 - <your text>", "Q3 - <choice name>", "Q4 - skip for now, ask again later", followed by the extra text.
- **Claude terminal sessions:** they continue in a background copy, as with today's Send. The summary says so before you send.
- **After Send:** the screen closes, the card shows "sent", and the saved progress is cleared.

---

❓ Q8 - The session moves on while you're answering, and saved progress

The screen works from a snapshot of the last message. Meanwhile, you might reply from the terminal or another device, a Codex turn might run, or a new message might arrive. Today's drafts survive closing the dialog but not a reload or Android closing the app.

➡️
- **Saved progress:** stored on the device, keyed by session plus a fingerprint of the message (time, length and hash). Reopening resumes where you left off.
- **Send check:** Send carries the fingerprint, and the hub refuses it if the session's last message has changed or the session is working.
- **If it moved on:** the screen shows "The session moved on (new message at 14:32)" with "Copy answers" and, only if the session is idle, "Send anyway". It never steers a running Codex turn.
- **Cleanup:** saved progress for an old message is dropped after 3 days.

---

❓ Q9 - On the desktop

Pointer events make mouse dragging work anyway. The question is whether the desktop needs more.

➡️ Same screen, with the card centred at about 480 px wide. Keyboard:
- → agree
- ← your own answer (focuses the text box)
- S skip
- Ctrl+Z, or Backspace when not typing: undo
- Enter: Next, or Send on the summary
- Esc: close and keep progress

Key hints show only with a mouse. No separate desktop list form, since the summary already is the overview.

---

❓ Q10 - Changing the grilling skill

The format only exists in the grilling skill, as identical copies in ~/.claude/skills/grilling and ~/.codex/skills/grilling on this PC. WSL (work) and the MacBook have their own copies. The skill already asks a whole round at once with a ➡️ each, but it holds back questions that depend on unanswered ones. That's why grillings drag over several rounds, and why you asked for "all 9 remaining questions in one go".

➡️ Rewrite it as follows, and copy the same file to all four places:
- **One message:** every question at once, about 12 at most. A question that depends on another still gets asked, with a recommendation consistent with the others. Follow-ups only for unclear answers or newly opened branches.
- **Fixed shape:** a "❓ Qn - <title>" line, then a self-contained body (choices as bold-named bullets, nothing that points to another document), then a final "➡️" line. Questions are separated by "---", and every question gets a ➡️.
- **Numbering:** continues across rounds (Q11, Q12…), so answers are never ambiguous.
- **How answers come back:** "Qn - agree" means the ➡️, "Qn - <name>" picks a choice, and "Qn - skip for now" means ask again later. Anything else is your own answer.

---

❓ Q11 - How we test it on your phone

➡️ Four steps:
1. **Parser self-test:** a self-test script like the existing tools/*-selftest.mjs, built from real grillings: today's B105, Tree of Savior and B101 messages, plus this message. It includes bold and plain variants, a message cut at 6000, and messages with choices and no ➡️.
2. **Demo:** "/?grill=demo" opens the screen on a built-in sample, and Send only shows the text it would post. You try the gestures in the installed app on the Xiaomi with gesture navigation on, at no risk.
3. **One real round each:** a throwaway Claude background session and a Codex session in a scratch folder grill you on a made-up topic, plus one Codex request with two questions. Answer from the phone over the tailnet and check the message arrives intact.
4. **Usage events:** names only, never content: open, right, left, chip, skip, undo, agree-to-rest, send, abandon. After a week the coordinator can check the time saved and how often you hit Undo.

---

Answer like "Q1 - agree, Q3 - …". I'll ask follow-ups only where an answer is unclear. Then I'll summarise the rulings, update task #19's notes (keeping the evidence) and save the decisions to shared memory. Nothing gets built until you say go.

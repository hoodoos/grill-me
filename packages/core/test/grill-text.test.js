// Every parseGrill/DEMO_TEXT assertion from the hub's grill self-test, ported 1:1 (one test() per block,
// same inputs, same expected values). Only the grillOf/structuredQuestions checks are left out.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseGrill, DEMO_TEXT } from "../src/grill-text.js";

const round1 = fs.readFileSync(new URL("./fixtures/design-round1.md", import.meta.url), "utf8");

// A real round (11 questions, the user's "❓ Qn - title" format, separators after every question).
test("design round", () => {
  const g = parseGrill(round1);
  assert.ok(g.questions.length === 11 && g.questions.map((q) => q.n).join() === "1,2,3,4,5,6,7,8,9,10,11", "11 questions numbered 1–11");
  assert.ok(g.questions[0].title === "How the hub spots a grilling" && g.questions[10].title === "How we test it on your phone", "titles");
  assert.ok(g.questions[0].options.join("|") === "Parse the text you already see|A structured block|Both", "bold-named bullets become choices");
  assert.ok(g.questions[0].rec.startsWith("Parse the text only") && g.questions[0].rec.endsWith("No JSON block."), "one-line recommendation");
  assert.ok(g.questions[3].rec.startsWith("- **Swipes:**") && g.questions[3].rec.includes("- **Skip:**"), "recommendation that is a list under a bare ➡️");
  assert.ok(g.questions[8].rec.includes("Key hints show only with a mouse"), "recommendation with a second paragraph (up to the separator)");
  assert.ok(g.questions[2].options.length === 0 && g.questions[5].options.length === 0, "no choices where the body has none");
  assert.ok(!g.questions[0].body.includes("➡️ Parse") && g.questions[0].body.startsWith("Nothing reads agent messages"), "body stops before the recommendation");
  assert.ok(g.outro.startsWith("Answer like") && g.intro.startsWith("I've read tasks"), "intro and outro kept apart");
});

// The old skill format: bold number and title, body starting on the header line, no separator after the last one.
test("old format", () => {
  const g = parseGrill(`Round one.

❓ **Q1** - **Storage engine**: Do we keep SQLite or move to Postgres?

Postgres means a server to run.

➡️ Keep SQLite.

---

❓ **Q2** - **Auth**: Tokens or cookies?

➡️ Cookies.`);
  assert.ok(g.questions.length === 2 && g.questions[0].title === "Storage engine" && g.questions[1].title === "Auth", "old format: bold titles");
  assert.ok(g.questions[0].body.startsWith("Do we keep SQLite") && g.questions[0].body.includes("a server to run"), "old format: body starts on the header line");
  assert.ok(g.questions[0].rec === "Keep SQLite." && g.questions[1].rec === "Cookies." && g.outro === "", "old format: recommendations");
});

// Drift.
test("drifted headers and recommendations", () => {
  const g = parseGrill(`**❓ Q1 - Bold whole line**
Body one.
**➡️ Do this**
---
### ❓ Q2: Heading style
Body two.
> ➡️ Quoted recommendation
---
❓ **Q3 - Bold title only**
➡️ **Bold** start stays bold
---
- ❓ Q4 — Em dash in a list
➡️Tight arrow
---
❓Q12. Continued numbering
➡ Arrow without the emoji selector`);
  assert.ok(g.questions.map((q) => q.title).join("|") === "Bold whole line|Heading style|Bold title only|Em dash in a list|Continued numbering", "drifted headers");
  assert.ok(g.questions.map((q) => q.rec).join("|") === "Do this|Quoted recommendation|**Bold** start stays bold|Tight arrow|Arrow without the emoji selector", "drifted recommendations");
  assert.ok(g.questions[4].n === 12, "numbering continues across rounds");
});

// No recommendation, and lookalikes inside code.
test("lookalikes inside code", () => {
  const g = parseGrill(`❓ Q1 - Your words
Tell me in your own words.
---
❓ Q2 - With an example
\`\`\`
❓ Q9 - not a question
➡️ not a recommendation
---
\`\`\`
➡️ The real one.
---
Thanks.`);
  assert.ok(g.questions.length === 2 && g.questions[0].rec === null && g.questions[0].body === "Tell me in your own words.", "question without ➡️");
  assert.ok(g.questions[1].rec === "The real one." && g.questions[1].body.includes("❓ Q9 - not a question"), "❓/➡️/--- inside a code block are body text");
  assert.ok(g.outro === "Thanks.", "outro after the last separator");
});

// The last question without a closing separator: the recommendation ends where a plain paragraph starts.
test("unclosed last question", () => {
  const g = parseGrill(`❓ Q1 - Last one
Body.
➡️ Do these:
- one
- two

Answer like "Q1 - agree".`);
  assert.ok(g.questions[0].rec === "Do these:\n- one\n- two" && g.outro === 'Answer like "Q1 - agree".', "unclosed last question stops before the closing line");
});

// Unnumbered one-off questions are numbered in order, but only when nothing in the message is numbered.
test("unnumbered question", () => {
  const g = parseGrill(`Before I continue:

❓ **Texel density** (texture pixels per metre of world). Higher looks sharper, costs memory.

➡️ 256 px/m.`);
  assert.ok(g.questions.length === 1 && g.questions[0].n === 1 && g.questions[0].title === "Texel density" && g.questions[0].rec === "256 px/m.", "unnumbered question");
  assert.ok(parseGrill("❓ Q1 - Numbered\n➡️ yes\n---\n❓ **Loose** aside\n➡️ no").questions.length === 1, "a loose ❓ line beside numbered ones isn't a question");
});

// Not a grilling.
test("not a grilling", () => {
  assert.ok(parseGrill("Done. ❓ Questions? None. ➡️ Next: deploy.").questions.length === 0, "❓ in prose isn't a question");
});

// Cut messages (collectors keep the first 6000 characters): a partial count.
test("cut message", () => {
  const n = parseGrill(round1.slice(0, 6000)).questions.length;
  assert.ok(n >= 4 && n < 11, `cut message: partial count (${n})`);
});

// The built-in demo.
test("demo grilling parses", () => {
  const g = parseGrill(DEMO_TEXT);
  assert.ok(g.questions.length === 4 && g.questions[1].options.length === 3 && g.questions[3].rec === null && g.questions[1].rec === "Follow the phone.", "demo grilling parses");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { convert, fromGrillText, fromAskUserQuestion, fromCodex, fromNumbered, DEMO_TEXT, GRILL_SCHEMA } from "../src/index.js";

const round1 = fs.readFileSync(new URL("./fixtures/design-round1.md", import.meta.url), "utf8");

test("fixture: 11 questions with choices, details and recommendations", () => {
  const r = convert(round1);
  assert.ok(r.ok, r.error);
  assert.equal(r.source, "grill-text");
  assert.equal(r.grill.questions.length, 11);
  const q1 = r.grill.questions[0];
  assert.deepEqual(q1.choices, [
    { name: "Parse the text you already see", detail: 'A question starts on a line beginning with "❓ Q<number>", and its recommendation is the line beginning with "➡️". The parser accepts small variations: bold or not, "-" or ":" after the number. It works on every grilling already in your transcripts and adds nothing to the terminal or the Claude app. If an agent drifts from the format, the button just doesn\'t appear and a normal reply still works.' },
    { name: "A structured block", detail: "Agents add a fenced JSON block (ids, titles, bodies, recommendations, options) to the end of the message. It's exact, but it repeats the whole message, clutters the terminal and the Claude app, and agents forget it or break the JSON about as often as they drift from a text format." },
    { name: "Both", detail: "with the block preferred and the text as a fallback. That means two formats to keep working." },
  ]);
  assert.ok(!q1.body.includes("**Parse the text you already see**"), "choice bullets leave the body");
  assert.ok(q1.body.startsWith("Nothing reads agent messages"));
  assert.equal(q1.recommend.choice, null); // the rec names no single choice
  assert.ok(q1.recommend.why.startsWith("Parse the text only"));
  // Q4's recommendation is a list under a bare ➡️, kept whole as `why`.
  const q4 = r.grill.questions[3];
  assert.equal(q4.recommend.choice, null);
  assert.ok(q4.recommend.why.startsWith("- **Swipes:**") && q4.recommend.why.includes("- **Skip:**"));
  // Questions without choices stay without choices.
  assert.deepEqual(r.grill.questions[2].choices, []);
  assert.deepEqual(r.grill.questions[5].choices, []);
});

test("demo: recommendation matches a choice name", () => {
  const r = convert(DEMO_TEXT);
  assert.ok(r.ok, r.error);
  assert.equal(r.grill.questions[1].recommend.choice, "Follow the phone");
  assert.equal(r.grill.questions[1].recommend.why, "Follow the phone.");
  assert.equal(r.grill.questions[3].recommend, null);
});

test("old format converts", () => {
  const r = convert(`Round one.

❓ **Q1** - **Storage engine**: Do we keep SQLite or move to Postgres?

Postgres means a server to run.

➡️ Keep SQLite.

---

❓ **Q2** - **Auth**: Tokens or cookies?

➡️ Cookies.`);
  assert.ok(r.ok, r.error);
  assert.equal(r.source, "grill-text");
  assert.equal(r.grill.questions[0].title, "Storage engine");
  assert.deepEqual(r.grill.questions[0].recommend, { choice: null, why: "Keep SQLite." });
});

test("drifted format converts", () => {
  const r = convert(`**❓ Q1 - Bold whole line**
Body one.
**➡️ Do this**
---
### ❓ Q2: Heading style
Body two.
> ➡️ Quoted recommendation`);
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.grill.questions.map((q) => q.title), ["Bold whole line", "Heading style"]);
  assert.equal(r.grill.questions[1].recommend.why, "Quoted recommendation");
});

test("grill text: choice continuation lines join the detail and leave the body", () => {
  const r = convert(`❓ Q1 - Pick one
Some context.
- **Alpha**: first option.
  more about alpha
- **Beta**: second option.

➡️ Alpha.`);
  assert.ok(r.ok, r.error);
  const q = r.grill.questions[0];
  assert.deepEqual(q.choices, [
    { name: "Alpha", detail: "first option. more about alpha" },
    { name: "Beta", detail: "second option." },
  ]);
  assert.ok(!q.body.includes("Alpha") && q.body.includes("Some context."));
  assert.deepEqual(q.recommend, { choice: "Alpha", why: "Alpha." });
});

test("grill text that fails validation stands (no falling through)", () => {
  const r = convert(`❓ Q1 - Pick one
- **Alpha**: x
- **alpha**: y

➡️ Alpha.`);
  assert.equal(r.ok, false);
  assert.match(r.error, /duplicate choice/i);
  assert.ok(r.schema);
});

const askPayload = {
  questions: [
    {
      question: "Which scope?",
      header: "Scope",
      multiSelect: false,
      options: [
        { label: "Only the hub (Recommended)", description: "Keep it small." },
        { label: "Everything", description: "All projects." },
      ],
    },
    {
      question: "Which colours?",
      multiSelect: true,
      options: [
        { label: "Red", description: "Warm." },
        { label: "Green" },
      ],
    },
  ],
};

test("AskUserQuestion payload (Recommended marker, multiSelect)", () => {
  const r = convert(askPayload);
  assert.ok(r.ok, r.error);
  assert.equal(r.source, "ask-user-question");
  const [q1, q2] = r.grill.questions;
  assert.equal(q1.title, "Scope");
  assert.equal(q1.body, "Which scope?");
  assert.deepEqual(q1.choices, [
    { name: "Only the hub", detail: "Keep it small." },
    { name: "Everything", detail: "All projects." },
  ]);
  assert.deepEqual(q1.recommend, { choice: "Only the hub", why: "" });
  assert.equal(q1.multi, false);
  assert.equal(q2.title, "Which colours?");
  assert.equal(q2.body, "");
  assert.equal(q2.multi, true);
  assert.equal(q2.choices[1].detail, "");
});

test("AskUserQuestion JSON as text and tool-call wrappers", () => {
  const asText = convert(JSON.stringify(askPayload));
  assert.ok(asText.ok && asText.source === "ask-user-question");
  const wrappedInput = convert({ input: askPayload });
  assert.ok(wrappedInput.ok && wrappedInput.source === "ask-user-question");
  const wrappedArgs = convert({ arguments: askPayload });
  assert.ok(wrappedArgs.ok && wrappedArgs.source === "ask-user-question");
});

test("Codex payload: object and string options", () => {
  const r = convert({
    questions: [
      { id: "q1", header: "H1", question: "Pick one?", options: [{ label: "Yes (Recommended)", description: "do it" }, "No"] },
      { id: "q2", question: "Free text?", options: [], isOther: true },
    ],
  });
  assert.ok(r.ok, r.error);
  assert.equal(r.source, "codex");
  const [q1, q2] = r.grill.questions;
  assert.deepEqual(q1.choices, [
    { name: "Yes", detail: "do it" },
    { name: "No", detail: "" },
  ]);
  assert.deepEqual(q1.recommend, { choice: "Yes", why: "" });
  assert.equal(q1.multi, false);
  assert.deepEqual(q2.choices, []);
  assert.equal(q2.recommend, null);
});

test("Codex isSecret refuses the whole conversion", () => {
  const r = convert({
    questions: [
      { id: "q1", question: "Pick one?", options: ["a", "b"] },
      { id: "q2", question: "Token?", isSecret: true },
    ],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "secret questions can't be sent to a phone");
  assert.ok(r.schema);
});

test("internal-format JSON as text, fenced and unfenced", () => {
  const grill = { v: 1, title: "T", questions: [{ n: 4, title: "Q?", choices: ["a", { name: "b", detail: "d" }] }] };
  const plain = convert(JSON.stringify(grill));
  assert.ok(plain.ok, plain.error);
  assert.equal(plain.source, "structured");
  assert.equal(plain.grill.title, "T");
  assert.equal(plain.grill.questions[0].n, 4);
  assert.deepEqual(plain.grill.questions[0].choices, [{ name: "a", detail: "" }, { name: "b", detail: "d" }]);
  const fenced = convert("```json\n" + JSON.stringify(grill, null, 2) + "\n```");
  assert.ok(fenced.ok && fenced.source === "structured");
  const bareFence = convert("```\n" + JSON.stringify(grill) + "\n```");
  assert.ok(bareFence.ok && bareFence.source === "structured");
});

test("structured object input passes through validation", () => {
  const r = convert({ questions: [{ title: "Q?" }] });
  assert.ok(r.ok && r.source === "structured");
  assert.equal(r.grill.questions[0].n, 1);
  const bad = convert({ questions: [{ body: "no title" }] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /title/);
  assert.ok(bad.schema);
});

test("numbered markdown with and without bold names", () => {
  const plain = convert(`1. Which database?
- SQLite: no server to run
- Postgres — more features
- MySQL`);
  assert.ok(plain.ok, plain.error);
  assert.equal(plain.source, "numbered");
  assert.deepEqual(plain.grill.questions[0].choices, [
    { name: "SQLite", detail: "no server to run" },
    { name: "Postgres", detail: "more features" },
    { name: "MySQL", detail: "" },
  ]);
  const bold = convert(`2. **Deploy where?**
- **DigitalOcean**: existing server.
- **Fly.io** – managed.`);
  assert.ok(bold.ok, bold.error);
  assert.equal(bold.grill.questions[0].title, "Deploy where?");
  assert.deepEqual(bold.grill.questions[0].choices, [
    { name: "DigitalOcean", detail: "existing server." },
    { name: "Fly.io", detail: "managed." },
  ]);
});

test("numbered markdown: recommended marker and ➡️ line", () => {
  const marked = convert(`1. Pick a colour?
- Red
- Blue (Recommended)`);
  assert.ok(marked.ok, marked.error);
  assert.deepEqual(marked.grill.questions[0].recommend, { choice: "Blue", why: "" });
  const arrow = convert(`1. Pick a colour?
- Red
- Blue
➡️ Blue, because it matches.`);
  assert.ok(arrow.ok, arrow.error);
  assert.deepEqual(arrow.grill.questions[0].recommend, { choice: "Blue", why: "Blue, because it matches." });
});

test("numbered markdown: question mark alone qualifies, long names get cut", () => {
  const r = convert(`1. Ship it?
Some body text.`);
  assert.ok(r.ok, r.error);
  assert.equal(r.grill.questions[0].body, "Some body text.");
  const long = convert(`1. Pick?
- ${"x".repeat(90)}
- short`);
  assert.ok(long.ok, long.error);
  assert.equal(long.grill.questions[0].choices[0].name.length, 78); // 77 + …
  assert.equal(long.grill.questions[0].choices[0].detail, "x".repeat(90));
});

test("a numbered list of steps is not a grill", () => {
  const r = convert(`1. Clone the repo
2. Install dependencies
3. Run the tests`);
  assert.equal(r.ok, false);
  assert.ok(r.schema);
});

test("grill text wins over numbered markdown in the same text", () => {
  const r = convert(`❓ Q1 - Grill question
Body.
➡️ Yes.

1. Not a numbered question
2. Just steps here`);
  assert.ok(r.ok, r.error);
  assert.equal(r.source, "grill-text");
  assert.equal(r.grill.questions.length, 1);
});

test("31 questions fail", () => {
  const questions = Array.from({ length: 31 }, (_, i) => ({ title: `Q${i + 1}?` }));
  const r = convert({ questions });
  assert.equal(r.ok, false);
  assert.match(r.error, /at most 30/);
});

test("nothing matching fails with the schema", () => {
  const r = convert("just some prose, no questions here");
  assert.equal(r.ok, false);
  assert.equal(r.schema, GRILL_SCHEMA);
  assert.match(r.error, /Accepted formats/);
});

test("title option overrides the grill title", () => {
  const r = convert(DEMO_TEXT, { title: "  My grill  " });
  assert.ok(r.ok, r.error);
  assert.equal(r.grill.title, "My grill");
  const cleared = convert({ title: "T", questions: [{ title: "Q?" }] }, { title: "" });
  assert.ok(cleared.ok && cleared.grill.title === undefined);
});

test("converters return null when they find no questions", () => {
  assert.equal(fromGrillText("no questions"), null);
  assert.equal(fromAskUserQuestion({ questions: [] }), null);
  assert.equal(fromCodex({}), null);
  assert.equal(fromNumbered("1. a step\n2. another step"), null);
});

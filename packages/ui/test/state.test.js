import { test } from "node:test";
import assert from "node:assert/strict";
import { createState } from "../src/state.js";

const grill = () => ({
  v: 1,
  title: "Design",
  questions: [
    { n: 10, title: "Pick one", body: "body", choices: [{ name: "A", detail: "a detail" }, { name: "B", detail: "" }], recommend: { choice: "A", why: "because" }, multi: false },
    { n: 11, title: "Pick several", body: "", choices: [{ name: "X", detail: "" }, { name: "Y", detail: "" }, { name: "Z", detail: "" }], recommend: null, multi: true },
    { n: 12, title: "Free text", body: "", choices: [], recommend: null, multi: false },
  ],
});

test("opens on the first card; a question with no recommendation opens in the text view", () => {
  const s = createState(grill());
  assert.equal(s.state.view, "card");
  assert.equal(s.state.pos, 0);
  s.agree(); // Q10
  assert.equal(s.state.view, "text"); // Q11 has no recommendation
});

test("agree answers with the recommendation and advances past it", () => {
  const s = createState(grill());
  s.agree();
  assert.deepEqual(s.state.answers[0], { kind: "agree" });
  assert.equal(s.state.pos, 1);
});

test("agree is a no-op without a recommendation", () => {
  const s = createState(grill());
  s.jump(2);
  s.agree();
  assert.equal(s.state.answers[2], null);
});

test("choose commits one name; multi commits an array", () => {
  const s = createState(grill());
  s.choose("B");
  assert.deepEqual(s.toAnswers().answers[0], { n: 10, kind: "choice", choice: "B" });
  s.choose(["X", "Z"]); // Q11, now current
  assert.deepEqual(s.toAnswers().answers[1], { n: 11, kind: "choice", choice: ["X", "Z"] });
});

test("own commits trimmed text; empty text is not an answer", () => {
  const s = createState(grill());
  s.jump(2);
  assert.equal(s.state.view, "text");
  assert.equal(s.own("   "), false);
  assert.equal(s.state.answers[2], null);
  assert.equal(s.own("  my words "), true);
  assert.deepEqual(s.toAnswers().answers[2], { n: 12, kind: "own", text: "my words" });
});

test("a skipped card moves to the end once; skipped again it is answered skip", () => {
  const s = createState(grill());
  s.skip(); // Q10 → end
  assert.deepEqual(s.state.order, [1, 2, 0]);
  assert.deepEqual(s.state.skipped, [0]);
  assert.equal(s.state.pos, 0);
  s.skip(); // Q11 → end
  s.skip(); // Q12 → end
  assert.deepEqual(s.state.order, [0, 1, 2]);
  s.skip(); // Q10 again: answered skip
  assert.deepEqual(s.state.answers[0], { kind: "skip" });
  assert.equal(s.state.pos, 1);
});

test("skipping the only remaining card answers it", () => {
  const s = createState(grill());
  s.agree();
  s.own("two");
  s.skip(); // last card: no "move to the end"
  assert.deepEqual(s.state.answers[2], { kind: "skip" });
  assert.equal(s.state.view, "summary");
});

test("the last card is the summary; unanswered questions are sent as skip", () => {
  const s = createState(grill());
  s.agree();
  s.own("two");
  s.skip();
  assert.deepEqual(s.toAnswers(), {
    v: 1,
    answers: [
      { n: 10, kind: "agree" },
      { n: 11, kind: "own", text: "two" },
      { n: 12, kind: "skip" },
    ],
  });
});

test("undo goes back any number of steps and shows what you had", () => {
  const s = createState(grill());
  s.agree();
  s.own("two");
  assert.equal(s.state.view, "text"); // Q12, no recommendation
  assert.equal(s.undo(), true); // back to Q11
  assert.equal(s.state.pos, 1);
  assert.equal(s.state.answers[1], null);
  assert.deepEqual(s.state.hint, { i: 1, a: { kind: "own", text: "two" } });
  assert.equal(s.undo(), true); // back to Q10
  assert.equal(s.state.pos, 0);
  assert.equal(s.state.answers[0], null);
  assert.deepEqual(s.state.hint, { i: 0, a: { kind: "agree" } });
  assert.equal(s.undo(), false); // nothing left
});

test("undo restores the swipe order after a skip", () => {
  const s = createState(grill());
  s.skip();
  assert.deepEqual(s.state.order, [1, 2, 0]);
  s.undo();
  assert.deepEqual(s.state.order, [0, 1, 2]);
  assert.deepEqual(s.state.skipped, []);
});

test("jumping from the summary returns to the summary after answering", () => {
  const s = createState(grill());
  s.agree();
  s.choose(["X"]);
  s.skip(); // summary
  assert.equal(s.state.view, "summary");
  s.jump(1); // reopen Q11
  assert.equal(s.state.view, "text"); // no recommendation
  s.own("actually this");
  assert.equal(s.state.view, "summary");
  assert.deepEqual(s.toAnswers().answers[1], { n: 11, kind: "own", text: "actually this" });
});

test("the list toggles with the view it came from", () => {
  const s = createState(grill());
  s.toggleList();
  assert.equal(s.state.view, "list");
  s.toggleList();
  assert.equal(s.state.view, "card");
  s.agree(); s.own("x"); s.skip(); // summary
  s.toggleList();
  assert.equal(s.state.view, "list");
  s.toggleList();
  assert.equal(s.state.view, "summary");
});

test("jumping from the list comes back to the list's origin", () => {
  const s = createState(grill());
  s.agree(); s.choose(["X"]); s.skip(); // summary
  s.toggleList(); // list, from summary
  s.jump(0);
  s.choose("B"); // re-answer Q10
  assert.equal(s.state.view, "summary");
  assert.deepEqual(s.toAnswers().answers[0], { n: 10, kind: "choice", choice: "B" });
});

test("snapshot round trip: a saved state resumes where you stopped", () => {
  const s = createState(grill());
  s.skip();
  s.setDraft("half typed");
  const snap = s.snapshot();
  const r = createState(grill(), snap);
  assert.deepEqual(r.state.order, s.state.order);
  assert.deepEqual(r.state.skipped, s.state.skipped);
  assert.equal(r.state.pos, s.state.pos);
  assert.equal(r.state.drafts[1], "half typed");
  assert.equal(r.state.view, s.state.view);
  assert.deepEqual(r.toAnswers(), s.toAnswers());
});

test("a snapshot at the summary reopens on the summary", () => {
  const s = createState(grill());
  s.agree(); s.own("x"); s.skip();
  const r = createState(grill(), s.snapshot());
  assert.equal(r.state.view, "summary");
});

test("answering drops the draft for that card", () => {
  const s = createState(grill());
  s.jump(2);
  s.setDraft("typed");
  s.own("typed");
  assert.equal(s.state.drafts[2], undefined);
});

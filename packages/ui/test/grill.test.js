import { test } from "node:test";
import assert from "node:assert/strict";
import { mountGrill } from "../src/grill.js";
import { createDocument } from "../test-support/dom.js";

const grill = { v: 1, questions: [{ n: 1, title: "Choose", body: "", choices: [], recommend: null, multi: false }] };
const saved = { answers: [{ kind: "own", text: "Keep this answer" }], order: [0], pos: 1, skipped: [] };

function cardRoot(t) {
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => fn();
  t.after(() => {
    if (previous) globalThis.requestAnimationFrame = previous;
    else delete globalThis.requestAnimationFrame;
  });
  return createDocument().createElement("div");
}

test("real single-choice rendering keeps descriptions in safe body content and compact chips select/undo", async (t) => {
  const root = cardRoot(t);
  const detail = "**Readable** `code` <img src=x onerror=alert(1)> https://example.com";
  const ui = mountGrill(root, {
    grill: { v: 1, questions: [{ ...grill.questions[0], recommend: { choice: "First", why: "First works" }, choices: [{ name: "First", detail }, { name: "Second", detail: "Other explanation" }] }] },
  });
  const chips = root.querySelectorAll(".gm-chip");
  assert.deepEqual(chips.map((b) => b.textContent), ["➡️ First", "Second"]);
  assert.ok(chips.every((b) => b.querySelector(".gm-choice-detail") === null));
  const context = root.querySelector(".gm-choice-context");
  assert.equal(context.parentElement.className, "gm-scroll");
  assert.equal(context.querySelectorAll("li").length, 2);
  assert.equal(context.querySelector(".gm-choice-detail").querySelector("strong").textContent, "Readable");
  assert.equal(context.querySelector("code").textContent, "code");
  assert.ok(context.textContent.includes("<img src=x onerror=alert(1)> https://example.com"));
  assert.equal(root.querySelector("img"), null);
  assert.equal(root.querySelector("a"), null);
  assert.equal(root.querySelectorAll(".gm-choice-detail").length, 2, "descriptions appear once");
  await chips[1].click();
  assert.deepEqual(ui.answers().answers, [{ n: 1, kind: "choice", choice: "Second" }]);
  await root.querySelectorAll("button").find((b) => b.title === "Undo").click();
  // Undo exposes the previous choice as a hint; selecting it again and jumping back
  // from the summary exposes its persisted selected state.
  await root.querySelectorAll(".gm-chip")[1].click();
  await root.querySelector(".gm-qrow").click();
  assert.equal(root.querySelector(".gm-chip.on").textContent, "Second");
});

test("real multi-choice rendering retains detail rows, toggles, and explicit Next", async (t) => {
  const root = cardRoot(t);
  const ui = mountGrill(root, {
    grill: { v: 1, questions: [{ ...grill.questions[0], multi: true, choices: [{ name: "First", detail: "First explanation" }, { name: "Second", detail: "Second explanation" }] }] },
  });
  assert.equal(root.querySelector(".gm-choice-context"), null);
  const rows = root.querySelectorAll(".gm-choice");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector(".gm-choice-detail").textContent, "First explanation");
  await rows[0].click();
  await rows[1].click();
  await rows[0].click();
  assert.equal(root.querySelector(".gm-send"), null, "toggling does not advance");
  await root.querySelector(".gm-multi-next").click();
  assert.deepEqual(ui.answers().answers, [{ n: 1, kind: "choice", choice: ["Second"] }]);
});

for (const [label, error, expected] of [
  ["network abort", new DOMException("The request was aborted", "AbortError"), "Send failed. Your answers are still here — try again, or use Copy answers."],
  ["expired 404", Object.assign(new Error("gone"), { status: 404, userMessage: "This grill expired or was picked up. Use Copy answers below and paste them into your agent's session." }), "This grill expired or was picked up. Use Copy answers below and paste them into your agent's session."],
]) {
  test(`real mountGrill: ${label} renders a visible note, retains answers, and retries successfully`, async () => {
    const root = createDocument().createElement("div");
    let rejectSend;
    const firstSend = new Promise((_, reject) => { rejectSend = reject; });
    const received = [];
    const ui = mountGrill(root, {
      grill, saved,
      onSend: async (answers) => { received.push(answers); if (received.length === 1) await firstSend; },
    });
    const expectedAnswers = { v: 1, answers: [{ n: 1, kind: "own", text: "Keep this answer" }] };
    const sending = root.querySelector(".gm-send").click();
    assert.equal(root.querySelector(".gm-send").disabled, true);
    assert.equal(root.querySelector(".gm-send").textContent, "Sending…");
    rejectSend(error);
    await assert.doesNotReject(sending);
    const note = root.querySelector(".gm-note");
    assert.ok(note?.visible, "the note is in the visible summary tree");
    assert.equal(note.textContent, expected);
    assert.equal(root.querySelector(".gm-send").disabled, false);
    assert.equal(root.querySelector(".gm-send").textContent, "Send answers");
    assert.deepEqual(ui.answers(), expectedAnswers);
    await assert.doesNotReject(root.querySelector(".gm-send").click());
    assert.deepEqual(received, [expectedAnswers, expectedAnswers]);
    assert.equal(root.querySelector(".gm-send").disabled, false);
    // The public setter uses the same rendering path and supports clearing a note.
    ui.setNote("New host note");
    assert.equal(root.querySelector(".gm-note").textContent, "New host note");
    ui.setNote("");
    assert.equal(root.querySelector(".gm-note"), null);
  });
}

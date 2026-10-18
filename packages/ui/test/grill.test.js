import { test } from "node:test";
import assert from "node:assert/strict";
import { mountGrill } from "../src/grill.js";
import { createDocument } from "../test-support/dom.js";

const grill = { v: 1, questions: [{ n: 1, title: "Choose", body: "", choices: [], recommend: null, multi: false }] };
const saved = { answers: [{ kind: "own", text: "Keep this answer" }], order: [0], pos: 1, skipped: [] };

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

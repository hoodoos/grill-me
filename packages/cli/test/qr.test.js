// No QR reader is allowed as a test dependency, so check the structure instead.
import test from "node:test";
import assert from "node:assert/strict";
import { newId, newSecret, makeLink } from "../../core/src/index.js";
import { qrText } from "../src/qr.js";

const LINK = makeLink(newId(), newSecret()); // always 61 characters
assert.equal(LINK.length, 61);

const ALLOWED = new Set([" ", "▀", "▄", "█"]);
const MODULES = 33; // a 61-character link is version 4
const QUIET = 2;

// lines[r][c] covers module rows (2r - QUIET, 2r - QUIET + 1) and module column (c - QUIET).
const at = (lines, r, c) => lines[r][c];

for (const mode of ["dark", "light"]) {
  test(`qr structure (${mode} mode)`, () => {
    const text = qrText(LINK, { mode });
    const lines = text.split("\n");
    assert.equal(lines.length, Math.ceil((MODULES + 2 * QUIET) / 2));
    for (const line of lines) {
      assert.equal(line.length, MODULES + 2 * QUIET);
      for (const ch of line) assert.ok(ALLOWED.has(ch), `unexpected character ${JSON.stringify(ch)}`);
    }
    const paint = mode === "light" ? (dark) => dark : (dark) => !dark;
    const pair = (topDark, botDark) =>
      ({ "00": " ", "10": "▀", "01": "▄", "11": "█" })[(paint(topDark) ? "1" : "0") + (paint(botDark) ? "1" : "0")];

    // The three finder patterns: dark 7×7 border with a light ring at offset 1.
    // top-left: modules (0,0)+(1,0) dark, (0,1) dark over (1,1) light
    assert.equal(at(lines, 1, 2), pair(true, true));
    assert.equal(at(lines, 1, 3), pair(true, false));
    // top-right: modules (0,32)+(1,32)
    assert.equal(at(lines, 1, 2 + MODULES - 1), pair(true, true));
    // bottom-left: module (32,0) over the quiet zone
    assert.equal(at(lines, 17, 2), pair(true, false));
  });
}

test("the two modes are complementary", () => {
  const dark = qrText(LINK, { mode: "dark" }).split("\n");
  const light = qrText(LINK, { mode: "light" }).split("\n");
  const opposite = { " ": "█", "█": " ", "▀": "▄", "▄": "▀" };
  for (let r = 0; r < dark.length; r++) {
    for (let c = 0; c < dark[r].length; c++) {
      assert.equal(opposite[dark[r][c]], light[r][c], `cell ${r},${c}`);
    }
  }
});

test("qr mode is validated", () => {
  assert.throws(() => qrText(LINK, { mode: "blue" }), /dark.*light/);
});

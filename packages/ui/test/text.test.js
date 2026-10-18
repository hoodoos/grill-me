import { test } from "node:test";
import assert from "node:assert/strict";
import { tokens, renderText } from "../src/text.js";

test("plain text is one text token", () => {
  assert.deepEqual(tokens("hello world"), [{ type: "text", text: "hello world" }]);
});

test("bold", () => {
  assert.deepEqual(tokens("a **b** c"), [
    { type: "text", text: "a " },
    { type: "bold", text: "b" },
    { type: "text", text: " c" },
  ]);
});

test("code", () => {
  assert.deepEqual(tokens("run `npm test` now"), [
    { type: "text", text: "run " },
    { type: "code", text: "npm test" },
    { type: "text", text: " now" },
  ]);
});

test("unclosed markers stay literal text", () => {
  assert.deepEqual(tokens("a **b"), [{ type: "text", text: "a **b" }]);
  assert.deepEqual(tokens("a `b"), [{ type: "text", text: "a `b" }]);
  assert.deepEqual(tokens("**"), [{ type: "text", text: "**" }]);
});

test("bold markers inside code are literal; code inside bold ends the bold", () => {
  assert.deepEqual(tokens("`a **b** c`"), [{ type: "code", text: "a **b** c" }]);
  assert.deepEqual(tokens("**a `b` c**"), [
    { type: "text", text: "**a " },
    { type: "code", text: "b" },
    { type: "text", text: " c**" },
  ]);
});

test("bold does not cross a newline", () => {
  assert.deepEqual(tokens("**a\nb**"), [{ type: "text", text: "**a\nb**" }]);
});

test("several spans in one text", () => {
  assert.deepEqual(tokens("**a** and `b` and **c**"), [
    { type: "bold", text: "a" },
    { type: "text", text: " and " },
    { type: "code", text: "b" },
    { type: "text", text: " and " },
    { type: "bold", text: "c" },
  ]);
});

test("URLs and HTML stay plain text", () => {
  assert.deepEqual(tokens("see https://example.com/x"), [{ type: "text", text: "see https://example.com/x" }]);
  assert.deepEqual(tokens("<script>alert(1)</script>"), [{ type: "text", text: "<script>alert(1)</script>" }]);
});

// renderText builds element nodes only through createElement + textContent, so a minimal fake
// document is enough to check the shape it produces.
function fakeDoc() {
  const node = (tag) => ({ tag, textContent: "", children: [], append(...kids) { this.children.push(...kids); } });
  return {
    root: node("div"),
    createElement: node,
    createTextNode: (t) => ({ text: t }),
  };
}

test("renderText appends strong/code/text nodes, never HTML", () => {
  const doc = fakeDoc();
  const el = doc.root;
  el.ownerDocument = doc;
  renderText(el, "**yes** `no` <b>never</b>");
  assert.equal(el.children[0].tag, "strong");
  assert.equal(el.children[0].textContent, "yes");
  assert.equal(el.children[2].tag, "code");
  assert.equal(el.children[2].textContent, "no");
  assert.deepEqual(el.children[3], { text: " <b>never</b>" });
});

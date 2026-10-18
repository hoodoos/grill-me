// Small DOM shell for rendering tests: actual trees, text replacement, classes, visibility
// and asynchronous event handlers. No UI rendering or state behavior is implemented here.
export function createDocument() {
  class Node {
    constructor(tagName = "", text = "") {
      this.ownerDocument = doc;
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.className = "";
      this.hidden = false;
      this.disabled = false;
      this.style = {};
      this.listeners = new Map();
      this._text = text;
      const classes = () => new Set(this.className.split(/\s+/).filter(Boolean));
      this.classList = {
        contains: (c) => classes().has(c),
        add: (...names) => { this.className = [...new Set([...classes(), ...names])].join(" "); },
        remove: (...names) => { this.className = [...classes()].filter((c) => !names.includes(c)).join(" "); },
        toggle: (c) => { if (classes().has(c)) this.classList.remove(c); else this.classList.add(c); },
      };
    }
    set textContent(value) {
      for (const child of this.children) child.parentElement = null;
      this.children = [];
      this._text = String(value);
    }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
    append(...nodes) {
      for (let child of nodes) {
        if (typeof child === "string") child = doc.createTextNode(child);
        child.parentElement = this;
        this.children.push(child);
      }
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    // Awaiting the real async handler exposes an unhandled rejection that native dispatch
    // would report to the browser console (the original undefined-setNote regression).
    async click() {
      if (this.disabled) return;
      for (const fn of this.listeners.get("click") || []) await fn({ type: "click", target: this });
    }
    querySelectorAll(selector) {
      const matches = (n) => selector.startsWith(".")
        ? selector.slice(1).split(".").every((c) => n.classList.contains(c))
        : n.tagName === selector.toUpperCase();
      return this.children.flatMap((c) => [...(matches(c) ? [c] : []), ...c.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    get visible() { return !this.hidden && (!this.parentElement || this.parentElement.visible); }
  }
  const doc = {
    createElement: (tag) => new Node(tag),
    createTextNode: (text) => new Node("", text),
  };
  return doc;
}

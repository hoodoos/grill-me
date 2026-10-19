// Agent-written text rendering: only **bold** and `code` are markup, everything else stays
// plain text (URLs are never linked). renderText builds nodes with textContent/createElement
// only, so no agent text can ever become HTML.

const CODE = /`([^`\n]+)`/g;
const BOLD = /\*\*([^*\n]+?)\*\*/g;

// tokens(text) → [{ type: "text" | "bold" | "code", text }]. Code spans are found first;
// `**` inside a code span is literal. Bold never crosses a newline; unclosed markers stay text.
export function tokens(text) {
  const out = [];
  const push = (type, t) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += t;
    else out.push({ type, text: t });
  };
  const str = String(text ?? "");
  let i = 0;
  for (const m of str.matchAll(CODE)) {
    boldInto(push, str.slice(i, m.index));
    push("code", m[1]);
    i = m.index + m[0].length;
  }
  boldInto(push, str.slice(i));
  return out;
}

function boldInto(push, segment) {
  let i = 0;
  for (const m of segment.matchAll(BOLD)) {
    push("text", segment.slice(i, m.index));
    push("bold", m[1]);
    i = m.index + m[0].length;
  }
  push("text", segment.slice(i));
}

// Appends the tokens to el. Newlines are kept (the CSS uses white-space: pre-wrap).
export function renderText(el, text) {
  const doc = el.ownerDocument;
  for (const t of tokens(text)) {
    if (t.type === "bold") {
      const strong = doc.createElement("strong");
      strong.textContent = t.text;
      el.append(strong);
    } else if (t.type === "code") {
      const code = doc.createElement("code");
      code.textContent = t.text;
      el.append(code);
    } else {
      el.append(doc.createTextNode(t.text));
    }
  }
  return el;
}

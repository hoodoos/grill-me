// The grill page: an agent's questions as swipe cards, extracted from Agent Hub's grill UI.
// Host-agnostic: it knows nothing about grill-me.ai's server, links or keys. The host hands it
// a plain grill object and callbacks; all core/crypto work is the host's job.
//
//   mountGrill(root, { grill, saved, onChange, onSend, note }) → { destroy(), setNote(text) }
//
// grill: the core grill format ({ title?, questions: [{ n, title, body, choices: [{ name, detail }],
//   recommend: { choice, why } | null, multi }] }).
// saved: a snapshot() from an earlier session, or null.
// onChange(snapshot): fires on every change; the host persists the snapshot.
// onSend(answers): returns a promise; the UI shows "Sending…" until it settles.
// note: a host message shown above the list/summary (e.g. "This grill expired").
import { createState } from "./state.js";
import { renderText } from "./text.js";

const SKIP_LINE = "skip for now, ask again later";
const oneLine = (t) => String(t).replace(/\s*\n+\s*/g, " ").trim();
const norm = (t) => " " + String(t ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() + " ";

export function mountGrill(root, { grill, saved = null, onChange = () => {}, onSend = () => Promise.resolve(), note = "" }) {
  const doc = root.ownerDocument;
  const mach = createState(grill, saved);
  const S = mach.state;
  let sending = false;
  let focusText = false;
  let noteText = note || "";
  const multiPicked = new Set(); // selected choice names while on a multi card

  root.classList.add("gm-root");
  root.textContent = "";
  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const top = el("div", "gm-top");
  const titleEl = el("span", "gm-title");
  const progressEl = el("span", "gm-progress");
  const listBtn = el("button", "gm-listbtn", "Questions");
  listBtn.type = "button";
  top.append(titleEl, progressEl, listBtn);
  const stage = el("div", "gm-stage");
  const list = el("div", "gm-list");
  list.hidden = true;
  const bar = el("div", "gm-bar");
  root.append(top, stage, list, bar);

  const changed = () => onChange(mach.snapshot());
  const act = (fn, ...args) => {
    multiPicked.clear();
    fn(...args);
    changed();
    render(true);
  };

  // "agree: Parsed" / "A, B" / own words / the skip line.
  const showAnswer = (q, a, summary) => {
    if (!a) return summary ? SKIP_LINE : "not answered yet";
    switch (a.kind) {
      case "agree": return q.recommend?.choice ? `agree: ${q.recommend.choice}` : "agree";
      case "choice": return Array.isArray(a.choice) ? a.choice.join(", ") : a.choice;
      case "own": return oneLine(a.text);
      default: return SKIP_LINE;
    }
  };

  function render(animate) {
    const inList = S.view === "summary" || S.view === "list";
    titleEl.textContent = grill.title || "Questions";
    listBtn.textContent = S.view === "list" ? "Back" : "Questions";
    progressEl.textContent = inList
      ? `${S.answers.filter(Boolean).length}/${grill.questions.length} answered`
      : `${S.pos + 1}/${S.order.length}`;
    stage.hidden = inList;
    list.hidden = !inList;
    if (inList) return renderList();
    renderCard(animate);
  }

  function renderCard(animate) {
    const i = mach.currentIndex(), q = grill.questions[i], a = S.answers[i], text = S.view === "text";
    stage.textContent = "";
    bar.textContent = "";
    const card = el("div", "gm-card" + (animate ? " enter" : ""));
    if (!text) {
      card.append(el("span", "gm-stamp agree", "AGREE"), el("span", "gm-stamp own", "MY OWN"));
    }
    const scroll = el("div", "gm-scroll");
    scroll.append(el("div", "gm-n", `Q${q.n}`));
    scroll.append(el("div", "gm-qtitle", q.title));
    // Writing your own answer: the recommendation stays in view, the question folds away.
    if (q.body) {
      if (text && q.recommend) {
        const det = el("details", "gm-md");
        const sum = el("summary", "gm-meta", "The question");
        const body = el("div");
        renderText(body, q.body);
        det.append(sum, body);
        scroll.append(det);
      } else {
        const body = el("div", "gm-md");
        renderText(body, q.body);
        scroll.append(body);
      }
    }
    if (q.recommend) {
      const rec = el("div", "gm-rec");
      rec.append(el("div", "gm-rec-h", "➡️ Recommended"));
      const body = el("div", "gm-md");
      const { choice, why } = q.recommend;
      // When the why doesn't already start with the choice's name, name it first, in bold.
      if (choice && !norm(why).startsWith(norm(choice))) {
        const strong = el("strong", "", choice);
        body.append(strong);
        if (why) body.append(doc.createTextNode(" — "));
      }
      if (why) renderText(body, why);
      rec.append(body);
      scroll.append(rec);
    }
    if (q.choices.length) {
      const isRec = (c) => !!q.recommend?.choice && c.name.toLowerCase() === q.recommend.choice.toLowerCase();
      const box = el("div", "gm-choices");
      q.choices.forEach((c) => {
        const picked = a?.kind === "choice" && (Array.isArray(a.choice) ? a.choice : [a.choice]).some((n) => n.toLowerCase() === c.name.toLowerCase());
        const isOn = q.multi ? multiPicked.has(c.name) : picked;
        // A choice with a detail is a tappable row (bold name, muted detail); without one, a compact chip.
        const b = el("button", c.detail ? "gm-choice" : "gm-chip");
        b.type = "button";
        if (isOn) b.classList.add("on");
        const name = el("span", "gm-choice-name", (isRec(c) ? "➡️ " : "") + c.name);
        b.append(name);
        if (c.detail) b.append(el("span", "gm-choice-detail", c.detail));
        b.addEventListener("click", () => {
          if (q.multi) {
            if (multiPicked.has(c.name)) multiPicked.delete(c.name);
            else multiPicked.add(c.name);
            b.classList.toggle("on");
          } else act(() => mach.choose(c.name));
        });
        box.append(b);
      });
      if (q.multi) {
        const next = el("button", "gm-primary gm-multi-next", "Next");
        next.type = "button";
        next.addEventListener("click", () => {
          if (!multiPicked.size) return;
          const names = [...multiPicked];
          multiPicked.clear();
          act(() => mach.choose(names));
        });
        box.append(next);
      }
      scroll.append(box);
    }
    const mine = a ? "Your answer: " + showAnswer(q, a) : S.hint?.i === i ? "You had: " + showAnswer(q, S.hint.a) : "";
    if (mine) scroll.append(el("div", "gm-mine", mine));
    card.append(scroll);
    if (text) {
      const twrap = el("div", "gm-text");
      const input = el("textarea");
      input.rows = 4;
      input.placeholder = q.recommend ? "Your own answer…" : "Your answer…";
      input.value = S.drafts[i] ?? (a?.kind === "own" ? a.text : S.hint?.i === i && S.hint.a.kind === "own" ? S.hint.a.text : "");
      input.addEventListener("input", () => { mach.setDraft(input.value); changed(); });
      const row = el("div", "gm-row");
      if (q.recommend) {
        const back = el("button", "", "Back");
        back.type = "button";
        back.addEventListener("click", () => { mach.closeText(); render(); });
        row.append(back);
      }
      row.append(el("span", "gm-spacer"));
      const next = el("button", "gm-primary", "Next");
      next.type = "button";
      next.addEventListener("click", () => {
        if (mach.own(input.value)) { changed(); render(true); }
        else input.focus();
      });
      row.append(next);
      twrap.append(input, row);
      card.append(twrap);
      if (focusText) { focusText = false; setTimeout(() => input.focus(), 60); }
    }
    stage.append(card);
    // Bottom bar: undo, ✗ own, Skip, ✓ agree.
    const undo = el("button", "", "↶");
    undo.type = "button";
    undo.title = "Undo";
    undo.disabled = !S.hist.length;
    undo.addEventListener("click", () => act(() => mach.undo()));
    bar.append(undo);
    if (!text) {
      const own = el("button", "gm-no", "✗");
      own.type = "button";
      own.title = "My own answer";
      own.addEventListener("click", () => { mach.startOwn(); focusText = true; render(); });
      bar.append(own);
    }
    const skip = el("button", "", "Skip");
    skip.type = "button";
    skip.addEventListener("click", () => { multiPicked.clear(); act(() => mach.skip()); });
    bar.append(skip);
    if (!text) {
      const yes = el("button", "gm-yes", "✓");
      yes.type = "button";
      yes.title = "Agree";
      yes.disabled = !mach.canAgree();
      yes.addEventListener("click", () => act(() => mach.agree()));
      bar.append(yes);
    }
    if (animate) requestAnimationFrame(() => requestAnimationFrame(() => card.classList.remove("enter")));
    if (!text) bindSwipe(card, mach.canAgree());
  }

  function renderList() {
    const summary = S.view === "summary";
    list.textContent = "";
    bar.textContent = "";
    if (noteText) list.append(el("div", "gm-note", noteText));
    grill.questions.forEach((q, i) => {
      const a = S.answers[i];
      const row = el("button", "gm-qrow" + (!summary && i === mach.currentIndex() ? " here" : ""));
      row.type = "button";
      const inner = el("div");
      inner.append(el("div", "gm-q", `Q${q.n} · ${q.title}`));
      const ans = el("div", "gm-a" + (a?.kind === "skip" || (!a && summary) ? " skip" : ""), showAnswer(q, a, summary));
      inner.append(ans);
      row.append(inner);
      row.addEventListener("click", () => { multiPicked.clear(); mach.jump(i); render(true); });
      list.append(row);
    });
    if (summary) {
      const undo = el("button", "", "↶");
      undo.type = "button";
      undo.title = "Undo";
      undo.disabled = !S.hist.length;
      undo.addEventListener("click", () => act(() => mach.undo()));
      const send = el("button", "gm-primary gm-send", sending ? "Sending…" : "Send answers");
      send.type = "button";
      send.disabled = sending;
      send.addEventListener("click", async () => {
        sending = true;
        render();
        try { await onSend(mach.toAnswers()); }
        catch { setNote("Send failed. Your answers are still here — try again, or use Copy answers."); }
        finally { sending = false; render(); }
      });
      bar.append(undo, send);
    } else {
      const back = el("button", "", "Back to the card");
      back.type = "button";
      back.addEventListener("click", () => { mach.toggleList(); render(); });
      bar.append(back);
    }
  }

  // Swipes: a horizontal drag past 35% of the card (20% if flicked fast) commits; less springs
  // back. The first 10 px decide between swiping and scrolling the card's text. With no
  // recommendation, a right swipe only budges.
  function bindSwipe(card, canAgree) {
    const stamp = (cls) => card.querySelector(".gm-stamp." + cls);
    let st = null;
    card.addEventListener("pointerdown", (e) => {
      if (e.button > 0 || e.target.closest("button, a, textarea, input, summary")) return;
      st = { x: e.clientX, y: e.clientY, t: 0, id: e.pointerId, lock: null, dx: 0, over: 0 };
    });
    card.addEventListener("pointermove", (e) => {
      if (!st || e.pointerId !== st.id) return;
      const dx = e.clientX - st.x, dy = e.clientY - st.y;
      if (!st.lock) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        st.lock = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (st.lock === "x") { card.setPointerCapture(e.pointerId); card.classList.add("dragging"); st.t = performance.now(); }
      }
      if (st.lock !== "x") return;
      const d = dx > 0 && !canAgree ? dx / 4 : dx, w = card.offsetWidth;
      st.dx = d;
      card.style.transform = `translateX(${d}px) rotate(${d / 20}deg)`;
      stamp("agree").style.opacity = d > 0 && canAgree ? Math.min(1, d / (w * 0.35)) : 0;
      stamp("own").style.opacity = d < 0 ? Math.min(1, -d / (w * 0.35)) : 0;
      const over = Math.abs(d) >= w * 0.35 && (d < 0 || canAgree) ? Math.sign(d) : 0;
      if (over && over !== st.over) navigator.vibrate?.(12);
      st.over = over;
    });
    const end = (e) => {
      if (!st || e.pointerId !== st.id) return;
      const s0 = st;
      st = null;
      card.classList.remove("dragging");
      if (s0.lock !== "x") return;
      const w = card.offsetWidth, fast = Math.abs(s0.dx) / Math.max(1, performance.now() - s0.t) > 0.5;
      const go = e.type === "pointerup" && (Math.abs(s0.dx) >= w * 0.35 || (Math.abs(s0.dx) >= w * 0.2 && fast)) && (s0.dx < 0 || canAgree);
      if (!go) { card.style.transform = ""; stamp("agree").style.opacity = 0; stamp("own").style.opacity = 0; return; }
      const dir = Math.sign(s0.dx);
      card.style.transform = `translateX(${dir * 130}%) rotate(${dir * 18}deg)`;
      card.style.opacity = "0";
      setTimeout(() => {
        if (dir > 0) act(() => mach.agree());
        else { mach.startOwn(); focusText = true; render(); }
      }, 200);
    };
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", end);
  }

  listBtn.addEventListener("click", () => { mach.toggleList(); render(); });

  render(true);
  return {
    destroy() { root.classList.remove("gm-root"); root.textContent = ""; },
    setNote(text) {
      noteText = text || "";
      if (S.view === "summary" || S.view === "list") render();
    },
  };
}

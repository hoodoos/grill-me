// The grill page's state machine, ported from Agent Hub's grill logic (`G` in its index.html).
// No DOM here: the view (grill.js) renders from this state and calls its methods.
//
// answers: one slot per question (grill order), an answer object or null.
//   { kind: "agree" } · { kind: "choice", choice: name | [names] } · { kind: "own", text } · { kind: "skip" }
// order: question indexes in swipe order (a skipped card moves to the end once).
// pos: position in order. pos === order.length is the summary.
// view: "card" | "text" | "list" | "summary".

const needsText = (q) => !q.recommend; // nothing to agree with: the card opens in the text view

export function createState(grill, saved) {
  const n = grill.questions.length;
  const s = {
    grill,
    answers: saved?.answers?.length === n ? saved.answers.map((a) => (a ? { ...a } : null)) : Array(n).fill(null),
    order: saved?.order?.length === n ? saved.order.slice() : [...Array(n).keys()],
    pos: Math.min(saved?.pos ?? 0, n),
    skipped: saved?.skipped ? saved.skipped.slice() : [],
    drafts: { ...(saved?.drafts || {}) },
    choiceDrafts: Object.fromEntries(Object.entries(saved?.choiceDrafts || {}).filter(([i, names]) =>
      grill.questions[i]?.multi && Array.isArray(names)).map(([i, names]) =>
      [i, [...new Set(names.filter(name => grill.questions[i].choices.some(c => c.name === name)))]])),
    hist: [],
    view: "card",
    jumpBack: false,
    hint: null,
    listFrom: "card",
  };
  s.view = s.pos >= n ? "summary" : needsText(current(s)) ? "text" : "card";

  const gi = () => s.order[s.pos];
  const copyChoices = () => Object.fromEntries(Object.entries(s.choiceDrafts).map(([i, names]) => [i, names.slice()]));
  const snap = () => ({ answers: s.answers.slice(), order: s.order.slice(), pos: s.pos, skipped: s.skipped.slice(), jumpBack: s.jumpBack, choiceDrafts: copyChoices() });

  // On to the next unanswered card; after a card opened from the summary, back to the summary.
  const advance = () => {
    s.hint = null;
    if (s.jumpBack) { s.jumpBack = false; s.pos = s.order.length; }
    else do s.pos++; while (s.pos < s.order.length && s.answers[s.order[s.pos]]);
    s.view = s.pos >= s.order.length ? "summary" : needsText(current(s)) ? "text" : "card";
  };

  const answer = (a) => {
    s.hist.push(snap());
    delete s.choiceDrafts[gi()];
    s.answers[gi()] = a;
    advance();
  };

  return {
    state: s,
    currentIndex: gi,
    current: () => current(s),
    // True when the current question has a recommendation to agree with.
    canAgree: () => !!current(s).recommend,

    agree() {
      if (!current(s).recommend) return;
      answer({ kind: "agree" });
    },
    // One name, or an array of names for a multi question.
    choose(names) {
      answer({ kind: "choice", choice: names });
    },
    // Commit a typed answer. Empty text is not an answer; the view stays.
    own(text) {
      const v = String(text ?? "").trim();
      if (!v) return false;
      delete s.drafts[gi()];
      answer({ kind: "own", text: v });
      return true;
    },
    // Open the text view without answering yet (the ✗ button, a left swipe).
    startOwn() {
      s.view = "text";
    },
    closeText() {
      s.view = "card";
    },
    setDraft(text) {
      s.drafts[gi()] = text;
    },
    choiceDraft() {
      const i = gi();
      if (Object.hasOwn(s.choiceDrafts, i)) return s.choiceDrafts[i].slice();
      const answer = s.answers[i];
      return answer?.kind === "choice" ? [...(Array.isArray(answer.choice) ? answer.choice : [answer.choice])] : [];
    },
    setChoiceDraft(names) { s.choiceDrafts[gi()] = names.slice(); },
    // A skipped card goes to the end once; skipped again, it's sent as "skip for now".
    skip() {
      const i = gi();
      s.hist.push(snap());
      if (!s.skipped.includes(i) && s.order.length - s.pos > 1 && !s.jumpBack) {
        s.skipped.push(i);
        s.order.splice(s.pos, 1);
        s.order.push(i);
        s.pos--;
        return advance();
      }
      s.answers[i] = { kind: "skip" };
      delete s.choiceDrafts[i];
      advance();
    },
    // Back one step, as many times as you like; the card shows what you had answered.
    undo() {
      const h = s.hist.pop();
      if (!h) return false;
      const undone = s.answers[h.order[h.pos]];
      Object.assign(s, h);
      s.hint = undone && undone !== s.answers[gi()] ? { i: gi(), a: undone } : null;
      s.view = needsText(current(s)) ? "text" : "card";
      return true;
    },
    // Open question i (an index into grill.questions) from the list or the summary.
    jump(i) {
      s.jumpBack = s.view === "summary" || s.listFrom === "summary";
      s.pos = s.order.indexOf(i);
      s.hint = null;
      s.view = needsText(current(s)) ? "text" : "card";
    },
    toggleList() {
      if (s.view === "list") s.view = s.listFrom;
      else { s.listFrom = s.view; s.view = "list"; }
    },

    // What the host persists (it adds its own timestamp/fingerprint).
    snapshot() {
      return { answers: s.answers.slice(), order: s.order.slice(), pos: s.pos, skipped: s.skipped.slice(), drafts: { ...s.drafts }, choiceDrafts: copyChoices() };
    },
    // The core answers object: one answer per question, in grill order; unanswered → skip.
    toAnswers() {
      return {
        v: 1,
        answers: grill.questions.map((q, i) => {
          const a = s.answers[i];
          if (!a) return { n: q.n, kind: "skip" };
          if (a.kind === "choice") return { n: q.n, kind: "choice", choice: Array.isArray(a.choice) ? a.choice.slice() : a.choice };
          if (a.kind === "own") return { n: q.n, kind: "own", text: a.text };
          return { n: q.n, kind: a.kind === "agree" ? "agree" : "skip" };
        }),
      };
    },
  };
}

function current(s) {
  return s.grill.questions[s.order[Math.min(s.pos, s.order.length - 1)]];
}

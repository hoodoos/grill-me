// The answer lines an agent receives, one per grill question, in grill order: "Q<n> - <value>".

const SKIP_LINE = "skip for now, ask again later"; // the hub's exact wording
const oneLine = (text) => text.replace(/\s*\n+\s*/g, " ").trim(); // the hub's oneLine

export function answerLines(grill, answers) {
  const byN = new Map((answers?.answers || []).map((a) => [a.n, a]));
  return grill.questions
    .map((q) => {
      const a = byN.get(q.n);
      let value;
      switch (a?.kind) {
        case "agree": value = "agree"; break;
        case "choice": value = Array.isArray(a.choice) ? a.choice.join(", ") : a.choice; break;
        case "own": value = oneLine(a.text); break;
        default: value = SKIP_LINE;
      }
      return `Q${q.n} - ${value}`;
    })
    .join("\n");
}

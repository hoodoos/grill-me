import { mountGrill } from "/ui/grill.js";

// No relay, storage or history: this interview exists only in this page's memory.
const grill = { title: "A tiny grilling demo", questions: [
  { n: 1, title: "Do you know what grilling is?", body: "A focused interview with your AI. It asks useful questions, challenges assumptions, and helps you think an idea through.", choices: [], multi: false,
    recommend: { why: "Start with one idea. Let a good question move it forward." } },
  { n: 2, title: "How would you answer?", body: "In a real grill, your agent shows the questions in chat. Open the phone link: swipe right to agree, or left to write your own answer. Try either here. Nothing leaves this demo.", choices: [], multi: false,
    recommend: { why: "Your perspective matters. Agree when it fits; use your own words when it doesn't." } },
  { n: 3, title: "Ready for the next good question?", body: "Keep the same phone page open for the whole interview. After your agent collects a round, the page waits and updates automatically with the next questions.", choices: [], multi: false,
    recommend: { why: "One conversation. One phone link. Keep thinking together." } },
] };
const complete = document.getElementById("home-complete");
let handle, observer;
function replay() {
  observer?.disconnect(); handle?.destroy();
  // A retired mount cannot repaint this new one if a delayed swipe finishes late.
  const previous = document.getElementById("home-grill");
  const root = document.createElement("div"); root.id = "home-grill";
  root.setAttribute("aria-label", "Local interactive demo"); previous.replaceWith(root);
  complete.hidden = true;
  const localLabels = () => { const send = root.querySelector(".gm-send"); if (send && send.textContent !== "Finish demo") send.textContent = "Finish demo"; };
  observer = new MutationObserver(localLabels); observer.observe(root, { childList: true, subtree: true });
  handle = mountGrill(root, { grill, note: "Local demo only. Nothing is sent or saved.", onSend: async () => {
    root.hidden = true; complete.hidden = false;
    complete.querySelector("a").focus({ preventScroll: true });
  } });
}
document.getElementById("home-replay").addEventListener("click", replay);
replay();

// Wrap rendered commands progressively; never rewrite their text or newlines.
for (const [i, pre] of [...document.querySelectorAll("#install-commands pre")].entries()) {
  const code = pre.querySelector("code"); if (!code) continue;
  code.id = `install-command-${i + 1}`; code.tabIndex = 0;
  const box = document.createElement("div"); box.className = "copy-window";
  const toolbar = document.createElement("div"); toolbar.className = "copy-toolbar";
  const label = document.createElement("span"); label.textContent = "Command / configuration";
  const button = document.createElement("button"); button.type = "button"; button.textContent = "Copy";
  button.dataset.copyTarget = code.id; button.setAttribute("aria-label", `Copy command block ${i + 1}`);
  toolbar.append(label, button);
  const status = document.createElement("p"); status.className = "copy-status";
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  pre.replaceWith(box); box.append(toolbar, pre, status);
}
for (const button of document.querySelectorAll("[data-copy-target]")) {
  const code = document.getElementById(button.dataset.copyTarget);
  const status = button.closest(".copy-window").querySelector(".copy-status");
  button.addEventListener("click", async () => {
    button.disabled = true; button.textContent = "Copy"; status.textContent = "";
    try {
      await navigator.clipboard.writeText(code.textContent);
      button.textContent = "Copied"; status.textContent = "Copied to clipboard.";
    } catch {
      code.focus({ preventScroll: true });
      const range = document.createRange(); range.selectNodeContents(code);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      status.textContent = "Couldn't copy. Text selected—copy it manually.";
    } finally { button.disabled = false; }
  });
}

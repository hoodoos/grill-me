// The polling/deadline scope shared by one-shot grills and persistent sessions.
// One absolute budget spans polling, retries, delivery, acknowledgement and lock waits.

export const NOW = () => performance.now(); // monotonic wall-clock budget, unaffected by clock corrections
export const SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const defaultBackoff = (failures, { baseMs = 1000, capMs = 30000 } = {}) =>
  Math.min(capMs, baseMs * 2 ** (failures - 1));

export const abortedError = () => {
  const err = new Error("the wait was cancelled");
  err.code = "aborted";
  return err;
};

export const abortableSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

// One absolute budget spans polling, retries, delivery and acknowledgement. An unanswered
// CLI wait has no overall deadline; individual HTTP attempts still have their own timeout.
export function waitScope(seconds, signal, now = NOW) {
  const until = Number.isFinite(seconds) ? now() + Math.max(0, seconds * 1000) : Infinity;
  const deadline = new AbortController();
  let closed = false;
  const remaining = () => Math.max(0, until - now());
  const timer = Number.isFinite(until) ? setTimeout(() => deadline.abort(), remaining()) : null;
  timer?.unref();
  const scope = {
    signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
    remaining,
    ready() {
      if (signal?.aborted) throw abortedError();
      return !closed && !deadline.signal.aborted && remaining() > 0;
    },
    assertReady() {
      if (!scope.ready()) {
        const err = new Error("the wait deadline elapsed");
        err.code = "deadline";
        throw err;
      }
    },
    close() { closed = true; clearTimeout(timer); deadline.abort(); },
  };
  return scope;
}

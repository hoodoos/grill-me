// A write is delivered only when its callback succeeds. Abort stops waiting for that callback;
// callers must retain pending state and must never acknowledge a failed/interrupted write.
export function writeOutput(stream, text, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(new Error("output interrupted"));
    const onError = (err) => finish(err);
    let finished = false;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      // Node emits 'error' after a failed write callback. Keep the one-shot handler to consume it.
      if (!err) stream.removeListener("error", onError);
      if (err) reject(err);
      else resolve();
    };
    if (signal?.aborted) return finish(new Error("output interrupted"));
    stream.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    try { stream.write(text, (err) => {
      // Abort may have settled the promise before a successful callback arrives.
      if (!err) stream.removeListener("error", onError);
      finish(err);
    }); }
    catch (err) { finish(err); }
  });
}

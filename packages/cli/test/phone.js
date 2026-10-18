// The phone's side of a test: fetch and decrypt the grill, seal the answers, POST them with the write token.
import { deriveKeys, openGrill, sealAnswers } from "../../core/src/index.js";

// picks: [{ n, kind, choice?, text? }] in the spec's answer shape.
export async function phoneAnswer(server, id, secret, picks) {
  const res = await fetch(`${server}/api/g/${id}`);
  if (res.status !== 200) throw new Error(`phone: GET grill → ${res.status}`);
  const blob = await res.json();
  const grill = await openGrill(blob, { id, secret });
  const sealed = await sealAnswers({ v: 1, answers: picks }, grill, { id, secret });
  const { writeToken } = await deriveKeys(secret);
  const post = await fetch(`${server}/api/g/${id}/answers`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${writeToken}` },
    body: JSON.stringify(sealed),
  });
  if (post.status !== 204) throw new Error(`phone: POST answers → ${post.status}`);
  return grill;
}

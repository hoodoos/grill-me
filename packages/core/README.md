# @grill-me/core

Grill Me's internal format, converters, crypto and answer lines. Zero dependencies; runs in
browsers and Node (Web Crypto only).

- `parseGrill(text)` — lenient grill-text parser ported from Agent Hub; `DEMO_TEXT` — the built-in sample.
- `LIMITS` — size caps (questions, bytes, characters).
- `GRILL_SCHEMA` — JSON Schema for the input form of a grill (the MCP tool's input schema).
- `validateGrill(input)` → `{ ok, grill | errors }` — normalize and validate a grill.
- `validateAnswers(input, grill)` → `{ ok, answers | errors }` — normalize and validate answers.
- `convert(input, { title? })` → `{ ok, grill, source | error, schema }` — any supported format in.
- `fromGrillText` / `fromAskUserQuestion` / `fromCodex` / `fromNumbered` — individual converters.
- `answerLines(grill, answers)` — the `Q<n> - <value>` lines an agent receives.
- `newSecret()` / `newId()` / `isSecret(s)` / `isId(s)` — random link parts and strict checks.
- `deriveKeys(secret)` → `{ encKey, writeToken, writeHash }`; `hashWriteToken(token)`.
- `encryptJson` / `decryptJson(encKey, id, slot, …)` — AES-256-GCM with `id:slot` as AAD.
- `sealGrill` / `openGrill` / `sealAnswers` / `openAnswers` — validate + encrypt / decrypt + validate.
- `contentHash(grill)` — stable hash of a normalized grill.
- `createMcpHandler({ name, version, instructions, tools })` — the MCP protocol, no I/O;
  `grillToolDefs({ mode })` — the three grill tool definitions; `clientAgent(clientInfo)` — the metrics allowlist.
- `makeLink(id, secret, base?)` / `parseLink(url)` — grill links.
- `b64urlEncode` / `b64urlDecode` — strict unpadded base64url.

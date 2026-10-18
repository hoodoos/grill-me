import test from "node:test";
import assert from "node:assert/strict";
import { createMcpHandler, grillToolDefs, clientAgent, PROTOCOL_VERSIONS } from "../src/index.js";

const makeHandler = (tools = []) =>
  createMcpHandler({ name: "grill-me", version: "0.1.0", instructions: "Ask away.", tools });

test("initialize negotiates the protocol version", async () => {
  const { handle } = makeHandler();
  for (const v of PROTOCOL_VERSIONS) {
    const res = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v, clientInfo: { name: "x" } } });
    assert.equal(res.result.protocolVersion, v);
    assert.deepEqual(res.result.capabilities, { tools: { listChanged: false } });
    assert.deepEqual(res.result.serverInfo, { name: "grill-me", version: "0.1.0" });
    assert.equal(res.result.instructions, "Ask away.");
  }
  // an unknown or missing version gets the newest
  for (const v of ["1999-01-01", undefined]) {
    const res = await handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: v ? { protocolVersion: v } : {} });
    assert.equal(res.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  }
});

test("ping answers with an empty result", async () => {
  const res = await makeHandler().handle({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.deepEqual(res.result, {});
});

test("notifications get no response", async () => {
  const { handle } = makeHandler();
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }), null);
  assert.equal(await handle({ jsonrpc: "2.0", method: "tools/call", params: { name: "x" } }), null);
});

test("tools/list returns the definitions", async () => {
  const tools = grillToolDefs({ mode: "local" }).map((d) => ({ ...d, run: async () => ({ text: "x" }) }));
  const res = await makeHandler(tools).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(res.result.tools.map((t) => t.name), ["grill_send", "grill_wait", "grill_cancel"]);
  assert.ok(res.result.tools.every((t) => !("run" in t) && t.inputSchema && t.description));
  assert.ok(res.result.tools.every((t) => t.annotations.readOnlyHint === false && t.annotations.openWorldHint === true));
});

test("tools/call dispatches to run with args and ctx", async () => {
  const seen = [];
  const tools = [
    {
      name: "probe",
      title: "Probe",
      description: "d",
      inputSchema: { type: "object" },
      run: async (args, ctx) => {
        seen.push({ args, clientInfo: ctx.clientInfo, hasSignal: ctx.signal instanceof AbortSignal });
        return { text: "done", structured: { ok: 1 } };
      },
    },
  ];
  const signal = new AbortController().signal;
  const res = await makeHandler(tools).handle(
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "probe", arguments: { a: 1 } } },
    { clientInfo: { name: "tester" }, signal },
  );
  assert.deepEqual(res.result.content, [{ type: "text", text: "done" }]);
  assert.deepEqual(res.result.structuredContent, { ok: 1 });
  assert.deepEqual(seen, [{ args: { a: 1 }, clientInfo: { name: "tester" }, hasSignal: true }]);
});

test("a tool that throws becomes isError, not a JSON-RPC error", async () => {
  const tools = [
    { name: "boom", title: "t", description: "d", inputSchema: {}, run: async () => { throw new Error("kaput"); } },
  ];
  const res = await makeHandler(tools).handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boom" } });
  assert.equal(res.result.isError, true);
  assert.equal(res.result.content[0].text, "kaput");
});

test("error codes: -32600 malformed, -32601 unknown method, -32602 bad params", async () => {
  const { handle } = makeHandler();
  assert.equal((await handle({ jsonrpc: "2.0", id: 1 })).error.code, -32600);
  assert.equal((await handle(["not", "an", "object"])).error.code, -32600);
  assert.equal((await handle({ id: 1, method: "ping" })).error.code, -32600); // no jsonrpc: "2.0"
  assert.equal((await handle({ jsonrpc: "2.0", id: 1, method: "resources/list" })).error.code, -32601);
  assert.equal((await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })).error.code, -32602);
  assert.equal((await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } })).error.code, -32602);
  assert.equal((await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope", arguments: [] } })).error.code, -32602);
});

test("grill tool defs: local vs hosted inputs, every type a single string", () => {
  const walk = (node, path) => {
    if ("type" in node) assert.equal(typeof node.type, "string", `${path}.type`);
    for (const [k, v] of Object.entries(node)) {
      if (k === "properties" && v && typeof v === "object") for (const [name, sub] of Object.entries(v)) walk(sub, `${path}.${name}`);
      else if (k === "items") walk(v, `${path}.items`);
    }
  };
  for (const mode of ["local", "hosted"]) {
    const defs = grillToolDefs({ mode });
    assert.equal(defs.length, 3);
    for (const d of defs) {
      walk(d.inputSchema, d.name);
      assert.ok(!("run" in d), "defs come without run");
    }
    const wait = defs.find((d) => d.name === "grill_wait");
    if (mode === "local") {
      assert.deepEqual(Object.keys(wait.inputSchema.properties), ["id", "seconds"]);
      assert.deepEqual(wait.inputSchema.required, ["id"]);
    } else {
      assert.deepEqual(Object.keys(wait.inputSchema.properties), ["link", "id", "secret", "seconds"]);
      assert.ok(!("required" in wait.inputSchema));
    }
  }
  assert.throws(() => grillToolDefs({ mode: "purple" }));
});

test("clientAgent maps clientInfo.name onto the allowlist", () => {
  const cases = {
    "Claude Code": "claude-code",
    "claude-code": "claude-code",
    "Claude Desktop": "claude-desktop",
    "claude.ai": "claude-ai",
    "Claude": "claude-ai",
    "ChatGPT": "chatgpt",
    "Codex CLI": "codex",
    "cursor": "cursor",
    "Gemini CLI": "gemini-cli",
    "vscode-mcp": "vscode",
    "Visual Studio Code": "vscode",
    "Emacs": "other",
  };
  for (const [name, expected] of Object.entries(cases)) {
    assert.equal(clientAgent({ name }), expected, name);
  }
  assert.equal(clientAgent(undefined), "other");
  assert.equal(clientAgent({}), "other");
});

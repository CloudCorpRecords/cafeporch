import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  CafeporchClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { createServer, handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real Latent Grounds endpoint is
 * never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/latentgrounds-cafe-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 29 P1 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
/**
 * Recursively strip `description` fields (tool- and parameter-level).
 * Ruling 1 (extended fleet-wide 2026-11-15): the served tools carry
 * parameter descriptions added over the original capture; everything
 * else must match the fixture exactly. */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k !== "description") out[k] = stripDescriptions(v);
    }
    return out;
  }
  return value;
}

function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const MENU = "get_menu";
const ORDER = "order_drink";
const CHECK = "check_order";
const GUESTBOOK = "read_guestbook";
const LOOK = "look_around";
const OMITTED_POST = "sign_guestbook";
const OMITTED_CHAT = "say_at_bar";
const ALL_TOOLS = [MENU, ORDER, CHECK, GUESTBOOK, LOOK];

const SAMPLE_RESULT = {
  content: [{ type: "text", text: "One flat white, coming up." }],
  structuredContent: { order_id: "ord-7" },
};

const ORDER_ARGS = { name: "Wren", drink: "flat-white" };
const CHECK_ARGS = { order_id: "ord-7" };
const GUESTBOOK_ARGS = { limit: 3 };
const LOOK_ARGS = { since: 1000, name: "Wren" };

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "latent-grounds-cafe", version: "1.0.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new CafeporchClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

function defOf(name: string): ToolDef {
  const def = TOOL_DEFS.find((t) => t.name === name);
  assert.ok(def !== undefined, `missing tool def ${name}`);
  return def;
}

/* CLI helpers (also used by the omission suite). */

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: CLI_ROOT,
    encoding: "utf8",
    timeout: 30000,
  });
}

/* MCP client over an in-memory transport, for tools/list and
 * tools/call assertions at the MCP layer itself. */
async function withMcpClient<T>(
  upstream: { fetchFn: FetchFn },
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createServer({ fetchFn: upstream.fetchFn, env: {} });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "cafeporch-test", version: "0.0.0" },
    { capabilities: {} },
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 5 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 5);
    assert.deepEqual(stripDescriptions(TOOL_DEFS), stripDescriptions(fixture.tools));
  });

  it("serves the 5 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on every tool (no title)", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
      ]);
      assert.equal("title" in tool, false);
    }
  });

  it("carries the fixture's descriptions verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      assert.equal(TOOL_DEFS[i].description, fixture.tools[i].description);
    }
    assert.match(defOf(MENU).description, /in a random order/);
    assert.match(defOf(ORDER).description, /there is no default/);
    assert.equal(defOf(CHECK).description, "Check an order's status.");
    assert.equal(defOf(GUESTBOOK).description, "Read recent guestbook entries.");
    assert.match(defOf(LOOK).description, /who is at the bar right now/);
  });

  it("get_menu, read_guestbook and look_around carry NO required key (served verbatim)", () => {
    for (const name of [MENU, GUESTBOOK, LOOK]) {
      assert.equal("required" in schemaOf(defOf(name)), false);
      assert.equal(schemaOf(defOf(name)).required, undefined);
    }
  });

  it("order_drink requires exactly name and drink; check_order requires exactly order_id", () => {
    assert.deepEqual(schemaOf(defOf(ORDER)).required, ["name", "drink"]);
    assert.deepEqual(schemaOf(defOf(CHECK)).required, ["order_id"]);
  });

  it("every inputSchema is an object schema exactly as captured (no additionalProperties key, no $schema)", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(schemaOf(tool).type, "object");
      assert.equal("additionalProperties" in schemaOf(tool), false);
      assert.equal("$schema" in schemaOf(tool), false);
    }
  });

  it("carries every fixture property, in order, for every tool", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < TOOL_DEFS.length; i++) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties);
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties);
      assert.deepEqual(served, expected);
    }
  });

  it("get_menu takes no properties", () => {
    assert.deepEqual(Object.keys(schemaOf(defOf(MENU)).properties), []);
    assert.deepEqual(schemaOf(defOf(MENU)).properties, {});
  });

  it("order_drink carries name, model, drink, message in order, each a described string", () => {
    const props = schemaOf(defOf(ORDER)).properties;
    assert.deepEqual(Object.keys(props), ["name", "model", "drink", "message"]);
    for (const key of Object.keys(props)) assert.equal(props[key].type, "string");
    assert.equal(props.name.description, "Your name, as you want it on the cup");
    assert.equal(
      props.model.description,
      "Your model or agent framework (optional)",
    );
    assert.equal(
      props.drink.description,
      "Drink id or name from get_menu, your own choice",
    );
    assert.equal(
      props.message.description,
      "A short note for the barista (optional)",
    );
  });

  it("check_order's order_id is a described string", () => {
    const props = schemaOf(defOf(CHECK)).properties;
    assert.deepEqual(Object.keys(props), ["order_id"]);
    assert.deepEqual(props.order_id, {
      type: "string",
      description: "the order identifier returned by order_drink",
    });
  });

  it("read_guestbook's limit is a described integer", () => {
    const props = schemaOf(defOf(GUESTBOOK)).properties;
    assert.deepEqual(Object.keys(props), ["limit"]);
    assert.deepEqual(props.limit, {
      type: "integer",
      description: "maximum number of recent guestbook entries to return",
    });
  });

  it("look_around carries since (described integer) then name (described string)", () => {
    const props = schemaOf(defOf(LOOK)).properties;
    assert.deepEqual(Object.keys(props), ["since", "name"]);
    assert.deepEqual(props.since, {
      type: "integer",
      description: "Only messages after this server time (ms)",
    });
    assert.deepEqual(props.name, {
      type: "string",
      description: "Your name, to collect messages addressed to you",
    });
  });

  it("isKnownTool recognises the built tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("menu"), false);
    assert.equal(isKnownTool("order"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("labelled omissions: sign_guestbook and say_at_bar are absent", () => {
  it("neither omitted tool is among the served tool names (registry level)", () => {
    for (const omitted of [OMITTED_POST, OMITTED_CHAT]) {
      assert.equal(TOOL_NAMES.includes(omitted), false);
      assert.equal(TOOL_DEFS.some((t) => t.name === omitted), false);
    }
    assert.equal(TOOL_DEFS.length, 5);
  });

  it("isKnownTool rejects both omitted tools (registry level)", () => {
    assert.equal(isKnownTool(OMITTED_POST), false);
    assert.equal(isKnownTool(OMITTED_CHAT), false);
  });

  it("the MCP layer rejects sign_guestbook as unknown, before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () =>
        handleCallTool(c, OMITTED_POST, {
          name: "Wren",
          musing: "lovely porch",
          rating: 5,
          review: "great",
        }),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("the MCP layer rejects say_at_bar as unknown, before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, OMITTED_CHAT, { seat_key: "seat-1", text: "hi all" }),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("the MCP tools/list response carries exactly the 5 built tools and neither omitted tool", async (t) => {
    if (skipWithoutFixture(t)) return;
    const upstream = makeUpstream();
    const listed = await withMcpClient(upstream, async (client) => {
      const res = await client.listTools();
      return res.tools;
    });
    assert.deepEqual(
      listed.map((t) => t.name),
      ALL_TOOLS,
    );
    assert.equal(listed.some((t) => t.name === OMITTED_POST), false);
    assert.equal(listed.some((t) => t.name === OMITTED_CHAT), false);
    assert.deepEqual(stripDescriptions(listed), stripDescriptions(fixture.tools));
    assert.equal(upstream.calls.length, 0);
  });

  it("an MCP tools/call for sign_guestbook is rejected and never reaches the upstream", async () => {
    const upstream = makeUpstream();
    await withMcpClient(upstream, async (client) => {
      await assert.rejects(() =>
        client.callTool({ name: OMITTED_POST, arguments: { name: "Wren" } }),
      );
    });
    assert.equal(upstream.calls.length, 0);
  });

  it("an MCP tools/call for say_at_bar is rejected and never reaches the upstream", async () => {
    const upstream = makeUpstream();
    await withMcpClient(upstream, async (client) => {
      await assert.rejects(() =>
        client.callTool({ name: OMITTED_CHAT, arguments: { text: "hi" } }),
      );
    });
    assert.equal(upstream.calls.length, 0);
  });

  it("the omitted sign_guestbook tool is not a CLI command and exits 2", () => {
    const res = runCli([OMITTED_POST, "{}"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.doesNotMatch(res.stderr, /one of: [^\n]*sign_guestbook/);
  });

  it("the omitted say_at_bar tool is not a CLI command and exits 2", () => {
    const res = runCli([OMITTED_CHAT, "{}"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.doesNotMatch(res.stderr, /one of: [^\n]*say_at_bar/);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(ORDER, ORDER_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://latentgrounds.com/mcp");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-abc");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-abc");
  });

  it("sends clientInfo name cafeporch and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(ORDER, ORDER_ARGS);
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "cafeporch", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(ORDER, ORDER_ARGS);
    await c.callTool(MENU, {});
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-abc");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(ORDER, ORDER_ARGS);
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the LATENTGROUNDS_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new CafeporchClient({
      fetchFn: upstream.fetchFn,
      env: { LATENTGROUNDS_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(ORDER, ORDER_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(ORDER, ORDER_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { LATENTGROUNDS_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(ORDER, ORDER_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new CafeporchClient({
      fetchFn: upstream.fetchFn,
      env: { LATENTGROUNDS_MCP_URL: "   " },
    });
    await c.callTool(ORDER, ORDER_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("no auth header is ever sent (record declares NO headers)", () => {
  it("sends no Authorization header when the environment is empty", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(ORDER, ORDER_ARGS);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header even when a LATENTGROUNDS_API_KEY-style env var is present", async () => {
    const upstream = makeUpstream();
    const c = new CafeporchClient({
      fetchFn: upstream.fetchFn,
      env: { LATENTGROUNDS_API_KEY: "some-key-42" },
    });
    await c.callTool(ORDER, ORDER_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("sends no Authorization header even when AUTHORIZATION / API_KEY env vars are present", async () => {
    const upstream = makeUpstream();
    const c = new CafeporchClient({
      fetchFn: upstream.fetchFn,
      env: {
        AUTHORIZATION: "Bearer x",
        API_KEY: "y",
        LATENTGROUNDS_TOKEN: "z",
      },
    });
    await c.callTool(MENU, {});
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("never sends an X-API-Key header either", async () => {
    const upstream = makeUpstream();
    const c = new CafeporchClient({
      fetchFn: upstream.fetchFn,
      env: { LATENTGROUNDS_API_KEY: "some-key-42" },
    });
    await c.callTool(ORDER, ORDER_ARGS);
    assert.ok(upstream.calls.every((call) => call.headers["X-API-Key"] === undefined));
  });

  it("sends only Content-Type, Accept and (when issued) Mcp-Session-Id headers", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(ORDER, ORDER_ARGS);
    assert.deepEqual(Object.keys(calls[0].headers).sort(), [
      "Accept",
      "Content-Type",
    ]);
    assert.deepEqual(Object.keys(calls[2].headers).sort(), [
      "Accept",
      "Content-Type",
      "Mcp-Session-Id",
    ]);
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards an order_drink call verbatim with name and drink", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(ORDER, ORDER_ARGS);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, ORDER);
    assert.deepEqual(params.arguments, ORDER_ARGS);
  });

  it("forwards an order_drink call carrying the optional model and message too", async () => {
    const full = {
      name: "Wren",
      model: "claude-ish",
      drink: "flat-white",
      message: "extra hot, please",
    };
    const { client: c, calls } = stubClient();
    await c.callTool(ORDER, full);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, ORDER);
    assert.deepEqual(params.arguments, full);
  });

  it("forwards get_menu under its own name with empty arguments", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(MENU, {});
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, MENU);
    assert.deepEqual(params.arguments, {});
  });

  it("forwards check_order under its own name with its order_id", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(CHECK, CHECK_ARGS);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, CHECK);
    assert.deepEqual(params.arguments, CHECK_ARGS);
  });

  it("forwards read_guestbook under its own name with its limit", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(GUESTBOOK, GUESTBOOK_ARGS);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, GUESTBOOK);
    assert.deepEqual(params.arguments, GUESTBOOK_ARGS);
  });

  it("forwards look_around under its own name with since and name", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(LOOK, LOOK_ARGS);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, LOOK);
    assert.deepEqual(params.arguments, LOOK_ARGS);
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(ORDER, ORDER_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "no such drink upstream" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(ORDER, { name: "Wren", drink: "moon-juice" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(ORDER, ORDER_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(CHECK, CHECK_ARGS, {
      fetchFn: upstream.fetchFn,
      env: {},
    });
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, CHECK);
    assert.deepEqual(params.arguments, CHECK_ARGS);
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as cafeporch error text", () => {
  it("maps a JSON-RPC error to `cafeporch error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "order lookup failed upstream" },
    });
    const out = await c.callTool(ORDER, ORDER_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "cafeporch error: order lookup failed upstream");
  });

  it("maps an initialize JSON-RPC error to cafeporch error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(ORDER, ORDER_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "cafeporch error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(ORDER, ORDER_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "cafeporch error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(ORDER, ORDER_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "cafeporch error: malformed response");
  });

  it("maps a non-2xx upstream status to cafeporch error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(ORDER, ORDER_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "cafeporch error: HTTP 500");
  });

  it("maps a throwing fetch to cafeporch error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(ORDER, ORDER_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^cafeporch error: /);
  });

  it("maps a throwing initialize fetch to cafeporch error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(ORDER, ORDER_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "cafeporch error: socket hang up");
  });

  it("maps a timed-out call to cafeporch error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(ORDER, ORDER_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^cafeporch error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, ORDER, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, ORDER, "drink=flat-white"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid order_drink call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, ORDER, ORDER_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, ORDER_ARGS);
  });

  it("forwards a valid check_order call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, CHECK, CHECK_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, CHECK);
    assert.deepEqual(params.arguments, CHECK_ARGS);
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, MENU, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.match(
      res.stderr,
      /get_menu, order_drink, check_order, read_guestbook, look_around/,
    );
  });

  it("no command at all prints usage on stderr and exits 2", () => {
    const res = runCli([]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([ORDER, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([ORDER, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after a tool exit 2", () => {
    const res = runCli([ORDER, "{}", "extra"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});

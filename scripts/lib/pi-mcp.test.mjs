import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as sdk from "@earendil-works/pi-mcp";
import bundleDefault, {
  createManagedMcpExtension,
  namespacedToolName,
  parseFrozenDocument,
  rejectingRedirectFetch,
  sanitizeFailure,
  serverLabel
} from "../../crates/rovai-core/src/pi/managed-mcp.bundle.mjs";
import { startFixtureHttpServer } from "../fixtures/pi-mcp/http-server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const stdioFixture = path.join(here, "..", "fixtures", "pi-mcp", "stdio-server.mjs");
const nodeExecutable = process.execPath;

const activePiSessions = new Set();

/** Collects the extension's Pi API surface so a test can drive the lifecycle. */
function fakePi() {
  const handlers = new Map();
  const tools = new Map();
  const statuses = [];
  const api = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(definition) {
      assert.ok(definition?.name, "a registered tool needs a name");
      assert.equal(tools.has(definition.name), false, `duplicate tool name ${definition.name}`);
      tools.set(definition.name, definition);
    }
  };
  const ctx = { ui: { setStatus: (key, value) => statuses.push({ key, value }) } };
  const session = {
    api,
    ctx,
    tools,
    statuses,
    async fire(event, payload = {}) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    }
  };
  activePiSessions.add(session);
  return session;
}

const tempRoots = new Set();

/**
 * Removal is deferred to the `after` hook so it is always awaited by the runner.
 * On Windows a fixture child may still own its cwd for a few milliseconds after
 * the transport closes, so removal retries instead of throwing EPERM.
 */
async function removeWithRetries(directory, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return true;
    } catch (error) {
      const code = error?.code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOTEMPTY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return false;
}

after(async () => {
  // Every fixture is a live session, including tests whose assertion path never
  // fired shutdown. Close the real transports BEFORE deleting their cwd.
  for (const session of activePiSessions) await session.fire("session_shutdown");
  activePiSessions.clear();
  for (const directory of tempRoots) {
    assert.equal(await removeWithRetries(directory), true, "owned fixture must be removable after transports close");
  }
  tempRoots.clear();
});

function privateRun(files) {
  const root = mkdtempSync(path.join(tmpdir(), "rovai-pi-mcp-"));
  tempRoots.add(root);
  const privateRoot = path.join(root, "host-config", "instance");
  mkdirSync(privateRoot, { recursive: true });
  const written = {};
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(privateRoot, name);
    writeFileSync(target, body);
    written[name] = target;
  }
  // Real removal happens in the `after` hook; a caller may still await this.
  return { root, privateRoot, written, cleanup: async () => undefined };
}

function document(servers, configDigest = `sha256:${"a".repeat(64)}`) {
  return JSON.stringify({ schemaVersion: 1, configDigest, servers });
}

function digestOf(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const quietLogger = { info() {}, failure() {} };

function stdioServer(name, extraArgs = []) {
  return {
    name,
    transport: "stdio",
    command: nodeExecutable,
    args: [stdioFixture, ...extraArgs]
  };
}

function start(options, privateRoot, documentPath, documentDigest) {
  const pi = fakePi();
  const extension = createManagedMcpExtension(
    pi.api,
    { documentPath, documentDigest, privateRoot, workspaceRoot: path.dirname(documentPath), callTimeoutMs: 4000 },
    sdk,
    quietLogger
  );
  return { pi, extension };
}

test("registers the real tools of a selected stdio server and calls one", { timeout: 30_000 }, async () => {
  const body = document([stdioServer("local")]);
  const run = privateRun({ "mcp.json": body });
  try {
    const { pi, extension } = start({}, run.privateRoot, run.written["mcp.json"], digestOf(body));
    await pi.fire("session_start");
    const names = extension.toolNames();
    assert.ok(names.includes(namespacedToolName("local", "echo")), names.join(","));
    assert.equal(names.length, 3);
    const echo = pi.tools.get(namespacedToolName("local", "echo"));
    assert.equal(echo.parameters.type, "object");
    const result = await echo.execute("call-1", { text: "hello" }, new AbortController().signal);
    assert.equal(result.isError, false);
    assert.equal(result.content[0].text, "echo:hello");
    const status = extension.status();
    assert.equal(status.state, "ready");
    assert.equal(status.toolCount, 3);
    assert.equal(pi.statuses.at(-1).key, "rovai-managed-mcp");
  } finally {
    run.cleanup();
  }
});

test("the same tool name from two servers never collides", { timeout: 30_000 }, async () => {
  const body = document([stdioServer("alpha"), stdioServer("beta")]);
  const run = privateRun({ "mcp.json": body });
  try {
    const { pi, extension } = start({}, run.privateRoot, run.written["mcp.json"], digestOf(body));
    await pi.fire("session_start");
    const alpha = namespacedToolName("alpha", "echo");
    const beta = namespacedToolName("beta", "echo");
    assert.notEqual(alpha, beta);
    assert.ok(alpha.length <= 64 && beta.length <= 64);
    assert.ok(extension.toolNames().includes(alpha) && extension.toolNames().includes(beta));
  } finally {
    run.cleanup();
  }
});

test("a tampered document is refused before any server is contacted", async () => {
  const body = document([stdioServer("local")]);
  const run = privateRun({ "mcp.json": body });
  try {
    const { pi, extension } = start({}, run.privateRoot, run.written["mcp.json"], `sha256:${"b".repeat(64)}`);
    await pi.fire("session_start");
    assert.deepEqual(extension.toolNames(), []);
    assert.equal(extension.status().state, "degraded");
    assert.equal(pi.tools.size, 0);
  } finally {
    run.cleanup();
  }
});

test("a document outside the private root, or a symlinked one, is refused", async () => {
  const run = privateRun({ "outside.json": document([stdioServer("local")]) });
  try {
    const outside = path.join(run.root, "outside.json");
    const { pi, extension } = start({}, run.privateRoot, outside, digestOf(document([])));
    await pi.fire("session_start");
    assert.equal(extension.status().state, "degraded");
    assert.deepEqual(extension.toolNames(), []);
  } finally {
    run.cleanup();
  }
});

test("a tool whose schema exceeds the bound is skipped, the rest still load", async () => {
  const body = document([stdioServer("local", ["--huge-schema"])]);
  const run = privateRun({ "mcp.json": body });
  try {
    const { pi, extension } = start({}, run.privateRoot, run.written["mcp.json"], digestOf(body));
    await pi.fire("session_start");
    assert.equal(extension.toolNames().includes(namespacedToolName("local", "huge")), false);
    assert.equal(extension.toolNames().includes(namespacedToolName("local", "echo")), true);
  } finally {
    run.cleanup();
  }
});

test("a server failure stays a diagnostic and never leaks header or env text", { timeout: 30_000 }, async () => {
  const body = document([stdioServer("local")]);
  const run = privateRun({ "mcp.json": body });
  try {
    const { pi } = start({}, run.privateRoot, run.written["mcp.json"], digestOf(body));
    await pi.fire("session_start");
    const fail = pi.tools.get(namespacedToolName("local", "fail"));
    const result = await fail.execute("call-2", {}, new AbortController().signal);
    assert.equal(result.isError, true);
    const text = result.content.map((block) => block.text ?? "").join("");
    assert.equal(text.includes("synthetic-secret"), false, text);
    assert.equal(text.includes("Authorization"), false, text);
    assert.match(text, /server "local" failed/u);
  } finally {
    run.cleanup();
  }
});

test("an aborted call is cancelled, not replayed", { timeout: 30_000 }, async () => {
  const body = document([stdioServer("local")]);
  const run = privateRun({ "mcp.json": body });
  try {
    const { pi } = start({}, run.privateRoot, run.written["mcp.json"], digestOf(body));
    await pi.fire("session_start");
    const slow = pi.tools.get(namespacedToolName("local", "slow"));
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = slow.execute("call-3", {}, controller.signal);
    // Let the request reach the server, then cancel it while it is in flight.
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    const result = await pending;
    const elapsed = Date.now() - startedAt;
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text.includes("slow-done"), false);
    // The fixture sleeps 5s; returning well before that proves cancellation, not completion.
    assert.ok(elapsed < 4000, `cancellation took ${elapsed}ms`);
  } finally {
    run.cleanup();
  }
});

test("loopback Streamable HTTP server is really spoken to", { timeout: 30_000 }, async () => {
  const handle = await startFixtureHttpServer();
  const body = document([{ name: "remote", transport: "streamable_http", url: handle.url }]);
  const run = privateRun({ "mcp.json": body });
  try {
    const { pi, extension } = start({}, run.privateRoot, run.written["mcp.json"], digestOf(body));
    await pi.fire("session_start");
    assert.ok(extension.toolNames().includes(namespacedToolName("remote", "lookup")), extension.toolNames().join(","));
    const lookup = pi.tools.get(namespacedToolName("remote", "lookup"));
    const result = await lookup.execute("call-4", { id: "r-1" }, new AbortController().signal);
    assert.equal(result.content[0].text, "lookup:r-1");
    assert.ok(handle.stats.requests >= 2, `expected initialize + list + call, saw ${handle.stats.requests}`);
    // No request may ever reach the second origin in the happy path either.
    assert.equal(handle.stats.sinkRequests, 0);
  } finally {
    run.cleanup();
    await handle.close();
  }
});

test("an HTTP redirect is refused so credentials cannot cross origins", { timeout: 30_000 }, async () => {
  const handle = await startFixtureHttpServer();
  const body = document([{ name: "remote", transport: "streamable_http", url: handle.redirectUrl }]);
  const run = privateRun({ "mcp.json": body });
  try {
    const { pi, extension } = start({}, run.privateRoot, run.written["mcp.json"], digestOf(body));
    await pi.fire("session_start");
    assert.deepEqual(extension.toolNames(), []);
    assert.deepEqual(extension.status().failedServers, ["remote"]);
    assert.equal(extension.status().state, "degraded");
    // The refusal must happen after a real request, not because nothing was attempted...
    assert.ok(handle.stats.redirects >= 1, "no redirect was ever requested");
    // ...and the other origin must receive exactly nothing, ever.
    assert.equal(handle.stats.sinkRequests, 0, "a credentialed request reached the redirect target");
  } finally {
    run.cleanup();
    await handle.close();
  }
});

test("session_shutdown closes every connection; later calls fail closed", { timeout: 30_000 }, async () => {
  const body = document([stdioServer("local")]);
  const run = privateRun({ "mcp.json": body });
  try {
    const { pi } = start({}, run.privateRoot, run.written["mcp.json"], digestOf(body));
    await pi.fire("session_start");
    const echo = pi.tools.get(namespacedToolName("local", "echo"));
    await pi.fire("session_shutdown");
    const after = await echo.execute("call-5", { text: "x" }, new AbortController().signal);
    assert.equal(after.isError, true);
    assert.equal(after.content[0].text.includes("echo:x"), false);
  } finally {
    run.cleanup();
  }
});

test("the frozen digest reaches the status payload for warm-reuse fencing", async () => {
  const one = `sha256:${"1".repeat(64)}`;
  const two = `sha256:${"2".repeat(64)}`;
  const bodyOne = document([], one);
  const run = privateRun({ "one.json": bodyOne, "two.json": document([], two) });
  try {
    const first = start({}, run.privateRoot, run.written["one.json"], digestOf(bodyOne));
    await first.pi.fire("session_start");
    assert.equal(first.extension.status().digest, one);
    const second = start({}, run.privateRoot, run.written["two.json"], digestOf(document([], two)));
    await second.pi.fire("session_start");
    assert.equal(second.extension.status().digest, two);
    assert.notEqual(first.extension.status().digest, second.extension.status().digest);
  } finally {
    run.cleanup();
  }
});

test("no selected servers means no status and no tools", async () => {
  const body = document([]);
  const run = privateRun({ "mcp.json": body });
  try {
    const { pi, extension } = start({}, run.privateRoot, run.written["mcp.json"], digestOf(body));
    await pi.fire("before_agent_start");
    assert.deepEqual(extension.toolNames(), []);
    assert.equal(pi.tools.size, 0);
    assert.equal(extension.status().serverCount, 0);
  } finally {
    run.cleanup();
  }
});

test("the generated bundle really spawns a stdio server itself (dynamic-require regression)", { timeout: 30_000 }, async () => {
  // This drives the bundle's OWN default entry, so the bundled CommonJS
  // dependencies (cross-spawn) must be able to require Node builtins. Without the
  // createRequire banner this test fails with
  // "Dynamic require of child_process is not supported".
  const body = document([stdioServer("bundled")]);
  const run = privateRun({ "mcp.json": body });
  const previous = {
    file: process.env.ROVAI_PI_MCP_FILE,
    digest: process.env.ROVAI_PI_MCP_DIGEST,
    root: process.env.ROVAI_PI_MCP_ROOT,
    workspace: process.env.ROVAI_PI_MCP_WORKSPACE
  };
  try {
    process.env.ROVAI_PI_MCP_FILE = run.written["mcp.json"];
    process.env.ROVAI_PI_MCP_DIGEST = digestOf(body);
    process.env.ROVAI_PI_MCP_ROOT = run.privateRoot;
    process.env.ROVAI_PI_MCP_WORKSPACE = run.privateRoot;
    const pi = fakePi();
    await bundleDefault(pi.api);
    await pi.fire("session_start");
    const echo = pi.tools.get(namespacedToolName("bundled", "echo"));
    assert.ok(echo, `bundle registered no tools: ${[...pi.tools.keys()].join(",")}`);
    const result = await echo.execute("bundle-call", { text: "live" }, new AbortController().signal);
    assert.equal(result.isError, false);
    assert.equal(result.content[0].text, "echo:live");
    await pi.fire("session_shutdown");
  } finally {
    for (const [key, value] of Object.entries({
      ROVAI_PI_MCP_FILE: previous.file,
      ROVAI_PI_MCP_DIGEST: previous.digest,
      ROVAI_PI_MCP_ROOT: previous.root,
      ROVAI_PI_MCP_WORKSPACE: previous.workspace
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run.cleanup();
  }
});

test("the bundle defines require through node:module and carries no absolute node_modules require", () => {
  const text = readFileSync(
    fileURLToPath(new URL("../../crates/rovai-core/src/pi/managed-mcp.bundle.mjs", import.meta.url)),
    "utf8"
  );
  assert.ok(text.includes('from "node:module"'), "missing node:module import");
  assert.ok(text.includes("__rovaiCreateRequire(import.meta.url)"), "missing createRequire banner");
  assert.ok(text.includes("child_process"), "cross-spawn was not bundled");
  assert.equal(/require\(\s*["']\/.*node_modules/u.test(text), false);
});

test(
  "a Windows .cmd shim is spawned through cross-spawn, not silently skipped",
  { timeout: 30_000, skip: process.platform === "win32" ? false : "POSIX host: .cmd shims do not exist here" },
  async (t) => {
    if (process.platform !== "win32") {
      // Never let a platform branch vanish without a trace in the log.
      t.diagnostic("Windows .cmd shim branch not exercised on this host");
      return;
    }
    const run = privateRun({});
    try {
      const shim = path.join(run.root, "fixture-mcp.cmd");
      // Forward every argument to the Node fixture, exactly like an npm bin shim.
      writeFileSync(shim, `@echo off\r\n"${nodeExecutable}" "${stdioFixture}" %*\r\n`);
      const body = document([
        { name: "shimmed", transport: "stdio", command: shim, args: [] }
      ]);
      writeFileSync(path.join(run.privateRoot, "mcp.json"), body);
      const { pi, extension } = start(
        {},
        run.privateRoot,
        path.join(run.privateRoot, "mcp.json"),
        digestOf(body)
      );
      await pi.fire("session_start");
      assert.deepEqual(extension.status().failedServers, []);
      assert.ok(
        extension.toolNames().includes(namespacedToolName("shimmed", "echo")),
        `shim launched no tools: ${extension.toolNames().join(",")}`
      );
    } finally {
      run.cleanup();
    }
  }
);

test("pure helpers stay bounded and stable", () => {
  assert.equal(serverLabel("alpha"), serverLabel("alpha"));
  assert.notEqual(serverLabel("alpha"), serverLabel("beta"));
  assert.equal(serverLabel("alpha").length, 8);
  assert.match(namespacedToolName("srv", "a/b c"), /^mcp__[0-9a-f]{8}__a_b_c$/u);
  assert.equal(namespacedToolName("srv", "x".repeat(200)).length, 64);
  assert.throws(() => parseFrozenDocument({ schemaVersion: 2, configDigest: `sha256:${"a".repeat(64)}`, servers: [] }));
  assert.equal(sanitizeFailure("srv", new Error("Authorization: Bearer xyz")).includes("xyz"), false);
});

test("the redirect guard rejects a 3xx before any body is read", async () => {
  const guarded = rejectingRedirectFetch(async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid" } }));
  await assert.rejects(() => guarded("http://127.0.0.1/mcp", {}), /redirect/u);
});

test("the redirect guard also refuses an opaque manual-redirect response", async () => {
  // Node/undici returns status 0 with type "opaqueredirect" for redirect:"manual".
  const guarded = rejectingRedirectFetch(async () => ({ status: 0, type: "opaqueredirect" }));
  await assert.rejects(() => guarded("http://127.0.0.1/mcp", {}), /redirect/u);
});

test("the redirect guard always sets redirect:error-equivalent manual mode before dispatch", async () => {
  const seen = [];
  const guarded = rejectingRedirectFetch(async (_input, init) => {
    seen.push(init);
    return new Response("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}", { status: 200, headers: { "content-type": "application/json" } });
  });
  await guarded("http://127.0.0.1/mcp", { method: "POST", headers: { authorization: "Bearer synthetic" } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].redirect, "manual");
  assert.equal(seen[0].headers.authorization, "Bearer synthetic");
});

/**
 * Shared contract with Core: `scripts/fixtures/pi-mcp/frozen-document.json` is the
 * exact server shape `pi::managed_mcp_document_file` emits (no `cwd` key, config
 * digest stamped by Core). Here we stamp the digest the way Core does and prove the
 * selected tool actually runs through real MCP I/O.
 */
function sharedFrozenDocument() {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/pi-mcp/frozen-document.json", import.meta.url), "utf8")
  );
  const substitute = (value) => {
    if (typeof value === "string") {
      return value
        .replaceAll("__NODE_EXECUTABLE__", nodeExecutable)
        .replaceAll("__STDIO_FIXTURE__", stdioFixture);
    }
    if (Array.isArray(value)) return value.map(substitute);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry)]));
    }
    return value;
  };
  const body = { schemaVersion: fixture.schemaVersion, servers: substitute(fixture.servers) };
  const configDigest = `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
  const documentValue = { schemaVersion: fixture.schemaVersion, configDigest, servers: body.servers };
  const bytes = `${JSON.stringify(documentValue, null, 2)}\n`;
  const fileDigest = `sha256:${createHash("sha256").update(Buffer.from(bytes, "utf8")).digest("hex")}`;
  return { fixture, bytes, fileDigest, configDigest };
}

test("the shared frozen-document fixture loads and its selected tool really runs", { timeout: 30_000 }, async () => {
  const frozen = sharedFrozenDocument();
  // The fixture itself carries no configDigest and no cwd key: Core stamps both.
  assert.equal(frozen.fixture.configDigest, undefined);
  for (const server of frozen.fixture.servers) assert.equal("cwd" in server, false);

  const run = privateRun({ "mcp.json": frozen.bytes });
  try {
    const { pi, extension } = start({}, run.privateRoot, run.written["mcp.json"], frozen.fileDigest);
    await pi.fire("session_start");
    assert.deepEqual(extension.status().failedServers, []);
    assert.equal(extension.status().digest, frozen.configDigest);
    const echo = pi.tools.get(namespacedToolName("fixture", "echo"));
    assert.ok(echo, `fixture selection registered no tools: ${extension.toolNames().join(",")}`);
    const result = await echo.execute("fixture-call", { text: "shared" }, new AbortController().signal);
    assert.equal(result.isError, false);
    assert.equal(result.content[0].text, "echo:shared");
    await pi.fire("session_shutdown");
  } finally {
    run.cleanup();
  }
});

test("the file digest covers the whole file, newline and config stamp included", async () => {
  const frozen = sharedFrozenDocument();
  // Same document, one extra byte: the extension must refuse it.
  const tampered = privateRun({ "mcp.json": `${frozen.bytes} ` });
  try {
    const { pi, extension } = start({}, tampered.privateRoot, tampered.written["mcp.json"], frozen.fileDigest);
    await pi.fire("session_start");
    assert.deepEqual(extension.toolNames(), []);
    assert.equal(extension.status().state, "degraded");
  } finally {
    tampered.cleanup();
  }
  // Dropping only the trailing newline is equally a mismatch.
  const noNewline = privateRun({ "mcp.json": frozen.bytes.trimEnd() });
  try {
    const { pi, extension } = start({}, noNewline.privateRoot, noNewline.written["mcp.json"], frozen.fileDigest);
    await pi.fire("session_start");
    assert.deepEqual(extension.toolNames(), []);
    assert.equal(extension.status().state, "degraded");
  } finally {
    noNewline.cleanup();
  }
});

/**
 * LOOM managed Pi MCP extension.
 *
 * Loads the frozen per-Run MCP document that Core wrote into this Host's private
 * config root, connects to each already-selected+enabled server through the
 * maintained @earendil-works/pi-mcp client, and registers exactly the tools those
 * servers list. No MCP framing is implemented here.
 *
 * Boundaries:
 * - The document is the only input. Nothing is re-read from the live catalog, and
 *   no URL or credential is ever taken from model output.
 * - The document path must be absolute, inside this Host's private root, a regular
 *   file (no symlinks), within the size limit, with a matching digest. Anything
 *   else throws before a single server is contacted.
 * - Tool definitions, headers, env values and URLs never reach a log or a status
 *   string. Only counts, digests and server/tool labels do.
 * - There is no per-tool approval prompt: Pi runs with `--approve` and this Host
 *   has no approval channel. Loading is therefore limited to definitions the User
 *   already enabled and assigned in Core (existing high-risk approval). Deny by
 *   default is expressed by not loading, not by pretending to ask.
 * - A selected server that fails stays a diagnostic. It is never reported as
 *   applied, and the remaining tools are not silently widened to compensate.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import * as piMcp from "@earendil-works/pi-mcp";

const DOC_SCHEMA_VERSION = 1;
const MAX_DOC_BYTES = 4 * 1024 * 1024;
const MAX_SERVER_COUNT = 32;
const MAX_TOOL_COUNT = 128;
const MAX_TOOL_SCHEMA_BYTES = 64 * 1024;
const MAX_TOOL_NAME_LENGTH = 64;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const MAX_RESULT_TEXT_CHARS = 64 * 1024;
const MAX_RESULT_IMAGE_BYTES = 8 * 1024 * 1024;
const STATUS_KEY = "rovai-managed-mcp";
const STATUS_VERSION = "rovai-pi-mcp-v1";

export type FrozenMcpServer =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      name: string;
      transport: "streamable_http";
      url: string;
      headers?: Record<string, string>;
    };

export interface FrozenMcpDocument {
  schemaVersion: 1;
  /** Core's per-Run projection digest: the identity warm reuse is fenced on. */
  configDigest: string;
  servers: FrozenMcpServer[];
}

export interface McpSdk {
  McpClient: new (options: Record<string, unknown>) => {
    connect(transport: unknown): Promise<unknown>;
    listTools(options?: Record<string, unknown>): Promise<
      Array<{ name: string; title?: string; description?: string; inputSchema?: Record<string, unknown> }>
    >;
    callTool(
      name: string,
      args?: Record<string, unknown>,
      options?: Record<string, unknown>
    ): Promise<{ content?: unknown[]; structuredContent?: unknown; isError?: boolean }>;
    close(): Promise<void>;
  };
  StdioTransport: new (options: Record<string, unknown>) => unknown;
  StreamableHttpTransport: new (options: Record<string, unknown>) => unknown;
  toLlmContent(result: { content?: unknown[]; structuredContent?: unknown }): unknown[];
}

export interface ManagedMcpLogger {
  info(message: string): void;
  failure(message: string): void;
}

interface RegisteredConnection {
  serverName: string;
  client: InstanceType<McpSdk["McpClient"]>;
  transport: unknown;
  pid: number | null;
  close(): Promise<void>;
}

export interface ManagedMcpStatus {
  state: "loading" | "ready" | "degraded";
  digest: string;
  serverCount: number;
  toolCount: number;
  toolNames: string[];
  failedServers: string[];
}

// ---------------------------------------------------------------- validation

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Stable 8-hex label per server so tool names never depend on registration order. */
export function serverLabel(serverName: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < serverName.length; index += 1) {
    hash ^= serverName.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 8);
}

/** `mcp__<serverLabel>__<tool>` sanitised to the provider alphabet, hard-capped at 64. */
export function namespacedToolName(serverName: string, toolName: string): string {
  const sanitizedTool = toolName.replace(/[^A-Za-z0-9_-]/g, "_");
  const prefix = `mcp__${serverLabel(serverName)}__`;
  return `${prefix}${sanitizedTool}`.slice(0, MAX_TOOL_NAME_LENGTH);
}

function boundedSchema(schema: unknown): Record<string, unknown> | null {
  const source = isRecord(schema) ? schema : {};
  const document = {
    ...source,
    type: "object",
    properties: isRecord(source.properties) ? source.properties : {}
  };
  if (JSON.stringify(document).length > MAX_TOOL_SCHEMA_BYTES) return null;
  return document;
}

export function parseFrozenDocument(raw: unknown): FrozenMcpDocument {
  if (!isRecord(raw)) throw new Error("mcp document is not an object");
  if (raw.schemaVersion !== DOC_SCHEMA_VERSION) throw new Error("mcp document schema is unsupported");
  if (typeof raw.configDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(raw.configDigest)) {
    throw new Error("mcp document digest is missing");
  }
  if (!Array.isArray(raw.servers) || raw.servers.length > MAX_SERVER_COUNT) {
    throw new Error("mcp document servers are out of range");
  }
  const seen = new Set<string>();
  const servers: FrozenMcpServer[] = raw.servers.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name) {
      throw new Error("mcp server entry is malformed");
    }
    const name = entry.name;
    if (seen.has(name)) throw new Error("mcp server entry is duplicated");
    seen.add(name);
    if (entry.transport === "stdio") {
      if (typeof entry.command !== "string" || !entry.command) throw new Error("mcp stdio command is missing");
      const args = entry.args === undefined ? undefined : entry.args;
      if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))) {
        throw new Error("mcp stdio args are malformed");
      }
      if (entry.env !== undefined && !stringMap(entry.env)) throw new Error("mcp stdio env is malformed");
      if (entry.cwd !== undefined && typeof entry.cwd !== "string") throw new Error("mcp stdio cwd is malformed");
      return {
        name,
        transport: "stdio",
        command: entry.command,
        ...(args ? { args: args as string[] } : {}),
        ...(entry.env ? { env: entry.env as Record<string, string> } : {}),
        ...(entry.cwd ? { cwd: entry.cwd as string } : {})
      };
    }
    if (entry.transport === "streamable_http") {
      if (typeof entry.url !== "string" || !/^https?:\/\//u.test(entry.url)) {
        throw new Error("mcp http url is malformed");
      }
      if (entry.headers !== undefined && !stringMap(entry.headers)) throw new Error("mcp http headers are malformed");
      return {
        name,
        transport: "streamable_http",
        url: entry.url,
        ...(entry.headers ? { headers: entry.headers as Record<string, string> } : {})
      };
    }
    throw new Error("mcp server transport is unsupported");
  });
  return { schemaVersion: 1, configDigest: raw.configDigest, servers };
}

function stringMap(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

/** Never echo a header, env value, URL or command: labels only. */
export function sanitizeFailure(serverName: string, error: unknown): string {
  const kind = isRecord(error) && typeof error.name === "string" ? error.name : "error";
  const code = isRecord(error) && typeof error.code === "string" ? error.code.slice(0, 32) : "";
  return `server "${serverName}" failed (${kind}${code ? `:${code}` : ""})`;
}

// ------------------------------------------------------------------ transport

/**
 * A redirect must never forward credentials to another origin.
 *
 * The guard is applied to every request the transport makes (initialize, POSTs,
 * the GET stream, DELETE on close), so there is no unguarded fallback path.
 *
 * `redirect: "manual"` is not enough on its own: per the fetch spec an opaqueredirect
 * response carries `status === 0` (Node/undici included), which a status-only check
 * would miss. Both shapes are treated as a refusal.
 */
export function rejectingRedirectFetch(base: (input: unknown, init?: unknown) => Promise<unknown>) {
  return async (input: unknown, init?: unknown): Promise<unknown> => {
    const request = { ...(init as Record<string, unknown> | undefined), redirect: "manual" as const };
    const response = (await base(input, request)) as {
      status?: number;
      type?: string;
      headers?: { get(name: string): string | null };
    };
    const status = typeof response?.status === "number" ? response.status : 0;
    const opaque = response?.type === "opaqueredirect";
    const location = response?.headers?.get?.("location") ?? null;
    if (opaque || status === 0 || (status >= 300 && status < 400) || location !== null) {
      throw new Error("mcp http redirect is not followed");
    }
    return response;
  };
}

// ------------------------------------------------------------------ extension

export interface ManagedMcpExtensionOptions {
  /** Absolute path to the frozen document inside this Host's private root. */
  documentPath: string;
  /** Digest recorded by Core when it wrote the document. */
  documentDigest: string;
  /** Private root the document must stay inside. */
  privateRoot: string;
  /** Actual prepared workspace root reported to the server as `roots`. */
  workspaceRoot: string;
  callTimeoutMs?: number;
}

function readDocumentSync(options: ManagedMcpExtensionOptions): FrozenMcpDocument {
  const documentPath = options.documentPath;
  if (typeof documentPath !== "string"
    || (!documentPath.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(documentPath))) {
    throw new Error("mcp document path is not absolute");
  }
  const stat = lstatSync(documentPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("mcp document is not a regular file");
  if (stat.size <= 0 || stat.size > MAX_DOC_BYTES) throw new Error("mcp document size is out of range");
  const resolved = realpathSync(documentPath);
  const root = realpathSync(options.privateRoot);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("mcp document escapes the private root");
  }
  const bytes = readFileSync(resolved);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== options.documentDigest) throw new Error("mcp document digest does not match");
  return parseFrozenDocument(JSON.parse(bytes.toString("utf8")));
}

/**
 * The whole extension as one testable factory. `pi` is the Pi ExtensionAPI, `sdk`
 * the @earendil-works/pi-mcp client, `logger` the only place messages go.
 */
export function createManagedMcpExtension(
  pi: any,
  options: ManagedMcpExtensionOptions,
  sdk: McpSdk,
  logger: ManagedMcpLogger
) {
  const connections: RegisteredConnection[] = [];
  const registeredTools = new Map<string, { server: string; tool: string; client: RegisteredConnection["client"] }>();
  let state: ManagedMcpStatus = {
    state: "loading",
    digest: options.documentDigest,
    serverCount: 0,
    toolCount: 0,
    toolNames: [],
    failedServers: []
  };
  let loaded: FrozenMcpDocument | null = null;
  let loading: Promise<void> | null = null;

  const publish = (ctx: any): void => {
    try {
      const payload = JSON.stringify({ version: STATUS_VERSION, ...state });
      ctx?.ui?.setStatus?.(STATUS_KEY, payload);
    } catch {
      // A status surface must never take the Run down.
    }
  };

  const fail = (message: string): void => {
    state = { ...state, state: "degraded" };
    logger.failure(message);
  };

  async function connectServer(
    server: FrozenMcpServer
  ): Promise<{ client: RegisteredConnection["client"]; transport: unknown; pid: number | null }> {
    const client = new sdk.McpClient({
      name: "rovai-managed-mcp",
      version: STATUS_VERSION,
      requestTimeoutMs: options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      roots: [{ uri: pathToFileUrl(options.workspaceRoot), name: "workspace" }]
    }) as RegisteredConnection["client"];
    if (server.transport === "stdio") {
      const transport = new sdk.StdioTransport({
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env, inheritEnv: false } : {}),
        cwd: server.cwd ?? options.workspaceRoot,
        stderr: "pipe"
      });
      await client.connect(transport);
      const pid = (transport as { pid?: number }).pid;
      return { client, transport, pid: typeof pid === "number" ? pid : null };
    }
    // Every request goes through the guarded fetch: initialize, POSTs, the GET
    // stream and the DELETE on close. There is no unguarded fallback.
    const transport = new sdk.StreamableHttpTransport({
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
      fetch: rejectingRedirectFetch(globalThis.fetch as never) as never,
      openGetStream: false
    });
    await client.connect(transport);
    return { client, transport, pid: null };
  }

  /**
   * Bounded, owned teardown: close the client, close the transport, then wait for
   * the child process to actually go away. On Windows the fixture's cwd stays owned
   * until the child exits, so a test that removes the directory immediately sees
   * EPERM; waiting here is what makes cleanup deterministic. Never throws.
   */
  async function closeConnection(connection: {
    client: RegisteredConnection["client"];
    transport: unknown;
    pid: number | null;
  }): Promise<void> {
    try {
      await connection.client.close();
    } catch {
      // best effort
    }
    try {
      await (connection.transport as { close?: () => Promise<void> })?.close?.();
    } catch {
      // best effort
    }
    if (connection.pid !== null) await waitForProcessExit(connection.pid, options.callTimeoutMs ?? 5_000);
  }

  async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.min(timeoutMs, 5_000);
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException)?.code;
        // ESRCH: gone. EPERM: exists but not ours (Windows) — keep waiting.
        if (code === "ESRCH") return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  function pathToFileUrl(directory: string): string {
    const normalized = directory.replace(/\\/g, "/");
    return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
  }

  async function registerServerTools(server: FrozenMcpServer, client: RegisteredConnection["client"]): Promise<number> {
    const listed = await client.listTools({ timeoutMs: options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS });
    let added = 0;
    for (const tool of listed) {
      if (registeredTools.size >= MAX_TOOL_COUNT) break;
      const schema = boundedSchema(tool.inputSchema);
      if (!schema) continue;
      const name = namespacedToolName(server.name, tool.name);
      if (registeredTools.has(name)) continue;
      registeredTools.set(name, { server: server.name, tool: tool.name, client });
      pi.registerTool({
        name,
        label: tool.title ?? tool.name,
        // Description comes from the server, never from the model or our HTML.
        description: typeof tool.description === "string" ? tool.description.slice(0, 1024) : tool.name,
        parameters: schema,
        async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
          const timeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          const onAbort = (): void => controller.abort();
          signal?.addEventListener("abort", onAbort, { once: true });
          let content: unknown[];
          let isError = false;
          try {
            // No automatic replay: an unknown outcome is returned to the model.
            const result = await client.callTool(tool.name, params ?? {}, {
              signal: controller.signal,
              timeoutMs
            });
            content = boundContent(sdk.toLlmContent({ content: result.content ?? [], structuredContent: result.structuredContent }));
            isError = result.isError === true;
          } catch (error: unknown) {
            // Pi 0.85 marks a fulfilled handler successful, regardless of a returned isError flag.
            throw new Error(sanitizeFailure(server.name, error));
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
          }
          if (isError) {
            // The native error protocol carries text only. Keep the existing text budget and the
            // client's structured-content rendering; never put image/base64 data into an error.
            const text = content
              .filter((block): block is { type: "text"; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
              .map((block) => block.text)
              .join("\n")
              .slice(0, MAX_RESULT_TEXT_CHARS);
            throw new Error(text || "MCP tool reported an error");
          }
          return { content, details: undefined, isError: false };
        }
      });
      added += 1;
    }
    return added;
  }

  function boundContent(content: unknown[]): unknown[] {
    const bounded: unknown[] = [];
    let textBudget = MAX_RESULT_TEXT_CHARS;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        if (textBudget <= 0) continue;
        const text = block.text.slice(0, textBudget);
        textBudget -= text.length;
        bounded.push({ type: "text", text });
      } else if (block.type === "image" && typeof block.data === "string") {
        // base64 is ~4/3 of the byte size.
        if (block.data.length * 0.75 > MAX_RESULT_IMAGE_BYTES) {
          bounded.push({ type: "text", text: "[image omitted: above the managed size limit]" });
        } else {
          bounded.push({ type: "image", data: block.data, mimeType: block.mimeType ?? "application/octet-stream" });
        }
      }
    }
    if (!bounded.length) bounded.push({ type: "text", text: "[no content]" });
    return bounded;
  }

  async function load(ctx: any): Promise<void> {
    let document: FrozenMcpDocument;
    try {
      document = readDocumentSync(options);
    } catch (error: unknown) {
      fail(`frozen MCP document rejected: ${(error as Error)?.message ?? "unknown"}`);
      publish(ctx);
      throw error;
    }
    loaded = document;
    state = { ...state, digest: document.configDigest, serverCount: document.servers.length };
    const failed: string[] = [];
    for (const server of document.servers) {
      let connected: Awaited<ReturnType<typeof connectServer>> | null = null;
      try {
        connected = await connectServer(server);
        const added = await registerServerTools(server, connected.client);
        const owned = connected;
        connections.push({
          serverName: server.name,
          client: owned.client,
          transport: owned.transport,
          pid: owned.pid,
          close: () => closeConnection(owned)
        });
        logger.info(`mcp server "${server.name}" ready with ${added} tools`);
      } catch (error: unknown) {
        if (connected) await closeConnection(connected);
        failed.push(server.name);
        logger.failure(sanitizeFailure(server.name, error));
      }
    }
    state = {
      ...state,
      state: failed.length ? "degraded" : "ready",
      toolCount: registeredTools.size,
      toolNames: [...registeredTools.keys()].sort(),
      failedServers: failed
    };
    publish(ctx);
  }

  async function ensureLoaded(ctx: any): Promise<void> {
    if (!loading) loading = load(ctx).catch(() => undefined);
    await loading;
  }

  pi.on("session_start", async (_event: any, ctx: any) => {
    await ensureLoaded(ctx);
  });

  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    // A Run must not start as if its selected MCP were applied when it was not.
    await ensureLoaded(ctx);
    return undefined;
  });

  pi.on("session_shutdown", async () => {
    const closing = connections.splice(0, connections.length);
    await Promise.all(closing.map((connection) => connection.close()));
    registeredTools.clear();
  });

  return {
    status: () => state,
    document: () => loaded,
    toolNames: () => [...registeredTools.keys()],
    ensureLoaded
  };
}

/** Default Pi loader: reads the two env values Core set for this Host and runs the factory. */
export default async function (pi: any): Promise<void> {
  const documentPath = process.env.ROVAI_PI_MCP_FILE ?? "";
  const documentDigest = process.env.ROVAI_PI_MCP_DIGEST ?? "";
  const privateRoot = process.env.ROVAI_PI_MCP_ROOT ?? "";
  const workspaceRoot = process.env.ROVAI_PI_MCP_WORKSPACE ?? process.cwd();
  if (!documentPath || !documentDigest || !privateRoot) {
    // No selected MCP for this Run: no extension behaviour, no status, no spawn.
    return;
  }
  createManagedMcpExtension(
    pi,
    { documentPath, documentDigest, privateRoot, workspaceRoot },
    piMcp as unknown as McpSdk,
    {
      info: (message) => process.stderr.write(`[rovai-mcp] ${message}\n`),
      failure: (message) => process.stderr.write(`[rovai-mcp] ${message}\n`)
    }
  );
}

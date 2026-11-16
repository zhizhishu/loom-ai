import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = 3;
const EXTENSION_VERSION = "rovai-pi-host-v10";
// Optional per-Run file-access policy. Absent => the unchanged legacy native policy (no guard).
// Core writes the grant to a private file and points this env var at it; the same file is what the
// shared guard reads, so the extension and the guard can never disagree about the policy.
const FILE_GRANT_FILE_ENV = "ROVAI_PI_FILE_GRANT_FILE";
const FILE_GRANT_SCHEMA = "loom.runtime.file-guard.v1";
// The only two tool sets a Core-written grant may carry: the conservative read-only policy and the
// read-write policy over Pi's three native file tools. Anything else (a subset, a duplicate, `bash`,
// an extension/MCP tool) fails the extension load. The sets are compared in order, exactly.
const FILE_GRANT_READ_ONLY_TOOLS = ["read"];
const FILE_GRANT_READ_WRITE_TOOLS = ["read", "write", "edit"];
const FILE_GRANT_TOOL_SETS = [FILE_GRANT_READ_ONLY_TOOLS, FILE_GRANT_READ_WRITE_TOOLS];
const FILE_GRANT_KEYS = [
  "schema",
  "runId",
  "botId",
  "executionEpoch",
  "workspaceReal",
  "allowedTools",
  "expiresAtEpochMs",
  "logPath",
];

/**
 * Read the Core-written grant. `null` means the legacy native policy: no guard, no restriction.
 * A present-but-invalid grant must throw, never degrade to native.
 */
function readRunGrant(): any {
  const grantPath = process.env[FILE_GRANT_FILE_ENV];
  if (grantPath === undefined || grantPath.length === 0) return null;
  if (!path.isAbsolute(grantPath)) throw new Error("file grant path must be absolute");
  const stat = lstatSync(grantPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("file grant must be a regular file");
  const parsed = JSON.parse(readFileSync(grantPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("file grant is not an object");
  }
  return parsed;
}
const REQUIRED_BINDING_KEYS = [
  "agentRunId",
  "bootstrap",
  "bootstrapPayloadDigest",
  "executionEpoch",
  "expectedNativeSessionId",
  "extensionVersion",
  "hostBindingGeneration",
  "hostInstanceId",
  "nativeBindingGeneration",
  "nativeBindingId",
  "schemaVersion",
];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasRequiredKeys(value: any, expected: string[]): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function loadBinding(): any {
  const bindingPath = process.env.ROVAI_PI_HOST_BINDING_FILE;
  if (!bindingPath || !path.isAbsolute(bindingPath)) throw new Error("missing binding path");
  const metadata = lstatSync(bindingPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("invalid binding file");
  if (process.platform !== "win32") {
    if ((metadata.mode & 0o077) !== 0) throw new Error("binding permissions are too broad");
    if (typeof process.geteuid === "function" && metadata.uid !== process.geteuid()) {
      throw new Error("binding owner mismatch");
    }
  }
  const binding = JSON.parse(readFileSync(bindingPath, "utf8"));
  if (!hasRequiredKeys(binding, REQUIRED_BINDING_KEYS)) throw new Error("binding shape mismatch");
  if (
    binding.schemaVersion !== SCHEMA_VERSION ||
    binding.extensionVersion !== EXTENSION_VERSION ||
    !nonEmpty(binding.hostInstanceId) ||
    !Number.isSafeInteger(binding.hostBindingGeneration) ||
    binding.hostBindingGeneration < 1 ||
    !nonEmpty(binding.agentRunId) ||
    !Number.isSafeInteger(binding.executionEpoch) ||
    binding.executionEpoch < 1 ||
    !nonEmpty(binding.nativeBindingId) ||
    !Number.isSafeInteger(binding.nativeBindingGeneration) ||
    binding.nativeBindingGeneration < 1 ||
    !(binding.expectedNativeSessionId === null || nonEmpty(binding.expectedNativeSessionId)) ||
    typeof binding.bootstrap !== "string" ||
    !/^[a-f0-9]{64}$/.test(binding.bootstrapPayloadDigest) ||
    sha256(binding.bootstrap) !== binding.bootstrapPayloadDigest
  ) {
    throw new Error("binding evidence mismatch");
  }
  // A present-but-invalid grant fails every load instead of degrading to native permissions. No guard
  // ACK then follows, and Core refuses to send a prompt for this Run.
  validateFileAccess(binding);
  return binding;
}

/**
 * Validate the optional per-Run file-access policy.
 *
 * - absent / `native`: the unchanged legacy behaviour. A `runGrant` must NOT be present, so a guard can
 *   never be half-configured.
 * - `workspace_read_only` / `workspace_read_write`: a fully typed `runGrant` is mandatory and must be
 *   bound to THIS run, to one of the two exact frozen tool sets, and to a future expiry. Anything else
 *   fails the extension load.
 */
function validateFileAccess(binding: any): void {
  const grant = readRunGrant();
  if (grant === null) return;
  if (!hasRequiredKeys(grant, FILE_GRANT_KEYS) || Object.keys(grant).length !== FILE_GRANT_KEYS.length) {
    throw new Error("runGrant shape mismatch");
  }
  if (grant.schema !== FILE_GRANT_SCHEMA) throw new Error("runGrant schema mismatch");
  if (grant.runId !== binding.agentRunId) throw new Error("runGrant is bound to another AgentRun");
  if (grant.executionEpoch !== binding.executionEpoch) throw new Error("runGrant epoch mismatch");
  if (!nonEmpty(grant.botId)) throw new Error("runGrant botId is missing");
  if (!nonEmpty(grant.workspaceReal) || !path.isAbsolute(grant.workspaceReal)) {
    throw new Error("runGrant workspaceReal must be absolute");
  }
  if (!nonEmpty(grant.logPath) || !path.isAbsolute(grant.logPath)) {
    throw new Error("runGrant logPath must be absolute");
  }
  if (!Array.isArray(grant.allowedTools)
    || !FILE_GRANT_TOOL_SETS.some((toolSet) => toolSet.length === grant.allowedTools.length
      && toolSet.every((tool, index) => grant.allowedTools[index] === tool))) {
    throw new Error("runGrant tools exceed the file-access policy");
  }
  if (!Number.isSafeInteger(grant.expiresAtEpochMs) || grant.expiresAtEpochMs <= Date.now()) {
    throw new Error("runGrant is expired");
  }
}

/**
 * Publish the binding-side guard acknowledgement. This is only an ACK of the *grant the Host was
 * started with*; the executed guard writes its own `guard_ready`/`guard_selftest` lines into
 * `runGrant.logPath`, and Core must require BOTH before it sends a prompt.
 */
function publishGuardState(ctx: any, binding: any): void {
  const grant = readRunGrant();
  if (grant === null) return;
  ctx.ui.setStatus(
    "rovai-managed-guard-state",
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      extensionVersion: EXTENSION_VERSION,
      hostInstanceId: binding.hostInstanceId,
      hostBindingGeneration: binding.hostBindingGeneration,
      runId: grant.runId,
      botId: grant.botId,
      executionEpoch: grant.executionEpoch,
      allowedTools: grant.allowedTools,
      workspaceReal: grant.workspaceReal,
      expiresAtEpochMs: grant.expiresAtEpochMs,
      guardLogPath: grant.logPath,
    }),
  );
}

function publishManagedSessionState(ctx: any, current: any): void {
  const sessionFile = ctx.sessionManager.getSessionFile();
  const sessionId = ctx.sessionManager.getSessionId();
  const cwd = ctx.sessionManager.getCwd();
  if (!nonEmpty(sessionFile) || !path.isAbsolute(sessionFile) || !nonEmpty(sessionId) || !nonEmpty(cwd)) {
    throw new Error("Pi managed Session state is incomplete");
  }
  ctx.ui.setStatus(
    "rovai-managed-session-state",
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      extensionVersion: EXTENSION_VERSION,
      hostInstanceId: current.hostInstanceId,
      hostBindingGeneration: current.hostBindingGeneration,
      sessionId,
      sessionFile,
      cwd,
    }),
  );
}

function publishFailure(ctx: any, binding: any, phase: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.setStatus(
    "rovai-managed-failure",
    JSON.stringify({
      schemaVersion: 1,
      extensionVersion: EXTENSION_VERSION,
      hostInstanceId: binding?.hostInstanceId ?? null,
      agentRunId: binding?.agentRunId ?? null,
      executionEpoch: binding?.executionEpoch ?? null,
      hostBindingGeneration: binding?.hostBindingGeneration ?? null,
      nativeSessionId: ctx.sessionManager?.getSessionId?.() ?? null,
      phase,
      code: "pi_managed_extension_failure",
      message: message.slice(0, 2000),
    }),
  );
}

function publishContextUsage(ctx: any): void {
  try {
    if (typeof ctx.getContextUsage !== "function") return;
    const current = loadBinding();
    const usage = ctx.getContextUsage();
    if (!usage) return;
    const used = Number.isSafeInteger(usage.tokens) && usage.tokens >= 0 ? usage.tokens : null;
    const window = Number.isSafeInteger(usage.contextWindow) && usage.contextWindow >= 0 ? usage.contextWindow : null;
    if (used === null && window === null) return;
    const sessionId = ctx.sessionManager.getSessionId();
    if (!nonEmpty(sessionId) || !nonEmpty(ctx.model?.provider) || !nonEmpty(ctx.model?.id)) return;
    ctx.ui.setStatus("rovai-managed-context-usage", JSON.stringify({
      schemaVersion: 1, extensionVersion: EXTENSION_VERSION,
      hostInstanceId: current.hostInstanceId, hostBindingGeneration: current.hostBindingGeneration,
      agentRunId: current.agentRunId, executionEpoch: current.executionEpoch,
      nativeBindingId: current.nativeBindingId, nativeBindingGeneration: current.nativeBindingGeneration,
      sessionId, provider: ctx.model.provider, modelId: ctx.model.id,
      usedTokens: used, windowTokens: window,
    }));
  } catch {
    // Missing metrics cannot abort a native prompt or expose arbitrary payloads.
  }
}

export default function (pi: any) {
  pi.on("turn_end", async (_event: any, ctx: any) => publishContextUsage(ctx));
  pi.on("session_compact", async (_event: any, ctx: any) => publishContextUsage(ctx));
  pi.on("session_start", async (_event: any, ctx: any) => {
    try {
      const binding = loadBinding();
      publishManagedSessionState(ctx, binding);
      // Binding-side guard ACK: proves this Host was started with the Run's grant. The executed guard
      // writes its own guard_ready/guard_selftest lines; Core requires both before prompting.
      publishGuardState(ctx, binding);
    } catch (error) {
      publishFailure(ctx, undefined, "session_start", error);
    }
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      const current = loadBinding();
      return { systemPrompt: `${event.systemPrompt}\n\n${current.bootstrap}` };
    } catch (error) {
      publishFailure(ctx, undefined, "before_agent_start", error);
      return undefined;
    }
  });
}

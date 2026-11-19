import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
// The managed workflow bridge is the single canonical source of the one Core business tool the
// `workspace_workflow` policy adds. It has no import side effects (crypto/fs/path only) and grants
// nothing by itself; the child process module is loaded lazily on first use so a legacy Host keeps
// exactly today's capability surface.
import {
  CLI_ENV,
  LOOM_TOOL_NAME,
  WORKFLOW_CONTRACT_FILE,
  loomToolDescription,
  loomToolParameters,
  piToolResult,
  planInvocation,
  readWorkflowContracts,
  registrationFailureLine,
  resolveTrustedCli,
  runInvocation,
} from "./managed-workflow-tool.ts";

const SCHEMA_VERSION = 3;
// P0 step 2 / Core's plan decision E2: the guard acknowledgement (`rovai-managed-guard-state`)
// carries the LOOM claim the grant was issued under.
// P0 step 3: it also carries `requiresClaim`, the boolean that makes every `write`/`edit` require a
// live claim, so THAT receipt is v5 while the binding and session-state documents keep v3 (they did
// not change). Core's matching constant is `PI_MANAGED_GUARD_SCHEMA_VERSION` in `pi.rs`; the two must
// move together or every guarded Run is refused by `await_guard_ready`.
const GRANT_SCHEMA_VERSION = 5;
const EXTENSION_VERSION = "rovai-pi-host-v11";
// Optional per-Run file-access policy. Absent => the unchanged legacy native policy (no guard).
// Core writes the grant to a private file and points this env var at it; the same file is what the
// shared guard reads, so the extension and the guard can never disagree about the policy.
const FILE_GRANT_FILE_ENV = "ROVAI_PI_FILE_GRANT_FILE";
const FILE_GRANT_SCHEMA = "loom.runtime.file-guard.v1";
// The only three tool sets a Core-written grant may carry: the conservative read-only policy, the
// read-write policy over Pi's three native file tools, and the explicitly chosen workflow policy that
// adds the one managed Core business tool. Anything else (a subset, a duplicate, `bash`, an arbitrary
// extension/MCP tool, or the business tool without the file tools) fails the extension load. The sets
// are compared in order, exactly.
const FILE_GRANT_READ_ONLY_TOOLS = ["read"];
const FILE_GRANT_READ_WRITE_TOOLS = ["read", "write", "edit"];
const FILE_GRANT_WORKFLOW_TOOLS = ["read", "write", "edit", LOOM_TOOL_NAME];
const FILE_GRANT_TOOL_SETS = [
  FILE_GRANT_READ_ONLY_TOOLS,
  FILE_GRANT_READ_WRITE_TOOLS,
  FILE_GRANT_WORKFLOW_TOOLS,
];
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
// The claim identity Core adds to every grant it issues (P0 step 2). A Run that holds no LOOM Task
// presents the empty triple (`""`/`0`/`0`) — the keys are still present, so "missing" can never be
// mistaken for "unbound".
// P0 step 3 adds `requiresClaim` beside them: it is the REQUIREMENT, not the identity, and it is
// `true` for a Run bound to a LOOM Task even before the claim row exists (the r9 window). The shared
// guard refuses `write`/`edit` without a live claim exactly when it is `true`.
const FILE_GRANT_CLAIM_KEYS = ["claimId", "fenceGeneration", "leaseExpiresAtEpochMs", "requiresClaim"];
const FILE_GRANT_ALL_KEYS = [...FILE_GRANT_KEYS, ...FILE_GRANT_CLAIM_KEYS];

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
 *   bound to THIS run, to one of the exact frozen tool sets, and to a future expiry. Anything else
 *   fails the extension load.
 * - `workspace_workflow`: the read-write set plus the one managed `rovai_loom` business tool. Only this
 *   grant shape registers that tool; every other policy registers nothing.
 */
function validateFileAccess(binding: any): void {
  const grant = readRunGrant();
  if (grant === null) return;
  if (!hasRequiredKeys(grant, FILE_GRANT_ALL_KEYS) || Object.keys(grant).length !== FILE_GRANT_ALL_KEYS.length) {
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
  // The claim triple is coherent or it is not a Core-written grant: an empty claim id means "this Run
  // holds no LOOM claim" and must then carry no fence and no lease; a present claim id must carry a
  // positive fence and a positive lease. Whether that lease is still live is enforced where the write
  // decision is made (the shared guard), not at extension load.
  if (!Number.isSafeInteger(grant.fenceGeneration) || grant.fenceGeneration < 0) {
    throw new Error("runGrant fenceGeneration is invalid");
  }
  if (!Number.isSafeInteger(grant.leaseExpiresAtEpochMs) || grant.leaseExpiresAtEpochMs < 0) {
    throw new Error("runGrant claim lease is invalid");
  }
  if (nonEmpty(grant.claimId)) {
    if (grant.fenceGeneration < 1 || grant.leaseExpiresAtEpochMs < 1) {
      throw new Error("runGrant claim is incomplete");
    }
  } else if (grant.fenceGeneration !== 0 || grant.leaseExpiresAtEpochMs !== 0) {
    throw new Error("runGrant claim is inconsistent");
  }
  // P0 step 3: the requirement is a boolean, and a claim always implies it. `requiresClaim:true`
  // beside an empty triple is the legal pre-claim window (r9); a claim beside `requiresClaim:false`
  // would let the shared guard skip the gate while carrying an identity, so it is refused outright.
  if (typeof grant.requiresClaim !== "boolean") {
    throw new Error("runGrant requiresClaim is invalid");
  }
  if (nonEmpty(grant.claimId) && grant.requiresClaim !== true) {
    throw new Error("runGrant claim is inconsistent with requiresClaim");
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
      schemaVersion: GRANT_SCHEMA_VERSION,
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
      claimId: grant.claimId,
      fenceGeneration: grant.fenceGeneration,
      leaseExpiresAtEpochMs: grant.leaseExpiresAtEpochMs,
      requiresClaim: grant.requiresClaim,
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

function publishFailure(ctx: any, binding: any, phase: string, error: unknown): void {  const message = error instanceof Error ? error.message : String(error);
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

// --------------------------------------------------------------------------
// Managed LOOM workflow tool
// --------------------------------------------------------------------------

/**
 * Decide once, at extension load time, whether this Host may register the managed business tool.
 *
 * Registration is synchronous and load-time on purpose: Pi applies its tool allowlist to
 * built-in/extension/custom tools alike, so the tool must exist before the first prompt instead of
 * appearing after `session_start`. A policy that does not carry it registers nothing — there is no
 * degraded variant, no PATH search and no fallback executable.
 */
function loomRegistration(pi: any): void {
  let grant: any = null;
  try {
    grant = readRunGrant();
  } catch {
    writeLoadDiagnostic("loom_grant_unreadable");
    return;
  }
  if (grant === null) return;
  if (!Array.isArray(grant.allowedTools) || !grant.allowedTools.includes(LOOM_TOOL_NAME)) return;
  const resolved = resolveTrustedCli(process.env[CLI_ENV]);
  if (!resolved.ok) {
    writeLoadDiagnostic(resolved.code);
    return;
  }
  const cliPath = resolved.cliPath;
  // This adjacent file contains only Core's public input schemas, not binding credentials.
  const bindingFile = process.env.ROVAI_PI_HOST_BINDING_FILE;
  if (!bindingFile || !path.isAbsolute(bindingFile)) throw new Error("loom_contract_path_invalid");
  const contracts = readWorkflowContracts(path.join(path.dirname(bindingFile), WORKFLOW_CONTRACT_FILE));

  pi.registerTool({
    name: LOOM_TOOL_NAME,
    label: "LOOM workflow",
    description: loomToolDescription(contracts),
    promptSnippet: "rovai_loom — record delivery evidence and submit a claimed task (8 LOOM operations only)",
    parameters: loomToolParameters(contracts),
    async execute(toolCallId: string, params: any, signal?: AbortSignal) {
      let binding: any;
      let grantNow: any;
      try {
        // Re-validate the live binding and grant on EVERY call: an expired grant, a re-bound Host or a
        // policy that no longer carries this tool must refuse here even if it was valid at load time.
        binding = loadBinding();
        grantNow = readRunGrant();
      } catch (error: unknown) {
        return toolFailure(`LOOM tool refused: ${errorMessage(error)}`);
      }
      const planned = planInvocation({
        toolCallId,
        params,
        contracts,
        grant: grantNow,
        binding: { agentRunId: binding.agentRunId, executionEpoch: binding.executionEpoch },
        nowMs: Date.now(),
        cliPath,
        baseEnv: process.env,
      });
      if (!planned.ok) return toolFailure(`LOOM tool refused: ${planned.code}`);
      let spawnFn;
      try {
        // Loaded lazily: a Host that never calls this tool never loads a child-process module.
        spawnFn = (await import("node:child_process")).spawn;
      } catch {
        return toolFailure("LOOM tool refused: loom_spawn_unavailable");
      }
      const result = await runInvocation({
        spawn: spawnFn as any,
        plan: planned.plan,
        signal,
      });
      // Pi marks a fulfilled handler successful. Preserve Core rejection/unknown state by throwing;
      // this conversion never retries the child or changes its request identity.
      return piToolResult(result);
    },
  });
}

function toolFailure(text: string): never {
  throw new Error(text);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

/** Private diagnostics channel: stdout is the RPC stream, so a bounded stderr line is the only safe one. */
function writeLoadDiagnostic(code: string): void {
  try {
    process.stderr.write(registrationFailureLine(code));
  } catch {
    // A diagnostic that cannot be written cannot change what was registered.
  }
}

export default function (pi: any) {
  // Register at load time, before any session state or prompt exists.
  loomRegistration(pi);
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

/**
 * LOOM V2 — the one managed Core business tool the `workspace_workflow` Pi policy adds.
 *
 * Why this file exists:
 * - `workspace_read_only` / `workspace_read_write` give a Pi Run a workspace boundary but only Pi's
 *   own native `read`/`write`/`edit`. A Run that produces a deliverable could therefore not register
 *   evidence or submit it, because `rovai loom evidence|submit` needs a process — and `bash` is
 *   deliberately outside every guarded policy. The result was that a human/test host recorded the
 *   Run's own artifacts for it.
 * - This module is the *typed bridge* for exactly that gap: one tool (`rovai_loom`) that can reach
 *   only the fourteen operations Core already ships for a managed delivery — the ten `loom.*`
 *   business operations, the three `loom.workspace.*` RPC operations that move real bytes into and
 *   out of the Run's authorized workspace, and one ordinary `thread.message.send` — spawned as a
 *   fixed trusted executable with no shell, with the operation parameters on stdin as one JSON
 *   object.
 *
 * Binary deliveries: Pi's own `write` tool is text-only, so a Run cannot materialize a `.docx` with
 * it. After an untruncated `loom.workspace.read`, this bridge decodes the returned bytes itself and
 * writes one generated copy under `ROVAI_RUN_TMP` (mode 0600, exclusive create, content-addressed
 * name), then reports that absolute path. `thread.message.send` `files` is the existing ordinary
 * attachment path, and Core's `camp_attachment` accepts exactly workspace or `ROVAI_RUN_TMP`
 * sources, so the model never needs a filesystem capability of its own. A `files` entry is a
 * workspace-relative path or that run-private copy; the bridge refuses any other absolute host path
 * before a child starts.
 *
 * This file is a pure contract plus one injected-runtime helper:
 * - No top-level side effects: importing it starts no process and touches no credential or
 *   environment, so `scripts/loom-v2-workflow-tool.test.mjs` validates the SAME bytes production runs.
 * - It grants nothing on its own. Authority stays in Core: the child carries only the CLI context /
 *   binding credential Core already injected into this Host, and Core authenticates the Run from that
 *   binding. This module never claims a Run, bot, Mission, creator or command identity.
 *
 * Non-goals (hard boundaries):
 * - No `bash`, no arbitrary CLI, no MCP, no `--input-file` path, and no model text in argv. The argv
 *   is two fixed words (one for `send`) taken from a closed table; the model's parameters travel on
 *   stdin only.
 * - No arbitrary output path and no delete: the only file this module ever creates is one generated
 *   copy under `ROVAI_RUN_TMP`, and it never overwrites an existing name.
 * - No silent retry: an unknown outcome is reported as indeterminate instead of being re-sent with a
 *   fresh request id.
 */

import { createHash } from "node:crypto"
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, statSync, writeSync } from "node:fs"
import { extname, isAbsolute, join, resolve, sep } from "node:path"
import { StringDecoder } from "node:string_decoder"

export const LOOM_TOOL_NAME = "rovai_loom"
export const WORKFLOW_CONTRACT_FILE = "loom-workflow-contract.json"
export const WORKFLOW_POLICY = "workspace_workflow"
export const FILE_GRANT_SCHEMA = "loom.runtime.file-guard.v1"
/** Set by this bridge on the exact child it spawns; never on `process.env`. */
export const REQUEST_ID_ENV = "ROVAI_BUILTIN_REQUEST_ID"
/** Core-filled absolute path of the bundled Rovai Agent CLI for this Run. */
export const CLI_ENV = "ROVAI_AGENT_CLI"

/**
 * The only operations this tool may reach, in Core's catalog order: the ten `loom.*` business
 * operations, the three workspace RPC operations a managed delivery needs, and the one ordinary
 * group send. `loom.workspace.run`, the poll/cancel controls, `bash` and MCP stay outside it.
 */
export const LOOM_OPERATIONS = Object.freeze([
  "loom.status",
  "loom.skill_suggest",
  "loom.plan",
  "loom.release",
  "loom.claim",
  "loom.claim_heartbeat",
  "loom.evidence",
  "loom.submit",
  "loom.inspect",
  "loom.stage-review",
  "loom.workspace.list",
  "loom.workspace.read",
  "loom.workspace.write",
  "thread.message.send",
])

/** Operation → the two fixed CLI words. Never assembled from model text. */
export const LOOM_OPERATION_ARGV: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "loom.status": ["loom", "status"],
  "loom.skill_suggest": ["loom", "skill-suggest"],
  "loom.plan": ["loom", "plan"],
  "loom.release": ["loom", "release"],
  "loom.claim": ["loom", "claim"],
  "loom.claim_heartbeat": ["loom", "claim-heartbeat"],
  "loom.evidence": ["loom", "evidence"],
  "loom.submit": ["loom", "submit"],
  "loom.inspect": ["loom", "inspect"],
  "loom.stage-review": ["loom", "stage-review"],
  "loom.workspace.list": ["workspace", "list"],
  "loom.workspace.read": ["workspace", "read"],
  "loom.workspace.write": ["workspace", "write"],
  // The one operation outside the `rovai loom` family: the ordinary group send whose `files` names
  // the local copy this bridge materialized under ROVAI_RUN_TMP.
  "thread.message.send": ["send"],
})

/**
 * The exact parameter keys each operation may carry, mirroring Core's closed input schemas
 * (`crates/rovai-core/src/loom_tool.rs`). Anything else — `agentRunId`, `commandId`, `missionId`,
 * `creatorId`, `executionEpoch`, … — is rejected before a child is started, and Core's
 * `additionalProperties: false` schemas reject it again on the wire.
 *
 * `claimId`/`fenceGeneration` are the one exception below, and only as input to
 * `loom.claim_heartbeat`: a heartbeat names which of *this Run's own* claims to renew, and Core
 * still refuses a claim this Run does not hold. No other operation lists them, so the per-operation
 * key set below stays the authority.
 */
export const LOOM_INPUT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "loom.status": [],
  "loom.skill_suggest": ["name", "description", "instructions", "rationale"],
  "loom.plan": ["goal", "acceptanceCriteriaVersion", "criteria", "tasks", "dependencies"],
  "loom.release": ["taskId"],
  "loom.claim": ["taskId", "leaseSeconds"],
  "loom.claim_heartbeat": ["claimId", "fenceGeneration"],
  "loom.evidence": ["relativePath", "taskId", "contentType"],
  "loom.submit": ["taskId", "evidenceIds", "previousCandidateId"],
  "loom.inspect": ["taskId"],
  "loom.stage-review": [
    "taskId",
    "candidateId",
    "policyRevision",
    "manifestHash",
    "verdict",
    "reason",
    "criteriaResults",
  ],
  // The workspace keys are Core's own closed catalog keys, never a second registry. `data` is the
  // complete base64 payload of one write; there is no mode, append, delete or output-path key.
  "loom.workspace.list": ["workspaceId", "path", "limit", "requestId", "timeoutMs"],
  "loom.workspace.read": ["workspaceId", "path", "offset", "maxBytes", "requestId", "timeoutMs"],
  "loom.workspace.write": ["workspaceId", "path", "data", "requestId", "timeoutMs"],
  // `thread.message.send` declares exactly five keys in Core's catalog schema. `taskId` is a legacy
  // input alias the Core validator tolerates, not a schema key, so it is not offered here.
  "thread.message.send": ["body", "to", "mentionUser", "publicOnly", "files"],
})

/**
 * The input keys this bridge projects to a provider as bare scalars.
 *
 * Every one of them is a workspace-operation key, and every one is a flat string/integer in Core's
 * catalog. The projection exists only because some providers (OCT/Mistral) refuse the whole tool
 * when the input object carries nested validation metadata for these keys. Nothing else changes:
 * `validateLoomParams` and Core's closed catalog schema keep the real bounds.
 */
export const WORKSPACE_PROVIDER_KEYS = Object.freeze([
  "workspaceId",
  "path",
  "limit",
  "offset",
  "maxBytes",
  "data",
  "requestId",
  "timeoutMs",
])

/**
 * Identity an operation could try to claim for itself. Never accepted from the model.
 *
 * `claimId` and `fenceGeneration` are intentionally absent: `loom.claim_heartbeat` takes them as
 * input to name the lease it renews. They grant nothing on their own — Core renews only a claim
 * held by the authenticated Run at the current fence — and every other operation's key set above
 * still refuses them.
 */
export const FORBIDDEN_INPUT_KEYS = Object.freeze([
  "agentRunId",
  "runId",
  "botId",
  "agentId",
  "missionId",
  "campId",
  "creatorId",
  "commandId",
  "requestId",
  "executionEpoch",
  "reviewerAgentId",
  "reviewedAt",
  "tenantId",
  "workspaceReal",
  "logPath",
])

/**
 * Child stdout budget. One `loom.workspace.read` page can carry a full 1 MiB read as standard
 * padded base64 (⌈1 048 576 / 3⌉ × 4 = 1 398 104 bytes) plus the bounded page envelope, so the
 * budget is one 2 MiB block instead of 64 KiB. Anything larger is reported, never half-read.
 */
export const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024
/**
 * JSON stdin budget, measured in UTF-8 bytes *before* a child exists. A `loom.workspace.write`
 * carries at most 1 MiB of decoded bytes, which is 1 398 104 bytes of base64 plus the operation's
 * closed keys, so 2 MiB is the smallest block that admits the protocol maximum.
 */
export const MAX_STDIN_BYTES = 2 * 1024 * 1024
/** How long a killed child gets to confirm its own close before the outcome is called unknown. */
export const KILL_CONFIRM_MS = 2_000
/** Must match `BUILTIN_TOOL_ENVELOPE_VERSION` in crates/rovai-core/src/builtin_tool_transport.rs. */
export const ENVELOPE_VERSION = 2
/** Exit-code contract of the CLI (`envelope_exit_code` in bin/rovai.rs). */
export const EXIT_CODES = Object.freeze({ ok: 0, rejection: 1, featureDisabled: 2, outcomeIndeterminate: 3 })
const CODE_FEATURE_DISABLED = "task.feature_disabled"
const CODE_OUTCOME_INDETERMINATE = "builtin_tool.outcome_indeterminate"
const CODE_INVALID_OUTPUT = "builtin_tool.invalid_output"
export const DEFAULT_TIMEOUT_MS = 60_000
const MAX_CHILD_STREAM_BYTES = 128 * 1024
const REQUEST_ID_NAMESPACE = "rovai.loom.request-id.v1"
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
/** Interpreters, not executables: a child started through one is an arbitrary-command surface. */
const SCRIPT_EXTENSIONS = [".cmd", ".bat", ".com", ".ps1", ".vbs", ".js", ".mjs", ".cjs", ".sh", ".py"]
const IS_WIN = process.platform === "win32"
/** The run-private directory Core already fills for this Run; the only place this module writes. */
export const RUN_TMP_ENV = "ROVAI_RUN_TMP"
/** The one operation whose untruncated result bytes become a local file. */
export const MATERIALIZE_OPERATION = "loom.workspace.read"
/** Mirrors `MAX_WRITE_BYTES` / `MAX_READ_BYTES` in crates/loom-protocol/src/workspace_rpc.rs. */
export const MAX_MATERIALIZED_BYTES = 1_048_576
export const MAX_WRITE_BYTES = 1_048_576
export const MATERIALIZED_PREFIX = "loom-read-"
/** Path text longer than this keeps only a compact summary in the model's context. */
const MAX_INLINE_RESULT_CHARS = 64 * 1024
/** A generated copy must never look executable to a later consumer. */
const MATERIALIZED_DENIED_EXTENSIONS = new Set([
  "exe", "com", "scr", "pif", "msi", "msp", "dll", "cpl", "ocx", "drv", "sys", "bat", "cmd",
  "ps1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "lnk", "hta", "reg", "pl", "jar", "app", "xll",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function norm(target: string): string {
  const unified = resolve(target)
  return IS_WIN ? unified.toLowerCase() : unified
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

// ---------------------------------------------------------------------------
// Trusted executable
// ---------------------------------------------------------------------------

/**
 * Resolve the one trusted CLI path Core named for this Run.
 *
 * Refused: anything relative, a NUL byte, a Windows device/UNC prefix, an interpreter script
 * (`.cmd`/`.bat`/…), a non-regular file, a symlink, and — on Windows, where junctions and reparse
 * points are indistinguishable from ordinary directories by `lstat` — any path whose real path
 * differs. There is no PATH search and no fallback: a Host that cannot resolve this path simply does
 * not register the tool.
 */
export function resolveTrustedCli(
  raw: unknown,
): { ok: true; cliPath: string } | { ok: false; code: string } {
  if (typeof raw !== "string" || raw.trim().length === 0) return { ok: false, code: "loom_cli_missing" }
  if (raw.includes("\0")) return { ok: false, code: "loom_cli_nul_byte" }
  if (!isAbsolute(raw)) return { ok: false, code: "loom_cli_not_absolute" }
  if (IS_WIN) {
    if (/^\\\\[?.]\\/.test(raw)) return { ok: false, code: "loom_cli_device_namespace" }
    if (/^\\\\/.test(raw)) return { ok: false, code: "loom_cli_unc" }
  }
  if (SCRIPT_EXTENSIONS.includes(extname(raw).toLowerCase())) {
    return { ok: false, code: "loom_cli_not_executable" }
  }
  let stat
  try {
    stat = lstatSync(raw)
  } catch {
    return { ok: false, code: "loom_cli_missing" }
  }
  if (stat.isSymbolicLink()) return { ok: false, code: "loom_cli_symlink" }
  if (!stat.isFile()) return { ok: false, code: "loom_cli_not_regular_file" }
  let real: string
  try {
    real = realpathSync(raw)
  } catch {
    return { ok: false, code: "loom_cli_unresolvable" }
  }
  if (IS_WIN && norm(real) !== norm(raw)) return { ok: false, code: "loom_cli_reparse" }
  return { ok: true, cliPath: real }
}

// ---------------------------------------------------------------------------
// Request identity
// ---------------------------------------------------------------------------

/**
 * Deterministic request id for one provider tool call:
 * `sha256(namespace, runId, executionEpoch, operation, toolCallId)` rendered as a UUIDv8.
 *
 * The same call retried inside the same Run therefore replays in Core instead of executing twice,
 * while a different Run, a different operation or a different call can never collide. The model
 * supplies none of these inputs.
 */
export function deriveRequestId(input: {
  runId: string
  executionEpoch: number
  operation: string
  toolCallId: string
}): string {
  const hex = sha256Hex(
    [REQUEST_ID_NAMESPACE, input.runId, String(input.executionEpoch), input.operation, input.toolCallId].join("\0"),
  )
    .slice(0, 32)
    .split("")
  // UUIDv8: custom, deterministic. Set the version and RFC 9562 variant nibbles.
  hex[12] = "8"
  hex[16] = "89ab"[Number.parseInt(hex[16], 16) & 0x3]
  const s = hex.join("")
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * Pre-check a `loom.evidence` path. The shared guard remains the authority (it resolves, realpaths and
 * proves the file is a regular, non-hardlinked, in-workspace file); this only refuses obvious syntax
 * before a child is ever started.
 */
export function evidencePathProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return "path_missing"
  if (raw.includes("\0")) return "path_nul_byte"
  if (raw.length > 1000) return "path_too_long"
  if (isAbsolute(raw)) return "path_not_relative"
  if (/^[A-Za-z]:/.test(raw)) return "path_not_relative"
  if (raw.startsWith("\\\\") || raw.startsWith("//")) return "path_not_relative"
  const segments = raw.split(/[\\/]+/).filter((segment) => segment.length > 0)
  if (segments.length === 0) return "path_is_workspace_root"
  for (const segment of segments) {
    if (segment === "..") return "path_parent_escape"
    if (segment.includes(":")) return "path_alternate_data_stream"
    if (/[. ]$/.test(segment)) return "path_trailing_dot_or_space"
    if (RESERVED_DEVICE.test(segment)) return "path_reserved_device_name"
  }
  return null
}

/**
 * Pre-check a workspace RPC path before a child exists.
 *
 * Core's `validate_relative_path` / `validate_write_path` remain the authority. This refuses the
 * obvious syntax early so a rejected path never costs a process: it rejects every backslash, an
 * empty or dot component, an absolute or drive/UNC form, an alternate-data-stream colon, a trailing
 * dot or space, a DOS device basename, and — for a write target only — any Git metadata component.
 */
export function workspacePathProblem(raw: unknown, options: { write: boolean }): string | null {
  if (typeof raw !== "string" || raw.length === 0) return "path_missing"
  if (raw.includes("\0")) return "path_nul_byte"
  if (Buffer.byteLength(raw, "utf8") > 4096) return "path_too_long"
  if (raw.startsWith("/") || raw.includes("\\")) return "path_not_relative"
  if (/^[A-Za-z]:/.test(raw)) return "path_not_relative"
  for (const segment of raw.split("/")) {
    if (segment.length === 0) return "path_empty_segment"
    if (segment === "." || segment === "..") return "path_parent_escape"
    if (segment.includes(":")) return "path_alternate_data_stream"
    if (/[\u0000-\u001f\u007f]/.test(segment)) return "path_control_byte"
    if (/[. ]$/.test(segment)) return "path_trailing_dot_or_space"
    if (RESERVED_DEVICE.test(segment)) return "path_reserved_device_name"
    if (options.write && segment.toLowerCase() === ".git") return "path_git_metadata"
  }
  return null
}

/**
 * Which local file extension one untruncated read may keep.
 *
 * Only the extension of the requested path survives, and only when it is a short alphanumeric
 * suffix that is not an executable/script type. The model never names the output file: the name
 * is generated from the payload digest, so the same bytes always map to the same run-private name.
 */
export function materializedExtension(requestedPath: unknown): string {
  if (typeof requestedPath !== "string") return ".bin"
  const last = requestedPath.split("/").pop() ?? ""
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(last)
  if (!match) return ".bin"
  const suffix = match[1].toLowerCase()
  if (MATERIALIZED_DENIED_EXTENSIONS.has(suffix)) return ".bin"
  return `.${suffix}`
}

export type LoomCall = { operation: string; input: Record<string, unknown> }
export type WorkflowContracts = Readonly<Record<string, Record<string, unknown>>>

/** Core materializes its existing schemas beside the private Host binding. */
export function workflowContracts(value: unknown): WorkflowContracts {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.operations)
    || value.operations.length !== LOOM_OPERATIONS.length) throw new Error("loom_contract_invalid")
  const contracts: Record<string, Record<string, unknown>> = Object.create(null)
  for (const row of value.operations) {
    if (!isRecord(row) || typeof row.operation !== "string" || !LOOM_OPERATIONS.includes(row.operation)
      || Object.hasOwn(contracts, row.operation) || !isRecord(row.inputSchema)) throw new Error("loom_contract_invalid")
    const schema = row.inputSchema
    if (schema.type !== "object" || schema.additionalProperties !== false || !isRecord(schema.properties)) {
      throw new Error("loom_contract_invalid")
    }
    const expected = [...LOOM_INPUT_KEYS[row.operation]].sort()
    if (JSON.stringify(Object.keys(schema.properties).sort()) !== JSON.stringify(expected)) {
      throw new Error("loom_contract_keys_changed")
    }
    const required = schema.required ?? []
    if (!Array.isArray(required) || required.some(key => typeof key !== "string" || !expected.includes(key))) {
      throw new Error("loom_contract_invalid")
    }
    contracts[row.operation] = schema
  }
  return Object.freeze(contracts)
}

export function readWorkflowContracts(file: string): WorkflowContracts {
  if (!isAbsolute(file)) throw new Error("loom_contract_path_invalid")
  const info = lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error("loom_contract_file_invalid")
  return workflowContracts(JSON.parse(readFileSync(file, "utf8")))
}

/** Accept exactly `{ operation, input? }` for one bridged operation with its closed key set. */
export function validateLoomParams(
  params: unknown,
  contracts: WorkflowContracts,
  sendPaths?: SendPathContext,
): { ok: true; call: LoomCall } | { ok: false; code: string } {
  if (!isRecord(params)) return { ok: false, code: "loom_params_not_object" }
  for (const key of Object.keys(params)) {
    if (key !== "operation" && key !== "input") return { ok: false, code: `loom_param_unknown:${key}` }
  }
  const operation = params.operation
  if (typeof operation !== "string" || !LOOM_OPERATIONS.includes(operation)) {
    return { ok: false, code: "loom_operation_not_allowed" }
  }
  const rawInput = params.input === undefined || params.input === null ? {} : params.input
  if (!isRecord(rawInput)) return { ok: false, code: "loom_input_not_object" }
  const allowed = LOOM_INPUT_KEYS[operation] ?? []
  for (const key of Object.keys(rawInput)) {
    if (FORBIDDEN_INPUT_KEYS.includes(key)) return { ok: false, code: `loom_identity_not_allowed:${key}` }
    if (!allowed.includes(key)) return { ok: false, code: `loom_input_not_allowed:${key}` }
  }
  const schema = contracts?.[operation]
  if (!schema) return { ok: false, code: "loom_contract_missing" }
  const missing = ((schema.required ?? []) as string[]).filter(key => !Object.hasOwn(rawInput, key))
  if (missing.length) return { ok: false, code: `loom_input_required:${missing.join(",")}` }
  if (operation === "loom.evidence") {
    const problem = evidencePathProblem(rawInput.relativePath)
    if (problem) return { ok: false, code: `loom_evidence_${problem}` }
  }
  if (operation === "loom.workspace.read" || operation === "loom.workspace.write") {
    const problem = workspacePathProblem(rawInput.path, { write: operation === "loom.workspace.write" })
    if (problem) return { ok: false, code: `loom_workspace_${problem}` }
  }
  if (operation === "loom.workspace.write" && typeof rawInput.data === "string") {
    // Refuse an obviously over-limit payload before a child exists. Core still decodes and enforces
    // the same 1 MiB ceiling; this only spares the model a pointless process round trip.
    const encodedSizeProblem = workspaceWriteDataProblem(rawInput.data)
    if (encodedSizeProblem) return { ok: false, code: `loom_workspace_${encodedSizeProblem}` }
  }
  if (operation === "loom.workspace.list" && Object.hasOwn(rawInput, "path")) {
    // The workspace root is expressed by omitting `path`; every present path is a real relative one.
    const problem = workspacePathProblem(rawInput.path, { write: false })
    if (problem) return { ok: false, code: `loom_workspace_${problem}` }
  }
  if (operation === "thread.message.send") {
    const problem = attachmentFilesProblem(rawInput.files, sendPaths)
    if (problem) return { ok: false, code: `loom_send_${problem}` }
  }
  return { ok: true, call: { operation, input: rawInput } }
}

/**
 * Cheap shape and size check for one write payload, without decoding it.
 *
 * Standard padded base64 decodes to `3 * (length / 4)` bytes minus padding, so an over-limit body is
 * refused from its length alone. Core remains the authority for the exact byte count.
 */
export function workspaceWriteDataProblem(data: string): string | null {
  if (data.length % 4 !== 0) return "write_data_not_base64"
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) return "write_data_not_base64"
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  if ((data.length / 4) * 3 - padding > MAX_WRITE_BYTES) return "write_data_too_large"
  return null
}

/**
 * Pre-check the local sources one group send may name.
 *
 * Each entry must be a non-empty local path string with no NUL and no parent segment. A relative
 * entry is resolved by Core against the Run workspace; an absolute entry is only admissible when it
 * is this Run's own materialized copy inside the canonical `ROVAI_RUN_TMP`. Core's
 * `camp_attachment::freeze_agent_sources` is still the authority: it accepts only the AgentRun
 * workspace or `ROVAI_RUN_TMP`, refuses symlinks and parent components, and freezes a copy. This
 * refuses every other host path — and every shape no authority could accept — before a child exists.
 */
export function attachmentFilesProblem(raw: unknown, paths?: SendPathContext): string | null {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw)) return "files_not_array"
  if (raw.length > 10) return "files_too_many"
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0) return "files_not_string"
    if (entry.includes("\0")) return "files_nul_byte"
    if (entry.length > 4096) return "files_too_long"
    if (entry.split(/[\\/]+/).some((segment) => segment === "..")) return "files_parent_escape"
  }
  return absoluteFilesProblem(raw, paths)
}

/** The run-private directory Core handed this Host, plus the filesystem seam a test can drive. */
export type SendPathContext = { runTmp?: unknown; fsApi?: MaterializeFs }

/**
 * Refuse an arbitrary absolute host path.
 *
 * An absolute entry may only name the run-private copy this bridge materialized: `ROVAI_RUN_TMP`
 * must canonicalize to an existing directory, and the entry must be a regular non-symlink file
 * whose own canonical path is inside it. A Host with no usable run directory refuses every absolute
 * entry rather than guessing.
 */
function absoluteFilesProblem(files: readonly string[], paths?: SendPathContext): string | null {
  const absolute = files.filter(isAbsoluteHostPath)
  if (absolute.length === 0) return null
  const fsApi = paths?.fsApi ?? materializeFs()
  const runTmp = paths?.runTmp
  const root = typeof runTmp === "string" && runTmp.length > 0 ? fsApi.canonicalDirectory(runTmp) : null
  if (root === null) return "path_not_allowed"
  for (const entry of absolute) {
    const settled = fsApi.canonicalFile(entry)
    if (settled === null || !containedIn(root, settled)) return "path_not_allowed"
  }
  return null
}

/** Absolute, drive-qualified or host-rooted: every shape Core would resolve as a host path. */
function isAbsoluteHostPath(entry: string): boolean {
  return isAbsolute(entry) || entry.startsWith("/") || entry.startsWith("\\") || /^[A-Za-z]:/u.test(entry)
}

/** True when `target` is the canonical directory itself or lies beneath it. */
function containedIn(root: string, target: string): boolean {
  const base = norm(root).replace(/[\\/]+$/u, "")
  const full = norm(target)
  return full === base || full.startsWith(base + sep)
}

/**
 * Preserve Core's field shapes for providers. Per-operation required keys are named in the
 * description and checked before a child starts; Core still owns final validation.
 *
 * Every original operation mirrors its catalog schema byte-for-byte. The three workspace
 * operations are the one projection: their flat scalar keys are published without
 * `minimum`/`maximum`/`default`/`format`/`minLength`/`maxLength`/`pattern` or a long description,
 * because OCT/Mistral otherwise refuses this whole tool as too complex. That shallow shape is a
 * provider-compatibility projection only: `validateLoomParams` still refuses an unknown key before
 * a child exists, and Core's closed catalog schema still owns every real bound.
 */
export function loomToolParameters(contracts: WorkflowContracts): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const operation of LOOM_OPERATIONS) {
    const fields = contracts[operation]?.properties
    if (!isRecord(fields)) throw new Error("loom_contract_missing")
    const workspace = operation.startsWith("loom.workspace.")
    for (const [name, schema] of Object.entries(fields)) {
      const projected = workspace && WORKSPACE_PROVIDER_KEYS.includes(name)
        ? providerScalarSchema(name, schema)
        : JSON.parse(JSON.stringify(schema))
      if (Object.hasOwn(properties, name) && JSON.stringify(properties[name]) !== JSON.stringify(projected)) {
        throw new Error("loom_contract_property_conflict")
      }
      properties[name] = projected
    }
  }
  return {
    type: "object",
    additionalProperties: false,
    required: ["operation", "input"],
    properties: {
      operation: { type: "string", enum: [...LOOM_OPERATIONS] },
      input: { type: "object", additionalProperties: false, properties },
    },
  }
}

/** The bare `{ type }` shape a provider sees for one workspace input key. */
function providerScalarSchema(name: string, schema: unknown): Record<string, unknown> {
  if (!isRecord(schema) || (schema.type !== "string" && schema.type !== "integer")) {
    throw new Error(`loom_contract_property_invalid:${name}`)
  }
  return { type: schema.type }
}

// ---------------------------------------------------------------------------
// Invocation plan
// ---------------------------------------------------------------------------

export function loomToolDescription(contracts: WorkflowContracts): string {
  const examples: Record<string, Record<string, unknown>> = {
    "loom.status": {},
    "loom.skill_suggest": { name: "triage-release", description: "Triage a release", instructions: "Inspect evidence before shipping.", rationale: "The user confirmed this repeatable workflow." },
    "loom.plan": { goal: "Deliver the requested file", criteria: [{ criterionId: "file", text: "File is registered and awaits User acceptance" }], tasks: [{ taskId: "task-1", title: "Write the requested file", assigneeAgentId: "member-agent-id", acceptanceCriteria: [{ criterionId: "file", text: "The requested file exists" }] }] },
    "loom.release": { taskId: "task-1" },
    "loom.claim": { taskId: "task-1" },
    "loom.claim_heartbeat": { claimId: "claim-from-claim", fenceGeneration: 1 },
    "loom.evidence": { relativePath: "result.md", taskId: "task-1" },
    "loom.submit": { taskId: "task-1", evidenceIds: ["artifact-from-evidence"] },
    "loom.inspect": { taskId: "task-1" },
    "loom.stage-review": { taskId: "task-1", candidateId: "candidate-from-inspect", policyRevision: 1, manifestHash: "0".repeat(64), verdict: "pass", reason: "The inspected evidence meets the criteria", criteriaResults: [{ criterionId: "file", satisfied: true }] },
    "loom.workspace.list": { workspaceId: "mission-workspace-id" },
    "loom.workspace.read": { workspaceId: "mission-workspace-id", path: "deliverables/report.docx" },
    "loom.workspace.write": { workspaceId: "mission-workspace-id", path: "deliverables/report.md", data: "IyBSZXBvcnQ=" },
    "thread.message.send": { body: "Delivery attached.", files: ["<localFile path returned by loom.workspace.read>"] },
  }
  const lines = [
    "Call one current-Mission operation as {operation, input}. Put the operation's JSON fields inside input. Run, Member and Mission identity come from Core authentication.",
    "Read status first. Only the Default Lead imports the one plan; importing starts the approved automatic dispatch for assigned tasks. Do not release, message, claim, or implement those tasks in the Lead run. In a multi-task plan, task acceptanceCriteria must name only that task's own output; cross-task Mission criteria belong only on the terminal task. An assigned worker claims only its own task before writing, registers each actual file with relativePath, then submits the returned artifactId values. Submit leaves the delivery awaiting User acceptance.",
    "For stage-review, inspect first and copy that candidateId, policyRevision and manifestHash. Review only an authorized task assigned to you; do not review your own output or accept for the User.",
    "Examples show JSON shape. Replace example task, member, candidate and artifact identifiers with actual current values. relativePath is a file path relative to the Mission workspace.",
    "A workspace path is always relative to the prepared Mission workspace: no absolute path, no `..`, no backslash and no `.git` component. `loom.workspace.write` stores exactly one file from complete base64 `data` (at most 1 MiB decoded); it cannot create a directory, delete a file, or run anything.",
    "To deliver real bytes (for example a .docx) into the group: call loom.workspace.read with offset 0 and a maxBytes large enough for the whole file. When the read is not truncated this bridge writes one run-private copy and returns its absolute `localFile` path. Pass exactly that path in thread.message.send files; never invent an output path and never paste binary content into body. If the read reports truncated, re-read with a larger maxBytes; there is no local copy for a partial file.",
    "thread.message.send files accepts only a path relative to the Mission workspace or that returned run-private `localFile` path; any other absolute host path is refused.",
  ]
  for (const operation of LOOM_OPERATIONS) {
    const schema = contracts[operation]
    if (!schema || !isRecord(schema.properties)) throw new Error("loom_contract_missing")
    const required = (schema.required ?? []) as string[]
    const optional = Object.keys(schema.properties).filter(key => !required.includes(key))
    lines.push(`${operation}: required input fields: ${required.join(", ") || "none"}; optional: ${optional.join(", ") || "none"}. Example: ${JSON.stringify({ operation, input: examples[operation] })}`)
  }
  return lines.join("\n")
}

export type Binding = { agentRunId: string; executionEpoch: number }

export type InvocationPlan = {
  cliPath: string
  argv: readonly string[]
  env: Record<string, string>
  stdin: string
  operation: string
  requestId: string
}

/**
 * Build the exact invocation for one tool call: the frozen operation table plus a per-child
 * environment carrying this call's request id. Nothing here reads or writes `process.env`, so two
 * concurrent calls in one Host cannot cross request ids.
 */
export function planInvocation(options: {
  toolCallId: unknown
  params: unknown
  contracts: WorkflowContracts
  grant: unknown
  binding: Binding
  nowMs: number
  cliPath: unknown
  baseEnv: Record<string, string | undefined>
}): { ok: true; plan: InvocationPlan } | { ok: false; code: string } {
  const { grant, binding, nowMs } = options
  if (typeof options.toolCallId !== "string" || options.toolCallId.trim().length === 0) {
    return { ok: false, code: "loom_tool_call_id_missing" }
  }
  if (!isRecord(grant)) return { ok: false, code: "loom_grant_missing" }
  if (grant.schema !== FILE_GRANT_SCHEMA) return { ok: false, code: "loom_grant_schema_mismatch" }
  if (grant.runId !== binding.agentRunId || grant.executionEpoch !== binding.executionEpoch) {
    return { ok: false, code: "loom_grant_binding_mismatch" }
  }
  if (!Array.isArray(grant.allowedTools) || !grant.allowedTools.includes(LOOM_TOOL_NAME)) {
    return { ok: false, code: "loom_tool_not_granted" }
  }
  const expiresAt = grant.expiresAtEpochMs
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || nowMs >= expiresAt) {
    return { ok: false, code: "loom_grant_expired" }
  }
  const validated = validateLoomParams(options.params, options.contracts, {
    runTmp: options.baseEnv[RUN_TMP_ENV],
  })
  if (!validated.ok) return validated
  const resolved = resolveTrustedCli(options.cliPath)
  if (!resolved.ok) return resolved
  const argv = LOOM_OPERATION_ARGV[validated.call.operation]
  if (!argv) return { ok: false, code: "loom_operation_not_allowed" }
  const requestId = deriveRequestId({
    runId: binding.agentRunId,
    executionEpoch: binding.executionEpoch,
    operation: validated.call.operation,
    toolCallId: options.toolCallId,
  })
  const stdin = JSON.stringify(validated.call.input)
  // The budget is UTF-8 bytes, checked before a child exists: a multibyte payload cannot pass as
  // "short" just because its character count is small.
  if (Buffer.byteLength(stdin, "utf8") > MAX_STDIN_BYTES) {
    return { ok: false, code: "loom_input_too_large" }
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.baseEnv)) {
    if (typeof value === "string") env[key] = value
  }
  env[REQUEST_ID_ENV] = requestId
  return {
    ok: true,
    plan: {
      cliPath: resolved.cliPath,
      argv,
      env,
      stdin,
      operation: validated.call.operation,
      requestId,
    },
  }
}

// ---------------------------------------------------------------------------
// Readback materialization
// ---------------------------------------------------------------------------

/** The bytes of one untruncated read, decoded by encoding, never by guesswork. */
export type ReadPayload = { bytes: Buffer; encoding: "utf8" | "base64"; offset: number }

/** Filesystem seam, so the contract test proves the policy without a real Run directory. */
export type MaterializeFs = {
  /** Canonical absolute path of an existing real directory, or null. */
  canonicalDirectory(path: string): string | null
  /** Exclusive create that throws `code: "EEXIST"` instead of replacing a name. */
  createExclusive(path: string, bytes: Buffer): void
  /** Existing regular file bytes, or null when the name is not a regular file. */
  readRegularFile(path: string): Buffer | null
  /** Canonical absolute path of an existing regular file, or null. */
  canonicalFile(path: string): string | null
}

export type MaterializedFile = { path: string; bytes: number; sha256: string }

function base64Payload(raw: unknown): Buffer | null {
  if (typeof raw !== "string" || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(raw)) return null
  const bytes = Buffer.from(raw, "base64")
  // A tolerant decoder can accept a body its own encoder would never emit; the round trip is the check.
  return Buffer.from(bytes.toString("base64"), "base64").equals(bytes) ? bytes : null
}

/**
 * Decode the completed result of one read page. Pure: no filesystem, no environment.
 *
 * Only a whole read is materializable. A truncated page is refused, and so is a page taken from a
 * nonzero offset: its bytes are one slice of the file, and a local copy that silently holds half of
 * a document is worse than no file at all.
 */
export function readPayload(text: unknown):
  | { ok: true; payload: ReadPayload }
  | { ok: false; code: string } {
  if (typeof text !== "string" || text.length === 0) return { ok: false, code: "loom_read_result_missing" }
  let page: unknown
  try {
    page = JSON.parse(text)
  } catch {
    // A page the child itself truncated cannot be trusted to hold the whole file.
    return { ok: false, code: "loom_read_result_unparsable" }
  }
  if (!isRecord(page)) return { ok: false, code: "loom_read_result_missing" }
  if (page.state !== "completed") return { ok: false, code: `loom_read_not_completed:${String(page.state)}` }
  const events = Array.isArray(page.events) ? page.events : []
  let result: Record<string, unknown> | null = null
  for (const event of events) {
    const body = isRecord(event) ? event.body : null
    if (isRecord(body) && body.kind === "completed" && isRecord(body.result) && body.result.kind === "read") {
      result = body.result
    }
  }
  if (result === null) return { ok: false, code: "loom_read_result_missing" }
  if (result.truncated !== false) return { ok: false, code: "loom_read_truncated" }
  if (typeof result.offset !== "number" || !Number.isSafeInteger(result.offset) || result.offset < 0) {
    return { ok: false, code: "loom_read_offset_invalid" }
  }
  // A page from a nonzero offset is a slice, never the whole file: it is reported, not materialized.
  if (result.offset !== 0) return { ok: false, code: "loom_read_offset_nonzero" }
  let bytes: Buffer | null
  let encoding: "utf8" | "base64"
  if (result.encoding === "utf8" && typeof result.text === "string") {
    encoding = "utf8"
    bytes = Buffer.from(result.text, "utf8")
  } else if (result.encoding === "base64") {
    encoding = "base64"
    bytes = base64Payload(result.data)
    if (bytes === null) return { ok: false, code: "loom_read_result_malformed" }
  } else {
    return { ok: false, code: "loom_read_result_malformed" }
  }
  if (bytes.length > MAX_MATERIALIZED_BYTES) return { ok: false, code: "loom_read_result_too_large" }
  return { ok: true, payload: { bytes, encoding, offset: result.offset } }
}

/** The production seam. Nothing here searches PATH, follows a symlink or consults the model. */
function materializeFs(): MaterializeFs {
  return {
    canonicalDirectory(path) {
      try {
        if (!statSync(path).isDirectory()) return null
        return realpathSync(path)
      } catch {
        return null
      }
    },
    createExclusive(path, bytes) {
      const descriptor = openSync(path, "wx", 0o600)
      try {
        writeSync(descriptor, bytes)
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
    },
    readRegularFile(path) {
      try {
        const info = lstatSync(path)
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MATERIALIZED_BYTES) return null
        return readFileSync(path)
      } catch {
        return null
      }
    },
    canonicalFile(path) {
      try {
        const info = lstatSync(path)
        if (!info.isFile() || info.isSymbolicLink()) return null
        return realpathSync(path)
      } catch {
        return null
      }
    },
  }
}

/**
 * Turn the bytes of one untruncated read into a local file under `ROVAI_RUN_TMP`.
 *
 * The name is generated from the payload digest, so a retry maps to the same file and a different
 * payload can never reuse a name. Creation is exclusive: an existing name is either the identical
 * copy (reused) or a conflict (refused). No path comes from the model, nothing is overwritten, and
 * nothing outside the canonicalized run directory is written.
 */
export function materializeReadBack(options: {
  operation: string
  result: RunResult
  requestedPath: unknown
  runTmp: unknown
  fsApi?: MaterializeFs
}): RunResult {
  const { operation, result } = options
  if (operation !== MATERIALIZE_OPERATION || result.isError) return result
  const fsApi = options.fsApi ?? materializeFs()
  const withNote = (code: string): RunResult => ({
    ...result,
    text: `${result.text}\n[rovai] No local attachment copy: ${code}. Use a smaller maxBytes with offset 0 and retry the read if the file must be attached.`,
  })
  const root = typeof options.runTmp === "string" && options.runTmp.length > 0 ? fsApi.canonicalDirectory(options.runTmp) : null
  if (root === null) return withNote("loom_run_tmp_unavailable")
  const decoded = readPayload(result.text)
  if (!decoded.ok) return withNote(decoded.code)
  const { bytes, encoding, offset } = decoded.payload
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const name = `${MATERIALIZED_PREFIX}${sha256.slice(0, 16)}${materializedExtension(options.requestedPath)}`
  const target = join(root, name)
  let reused = false
  try {
    fsApi.createExclusive(target, bytes)
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : ""
    if (code !== "EEXIST") return withNote("loom_materialize_failed")
    const existing = fsApi.readRegularFile(target)
    if (existing === null || !existing.equals(bytes)) return withNote("loom_materialize_conflict")
    reused = true
  }
  // The written name must still resolve to this exact directory: no symlink can stand in for it.
  const settled = fsApi.canonicalFile(target)
  if (settled === null || settled !== join(root, name)) return withNote("loom_materialize_escaped")
  const file: MaterializedFile = { path: settled, bytes: bytes.length, sha256 }
  const header = result.text.length <= MAX_INLINE_RESULT_CHARS
    ? result.text
    : JSON.stringify({ kind: "read", encoding, bytes: bytes.length, offset, truncated: false })
  return {
    ...result,
    localFile: file,
    text: `${header}\n\n[rovai] local file: ${file.path}\n`
      + `${bytes.length} bytes, sha256 ${sha256}, ${reused ? "already materialized" : "written"} under ROVAI_RUN_TMP, untruncated read from offset 0.`
      + ` Pass exactly this path in thread.message.send files to attach it.`,
  }
}

/**
 * Production wiring for one finished call: the extension hands over the planned operation, the raw
 * provider parameters and its own environment, and this resolves the two inputs the readback needs
 * (the requested workspace path and `ROVAI_RUN_TMP`) in ONE place that a unit test can drive.
 */
export function applyReadbackForCall(options: {
  operation: string
  result: RunResult
  params: unknown
  env: Record<string, string | undefined>
  fsApi?: MaterializeFs
}): RunResult {
  const input = isRecord(options.params) && isRecord(options.params.input) ? options.params.input : {}
  const request: Parameters<typeof materializeReadBack>[0] = {
    operation: options.operation,
    result: options.result,
    requestedPath: input.path,
    runTmp: options.env[RUN_TMP_ENV],
  }
  if (options.fsApi) request.fsApi = options.fsApi
  return materializeReadBack(request)
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export type EnvelopeOutcome = {
  ok: boolean
  operation: string | null
  requestId: string | null
  contractVersion: number | null
  result: unknown
  hasError: boolean
  code: string | null
  message: string | null
}

const INVALID_OUTPUT: EnvelopeOutcome = {
  ok: false,
  operation: null,
  requestId: null,
  contractVersion: null,
  result: null,
  hasError: false,
  code: CODE_INVALID_OUTPUT,
  message: null,
}

/** Parse exactly one bounded JSON envelope. Unparsable output is not a success and never a retry. */
export function parseEnvelope(stdout: unknown): EnvelopeOutcome {
  if (typeof stdout !== "string") return INVALID_OUTPUT
  if (stdout.length === 0 || stdout.length > MAX_ENVELOPE_BYTES) return INVALID_OUTPUT
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return INVALID_OUTPUT
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return INVALID_OUTPUT
  }
  if (!isRecord(parsed) || typeof parsed.ok !== "boolean") return INVALID_OUTPUT
  const error = isRecord(parsed.error) ? parsed.error : null
  return {
    ok: parsed.ok,
    operation: typeof parsed.operation === "string" ? parsed.operation : null,
    requestId: typeof parsed.requestId === "string" ? parsed.requestId : null,
    contractVersion: typeof parsed.contractVersion === "number" ? parsed.contractVersion : null,
    result: parsed.result ?? null,
    hasError: error !== null,
    code: error && typeof error.code === "string" ? error.code : null,
    message: error && typeof error.message === "string" ? error.message.slice(0, 2_000) : null,
  }
}

// ---------------------------------------------------------------------------
// Child runtime
// ---------------------------------------------------------------------------

export type ChildStream = { on(event: string, listener: (chunk: unknown) => void): void }
export type ChildProcess = {
  stdin: {
    write(chunk: string): void
    end(): void
    on(event: string, listener: (error: unknown) => void): void
  }
  stdout: ChildStream
  stderr: ChildStream
  on(event: string, listener: (...args: unknown[]) => void): void
  kill(signal?: string): void
}
export type SpawnFn = (command: string, args: readonly string[], options: Record<string, unknown>) => ChildProcess

export type RunResult = {
  isError: boolean
  code: string
  text: string
  /** `true` when Core may have committed the operation; the caller must never retry with a new id. */
  indeterminate: boolean
  /** Set only when an untruncated `loom.workspace.read` produced a run-private local copy. */
  localFile?: MaterializedFile
}

function failure(code: string, text: string, indeterminate: boolean): RunResult {
  return { isError: true, code, text, indeterminate }
}

/** Pi 0.85 marks any fulfilled handler successful; a failed operation must throw. */
export function piToolResult(result: RunResult): { content: { type: string; text: string }[] } {
  if (result.isError) {
    const recovery = result.indeterminate ? " Outcome unknown; do not replay this call. Read LOOM status before recovery." : ""
    const error = new Error(`${result.code}: ${result.text}${recovery}`)
    Object.assign(error, { code: result.code, indeterminate: result.indeterminate })
    throw error
  }
  return { content: [{ type: "text", text: result.text }] }
}

function boundedText(value: unknown): string {
  let text: string
  try {
    text = typeof value === "string" ? value : JSON.stringify(value ?? null)
  } catch {
    text = "null"
  }
  if (typeof text !== "string") text = "null"
  return text.length > MAX_ENVELOPE_BYTES ? `${text.slice(0, MAX_ENVELOPE_BYTES)}\n[truncated]` : text
}

/**
 * Run one planned invocation.
 *
 * - no shell: `spawn(cliPath, argv, { shell: false })`, argv from the frozen table only;
 * - the model's parameters are written to stdin as one JSON object, then stdin is closed;
 * - stdout is bounded by its real UTF-8 byte length and decoded through a `StringDecoder`, so a
 *   multibyte character split across chunks is never corrupted and CJK output cannot pass as "small";
 * - stderr is counted but never surfaced, so a CLI diagnostic can never become model-visible content
 *   or leak an environment credential;
 * - a result only counts when it is THIS call's result: same operation, same request id, the contract
 *   envelope version Core currently emits, and the exit code the CLI contract requires;
 * - anything else is reported as an unknown outcome. Nothing here retries with a fresh request id.
 */
export async function runInvocation(options: {
  spawn: SpawnFn
  plan: InvocationPlan
  signal?: AbortSignal | undefined
  timeoutMs?: number
  /** How long a killed child gets to confirm its own close. Test seam; production uses KILL_CONFIRM_MS. */
  killConfirmMs?: number
}): Promise<RunResult> {
  const { spawn, plan } = options
  const timeoutMs =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const killConfirmMs =
    typeof options.killConfirmMs === "number" && options.killConfirmMs > 0 ? options.killConfirmMs : KILL_CONFIRM_MS
  if (options.signal?.aborted) return failure("loom_cancelled", "LOOM tool call was cancelled.", false)

  return await new Promise<RunResult>((settle) => {
    let settled = false
    let stdout = ""
    let stdoutBytes = 0
    let stderrBytes = 0
    let child: ChildProcess | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    // Set when this call has decided to stop the child. While it is set, the child's own output can no
    // longer be read as a result: the outcome is unknown until that child confirms its close.
    let pending: { code: string; text: string } | null = null
    const decoder = new StringDecoder("utf8")

    const detach = (): void => {
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener?.("abort", onAbort)
    }
    const finish = (result: RunResult): void => {
      if (settled) return
      settled = true
      detach()
      settle(result)
    }
    const killChild = (): void => {
      try {
        child?.kill("SIGKILL")
      } catch {
        // A child that already exited needs no kill.
      }
    }
    /**
     * Stop the child and WAIT for its own close before reporting.
     *
     * Settling immediately after `kill()` would let this Run return while an old CLI process is still
     * alive; a still-running child must never be treated as reusable state, so the outcome stays open
     * until the close is observed — or is declared unknown when it never comes.
     */
    const stop = (code: string, text: string): void => {
      if (settled || pending) return
      pending = { code, text }
      // Arm the confirmation timer FIRST: a child whose kill emits its close synchronously must not
      // leave a dangling timer behind after the outcome is already settled.
      killTimer = setTimeout(() => {
        finish(failure(
          "loom_kill_unconfirmed",
          `${text} The child did not confirm termination, so its outcome is unknown.`,
          true,
        ))
      }, killConfirmMs)
      killChild()
    }
    function onAbort(): void {
      stop("loom_cancelled", "LOOM tool call was cancelled.")
    }

    if (options.signal) {
      options.signal.addEventListener?.("abort", onAbort, { once: true })
    }
    timer = setTimeout(() => {
      stop("loom_timed_out", "LOOM tool call did not finish in time.")
    }, Math.min(timeoutMs, 10 * 60_000))

    try {
      child = spawn(plan.cliPath, plan.argv, {
        // Never a shell: the argv is fixed and stdin carries the parameters.
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: plan.env,
      })
    } catch {
      finish(failure("loom_spawn_failed", "LOOM tool could not be started.", false))
      return
    }
    const bound = child

    /**
     * Classify the child's own close against the CLI contract.
     *
     * A determinate answer is only reachable for THIS call's envelope: the same operation, the same
     * request id, the contract version Core emits, and the exit code that matches the envelope. Every
     * other combination — including readable JSON on exit 0 that is not this call's result — is an
     * unknown outcome, because the operation may already have been committed in Core.
     */
    const classify = (exitCode: unknown): RunResult => {
      const code = typeof exitCode === "number" ? exitCode : null
      const exitText = code === null ? "" : ` (exit ${code})`
      const envelope = parseEnvelope(`${stdout}${decoder.end()}`)
      if (envelope.code === CODE_INVALID_OUTPUT) {
        // Unreadable output is never a determinate failure, even on a clean exit: Core may have run it.
        return failure(
          CODE_INVALID_OUTPUT,
          `LOOM tool returned no readable result${exitText}. It may have been executed.

Do not retry automatically; re-read LOOM status first.`,
          true,
        )
      }
      if (envelope.operation !== plan.operation) {
        return failure("loom_operation_mismatch", "LOOM tool returned another operation's result. The outcome is unknown.", true)
      }
      if (envelope.requestId !== plan.requestId) {
        return failure("loom_request_id_mismatch", "LOOM tool answered without this call's request id. The outcome is unknown.", true)
      }
      if (envelope.contractVersion !== ENVELOPE_VERSION) {
        return failure("loom_envelope_version_mismatch", "LOOM tool answered with an unexpected envelope version. The outcome is unknown.", true)
      }
      if (envelope.ok) {
        if (code !== EXIT_CODES.ok) {
          return failure("loom_exit_mismatch", "LOOM tool reported success without a clean exit. The outcome is unknown.", true)
        }
        if (envelope.hasError || envelope.result === null) {
          return failure("loom_result_missing", "LOOM tool reported success without a result. The outcome is unknown.", true)
        }
        return { isError: false, code: "ok", text: boundedText(envelope.result), indeterminate: false }
      }
      if (!envelope.hasError || envelope.code === null) {
        return failure("loom_rejection_malformed", "LOOM tool rejected without a Core error code. The outcome is unknown.", true)
      }
      const expectedExit = envelope.code === CODE_FEATURE_DISABLED
        ? EXIT_CODES.featureDisabled
        : envelope.code === CODE_OUTCOME_INDETERMINATE
          ? EXIT_CODES.outcomeIndeterminate
          : EXIT_CODES.rejection
      if (code !== expectedExit) {
        return failure(
          "loom_exit_mismatch",
          `LOOM tool exited ${code === null ? "without a code" : code} while reporting a rejection. The outcome is unknown.`,
          true,
        )
      }
      if (envelope.code === CODE_OUTCOME_INDETERMINATE) {
        return failure(envelope.code, envelope.message ?? "The outcome is unknown.", true)
      }
      return {
        isError: true,
        code: envelope.code,
        text: envelope.message ?? "LOOM operation was rejected.",
        indeterminate: false,
      }
    }

    bound.stdout.on("data", (chunk: unknown) => {
      let bytes: number
      let text: string
      if (typeof chunk === "string") {
        bytes = Buffer.byteLength(chunk, "utf8")
        text = chunk
      } else if (chunk instanceof Uint8Array) {
        bytes = chunk.length
        text = decoder.write(Buffer.from(chunk))
      } else {
        const other = String(chunk)
        bytes = Buffer.byteLength(other, "utf8")
        text = other
      }
      if (stdoutBytes + bytes > MAX_ENVELOPE_BYTES) {
        stop("loom_output_too_large", "LOOM tool output exceeded its limit.")
        return
      }
      stdoutBytes += bytes
      stdout += text
    })
    // stderr is counted in bytes, never decoded and never surfaced.
    bound.stderr.on("data", (chunk: unknown) => {
      const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk instanceof Uint8Array ? chunk.length : 0
      stderrBytes = Math.min(stderrBytes + bytes, MAX_CHILD_STREAM_BYTES)
    })
    bound.stdin.on("error", () => {
      // A write that failed part-way may already have reached the CLI, so this is not a clean failure.
      stop("loom_stdin_failed", "LOOM tool could not receive all of its parameters.")
    })
    bound.on("error", (error: unknown) => {
      const name = isRecord(error) && typeof error.code === "string" ? error.code : null
      if (name === "ENOENT") {
        // Nothing was started: no process exists, so this is a determinate pre-execution failure.
        finish(failure("loom_spawn_failed", "LOOM tool could not be started.", false))
        return
      }
      // Any other spawn error may arrive after the process exists, so the outcome stays unknown.
      stop("loom_spawn_failed", "LOOM tool could not be started cleanly.")
    })
    bound.on("close", (code: unknown) => {
      if (pending) {
        // The child confirmed it closed; the operation itself may still have been committed.
        finish(failure(pending.code, `${pending.text} The outcome is unknown; re-read LOOM status first.`, true))
        return
      }
      finish(classify(code))
    })

    try {
      bound.stdin.write(plan.stdin)
      bound.stdin.end()
    } catch {
      stop("loom_stdin_failed", "LOOM tool could not receive its parameters.")
    }
  })
}

/** Bounded, secret-free registration diagnostic for Core's stderr diagnostics channel. */
export function registrationFailureLine(code: string): string {
  return `[rovai-pi-host] ${LOOM_TOOL_NAME} not registered: ${String(code).slice(0, 120)}\n`
}

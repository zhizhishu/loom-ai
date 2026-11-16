// LOOM V2 — real native Pi Extension adapter for the pinned upstream pi-purge source.
//
// - A REAL ExtensionAPI consumer: it registers its own session_start /
//   before_agent_start hooks on the host API and drives the pinned original's own
//   hook implementations. Not a prompt simulator, not another agent loop.
// - Modes here: only 'off' and 'append'. replace/fallback/strict remain in the pure
//   reference contract (scripts/loom-pi-purge-bridge.mjs) and are refused here.
// - No LOOM_PI_PURGE_BINDING_FILE => register nothing, no prompt change.
// - Never mutates/deletes process.env; an inherited PI_PURGE_SOURCE is a refusal.
// - activation sends no model prompt: it is a local command call into the original
//   after the original's session_start reset.
// - Evidence ceiling: runtimeEvidence 'native_extension_local', providerPromptSeen
//   always false, never 'mockExtensionApi' in production, no prompt/persona text.
// - Touches no Core, FileGuard, tool registration, approval, or global config.

import { createHash } from "node:crypto"
import { appendFileSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

export const PIN = Object.freeze({ extensionId: "pi-purge", commit: "d0196ccfd773b0ed342bd2f25372aff65f1a4a53", version: "0.3.0", sha256: "983a3c3cc3011928a33805d84414060729fd2aa81822bc7ba94008943a65d71d" })

export const CONFIG_SCHEMA = "loom.pi-purge.run.v1"
export const SUPPORTED_MODES = Object.freeze(["off", "append"])
export const UNSUPPORTED_MODES = Object.freeze(["replace", "fallback", "strict"])
export const RUNTIME_EVIDENCE = "native_extension_local"
export const BINDING_ENV = "LOOM_PI_PURGE_BINDING_FILE"
export const HOST_BINDING_ENV = "ROVAI_PI_HOST_BINDING_FILE"
export const FILE_GRANT_ENV = "ROVAI_PI_FILE_GRANT_FILE"
export const FILE_GRANT_SCHEMA = "loom.runtime.file-guard.v1"

const CONFIG_KEYS = Object.freeze([
  "schema", "runId", "botId", "executionEpoch", "mode",
  "upstreamPath", "upstreamSha256", "personaPath", "personaSha256", "receiptPath",
])
const MAX_CONFIG_BYTES = 16 * 1024
const MAX_PERSONA_BYTES = 64 * 1024
const MAX_BINDING_BYTES = 64 * 1024
const HEX64 = /^[0-9a-f]{64}$/

const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex")
const norm = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p))
const isWithin = (parent, child) => {
  const base = norm(parent)
  const target = norm(child)
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep)
}

/** Read a bounded regular file, refusing symlinked or non-canonical paths. */
function readPlainFile(label, absPath, maxBytes) {
  if (typeof absPath !== "string" || absPath.trim() === "") return { error: `${label}_path_required` }
  if (!isAbsolute(absPath)) return { error: `${label}_path_must_be_absolute` }
  let stat
  try { stat = lstatSync(absPath) } catch { return { error: `${label}_missing` } }
  if (stat.isSymbolicLink()) return { error: `${label}_symlink_rejected` }
  if (!stat.isFile()) return { error: `${label}_not_regular_file` }
  if (stat.size === 0) return { error: `${label}_empty` }
  if (stat.size > maxBytes) return { error: `${label}_too_large` }
  let realPath
  try { realPath = realpathSync(absPath) } catch { return { error: `${label}_unresolvable` } }
  if (norm(realPath) !== norm(absPath)) return { error: `${label}_non_canonical_or_symlinked_ancestor` }
  const bytes = readFileSync(realPath)
  if (bytes.length !== stat.size) return { error: `${label}_size_drift` }
  return { realPath, bytes, sha256: sha256Hex(bytes) }
}

// A receipt target may not exist yet: canonicalise its parent and refuse any symlink.
function canonicalOutputPath(label, absPath) {
  if (typeof absPath !== "string" || !isAbsolute(absPath)) return { error: `${label}_must_be_absolute` }
  const abs = resolve(absPath)
  let stat = null
  try { stat = lstatSync(abs) } catch { stat = null }
  if (stat && stat.isSymbolicLink()) return { error: `${label}_symlink_rejected` }
  if (stat && !stat.isFile()) return { error: `${label}_not_regular_file` }
  let parentReal
  try { parentReal = realpathSync(dirname(abs)) } catch { return { error: `${label}_parent_unresolvable` } }
  return { realPath: join(parentReal, basename(abs)) }
}

function readBoundedJson(label, absPath) {
  const file = readPlainFile(label, absPath, MAX_BINDING_BYTES)
  if (file.error) return { error: file.error }
  try {
    return { value: JSON.parse(file.bytes.toString("utf8")) }
  } catch {
    return { error: `${label}_not_json` }
  }
}

/**
 * Cross-check the run owner against an independently supplied expectedRun, or,
 * when that is absent, against the ROVAI host-binding + file-grant files.
 * Exact schemas (no permissive fallback):
 * - Core HostBinding carries agentRunId + executionEpoch and NO botId.
 * - botId is derived only from the fileGrant top-level field.
 * - Both host.agentRunId and grant.runId must equal config.runId; both epochs match.
 */
function resolveOwner(config, expectedRun, env) {
  if (expectedRun !== undefined && expectedRun !== null) {
    if (typeof expectedRun !== "object") return ["expectedRun_must_be_object"]
    const errors = []
    if (expectedRun.runId !== config.runId) errors.push("runId_mismatch_expectedRun")
    if (expectedRun.botId !== config.botId) errors.push("botId_mismatch_expectedRun")
    if (expectedRun.executionEpoch !== config.executionEpoch) errors.push("executionEpoch_mismatch_expectedRun")
    return errors
  }
  const hostPath = env[HOST_BINDING_ENV]
  const grantPath = env[FILE_GRANT_ENV]
  if (!hostPath || !grantPath) return ["owner_context_missing_expectedRun_or_rovai_files"]
  const host = readBoundedJson("host_binding", hostPath)
  if (host.error) return [host.error]
  const grant = readBoundedJson("file_grant", grantPath)
  if (grant.error) return [grant.error]
  const errors = []
  const hostRunId = host.value?.agentRunId
  const hostEpoch = host.value?.executionEpoch
  const grantSchema = grant.value?.schema
  const grantRunId = grant.value?.runId
  const grantEpoch = grant.value?.executionEpoch
  const grantBotId = grant.value?.botId
  if (grantSchema !== FILE_GRANT_SCHEMA) errors.push(`file_grant_schema_must_be_${FILE_GRANT_SCHEMA}`)
  if (hostRunId !== config.runId) errors.push("runId_mismatch_host_binding_agentRunId")
  if (grantRunId !== config.runId) errors.push("runId_mismatch_file_grant")
  if (hostEpoch !== config.executionEpoch) errors.push("executionEpoch_mismatch_host_binding")
  if (grantEpoch !== config.executionEpoch) errors.push("executionEpoch_mismatch_file_grant")
  if (typeof grantBotId !== "string" || grantBotId === "") errors.push("botId_missing_in_file_grant")
  else if (grantBotId !== config.botId) errors.push("botId_mismatch_file_grant")
  return errors
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/** Validate a parsed run config plus its on-disk containment and owner. */
export function validateRunConfig(raw, { configPath, expectedRun, env = process.env } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["config_must_be_object"] }
  const errors = []
  for (const key of Object.keys(raw)) if (!CONFIG_KEYS.includes(key)) errors.push(`unknown_key:${key}`)
  for (const key of CONFIG_KEYS) if (raw[key] === undefined) errors.push(`missing_key:${key}`)
  if (errors.length > 0) return { ok: false, errors }

  if (raw.schema !== CONFIG_SCHEMA) errors.push(`schema_must_be_${CONFIG_SCHEMA}`)
  if (typeof raw.runId !== "string" || raw.runId.trim() === "") errors.push("runId_invalid")
  if (typeof raw.botId !== "string" || raw.botId.trim() === "") errors.push("botId_invalid")
  if (!Number.isInteger(raw.executionEpoch) || raw.executionEpoch < 1) errors.push("executionEpoch_invalid")

  if (UNSUPPORTED_MODES.includes(raw.mode)) errors.push(`mode_not_supported_here:${raw.mode}`)
  else if (!SUPPORTED_MODES.includes(raw.mode)) errors.push("mode_invalid")

  if (typeof raw.upstreamSha256 !== "string" || !HEX64.test(raw.upstreamSha256)) errors.push("upstreamSha256_invalid")
  else if (raw.upstreamSha256 !== PIN.sha256) errors.push("upstreamSha256_must_match_pinned_reference")
  if (typeof raw.personaSha256 !== "string" || !HEX64.test(raw.personaSha256)) errors.push("personaSha256_invalid")

  for (const key of ["upstreamPath", "personaPath", "receiptPath"]) {
    if (typeof raw[key] !== "string" || !isAbsolute(raw[key])) errors.push(`${key}_must_be_absolute`)
  }

  // No global env scrubbing: an inherited source is a refusal, not a thing to delete.
  const inherited = env.PI_PURGE_SOURCE
  if (typeof inherited === "string" && inherited.trim() !== "") errors.push("inherited_PI_PURGE_SOURCE_refused")

  if (errors.length > 0) return { ok: false, errors }

  const configFile = readPlainFile("config", configPath, MAX_CONFIG_BYTES)
  if (configFile.error) return { ok: false, errors: [configFile.error] }
  const runDir = dirname(configFile.realPath)
  const personaFile = readPlainFile("persona", raw.personaPath, MAX_PERSONA_BYTES)
  if (personaFile.error) return { ok: false, errors: [personaFile.error] }
  if (personaFile.sha256 !== raw.personaSha256) return { ok: false, errors: ["personaSha256_mismatch"] }

  const receiptFile = canonicalOutputPath("receipt", raw.receiptPath)
  if (receiptFile.error) return { ok: false, errors: [receiptFile.error] }

  // config / persona / receipt must share the one explicit private run directory.
  if (!isWithin(runDir, configFile.realPath)) return { ok: false, errors: ["config_outside_run_dir"] }
  if (!isWithin(runDir, personaFile.realPath)) return { ok: false, errors: ["persona_outside_run_dir"] }
  if (!isWithin(runDir, receiptFile.realPath)) return { ok: false, errors: ["receipt_outside_run_dir"] }

  const upstreamFile = readPlainFile("upstream", raw.upstreamPath, 4 * MAX_PERSONA_BYTES)
  if (upstreamFile.error) return { ok: false, errors: [upstreamFile.error] }
  const upstreamSha = upstreamFile.sha256
  if (upstreamSha !== PIN.sha256) return { ok: false, errors: ["upstream_file_sha256_not_pinned_source"] }

  // The receipt must not overwrite any input, config, or the pinned source.
  const receiptNorm = norm(receiptFile.realPath)
  if (receiptNorm === norm(configFile.realPath)) errors.push("receipt_collides_config")
  if (receiptNorm === norm(personaFile.realPath)) errors.push("receipt_collides_persona")
  if (receiptNorm === norm(upstreamFile.realPath)) errors.push("receipt_collides_upstream")

  errors.push(...resolveOwner(raw, expectedRun, env))
  if (errors.length > 0) return { ok: false, errors }

  const frozen = deepFreeze({ ...raw })
  return {
    ok: true,
    config: frozen,
    meta: Object.freeze({
      configPath: configFile.realPath,
      configSha256: configFile.sha256,
      runDir,
      personaPath: personaFile.realPath,
      personaSha256: personaFile.sha256,
      upstreamPath: upstreamFile.realPath,
      upstreamSha256: upstreamSha,
      receiptPath: receiptFile.realPath,
    }),
  }
}

/** Load + verify a run binding from the explicit config file. */
export function loadManagedBinding({ configPath, expectedRun, env = process.env } = {}) {
  if (typeof configPath !== "string" || configPath.trim() === "") return { ok: false, errors: ["configPath_required"] }
  if (!isAbsolute(configPath)) return { ok: false, errors: ["configPath_must_be_absolute"] }
  const file = readPlainFile("config", configPath, MAX_CONFIG_BYTES)
  if (file.error) return { ok: false, errors: [file.error] }
  let raw
  try {
    raw = JSON.parse(file.bytes.toString("utf8"))
  } catch {
    return { ok: false, errors: ["config_not_json"] }
  }
  const checked = validateRunConfig(raw, { configPath, expectedRun, env })
  if (!checked.ok) return checked
  return { ok: true, binding: Object.freeze({ ...checked.config, ...checked.meta }) }
}

function systemText(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").join("\n\n")
  return typeof value === "string" ? value : ""
}

let instanceCounter = 0

/**
 * Register the managed adapter on a real (or test-mock) ExtensionAPI.
 * binding comes from loadManagedBinding; config values are frozen.
 */
export async function registerManagedPiPurge(api, binding) {
  if (!api || typeof api.on !== "function" || typeof api.registerCommand !== "function") {
    return { ok: false, status: "refused", errors: ["extension_api_invalid"] }
  }
  if (!binding || typeof binding !== "object") return { ok: false, status: "refused", errors: ["binding_required"] }

  // Per-instance module URL so the pinned original gets fresh module-level state.
  const url = pathToFileURL(binding.upstreamPath)
  url.searchParams.set("loom-pi-purge-instance", `${binding.runId}:${binding.executionEpoch}:${++instanceCounter}`)
  let captured
  try {
    const mod = await import(url.href)
    if (typeof mod.default !== "function") return { ok: false, status: "refused", errors: ["upstream_missing_default_export"] }
    const buckets = { sessionStart: [], beforeAgentStart: [], purge: null, unexpected: [] }
    const proxyApi = {
      on(event, handler) {
        if (event === "session_start") buckets.sessionStart.push(handler)
        else if (event === "before_agent_start") buckets.beforeAgentStart.push(handler)
        else buckets.unexpected.push(`on:${event}`)
        return proxyApi
      },
      registerCommand(name, definition) {
        // Never forwarded to the host: the mutable public /purge command stays unreachable.
        if (name === "purge" && buckets.purge === null) buckets.purge = definition
        else buckets.unexpected.push(`command:${name}`)
        return proxyApi
      },
    }
    mod.default(proxyApi)
    captured = buckets
  } catch (error) {
    return { ok: false, status: "refused", errors: [`upstream_import_failed:${error instanceof Error ? error.message : String(error)}`] }
  }

  const drift = captured.unexpected.length > 0
    || captured.sessionStart.length !== 1
    || captured.beforeAgentStart.length !== 1
    || !captured.purge || typeof captured.purge.handler !== "function"
  if (drift) return { ok: false, status: "refused", errors: ["upstream_registration_drift"] }

  const localContext = () => {
    const notifications = []
    const statuses = []
    return { notifications, statuses, ui: {
      notify(text, level = "info") { notifications.push({ text: String(text), level }) },
      setStatus(key, text) { statuses.push({ key, text }) },
    } }
  }

  const writeReceipt = (record) => {
    // Re-canonicalise before every append: a path swapped for a symlink (or any
    // non-regular file) after load must never be followed.
    const target = canonicalOutputPath("receipt", binding.receiptPath)
    if (target.error) return false
    if (norm(target.realPath) !== norm(binding.receiptPath)) return false
    if (typeof binding.runDir === "string" && !isWithin(binding.runDir, target.realPath)) return false
    try {
      appendFileSync(target.realPath, `${JSON.stringify(record)}\n`)
      return true
    } catch {
      return false
    }
  }

  const baseRecord = (hook) => ({
    schema: "loom.pi-purge.receipt.v1", runtimeEvidence: RUNTIME_EVIDENCE, providerPromptSeen: false,
    runId: binding.runId, botId: binding.botId, executionEpoch: binding.executionEpoch,
    hook, mode: binding.mode,
    upstreamExtensionId: PIN.extensionId, upstreamCommit: PIN.commit, upstreamVersion: PIN.version, upstreamSha256: PIN.sha256,
    configSha256: binding.configSha256, personaSha256: binding.personaSha256,
    at: new Date().toISOString(),
  })

  // Tamper recheck before every hook: config bytes and persona bytes must still match.
  const recheck = () => {
    const configFile = readPlainFile("config", binding.configPath, MAX_CONFIG_BYTES)
    if (configFile.error) return { ok: false, code: configFile.error }
    if (configFile.sha256 !== binding.configSha256) return { ok: false, code: "config_tampered" }
    const personaFile = readPlainFile("persona", binding.personaPath, MAX_PERSONA_BYTES)
    if (personaFile.error) return { ok: false, code: personaFile.error }
    if (personaFile.sha256 !== binding.personaSha256) return { ok: false, code: "persona_tampered" }
    return { ok: true }
  }

  let activationAdmitted = false

  async function onSessionStart() {
    activationAdmitted = false
    const checked = recheck()
    if (!checked.ok) {
      writeReceipt({ ...baseRecord("session_start"), activated: false, refused: checked.code })
      return
    }
    const ctx = localContext()
    // 1. the pinned original's own reset (enabled=false, lastCut cleared, reload).
    for (const handler of captured.sessionStart) await handler({}, ctx)
    if (binding.mode === "off") {
      writeReceipt({ ...baseRecord("session_start"), activated: false, reason: "mode_off" })
      return
    }
    // 2. re-activate through the original's registered command handler, in this order.
    await captured.purge.handler(`source ${binding.personaPath}`, ctx)
    await captured.purge.handler("mode append", ctx)
    await captured.purge.handler("on", ctx)
    const activated = ctx.notifications.some((entry) => entry.text.includes("已开启"))
    const recorded = writeReceipt({ ...baseRecord("session_start"), activated, reason: activated ? null : "activation_not_confirmed" })
    activationAdmitted = activated && recorded
  }

  async function onBeforeAgentStart(event) {
    if (binding.mode === "off" || !activationAdmitted) return undefined
    const checked = recheck()
    if (!checked.ok) {
      writeReceipt({ ...baseRecord("before_agent_start"), applied: false, refused: checked.code })
      return undefined
    }
    const ctx = localContext()
    const result = await captured.beforeAgentStart[0](event, ctx)
    const hostText = systemText(event?.systemPrompt)
    if (!result || typeof result.systemPrompt !== "string") {
      writeReceipt({ ...baseRecord("before_agent_start"), applied: false, reason: "upstream_noop" })
      return undefined
    }
    // append semantics: the original host prompt must survive whole.
    if (hostText.length > 0 && !result.systemPrompt.endsWith(hostText)) {
      writeReceipt({ ...baseRecord("before_agent_start"), applied: false, reason: "host_text_not_preserved" })
      return undefined
    }
    const recorded = writeReceipt({
      ...baseRecord("before_agent_start"),
      applied: true,
      reason: null,
      promptDigest: sha256Hex(Buffer.from(result.systemPrompt, "utf8")),
      hostTextDigest: sha256Hex(Buffer.from(hostText, "utf8")),
    })
    // Without a written local receipt, do not apply a persona the Host cannot account for.
    if (!recorded) {
      activationAdmitted = false
      return undefined
    }
    return result
  }

  api.on("session_start", onSessionStart)
  api.on("before_agent_start", onBeforeAgentStart)
  return { ok: true, status: "registered", mode: binding.mode, hooks: ["session_start", "before_agent_start"] }
}

/** Default Pi extension entry: absent binding file => no hooks, no prompt change. */
export default async function loomPiPurgeExtension(api, options = {}) {
  const env = options.env ?? process.env
  const configPath = options.configPath ?? env[BINDING_ENV]
  if (typeof configPath !== "string" || configPath.trim() === "") {
    return { ok: true, status: "disabled_no_binding", hooks: [] }
  }
  const loaded = loadManagedBinding({ configPath, expectedRun: options.expectedRun, env })
  // Pi ignores an extension entry's return value: an explicitly requested binding
  // that fails verification must surface as a hard error instead of silence.
  if (!loaded.ok) throw new Error(`loom_pi_purge_binding_invalid:${loaded.errors.join(",")}`)
  const registered = await registerManagedPiPurge(api, loaded.binding)
  if (!registered.ok) throw new Error(`loom_pi_purge_register_failed:${registered.errors.join(",")}`)
  return registered
}

// LOOM V2 — authorized per-run Pi 0.85.1 execution entry (real model path, guarded file tools).
//
// Contract (Root review 2026-11-16, all items hard):
// 1. cwd / `--tools` are NOT a path sandbox. Every tool call is gated by our own native Pi extension
//    (scripts/loom-v2-runtime-file-guard.ts, loaded with an explicit `--extension` while
//    `--no-extensions` disables auto-discovery). Only `read`/`write`/`edit` inside the granted
//    workspace realpath are permitted; absolute escapes, `..`, Windows case/UNC/device paths,
//    symlink/junction escapes and sensitive files (.git, keys, .env, auth/models) are refused.
//    A run without a loaded guard FAILS CLOSED — the runner never reports a green run from `--tools`
//    alone. OS-level sandboxing is NOT claimed (evidence: `osSandbox:false`).
// 2. Tool evidence must come from real `tool_execution_start`/`tool_execution_end` events (or an
//    executed `toolResult` linked by toolCallId) AND from a matching guard `allow` decision. A model
//    `toolcall_start` intention is never counted as an execution. Timeouts abort and then wait for
//    settle; if settle cannot be confirmed the status is `unknown_outcome` with `replayable:false`.
//    Only this run's own process tree is killed.
// 3. No claim about the backend: `providerConnection` + `declaredModelId` + `actualBackendVerified:false`.
//    `realCommercialModel` is never asserted. Logs carry no key, no prompt text, no tool payload and
//    no URL query. Host-side artifacts come only from an explicit `expectedArtifactPaths` list
//    (relative, in-workspace, non-symlink); the workspace is never walked.
// 4. Credentials are referenced by env var NAME only; nothing is copied from user auth/models config.
//    All launch flags below were verified present in the pinned 0.85.1 CLI parser
//    (resources/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js:40 `--mode`,
//    :76 `--no-session`, :100 `--tools`, :135 `--extension`, :139 `--no-extensions`, :164 `--no-skills`,
//    :173 `--no-context-files`, :211 `--offline`). Project trust is left at Pi's non-interactive
//    default (README.md:302): project-local resources are ignored because the agent dir is a fresh
//    temp dir — we do NOT pass `--approve`/`--no-approve` as an "authorization".
// 5. Every safety check throws; none is downgraded to a warning.
//
// Boundaries: no Core/DB/UI/global-config/port-64851/remote side effects; no delegation; no shell
// execution by this module; the caller owns the workspace and the grant.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { BOT_ID_PATTERN, assertNoSecrets } from './loom-v2-two-worker-loopback.mjs'
import { PINNED_PI, buildIsolatedEnv, sha256Hex } from './loom-v2-managed-pi-rpc.mjs'
import { PI_BUNDLE_LOCKED_VERSION, assertPinnedPiBundle, defaultPiBin } from './loom-v2-pi-loopback-provider.mjs'

// `assertSandboxRoot` (managed-pi-rpc.mjs:204) requires agentDir AND workspace to live inside ONE
// sandbox root. A per-run grant keeps the caller's workspace outside our temp root, so that helper is
// deliberately not used here; `assertRunIsolation` below performs the narrower check we need.
// `PINNED_PI` (managed-pi-rpc.mjs:43) pins the same bundle this runner verifies before every spawn.

export const RUNTIME_EXECUTION_SCHEMA = 'loom.runtime.execution-receipt.v1'
export const RUNTIME_GUARD_SCHEMA = 'loom.runtime.file-guard.v1'
export const RUNTIME_GUARD_ENV = 'LOOM_RUN_GUARD'
export const RUNTIME_TOOL_ALLOWLIST = Object.freeze(['read', 'write', 'edit'])
export const RUN_STATUSES = Object.freeze(['settled', 'failed', 'cancelled', 'unknown_outcome'])
export const API_KEY_ENV_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
export const DEFAULT_PROMPT_TIMEOUT_MS = 180_000
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
export const DEFAULT_SETTLE_AFTER_ABORT_MS = 20_000
export const DEFAULT_GUARD_READY_TIMEOUT_MS = 10_000
export const DEFAULT_STOP_GRACE_MS = 8_000
export const DEFAULT_STOP_KILL_MS = 5_000
export const MAX_GRANT_WINDOW_MS = 24 * 60 * 60 * 1000
export const MAX_CAPTURED_EVENTS = 8_000
const MAX_CAPTURED_STDERR = 400

// Deny-list shared with the guard (defence in depth for the Host-side artifact list).
const SENSITIVE_SEGMENTS = Object.freeze([
  '.git', '.ssh', '.gnupg', '.aws', '.env', '.npmrc', '.netrc', '.pgpass',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'auth.json', 'models.json', 'trust.json', 'credentials', 'credentials.json'
])
const SENSITIVE_SUFFIXES = Object.freeze(['.pem', '.key', '.pfx', '.p12', '.kdbx', '.keystore', '.jks'])

export function defaultGuardPath() {
  return join(import.meta.dirname, 'loom-v2-runtime-file-guard.ts')
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function stableJson(value) {
  if (value === undefined) return 'undefined'
  const seen = new WeakSet()
  const walk = (node) => {
    if (node === null || typeof node !== 'object') {
      if (typeof node === 'bigint') return `${node.toString()}n`
      return node
    }
    if (seen.has(node)) return '[circular]'
    seen.add(node)
    if (Array.isArray(node)) return node.map(walk)
    const out = {}
    for (const key of Object.keys(node).sort()) out[key] = walk(node[key])
    return out
  }
  try {
    return JSON.stringify(walk(value))
  } catch {
    return '[unserializable]'
  }
}

function digestOf(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Diagnostics are the one place a third party (Pi's stderr) could echo a credential or a URL query.
 * Strip bearer tokens, key-shaped tokens and every query string before anything leaves the module.
 */
export function sanitizeDiagnosticText(value, { maxLength = 4_000 } = {}) {
  let text = typeof value === 'string' ? value : String(value ?? '')
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
  text = text.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[redacted-key]')
  text = text.replace(/\?[^\s"']*/g, '?[redacted-query]')
  text = text.replace(/([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_]*)(\s*[=:]\s*)(["']?)[^\s"',;]+/gi, '$1$2$3[redacted]')
  return text.slice(0, maxLength)
}

function insidePath(child, parent) {
  const normalize = (value) => {
    const unified = value.split(sep).join('/')
    return process.platform === 'win32' ? unified.toLowerCase() : unified
  }
  const c = normalize(child)
  const p = normalize(parent)
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`)
}

function realpathOrNull(target) {
  try {
    return realpathSync(target)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Per-run grant
// ---------------------------------------------------------------------------

/**
 * Validate the explicit per-run grant. Nothing is spawned before this passes.
 *
 * @param {unknown} grant
 * @param {{now?: number}} [options]
 */
export function assertPerRunGrant(grant, { now = Date.now() } = {}) {
  if (!isPlainObject(grant)) throw new Error('grant_must_be_object')
  const runId = grant.runId
  const botId = grant.botId
  if (typeof runId !== 'string' || !BOT_ID_PATTERN.test(runId)) throw new Error('grant_runId_invalid')
  if (typeof botId !== 'string' || !BOT_ID_PATTERN.test(botId)) throw new Error('grant_botId_invalid')

  const workspaceRoot = grant.workspaceRoot
  if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot)) throw new Error('grant_workspaceRoot_must_be_absolute')

  const allowedTools = grant.allowedTools
  if (!Array.isArray(allowedTools) || allowedTools.length === 0) throw new Error('grant_allowedTools_must_be_non_empty_array')
  for (const tool of allowedTools) {
    if (!RUNTIME_TOOL_ALLOWLIST.includes(tool)) throw new Error(`grant_tool_not_permitted:${String(tool)}`)
  }
  if (new Set(allowedTools).size !== allowedTools.length) throw new Error('grant_allowedTools_has_duplicates')

  // Read-only is the default posture. `write`/`edit` are only admitted for a workspace the grant
  // explicitly declares as isolated and self-owned — never for a shared, untrusted user directory.
  const isolatedSelfOwnedWorkspace = grant.isolatedSelfOwnedWorkspace === true
  const wantsMutation = allowedTools.some((tool) => tool === 'write' || tool === 'edit')
  if (wantsMutation && !isolatedSelfOwnedWorkspace) {
    throw new Error('grant_write_requires_isolated_self_owned_workspace')
  }

  const expiresAtEpochMs = normalizeExpiry(grant.expiresAt)
  if (!Number.isInteger(expiresAtEpochMs)) throw new Error('grant_expiresAt_invalid')
  if (expiresAtEpochMs <= now) throw new Error('grant_expired')
  if (expiresAtEpochMs - now > MAX_GRANT_WINDOW_MS) throw new Error('grant_window_too_long')

  const normalized = Object.freeze({
    runId,
    botId,
    workspaceRoot: resolve(workspaceRoot),
    allowedTools: Object.freeze([...allowedTools]),
    expiresAtEpochMs,
    isolatedSelfOwnedWorkspace,
    workspaceOwnership: isolatedSelfOwnedWorkspace ? 'isolated-self-owned' : 'read-only-grant'
  })
  return Object.freeze({ ...normalized, grantSha256: digestOf({ ...normalized }) })
}

function normalizeExpiry(expiresAt) {
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) return Math.trunc(expiresAt)
  if (typeof expiresAt === 'string') {
    const parsed = Date.parse(expiresAt)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

// ---------------------------------------------------------------------------
// Model configuration (explicit, authorized, env-referenced credential)
// ---------------------------------------------------------------------------

/**
 * Validate the explicitly authorized model configuration.
 * The credential is referenced by ENV VAR NAME only; no value is read or stored here.
 */
export function assertAuthorizedModelConfig(config) {
  if (!isPlainObject(config)) throw new Error('model_config_must_be_object')
  const providerId = config.providerId
  if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) throw new Error('model_providerId_invalid')
  const modelId = config.modelId
  if (typeof modelId !== 'string' || !MODEL_ID_PATTERN.test(modelId)) throw new Error('model_modelId_invalid')
  if (config.api !== 'openai-completions') throw new Error('model_api_must_be_openai_completions')
  const apiKeyEnvVar = config.apiKeyEnvVar
  if (typeof apiKeyEnvVar !== 'string' || !API_KEY_ENV_PATTERN.test(apiKeyEnvVar)) throw new Error('model_apiKeyEnvVar_invalid')

  const baseUrl = config.baseUrl
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) throw new Error('model_baseUrl_missing')
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error('model_baseUrl_unparsable')
  }
  if (parsed.username !== '' || parsed.password !== '') throw new Error('model_baseUrl_must_not_embed_credentials')
  if (parsed.search !== '' || parsed.hash !== '') throw new Error('model_baseUrl_must_not_carry_query_or_hash')
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('model_baseUrl_protocol_not_permitted')

  const hostname = parsed.hostname
  const isLoopbackHost = hostname === '127.0.0.1' || hostname === 'localhost'
  if (parsed.protocol === 'http:' && !isLoopbackHost) throw new Error('model_baseUrl_http_must_be_loopback')
  if (parsed.protocol === 'https:' && isLoopbackHost) throw new Error('model_baseUrl_https_loopback_ambiguous')

  // The provider connection kind is derived from the endpoint, never from a caller flag.
  const providerConnection = parsed.protocol === 'http:' && isLoopbackHost ? 'loopback-mock' : 'external'
  const reservedMockIds = ['loopback', 'loom-mock']
  if (providerConnection === 'loopback-mock' && !reservedMockIds.includes(providerId)) {
    throw new Error('model_loopback_endpoint_requires_mock_provider_id')
  }
  if (providerConnection === 'external' && reservedMockIds.includes(providerId)) {
    throw new Error('model_external_endpoint_must_not_use_mock_provider_id')
  }

  const contextWindow = config.contextWindow ?? 32_768
  const maxTokens = config.maxTokens ?? 1_024
  if (!Number.isInteger(contextWindow) || contextWindow < 1_024) throw new Error('model_contextWindow_invalid')
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('model_maxTokens_invalid')

  return Object.freeze({
    providerId,
    modelId,
    api: 'openai-completions',
    baseUrl,
    baseUrlOrigin: parsed.origin,
    baseUrlHost: hostname,
    baseUrlPort: parsed.port === '' ? null : Number(parsed.port),
    apiKeyEnvVar,
    contextWindow,
    maxTokens,
    providerConnection,
    mockProvider: providerConnection === 'loopback-mock'
  })
}

/**
 * Resolve the credential from the caller's environment by NAME. The value is returned to the caller
 * for child-process injection only; it is never logged, never written to a profile, never hashed into
 * evidence, and never returned inside the receipt.
 */
export function resolveApiKeyValue(model, { env = process.env } = {}) {
  const value = env[model.apiKeyEnvVar]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`credential_env_missing:${model.apiKeyEnvVar}`)
  }
  if (value.length < 8 || /\s/.test(value)) throw new Error('credential_env_value_invalid')
  return value
}

// ---------------------------------------------------------------------------
// Launch contract
// ---------------------------------------------------------------------------

export function buildAuthorizedPiArgv({ guardPath = defaultGuardPath(), tools } = {}) {
  if (typeof guardPath !== 'string' || !isAbsolute(guardPath)) throw new Error('guard_path_must_be_absolute')
  if (!guardPath.endsWith('.ts')) throw new Error('guard_path_must_be_typescript_extension')
  if (!Array.isArray(tools) || tools.length === 0) throw new Error('tools_must_be_non_empty_array')
  for (const tool of tools) {
    if (!RUNTIME_TOOL_ALLOWLIST.includes(tool)) throw new Error(`tool_not_permitted:${String(tool)}`)
  }
  return [
    '--mode', 'rpc',
    '--offline',
    '--no-session',
    '--no-context-files',
    '--no-skills',
    '--no-extensions',
    '--tools', tools.join(','),
    '--extension', guardPath
  ]
}

export function buildAuthorizedEnv({ agentDir, model, apiKeyValue, guardConfig, baseEnv = process.env, additionalEnv = {} }) {
  if (typeof agentDir !== 'string' || !isAbsolute(agentDir)) throw new Error('agentDir_must_be_absolute')
  if (typeof apiKeyValue !== 'string' || apiKeyValue.length === 0) throw new Error('apiKeyValue_missing')
  if (!isPlainObject(additionalEnv)) throw new Error('additionalEnv_must_be_object')
  const env = buildIsolatedEnv({
    agentDir,
    baseEnv,
    env: {
      ...additionalEnv,
      [model.apiKeyEnvVar]: apiKeyValue,
      [RUNTIME_GUARD_ENV]: JSON.stringify(guardConfig),
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost'
    }
  })
  // Defence in depth: the inherited env is already an allowlist (managed-pi-rpc.mjs:262), so any
  // credential-shaped key other than the authorized one means the contract was broken. `additionalEnv`
  // is the only other way a caller can add a variable, so it is covered by the same check.
  for (const key of Object.keys(env)) {
    if (key === model.apiKeyEnvVar) continue
    if (/(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) throw new Error(`env_credential_not_authorized:${key}`)
  }
  return env
}

/**
 * Write the isolated profile. The apiKey is stored as a `$ENV_VAR` reference (Pi resolves it via
 * dist/core/resolve-config-value.js:123); the literal secret never touches disk. No auth.json is
 * written and no global models/auth file is read.
 */
export async function writeAuthorizedProfile({ agentDir, model }) {
  if (typeof agentDir !== 'string' || !isAbsolute(agentDir)) throw new Error('agentDir_must_be_absolute')
  await mkdir(agentDir, { recursive: true })
  const models = {
    providers: {
      [model.providerId]: {
        name: `LOOM run provider (${model.providerConnection})`,
        baseUrl: model.baseUrl,
        apiKey: `$${model.apiKeyEnvVar}`,
        api: 'openai-completions',
        models: [
          {
            id: model.modelId,
            name: model.modelId,
            reasoning: false,
            input: ['text'],
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens
          }
        ]
      }
    }
  }
  const settings = { defaultProvider: model.providerId, defaultModel: model.modelId }
  const modelsPath = join(agentDir, 'models.json')
  const settingsPath = join(agentDir, 'settings.json')
  const modelsText = `${JSON.stringify(models, null, 2)}\n`
  const settingsText = `${JSON.stringify(settings, null, 2)}\n`
  await writeFile(modelsPath, modelsText, 'utf8')
  await writeFile(settingsPath, settingsText, 'utf8')
  if (modelsText.includes(model.apiKeyEnvVar) === false) throw new Error('profile_missing_env_reference')
  return {
    modelsPath,
    settingsPath,
    modelsSha256: sha256Hex(modelsText),
    settingsSha256: sha256Hex(settingsText),
    apiKeyIsEnvReference: true,
    authFileWritten: false
  }
}

/**
 * Isolation check for a per-run sandbox. Deliberately narrower than
 * managed-pi-rpc.mjs:204 `assertSandboxRoot`, which forces the workspace inside the sandbox root.
 */
export function assertRunIsolation({ tempRoot, agentDir, workspaceRoot, homeDir = homedir() }) {
  for (const [label, value] of [['tempRoot', tempRoot], ['agentDir', agentDir], ['workspaceRoot', workspaceRoot]]) {
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`isolation_${label}_must_be_absolute`)
  }
  const stats = {}
  for (const [label, value] of [['tempRoot', tempRoot], ['agentDir', agentDir], ['workspaceRoot', workspaceRoot]]) {
    let stat
    try {
      stat = lstatSync(value)
    } catch {
      throw new Error(`isolation_${label}_missing`)
    }
    if (stat.isSymbolicLink()) throw new Error(`isolation_${label}_symlink`)
    if (!stat.isDirectory()) throw new Error(`isolation_${label}_not_directory`)
    stats[label] = stat.isDirectory()
  }
  const tempRootReal = realpathOrNull(tempRoot)
  const agentDirReal = realpathOrNull(agentDir)
  const workspaceReal = realpathOrNull(workspaceRoot)
  if (!tempRootReal || !agentDirReal || !workspaceReal) throw new Error('isolation_realpath_failed')
  // agentDir must be a PROPER subdirectory of the temp root — never the root itself.
  if (agentDirReal === tempRootReal) throw new Error('isolation_agentDir_must_be_below_tempRoot')
  if (!insidePath(agentDirReal, tempRootReal)) throw new Error('isolation_agentDir_outside_tempRoot')
  if (insidePath(workspaceReal, tempRootReal) || insidePath(tempRootReal, workspaceReal)) {
    throw new Error('isolation_workspace_and_tempRoot_overlap')
  }
  const userPiDir = join(resolve(homeDir), '.pi')
  for (const [label, real] of [['tempRoot', tempRootReal], ['agentDir', agentDirReal], ['workspaceRoot', workspaceReal]]) {
    if (insidePath(real, userPiDir)) throw new Error(`isolation_${label}_forbidden_user_pi`)
  }
  // A grant that covers the home directory itself (or an ancestor of it) would make the sensitive-file
  // denylist the only barrier; a workspace merely *inside* home (e.g. a temp dir) stays allowed.
  const homeReal = realpathOrNull(resolve(homeDir)) ?? resolve(homeDir)
  if (insidePath(homeReal, workspaceReal)) throw new Error('isolation_workspace_covers_home')
  return Object.freeze({ tempRootReal, agentDirReal, workspaceReal })
}

// ---------------------------------------------------------------------------
// Pinned identity
// ---------------------------------------------------------------------------

function verifyPinnedIdentity(piBin, guardPath) {
  const bundleFile = join(piBin, '..', 'pi-bundle.json')
  let bundle
  try {
    bundle = JSON.parse(readFileSync(bundleFile, 'utf8'))
  } catch (error) {
    throw new Error(`pinned_bundle_unreadable:${error.message}`)
  }
  if (bundle.piVersion !== PI_BUNDLE_LOCKED_VERSION) throw new Error(`pinned_bundle_version_drift:${String(bundle.piVersion)}`)
  if (bundle.piVersion !== PINNED_PI.version) throw new Error(`pinned_bundle_version_drift_managed:${String(bundle.piVersion)}`)
  const entryFile = Array.isArray(bundle.files) ? bundle.files.find((file) => file.path === bundle.entry) : undefined
  if (!entryFile || typeof entryFile.sha256 !== 'string') throw new Error('pinned_bundle_entry_not_listed')
  const entryAbsolute = join(piBin, '..', ...String(bundle.entry).split('/'))
  let entryDigest
  try {
    entryDigest = createHash('sha256').update(readFileSync(entryAbsolute)).digest('hex')
  } catch (error) {
    throw new Error(`pinned_bundle_entry_unreadable:${error.message}`)
  }
  if (entryDigest !== entryFile.sha256) throw new Error('pinned_bundle_entry_digest_mismatch')
  const piExeDigest = createHash('sha256').update(readFileSync(piBin)).digest('hex')
  const guardDigest = createHash('sha256').update(readFileSync(guardPath)).digest('hex')
  return {
    piVersion: bundle.piVersion,
    launcher: bundle.launcher,
    platform: bundle.platform ?? null,
    piExeSha256: piExeDigest,
    bundleEntry: bundle.entry,
    bundleEntrySha256Verified: true,
    guardPath,
    guardSha256: guardDigest
  }
}

// ---------------------------------------------------------------------------
// RPC host (strict LF framing — Pi README.md:489 forbids readline framing)
// ---------------------------------------------------------------------------

export class AuthorizedRunHost {
  #child = null
  #pending = new Map()
  #nextId = 0
  #events = []
  #stderr = []
  #buffer = ''
  #stopped = false
  #modelToolcallIntentions = 0
  #droppedEventCount = 0
  #eventsOverflowed = false

  constructor({ piBin, args, cwd, env, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    if (typeof piBin !== 'string' || !Array.isArray(args) || typeof cwd !== 'string' || !isPlainObject(env)) {
      throw new Error('run_host_requires_piBin_args_cwd_env')
    }
    this.piBin = piBin
    this.args = args
    this.cwd = cwd
    this.env = env
    this.requestTimeoutMs = requestTimeoutMs
  }

  get events() { return this.#events }
  get stderr() { return this.#stderr }
  get pid() { return this.#child?.pid ?? null }
  get modelToolcallIntentions() { return this.#modelToolcallIntentions }
  get droppedEventCount() { return this.#droppedEventCount }
  get eventsOverflowed() { return this.#eventsOverflowed }

  stderrTail(lines = 12) {
    return this.#stderr.slice(-lines).join(' | ').slice(0, 4000)
  }

  start() {
    if (this.#child) throw new Error('run_host_already_started')
    const child = spawn(this.piBin, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    this.#child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onStdout(chunk))
    child.stderr.on('data', (chunk) => {
      this.#stderr.push(String(chunk))
      if (this.#stderr.length > MAX_CAPTURED_STDERR) this.#stderr.splice(0, this.#stderr.length - MAX_CAPTURED_STDERR)
    })
    child.once('error', (error) => this.#rejectAll(new Error(`pi_spawn_error:${error.message}`)))
    child.once('close', (code, signal) => {
      if (!this.#stopped) this.#rejectAll(new Error(`pi_exited_early:code=${code}:signal=${signal}`))
    })
    return this
  }

  #onStdout(chunk) {
    this.#buffer += chunk
    let index
    while ((index = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, '').trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line.length > 0) this.#onLine(line)
    }
  }

  #onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.#stderr.push(`[non-json-stdout] ${line.slice(0, 200)}`)
      return
    }
    if (!isPlainObject(message)) return
    if (message.type === 'response') {
      const pending = this.#pending.get(String(message.id))
      if (!pending) return
      clearTimeout(pending.timer)
      this.#pending.delete(String(message.id))
      if (message.success === false) pending.reject(new Error(`pi_rpc_failed:${String(pending.command)}:${String(message.error ?? 'unknown')}`))
      else pending.resolve(message.data ?? {})
      return
    }
    // Only structured tool/terminal events are retained; stream deltas are counted, never buffered.
    const classification = classifyRpcEvent(message)
    if (classification.intentionDelta !== 0) this.#modelToolcallIntentions += classification.intentionDelta
    if (!classification.retain) {
      this.#droppedEventCount += 1
      return
    }
    this.#events.push(message)
    if (this.#events.length > MAX_CAPTURED_EVENTS) {
      // Never evict silently: an eviction means the evidence is incomplete, which the runner reports
      // as unknown_outcome rather than a false success.
      this.#events.shift()
      this.#eventsOverflowed = true
    }
  }

  #rejectAll(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  request(command, { timeoutMs = this.requestTimeoutMs } = {}) {
    const child = this.#child
    if (!child || child.exitCode !== null) return Promise.reject(new Error('pi_host_not_running'))
    const id = String(++this.#nextId)
    const commandType = String(command?.type ?? 'unknown')
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        rejectRequest(new Error(`pi_rpc_timeout:${commandType}`))
      }, timeoutMs)
      this.#pending.set(id, { command: commandType, resolve: resolveRequest, reject: rejectRequest, timer })
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return
        clearTimeout(timer)
        this.#pending.delete(id)
        rejectRequest(new Error(`pi_stdin_write_failed:${error.message}`))
      })
    })
  }

  waitForEvent(type, { timeoutMs = DEFAULT_PROMPT_TIMEOUT_MS, sinceIndex = 0, predicate = null } = {}) {
    const deadline = Date.now() + timeoutMs
    return new Promise((resolveWait, rejectWait) => {
      const poll = () => {
        for (let index = Math.max(sinceIndex, 0); index < this.#events.length; index += 1) {
          const event = this.#events[index]
          if (event?.type === type && (!predicate || predicate(event))) {
            resolveWait({ event, index })
            return
          }
        }
        if (Date.now() > deadline) {
          rejectWait(new Error(`pi_event_timeout:${type}:${timeoutMs}ms`))
          return
        }
        setTimeout(poll, 25)
      }
      poll()
    })
  }

  async stop({ graceMs = DEFAULT_STOP_GRACE_MS, killMs = DEFAULT_STOP_KILL_MS } = {}) {
    const child = this.#child
    if (!child || this.#stopped) return { exited: true, forced: false }
    this.#stopped = true
    const closed = new Promise((resolveClose) => child.once('close', () => resolveClose(true)))
    try { child.stdin.end() } catch {}
    let exited = await Promise.race([closed, new Promise((done) => setTimeout(() => done(false), graceMs))])
    if (!exited) {
      this.#killOwnTree(killMs)
      exited = await Promise.race([closed, new Promise((done) => setTimeout(() => done(false), killMs))])
    }
    if (!exited) throw new Error(`pi_host_refused_to_exit:pid=${child.pid}`)
    return { exited: true, forced: child.exitCode === null && child.signalCode !== null }
  }

  /** Kill only this run's own process tree. Never signals any other pid. */
  #killOwnTree(killMs) {
    const child = this.#child
    const pid = child?.pid
    if (!pid) return
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: killMs })
      } catch {}
      return
    }
    try {
      process.kill(-pid, 'SIGKILL')
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
}

// ---------------------------------------------------------------------------
// Evidence extraction
// ---------------------------------------------------------------------------

/**
 * Real tool executions only: a `tool_execution_start` is a claim, `tool_execution_end` closes it, and
 * a `toolResult` message must be linked by toolCallId. Model `toolcall_start` intentions are ignored.
 */
export function extractToolExecutions(events, { intentionCount = null } = {}) {
  const starts = new Map()
  const ends = new Map()
  const toolResults = new Map()
  let intentions = 0
  for (const event of events) {
    if (!isPlainObject(event)) continue
    if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string') {
      starts.set(event.toolCallId, event)
      continue
    }
    if (event.type === 'tool_execution_end' && typeof event.toolCallId === 'string') {
      ends.set(event.toolCallId, event)
      continue
    }
    if (event.type === 'message_end' && event.message?.role === 'toolResult' && typeof event.message.toolCallId === 'string') {
      toolResults.set(event.message.toolCallId, event.message)
      continue
    }
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'toolcall_start') intentions += 1
  }
  const executions = []
  for (const [toolCallId, start] of starts) {
    const end = ends.get(toolCallId) ?? null
    const resultMessage = toolResults.get(toolCallId) ?? null
    executions.push({
      toolCallId,
      toolName: typeof start.toolName === 'string' ? start.toolName : null,
      started: true,
      finished: end !== null,
      isError: end ? end.isError === true : null,
      argsSha256: digestOf(start.args ?? null),
      argsBytes: Buffer.byteLength(stableJson(start.args ?? null), 'utf8'),
      resultSha256: end ? digestOf(end.result ?? null) : null,
      resultBytes: end ? Buffer.byteLength(stableJson(end.result ?? null), 'utf8') : null,
      toolResultLinked: resultMessage !== null,
      toolResultIsError: resultMessage ? resultMessage.isError === true : null,
      guardBlockedMarkerInEnd: !!end && stableJson(end.result ?? null).includes('LOOM guard blocked'),
      guardBlockedMarkerInResult: !!resultMessage && stableJson(resultMessage.content ?? null).includes('LOOM guard blocked')
    })
  }
  return {
    executions,
    executedCount: executions.filter((execution) => execution.finished).length,
    unfinishedCount: executions.filter((execution) => !execution.finished).length,
    toolResultCount: toolResults.size,
    modelToolcallIntentions: intentionCount === null ? intentions : intentionCount
  }
}

/**
 * Pi emits tool_execution_start/end even when its pre-tool extension denies a call.
 * Treat an explicit guard refusal as a denied *attempt*, never as completed filesystem I/O,
 * but ONLY if the native tool result independently confirms that guard refusal.
 * Otherwise fail closed: a blocked tool may have executed despite policy.
 */
export function reconcileGuardedExecutions(rawEvidence, guardLog) {
  const blockedIds = new Set(guardLog.decisions
    .filter((decision) => decision.decision === 'block' && typeof decision.toolCallId === 'string')
    .map((decision) => decision.toolCallId))
  const allowedIds = new Set(guardLog.decisions
    .filter((decision) => decision.decision === 'allow' && typeof decision.toolCallId === 'string')
    .map((decision) => decision.toolCallId))
  const executions = []
  const deniedAttempts = []
  for (const execution of rawEvidence.executions) {
    if (!blockedIds.has(execution.toolCallId)) {
      executions.push(execution)
      continue
    }
    if (allowedIds.has(execution.toolCallId)) throw new Error('contradictory_guard_decisions')
    if (!execution.finished || execution.isError !== true || execution.toolResultIsError !== true ||
      !execution.toolResultLinked || !execution.guardBlockedMarkerInEnd || !execution.guardBlockedMarkerInResult) {
      throw new Error(`execution_despite_guard_block:${execution.toolName ?? 'unknown'}`)
    }
    deniedAttempts.push({
      toolCallId: execution.toolCallId,
      toolName: execution.toolName,
      guardDenied: true
    })
  }
  return {
    ...rawEvidence,
    executions,
    deniedAttempts,
    executedCount: executions.filter((execution) => execution.finished).length,
    unfinishedCount: executions.filter((execution) => !execution.finished).length
  }
}

/** Last assistant message facts, without content text (no prompt/tool payload leaves here). */
/**
 * The single terminal-status decision, kept pure so every ordering can be tested without a process.
 *
 * Ordering is the whole point:
 *  - nothing sent and the user cancelled       -> cancelled (nothing ran)
 *  - attempted, receipt lost                   -> unknown_outcome (may have been delivered)
 *  - attempted, delivery proven failed         -> failed (still non-replayable: an attempt happened)
 *  - evidence budget exceeded                  -> unknown_outcome (tool evidence incomplete)
 *  - accepted but unsettled / settle timed out -> unknown_outcome
 *  - cancelled before a genuine settle         -> cancelled
 *  - provider error after a genuine settle     -> failed
 *  - otherwise                                 -> settled
 */
export function resolveRunStatus({
  cancelledBeforeSend = false,
  cancelledBeforeSettle = false,
  promptAttempted = false,
  promptAccepted = false,
  promptDeliveryKnown = false,
  settledObserved = false,
  settleWaitTimedOut = false,
  providerError = false,
  evidenceBudgetExceeded = false
} = {}) {
  if (!promptAttempted) return cancelledBeforeSend ? 'cancelled' : 'failed'
  if (!promptAccepted) return promptDeliveryKnown ? 'failed' : 'unknown_outcome'
  if (evidenceBudgetExceeded) return 'unknown_outcome'
  if (settleWaitTimedOut || !settledObserved) return 'unknown_outcome'
  if (cancelledBeforeSettle) return 'cancelled'
  if (providerError) return 'failed'
  return 'settled'
}

/** Replay is only ever safe when nothing was even attempted. */
export function isRunReplayable({ status, promptAttempted }) {
  return status === 'failed' && promptAttempted === false
}

// ---------------------------------------------------------------------------
// RPC event retention
//
// Streaming deltas (`message_update`, `entry_appended`, ...) are the bulk of the RPC stream and carry no
// security evidence. Keeping them would push the bounded buffer over its cap and, after an eviction,
// shift `sinceIndex` so a real `tool_execution_start` could be silently lost. Only structured tool and
// terminal events are retained; the intention counter is kept as a number instead of as events.
// ---------------------------------------------------------------------------

export const RETAINED_RPC_EVENT_TYPES = Object.freeze([
  'tool_execution_start',
  'tool_execution_end',
  'message_end',
  'agent_end',
  'agent_settled',
  'extension_ui_request',
  'extension_error',
  'session'
])

/**
 * Decide whether an inbound RPC line is kept. Pure, so the retention policy itself is testable.
 *
 * @returns {{retain: boolean, intentionDelta: number}}
 */
export function classifyRpcEvent(message) {
  if (!isPlainObject(message)) return { retain: false, intentionDelta: 0 }
  const type = message.type
  if (type === 'response') return { retain: false, intentionDelta: 0 }
  if (type === 'message_update') {
    return {
      retain: false,
      intentionDelta: message.assistantMessageEvent?.type === 'toolcall_start' ? 1 : 0
    }
  }
  if (RETAINED_RPC_EVENT_TYPES.includes(type)) return { retain: true, intentionDelta: 0 }
  return { retain: false, intentionDelta: 0 }
}

export function extractAssistantOutcome(events) {
  let lastAssistant = null
  for (const event of events) {
    if (!isPlainObject(event)) continue
    if (event.type === 'message_end' && event.message?.role === 'assistant') lastAssistant = event.message
  }
  if (!lastAssistant) {
    return { assistantMessageObserved: false, stopReason: null, providerError: false, errorMessageSha256: null, usage: null }
  }
  const stopReason = typeof lastAssistant.stopReason === 'string' ? lastAssistant.stopReason : null
  const errorMessage = typeof lastAssistant.errorMessage === 'string' ? lastAssistant.errorMessage : null
  const usage = isPlainObject(lastAssistant.usage)
    ? {
        input: Number(lastAssistant.usage.input ?? 0),
        output: Number(lastAssistant.usage.output ?? 0),
        total: Number(lastAssistant.usage.total ?? 0)
      }
    : null
  return {
    assistantMessageObserved: true,
    stopReason,
    providerError: stopReason === 'error' || errorMessage !== null,
    errorMessageSha256: errorMessage === null ? null : digestOf(errorMessage),
    usage
  }
}

// ---------------------------------------------------------------------------
// Guard log
// ---------------------------------------------------------------------------

export function readGuardLog(logPath) {
  let text = ''
  try {
    text = readFileSync(logPath, 'utf8')
  } catch {
    return { present: false, ready: null, selfTest: null, decisions: [], badLines: 0 }
  }
  let ready = null
  let selfTest = null
  const decisions = []
  let badLines = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      badLines += 1
      continue
    }
    if (record?.t === 'guard_ready') ready = record
    else if (record?.t === 'guard_selftest') selfTest = record
    else if (record?.t === 'decision') decisions.push(record)
  }
  return { present: true, ready, selfTest, decisions, badLines }
}

/**
 * Cross-check guard decisions against real executions. Any inconsistency is a hard failure.
 */
export function summarizeGuard(guardLog, toolEvidence, { allowedTools, workspaceReal, runId, botId }) {
  if (!guardLog.present || !guardLog.ready) throw new Error('guard_not_loaded')
  if (guardLog.badLines > 0) throw new Error(`guard_log_unparsable_lines:${guardLog.badLines}`)
  if (!guardLog.selfTest) throw new Error('guard_selftest_missing')
  if (guardLog.selfTest.failures !== 0) throw new Error(`guard_selftest_failed:${guardLog.selfTest.failures}`)
  if (guardLog.ready.selfTestFailures !== 0) throw new Error('guard_ready_reports_selftest_failures')
  if (guardLog.ready.schema !== RUNTIME_GUARD_SCHEMA) throw new Error('guard_schema_mismatch')
  if (guardLog.ready.workspaceReal !== workspaceReal) throw new Error('guard_workspace_mismatch')
  if (runId !== undefined && guardLog.ready.runId !== runId) throw new Error('guard_run_id_mismatch')
  if (botId !== undefined && guardLog.ready.botId !== botId) throw new Error('guard_bot_id_mismatch')
  const readyTools = Array.isArray(guardLog.ready.allowedTools) ? guardLog.ready.allowedTools : []
  if (readyTools.length !== allowedTools.length || allowedTools.some((tool) => !readyTools.includes(tool))) {
    throw new Error('guard_tools_mismatch')
  }

  const decisions = guardLog.decisions.map((decision) => ({
    toolCallId: typeof decision.toolCallId === 'string' ? decision.toolCallId : null,
    toolName: typeof decision.toolName === 'string' ? decision.toolName : null,
    decision: decision.decision === 'allow' ? 'allow' : 'block',
    reasonCode: typeof decision.reasonCode === 'string' ? decision.reasonCode : 'unknown',
    relPath: typeof decision.relPath === 'string' ? decision.relPath : null,
    pathSha256: typeof decision.pathSha256 === 'string' ? decision.pathSha256 : null
  }))

  const allowByCallId = new Set(decisions.filter((entry) => entry.decision === 'allow' && entry.toolCallId).map((entry) => entry.toolCallId))
  const blockByCallId = new Set(decisions.filter((entry) => entry.decision === 'block' && entry.toolCallId).map((entry) => entry.toolCallId))

  for (const execution of toolEvidence.executions) {
    if (blockByCallId.has(execution.toolCallId)) throw new Error(`execution_despite_guard_block:${execution.toolName ?? 'unknown'}`)
    if (!allowByCallId.has(execution.toolCallId)) throw new Error(`execution_without_guard_allow:${execution.toolName ?? 'unknown'}`)
  }
  for (const toolCallId of allowByCallId) {
    if (!toolEvidence.executions.some((execution) => execution.toolCallId === toolCallId)) {
      throw new Error('guard_allow_without_execution')
    }
  }

  return {
    loaded: true,
    schema: guardLog.ready.schema,
    runId: guardLog.ready.runId ?? null,
    botId: guardLog.ready.botId ?? null,
    selfTestCases: Number(guardLog.selfTest.cases ?? 0),
    selfTestFailures: 0,
    decisions,
    allowedCount: decisions.filter((entry) => entry.decision === 'allow').length,
    blockedCount: decisions.filter((entry) => entry.decision === 'block').length,
    executedCount: toolEvidence.executedCount,
    unguardedExecutions: 0
  }
}

// ---------------------------------------------------------------------------
// Pre-prompt guard gate
//
// The guard loads inside Pi. If it failed to load, was misconfigured, or is bound to a different run,
// Pi would happily keep going with no path policy — so this gate runs BEFORE any model prompt is
// sent. A failure here stops the run without a prompt request.
// ---------------------------------------------------------------------------

export async function waitForFreshGuardReady({ guardLogPath, timeoutMs = 10_000, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const log = readGuardLog(guardLogPath)
    if (log.present && log.ready) return log
    if (Date.now() > deadline) throw new Error('guard_ready_missing_before_prompt')
    await new Promise((done) => setTimeout(done, pollMs))
  }
}

/**
 * Assert this run's guard is fresh, self-tested and bound to exactly this run before prompting.
 *
 * @param {object} guardLog result of waitForFreshGuardReady
 * @param {{runId: string, botId: string, workspaceReal: string, allowedTools: string[], spawnedPid: number}} expected
 */
export function assertPrePromptGuard(guardLog, { runId, botId, workspaceReal, allowedTools, spawnedPid }) {
  if (!guardLog?.ready) throw new Error('guard_ready_missing_before_prompt')
  if (!guardLog.selfTest) throw new Error('guard_selftest_missing_before_prompt')
  if (guardLog.selfTest.failures !== 0) {
    // Name the failing cases: a self-test failure must be actionable, never a bare counter.
    const detail = Array.isArray(guardLog.selfTest.failureDetail)
      ? guardLog.selfTest.failureDetail
          .slice(0, 4)
          .map((entry) => `${String(entry?.path)}->${String(entry?.actual)}/${String(entry?.reasonCode)}`)
          .join(',')
      : 'detail_unavailable'
    throw new Error(`guard_selftest_failed_before_prompt:${guardLog.selfTest.failures}:${detail}`)
  }
  if (guardLog.ready.selfTestFailures !== 0) throw new Error('guard_ready_selftest_failures_before_prompt')
  if (guardLog.ready.schema !== RUNTIME_GUARD_SCHEMA) throw new Error('guard_schema_mismatch_before_prompt')
  if (guardLog.ready.runId !== runId) throw new Error('guard_run_id_mismatch_before_prompt')
  if (guardLog.ready.botId !== botId) throw new Error('guard_bot_id_mismatch_before_prompt')
  if (guardLog.ready.workspaceReal !== workspaceReal) throw new Error('guard_workspace_mismatch_before_prompt')
  const readyTools = Array.isArray(guardLog.ready.allowedTools) ? guardLog.ready.allowedTools : []
  if (readyTools.length !== allowedTools.length || allowedTools.some((tool) => !readyTools.includes(tool))) {
    throw new Error('guard_tools_mismatch_before_prompt')
  }
  // The guard must live in THIS run's process tree: either the spawned process itself, or its direct
  // child when the native launcher re-execs the bundled node.
  const pidMatches = guardLog.ready.pid === spawnedPid
  const ppidMatches = guardLog.ready.ppid === spawnedPid
  if (!pidMatches && !ppidMatches) {
    throw new Error(`guard_pid_mismatch_before_prompt:guard=${String(guardLog.ready.pid)}/${String(guardLog.ready.ppid)}:spawned=${String(spawnedPid)}`)
  }
  return {
    prePromptVerified: true,
    guardPid: guardLog.ready.pid,
    guardPpid: guardLog.ready.ppid ?? null,
    pidMatches,
    ppidMatches,
    selfTestCases: Number(guardLog.selfTest.cases ?? 0),
    selfTestFailures: 0,
    readyAt: Number(guardLog.ready.at ?? 0)
  }
}

// ---------------------------------------------------------------------------
// Host-side artifacts (explicit list only; never walks the workspace)
// ---------------------------------------------------------------------------

export function hashExpectedArtifacts({ workspaceRoot, expectedArtifactPaths = [] }) {
  if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot)) throw new Error('artifacts_workspaceRoot_must_be_absolute')
  if (!Array.isArray(expectedArtifactPaths)) throw new Error('artifacts_list_must_be_array')
  const workspaceReal = realpathOrNull(workspaceRoot)
  if (workspaceReal === null) throw new Error('artifacts_workspaceRoot_unresolvable')
  const artifacts = []
  const seen = new Set()
  for (const relativePath of expectedArtifactPaths) {
    if (typeof relativePath !== 'string' || relativePath.length === 0) throw new Error('artifact_path_invalid')
    if (relativePath.includes('\0')) throw new Error('artifact_path_nul_byte')
    if (isAbsolute(relativePath)) throw new Error('artifact_path_must_be_relative')
    if (relativePath.split(/[\\/]+/).some((segment) => segment === '..')) throw new Error('artifact_path_parent_escape')
    if (seen.has(relativePath)) throw new Error('artifact_path_duplicate')
    seen.add(relativePath)
    const segments = relativePath.split(/[\\/]+/).filter(Boolean).map((segment) => segment.toLowerCase())
    if (segments.some((segment) => SENSITIVE_SEGMENTS.includes(segment) || segment.startsWith('.env'))) {
      throw new Error('artifact_path_sensitive')
    }
    if (segments.some((segment) => SENSITIVE_SUFFIXES.some((suffix) => segment.endsWith(suffix)))) {
      throw new Error('artifact_path_sensitive_suffix')
    }
    const absolute = resolve(workspaceReal, relativePath)
    if (!insidePath(absolute, workspaceReal)) throw new Error('artifact_path_outside_workspace')
    let stat
    try {
      stat = lstatSync(absolute)
    } catch {
      throw new Error('artifact_path_missing')
    }
    if (stat.isSymbolicLink()) throw new Error('artifact_path_symlink')
    if (!stat.isFile()) throw new Error('artifact_path_not_regular_file')
    // A hardlink shares its inode with a file outside the workspace: realpath/lstat cannot tell them
    // apart, so a multiply-linked file is never accepted as an artifact.
    if (stat.nlink > 1) throw new Error('artifact_path_hardlink')
    const real = realpathOrNull(absolute)
    if (real === null) throw new Error('artifact_path_realpath_failed')
    if (!insidePath(real, workspaceReal)) throw new Error('artifact_path_realpath_outside_workspace')
    const bytes = readFileSync(real)
    artifacts.push({
      relativePath: relativePath.split(sep).join('/'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length
    })
  }
  return artifacts
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run one authorized Pi execution.
 *
 * @param {object} options
 * @param {object} options.grant explicit per-run grant {runId, botId, workspaceRoot, allowedTools, expiresAt}
 * @param {object} options.model explicit authorized model config (see assertAuthorizedModelConfig)
 * @param {string} options.prompt the user prompt for THIS run
 * @param {string[]} [options.expectedArtifactPaths] workspace-relative files to hash as artifacts
 * @param {AbortSignal} [options.cancelSignal] cooperative cancel for this run
 */
export async function runAuthorizedExecution({
  grant,
  model,
  prompt,
  expectedArtifactPaths = [],
  cancelSignal = null,
  piBin = defaultPiBin(),
  guardPath = defaultGuardPath(),
  promptTimeoutMs = DEFAULT_PROMPT_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  settleAfterAbortMs = DEFAULT_SETTLE_AFTER_ABORT_MS,
  guardReadyTimeoutMs = DEFAULT_GUARD_READY_TIMEOUT_MS,
  keepTempRoot = false
} = {}) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) throw new Error('prompt_must_be_non_empty_string')

  // 1. Authorization first: nothing is spawned before the grant and the model config validate.
  const normalizedGrant = assertPerRunGrant(grant)
  const normalizedModel = assertAuthorizedModelConfig(model)
  const apiKeyValue = resolveApiKeyValue(normalizedModel)
  if (Date.now() > normalizedGrant.expiresAtEpochMs) throw new Error('grant_expired')

  // 2. Pinned identity (same bundle for every run) + guard digest.
  const identity = verifyPinnedIdentity(piBin, guardPath)
  if (identity.piVersion !== PI_BUNDLE_LOCKED_VERSION) throw new Error('pinned_bundle_version_drift')
  const pinned = await assertPinnedPiBundle(piBin)
  if (pinned.piVersion !== PI_BUNDLE_LOCKED_VERSION) throw new Error('pinned_bundle_version_drift')
  if (pinned.launcher !== 'pi.exe') throw new Error('pinned_bundle_launcher_drift')

  // 3. Isolated profile + guard log inside a private temp root.
  const tempRoot = await mkdtemp(join(tmpdir(), 'loom-v2-run-'))
  let host = null
  let evidence = null
  let mainError = null
  const startedAt = Date.now()

  try {
    const agentDir = join(tempRoot, 'agent')
    await mkdir(agentDir, { recursive: true })
    const guardLogPath = join(tempRoot, 'guard.jsonl')
    const isolation = assertRunIsolation({ tempRoot, agentDir, workspaceRoot: normalizedGrant.workspaceRoot })

    const profile = await writeAuthorizedProfile({ agentDir, model: normalizedModel })
    const guardConfig = Object.freeze({
      schema: RUNTIME_GUARD_SCHEMA,
      runId: normalizedGrant.runId,
      botId: normalizedGrant.botId,
      workspaceReal: isolation.workspaceReal,
      allowedTools: normalizedGrant.allowedTools,
      expiresAtEpochMs: normalizedGrant.expiresAtEpochMs,
      logPath: guardLogPath
    })
    const env = buildAuthorizedEnv({ agentDir, model: normalizedModel, apiKeyValue, guardConfig })
    const args = buildAuthorizedPiArgv({ guardPath, tools: normalizedGrant.allowedTools })

    host = new AuthorizedRunHost({
      piBin,
      args,
      cwd: isolation.workspaceReal,
      env,
      requestTimeoutMs
    })
    host.start()

    const state = await host.request({ type: 'get_state' })
    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : null

    // Pre-prompt gate: prove THIS run is guarded before a single model request is made. If the guard
    // extension failed to load (syntax error, misconfiguration, wrong run, wrong tools, wrong pid) the
    // run stops here and no prompt is ever sent.
    const guardPrePromptLog = await waitForFreshGuardReady({ guardLogPath, timeoutMs: guardReadyTimeoutMs })
    const guardPrePrompt = assertPrePromptGuard(guardPrePromptLog, {
      runId: normalizedGrant.runId,
      botId: normalizedGrant.botId,
      workspaceReal: isolation.workspaceReal,
      allowedTools: normalizedGrant.allowedTools,
      spawnedPid: host.pid
    })

    const eventIndexBeforePrompt = host.events.length
    const intentionsBeforePrompt = host.modelToolcallIntentions
    const promptStartedAt = Date.now()

    let promptAttempted = false
    let promptAccepted = false
    let promptDeliveryKnown = false
    let promptError = null
    let settledObserved = false
    let settleWaitTimedOut = false
    let abortRequested = false
    // Cancel bookkeeping preserves the real event order: a cancel arriving AFTER a genuine settle must
    // never downgrade a successful run, and a cancel while the prompt receipt is still in flight must
    // never be reported as a clean cancel.
    let cancelObservedAt = null
    let settleResolvedAt = null
    const observeCancel = () => {
      if (cancelObservedAt === null) cancelObservedAt = Date.now()
    }
    const cancelBeforeSend = cancelSignal?.aborted === true
    if (cancelBeforeSend) observeCancel()
    const cancelPromise = cancelSignal
      ? new Promise((resolveCancel) => {
          if (cancelSignal.aborted) {
            resolveCancel('cancelled')
            return
          }
          cancelSignal.addEventListener('abort', () => {
            observeCancel()
            resolveCancel('cancelled')
          }, { once: true })
        })
      : null
    const markSettled = () => {
      if (settleResolvedAt === null) settleResolvedAt = Date.now()
      return true
    }
    const waitSettle = (timeoutMs) => host
      .waitForEvent('agent_settled', { timeoutMs, sinceIndex: eventIndexBeforePrompt })
      .then(markSettled)
      .catch(() => false)
    const abortOnce = async () => {
      if (abortRequested) return
      abortRequested = true
      try {
        await host.request({ type: 'abort' }, { timeoutMs: requestTimeoutMs })
      } catch {}
    }

    if (!cancelBeforeSend) {
      promptAttempted = true
      try {
        await host.request({ type: 'prompt', message: prompt }, { timeoutMs: requestTimeoutMs })
        promptAccepted = true
        promptDeliveryKnown = true
      } catch (error) {
        promptError = error
        // A stdin write error does NOT prove zero side effects, so an attempted send is never
        // replayable. Only a lost receipt (rather than a proven write failure) is reported unknown.
        promptDeliveryKnown = String(error?.message ?? '').startsWith('pi_stdin_write_failed')
        await abortOnce()
        settledObserved = await waitSettle(settleAfterAbortMs)
      }
    }

    if (promptAccepted) {
      const settlePromise = host
        .waitForEvent('agent_settled', { timeoutMs: promptTimeoutMs, sinceIndex: eventIndexBeforePrompt })
        .then(() => ({ settled: markSettled() }))
        .catch(() => ({ settled: false }))

      const first = cancelPromise
        ? await Promise.race([settlePromise, cancelPromise])
        : await settlePromise

      if (first === 'cancelled') {
        await abortOnce()
        settledObserved = await waitSettle(settleAfterAbortMs)
        settleWaitTimedOut = !settledObserved
      } else if (first.settled === true) {
        settledObserved = true
      } else {
        // Timeout: abort, then wait a bounded time for a real settle before declaring the side effects
        // unknown. A timeout is never retried and never replayed.
        settleWaitTimedOut = true
        await abortOnce()
        settledObserved = await waitSettle(settleAfterAbortMs)
      }
    }

    const promptFinishedAt = Date.now()
    const events = host.events.slice(eventIndexBeforePrompt)
    const rawToolEvidence = extractToolExecutions(events, {
      intentionCount: host.modelToolcallIntentions - intentionsBeforePrompt
    })
    const assistant = extractAssistantOutcome(events)
    const guardLog = readGuardLog(guardLogPath)
    const toolEvidence = reconcileGuardedExecutions(rawToolEvidence, guardLog)
    const guard = summarizeGuard(guardLog, toolEvidence, {
      allowedTools: normalizedGrant.allowedTools,
      workspaceReal: isolation.workspaceReal,
      runId: normalizedGrant.runId,
      botId: normalizedGrant.botId
    })
    const artifacts = hashExpectedArtifacts({
      workspaceRoot: isolation.workspaceReal,
      expectedArtifactPaths
    })

    // Event budget: if the retained structured stream overflowed, the tool/terminal evidence is
    // incomplete, so the run is reported unknown instead of a false success.
    const budgetExceeded = host.eventsOverflowed === true
    const cancelBeforeSettle = cancelObservedAt !== null
      && (settleResolvedAt === null || cancelObservedAt <= settleResolvedAt)
    const status = resolveRunStatus({
      cancelledBeforeSend: cancelBeforeSend,
      cancelledBeforeSettle: cancelBeforeSettle,
      promptAttempted,
      promptAccepted,
      promptDeliveryKnown,
      settledObserved,
      settleWaitTimedOut,
      providerError: assistant.providerError,
      evidenceBudgetExceeded: budgetExceeded
    })
    if (!RUN_STATUSES.includes(status)) throw new Error(`status_not_permitted:${status}`)

    evidence = finalizeEvidence({
      status,
      promptAttempted,
      promptAccepted,
      promptDeliveryKnown,
      promptError,
      cancelBeforeSend,
      cancelBeforeSettle,
      cancelObservedAt,
      settleResolvedAt,
      budgetExceeded,
      settledObserved,
      settleWaitTimedOut,
      abortRequested,
      normalizedGrant,
      normalizedModel,
      identity,
      profile,
      isolation,
      sessionId,
      prompt,
      promptStartedAt,
      promptFinishedAt,
      startedAt,
      toolEvidence,
      assistant,
      guard,
      guardPrePrompt,
      artifacts,
      args,
      host
    })
  } catch (error) {
    if (mainError === null) mainError = error
  } finally {
    const cleanupErrors = []
    if (host) {
      try {
        await host.stop()
      } catch (error) {
        cleanupErrors.push(error)
      }
      host = null
    }
    if (!keepTempRoot) {
      try {
        await rm(tempRoot, { recursive: true, force: true })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (cleanupErrors.length > 0) {
      const errors = mainError ? [mainError, ...cleanupErrors] : cleanupErrors
      throw new AggregateError(errors, 'authorized run teardown failed; refusing to report a green run')
    }
  }
  if (mainError) throw mainError
  return evidence
}

function finalizeEvidence({
  status,
  promptAttempted = false,
  promptAccepted,
  promptDeliveryKnown,
  promptError = null,
  cancelBeforeSend = false,
  cancelBeforeSettle = false,
  cancelObservedAt = null,
  settleResolvedAt = null,
  budgetExceeded = false,
  settledObserved,
  settleWaitTimedOut,
  abortRequested,
  normalizedGrant,
  normalizedModel,
  identity,
  profile,
  isolation,
  sessionId,
  prompt,
  promptStartedAt,
  promptFinishedAt,
  startedAt,
  toolEvidence,
  assistant,
  guard,
  guardPrePrompt,
  artifacts,
  args,
  host
}) {
  const evidence = {
    schema: RUNTIME_EXECUTION_SCHEMA,
    runId: normalizedGrant.runId,
    botId: normalizedGrant.botId,
    status,
    replayable: isRunReplayable({ status, promptAttempted }),
    promptAttempted,
    promptAccepted,
    promptDeliveryKnown,
    promptErrorCode: promptError === null ? null : String(promptError?.message ?? promptError).split(':')[0].slice(0, 64),
    promptErrorSha256: promptError === null ? null : digestOf(String(promptError?.message ?? promptError)),
    settledObserved,
    settleWaitTimedOut,
    abortRequested,
    cancel: {
      observed: cancelObservedAt !== null,
      observedAt: cancelObservedAt,
      beforeSend: cancelBeforeSend,
      beforeSettle: cancelBeforeSettle,
      settleResolvedAt
    },
    budgetExceeded,
    promptSha256: digestOf(prompt),
    promptBytes: Buffer.byteLength(prompt, 'utf8'),
    // Backend honesty: the connection kind and the declared model only.
    providerConnection: normalizedModel.providerConnection,
    mockProvider: normalizedModel.mockProvider,
    declaredProviderId: normalizedModel.providerId,
    declaredModelId: normalizedModel.modelId,
    providerHost: normalizedModel.baseUrlHost,
    providerPort: normalizedModel.baseUrlPort,
    actualBackendVerified: false,
    realCommercialModelClaimed: false,
    userCredentialsUsed: normalizedModel.providerConnection === 'external',
    credentialSource: 'env_reference',
    credentialEnvVarName: normalizedModel.apiKeyEnvVar,
    credentialValueRecorded: false,
    osSandbox: false,
    coreIntegrated: false,
    ownerReviewRecorded: false,
    piBundle: identity,
    profile: {
      modelsSha256: profile.modelsSha256,
      settingsSha256: profile.settingsSha256,
      apiKeyIsEnvReference: profile.apiKeyIsEnvReference,
      authFileWritten: profile.authFileWritten
    },
    isolation: {
      tempRootReal: isolation.tempRootReal,
      agentDirReal: isolation.agentDirReal,
      workspaceReal: isolation.workspaceReal,
      workspaceOutsideTempRoot: true,
      userPiDirTouched: false
    },
    launch: {
      args,
      sessionId,
      requestTimeoutMs: host?.requestTimeoutMs ?? null,
      strictLfFraming: true
    },
    guard,
    pathGuard: {
      model: 'tool_call_policy',
      osSandbox: false,
      toctouConcurrentMutationGuarantee: false,
      workspaceOwnership: normalizedGrant.workspaceOwnership,
      prePromptVerified: guardPrePrompt?.prePromptVerified === true,
      guardPid: guardPrePrompt?.guardPid ?? null,
      guardPpid: guardPrePrompt?.guardPpid ?? null,
      guardPidMatchesSpawned: guardPrePrompt ? (guardPrePrompt.pidMatches || guardPrePrompt.ppidMatches) : false
    },
    tools: {
      allowlist: [...normalizedGrant.allowedTools],
      executedCount: toolEvidence.executedCount,
      unfinishedCount: toolEvidence.unfinishedCount,
      toolResultCount: toolEvidence.toolResultCount,
      modelToolcallIntentions: toolEvidence.modelToolcallIntentions,
      deniedAttempts: toolEvidence.deniedAttempts ?? [],
      executions: toolEvidence.executions
    },
    assistant,
    artifacts,
    timings: {
      startedAt,
      promptStartedAt,
      promptFinishedAt,
      totalMs: Math.max(0, promptFinishedAt - startedAt)
    },
    stderrTail: typeof host?.stderrTail === 'function' ? sanitizeDiagnosticText(host.stderrTail(6)) : ''
  }
  // Ceiling checks on the finished object: no prompt text, no key-shaped token, no URL query.
  const text = JSON.stringify(evidence)
  // A very short prompt can collide with unrelated substrings; the digest above is the real check.
  if (prompt.length >= 12 && text.includes(prompt)) throw new Error('evidence_leaked_prompt_text')
  assertNoSecrets(evidence, { label: 'authorized run evidence' })
  return evidence
}

// ---------------------------------------------------------------------------
// Direct CLI entry: node scripts/loom-v2-runtime-execution.mjs --workspace <dir> ...
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  const options = { artifact: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[++index]
      if (value === undefined) throw new Error(`missing_value_for:${arg}`)
      return value
    }
    switch (arg) {
      case '--run-id': options.runId = next(); break
      case '--bot-id': options.botId = next(); break
      case '--workspace': options.workspace = next(); break
      case '--tools': options.tools = next().split(',').map((tool) => tool.trim()).filter(Boolean); break
      case '--isolated-self-owned-workspace': options.isolatedSelfOwnedWorkspace = true; break
      case '--expires-at': options.expiresAt = next(); break
      case '--provider-id': options.providerId = next(); break
      case '--base-url': options.baseUrl = next(); break
      case '--model-id': options.modelId = next(); break
      case '--api-key-env-var': options.apiKeyEnvVar = next(); break
      case '--prompt': options.prompt = next(); break
      case '--artifact': options.artifact.push(next()); break
      case '--guard': options.guardPath = next(); break
      case '--pi-bin': options.piBin = next(); break
      case '--prompt-timeout-ms': options.promptTimeoutMs = Number(next()); break
      default: throw new Error(`unknown_argument:${arg}`)
    }
  }
  return options
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  Promise.resolve()
    .then(async () => {
      const options = parseCliArgs(process.argv.slice(2))
      const evidence = await runAuthorizedExecution({
        grant: {
          runId: options.runId,
          botId: options.botId,
          workspaceRoot: options.workspace,
          allowedTools: options.tools,
          isolatedSelfOwnedWorkspace: options.isolatedSelfOwnedWorkspace === true,
          expiresAt: options.expiresAt
        },
        model: {
          providerId: options.providerId,
          baseUrl: options.baseUrl,
          modelId: options.modelId,
          apiKeyEnvVar: options.apiKeyEnvVar,
          api: 'openai-completions'
        },
        prompt: options.prompt,
        expectedArtifactPaths: options.artifact,
        ...(options.guardPath ? { guardPath: options.guardPath } : {}),
        ...(options.piBin ? { piBin: options.piBin } : {}),
        ...(Number.isInteger(options.promptTimeoutMs) ? { promptTimeoutMs: options.promptTimeoutMs } : {})
      })
      console.log(JSON.stringify(evidence, null, 2))
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error))
      process.exitCode = 1
    })
}

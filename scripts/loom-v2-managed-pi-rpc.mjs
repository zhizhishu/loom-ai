// LOOM V2 — Node-native private Pi RPC Supervisor.
//
// Contract: docs/loom/LOOM-V2-P1B-PI-RUNTIME-INTEGRATION-2026-11-15.md and
// docs/loom/LOOM-V2-P1B-ACCEPTANCE-HANDOFF-2026-11-15.md. This supervisor owns
// the *managed*, *per-Bot*, *offline* Pi JSONL RPC process that Root validated
// empirically against the pinned pi.exe 0.85.1 bundle:
//
//   pi --mode rpc --offline --no-tools --no-session --no-context-files
//      --no-skills --no-extensions --extension <staged pi-purge.ts>
//
// Boundaries (deliberate, do not relax here):
// - It NEVER touches the user's global Pi/DSH config. Each Bot gets its own
//   private sandbox root, its own PI_CODING_AGENT_DIR (agent dir) and its own
//   workspace; the sandbox must be absolute, symlink-free, and outside the real
//   user ~/.pi.
// - It NEVER sends a model prompt. The only outbound commands are
//   get_commands / get_state / prompt (message strictly one of the allowlisted
//   `/purge on|off|status|mode append|mode strict` slash commands). Pi 0.85.1
//   RPC has no run_command; /purge is reachable only through those prompts.
//   providerPromptSeen is therefore always false: loading the extension and
//   toggling /purge is not a Provider Prompt, and must never be reported as one.
// - It is fail-closed: a request timeout or a mid-request process exit rejects
//   the pending call and poisons the supervisor, so no later call can silently
//   proceed against a half-dead Pi.
// - JSONL response pairing is strict: a response must match the pending request
//   by `id` AND (when present) `command`; a mismatch is a protocol failure.
//
// Honest evidence split (see activatePurge): `loaded` (extension listed by
// get_commands), `activated` (/purge on + mode observed via real extension
// notifications), `providerPromptSeen` (always false). Deleting this file and its
// test fully reverts the change.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const PI_RPC_API_VERSION = 'loom.v2alpha1'

// Pinned Pi bundle identity Root verified (tree SHA from the P1-B handoff). A
// manifest that does not declare exactly this bundle is refused.
export const PINNED_PI = Object.freeze({
  packageName: '@earendil-works/pi',
  version: '0.85.1',
  treeSha256: '5692cc77a900ec7fccc8b6e9dcc6648b8ec42d81e83b627cd06c21fd0707c871'
})

export const PURGE_EXTENSION_ID = 'pi-purge'
export const PURGE_COMMAND_NAME = 'purge'

// Pi 0.85.1 JSONL RPC has no `run_command`; the ONLY way to drive the /purge
// extension is `type:"prompt"` whose message is a slash command. We therefore
// allowlist the exact /purge subcommands Root validated on the bundled Pi, so a
// normal model prompt can never be sent through this supervisor.
export const PURGE_COMMAND_ALLOWLIST = Object.freeze([
  '/purge on',
  '/purge off',
  '/purge status',
  '/purge mode append',
  '/purge mode strict'
])

// Outbound request types the supervisor may emit. `run_command` is deliberately
// absent: it does not exist in Pi 0.85.1 and must be refused, not silently sent.
const REQUEST_TYPE_ALLOWLIST = Object.freeze(['get_commands', 'get_state', 'prompt'])

// Exact managed argv Root validated against pi.exe 0.85.1. `--no-extensions`
// disables auto-discovery; the single `--extension <path>` we append is the only
// extension the process loads.
export const MANAGED_PI_FLAGS = Object.freeze([
  '--mode', 'rpc',
  '--offline',
  '--no-tools',
  '--no-session',
  '--no-context-files',
  '--no-skills',
  '--no-extensions'
])

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000
export const DEFAULT_STOP_TIMEOUT_MS = 2_000
export const MAX_CAPTURED_NOTIFICATIONS = 256

// Environment inherited from the launching process. We never inherit a
// user-global Pi coding-agent dir; PI_CODING_AGENT_DIR is always forced to the
// Bot's private agent dir below.
const INHERITED_ENV_KEYS = Object.freeze([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL',
  'NUMBER_OF_PROCESSORS'
])

export class PiRpcError extends Error {
  constructor(code, message) {
    super(message ?? code)
    this.name = 'PiRpcError'
    this.code = code
  }
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

// ---------------------------------------------------------------------------
// Manifest pin check
// ---------------------------------------------------------------------------

// A managed manifest declares which Pi bundle and which staged extension the
// supervisor is allowed to launch. Anything other than the pinned bundle is
// refused before a process is ever spawned.
export function verifyManifestPin(manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['manifest_must_be_object'] }
  }
  const errors = []
  if (manifest.piVersion !== PINNED_PI.version) errors.push('piVersion_must_match_pinned_bundle')
  if (manifest.treeSha256 !== PINNED_PI.treeSha256) errors.push('treeSha256_must_match_pinned_bundle')
  if (typeof manifest.extensionSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.extensionSha256)) {
    errors.push('extensionSha256_invalid')
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}

// ---------------------------------------------------------------------------
// Deterministic tree + file digests (used to detect bundle / extension tamper)
// ---------------------------------------------------------------------------

function walkFiles(root, current = root, out = []) {
  for (const name of readdirSync(current).sort()) {
    const abs = join(current, name)
    const stat = lstatSync(abs)
    if (stat.isSymbolicLink()) {
      throw new PiRpcError('bundle_symlink', `tree digest refuses symlinks: ${abs}`)
    }
    if (stat.isDirectory()) walkFiles(root, abs, out)
    else if (stat.isFile()) out.push(abs)
  }
  return out
}

export function computeTreeSha256(directory) {
  const root = resolve(directory)
  const files = walkFiles(root)
  files.sort((a, b) => relative(root, a).localeCompare(relative(root, b)))
  const hash = createHash('sha256')
  for (const abs of files) {
    const rel = relative(root, abs).split(sep).join('/')
    const bytes = readFileSync(abs)
    hash.update(`${rel}\0${bytes.length}\0${sha256Hex(bytes)}\n`)
  }
  return hash.digest('hex')
}

export function verifyExtensionDigest(extensionPath, expectedSha256) {
  let stat
  try {
    stat = lstatSync(extensionPath)
  } catch {
    return { ok: false, error: 'extension_missing', expected: expectedSha256 }
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { ok: false, error: 'extension_not_regular_file', expected: expectedSha256 }
  }
  const actual = sha256Hex(readFileSync(extensionPath))
  return { ok: actual === expectedSha256, actual, expected: expectedSha256 }
}

// ---------------------------------------------------------------------------
// Sandbox isolation checks
// ---------------------------------------------------------------------------

function realResolve(target) {
  try {
    return realpathSync(target)
  } catch {
    return resolve(target)
  }
}

function isInside(child, parent) {
  const c = resolve(child)
  const p = resolve(parent)
  if (c === p) return true
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

function assertNoSymlinkBelow(rootReal, targetReal, label) {
  const rel = relative(rootReal, targetReal)
  if (rel === '' || rel.startsWith('..')) return
  let current = rootReal
  for (const segment of rel.split(sep)) {
    current = join(current, segment)
    if (lstatSync(current).isSymbolicLink()) {
      throw new PiRpcError('sandbox_symlink', `${label} contains a symlink at ${current}`)
    }
  }
}

// A managed sandbox must be absolute, exist, be symlink-free, and stay outside
// the real user ~/.pi. agentDir and workspace must both live inside it.
export function assertSandboxRoot({ sandboxRoot, agentDir, workspace, homeDir = homedir() } = {}) {
  const errors = []
  for (const [label, value] of [['sandboxRoot', sandboxRoot], ['agentDir', agentDir], ['workspace', workspace]]) {
    if (typeof value !== 'string' || !isAbsolute(value)) errors.push(`${label}_must_be_absolute`)
  }
  if (errors.length > 0) return { ok: false, errors }

  const lstatOrNull = (target) => {
    try {
      return lstatSync(target)
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      throw error
    }
  }
  for (const [label, target] of [['sandboxRoot', sandboxRoot], ['agentDir', agentDir], ['workspace', workspace]]) {
    const stat = lstatOrNull(target)
    if (!stat) {
      errors.push(`${label}_missing`)
    } else if (stat.isSymbolicLink()) {
      errors.push(`${label}_symlink`)
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  const realRoot = realpathSync(sandboxRoot)
  const realAgent = realpathSync(agentDir)
  const realWorkspace = realpathSync(workspace)
  const userPiDir = join(realResolve(homeDir), '.pi')

  for (const [label, real] of [['sandboxRoot', realRoot], ['agentDir', realAgent], ['workspace', realWorkspace]]) {
    if (isInside(real, userPiDir)) errors.push(`${label}_forbidden_user_pi`)
  }
  if (!isInside(realAgent, realRoot)) errors.push('agentDir_outside_sandbox')
  if (!isInside(realWorkspace, realRoot)) errors.push('workspace_outside_sandbox')

  try {
    assertNoSymlinkBelow(realRoot, realAgent, 'agentDir')
    assertNoSymlinkBelow(realRoot, realWorkspace, 'workspace')
  } catch (error) {
    if (error instanceof PiRpcError) errors.push(error.code)
    else throw error
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, realRoot }
}

// ---------------------------------------------------------------------------
// Launch argv + isolated environment
// ---------------------------------------------------------------------------

export function buildPiArgv({ extensionPath, prefixArgs = [] } = {}) {
  if (typeof extensionPath !== 'string' || !isAbsolute(extensionPath)) {
    throw new PiRpcError('extension_path_must_be_absolute')
  }
  return [...prefixArgs, ...MANAGED_PI_FLAGS, '--extension', extensionPath]
}

export function buildIsolatedEnv({ agentDir, env = {}, baseEnv = process.env } = {}) {
  if (typeof agentDir !== 'string' || !isAbsolute(agentDir)) {
    throw new PiRpcError('agentDir_must_be_absolute')
  }
  const out = {}
  for (const key of INHERITED_ENV_KEYS) {
    if (baseEnv[key] !== undefined) out[key] = baseEnv[key]
  }
  for (const [key, value] of Object.entries(env)) out[key] = value
  // Forced LAST so a caller-supplied env can never redirect Pi at the user's
  // global config or re-enable telemetry.
  out.PI_CODING_AGENT_DIR = agentDir
  out.PI_TELEMETRY = '0'
  return out
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

export class ManagedPiRpcSupervisor {
  constructor(config = {}) {
    this.config = config
    this.instanceLabel = config.instanceLabel ?? 'bot'
    this.child = null
    this.pending = new Map()
    this.nextId = 0
    this.notifications = []
    this.sentCommands = []
    this.sentPrompts = []
    this.stderr = []
    this.failed = false
    this.failReason = null
    this.sessionId = null
    this.exit = null
    this.stdoutBuffer = ''
  }

  async start() {
    if (this.child) throw new PiRpcError('already_started')

    const pin = verifyManifestPin(this.config.manifest)
    if (!pin.ok) throw new PiRpcError('manifest_pin_mismatch', pin.errors.join(','))

    const digest = verifyExtensionDigest(this.config.extensionPath, this.config.manifest.extensionSha256)
    if (!digest.ok) {
      throw new PiRpcError('extension_digest_mismatch', `expected ${digest.expected} got ${digest.actual ?? digest.error}`)
    }

    const sandbox = assertSandboxRoot({
      sandboxRoot: this.config.sandboxRoot,
      agentDir: this.config.agentDir,
      workspace: this.config.workspace,
      homeDir: this.config.homeDir
    })
    if (!sandbox.ok) throw new PiRpcError('sandbox_rejected', sandbox.errors.join(','))

    const argv = buildPiArgv({
      extensionPath: this.config.extensionPath,
      prefixArgs: this.config.executablePrefixArgs ?? []
    })
    const env = buildIsolatedEnv({ agentDir: this.config.agentDir, env: this.config.env ?? {} })

    const child = spawn(this.config.executable, argv, {
      cwd: this.config.workspace,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onStdout(chunk))
    child.stderr.on('data', (chunk) => {
      this.stderr.push(String(chunk).slice(0, 2000))
      if (this.stderr.length > MAX_CAPTURED_NOTIFICATIONS) this.stderr.shift()
    })
    child.on('error', (error) => this.#failClosed(`spawn_error:${error.message}`))
    child.on('exit', (code, signal) => this.#onExit(code, signal))

    await new Promise((resolveStart, rejectStart) => {
      const timer = setTimeout(
        () => rejectStart(new PiRpcError('startup_timeout')),
        this.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
      )
      child.once('spawn', () => {
        clearTimeout(timer)
        resolveStart()
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        rejectStart(new PiRpcError('spawn_error', error.message))
      })
    })
    return this
  }

  #onStdout(chunk) {
    this.stdoutBuffer += chunk
    let index
    while ((index = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, index).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1)
      if (line.length > 0) this.#onLine(line)
    }
  }

  #onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.stderr.push(`[unparsable-stdout] ${line.slice(0, 200)}`)
      return
    }
    const type = message?.type
    if (type === 'response') {
      this.#onResponse(message)
      return
    }
    if (type === 'session') {
      if (typeof message.id === 'string' && message.id.length > 0) this.sessionId = message.id
      return
    }
    this.#recordNotification(message)
  }

  #recordNotification(message) {
    const type = message?.type
    if (
      type === 'extension_ui_request' ||
      type === 'notify' ||
      type === 'setStatus' ||
      type === 'extension_error'
    ) {
      if (this.notifications.length >= MAX_CAPTURED_NOTIFICATIONS) this.notifications.shift()
      this.notifications.push({
        type,
        method: message.method ?? null,
        level: message.level ?? null,
        message: message.message ?? message.statusText ?? message.error ?? null
      })
    }
  }

  #onResponse(message) {
    const pending = this.pending.get(message.id)
    if (!pending) {
      this.stderr.push(`[unmatched-response] ${message.id}`)
      return
    }
    // id AND command must agree; a response that answers the right id but the
    // wrong command is a protocol failure, not a success.
    if (message.command !== undefined && message.command !== pending.command) {
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      pending.reject(new PiRpcError('response_command_mismatch', `expected ${pending.command} got ${message.command}`))
      this.#failClosed('response_command_mismatch')
      return
    }
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.success === false) {
      pending.reject(new PiRpcError('rpc_command_failed', message.error ?? `${pending.command} failed`))
    } else {
      pending.resolve(message.data ?? {})
    }
  }

  #onExit(code, signal) {
    this.exit = { code, signal }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new PiRpcError('pi_process_exited', `code=${code} signal=${signal}`))
      this.pending.delete(id)
    }
    if (!this.failed) {
      this.failed = true
      this.failReason = `process_exited:${code}`
    }
  }

  #failClosed(reason) {
    if (this.failed) return
    this.failed = true
    this.failReason = reason
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new PiRpcError('supervisor_failed', reason))
      this.pending.delete(id)
    }
    const child = this.child
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill()
      } catch {
        // A process already on its way out is not an error here.
      }
    }
  }

  async request(type, fields = {}, options = {}) {
    // Protocol guards run first: they are pure and fire before any process or
    // health check, so a bad type or a normal model prompt is refused loudly.
    if (type === 'run_command') {
      throw new PiRpcError('run_command_not_supported', 'Pi 0.85.1 RPC has no run_command; drive /purge via type=prompt')
    }
    if (!REQUEST_TYPE_ALLOWLIST.includes(type)) {
      throw new PiRpcError('unsupported_rpc_type', `unsupported RPC type: ${type}`)
    }
    if (type === 'prompt' && !PURGE_COMMAND_ALLOWLIST.includes(fields.message)) {
      throw new PiRpcError('prompt_not_allowlisted', `refusing non-/purge prompt message: ${String(fields.message)}`)
    }
    if (this.failed) throw new PiRpcError('supervisor_failed', this.failReason ?? 'failed')
    if (!this.child || this.child.exitCode !== null) throw new PiRpcError('pi_process_not_running')

    const id = `${this.instanceLabel}-${++this.nextId}`
    const record = { type, id, ...fields }
    const timeoutMs = options.timeoutMs ?? this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.sentCommands.push(type)
    if (type === 'prompt') this.sentPrompts.push(fields.message)

    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectRequest(new PiRpcError('request_timeout', type))
        this.#failClosed(`timeout:${type}`)
      }, timeoutMs)
      this.pending.set(id, { command: type, resolve: resolveRequest, reject: rejectRequest, timer })
      try {
        this.child.stdin.write(`${JSON.stringify(record)}\n`)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        rejectRequest(new PiRpcError('stdin_write_failed', error.message))
      }
    })
  }

  async getCommands(options) {
    const data = await this.request('get_commands', {}, options)
    if (Array.isArray(data)) return data
    return Array.isArray(data?.commands) ? data.commands : []
  }

  async getState(options) {
    return this.request('get_state', {}, options)
  }

  // Drive one /purge subcommand over the real Pi RPC. Pi has no run_command, so
  // this is a `type:"prompt"` whose message is a strict-allowlisted slash
  // command; any other message is refused before it reaches the process.
  async runPurgeCommand(message, options) {
    if (!PURGE_COMMAND_ALLOWLIST.includes(message)) {
      throw new PiRpcError('purge_command_not_allowlisted', `refusing non-allowlisted /purge command: ${String(message)}`)
    }
    return this.request('prompt', { message }, options)
  }

  async stop() {
    const child = this.child
    this.child = null
    if (!child) return { stopped: false }
    if (child.exitCode !== null || child.signalCode !== null) {
      return { stopped: true, graceful: false, alreadyExited: true }
    }
    const closed = new Promise((resolveClose) => child.once('close', () => resolveClose(true)))
    try {
      child.stdin.end()
    } catch {
      // stdin may already be gone if the process died; force-kill handles it.
    }
    const stopTimeout = this.config.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
    const graceful = await Promise.race([
      closed,
      new Promise((resolveGraceful) => setTimeout(() => resolveGraceful(false), stopTimeout))
    ])
    if (!graceful) {
      try {
        child.kill()
      } catch {
        // ignore
      }
      await Promise.race([closed, new Promise((resolveKill) => setTimeout(() => resolveKill(false), stopTimeout))])
    }
    return { stopped: true, graceful }
  }
}

// ---------------------------------------------------------------------------
// Honest activation orchestrator
// ---------------------------------------------------------------------------

// Drive /purge on a running supervisor and report what was actually observed.
// The only `prompt` this path ever issues is an allowlisted /purge slash command
// (never a normal model prompt), so providerPromptSeen is a literal false: a
// Provider Prompt can never have been seen. `activated` is only true when the
// extension itself emitted the enable (and, if requested, mode) notifications —
// a command response success alone is not activation evidence.
export async function activatePurge(supervisor, { enable, mode } = {}) {
  const commands = await supervisor.getCommands()
  const purge = commands.find((command) => command && command.name === PURGE_COMMAND_NAME)
  const loaded = Boolean(purge)
  const sourcePath = purge?.sourceInfo?.path ?? null

  if (loaded && enable) {
    await supervisor.runPurgeCommand('/purge on')
    if (mode) await supervisor.runPurgeCommand(`/purge mode ${mode}`)
    await supervisor.runPurgeCommand('/purge status')
  } else if (loaded) {
    await supervisor.runPurgeCommand('/purge status')
  }

  const state = await supervisor.getState()
  const notifyTexts = supervisor.notifications.map((notification) => String(notification.message ?? ''))
  const enabledNotified = notifyTexts.some((text) => text.includes('已开启'))
  const modeNotified = mode ? notifyTexts.some((text) => text.includes(mode)) : true
  const activated = Boolean(loaded && enable && enabledNotified && modeNotified)

  return {
    loaded,
    activated,
    providerPromptSeen: false,
    sourcePath,
    mode: mode ?? null,
    messageCount: Number(state?.messageCount ?? -1),
    sessionId: state?.sessionId ?? supervisor.sessionId ?? null,
    notifications: notifyTexts,
    commands: commands.map((command) => command?.name ?? null)
  }
}

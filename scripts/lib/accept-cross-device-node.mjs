// Shared, import-time-side-effect-free helpers for the two-machine device
// acceptance in `scripts/accept-cross-device-node.mjs`.
//
// Boundary (read before trusting any output):
//   * Nothing here starts a server, a node, a Runtime or a model.
//   * Host facts come only from the running host's own HTTP API
//     (`POST /api/v1/login`, `GET /api/v1/nodes`, `POST /api/v1/nodes/pair`,
//     `POST /api/v1/nodes/workspaces`, `POST /api/v1/nodes/workspaces/files`).
//   * Node facts come only from the node's own credential file written by
//     `loom-node` after a successful pairing.
//   * A runtime that a node advertises is `ADVERTISED`, never `INVOKED`.
//     No field here may be read as "the Runtime loaded or ran".
//   * The Workspace RPC (R2) archive receipt / loom_artifact is NOT reachable
//     from the node CLI or the HTTP surface, so it is always reported as
//     NOT_RUN with that reason instead of being inferred from returned bytes.
//
// Secret policy: a pairing code or an administrator/session token is never put
// in argv, never printed, and never written into an evidence document. Callers
// pass secrets in, and `assertNoSecrets` is a hard gate before every write.

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SCRIPT_NAME = 'accept-cross-device-node'
export const EVIDENCE_VERSION = 1

/** `rovai_web::HOST_WEB_PROTOCOL_VERSION` (crates/rovai-web/src/lib.rs:43). */
export const HOST_WEB_PROTOCOL_VERSION = 5

/** The closed four-runtime set (`loom_protocol::v2_domain::RuntimeKind`). */
export const RUNTIME_KINDS = Object.freeze(['pi', 'deepseek-harness', 'codex-cli', 'claude-code-cli'])

/** `MAX_READ_BYTES` in crates/loom-protocol/src/workspace.rs. */
export const MAX_READ_BYTES = 1024 * 1024

export const STAGES = Object.freeze([
  'plan',
  'host-prepare',
  'node-pair',
  'node-serve',
  'workspace-prepare',
  'verify',
  'status'
])

export const VERIFY_PHASES = Object.freeze(['online', 'offline', 'reconnect'])

export const EVIDENCE_FILES = Object.freeze({
  'host-prepare': 'host-prepare.json',
  'node-pair': 'node-pair.json',
  'workspace-prepare': 'workspace-prepare.json',
  online: 'verify-online.json',
  offline: 'verify-offline.json',
  reconnect: 'verify-reconnect.json'
})

export class UsageError extends Error {
  constructor (code, message) { super(message); this.code = code; this.name = 'UsageError' }
}

export class HostError extends Error {
  constructor (code, message, status) {
    super(message)
    this.code = code
    this.status = status
    this.name = 'HostError'
  }
}

/* ------------------------------------------------------------------ flags */

const VALUE_FLAGS = {
  '--endpoint': 'endpoint',
  '--token-file': 'tokenFile',
  '--evidence': 'evidence',
  '--pair-code-out': 'pairCodeOut',
  '--pair-code-env': 'pairCodeEnv',
  '--node-bin': 'nodeBin',
  '--node-root': 'nodeRoot',
  '--node-data-root': 'nodeRoot',
  '--host-data-root': 'hostDataRoot',
  '--server': 'server',
  '--expect-node-id': 'expectNodeId',
  '--mission': 'mission',
  '--camp': 'camp',
  '--source': 'source',
  '--probe-relative': 'probeRelative',
  '--expected-sha256': 'expectedSha256',
  '--require-runtime': 'requireRuntime',
  '--exec-runtime': 'execRuntime',
  '--exec-cwd': 'execCwd',
  '--exec-arg': 'execArg',
  '--timeout-ms': 'timeoutMs',
  '--phase': 'phase'
}

const BOOLEAN_FLAGS = {
  '--token-stdin': 'tokenStdin',
  '--pair-code-stdin': 'pairCodeStdin'
}

const REQUIRED = {
  plan: ['endpoint', 'nodeBin', 'nodeRoot', 'server', 'evidence', 'hostDataRoot'],
  'host-prepare': ['endpoint', 'evidence'],
  'node-pair': ['nodeBin', 'nodeRoot', 'server', 'evidence'],
  'node-serve': ['nodeBin', 'nodeRoot', 'server'],
  'workspace-prepare': ['endpoint', 'evidence', 'mission', 'camp', 'source', 'expectNodeId'],
  verify: ['endpoint', 'evidence', 'mission', 'probeRelative', 'expectNodeId'],
  status: ['evidence']
}

/** `loom-node` probes installed CLIs before it dials, so pairing can be slow. */
export const DEFAULT_TIMEOUT_MS = 120_000

export function parseArguments (argv) {
  const [stage, ...rest] = argv
  if (!stage) throw new UsageError('usage', `stage must be one of ${STAGES.join(', ')}`)
  if (!STAGES.includes(stage)) throw new UsageError('usage', `unknown stage ${stage}`)
  const options = { stage, tokenStdin: false, pairCodeStdin: false, timeoutMs: DEFAULT_TIMEOUT_MS }
  for (let index = 0; index < rest.length; index += 1) {
    const raw = rest[index]
    // `--flag=value` is the only form that may carry a value starting with `--`,
    // so `--exec-arg=--version` stays expressible without relaxing the space form.
    const equals = raw.startsWith('--') ? raw.indexOf('=') : -1
    const flag = equals > 2 ? raw.slice(0, equals) : raw
    const inline = equals > 2 ? raw.slice(equals + 1) : undefined
    if (BOOLEAN_FLAGS[flag]) {
      if (inline !== undefined) throw new UsageError('usage', `${flag} does not take a value`)
      options[BOOLEAN_FLAGS[flag]] = true
      continue
    }
    const key = VALUE_FLAGS[flag]
    if (!key) throw new UsageError('usage', `unknown option ${flag}`)
    const value = inline ?? rest[index + 1]
    if (value === undefined) throw new UsageError('usage', `${flag} needs a value`)
    if (inline === undefined && value.startsWith('--')) {
      throw new UsageError('usage', `${flag} needs a value; write ${flag}=<value> if the value starts with --`)
    }
    if (inline === undefined) index += 1
    if (key === 'execArg') {
      if (value.length > 32_768 || value.includes('\u0000')) throw new UsageError('usage', '--exec-arg is too long or contains NUL')
      options.execArgs = [...(options.execArgs ?? []), value]
      if (options.execArgs.length > 64) throw new UsageError('usage', 'at most 64 --exec-arg values')
      continue
    }
    options[key] = value
  }
  for (const key of REQUIRED[stage]) {
    if (options[key] === undefined) throw new UsageError('usage', `${stage} needs --${kebab(key)}`)
  }
  if (options.timeoutMs !== DEFAULT_TIMEOUT_MS) {
    const parsed = Number(options.timeoutMs)
    if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 900_000) {
      throw new UsageError('usage', '--timeout-ms must be an integer between 1000 and 900000')
    }
    options.timeoutMs = parsed
  }
  if (options.endpoint !== undefined) options.endpoint = normalizeEndpoint(options.endpoint)
  if (options.server !== undefined) options.server = normalizeServer(options.server)
  for (const key of ['mission', 'camp', 'expectNodeId']) {
    if (options[key] !== undefined) assertScopeId(options[key], `--${kebab(key)}`)
  }
  if (options.probeRelative !== undefined) options.relative = assertSafeRelative(options.probeRelative)
  if (options.expectedSha256 !== undefined) assertSha256(options.expectedSha256, '--expected-sha256')
  if (options.requireRuntime !== undefined) {
    options.requireRuntimes = options.requireRuntime.split(',').map(value => value.trim()).filter(Boolean)
    for (const kind of options.requireRuntimes) assertRuntimeKind(kind)
  }
  if (options.execRuntime !== undefined) {
    assertRuntimeKind(options.execRuntime)
    if (options.execCwd === undefined) throw new UsageError('usage', '--exec-runtime needs --exec-cwd')
  }
  if (options.phase !== undefined && !VERIFY_PHASES.includes(options.phase)) {
    throw new UsageError('usage', `--phase must be one of ${VERIFY_PHASES.join(', ')}`)
  }
  const tokenSources = [Boolean(options.tokenFile), options.tokenStdin].filter(Boolean).length
  if (['host-prepare', 'workspace-prepare', 'verify'].includes(stage)) {
    if (tokenSources === 0) throw new UsageError('usage', `${stage} needs --token-file or --token-stdin`)
    if (tokenSources > 1) throw new UsageError('usage', '--token-file and --token-stdin are exclusive')
  }
  if (options.tokenFile !== undefined && options.tokenStdin) {
    throw new UsageError('usage', '--token-file and --token-stdin are exclusive')
  }
  if (stage === 'node-pair') {
    const sources = [options.pairCodeStdin, Boolean(options.pairCodeEnv)].filter(Boolean).length
    if (sources !== 1) throw new UsageError('usage', 'node-pair needs exactly one of --pair-code-stdin or --pair-code-env')
  }
  if (stage === 'host-prepare' && options.pairCodeOut === undefined) {
    throw new UsageError('pairing-code', 'the pairing code is written with --pair-code-out and never printed')
  }
  return options
}

function kebab (key) { return key.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`) }

/** Mirrors `rovai-web/src/nodes.rs::valid_scope_id`. */
export function assertScopeId (value, label) {
  const ok = typeof value === 'string' && value.length > 0 && value.length <= 80 &&
    !value.includes('\u0000') && ![...value].some(character => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)
  if (!ok) throw new UsageError('usage', `${label} must be 1..80 characters without NUL or control characters`)
  return value
}

/** Mirrors the pre-I/O half of `loom-protocol/src/workspace.rs::workspace_relative`. */
export function assertSafeRelative (raw) {
  if (typeof raw !== 'string') throw new UsageError('usage', '--probe-relative must be a string')
  if (raw === '' || raw === '.') return ''
  if (raw.includes('\u0000')) throw new UsageError('path_rejected', '--probe-relative contains NUL')
  if (raw.length > 4096) throw new UsageError('path_rejected', '--probe-relative is longer than 4096 bytes')
  if (raw.includes('\\')) throw new UsageError('path_rejected', '--probe-relative must use / and no backslash')
  if (raw.startsWith('/') || /^[A-Za-z]:/u.test(raw)) throw new UsageError('path_rejected', '--probe-relative must be relative')
  for (const part of raw.split('/')) {
    if (part === '' || part === '.' || part === '..') {
      throw new UsageError('path_rejected', '--probe-relative has an empty, . or .. component')
    }
  }
  return raw
}

export function assertSha256 (value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new UsageError('usage', `${label} must be 64 lowercase hex characters`)
  }
  return value
}

export function assertRuntimeKind (kind) {
  if (!RUNTIME_KINDS.includes(kind)) {
    throw new UsageError('usage', `runtime must be one of ${RUNTIME_KINDS.join(', ')}`)
  }
  return kind
}

export function normalizeEndpoint (value) {
  let url
  try { url = new URL(value) } catch { throw new UsageError('usage', '--endpoint must be an http(s) URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError('usage', '--endpoint must be an http(s) URL')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new UsageError('usage', '--endpoint must not carry credentials, a query or a fragment')
  }
  return url.origin
}

/** `loom-node` refuses plaintext ws:// off loopback (crates/loom-node/src/lib.rs). */
export function normalizeServer (value) {
  let url
  try { url = new URL(value) } catch { throw new UsageError('usage', '--server must be a ws(s) URL') }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new UsageError('usage', '--server must be a ws(s) URL')
  }
  if (!url.pathname.endsWith('/api/v1/nodes/connect')) {
    throw new UsageError('usage', '--server must end with /api/v1/nodes/connect')
  }
  if (url.protocol === 'ws:' && !isLoopbackHost(url.hostname)) {
    throw new UsageError('usage', 'plaintext ws:// is only accepted for a loopback host; use wss:// or a loopback tunnel')
  }
  return url.toString()
}

function isLoopbackHost (hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

/* ----------------------------------------------------------------- secrets */

/** Replace any secret, and any string that merely contains one, with a marker. */
export function sanitizeEvidence (value, secrets = []) {
  const list = secrets.filter(secret => typeof secret === 'string' && secret.length > 0)
  const scrub = text => {
    let out = text
    for (const secret of list) out = out.split(secret).join('<redacted>')
    return out
  }
  const walk = item => {
    if (typeof item === 'string') return scrub(item)
    if (Array.isArray(item)) return item.map(walk)
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).map(([key, nested]) => [scrub(key), walk(nested)]))
    }
    return item
  }
  return walk(value)
}

export function findSecret (value, secrets = []) {
  const list = secrets.filter(secret => typeof secret === 'string' && secret.length > 0)
  const visit = item => {
    if (typeof item === 'string') return list.find(secret => item.includes(secret)) ?? null
    if (Array.isArray(item)) {
      for (const nested of item) { const hit = visit(nested); if (hit) return hit }
      return null
    }
    if (item && typeof item === 'object') {
      for (const [key, nested] of Object.entries(item)) {
        const keyHit = list.find(secret => key.includes(secret))
        if (keyHit) return keyHit
        const hit = visit(nested)
        if (hit) return hit
      }
    }
    return null
  }
  return visit(value)
}

/** Hard gate: evidence containing a secret is never written. */
export function assertNoSecrets (value, secrets = []) {
  const hit = findSecret(value, secrets)
  if (hit) throw new UsageError('secret_leak', 'refusing to write evidence that contains a secret')
  return value
}

/* ----------------------------------------------------------- credentials */

/**
 * Read the node credential `loom-node` writes after pairing
 * (crates/loom-node/src/lib.rs::write_credentials: {version,nodeId,token,server}).
 * The token is validated and then dropped: only the node id leaves this call.
 */
export function parseNodeCredential (text) {
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new UsageError('node_credential', 'node.json is not JSON') }
  if (parsed?.version !== 1) throw new UsageError('node_credential', 'node.json has an unsupported version')
  if (typeof parsed.nodeId !== 'string' || parsed.nodeId.length === 0) {
    throw new UsageError('node_credential', 'node.json is missing nodeId')
  }
  if (typeof parsed.token !== 'string' || !/^[0-9a-f]{64}$/u.test(parsed.token)) {
    throw new UsageError('node_credential', 'node.json token is not 64 lowercase hex')
  }
  if (typeof parsed.server !== 'string' || parsed.server.length === 0) {
    throw new UsageError('node_credential', 'node.json is missing server')
  }
  return { nodeId: parsed.nodeId, server: parsed.server }
}

/** A 64-hex administrator or session token; the value itself is only returned. */
export function parseToken (text, label = 'token') {
  const line = String(text).split(/\r?\n/u).map(value => value.trim())
    .find(value => /^(?:token=)?[0-9a-f]{64}$/u.test(value))
  if (!line) throw new UsageError('token', `${label} is not a 64-hex token`)
  return line.replace(/^token=/u, '')
}

/* ---------------------------------------------------------------- evidence */

export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex')

export class EvidenceWriter {
  constructor (directory, secrets = []) {
    this.directory = directory
    this.secrets = secrets.filter(secret => typeof secret === 'string' && secret.length > 0)
  }

  path (name) { return join(this.directory, name) }

  ensureDirectory () {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    try { chmodSync(this.directory, 0o700) } catch { /* Windows ignores POSIX modes */ }
  }

  write (name, payload) {
    this.ensureDirectory()
    const document = {
      version: EVIDENCE_VERSION,
      script: SCRIPT_NAME,
      platform: process.platform,
      wroteAt: new Date().toISOString(),
      ...payload
    }
    const sanitized = sanitizeEvidence(document, this.secrets)
    assertNoSecrets(sanitized, this.secrets)
    const text = `${JSON.stringify(sanitized, null, 2)}\n`
    assertNoSecrets(text, this.secrets)
    const target = this.path(name)
    writeFileSync(target, text, { mode: 0o600 })
    try { chmodSync(target, 0o600) } catch { /* Windows ignores POSIX modes */ }
    return target
  }

  read (name) {
    const target = this.path(name)
    if (!existsSync(target)) return null
    try { return JSON.parse(readFileSync(target, 'utf8')) } catch { return null }
  }
}

/** Write a secret (a one-time pairing code) to its own private file. */
export function writeSecretFile (path, secret) {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${secret}\n`, { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch { /* Windows ignores POSIX modes */ }
  return path
}

/* -------------------------------------------------------------------- http */

export class HostClient {
  constructor (origin, fetchImpl = globalThis.fetch) {
    this.origin = origin
    this.fetch = fetchImpl
    this.session = null
  }

  async #call (method, path, body) {
    const headers = { origin: this.origin }
    if (this.session) headers.authorization = `Bearer ${this.session}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    let response
    try {
      response = await this.fetch(`${this.origin}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    } catch (error) {
      throw new HostError('host_unreachable', `could not reach ${this.origin}: ${error.code ?? error.message}`, 0)
    }
    const text = await response.text()
    let parsed = null
    try { parsed = text.length ? JSON.parse(text) : null } catch { parsed = null }
    if (!response.ok) {
      const code = parsed?.error?.code ?? `http_${response.status}`
      throw new HostError(code, `${method} ${path} was rejected`, response.status)
    }
    if (parsed === null) throw new HostError('host_not_json', `${method} ${path} did not return JSON`, response.status)
    return parsed
  }

  async login (administratorToken) {
    const body = await this.#call('POST', '/api/v1/login', {
      protocolVersion: HOST_WEB_PROTOCOL_VERSION,
      administratorToken
    })
    if (typeof body.token !== 'string' || body.token.length === 0) {
      throw new HostError('login', 'login returned no session token', 200)
    }
    this.session = body.token
    return this.session
  }

  listNodes () { return this.#call('GET', '/api/v1/nodes') }

  /** `POST /api/v1/nodes/pair` -> {pairingCode, expiresInSeconds, connectUrl}. */
  issuePairing () { return this.#call('POST', '/api/v1/nodes/pair') }

  /** Idempotent per mission: an existing workspace is returned unchanged. */
  prepareWorkspace ({ missionId, campId, nodeId, source }) {
    return this.#call('POST', '/api/v1/nodes/workspaces', { missionId, campId, nodeId, source })
  }

  /** `op` is `list` or `read`; `relative` is already validated by the caller. */
  workspaceFiles ({ missionId, op, relative }) {
    return this.#call('POST', '/api/v1/nodes/workspaces/files', { missionId, op, relative })
  }

  /** One dispatch. The caller must never repeat this after an unknown outcome. */
  exec ({ runtime, cwd, args, missionId }) {
    const body = { runtime, cwd, args }
    if (missionId !== undefined) body.missionId = missionId
    return this.#call('POST', '/api/v1/nodes/exec', body)
  }
}

/* ------------------------------------------------------- fact projections */

export function nodeById (nodeList, nodeId) {
  const nodes = Array.isArray(nodeList?.nodes) ? nodeList.nodes : []
  return nodes.find(node => node?.nodeId === nodeId) ?? null
}

export function remoteNodeIds (nodeList) {
  const nodes = Array.isArray(nodeList?.nodes) ? nodeList.nodes : []
  return nodes.filter(node => node?.role === 'remote').map(node => node.nodeId).sort()
}

/**
 * Advertisement only. `availability` is the host's own projection
 * (crates/rovai-web/src/nodes.rs::list_nodes); it never proves a load or a call.
 */
export function runtimeAdvertisement (node, kinds = RUNTIME_KINDS) {
  const clis = Array.isArray(node?.clis) ? node.clis : []
  return kinds.map(kind => {
    const entry = clis.find(cli => cli?.adapterKind === kind) ?? null
    return {
      adapterKind: kind,
      verdict: entry === null ? 'MISSING' : 'ADVERTISED',
      pathPresent: entry?.pathPresent ?? false,
      availability: entry?.availability ?? null,
      version: entry?.version ?? null,
      evidenceKind: 'advertisement-only'
    }
  })
}

/**
 * The pairing claim needs a real, distinct node identity. A re-listed older
 * node is not a new pairing.
 */
export function pairingVerdict ({ nodeId, baselineRemoteNodeIds = [], nodeList }) {
  const node = nodeById(nodeList, nodeId)
  if (!node) return { status: 'FAIL', reason: 'node_not_listed', nodeId }
  const reasons = []
  if (node.role !== 'remote') reasons.push(`role_is_${node.role}`)
  if (node.status !== 'online') reasons.push(`status_is_${node.status}`)
  if (baselineRemoteNodeIds.includes(nodeId)) reasons.push('node_existed_before_pairing')
  return reasons.length === 0
    ? { status: 'PASS', reason: 'distinct_remote_node_online', nodeId, node }
    : { status: 'FAIL', reason: reasons.join('+'), nodeId, node }
}

/** A workspace record is only ours when the host bound it to the node we asked for. */
export function workspaceMatches ({ requested, returned }) {
  const reasons = []
  if (returned?.missionId !== requested.missionId) reasons.push('mission_mismatch')
  if (returned?.campId !== requested.campId) reasons.push('camp_mismatch')
  if (returned?.nodeId !== requested.nodeId) reasons.push('node_mismatch')
  if (typeof returned?.worktree !== 'string' || returned.worktree.length === 0) reasons.push('worktree_empty')
  if (typeof returned?.baseSha !== 'string' || returned.baseSha.length === 0) reasons.push('base_sha_empty')
  return reasons.length === 0
    ? { status: 'PASS', reasons, returned }
    : { status: 'FAIL', reasons, returned }
}

/**
 * Byte result of one `read`. `expectedSha256` must be produced independently on
 * the node; without it the byte identity is NOT_RUN, never assumed.
 */
export function checkReturnedBytes ({ bytes, truncated, archivedSize, expectedSha256, expectedSizeBytes }) {
  const sizeBytes = bytes.length
  const sha256 = sha256Hex(bytes)
  const reasons = []
  if (truncated === true) reasons.push('read_was_truncated')
  if (sizeBytes > MAX_READ_BYTES) reasons.push('over_read_cap')
  if (Number.isInteger(archivedSize) && archivedSize !== sizeBytes) reasons.push('size_field_mismatch')
  if (expectedSizeBytes !== undefined && expectedSizeBytes !== sizeBytes) reasons.push('expected_size_mismatch')
  if (expectedSha256 === undefined) {
    return {
      status: reasons.length === 0 ? 'NOT_RUN' : 'FAIL',
      reasons: reasons.length === 0 ? ['no_independent_ground_truth_on_node'] : reasons,
      sha256,
      sizeBytes
    }
  }
  if (sha256 !== expectedSha256) reasons.push('sha256_mismatch')
  return { status: reasons.length === 0 ? 'PASS' : 'FAIL', reasons, sha256, sizeBytes }
}

/** The offline negative: a stopped node must fail closed, never answer. */
export function classifyHostError (error) {
  const status = Number.isInteger(error?.status) ? error.status : 0
  const code = error?.code ?? 'unknown'
  return {
    code,
    status,
    nodeOffline: code === 'node_offline',
    loopbackRequired: code === 'node_channel_requires_loopback',
    unknownOutcome: status === 0 || status >= 500,
    remedy: code === 'node_channel_requires_loopback'
      ? 'the host must listen on loopback; reach it through a tunnel or a loopback listener'
      : code === 'node_offline'
        ? 'the node is not connected; start the same node again with its existing data root'
        : null
  }
}

/** Exactly one dispatch attempt, and an unknown outcome forbids a second one. */
export function execAttemptPolicy ({ attempts }) {
  if (attempts > 1) {
    throw new UsageError('no_retry', 'an exec dispatch is attempted once; an unknown outcome is never re-dispatched')
  }
  return { attempts, retryAllowed: false }
}

/* -------------------------------------------------------------------- plan */

const placeholder = name => `<${name}>`

/** The exact commands, with the flags verified against the current sources. */
export function planCommands (options) {
  const evidence = options.evidence
  const endpoint = options.endpoint
  const hostRoot = options.hostDataRoot ?? placeholder('host-data-root')
  const token = `--token-file ${hostRoot}/server-token`
  return [
    {
      side: 'host',
      title: '1. issue one pairing code and record the pre-pairing node list',
      command: `node scripts/accept-cross-device-node.mjs host-prepare --endpoint ${endpoint} ${token} --evidence ${evidence} --pair-code-out ${join(evidence, 'pair-code.secret')}`,
      notes: [
        'requires the host to listen on loopback (POST /api/v1/nodes/pair answers node_channel_requires_loopback otherwise)',
        'the code lands in pair-code.secret (0600) and is never printed or logged',
        `same CLI equivalent: rovai-server node-pair --data-dir ${hostRoot}`
      ]
    },
    {
      side: 'node',
      title: '2. pair the node once, then stop it (the credential persists)',
      command: `node scripts/accept-cross-device-node.mjs node-pair --node-bin ${options.nodeBin} --node-root ${options.nodeRoot} --server ${options.server} --pair-code-stdin --evidence ${evidence}`,
      notes: [
        'paste the code on stdin; it is never an argv value',
        `without a launcher: ${options.nodeBin} --data-dir ${options.nodeRoot} --server ${options.server} --pair-code-stdin`
      ]
    },
    {
      side: 'node',
      title: '3. serve the same node again with its persisted identity',
      command: `node scripts/accept-cross-device-node.mjs node-serve --node-bin ${options.nodeBin} --node-root ${options.nodeRoot} --server ${options.server}`,
      notes: ['keep this running for steps 4-5; Ctrl-C stops only this node']
    },
    {
      side: 'host',
      title: '4. verify the real remote identity and bind a fresh mission workspace',
      command: `node scripts/accept-cross-device-node.mjs workspace-prepare --endpoint ${endpoint} ${token} --mission ${placeholder('new-mission-id')} --camp ${placeholder('camp-id')} --source ${placeholder('git-repo-on-node')} --expect-node-id ${placeholder('nodeId-from-step-2')} --evidence ${evidence}`,
      notes: [
        'the mission id must be new: an existing mission workspace is returned unchanged',
        'a fresh synthetic id works (the existing b6 acceptance uses mission_b6/camp_b6); it stores a workspace record and does not create a Core Mission',
        `same CLI equivalent: rovai-server workspace-prepare --data-dir ${hostRoot} --mission ${placeholder('mission')} --camp ${placeholder('camp')} --node ${placeholder('nodeId')} --source ${placeholder('git-repo-on-node')}`
      ]
    },
    {
      side: 'host',
      title: '5. read real bytes back and compare against a hash computed on the node',
      command: `node scripts/accept-cross-device-node.mjs verify --endpoint ${endpoint} ${token} --phase online --mission ${placeholder('mission-id')} --probe-relative ${placeholder('path/in/worktree')} --expected-sha256 ${placeholder('sha256-printed-on-node')} --expect-node-id ${placeholder('nodeId-from-step-2')} --evidence ${evidence}`,
      notes: [
        'compute the ground truth on the node: sha256sum <worktree>/<path/in/worktree>',
        'a read above 1 MiB is truncated and never counts as a byte proof',
        'without --expected-sha256 the byte identity slice is NOT_RUN, never PASS',
        'add --require-runtime pi,codex-cli,deepseek-harness,claude-code-cli to turn a missing advertisement into a FAIL; otherwise every runtime is recorded ADVERTISED/MISSING only',
        `same CLI equivalent: rovai-server workspace-files --data-dir ${hostRoot} --mission ${placeholder('mission')} read ${placeholder('path/in/worktree')}`
      ]
    },
    {
      side: 'host',
      title: '6. stop node-serve, then prove the offline answer fails closed',
      command: `node scripts/accept-cross-device-node.mjs verify --endpoint ${endpoint} ${token} --phase offline --mission ${placeholder('mission-id')} --probe-relative ${placeholder('path/in/worktree')} --expect-node-id ${placeholder('nodeId-from-step-2')} --evidence ${evidence}`,
      notes: ['expects node_offline and no retry; every retry of a dispatch is refused by the script']
    },
    {
      side: 'host',
      title: '7. start node-serve again, then prove identity and bytes are unchanged',
      command: `node scripts/accept-cross-device-node.mjs verify --endpoint ${endpoint} ${token} --phase reconnect --mission ${placeholder('mission-id')} --probe-relative ${placeholder('path/in/worktree')} --expect-node-id ${placeholder('nodeId-from-step-2')} --evidence ${evidence}`,
      notes: ['compares the sha256 with the online phase and requires the same node id']
    },
    {
      side: 'host',
      title: '8. roll the run up from the evidence files',
      command: `node scripts/accept-cross-device-node.mjs status --evidence ${evidence}`,
      notes: ['exit 0 only when every required slice is PASS; exit 2 on any FAIL; exit 3 when a required slice is still NOT_RUN']
    }
  ]
}

export function formatPlan (options) {
  const lines = []
  for (const step of planCommands(options)) {
    lines.push(`[${step.side}] ${step.title}`)
    lines.push(`  ${step.command}`)
    for (const note of step.notes) lines.push(`  - ${note}`)
    lines.push('')
  }
  lines.push('never claimed by this plan: R2 archive receipt, loom_artifact, Runtime Loaded/Invoked, Owner Review')
  return lines.join('\n')
}

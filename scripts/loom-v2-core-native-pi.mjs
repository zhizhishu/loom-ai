// LOOM V2 E-native · 真实生产 Core → Delivery → AgentRun → PiHost 闭环（Windows 沙箱专用）。
//
// 诚实边界（绝不冒充）：
// - 二进制来自 Root 提供的 frozen artifact（默认 build-current/rovai-core.exe），本文件**只读校验**
//   path + lstat + sha256，从不运行 cargo，也不复制旧 resources/bin helper 冒充同源。
// - 模型侧只有本机 127.0.0.1 fake Provider（mockProvider=true / realExternalProvider=false）；
//   模型回复是 mock 执行事实，不是真实商业模型完成（modelReplyIsRealCompletion=false）。
// - nonce 只从**实际 tool 角色回执**解析回给模型；Provider 从不接收 expectedNonce，也不从闭包取值。
//   只使用 request.tools 里真实声明的只读工具；未声明则明确失败，不伪造工具调用。
// - OwnerReview 保持 pending：本文件绝不调用 loom.review.record / 任何 Review 写接口。
// - 不 SQL 手插任何业务表；未知模型结果不自动重试新 Run。
// - 不复制 ~/.pi、不读任何用户 secret 源；dummy key 只存在于 Core 子进程 env。

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

import {
  coreDataDirectoryArguments,
  runtimeCampFilesRootForDataDirectory
} from './lib/runtime-camp-files-root.mjs'
import { createConfiguredCampAndSend } from './lib/create-configured-camp.mjs'

const repository = resolve(import.meta.dirname, '..')

export const DEFAULT_CORE_BINARY = join(
  repository, '_artifacts', 'loom-v2-user-authorized-20261115', 'build-current', 'rovai-core.exe'
)
export const DEFAULT_CORE_SHA256 = '64d5e469b558e72bbf365ce7ede1f529195973fcec49943255566d61c509ee9d'
export const DEFAULT_EVIDENCE_ROOT = join(
  repository, '_artifacts', 'loom-v2-user-authorized-20261115', 'native-pi'
)
/** Fixed, already-verified Pi bundle. No PATH/other-CLI discovery is ever allowed to displace it. */
export const EMBEDDED_PI_ROOT = join(repository, 'resources', 'runtime', 'pi')
export const FAKE_KEY_ENV_NAME = 'LOOM_NATIVE_FAKE_KEY'
const DUMMY_KEY_VALUE = 'loom-native-fake-dummy-key'
export const NONCE_FILE_NAME = 'NONCE.txt'
export const NONCE_LINE_PREFIX = 'LOOM_NATIVE_PI_NONCE='
const NONCE_PATTERN = /LOOM_NATIVE_PI_NONCE=([0-9a-f]{32})/i

export const LOOPBACK_HOST = '127.0.0.1'
export const ALLOWED_CHAT_PATH = '/v1/chat/completions'
/** Root-provided same-source helper identity. Recorded, never used to claim compatibility. */
export const ROOT_PROVIDED_HELPER_SHA256 = '2554da544af0a069c7180c7053fbd6505fc1cc1864a86cc7afae011da2816102'
const DIAGNOSTIC_MESSAGE_LIMIT = 320
const DIAGNOSTIC_SCALAR_KEYS = Object.freeze([
  'phase', 'stage', 'status', 'readiness', 'state', 'level', 'outcome', 'code',
  'diagnosticCode', 'runtimeKind', 'adapterKind', 'attempt', 'attemptId',
  'probeStatus', 'authenticationStatus', 'installationClass', 'source', 'pathState',
  'hostInstanceId'
])

/** Diagnostics are summaries only: no headers, no model/message bodies, no env values. */
export function redactDiagnosticText(value) {
  return String(value ?? '')
    .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[redacted]')
    .replace(/(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .slice(0, DIAGNOSTIC_MESSAGE_LIMIT)
}

function summarizeNotification(event) {
  const params = event?.params && typeof event.params === 'object' ? event.params : {}
  const scalars = {}
  for (const key of DIAGNOSTIC_SCALAR_KEYS) {
    const value = params[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string') scalars[key] = redactDiagnosticText(value)
    else if (typeof value === 'number' || typeof value === 'boolean') scalars[key] = value
  }
  const messageText = typeof params.message === 'string'
    ? params.message
    : (typeof params.text === 'string' ? params.text : (typeof params.detail === 'string' ? params.detail : null))
  const message = messageText === null ? null : redactDiagnosticText(messageText)
  return { method: String(event?.method ?? ''), scalars, message }
}
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_REQUESTS = 32
const BODY_DEADLINE_MS = 30_000
const CLOSE_DEADLINE_MS = 5_000

const READY_BUDGET_MS = 120_000
const REQUEST_TIMEOUT_MS = 180_000
const RUN_BUDGET_MS = 300_000
/** Bounded fresh product checks. `deferred`/`superseded` is never a final answer. */
const MAX_FRESH_PRODUCT_CHECKS = 3
const PRODUCT_CHECK_RETRY_DELAY_MS = 750
const READINESS_POLL_BUDGET_MS = 45_000
const READINESS_POLL_INTERVAL_MS = 500
/** Core product semantics: these statuses mean "verified by the first real task", not failure. */
const PI_DEFERRED_PROBE_STATUSES = Object.freeze(['installed_unverified', 'light_ready'])
const PI_FAILED_PROBE_STATUSES = Object.freeze([
  'not_installed', 'probe_failed', 'light_failed', 'missing_capabilities', 'authentication_required'
])

/** Standing declarations this file may ever claim. */
export const EVIDENCE_ENVELOPE = Object.freeze({
  scope: 'native-core-pi-sandbox',
  mockProvider: true,
  realExternalProvider: false,
  realCommercialModel: false,
  userCredentialsUsed: false,
  modelReplyIsRealCompletion: false,
  coreHeldPiRun: true,
  piStartedByCore: true,
  ownerReviewRecorded: false,
  sqlBusinessRowsInserted: false,
  retriedRunOnUnknownResult: false
})

/** Only OS keys Core/Node genuinely need; every user API/OAuth/token key is refused. */
const INHERITED_ENV_ALLOWLIST = Object.freeze([
  'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'OS', 'USERNAME',
  'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'CommonProgramFiles', 'CommonProgramW6432'
])
const FORBIDDEN_ENV_PATTERN = /(API_?KEY|_TOKEN|TOKEN_|SECRET|PASSWORD|OAUTH|CREDENTIAL|AUTH_)/i

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Windows paths are case-insensitive; compare normalized, lower-cased prefixes. */
function contained(root, path) {
  const normalizedRoot = resolve(root).toLowerCase()
  const normalizedPath = resolve(path).toLowerCase()
  if (normalizedPath === normalizedRoot) return false
  const offset = relative(normalizedRoot, normalizedPath)
  return offset !== '' && offset !== '..' && !offset.startsWith(`..${sep}`)
}

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

// ---------------------------------------------------------------------------
// Binary honesty: read-only verification, never a build, never a silent substitute
// ---------------------------------------------------------------------------

export async function verifyCoreBinary({ coreBinaryPath = DEFAULT_CORE_BINARY, coreExpectedSha256 = DEFAULT_CORE_SHA256 } = {}) {
  const stats = await lstat(coreBinaryPath).catch(() => null)
  if (!stats || !stats.isFile() || stats.isSymbolicLink()) {
    throw Object.assign(
      new Error(`rovai-core is missing at ${coreBinaryPath}; this harness never builds and never substitutes a binary`),
      { code: 'BLOCKED_CORE_BINARY_MISSING' }
    )
  }
  const sha256 = sha256Of(await readFile(coreBinaryPath))
  if (coreExpectedSha256 && sha256 !== coreExpectedSha256) {
    throw Object.assign(
      new Error(`rovai-core sha256 mismatch at ${coreBinaryPath}: expected ${coreExpectedSha256}, got ${sha256}`),
      { code: 'BLOCKED_CORE_BINARY_SHA_MISMATCH' }
    )
  }
  return { path: coreBinaryPath, sha256, sizeBytes: stats.size, shaVerified: Boolean(coreExpectedSha256) }
}

/**
 * Core resolves its bundled Agent CLI as `<current_exe dir>/rovai.exe`. Root supplies a same-source
 * build; this harness never copies an old `resources/bin` helper and never claims compatibility.
 */
export async function resolveBuiltinToolHelper({ coreBinaryPath = DEFAULT_CORE_BINARY, builtinToolBinaryPath } = {}) {
  const candidates = []
  if (builtinToolBinaryPath) candidates.push({ path: builtinToolBinaryPath, source: 'explicit-parameter' })
  candidates.push({ path: join(dirname(coreBinaryPath), 'rovai.exe'), source: 'adjacent-to-core-binary' })
  for (const candidate of candidates) {
    const stats = await lstat(candidate.path).catch(() => null)
    if (stats?.isFile() && !stats.isSymbolicLink()) {
      return {
        ...candidate,
        sha256: sha256Of(await readFile(candidate.path)),
        sizeBytes: stats.size,
        // Same-source provenance is Root's manifest claim; this harness only records the hash.
        matchesRootProvidedHash: sha256Of(await readFile(candidate.path)) === ROOT_PROVIDED_HELPER_SHA256,
        compatibilityClaimed: false
      }
    }
  }
  throw Object.assign(
    new Error(
      'BLOCKED: Core dispatch requires a same-source rovai.exe beside the frozen Core binary'
        + ` (${join(dirname(coreBinaryPath), 'rovai.exe')}). Build it from the same source into that directory`
        + ' or pass builtinToolBinaryPath. This harness refuses to substitute an unrelated older helper.'
    ),
    { code: 'BLOCKED_BUILTIN_HELPER_MISSING', searched: candidates.map((entry) => entry.path) }
  )
}

// ---------------------------------------------------------------------------
// Fixed Pi bundle: every executable path comes from the real manifest, contained
// ---------------------------------------------------------------------------

/**
 * Resolve launcher/node strictly from the bundle manifest. Nothing is hardcoded, and a
 * manifest that points outside its root is refused instead of executed.
 */
export async function readPiBundleManifest(embeddedPiRoot = EMBEDDED_PI_ROOT) {
  const root = resolve(embeddedPiRoot)
  const manifestPath = join(root, 'pi-bundle.json')
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw Object.assign(new Error(`Pi bundle manifest is unreadable at ${manifestPath}: ${error?.message ?? error}`), {
      code: 'BLOCKED_PI_BUNDLE_MANIFEST'
    })
  }
  const relativeOf = (value, label) => {
    if (typeof value !== 'string' || value.length === 0) {
      throw Object.assign(new Error(`Pi bundle manifest is missing ${label}`), { code: 'BLOCKED_PI_BUNDLE_MANIFEST' })
    }
    const absolute = join(root, ...value.split('/'))
    if (!contained(root, absolute)) {
      throw Object.assign(new Error(`Pi bundle ${label} escapes its root: ${value}`), { code: 'BLOCKED_PI_BUNDLE_MANIFEST' })
    }
    return absolute
  }
  const launcher = relativeOf(manifest.launcher, 'launcher')
  const node = relativeOf(manifest.node, 'node')
  for (const [label, path] of [['launcher', launcher], ['node', node]]) {
    const stats = await lstat(path).catch(() => null)
    if (!stats?.isFile() || stats.isSymbolicLink()) {
      throw Object.assign(new Error(`Pi bundle ${label} is missing at ${path}`), { code: 'BLOCKED_PI_BUNDLE_BINARY_MISSING' })
    }
  }
  return {
    root,
    manifestPath,
    piVersion: typeof manifest.piVersion === 'string' ? manifest.piVersion : null,
    platform: typeof manifest.platform === 'string' ? manifest.platform : null,
    arch: typeof manifest.arch === 'string' ? manifest.arch : null,
    launcher,
    node,
    treeSha256: typeof manifest.treeSha256 === 'string' ? manifest.treeSha256 : null
  }
}

// ---------------------------------------------------------------------------
// Isolated environment: allowlisted OS keys only, every user root redirected
// ---------------------------------------------------------------------------

export function buildIsolatedEnv({
  fixtureRoot,
  agentDir,
  embeddedPiRoot = EMBEDDED_PI_ROOT,
  piNodePath = join(embeddedPiRoot, 'node', 'node.exe')
}) {
  const env = {}
  for (const key of INHERITED_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const systemRoot = env.SystemRoot ?? env.windir
  if (!systemRoot) throw new Error('Windows SystemRoot is unavailable; refusing to build a Core environment')
  const bundleNodeDirectory = dirname(piNodePath)
  Object.assign(env, {
    PATH: [`${join(systemRoot, 'System32')}`, systemRoot, bundleNodeDirectory].join(delimiter),
    HOME: join(fixtureRoot, 'home'),
    USERPROFILE: join(fixtureRoot, 'home'),
    APPDATA: join(fixtureRoot, 'home', 'AppData', 'Roaming'),
    LOCALAPPDATA: join(fixtureRoot, 'home', 'AppData', 'Local'),
    TMP: join(fixtureRoot, 'tmp'),
    TEMP: join(fixtureRoot, 'tmp'),
    TMPDIR: join(fixtureRoot, 'tmp'),
    XDG_CACHE_HOME: join(fixtureRoot, 'home', '.cache'),
    XDG_CONFIG_HOME: join(fixtureRoot, 'home', '.config'),
    XDG_DATA_HOME: join(fixtureRoot, 'home', '.local', 'share'),
    XDG_STATE_HOME: join(fixtureRoot, 'home', '.local', 'state'),
    PI_CODING_AGENT_DIR: agentDir,
    CODEX_HOME: join(fixtureRoot, 'home', '.codex'),
    CLAUDE_CONFIG_DIR: join(fixtureRoot, 'home', '.claude'),
    DSH_HOME: join(fixtureRoot, 'home', '.dsh'),
    ROVAI_EMBEDDED_PI_ROOT: resolve(embeddedPiRoot),
    PI_TELEMETRY: '0',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    [FAKE_KEY_ENV_NAME]: DUMMY_KEY_VALUE
  })
  for (const key of Object.keys(env)) {
    if (key === FAKE_KEY_ENV_NAME) continue
    if (FORBIDDEN_ENV_PATTERN.test(key)) {
      throw new Error(`refusing to pass a credential-shaped environment key into Core: ${key}`)
    }
  }
  return env
}

// ---------------------------------------------------------------------------
// Scripted loopback provider (127.0.0.1 only). Never receives the expected nonce.
// ---------------------------------------------------------------------------

function normalizeTextContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
      .join('')
  }
  return ''
}

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function splitText(text, pieces = 3) {
  const size = Math.max(1, Math.ceil(text.length / pieces))
  const chunks = []
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size))
  return chunks
}

/** Declared tool descriptors, read from the real request body only. */
function declaredTools(parsed) {
  const tools = Array.isArray(parsed.tools) ? parsed.tools : []
  return tools.map((tool) => {
    const fn = tool?.function && typeof tool.function === 'object' ? tool.function : tool
    const name = typeof fn?.name === 'string' ? fn.name : null
    const schema = fn?.parameters ?? fn?.input_schema ?? fn?.inputSchema ?? null
    const properties = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object'
      ? schema.properties
      : {}
    return { name, properties: Object.keys(properties) }
  })
}

/**
 * @param {{ nonceFilePath: string }} options
 */
export async function createFakeProvider({ nonceFilePath }) {
  if (typeof nonceFilePath !== 'string' || nonceFilePath.length === 0) {
    throw new Error('createFakeProvider requires the absolute nonce file path (never the nonce value)')
  }
  const state = { mode: 'short', closed: false }
  const requests = []
  const violations = []
  const sockets = new Set()
  let seq = 0

  const server = createServer((req, res) => {
    const remoteAddress = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '')
    const fail = (status, reason) => {
      violations.push({ seq: requests.length + 1, remoteAddress, method: req.method, path: String(req.url ?? '').split('?')[0], reason })
      res.writeHead(status, { connection: 'close' })
      res.end(JSON.stringify({ error: reason }))
    }
    if (state.closed) return fail(503, 'provider_closed')
    if (remoteAddress !== LOOPBACK_HOST) return fail(403, 'non_loopback_peer')
    if (req.method !== 'POST') return fail(405, 'method_not_allowed')
    if (String(req.url ?? '').split('?')[0] !== ALLOWED_CHAT_PATH) return fail(404, 'path_not_allowed')
    if (requests.length >= MAX_REQUESTS) return fail(503, 'request_quota_exceeded')

    const chunks = []
    let bytes = 0
    let aborted = false
    const deadline = setTimeout(() => {
      aborted = true
      fail(408, 'body_deadline_exceeded')
      req.destroy()
    }, BODY_DEADLINE_MS)
    req.on('data', (chunk) => {
      if (aborted) return
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        aborted = true
        clearTimeout(deadline)
        fail(413, 'body_quota_exceeded')
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => { aborted = true; clearTimeout(deadline) })
    req.on('end', () => {
      if (aborted) return
      clearTimeout(deadline)
      let parsed
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return fail(400, 'invalid_json')
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(400, 'invalid_body')

      seq += 1
      const messages = Array.isArray(parsed.messages) ? parsed.messages : []
      const tools = declaredTools(parsed)
      // Only the tool-role receipt is ever mined for the nonce; the value is never supplied to us.
      const toolReceiptText = messages
        .filter((message) => message?.role === 'tool')
        .map((message) => normalizeTextContent(message.content))
        .join('\n')
      const receiptMatch = toolReceiptText.match(NONCE_PATTERN)
      const systemPrompt = normalizeTextContent(messages.find((message) => message?.role === 'system')?.content)
      const userText = messages
        .filter((message) => message?.role === 'user')
        .map((message) => normalizeTextContent(message.content))
        .join('\n')

      const record = {
        seq,
        mode: state.mode,
        remoteAddress,
        model: typeof parsed.model === 'string' ? parsed.model : null,
        stream: parsed.stream === true,
        declaredToolNames: tools.map((tool) => tool.name).filter(Boolean),
        toolReceiptMessageCount: messages.filter((message) => message?.role === 'tool').length,
        toolReceiptHasNonce: Boolean(receiptMatch),
        userTextHasNonce: NONCE_PATTERN.test(userText),
        systemPromptSha256: sha256Of(systemPrompt),
        systemPromptBytes: Buffer.byteLength(systemPrompt, 'utf8'),
        authorizationIsDummyBearer: String(req.headers?.authorization ?? '') === `Bearer ${DUMMY_KEY_VALUE}`,
        bodyBytes: bytes,
        toolCallEmitted: false,
        toolCallArgumentName: null,
        replyKind: null
      }
      requests.push(record)

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive'
      })
      const base = {
        id: `chatcmpl-native-pi-${String(record.seq).padStart(4, '0')}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: record.model ?? 'loom-native-fake-model'
      }
      const finish = (text, label = text) => {
        // Only a label is recorded: an echoed nonce must never reach the evidence.
        record.replyKind = label
        for (const piece of splitText(text)) {
          res.write(sseFrame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: piece }, finish_reason: null }] }))
        }
        res.write(sseFrame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: text.length, total_tokens: 1 + text.length } }))
        res.write('data: [DONE]\n\n')
        res.end()
      }

      if (state.mode === 'read-nonce') {
        if (record.toolReceiptMessageCount > 0) {
          // Echo strictly what the native tool receipt contained; nothing is injected from this side.
          if (!receiptMatch) return finish('TOOL_RECEIPT_WITHOUT_NONCE')
          return finish(receiptMatch[1], 'nonce-echo-from-tool-receipt')
        }
        const readTool = tools.find((tool) => tool.name === 'read')
        if (!readTool) {
          // Honest failure: never fabricate a tool the runtime did not declare.
          return finish(`READ_TOOL_NOT_DECLARED:${tools.map((tool) => tool.name).filter(Boolean).join(',')}`)
        }
        const argumentName = readTool.properties.includes('path')
          ? 'path'
          : readTool.properties[0]
        if (!argumentName) return finish('READ_TOOL_HAS_NO_ARGUMENTS')
        record.toolCallEmitted = true
        record.toolCallArgumentName = argumentName
        record.replyKind = 'tool-call'
        const toolCallId = `call_native_pi_${record.seq}`
        const args = JSON.stringify({ [argumentName]: nonceFilePath })
        res.write(sseFrame({
          ...base,
          choices: [{
            index: 0,
            delta: { role: 'assistant', tool_calls: [{ index: 0, id: toolCallId, type: 'function', function: { name: readTool.name, arguments: args } }] },
            finish_reason: null
          }]
        }))
        res.write(sseFrame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } }))
        res.write('data: [DONE]\n\n')
        return res.end()
      }

      return finish('LOOM_NATIVE_PI_SHORT_OK')
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  if (!address || typeof address !== 'object' || address.address !== LOOPBACK_HOST || !Number.isInteger(address.port) || address.port <= 0) {
    try { server.close() } catch {}
    throw new Error(`fake provider did not bind ${LOOPBACK_HOST}:0: ${JSON.stringify(address)}`)
  }

  return {
    host: LOOPBACK_HOST,
    port: address.port,
    baseUrl: `http://${LOOPBACK_HOST}:${address.port}/v1`,
    requests,
    violations,
    setMode(mode) {
      if (!['short', 'read-nonce'].includes(mode)) throw new Error(`unknown provider mode: ${mode}`)
      state.mode = mode
    },
    /** Counts and enums only: never a header, a model list or a message body. */
    diagnosticsSnapshot() {
      return {
        host: LOOPBACK_HOST,
        port: address.port,
        requestCount: requests.length,
        violationCount: violations.length,
        violationReasons: violations.map((entry) => entry.reason),
        modes: requests.map((entry) => entry.mode),
        anyAuthorizationDummyBearer: requests.some((entry) => entry.authorizationIsDummyBearer),
        anyToolReceipt: requests.some((entry) => entry.toolReceiptMessageCount > 0),
        closed: state.closed
      }
    },
    async close() {
      const startedAt = Date.now()
      if (state.closed) return { closed: true, elapsedMs: 0 }
      state.closed = true
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      const closed = await new Promise((resolveClose) => {
        const timer = setTimeout(() => resolveClose(false), CLOSE_DEADLINE_MS)
        server.close(() => {
          clearTimeout(timer)
          resolveClose(true)
        })
      })
      if (!closed) {
        throw Object.assign(new Error('fake provider failed to close its listening socket in time'), {
          receipt: { closed: false, elapsedMs: Date.now() - startedAt }
        })
      }
      return { closed: true, elapsedMs: Date.now() - startedAt }
    }
  }
}

// ---------------------------------------------------------------------------
// Isolated Pi profile: models.json references an env var, no auth.json is written
// ---------------------------------------------------------------------------

export async function createIsolatedPiProfile({ agentDir, baseUrl }) {
  await mkdir(agentDir, { recursive: true })
  const models = {
    providers: {
      'loom-native-fake': {
        name: 'LOOM Native Pi Fake Provider',
        baseUrl,
        // Env reference only: the dummy value never lands in any file.
        apiKey: `$${FAKE_KEY_ENV_NAME}`,
        api: 'openai-completions',
        models: [{
          id: 'loom-native-fake-model',
          name: 'LOOM Native Fake (loopback)',
          reasoning: false,
          input: ['text'],
          contextWindow: 8192,
          maxTokens: 512
        }]
      }
    }
  }
  const settings = {
    defaultProvider: 'loom-native-fake',
    defaultModel: 'loom-native-fake-model'
  }
  const modelsPath = join(agentDir, 'models.json')
  const settingsPath = join(agentDir, 'settings.json')
  await writeFile(modelsPath, `${JSON.stringify(models, null, 2)}\n`, 'utf8')
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  // No auth.json: Pi must resolve the apiKey through the env reference or fail honestly.
  return { agentDir, modelsPath, settingsPath, apiKeyReference: `$${FAKE_KEY_ENV_NAME}`, authFileWritten: false }
}

// ---------------------------------------------------------------------------
// Core JSONL harness (string request ids, core_startup frames, bounded shutdown)
// ---------------------------------------------------------------------------

function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

function killProcessTree(child, budgetMs) {
  const pid = child.pid
  if (!pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
    return
  }
  const outcome = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: budgetMs
  })
  if (outcome.error || outcome.status !== 0) {
    throw Object.assign(
      new Error(`taskkill.exe /PID ${pid} /T /F failed (status=${outcome.status}): ${`${outcome.stderr ?? ''}${outcome.stdout ?? ''}`.trim()}`),
      { stage: 'taskkill', pid, status: outcome.status }
    )
  }
}

export function startIsolatedCore({ binaryPath, dataDir, skillRoot, mcpPath, env, cwd, readyBudgetMs = READY_BUDGET_MS }) {
  const args = [
    ...coreDataDirectoryArguments(dataDir, { homeDirectory: env.HOME }),
    '--skill-library-root', skillRoot,
    '--mcp-config-path', mcpPath
  ]
  const child = spawn(binaryPath, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const pending = new Map()
  const startupFrames = []
  const notifications = []
  const requestLog = []
  const diagnostics = []
  const notificationCounts = new Map()
  let nextId = 0
  let stderrTail = ''
  let stopped = false
  const readyStartedAt = Date.now()
  let readyAt = null
  let resolveReady
  let rejectReady
  const ready = new Promise((resolveOk, rejectErr) => { resolveReady = resolveOk; rejectReady = rejectErr })
  const startupTimer = setTimeout(() => {
    rejectReady(Object.assign(
      new Error(`Core ready timeout after ${Date.now() - readyStartedAt}ms (budget ${readyBudgetMs}ms); lastFrame=${JSON.stringify(startupFrames.at(-1) ?? null)}; stderrTail=${stderrTail}`),
      { stage: 'ready' }
    ))
  }, readyBudgetMs)

  const exitEvent = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })))
  async function waitForExit(ms) {
    if (child.exitCode !== null || child.signalCode !== null || !pidAlive(child.pid)) return true
    let timer
    try {
      return await Promise.race([
        exitEvent.then(() => true),
        new Promise((resolveWait) => { timer = setTimeout(() => resolveWait(false), ms) })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  child.stdin.on('error', () => {})
  child.stderr.on('data', (chunk) => { stderrTail = `${stderrTail}${chunk}`.slice(-8000) })
  child.once('error', (error) => {
    clearTimeout(startupTimer)
    rejectReady(error)
  })
  child.once('exit', (code) => {
    clearTimeout(startupTimer)
    const error = new Error(`Core exited before/while serving RPC (code=${code}): ${stderrTail}`)
    if (!stopped) rejectReady(error)
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  })

  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      stderrTail = `${stderrTail}\n[non-json stdout] ${trimmed.slice(0, 400)}`.slice(-8000)
      return
    }
    if (message?.kind === 'core_startup') {
      startupFrames.push(message)
      if (message.status === 'ready') {
        clearTimeout(startupTimer)
        readyAt = Date.now()
        resolveReady(message)
      } else if (message.status === 'blocked' || message.status === 'failed') {
        clearTimeout(startupTimer)
        rejectReady(Object.assign(new Error(`Core startup ${message.status}: ${JSON.stringify(message.authorityState ?? message.error ?? null)}`), { stage: 'ready' }))
      }
      return
    }
    if (message?.method) {
      notifications.push(message)
      const method = String(message.method)
      notificationCounts.set(method, (notificationCounts.get(method) ?? 0) + 1)
      // Core already redacts credentials; keep only scalars plus a bounded message summary.
      if (/^runtime\.|^provider\.|^agent_run\./.test(method)) {
        diagnostics.push({ at: new Date().toISOString(), ...summarizeNotification(message) })
        if (diagnostics.length > 200) diagnostics.splice(0, diagnostics.length - 200)
      }
      return
    }
    if (message?.id !== undefined && pending.has(message.id)) {
      const request = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) request.reject(Object.assign(new Error(message.error.message ?? 'core error'), { coreError: message.error }))
      else request.resolve(message.result)
    }
  })

  function request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = String(++nextId)
    const entry = { id, method, startedAt: new Date().toISOString(), elapsedMs: null, outcome: 'pending', code: null }
    requestLog.push(entry)
    const settle = (outcome, code = null) => {
      entry.outcome = outcome
      entry.code = code
      entry.elapsedMs = Date.now() - Date.parse(entry.startedAt)
      return entry.elapsedMs
    }
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        const elapsedMs = settle('timeout')
        rejectRequest(Object.assign(new Error(`${method} timed out after ${timeoutMs}ms (id=${id})`), {
          method, id, elapsedMs, stage: 'request'
        }))
      }, timeoutMs)
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); settle('ok'); resolveRequest(value) },
        reject: (error) => {
          clearTimeout(timer)
          settle('error', error?.coreError?.code ?? null)
          if (error && typeof error === 'object') Object.assign(error, { method, id })
          rejectRequest(error)
        }
      })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return
        clearTimeout(timer)
        pending.delete(id)
        const elapsedMs = settle('write-error')
        rejectRequest(Object.assign(error, { method, id, elapsedMs }))
      })
    })
  }

  return {
    pid: child.pid,
    args,
    ready,
    request,
    startupFrames,
    notifications,
    requestLog,
    diagnostics,
    stderrTail: () => stderrTail,
    /** Everything Core said that may explain a failed RPC, without env values or payload bodies. */
    diagnosticsSnapshot() {
      return {
        pid: child.pid,
        args,
        readyElapsedMs: readyAt === null ? null : readyAt - readyStartedAt,
        startupFrames: startupFrames.map((frame) => ({
          status: frame.status ?? null,
          phase: frame.phase ?? null,
          authorityState: frame.authorityState?.kind ?? null,
          errorCode: frame.error?.code ?? null
        })),
        notificationCounts: Object.fromEntries([...notificationCounts.entries()].sort()),
        diagnostics: diagnostics.slice(-80),
        // Last 12 RPC calls only: method, id, duration and outcome shape. Never params or results.
        rpcTail: requestLog.slice(-12).map((entry) => ({
          method: entry.method,
          id: entry.id,
          durationMs: entry.elapsedMs,
          shape: entry.outcome === 'ok' ? 'ok' : entry.outcome
        })),
        requestLog: requestLog.slice(-60),
        stderrTail: redactDiagnosticText(stderrTail.slice(-4_000))
      }
    },
    get readyElapsedMs() { return readyAt === null ? null : readyAt - readyStartedAt },
    async close() {
      const pid = child.pid
      const closeStartedAt = Date.now()
      let stage = 'stdin-end'
      const receipt = () => ({ pid, stage, elapsedMs: Date.now() - closeStartedAt, gone: !pidAlive(pid), exitCode: child.exitCode, signalCode: child.signalCode })
      if (stopped) return receipt()
      stopped = true
      clearTimeout(startupTimer)
      const budgetStart = Date.now()
      const remaining = () => Math.max(20_000 - (Date.now() - budgetStart), 0)
      if (!child.stdin.destroyed) child.stdin.end()
      if (await waitForExit(Math.min(remaining(), 5_000))) {
        lines.close()
        return receipt()
      }
      stage = 'sigterm'
      child.kill('SIGTERM')
      if (await waitForExit(Math.min(remaining(), 5_000))) {
        lines.close()
        return receipt()
      }
      stage = 'taskkill'
      killProcessTree(child, Math.max(remaining(), 1_000))
      const gone = await waitForExit(Math.max(remaining(), 1_000))
      lines.close()
      if (!gone) {
        throw Object.assign(new Error(`Core pid=${pid} did not exit; refusing to delete the fixture`), { stage: 'shutdown', pid, receipt: receipt() })
      }
      return receipt()
    }
  }
}

// ---------------------------------------------------------------------------
// Run-scoped helpers
// ---------------------------------------------------------------------------

function startedEventFor(core, agentRunId) {
  return core.notifications.find((event) => event.method === 'agent_run.started' && event.params?.agentRunId === agentRunId) ?? null
}

async function waitForRun(core, threadId, agentRunId) {
  const deadline = Date.now() + RUN_BUDGET_MS
  let lastRun = null
  while (Date.now() < deadline) {
    const snapshot = await core.request('threads.snapshot', { threadId })
    const approvals = snapshot.approvals ?? []
    if (approvals.length > 0) {
      throw new Error(`native Pi execution created unexpected approval state: ${JSON.stringify(approvals)}`)
    }
    lastRun = (snapshot.agentRuns ?? []).find((run) => run.id === agentRunId) ?? null
    if (lastRun && ['succeeded', 'failed', 'cancelled'].includes(lastRun.status)) {
      return { snapshot, run: lastRun }
    }
    await delay(250)
  }
  throw new Error(`timed out waiting for AgentRun ${agentRunId}: ${JSON.stringify(lastRun)}`)
}

function acceptedRun(result, fallbackThreadId = null) {
  const command = result?.commandResult ?? result
  const threadId = fallbackThreadId ?? command?.payload?.threadId
  const agentRunId = command?.payload?.agentRunIds?.[0]
  if (command?.status !== 'accepted' || !threadId || !agentRunId) {
    throw new Error(`Core did not accept the message as an AgentRun: ${JSON.stringify(result)}`)
  }
  return { threadId, agentRunId }
}

async function sendMessage(request, threadId, body, purpose) {
  return request('thread.messages.send', {
    commandId: randomUUID(),
    threadId,
    content: { version: 2, segments: [{ kind: 'text', text: body }] },
    sourceAttachments: [],
    quotes: [],
    replyToThreadMessageId: null,
    execution: { taskId: null, purpose, completionRole: 'required' }
  })
}

function messageForRun(snapshot, agentRunId) {
  return (snapshot.messages ?? []).find((message) => message.sourceAgentRunId === agentRunId) ?? null
}

/** Only whitelisted scalars ever leave Core's runtime/status payloads. */
function pickScalars(source, keys) {
  const out = {}
  if (!source || typeof source !== 'object') return out
  for (const key of keys) {
    const value = source[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string') out[key] = redactDiagnosticText(value)
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value
  }
  return out
}

const RUNTIME_STATUS_KEYS = Object.freeze([
  'kind', 'runtimeKind', 'adapterKind', 'discoveryStatus', 'probeStatus', 'authenticationStatus',
  'canLaunch', 'launchable', 'status', 'diagnosticCode', 'installationId', 'reportedVersion',
  'version', 'readiness', 'detail'
])

/** Tolerant, scalar-only extraction from `runtime.status.get`; never a profile or prompt body. */
export function summarizeRuntimeStatus(payload) {
  const top = payload && typeof payload === 'object' ? payload : {}
  const runtime = top.runtime && typeof top.runtime === 'object' ? top.runtime : top
  const entries = Array.isArray(runtime) ? runtime : Object.entries(runtime).map(([key, value]) => ({ key, value }))
  const piEntries = []
  for (const entry of entries) {
    const value = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry
    if (!value || typeof value !== 'object') continue
    const kind = value.runtimeKind ?? value.adapterKind ?? value.kind ?? (typeof entry?.key === 'string' ? entry.key : null)
    if (String(kind ?? '').toLowerCase() !== 'pi') continue
    piEntries.push(pickScalars(value, RUNTIME_STATUS_KEYS))
  }
  return {
    topLevelKeys: Object.keys(top).sort(),
    runtimeKeys: Object.keys(runtime).sort(),
    pi: piEntries
  }
}

/** Stable identity of a managed installation; used to explain a Superseded check. */
function installationIdentity(entry) {
  return entry ? {
    id: entry.id ?? null,
    generation: entry.generation ?? null,
    executableFingerprint: entry.snapshot?.executableFingerprint ?? null
  } : null
}

function installationProbeState(entry) {
  return entry ? {
    probeStatus: entry.snapshot?.probeStatus ?? null,
    authenticationStatus: entry.snapshot?.authenticationStatus ?? null,
    lastProbeAttemptStatus: entry.lastProbeAttempt?.status ?? null,
    lastProbeAttemptFailureClass: entry.lastProbeAttempt?.failureClass ?? null,
    lastProbeAttemptDiagnosticCode: entry.lastProbeAttempt?.diagnosticCode ?? null,
    lastAttemptedAt: entry.snapshot?.lastAttemptedAt ?? null
  } : null
}

/** Read-only sample of the managed Pi installation; never throws for a transient absence. */
async function sampleManagedPiEntry(core) {
  const installations = await core.request('runtime.installations.list')
  const all = Array.isArray(installations) ? installations : []
  return all.filter((entry) => entry.adapterKind === 'pi'
    && entry.installationClass === 'managed_default'
    && entry.authScope === 'default')[0] ?? null
}

/**
 * Bounded fresh product checks. `deferred` (= Superseded, application.rs:2207-2223) means a
 * concurrent check or an installation change won the update guard (application.rs:27640-27645,
 * 27708). It is never cached, never repeated as a config write, and never read as a probe failure.
 * Each attempt records the installation identity/probe delta that explains it.
 */
async function runBoundedFreshProductChecks(core, attempts) {
  let last = null
  for (let attempt = 1; attempt <= MAX_FRESH_PRODUCT_CHECKS; attempt += 1) {
    const before = await sampleManagedPiEntry(core)
    const startedAt = Date.now()
    const result = await core.request('runtime.product.check', { runtimeKind: 'pi' })
    const after = await sampleManagedPiEntry(core)
    const beforeIdentity = installationIdentity(before)
    const afterIdentity = installationIdentity(after)
    const entry = {
      attempt,
      elapsedMs: Date.now() - startedAt,
      outcome: typeof result?.outcome === 'string' ? result.outcome : null,
      status: typeof result?.status === 'string' ? result.status : null,
      ready: result?.ready === true,
      cached: false,
      installationBefore: beforeIdentity,
      installationAfter: afterIdentity,
      installationIdentityChanged: JSON.stringify(beforeIdentity) !== JSON.stringify(afterIdentity),
      probeStateBefore: installationProbeState(before),
      probeStateAfter: installationProbeState(after)
    }
    attempts.push(entry)
    last = result
    if (entry.outcome === 'ready' && entry.ready) return { result, final: true }
    if (entry.outcome === 'stable_failure') return { result, final: true }
    if (attempt < MAX_FRESH_PRODUCT_CHECKS) await delay(PRODUCT_CHECK_RETRY_DELAY_MS)
  }
  return { result: last, final: false }
}

function summarizeInstallation(installation) {
  return pickScalars({
    id: installation?.id ?? null,
    installationClass: installation?.installationClass ?? null,
    source: installation?.source ?? null,
    authScope: installation?.authScope ?? null,
    pathState: installation?.pathState ?? null,
    executablePath: installation?.executablePath ?? null,
    probeStatus: installation?.snapshot?.probeStatus ?? null,
    authenticationStatus: installation?.snapshot?.authenticationStatus ?? null,
    reportedVersion: installation?.snapshot?.reportedVersion ?? null,
    lastError: installation?.snapshot?.lastError ?? null
  }, ['id', 'installationClass', 'source', 'authScope', 'pathState', 'executablePath', 'probeStatus', 'authenticationStatus', 'reportedVersion', 'lastError'])
}

/** Exactly one managed Pi installation, or a precise refusal. */
async function resolveManagedPiInstallation(core) {
  const installations = await core.request('runtime.installations.list')
  const all = Array.isArray(installations) ? installations : []
  const pi = all.filter((entry) => entry.adapterKind === 'pi')
  const managed = pi.filter((entry) => entry.installationClass === 'managed_default' && entry.authScope === 'default')
  if (managed.length !== 1) {
    throw new Error(`expected exactly one managed Pi installation, found ${managed.length}: ${JSON.stringify(pi.map(summarizeInstallation))}`)
  }
  return { installation: managed[0], pi: pi.map(summarizeInstallation) }
}

// ---------------------------------------------------------------------------
// Evidence run
// ---------------------------------------------------------------------------

/**
 * Write the failure summary next to the fixture (evidenceRoot), never inside a live Core's data root.
 * Contains scalars, ids, timings and bounded redacted text only.
 */
async function writeFailureSummary({ evidenceRoot, fixtureRoot, failure, receipts }) {
  const error = failure.error ?? new Error('unknown failure')
  const summary = {
    schema: 'loom.native-core-pi.failure-summary.v1',
    recordedAt: new Date().toISOString(),
    evidenceRoot,
    fixtureRoot,
    error: {
      name: error.name ?? 'Error',
      code: error.code ?? error.coreError?.code ?? null,
      coreErrorKind: error.coreError?.kind ?? null,
      message: redactDiagnosticText(error.message ?? String(error)),
      failedMethod: error.method ?? failure.failedMethod ?? null,
      failedRequestId: error.id ?? null,
      failedRequestElapsedMs: error.elapsedMs ?? null,
      stage: error.stage ?? null
    },
    coreBinary: failure.binary ?? null,
    builtinToolHelper: failure.helper ?? null,
    envKeyNames: failure.envKeyNames ?? null,
    pathEntries: failure.pathEntries ?? null,
    productCheck: failure.productCheck ?? null,
    probeState: failure.probeState ?? null,
    core: failure.core ?? null,
    provider: failure.provider ?? null,
    cleanupReceipts: receipts
  }
  const jsonPath = join(evidenceRoot, 'failure-summary.json')
  const logPath = join(evidenceRoot, 'failure-summary.log')
  const json = `${JSON.stringify(summary, null, 2)}\n`
  const lines = [
    `recordedAt=${summary.recordedAt}`,
    `fixtureRoot=${fixtureRoot}`,
    `error.code=${summary.error.code} error.coreErrorKind=${summary.error.coreErrorKind}`,
    `error.failedMethod=${summary.error.failedMethod} failedRequestId=${summary.error.failedRequestId} elapsedMs=${summary.error.failedRequestElapsedMs}`,
    `error.message=${summary.error.message}`,
    `provider.requestCount=${failure.provider?.requestCount ?? 'unknown'}`,
    `provider.violationReasons=${JSON.stringify(failure.provider?.violationReasons ?? null)}`,
    `productCheck=${JSON.stringify(failure.productCheck ?? null)}`,
    `probeState=${JSON.stringify(failure.probeState ?? null)}`,
    `cleanup.core=${JSON.stringify(receipts.core ?? null)}`,
    `cleanup.provider=${JSON.stringify(receipts.provider ?? null)}`,
    '--- core.rpcTail (last 12, method/id/duration/shape) ---',
    ...(failure.core?.rpcTail ?? []).map((entry) => JSON.stringify(entry)),
    '--- core.startupFrames ---',
    ...(failure.core?.startupFrames ?? []).map((frame) => JSON.stringify(frame)),
    '--- core.notificationCounts ---',
    JSON.stringify(failure.core?.notificationCounts ?? null),
    '--- core.diagnostics (last 40) ---',
    ...(failure.core?.diagnostics ?? []).slice(-40).map((entry) => JSON.stringify(entry)),
    '--- core.requestLog (last 40) ---',
    ...(failure.core?.requestLog ?? []).slice(-40).map((entry) => JSON.stringify(entry)),
    '--- core.stderrTail (redacted) ---',
    failure.core?.stderrTail ?? ''
  ]
  await writeFile(jsonPath, json, 'utf8')
  await writeFile(logPath, `${lines.join('\n')}\n`, 'utf8')
  return { jsonPath, logPath }
}

/**
 * Drive the real production Core → Delivery → AgentRun → PiHost chain against a local fake provider.
 *
 * @param {object} [options]
 * @param {string} [options.coreBinaryPath] frozen Core binary (never built here)
 * @param {string|null} [options.coreExpectedSha256] expected sha256; pass null to record without matching
 * @param {string} [options.builtinToolBinaryPath] Root-provided same-source rovai.exe
 * @param {string} [options.embeddedPiRoot] fixed, already-verified Pi bundle root
 * @param {string} [options.evidenceRoot] project-owned parent for the fixture
 * @param {boolean} [options.keepFixture] keep the fixture for inspection
 * @param {boolean} [options.allowUnprovenToolChain] do not throw when native read evidence is incomplete
 * @param {number} [options.readyBudgetMs] Core ready budget
 */
export async function runCoreNativePiEvidence({
  coreBinaryPath = DEFAULT_CORE_BINARY,
  coreExpectedSha256 = DEFAULT_CORE_SHA256,
  builtinToolBinaryPath,
  embeddedPiRoot = EMBEDDED_PI_ROOT,
  evidenceRoot = DEFAULT_EVIDENCE_ROOT,
  keepFixture = process.env.LOOM_KEEP_NATIVE_PI_FIXTURE === '1',
  allowUnprovenToolChain = false,
  readyBudgetMs = READY_BUDGET_MS
} = {}) {
  if (process.platform !== 'win32') {
    throw new Error(`LOOM native Core→Pi integration is Windows-only; host is ${process.platform}`)
  }
  const binary = await verifyCoreBinary({ coreBinaryPath, coreExpectedSha256 })
  const helper = await resolveBuiltinToolHelper({ coreBinaryPath, builtinToolBinaryPath })
  // Launcher/node come from the real manifest, contained in the fixed bundle root.
  const piBundle = await readPiBundleManifest(embeddedPiRoot)

  await mkdir(evidenceRoot, { recursive: true })
  const runId = randomUUID()
  const fixtureRoot = join(evidenceRoot, `native-pi-${runId.slice(0, 8)}`)
  await mkdir(fixtureRoot, { recursive: true })
  for (const directory of ['home', 'tmp', 'bin', 'agent', 'project']) {
    await mkdir(join(fixtureRoot, directory), { recursive: true })
  }
  const runCore = join(fixtureRoot, 'bin', 'rovai-core.exe')
  const runHelper = join(fixtureRoot, 'bin', 'rovai.exe')
  await copyFile(binary.path, runCore)
  await copyFile(helper.path, runHelper)
  const agentDir = join(fixtureRoot, 'agent')
  const projectPath = join(fixtureRoot, 'project')

  const nonce = randomBytes(16).toString('hex')
  const nonceFilePath = join(projectPath, NONCE_FILE_NAME)
  await writeFile(nonceFilePath, `${NONCE_LINE_PREFIX}${nonce}\n`, 'utf8')

  const provider = await createFakeProvider({ nonceFilePath })
  let core = null
  let preserveFixture = false
  const cleanupErrors = []
  let failure = null
  let env = null
  const productCheck = {
    attempts: [],
    finalOutcome: null,
    finalReady: false,
    finalWasDeferred: false,
    installation: null
  }
  try {
    const profile = await createIsolatedPiProfile({ agentDir, baseUrl: provider.baseUrl })
    env = buildIsolatedEnv({
      fixtureRoot,
      agentDir,
      embeddedPiRoot: piBundle.root,
      piNodePath: piBundle.node
    })

    const dataDir = JSON.parse(
      execFileSync(runCore, ['--prepare-windows-data-root', join(fixtureRoot, 'formal')], {
        encoding: 'utf8',
        env
      })
    ).core
    // Captured after the protected data root exists: Core must add nothing else at fixture top level.
    const rootBefore = (await readdir(fixtureRoot)).sort()
    const skillRoot = join(dataDir, 'managed-skill-library')
    const mcpPath = join(dataDir, 'mcp.json')
    const runtimeFilesRoot = runtimeCampFilesRootForDataDirectory(dataDir, { homeDirectory: env.HOME })
    for (const [label, path] of [['data', dataDir], ['skills', skillRoot], ['mcp', mcpPath], ['runtimeFiles', runtimeFilesRoot]]) {
      if (!contained(fixtureRoot, path)) {
        throw new Error(`${label} root escaped the fixture: ${path}`)
      }
    }

    core = startIsolatedCore({
      binaryPath: runCore,
      dataDir,
      skillRoot,
      mcpPath,
      env,
      cwd: fixtureRoot,
      readyBudgetMs
    })
    await core.ready

    const workspace = await core.request('workspaces.inspect', { path: projectPath })
    const members = await core.request('members.list')
    const agent = members.find((profileEntry) => profileEntry.presence === 'present')
    if (!agent) throw new Error(`no present member profile: ${JSON.stringify(members)}`)

    // One bounded round of FRESH product checks. A `deferred` (= Superseded) answer means a
    // concurrent Core check won the update guard; it is never cached or reused as a result.
    const productCheckAttempts = []
    const check = await runBoundedFreshProductChecks(core, productCheckAttempts)
    productCheck.attempts = productCheckAttempts
    productCheck.finalOutcome = check.result?.outcome ?? null
    productCheck.finalReady = check.result?.ready === true
    productCheck.finalWasDeferred = !check.final

    const { installation, pi: piInstallations } = await resolveManagedPiInstallation(core)
    productCheck.installation = summarizeInstallation(installation)

    const snapshotBefore = installation.snapshot ?? null
    const executablePath = resolve(installation.executablePath)
    if (!contained(piBundle.root, executablePath)) {
      throw new Error(`Core did not use the fixed Pi bundle: ${installation.executablePath} (bundle ${piBundle.root})`)
    }
    if (executablePath.toLowerCase() !== resolve(piBundle.launcher).toLowerCase()) {
      throw new Error(`Core's Pi installation is not the manifest launcher: ${executablePath} vs ${piBundle.launcher}`)
    }

    // Exactly one member runtime write, with a stable command id: a replay can never add a second
    // write, and no readiness loop is allowed to rewrite the same Bot over and over.
    const defaults = installation.memberRuntimeDefaults
    if (!defaults || defaults.model === undefined || defaults.permissions === undefined) {
      throw new Error(`managed Pi installation exposes no memberRuntimeDefaults: ${JSON.stringify(summarizeInstallation(installation))}`)
    }
    const profileBefore = await core.request('members.get', { agentId: agent.agentId })
    const setRuntimeCommandId = `loom-native-pi:${runId}:members.runtime.set:pi:${agent.agentId}`
    const setResult = await core.request('members.runtime.set', {
      commandId: setRuntimeCommandId,
      command: {
        agentId: agent.agentId,
        expectedVersion: profileBefore.version,
        adapterKind: 'pi',
        model: defaults.model,
        permissions: defaults.permissions
      }
    })
    if (setResult?.status !== 'applied') {
      throw new Error(`members.runtime.set was not applied for the managed Pi runtime: ${JSON.stringify(setResult)}`)
    }

    // Everything after the single write is read-only observation.
    const profileAfter = await core.request('members.get', { agentId: agent.agentId })
    const runtimeStatus = summarizeRuntimeStatus(await core.request('runtime.status.get'))
    const installationAfter = (await core.request('runtime.installations.list'))
      .find((entry) => entry.id === installation.id) ?? null
    const finalSnapshot = installationAfter?.snapshot ?? snapshotBefore
    const probeStatus = finalSnapshot?.probeStatus ?? null
    const memberReadiness = profileAfter?.runtimeReadiness?.status ?? null
    const observation = {
      memberRuntimeAdapterKind: profileAfter?.runtimeConfiguration?.adapterKind ?? null,
      memberReadiness,
      probeStatus,
      authenticationStatus: finalSnapshot?.authenticationStatus ?? null,
      runtimeStatus,
      installationAfter: installationAfter ? summarizeInstallation(installationAfter) : null
    }

    // Core's own product semantics: `installed_unverified` / `light_ready` mean "verified by the
    // first real task" (application.rs:2867-2872, runtime_verification_deferred). The harness must
    // not demand `ready` up front, and must not force a status either.
    const requiredCapabilities = [
      'pi-jsonl-rpc-v1',
      'pi.rpc.host',
      'pi.rpc.managed_extension',
      'pi.rpc.get_state',
      'model.dynamic_catalog',
      'session.new'
    ]
    let probeDecision
    if (probeStatus === 'ready') {
      probeDecision = 'ready'
      if (!finalSnapshot.protocols?.includes('pi-jsonl-rpc-v1')
          || !finalSnapshot.models?.some((model) => model.id === 'pi://runtime-default' && model.isDefault)
          || !requiredCapabilities.every((capability) => finalSnapshot.capabilities?.includes(capability))
          || finalSnapshot.permissionOptions?.length !== 0
          || finalSnapshot.nativeSessionCompatibilityKey !== 'pi-jsonl-rpc-v1:managed-system-prompt-v1') {
        throw new Error(`Pi machine-ready snapshot is inconsistent: ${JSON.stringify({
          protocols: finalSnapshot.protocols,
          capabilities: finalSnapshot.capabilities,
          permissionOptions: finalSnapshot.permissionOptions,
          nativeSessionCompatibilityKey: finalSnapshot.nativeSessionCompatibilityKey
        })}`)
      }
    } else if (PI_DEFERRED_PROBE_STATUSES.includes(probeStatus)) {
      probeDecision = 'deferred-to-first-task'
    } else if (PI_FAILED_PROBE_STATUSES.includes(probeStatus)) {
      throw new Error(`Pi runtime is not launchable (probeStatus=${probeStatus}): ${JSON.stringify({
        observation,
        piInstallations
      })}`)
    } else if (probeStatus === null) {
      // No capability snapshot yet: Core's execution-time verification decides, nothing is forced.
      probeDecision = 'no-snapshot'
    } else {
      throw new Error(`Pi runtime reported an unrecognized probeStatus ${JSON.stringify(probeStatus)}: ${JSON.stringify({
        observation,
        piInstallations
      })}`)
    }

    // ---- Run 1: fixed short reply, no tool intent ----
    provider.setMode('short')
    const run1RequestsBefore = provider.requests.length
    const first = acceptedRun(await createConfiguredCampAndSend(core.request, {
      commandId: randomUUID(),
      workspace,
      body: 'Reply with exactly LOOM_NATIVE_PI_SHORT_OK and nothing else.',
      address: { mode: 'explicit', agentIds: [agent.agentId] },
      purpose: 'Native Core→PiHost short-reply delivery'
    }))
    const firstResult = await waitForRun(core, first.threadId, first.agentRunId)
    const firstMessage = messageForRun(firstResult.snapshot, first.agentRunId)
    const firstStart = startedEventFor(core, first.agentRunId)
    const firstProviderRequests = provider.requests.slice(run1RequestsBefore)
    if (firstResult.run.status !== 'succeeded'
        || !String(firstMessage?.body ?? '').includes('LOOM_NATIVE_PI_SHORT_OK')
        || !firstStart
        || firstProviderRequests.length === 0
        || firstProviderRequests.some((entry) => entry.userTextHasNonce)) {
      throw new Error(`native short-reply Run failed: ${JSON.stringify({
        run: firstResult.run,
        message: firstMessage?.body ?? null,
        start: firstStart?.params ?? null,
        providerRequests: firstProviderRequests
      })}`)
    }

    // ---- Run 2: the model must call the runtime's own read tool, and echo only what it received ----
    provider.setMode('read-nonce')
    const run2RequestsBefore = provider.requests.length
    const second = acceptedRun(
      await sendMessage(
        core.request,
        first.threadId,
        `Use the read tool exactly once to read the file at ${nonceFilePath}. Then reply with exactly the value that follows ${NONCE_LINE_PREFIX} in that file, and nothing else.`,
        'Native Core→PiHost tool delivery with a real read receipt'
      ),
      first.threadId
    )
    const secondResult = await waitForRun(core, first.threadId, second.agentRunId)
    const secondMessage = messageForRun(secondResult.snapshot, second.agentRunId)
    const secondStart = startedEventFor(core, second.agentRunId)
    const secondProviderRequests = provider.requests.slice(run2RequestsBefore)
    const toolCallRequest = secondProviderRequests.find((entry) => entry.toolCallEmitted) ?? null
    const toolReceiptRequest = secondProviderRequests.find((entry) => entry.toolReceiptMessageCount > 0) ?? null
    const readActions = (secondResult.snapshot.actions ?? []).filter((action) =>
      action.agentRunId === second.agentRunId
        && /read/i.test(String(action.toolName ?? action.tool ?? action.kind ?? ''))
    )
    // Durable tool evidence, read back from Core (never inferred from the fake reply).
    const evidencePage = await core
      .request('agentRunEvidence.list', { threadId: first.threadId, agentRunId: second.agentRunId, afterSequence: 0, limit: 1_000 })
      .catch(() => null)
    const readEvidence = (evidencePage?.evidence ?? []).filter((entry) => {
      const operation = entry.payload?.runtimeFileOperation
      return operation?.operationKind === 'read'
        || String(entry.canonical?.semanticKind ?? '').startsWith('file.')
    })
    const nonceEchoed = String(secondMessage?.body ?? '').includes(nonce)
    const nativeReadActionObserved = readActions.length > 0 || readEvidence.length > 0
    const toolChainProven = Boolean(toolCallRequest && toolReceiptRequest?.toolReceiptHasNonce && nonceEchoed && nativeReadActionObserved)

    const runs = [
      {
        index: 1,
        phase: 'short-reply',
        agentRunId: first.agentRunId,
        threadId: first.threadId,
        status: firstResult.run.status,
        hostInstanceId: firstStart?.params?.hostInstanceId ?? null,
        nativeThreadId: firstStart?.params?.nativeThreadId ?? null,
        nativeTurnId: firstStart?.params?.nativeTurnId ?? null,
        messageContainsMarker: String(firstMessage?.body ?? '').includes('LOOM_NATIVE_PI_SHORT_OK'),
        providerRequestCount: firstProviderRequests.length,
        providerModes: firstProviderRequests.map((entry) => entry.mode),
        toolCallEmitted: firstProviderRequests.some((entry) => entry.toolCallEmitted),
        actionCount: (firstResult.snapshot.actions ?? []).filter((action) => action.agentRunId === first.agentRunId).length
      },
      {
        index: 2,
        phase: 'native-read-nonce',
        agentRunId: second.agentRunId,
        threadId: second.threadId,
        status: secondResult.run.status,
        hostInstanceId: secondStart?.params?.hostInstanceId ?? null,
        nativeThreadId: secondStart?.params?.nativeThreadId ?? null,
        nativeTurnId: secondStart?.params?.nativeTurnId ?? null,
        distinctAgentRunId: second.agentRunId !== first.agentRunId,
        distinctNativeTurnId: Boolean(secondStart && firstStart)
          && secondStart.params?.nativeTurnId !== firstStart.params?.nativeTurnId,
        providerRequestCount: secondProviderRequests.length,
        declaredToolNames: secondProviderRequests.flatMap((entry) => entry.declaredToolNames),
        providerToolCallObserved: Boolean(toolCallRequest),
        providerToolCallArgumentName: toolCallRequest?.toolCallArgumentName ?? null,
        providerToolReceiptObserved: Boolean(toolReceiptRequest),
        providerToolReceiptHasNonce: Boolean(toolReceiptRequest?.toolReceiptHasNonce),
        userPromptContainedNonce: secondProviderRequests.some((entry) => entry.userTextHasNonce),
        nonceEchoedInMessage: nonceEchoed,
        nativeReadActionObserved,
        nativeReadActionStatuses: readActions.map((action) => action.status),
        nativeReadEvidenceCount: readEvidence.length,
        toolChainProven
      }
    ]

    if (secondResult.run.status !== 'succeeded'
        || !runs[1].distinctAgentRunId
        || runs[1].userPromptContainedNonce
        || !runs[1].providerToolCallObserved
        || !runs[1].providerToolReceiptHasNonce
        || !nonceEchoed) {
      throw new Error(`native read Run did not prove the tool chain: ${JSON.stringify({
        run: secondResult.run,
        message: secondMessage?.body ?? null,
        start: secondStart?.params ?? null,
        providerRequests: secondProviderRequests,
        readActions: readActions.map((action) => ({ id: action.id, toolName: action.toolName, status: action.status }))
      })}`)
    }
    if (!allowUnprovenToolChain && !toolChainProven) {
      throw new Error(`native read evidence is incomplete (toolChainProven=false): ${JSON.stringify(runs[1])}`)
    }

    const isolation = {
      fixtureRoot,
      dataRootInsideFixture: contained(fixtureRoot, dataDir),
      skillRootInsideDataRoot: contained(fixtureRoot, skillRoot),
      mcpConfigInsideDataRoot: contained(fixtureRoot, mcpPath),
      runtimeFilesRootInsideFixture: contained(fixtureRoot, runtimeFilesRoot),
      embeddedPiRoot: piBundle.root,
      coreExecutablePath: installation.executablePath,
      isolatedRoots: ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'PI_CODING_AGENT_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'DSH_HOME'],
      inheritedEnvKeys: Object.keys(env).filter((key) => INHERITED_ENV_ALLOWLIST.includes(key)).sort(),
      credentialShapedEnvKeys: Object.keys(env).filter((key) => FORBIDDEN_ENV_PATTERN.test(key) && key !== FAKE_KEY_ENV_NAME),
      pathEntries: String(env.PATH).split(delimiter),
      authFileWritten: profile.authFileWritten,
      apiKeyReferenceOnly: profile.apiKeyReference,
      dummyKeyOnlyInCoreEnv: true,
      userPiProfileRead: false,
      userDatabaseTouched: false,
      port64851Touched: false,
      globalMcpConfigTouched: false
    }

    // Captured while Core is still alive: the ready timing must never be reported after the fact.
    const coreStartup = {
      readyElapsedMs: core.readyElapsedMs,
      readySkipped: core.readyElapsedMs === null,
      startupFrameCount: core.startupFrames.length,
      lastStartupStatus: core.startupFrames.at(-1)?.status ?? null
    }

    await core.close()
    const coreGone = !pidAlive(core.pid)
    core = null
    if (!coreGone) throw new Error('Core process is still alive after bounded shutdown')
    const rootAfter = (await readdir(fixtureRoot)).sort()
    if (JSON.stringify(rootAfter) !== JSON.stringify(rootBefore)) {
      throw new Error(`fixture gained unexpected top-level entries: before=${JSON.stringify(rootBefore)} after=${JSON.stringify(rootAfter)}`)
    }

    const evidence = {
      ok: true,
      ...EVIDENCE_ENVELOPE,
      coreBinary: { ...binary, copySha256: sha256Of(await readFile(runCore)) },
      builtinToolHelper: { ...helper, copySha256: sha256Of(await readFile(runHelper)), compatibilityClaimed: false },
      coreStartup,
      productCheck: { ...productCheck, attempts: [...productCheck.attempts] },
      probeDecision,
      observation,
      memberRuntimeWrite: {
        count: 1,
        commandId: setRuntimeCommandId,
        appliedStatus: setResult.status ?? null,
        profileVersionBefore: profileBefore?.version ?? null,
        profileVersionAfter: profileAfter?.version ?? null
      },
      piBundle: {
        root: piBundle.root,
        manifestPath: piBundle.manifestPath,
        piVersion: piBundle.piVersion,
        platform: piBundle.platform,
        arch: piBundle.arch,
        launcher: piBundle.launcher,
        node: piBundle.node,
        treeSha256: piBundle.treeSha256,
        reportedVersion: finalSnapshot?.reportedVersion ?? null
      },
      capabilitySnapshot: {
        probeStatus: finalSnapshot?.probeStatus ?? null,
        protocols: finalSnapshot?.protocols ?? null,
        capabilities: finalSnapshot?.capabilities ?? null,
        nativeSessionCompatibilityKey: finalSnapshot?.nativeSessionCompatibilityKey ?? null,
        permissionOptionCount: finalSnapshot?.permissionOptions?.length ?? null
      },
      isolation,
      provider: {
        host: provider.host,
        port: provider.port,
        requestCount: provider.requests.length,
        violationCount: provider.violations.length,
        allRequestsLoopback: provider.requests.every((entry) => entry.remoteAddress === LOOPBACK_HOST),
        violationReasons: provider.violations.map((entry) => entry.reason),
        allAuthorizationDummyBearer: provider.requests.every((entry) => entry.authorizationIsDummyBearer),
        requestSummaries: provider.requests.map((entry) => ({
          seq: entry.seq,
          mode: entry.mode,
          model: entry.model,
          stream: entry.stream,
          declaredToolNames: entry.declaredToolNames,
          toolReceiptMessageCount: entry.toolReceiptMessageCount,
          toolReceiptHasNonce: entry.toolReceiptHasNonce,
          userTextHasNonce: entry.userTextHasNonce,
          systemPromptSha256: entry.systemPromptSha256,
          systemPromptBytes: entry.systemPromptBytes,
          authorizationIsDummyBearer: entry.authorizationIsDummyBearer,
          toolCallEmitted: entry.toolCallEmitted,
          toolCallArgumentName: entry.toolCallArgumentName,
          replyKind: entry.replyKind
        }))
      },
      runs,
      ownerReview: { recorded: false, pending: true, reviewsRecorded: 0 },
      nonce: {
        file: NONCE_FILE_NAME,
        generatedByFixture: true,
        promptNeverContainedNonce: !provider.requests.some((entry) => entry.userTextHasNonce),
        echoedFromToolReceiptOnly: true,
        nonceValueRecordedInEvidence: false
      }
    }
    const serialized = JSON.stringify(evidence)
    for (const forbidden of [DUMMY_KEY_VALUE, nonce, '"apiKey"', '"authorization"']) {
      if (serialized.includes(forbidden)) {
        throw new Error(`evidence must never carry a secret-shaped value: ${forbidden === nonce ? 'nonce' : forbidden}`)
      }
    }
    return evidence
  } catch (error) {
    // A failed run keeps its fixture: the on-disk state is the only evidence of what went wrong.
    preserveFixture = true
    // Best effort, bounded: what Core itself recorded about the Pi installation/probe at failure time.
    const probeState = core
      ? await core.request('runtime.installations.list', {}, 15_000).then(
        (installations) => (Array.isArray(installations) ? installations : [])
          .filter((entry) => entry.adapterKind === 'pi')
          .map((entry) => ({
            installationClass: entry.installationClass ?? null,
            source: entry.source ?? null,
            pathState: entry.pathState ?? null,
            executablePath: entry.executablePath ?? null,
            reportedVersion: entry.snapshot?.reportedVersion ?? null,
            probeStatus: entry.snapshot?.probeStatus ?? null,
            authenticationStatus: entry.snapshot?.authenticationStatus ?? null,
            lastError: entry.snapshot?.lastError ? redactDiagnosticText(entry.snapshot.lastError) : null,
            lastAttemptedAt: entry.snapshot?.lastAttemptedAt ?? null,
            lastSuccessfulProbeAt: entry.snapshot?.lastSuccessfulProbeAt ?? null,
            lastProbeAttempt: entry.lastProbeAttempt
              ? {
                  status: entry.lastProbeAttempt.status ?? null,
                  failureClass: entry.lastProbeAttempt.failureClass ?? null,
                  diagnosticCode: entry.lastProbeAttempt.diagnosticCode ?? null,
                  candidatePath: entry.lastProbeAttempt.candidatePath ?? null,
                  retryAfter: entry.lastProbeAttempt.retryAfter ?? null
                }
              : null
          })),
        (probeError) => ({ error: redactDiagnosticText(probeError?.message ?? probeError) })
      )
      : null
    failure = {
      error,
      binary,
      helper,
      envKeyNames: env ? Object.keys(env).sort() : null,
      pathEntries: env ? String(env.PATH).split(delimiter) : null,
      productCheck: { ...productCheck },
      probeState,
      core: core ? core.diagnosticsSnapshot() : null,
      provider: provider.diagnosticsSnapshot()
    }
    if (error && typeof error === 'object' && error.fixtureRoot === undefined) error.fixtureRoot = fixtureRoot
    throw error
  } finally {
    const receipts = { core: null, provider: null }
    if (core) {
      try {
        receipts.core = await core.close()
      } catch (error) {
        preserveFixture = true
        cleanupErrors.push(error)
        receipts.core = error?.receipt ?? { gone: false, error: redactDiagnosticText(error?.message ?? error) }
      }
    }
    try {
      receipts.provider = await provider.close()
    } catch (error) {
      cleanupErrors.push(error)
      receipts.provider = error?.receipt ?? { closed: false, error: redactDiagnosticText(error?.message ?? error) }
    }
    if (failure) {
      try {
        failure.summaryPaths = await writeFailureSummary({ evidenceRoot, fixtureRoot, failure, receipts })
        if (failure.error && typeof failure.error === 'object') failure.error.failureSummary = failure.summaryPaths
      } catch (writeError) {
        cleanupErrors.push(writeError)
        if (failure.error && typeof failure.error === 'object') {
          failure.error.failureSummaryWriteError = redactDiagnosticText(writeError?.message ?? writeError)
        }
      }
    }
    if (!preserveFixture && !keepFixture) {
      try {
        await rm(fixtureRoot, { recursive: true, force: true })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (cleanupErrors.length > 0) {
      throw Object.assign(new AggregateError(cleanupErrors, 'native Core→Pi teardown failed; refusing a green run'), {
        fixtureRoot,
        failureSummary: failure?.summaryPaths ?? null,
        cleanupReceipts: receipts
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Direct CLI: node scripts/loom-v2-core-native-pi.mjs [--core-binary p] [--core-sha256 h]
//            [--helper p] [--embedded-pi-root d] [--evidence-root d] [--keep]
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--keep') { options.keepFixture = true; continue }
    const next = argv[index + 1]
    if (argument === '--core-binary' && next) { options.coreBinaryPath = resolve(next); index += 1; continue }
    if (argument === '--core-sha256' && next) { options.coreExpectedSha256 = next; index += 1; continue }
    if (argument === '--helper' && next) { options.builtinToolBinaryPath = resolve(next); index += 1; continue }
    if (argument === '--embedded-pi-root' && next) { options.embeddedPiRoot = resolve(next); index += 1; continue }
    if (argument === '--evidence-root' && next) { options.evidenceRoot = resolve(next); index += 1; continue }
    if (argument === '--allow-unproven-tool-chain') { options.allowUnprovenToolChain = true; continue }
    throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  try {
    const evidence = await runCoreNativePiEvidence(parseCliArgs(process.argv.slice(2)))
    console.log(JSON.stringify(evidence, null, 2))
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      code: error?.code ?? error?.coreError?.code ?? null,
      message: error?.message ?? String(error),
      failedMethod: error?.method ?? null,
      failedRequestId: error?.id ?? null,
      failedRequestElapsedMs: error?.elapsedMs ?? null,
      fixtureRoot: error?.fixtureRoot ?? null,
      failureSummary: error?.failureSummary ?? null,
      cleanupReceipts: error?.cleanupReceipts ?? null
    }, null, 2))
    process.exitCode = 1
  }
}

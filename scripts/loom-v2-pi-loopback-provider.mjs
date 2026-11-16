// LOOM V2 P1-C · Pi Purge 真 Provider PromptSeen 闭环 — 本机 loopback 假 Provider + 真 Pi 0.85.1 RPC 驱动。
//
// Scope (docs/loom/LOOM-V2-P1B-ACCEPTANCE-HANDOFF-2026-11-15.md E4 gap, microplan approved by Root):
// - A strictly local, OpenAI-compatible ChatCompletion STREAMING SSE fake service bound ONLY to
//   127.0.0.1:0 (OS-assigned random port). No public interface, no real model, no real credential.
// - Requests: only POST /v1/chat/completions is answered; JSON body is size-capped; the fake
//   provider RECORDS ONLY the system prompt text and the tool schema — user/assistant message
//   bodies are never persisted.
// - Reply is a fixed assistant SSE stream: content delta chunks + finish_reason:"stop" + usage +
//   "data: [DONE]".
// - Real Pi 0.85.1 (resources/runtime/pi/pi.exe, unmodified bundle) is launched twice, each with a
//   completely separate temp PI_CODING_AGENT_DIR profile whose models.json points an
//   api:"openai-completions" provider at the loopback base URL with a dummy test apikey and model
//   id loom-mock-fake (reasoning:false, input:["text"], contextWindow:8192).
// - Launch flags: --mode rpc --offline --no-tools --no-session --no-context-files --no-skills
//   --no-themes --no-extensions --extension <private staged pi-purge.ts> --approve. The staged
//   extension path is verified BEFORE launch against the locked upstream identity
//   (git d0196ccfd773b0ed342bd2f25372aff65f1a4a53, pi-purge.ts sha256 983a3c3c…a65d71d) via the
//   existing read-only stager (scripts/loom-v2-pi-purge-stage.mjs, imported, never modified).
// - Scenario Off: get_commands / get_state, then one harmless user prompt → real agent_settled +
//   assistant reply; the fake provider records the system prompt hash it actually received.
// - Scenario Append: same but /purge mode append first, then /purge on, confirm extension notify,
//   then the harmless prompt; the received system prompt hash must differ from Off.
// - Evidence contract: { mockProvider:true, providerPromptSeen:true, realExternalProvider:false }
//   is only ever claimed for THIS loopback fake provider. Every recorded request must originate
//   from 127.0.0.1; proxy env vars are stripped from the Pi process env.
// - Everything tears down fail-closed: child processes are killed on timeout, the server socket is
//   force-closed, and teardown failures throw rather than pass.
// - This module never touches: the real user ~/.pi, any user database, the five pre-existing WIP
//   files, port 64851, Bero/GitHub, the Pi bundle sources, or the upstream extension source.

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PI_PURGE_SOURCE_LOCK, verifyStage } from './loom-v2-pi-purge-stage.mjs'

// ---------------------------------------------------------------------------
// Locked constants (fail closed on any drift)
// ---------------------------------------------------------------------------

export const LOOPBACK_HOST = '127.0.0.1'
export const ALLOWED_CHAT_PATH = '/v1/chat/completions'
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024
export const DEFAULT_MAX_REQUESTS = 64
export const DUMMY_API_KEY = 'loom-loopback-dummy-key'
export const LOOPBACK_PROVIDER_ID = 'loopback'
export const MOCK_MODEL_ID = 'loom-mock-fake'
export const MOCK_MODEL_CONTEXT_WINDOW = 8192
export const MOCK_ASSISTANT_REPLY =
  'LOOM loopback mock reply: this text came from the local fake provider, not a real model.'

// Locked upstream identity (must equal scripts/loom-v2-pi-purge-stage.mjs PI_PURGE_SOURCE_LOCK).
export const PI_PURGE_COMMIT = 'd0196ccfd773b0ed342bd2f25372aff65f1a4a53'
export const PI_PURGE_EXTENSION_SHA256 =
  '983a3c3cc3011928a33805d84414060729fd2aa81822bc7ba94008943a65d71d'
export const PI_PURGE_STAGE_DIRNAME = 'pi-purge-stage-v030'
export const PI_BUNDLE_LOCKED_VERSION = '0.85.1'

// Timeouts — every wait is bounded; on expiry we fail closed.
export const READY_TIMEOUT_MS = 120_000
export const COMMAND_TIMEOUT_MS = 60_000
export const PROMPT_TIMEOUT_MS = 240_000
export const NOTIFY_TIMEOUT_MS = 20_000
export const STOP_GRACE_MS = 8_000
export const STOP_KILL_MS = 5_000
export const CLOSE_SERVER_TIMEOUT_MS = 5_000

export const PI_LAUNCH_FLAGS = Object.freeze([
  '--mode', 'rpc',
  '--offline',
  '--no-tools',
  '--no-session',
  '--no-context-files',
  '--no-skills',
  '--no-themes',
  '--no-extensions'
])

// ---------------------------------------------------------------------------
// Loopback fake provider (node:http, 127.0.0.1:0 only)
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

function splitReply(text, pieces = 3) {
  const size = Math.max(1, Math.ceil(text.length / pieces))
  const chunks = []
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size))
  return chunks
}

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export async function createLoopbackProvider({
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  maxRequests = DEFAULT_MAX_REQUESTS,
  assistantReply = MOCK_ASSISTANT_REPLY
} = {}) {
  const requests = []
  const violations = []
  const sockets = new Set()
  let closed = false
  let seq = 0

  const server = createServer((req, res) => {
    const remoteAddress = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '')
    const failRequest = (status, reason) => {
      violations.push({ seq: requests.length, remoteAddress, url: req.url, method: req.method, reason })
      res.writeHead(status, { connection: 'close' })
      res.end(JSON.stringify({ error: reason }))
    }
    if (closed) {
      failRequest(503, 'provider_closed')
      return
    }
    if (remoteAddress !== LOOPBACK_HOST) {
      failRequest(403, 'non_loopback_peer')
      return
    }
    if (req.method !== 'POST') {
      failRequest(405, 'method_not_allowed')
      return
    }
    const pathOnly = String(req.url ?? '').split('?')[0]
    if (pathOnly !== ALLOWED_CHAT_PATH) {
      failRequest(404, 'path_not_allowed')
      return
    }
    if (requests.length >= maxRequests) {
      failRequest(503, 'request_quota_exceeded')
      return
    }

    const body = []
    let bodyBytes = 0
    let aborted = false
    req.on('data', (chunk) => {
      if (aborted) return
      bodyBytes += chunk.length
      if (bodyBytes > maxBodyBytes) {
        aborted = true
        failRequest(413, 'body_quota_exceeded')
        req.destroy()
        return
      }
      body.push(chunk)
    })
    req.on('error', () => {
      aborted = true
    })
    req.on('end', () => {
      if (aborted) return
      let parsed
      try {
        parsed = JSON.parse(Buffer.concat(body).toString('utf8'))
      } catch {
        failRequest(400, 'invalid_json')
        return
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        failRequest(400, 'invalid_body')
        return
      }
      seq += 1
      const record = {
        seq,
        path: pathOnly,
        remoteAddress,
        bodyBytes,
        model: typeof parsed.model === 'string' ? parsed.model : null,
        stream: parsed.stream === true,
        // Evidence ceiling: only the system prompt text and the tool schema are recorded.
        // User and assistant message bodies are intentionally NOT persisted.
        systemPrompt: normalizeTextContent(parsed.messages?.find((m) => m?.role === 'system')?.content),
        toolsSchema: Array.isArray(parsed.tools) ? parsed.tools : null,
        userMessageRoleCount: Array.isArray(parsed.messages)
          ? parsed.messages.filter((m) => m?.role === 'user').length
          : 0,
        authorizationIsDummyBearer:
          String(req.headers?.authorization ?? '') === `Bearer ${DUMMY_API_KEY}`
      }
      record.systemPromptSha256 = sha256Hex(record.systemPrompt)
      requests.push(record)

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive'
      })
      const id = `chatcmpl-loopback-${String(record.seq).padStart(4, '0')}`
      const created = Math.floor(Date.now() / 1000)
      const base = { id, object: 'chat.completion.chunk', created, model: record.model ?? MOCK_MODEL_ID }
      for (const piece of splitReply(assistantReply)) {
        res.write(sseFrame({
          ...base,
          choices: [{ index: 0, delta: { role: 'assistant', content: piece }, finish_reason: null }]
        }))
      }
      res.write(sseFrame({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: Math.max(1, Math.ceil(record.bodyBytes / 4)),
          completion_tokens: assistantReply.length,
          total_tokens: Math.max(1, Math.ceil(record.bodyBytes / 4)) + assistantReply.length
        }
      }))
      res.write('data: [DONE]\n\n')
      res.end()
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
  if (!address || typeof address !== 'object' || address.address !== LOOPBACK_HOST
      || !Number.isInteger(address.port) || address.port <= 0) {
    try { server.close() } catch {}
    throw new Error(`loopback provider did not bind ${LOOPBACK_HOST}:0 as expected: ${JSON.stringify(address)}`)
  }

  const close = async () => {
    if (closed) return
    closed = true
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    const didClose = await new Promise((resolveClose) => {
      const timer = setTimeout(() => resolveClose(false), CLOSE_SERVER_TIMEOUT_MS)
      server.close(() => {
        clearTimeout(timer)
        resolveClose(true)
      })
    })
    if (!didClose) throw new Error('loopback provider failed to close its listening socket in time')
  }

  return {
    host: LOOPBACK_HOST,
    port: address.port,
    baseUrl: `http://${LOOPBACK_HOST}:${address.port}/v1`,
    requests,
    violations,
    sha256Hex,
    close
  }
}

// ---------------------------------------------------------------------------
// Isolated temp Pi profile (models.json / settings.json / auth.json)
// ---------------------------------------------------------------------------

export async function createIsolatedPiProfile({ parentDir, port, name = 'pi-agent' }) {
  if (!parentDir || !Number.isInteger(port) || port <= 0 || !name || /[\\/]/.test(name)) {
    throw new Error('createIsolatedPiProfile requires a parentDir, a concrete loopback port and a plain profile name')
  }
  const agentDir = join(parentDir, name)
  const projectDir = join(parentDir, 'project')
  await mkdir(agentDir, { recursive: true })
  await mkdir(projectDir, { recursive: true })
  const baseUrl = `http://${LOOPBACK_HOST}:${port}/v1`
  const models = {
    providers: {
      [LOOPBACK_PROVIDER_ID]: {
        name: 'LOOM Loopback Mock Provider',
        baseUrl,
        apiKey: DUMMY_API_KEY,
        api: 'openai-completions',
        models: [
          {
            id: MOCK_MODEL_ID,
            name: 'LOOM Mock Fake (loopback)',
            reasoning: false,
            input: ['text'],
            contextWindow: MOCK_MODEL_CONTEXT_WINDOW,
            maxTokens: 512
          }
        ]
      }
    }
  }
  const settings = {
    defaultProvider: LOOPBACK_PROVIDER_ID,
    defaultModel: MOCK_MODEL_ID
  }
  const auth = {
    [LOOPBACK_PROVIDER_ID]: { type: 'api_key', key: DUMMY_API_KEY }
  }
  const modelsPath = join(agentDir, 'models.json')
  const settingsPath = join(agentDir, 'settings.json')
  const authPath = join(agentDir, 'auth.json')
  await writeFile(modelsPath, `${JSON.stringify(models, null, 2)}\n`, 'utf8')
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, 'utf8')
  return { agentDir, projectDir, modelsPath, settingsPath, authPath, baseUrl }
}

// ---------------------------------------------------------------------------
// Locked environment resolution (pi.exe + staged extension), all read-only
// ---------------------------------------------------------------------------

export function defaultP1bSandboxRoot() {
  return process.env.LOOM_P1B_SANDBOX?.trim()
    ? resolve(process.env.LOOM_P1B_SANDBOX.trim())
    : resolve(import.meta.dirname, '..', '..', '_artifacts', 'loom-v2-20261115', 'p1b-sandbox')
}

export function defaultStagedExtensionPath() {
  return join(defaultP1bSandboxRoot(), PI_PURGE_STAGE_DIRNAME, 'extensions', 'pi-purge.ts')
}

export function defaultPiBin() {
  if (process.platform !== 'win32') {
    throw new Error(`the pinned Pi bundle is windows-x64 pi.exe; refusing to guess a substitute on ${process.platform}`)
  }
  return resolve(import.meta.dirname, '..', 'resources', 'runtime', 'pi', 'pi.exe')
}

/** Read-only verification of the pinned bundle identity next to pi.exe. */
export async function assertPinnedPiBundle(piBin) {
  let bundle
  try {
    bundle = JSON.parse(await readFile(join(piBin, '..', 'pi-bundle.json'), 'utf8'))
  } catch (error) {
    throw new Error(`pinned Pi bundle identity unreadable at ${join(piBin, '..', 'pi-bundle.json')}: ${error.message}`)
  }
  if (bundle.piVersion !== PI_BUNDLE_LOCKED_VERSION || bundle.launcher !== 'pi.exe') {
    throw new Error(`pinned Pi bundle drift: piVersion=${String(bundle.piVersion)} launcher=${String(bundle.launcher)}`)
  }
  return { piVersion: bundle.piVersion, launcher: bundle.launcher }
}

/**
 * Verify the private staged pi-purge tree against the locked upstream identity.
 * Delegates recomputation to the existing read-only stager (verifyStage) and additionally
 * asserts the pinned commit and the pinned pi-purge.ts byte sha256. Never executes upstream code.
 */
export function assertStagedPiPurge(stageDir) {
  const verified = verifyStage({ outputDir: stageDir })
  if (!verified.ok || verified.sourceCommit !== PI_PURGE_SOURCE_LOCK.sourceCommit || verified.sourceCommit !== PI_PURGE_COMMIT) {
    throw new Error(`staged pi-purge commit drift: ${String(verified.sourceCommit)}`)
  }
  const extension = verified.files.find((file) => file.path === PI_PURGE_SOURCE_LOCK.entry)
  if (!extension || extension.sha256 !== PI_PURGE_EXTENSION_SHA256) {
    throw new Error(`staged pi-purge.ts sha256 drift: ${String(extension?.sha256)}`)
  }
  return {
    commit: verified.sourceCommit,
    extensionSha256: extension.sha256,
    treeSha256: verified.treeSha256,
    extensionPath: join(stageDir, ...PI_PURGE_SOURCE_LOCK.entry.split('/'))
  }
}

// ---------------------------------------------------------------------------
// Real Pi 0.85.1 RPC host (JSONL stdin/stdout), fail-closed lifecycle
// ---------------------------------------------------------------------------

export function buildIsolatedPiEnv({ profileAgentDir }) {
  const env = { ...process.env }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    delete env[key]
  }
  env.NO_PROXY = '127.0.0.1,localhost'
  env.no_proxy = '127.0.0.1,localhost'
  env.PI_CODING_AGENT_DIR = profileAgentDir
  return env
}

export function buildPiLaunchArgs({ extensionPath }) {
  if (!extensionPath) throw new Error('buildPiLaunchArgs requires the staged extensionPath')
  return [...PI_LAUNCH_FLAGS, '--extension', extensionPath, '--approve']
}

export class PiRpcHost {
  #proc = null
  #events = []
  #stderr = []
  #pending = new Map()
  #nextId = 1
  #lines = null
  #stopped = false
  #eventLimit = 6000
  #stderrLimit = 600

  constructor({ piBin, args, cwd, env, requestTimeoutMs = COMMAND_TIMEOUT_MS } = {}) {
    if (!piBin || !Array.isArray(args) || !cwd || !env) {
      throw new Error('PiRpcHost requires piBin, args, cwd and env')
    }
    this.piBin = piBin
    this.args = args
    this.cwd = cwd
    this.env = env
    this.requestTimeoutMs = requestTimeoutMs
  }

  get events() { return this.#events }
  get stderr() { return this.#stderr }
  get pid() { return this.#proc?.pid ?? null }

  start() {
    if (this.#proc) throw new Error('PiRpcHost already started')
    this.#proc = spawn(this.piBin, this.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
      windowsHide: true
    })
    const failPending = (error) => {
      for (const request of this.#pending.values()) {
        clearTimeout(request.timer)
        request.reject(error)
      }
      this.#pending.clear()
    }
    this.#proc.once('error', failPending)
    this.#proc.once('close', (code, signal) => {
      if (!this.#stopped) {
        failPending(new Error(`pi rpc host exited early (code=${code}, signal=${signal}); stderr tail: ${this.stderrTail()}`))
      }
    })
    this.#proc.stderr.on('data', (chunk) => {
      this.#stderr.push(String(chunk))
      if (this.#stderr.length > this.#stderrLimit) this.#stderr.splice(0, this.#stderr.length - this.#stderrLimit)
    })
    this.#lines = createInterface({ input: this.#proc.stdout })
    this.#lines.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let message
      try {
        message = JSON.parse(trimmed)
      } catch {
        this.#stderr.push(`[non-json stdout] ${trimmed}`)
        return
      }
      if (!message || typeof message !== 'object') return
      if (message.type === 'response' && Number.isInteger(message.id)) {
        const request = this.#pending.get(message.id)
        if (!request) return
        clearTimeout(request.timer)
        this.#pending.delete(message.id)
        if (message.success === false) {
          request.reject(new Error(`pi rpc ${request.command} failed: ${String(message.error ?? 'unknown error')}`))
        } else {
          request.resolve(message.data)
        }
        return
      }
      if (typeof message.type === 'string') {
        this.#events.push(message)
        if (this.#events.length > this.#eventLimit) this.#events.splice(0, this.#events.length - this.#eventLimit)
      }
    })
  }

  stderrTail(lines = 12) {
    return this.#stderr.slice(-lines).join(' | ').slice(0, 4000)
  }

  request(command, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.#proc || this.#proc.exitCode !== null) {
      return Promise.reject(new Error(`pi rpc host not running; cannot send ${String(command?.type)}`))
    }
    const id = this.#nextId++
    const type = command?.type
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        rejectRequest(new Error(`timed out after ${timeoutMs}ms waiting for pi rpc response: ${String(type)}; stderr tail: ${this.stderrTail()}`))
      }, timeoutMs)
      this.#pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
        command: String(type)
      })
      this.#proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return
        clearTimeout(timer)
        this.#pending.delete(id)
        rejectRequest(error)
      })
    })
  }

  /** Index-based event wait so repeated waits never see stale events. */
  waitForEvent(type, { timeoutMs = PROMPT_TIMEOUT_MS, predicate = null, sinceIndex = 0 } = {}) {
    const deadline = Date.now() + timeoutMs
    return new Promise((resolveWait, rejectWait) => {
      const poll = () => {
        for (let index = Math.max(sinceIndex, 0); index < this.#events.length; index += 1) {
          const event = this.#events[index]
          if (event.type === type && (!predicate || predicate(event))) {
            resolveWait({ event, index })
            return
          }
        }
        if (Date.now() > deadline) {
          rejectWait(new Error(`timed out after ${timeoutMs}ms waiting for pi rpc event ${String(type)}; stderr tail: ${this.stderrTail()}`))
          return
        }
        setTimeout(poll, 50)
      }
      poll()
    })
  }

  async stop({ graceMs = STOP_GRACE_MS, killMs = STOP_KILL_MS } = {}) {
    const proc = this.#proc
    if (!proc || this.#stopped) return { exited: true, forced: false }
    this.#stopped = true
    const closed = new Promise((resolveClose) => proc.once('close', () => resolveClose(true)))
    try { proc.stdin.end() } catch {}
    let exited = await Promise.race([closed, new Promise((done) => setTimeout(() => done(false), graceMs))])
    if (!exited && proc.exitCode === null) {
      try { proc.kill() } catch {}
      exited = await Promise.race([closed, new Promise((done) => setTimeout(() => done(false), killMs))])
    }
    if (!exited && proc.exitCode === null) {
      throw new Error(`pi rpc host pid ${proc.pid} refused to exit; failing closed`)
    }
    this.#lines?.close()
    return { exited: true, forced: proc.exitCode === null && proc.signalCode !== null }
  }
}

// ---------------------------------------------------------------------------
// Scenario runner: Off / Append against the loopback fake provider
// ---------------------------------------------------------------------------

function extractAssistantReply(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      return normalizeTextContent(event.message.content)
    }
  }
  return null
}

function collectNotifyMessages(events, sinceIndex) {
  const messages = []
  for (let index = sinceIndex; index < events.length; index += 1) {
    const event = events[index]
    if (event.type === 'extension_ui_request' && event.method === 'notify') {
      messages.push({ message: String(event.message ?? ''), notifyType: event.notifyType ?? null })
    }
  }
  return messages
}

async function runPurgeCommand(host, commandText) {
  const notifyIndexBefore = host.events.length
  await host.request({ type: 'prompt', message: commandText }, { timeoutMs: COMMAND_TIMEOUT_MS })
  const deadline = Date.now() + NOTIFY_TIMEOUT_MS
  for (;;) {
    const notify = collectNotifyMessages(host.events, notifyIndexBefore)
    if (notify.length > 0) return notify
    if (Date.now() > deadline) {
      throw new Error(`no extension notify observed after ${commandText}; events tail: ${JSON.stringify(host.events.slice(-10))}`)
    }
    await new Promise((done) => setTimeout(done, 50))
  }
}

export async function runPiLoopbackScenario({
  piBin,
  extensionPath,
  profile,
  provider,
  mode,
  prompt,
  requestTimeoutMs = COMMAND_TIMEOUT_MS,
  promptTimeoutMs = PROMPT_TIMEOUT_MS
}) {
  const host = new PiRpcHost({
    piBin,
    args: buildPiLaunchArgs({ extensionPath }),
    cwd: profile.projectDir,
    env: buildIsolatedPiEnv({ profileAgentDir: profile.agentDir }),
    requestTimeoutMs
  })
  host.start()
  try {
    const commands = await host.request({ type: 'get_commands' })
    const commandList = Array.isArray(commands?.commands) ? commands.commands : []
    const purge = commandList.find((command) => command?.name === 'purge' && command?.source === 'extension')
    if (!purge) {
      throw new Error(`staged pi-purge command was not loaded by real Pi: ${JSON.stringify(commandList)}`)
    }
    const purgeSourcePath = purge.sourceInfo?.path ? resolve(purge.sourceInfo.path) : null
    const extensionResolved = resolve(extensionPath)
    const purgeSourceMatches = purgeSourcePath === extensionResolved

    const stateBefore = await host.request({ type: 'get_state' })
    if (stateBefore?.messageCount !== 0) {
      throw new Error(`fresh pi profile did not start empty: messageCount=${String(stateBefore?.messageCount)}`)
    }

    const notifyMessages = []
    if (mode === 'append') {
      notifyMessages.push(...await runPurgeCommand(host, '/purge mode append'))
      notifyMessages.push(...await runPurgeCommand(host, '/purge on'))
    } else if (mode !== 'off') {
      throw new Error(`unknown scenario mode: ${String(mode)}`)
    }

    const providerRequestsBefore = provider.requests.length
    await host.request({ type: 'prompt', message: prompt }, { timeoutMs: requestTimeoutMs })
    const { index: settledIndex } = await host.waitForEvent('agent_settled', { timeoutMs: promptTimeoutMs })
    const assistantReply = extractAssistantReply(host.events)
    if (!assistantReply) {
      throw new Error(`no assistant reply event observed before agent_settled; events tail: ${JSON.stringify(host.events.slice(-10))}`)
    }

    const providerRequests = provider.requests.slice(providerRequestsBefore)
    if (providerRequests.length < 1) {
      throw new Error(`loopback provider received no chat completion request for mode=${mode}`)
    }

    const stateAfter = await host.request({ type: 'get_state' })
    return {
      mode,
      mockProvider: true,
      providerPromptSeen: providerRequests.length > 0,
      realExternalProvider: false,
      purgeCommandFound: true,
      purgeSourcePath,
      purgeSourceMatches,
      notifyMessages,
      assistantReply,
      agentSettledObserved: true,
      settledEventIndex: settledIndex,
      messageCountAfter: stateAfter?.messageCount ?? null,
      model: stateBefore?.model ?? null,
      sessionId: stateBefore?.sessionId ?? null,
      providerRequests
    }
  } finally {
    await host.stop()
  }
}

// ---------------------------------------------------------------------------
// Full dual-scenario evidence run (used by tests and the direct CLI)
// ---------------------------------------------------------------------------

export async function runDualScenarioEvidence({ prompt = 'Please reply with one short sentence confirming you received this harmless local loopback test message.' } = {}) {
  const piBin = defaultPiBin()
  await assertPinnedPiBundle(piBin)
  const stageDir = join(defaultP1bSandboxRoot(), PI_PURGE_STAGE_DIRNAME)
  const staged = assertStagedPiPurge(stageDir)

  const provider = await createLoopbackProvider()
  const parentDir = await mkdtemp(join(tmpdir(), 'loom-v2-pi-loopback-'))
  try {
    const offProfile = await createIsolatedPiProfile({ parentDir, port: provider.port, name: 'pi-agent-off' })
    const off = await runPiLoopbackScenario({
      piBin,
      extensionPath: staged.extensionPath,
      profile: offProfile,
      provider,
      mode: 'off',
      prompt
    })

    // Serial isolation: the Append bot uses a completely separate temp profile and its own
    // Pi process, started only after the Off bot has fully exited.
    const appendProfile = await createIsolatedPiProfile({ parentDir, port: provider.port, name: 'pi-agent-append' })
    const append = await runPiLoopbackScenario({
      piBin,
      extensionPath: staged.extensionPath,
      profile: appendProfile,
      provider,
      mode: 'append',
      prompt
    })

    const offSystemHashes = off.providerRequests.map((request) => request.systemPromptSha256)
    const appendSystemHashes = append.providerRequests.map((request) => request.systemPromptSha256)
    const toolsLeak = [...off.providerRequests, ...append.providerRequests]
      .some((request) => request.toolsSchema !== null)

    return {
      ok: true,
      mockProvider: true,
      providerPromptSeen: true,
      realExternalProvider: false,
      provider: {
        host: provider.host,
        port: provider.port,
        requestCount: provider.requests.length,
        violationCount: provider.violations.length,
        allRequestsLoopback: provider.requests.every((request) => request.remoteAddress === LOOPBACK_HOST),
        allAuthorizationDummy: provider.requests.every((request) => request.authorizationIsDummyBearer)
      },
      stagedExtension: {
        commit: staged.commit,
        extensionSha256: staged.extensionSha256,
        treeSha256: staged.treeSha256
      },
      off: { ...off, providerRequests: undefined, providerSystemPromptSha256: offSystemHashes },
      append: { ...append, providerRequests: undefined, providerSystemPromptSha256: appendSystemHashes },
      offVsAppend: {
        systemPromptHashesDiffer: offSystemHashes.length > 0
          && appendSystemHashes.length > 0
          && offSystemHashes[offSystemHashes.length - 1] !== appendSystemHashes[appendSystemHashes.length - 1],
        toolsLeaked: toolsLeak
      },
      prompt
    }
  } finally {
    await provider.close()
    await rm(parentDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Direct CLI entry: node scripts/loom-v2-pi-loopback-provider.mjs
// ---------------------------------------------------------------------------

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  runDualScenarioEvidence()
    .then((evidence) => {
      console.log(JSON.stringify(evidence, null, 2))
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error))
      process.exitCode = 1
    })
}

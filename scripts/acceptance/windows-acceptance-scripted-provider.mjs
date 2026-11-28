// SCRIPTED / SIMULATED. This file is a local stub, not a model, and never
// provider-qualification evidence. It exists because the Windows personal
// package acceptance run may not hold a real OCT_API_KEY: an OpenAI-compatible
// SSE endpoint on loopback lets the installed product's real runtime/run/stop
// plumbing be exercised while every model answer is honestly labelled
// SCRIPTED or SIMULATED in the workflow that consumes it.
//
// Contract (the acceptance workflow depends on it verbatim):
//   node scripts/acceptance/windows-acceptance-scripted-provider.mjs \
//     --listen 127.0.0.1:0 --port-file <path> --requests-file <path>
//     node scripts/acceptance/windows-acceptance-scripted-provider.mjs --self-test
//
//   * foreground process; binds loopback only (any other --listen fails closed,
//     exit code 2) and rejects non-loopback peers at the request level too;
//   * once listening it atomically writes <port-file> (write + rename in the same
//     directory) with exactly:
//       { schemaVersion: 1, port, pid, kind: 'loom-windows-acceptance-scripted-provider' }
//   * POST <anything>/chat/completions (and /v1/chat/completions) is answered as
//     OpenAI streaming SSE with at most 1 MiB of request body accepted;
//   * the reply is derived from the whole JSON request body:
//       LOOM-REPLY-<digits>         -> the reply contains that exact token
//       LOOM-DOCX-MARKER-<digits>   -> the reply contains that exact marker
//       'Stop check' or 'write a long, slow answer'
//                                   -> STALL: the stream never finishes (an
//                                      assistant role chunk may be sent) until the
//                                      client disconnects or the process exits
//       anything else               -> one plain short sentence
//     the request `model` value is echoed in every chunk, so an installed
//     runtime's model identity plumbing keeps working unchanged;
//   * <requests-file> records counts, byte lengths and stall flags only. The
//     prompt body, headers and any credential are never persisted;
//   * SIGINT / SIGTERM / SIGBREAK destroy every socket, close the listener and
//     leave no background process behind.
//
// Structure copied/adapted from:
//   scripts/lib/loom-v2-qa-scripted-pi-provider.mjs
//     :16     POST-only + '/chat/completions' suffix routing
//     :20-22  1 MiB body cap, 413 when exceeded
//     :27-32  SSE headers/chunk envelope and the `emit` write helper
//     :49,53-54 connection set + socket destroy then server.close()
//   scripts/loom-v2-pi-loopback-provider.mjs
//     :125,:135-138  socket.remoteAddress must be 127.0.0.1 (::ffff: stripped)
//     :143           query string stripped before path comparison
//     :197-210       SSE response headers (keep-alive, no-store)
//     :232           socket set membership
//     :238-242       server.listen(0, '127.0.0.1') with the one-shot error guard
//     :244-249       post-listen assertion that the bound address is loopback
//     :253-264       fail-closed close(): destroy sockets, bounded server.close()
//   scripts/acceptance/windows-real-install-acceptance.draft.ps1
//     :700-734       real-model turn asserts its LOOM-REPLY-<nonce> token
//     :745-768       docx turn asserts its LOOM-DOCX-MARKER-<nonce> marker
//     :829-838       stop check sends 'Stop check: write a long, slow answer...'
//                    and expects the AgentRun to still be running, then cancels it
import { createServer, request as httpRequest } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const LOOPBACK_HOST = '127.0.0.1'
export const PORT_FILE_KIND = 'loom-windows-acceptance-scripted-provider'
export const REQUESTS_FILE_KIND = 'loom-windows-acceptance-scripted-provider-requests'
export const SCHEMA_VERSION = 1
export const MAX_BODY_BYTES = 1024 * 1024
export const CHAT_PATH_SUFFIX = '/chat/completions'
export const DEFAULT_MODEL_ECHO = 'loom-acceptance-scripted-model'
export const PLAIN_REPLY = 'SCRIPTED LOOM acceptance reply: this text came from a local stub, not a real model.'
export const STALL_PHRASES = Object.freeze(['Stop check', 'write a long, slow answer'])
export const HEARTBEAT_INTERVAL_MS = 15_000
export const CLOSE_SERVER_TIMEOUT_MS = 5_000
const TOKEN_PATTERN = /LOOM-REPLY-\d+/g
const MARKER_PATTERN = /LOOM-DOCX-MARKER-\d+/g

const LOOPBACK_ALIASES = new Set(['127.0.0.1', 'localhost'])

function uniqueMatches(text, pattern) {
  const found = []
  for (const match of String(text).matchAll(pattern)) {
    if (!found.includes(match[0])) found.push(match[0])
  }
  return found
}

// The stall probe is case-insensitive but the phrases are otherwise verbatim, so
// a prompt that drifts in case still stalls instead of silently finishing.
export function stallRequested(rawBody) {
  const haystack = String(rawBody).toLowerCase()
  return STALL_PHRASES.some((phrase) => haystack.includes(phrase.toLowerCase()))
}

// Reply text is content-driven and deterministic: the acceptance script compares
// the reply it reads back with the nonce/marker it sent.
export function buildReplyText(rawBody) {
  const tokens = uniqueMatches(rawBody, TOKEN_PATTERN)
  const markers = uniqueMatches(rawBody, MARKER_PATTERN)
  const parts = [...tokens, ...markers]
  return parts.length ? parts.join(' ') : PLAIN_REPLY
}

// Split the reply into a few content deltas so an SSE reader sees real streaming,
// but never cut through a word: the acceptance script compares the reassembled
// reply with the LOOM-REPLY/LOOM-DOCX-MARKER value it sent, and keeping every
// token inside a single delta also makes the raw SSE bytes greppable.
function splitReply(text, pieces = 3) {
  const whole = String(text)
  const target = Math.max(1, Math.ceil(whole.length / pieces))
  const chunks = []
  let start = 0
  while (start < whole.length) {
    if (whole.length - start <= target || chunks.length >= pieces - 1) {
      chunks.push(whole.slice(start))
      break
    }
    const nextSpace = whole.indexOf(' ', start + target)
    if (nextSpace === -1) {
      chunks.push(whole.slice(start))
      break
    }
    chunks.push(whole.slice(start, nextSpace + 1))
    start = nextSpace + 1
  }
  return chunks.length ? chunks : [whole]
}

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

// Atomic JSON write: the temp file lives in the target directory, so the rename
// is same-filesystem and a reader never observes a half-written document.
export function writeJsonAtomic(filePath, value) {
  const target = resolve(filePath)
  mkdirSync(dirname(target), { recursive: true })
  const text = `${JSON.stringify(value, null, 2)}\n`
  const temp = `${target}.tmp-${process.pid}`
  writeFileSync(temp, text, 'utf8')
  try {
    renameSync(temp, target)
  } catch {
    // Windows refuses the replace while another handle holds the target open (a
    // reader must dispose it). Fall back to an in-place write so the evidence still
    // lands, then drop the temp file.
    writeFileSync(target, text, 'utf8')
    try { rmSync(temp, { force: true }) } catch { /* temp already gone */ }
  }
}

function assertLoopbackHost(host) {
  if (!LOOPBACK_ALIASES.has(host)) {
    throw new Error(`refusing a non-loopback listener: ${JSON.stringify(host)} (only 127.0.0.1/localhost are allowed)`)
  }
  return LOOPBACK_HOST
}

export async function startScriptedProvider({
  listen = `${LOOPBACK_HOST}:0`,
  portFile,
  requestsFile,
  scriptPath = import.meta.filename
} = {}) {
  if (typeof listen !== 'string' || !listen.includes(':')) {
    throw new Error(`--listen must look like 127.0.0.1:0, got ${JSON.stringify(listen)}`)
  }
  const separator = listen.lastIndexOf(':')
  const host = assertLoopbackHost(listen.slice(0, separator))
  const requestedPort = Number(listen.slice(separator + 1))
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error(`--listen port must be 0..65535, got ${JSON.stringify(listen.slice(separator + 1))}`)
  }

  const records = []
  const totals = {
    requests: 0,
    bodyBytes: 0,
    tokenReplies: 0,
    markerReplies: 0,
    plainReplies: 0,
    stalls: 0,
    openStalls: 0,
    rejects: 0
  }
  const sockets = new Set()
  const stalls = new Set()
  const rejections = []
  const startedAt = new Date().toISOString()
  let closed = false
  let boundPort = null
  let seq = 0
  let requestsWriteError = null

  const snapshot = () => ({
    schemaVersion: SCHEMA_VERSION,
    kind: REQUESTS_FILE_KIND,
    provider: {
      script: scriptPath,
      host,
      port: boundPort,
      pid: process.pid,
      scripted: true,
      simulated: true
    },
    startedAt,
    updatedAt: new Date().toISOString(),
    closed,
    maxBodyBytes: MAX_BODY_BYTES,
    // Deliberately no prompt text, no message bodies, no Authorization header and
    // no credential: only counts, lengths and stall flags leave this process.
    totals: { ...totals },
    requests: records,
    rejects: rejections
  })

  const persist = () => {
    if (!requestsFile) return
    try {
      writeJsonAtomic(requestsFile, snapshot())
      requestsWriteError = null
    } catch (error) {
      // Recording must never take the provider down; the failure is kept in memory
      // and surfaced on stderr so the workflow log shows it.
      requestsWriteError = error
      process.stderr.write(`scripted-provider: requests-file write failed: ${error?.message ?? error}\n`)
    }
  }

  const reject = (status, reason, extra = {}) => {
    totals.rejects += 1
    rejections.push({ at: new Date().toISOString(), status, reason, ...extra })
    persist()
  }

  const server = createServer((req, res) => {
    const remoteAddress = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '')
    const failRequest = (status, reason) => {
      reject(status, reason, { method: req.method ?? null, remoteAddress })
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
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
    if (!pathOnly.endsWith(CHAT_PATH_SUFFIX)) {
      failRequest(404, 'path_not_allowed')
      return
    }

    const parts = []
    let bodyBytes = 0
    let abandoned = false
    req.on('data', (part) => {
      if (abandoned) return
      bodyBytes += part.length
      if (bodyBytes > MAX_BODY_BYTES) {
        abandoned = true
        failRequest(413, 'body_quota_exceeded')
        req.destroy()
        return
      }
      parts.push(part)
    })
    req.on('error', () => {
      abandoned = true
    })
    req.on('end', () => {
      if (abandoned) return
      const rawBody = Buffer.concat(parts).toString('utf8')
      let parsed
      try {
        parsed = JSON.parse(rawBody)
      } catch {
        failRequest(400, 'invalid_json')
        return
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        failRequest(400, 'invalid_body')
        return
      }

      const tokenMatches = uniqueMatches(rawBody, TOKEN_PATTERN).length
      const markerMatches = uniqueMatches(rawBody, MARKER_PATTERN).length
      const isStall = stallRequested(rawBody)
      const model = typeof parsed.model === 'string' && parsed.model.length > 0 ? parsed.model : DEFAULT_MODEL_ECHO
      const streaming = parsed.stream === true
      const replyText = buildReplyText(rawBody)
      seq += 1
      const record = {
        seq,
        at: new Date().toISOString(),
        method: req.method,
        path: pathOnly,
        bodyBytes,
        model,
        stream: streaming,
        messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
        tokenMatches,
        markerMatches,
        replyKind: isStall ? 'stall' : (tokenMatches || markerMatches ? 'marker' : 'plain'),
        replyChars: isStall ? 0 : replyText.length,
        stalled: isStall
      }
      records.push(record)
      totals.requests += 1
      totals.bodyBytes += bodyBytes
      if (isStall) {
        totals.stalls += 1
        totals.openStalls += 1
      } else if (tokenMatches || markerMatches) {
        totals.tokenReplies += tokenMatches > 0 ? 1 : 0
        totals.markerReplies += markerMatches > 0 ? 1 : 0
      } else {
        totals.plainReplies += 1
      }
      persist()

      const created = Math.floor(Date.now() / 1000)
      const base = { id: `chatcmpl-scripted-acceptance-${String(seq).padStart(4, '0')}`, created, model }

      if (isStall) {
        // STALL: hold the response open with a single role chunk and never send a
        // finish_reason, so the product AgentRun stays running until the acceptance
        // script cancels it (windows-real-install-acceptance.draft.ps1:829-838).
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-loom-acceptance-scripted': 'stall'
        })
        res.write(sseFrame({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }))
        const heartbeat = setInterval(() => {
          if (res.writableEnded || res.destroyed) return
          // SSE comment line: keeps proxies/readers awake without any content.
          try { res.write(': keep-alive\n\n') } catch { /* socket already gone */ }
        }, HEARTBEAT_INTERVAL_MS)
        heartbeat.unref?.()
        const release = () => {
          clearInterval(heartbeat)
          if (!stalls.delete(release)) return
          totals.openStalls = Math.max(0, totals.openStalls - 1)
          record.stallReleasedAt = new Date().toISOString()
          persist()
        }
        stalls.add(release)
        res.on('close', release)
        res.on('error', release)
        return
      }

      if (!streaming) {
        // Tolerated for non-streaming callers; the streaming path below is the one
        // the installed runtimes use.
        const payload = {
          id: base.id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 8, completion_tokens: replyText.length, total_tokens: 8 + replyText.length }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-loom-acceptance-scripted': 'true' })
        res.end(JSON.stringify(payload))
        return
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-loom-acceptance-scripted': 'true'
      })
      const emit = (value) => res.write(sseFrame(value))
      for (const piece of splitReply(replyText)) {
        emit({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: piece }, finish_reason: null }] })
      }
      emit({
        ...base,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: replyText.length, total_tokens: 8 + replyText.length }
      })
      res.end('data: [DONE]\n\n')
    })
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  // Idle keep-alive sockets must not delay shutdown.
  server.keepAliveTimeout = 5_000

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(requestedPort, host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })

  const address = server.address()
  if (!address || typeof address !== 'object' || address.address !== host
      || !Number.isInteger(address.port) || address.port <= 0) {
    try { server.close() } catch { /* already gone */ }
    throw new Error(`scripted provider did not bind ${host}:${requestedPort} as expected: ${JSON.stringify(address)}`)
  }
  boundPort = address.port

  if (portFile) {
    writeJsonAtomic(portFile, {
      schemaVersion: SCHEMA_VERSION,
      port: boundPort,
      pid: process.pid,
      kind: PORT_FILE_KIND
    })
  }
  persist()

  const close = async () => {
    if (closed) return { port: boundPort, requests: totals.requests }
    closed = true
    for (const release of [...stalls]) release()
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    const didClose = await new Promise((resolveClose) => {
      const timer = setTimeout(() => resolveClose(false), CLOSE_SERVER_TIMEOUT_MS)
      server.close(() => {
        clearTimeout(timer)
        resolveClose(true)
      })
    })
    persist()
    if (!didClose) throw new Error('scripted provider failed to close its listening socket in time')
    return { port: boundPort, requests: totals.requests, requestsWriteError: requestsWriteError?.message ?? null }
  }

  return { host, port: boundPort, portFile: portFile ?? null, requestsFile: requestsFile ?? null, totals, records, close }
}

export function parseArguments(argv) {
  const options = { listen: `${LOOPBACK_HOST}:0`, portFile: null, requestsFile: null, selfTest: false, help: false }
  const takeValue = (index, inline, flag) => {
    if (inline !== undefined) return { value: inline, next: index }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
    return { value, next: index + 1 }
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const equals = argument.indexOf('=')
    const flag = equals === -1 ? argument : argument.slice(0, equals)
    const inline = equals === -1 ? undefined : argument.slice(equals + 1)
    if (flag === '--listen') {
      const taken = takeValue(index, inline, '--listen')
      options.listen = taken.value
      index = taken.next
    } else if (flag === '--port-file') {
      const taken = takeValue(index, inline, '--port-file')
      options.portFile = taken.value
      index = taken.next
    } else if (flag === '--requests-file') {
      const taken = takeValue(index, inline, '--requests-file')
      options.requestsFile = taken.value
      index = taken.next
    } else if (flag === '--self-test') {
      options.selfTest = true
    } else if (flag === '--help' || flag === '-h') {
      options.help = true
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }
  return options
}

export const USAGE = [
  'SCRIPTED/SIMULATED loopback OpenAI-compatible provider for the Windows acceptance run.',
  '',
  '  node scripts/acceptance/windows-acceptance-scripted-provider.mjs \\',
  '    --listen 127.0.0.1:0 --port-file <path> --requests-file <path>',
  '',
  '  node scripts/acceptance/windows-acceptance-scripted-provider.mjs --self-test',
  '',
  '  --listen         host:port, loopback only; 0 asks the OS for a free port',
  '  --port-file      atomically written {"schemaVersion":1,"port","pid","kind"}',
  '  --requests-file rewritten on every state change with counts/lengths/stall flags only',
  '  --self-test      run the built-in verification against 127.0.0.1 and exit',
  '',
  'This is not a real model: label every result it produces SCRIPTED/SIMULATED.'
].join('\n')

// ---------------------------------------------------------------------------
// Self-test: proves the contract above without touching any product code.
// ---------------------------------------------------------------------------

// Rebuild the JSON chunks a client would see, then the content a client would
// reassemble from the deltas. Used only by --self-test.
function sseChunks(sseText) {
  const chunks = []
  for (const frame of String(sseText).split('\n\n')) {
    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
    if (!dataLine || dataLine.slice(6) === '[DONE]') continue
    try {
      chunks.push(JSON.parse(dataLine.slice(6)))
    } catch {
      // Non-JSON frame (a keep-alive comment); not part of the content.
    }
  }
  return chunks
}

function sseContent(sseText) {
  return sseChunks(sseText)
    .map((chunk) => chunk?.choices?.[0]?.delta?.content ?? '')
    .join('')
}

function rawPost(port, path, payload, { abortAfterMs = null } = {}) {
  return new Promise((resolvePost) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
    const request = httpRequest({
      host: LOOPBACK_HOST,
      port,
      path,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    })
    const controller = { aborted: false }
    const timer = abortAfterMs === null ? null : setTimeout(() => {
      controller.aborted = true
      request.destroy(new Error('aborted by self-test'))
    }, abortAfterMs)
    request.on('response', (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        if (timer) clearTimeout(timer)
        resolvePost({ aborted: controller.aborted, status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') })
      })
      response.on('error', () => {
        if (timer) clearTimeout(timer)
        resolvePost({ aborted: true, status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') })
      })
    })
    request.on('error', (error) => {
      if (timer) clearTimeout(timer)
      resolvePost({ aborted: true, status: null, headers: {}, text: '', error: error.message })
    })
    request.end(body)
  })
}

export async function runSelfTest() {
  const checks = []
  const check = (name, condition, detail = '') => {
    checks.push({ name, ok: Boolean(condition), detail })
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  }
  const workDir = mkdtempSync(join(tmpdir(), 'loom-scripted-provider-selftest-'))
  const portFile = join(workDir, 'provider-port.json')
  const requestsFile = join(workDir, 'provider-requests.json')
  const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
  let provider = null
  try {
    provider = await startScriptedProvider({ listen: `${LOOPBACK_HOST}:0`, portFile, requestsFile })
    const port = provider.port
    check('listener is bound on loopback', provider.host === LOOPBACK_HOST && port > 0, `${provider.host}:${port}`)

    const portDocument = readJson(portFile)
    check('port-file carries schemaVersion 1', portDocument.schemaVersion === 1, JSON.stringify(portDocument))
    check('port-file kind', portDocument.kind === PORT_FILE_KIND)
    check('port-file port matches the listener', portDocument.port === port)
    check('port-file pid matches this process', portDocument.pid === process.pid)

    const nonce = 'LOOM-REPLY-654321'
    const tokenReply = await rawPost(port, '/v1/chat/completions', {
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [{ role: 'user', content: `Real-model smoke: reply with exactly the token ${nonce} and nothing else.` }]
    })
    check('token request answered 200 SSE', tokenReply.status === 200 && String(tokenReply.headers['content-type']).startsWith('text/event-stream'))
    check('token reply contains the exact LOOM-REPLY token', tokenReply.text.includes(nonce))
    check('token reply echoes the request model', tokenReply.text.includes('"model":"deepseek-v4.1-flash"'))
    check('token reply finishes with finish_reason stop', tokenReply.text.includes('"finish_reason":"stop"'))
    check('token reply terminates with data: [DONE]', tokenReply.text.trimEnd().endsWith('data: [DONE]'))
    check('token reply streams at least two SSE frames', sseChunks(tokenReply.text).length >= 2)
    check('token reply reassembles exactly to the token', sseContent(tokenReply.text) === nonce, JSON.stringify(sseContent(tokenReply.text)))

    const marker = 'LOOM-DOCX-MARKER-112233'
    const markerReply = await rawPost(port, '/anything/chat/completions', {
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [{ role: 'user', content: `prompt-selftest-marker ${marker} first acceptance paragraph.` }]
    })
    check('trailing /chat/completions path is tolerated', markerReply.status === 200)
    check('docx reply contains the exact marker', markerReply.text.includes(marker))
    check('docx marker is not reported as a plain reply', readJson(requestsFile).totals.markerReplies === 1)

    const plainReply = await rawPost(port, '/v1/chat/completions', {
      model: 'loom-plain',
      stream: true,
      messages: [{ role: 'user', content: 'prompt-selftest-no-marker: say hello' }]
    })
    check('plain request gets a short reply', plainReply.status === 200 && plainReply.text.includes(PLAIN_REPLY.slice(0, 24)))
    check('plain reply reassembles to the scripted sentence', sseContent(plainReply.text) === PLAIN_REPLY, JSON.stringify(sseContent(plainReply.text)))
    check('plain reply is split into several streaming deltas',
      sseChunks(plainReply.text).filter((chunk) => typeof chunk?.choices?.[0]?.delta?.content === 'string').length > 1)
    check('plain request does not contain a token or marker',
      !plainReply.text.includes('LOOM-REPLY-') && !plainReply.text.includes('LOOM-DOCX-MARKER-'))

    const stallPrompt = 'Stop check: write a long, slow answer. Produce at least 800 words and keep working until you are interrupted.'
    const stalled = await rawPost(port, '/v1/chat/completions', {
      model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: stallPrompt }]
    }, { abortAfterMs: 1_500 })
    check('stall request never completes before the client disconnects', stalled.aborted === true && !stalled.text.includes('"finish_reason":"stop"'))
    check('stall request sent no [DONE] sentinel', !stalled.text.includes('[DONE]'))
    const duringStall = readJson(requestsFile)
    check('stall was recorded as a stall', duringStall.totals.stalls === 1)
    check('stall record has no reply text length', duringStall.requests.some((entry) => entry.stalled === true && entry.replyChars === 0))

    // Hold a second stall open on purpose: the process must keep the connection and
    // report it as open until the client goes away.
    const openStall = rawPost(port, '/v1/chat/completions', {
      model: 'deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'Stop check: write a long, slow answer.' }]
    }, { abortAfterMs: 1_200 })
    await new Promise((done) => setTimeout(done, 400))
    check('an open stall is reported as open while the client is connected', readJson(requestsFile).totals.openStalls === 1)
    const openStallResult = await openStall
    await new Promise((done) => setTimeout(done, 150))
    check('the open stall is released when the client disconnects',
      openStallResult.aborted === true && readJson(requestsFile).totals.openStalls === 0)

    const big = await rawPost(port, '/v1/chat/completions', `{"model":"m","pad":"${'x'.repeat(MAX_BODY_BYTES)}"}`)
    check('body over 1 MiB is rejected with 413', big.status === 413, String(big.status))

    const badJson = await rawPost(port, '/v1/chat/completions', '{not json')
    check('invalid JSON is rejected with 400', badJson.status === 400, String(badJson.status))

    const wrongPath = await rawPost(port, '/v1/models', { model: 'm' })
    check('non chat-completions path is rejected with 404', wrongPath.status === 404, String(wrongPath.status))

    const recordsText = readFileSync(requestsFile, 'utf8')
    check('requests-file persists no prompt body', !recordsText.includes(nonce) && !recordsText.includes(marker) && !recordsText.includes('prompt-selftest'))
    check('requests-file records only counts and lengths',
      recordsText.includes('"totals"') && recordsText.includes('"bodyBytes"') && recordsText.includes('"stalled"'))
    check('requests-file carries schemaVersion 1', readJson(requestsFile).schemaVersion === 1)

    const closed = await provider.close()
    provider = null
    check('close() released the listener', closed.port === port)
    const finalDocument = readJson(requestsFile)
    check('requests-file is marked closed after shutdown', finalDocument.closed === true)
    check('no stall session is left open', finalDocument.totals.openStalls === 0)
    check('rejections are counted without any prompt text', finalDocument.rejects.every((entry) => !String(entry.reason).includes(nonce)))
  } finally {
    try { if (provider) await provider.close() } catch { /* self-test teardown */ }
    rmSync(workDir, { recursive: true, force: true })
  }
  const failed = checks.filter((entry) => !entry.ok)
  console.log('')
  console.log(`self-test: ${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length) {
    console.log(`self-test FAILED: ${failed.map((entry) => entry.name).join(' | ')}`)
    return 1
  }
  console.log('verified SCRIPTED/SIMULATED behaviour: loopback-only binding, atomic port-file,')
  console.log('content-driven LOOM-REPLY/LOOM-DOCX-MARKER replies, model echo, SSE finish + [DONE],')
  console.log('never-finishing stall until client disconnect, 1 MiB cap, 400/404 rejects,')
  console.log('and a requests-file that records counts/lengths/stall flags only.')
  return 0
}

// ---------------------------------------------------------------------------
// CLI entry: foreground provider, or --self-test.
// ---------------------------------------------------------------------------

export async function runCli(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`scripted-provider: ${error.message}\n\n${USAGE}\n`)
    return 2
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (options.selfTest) {
    return runSelfTest()
  }
  if (!options.portFile || !options.requestsFile) {
    process.stderr.write(`scripted-provider: --port-file and --requests-file are required\n\n${USAGE}\n`)
    return 2
  }
  let provider
  try {
    provider = await startScriptedProvider({ listen: options.listen, portFile: options.portFile, requestsFile: options.requestsFile })
  } catch (error) {
    process.stderr.write(`scripted-provider: startup failed: ${error?.message ?? error}\n`)
    return 2
  }
  // Ready line for the workflow log; the port-file is the machine-readable copy.
  console.log(`scripted-provider ready: http://${provider.host}:${provider.port}/v1 pid=${process.pid} kind=${PORT_FILE_KIND} (SCRIPTED/SIMULATED, not a real model)`)

  let shuttingDown = false
  const shutdown = (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`scripted-provider stopping on ${signal}: ${provider.totals.requests} request(s) seen`)
    provider.close()
      .catch((error) => { process.stderr.write(`scripted-provider: close failed: ${error?.message ?? error}\n`); process.exitCode = 1 })
      .finally(() => {
        // Any lingering timer/socket is gone at this point; exit explicitly so a
        // Windows runner never keeps the job alive on an idle handle.
        process.exit(process.exitCode ?? 0)
      })
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    try { process.on(signal, () => shutdown(signal)) } catch { /* signal unsupported here */ }
  }
  process.on('uncaughtException', (error) => {
    process.stderr.write(`scripted-provider: uncaught: ${error?.stack ?? error}\n`)
    shutdown('uncaughtException')
  })
  process.on('unhandledRejection', (error) => {
    process.stderr.write(`scripted-provider: unhandled rejection: ${error?.stack ?? error}\n`)
    shutdown('unhandledRejection')
  })
  return null
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  runCli()
    .then((code) => {
      if (typeof code === 'number') process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(`scripted-provider: ${error?.stack ?? error}\n`)
      process.exitCode = 1
    })
}

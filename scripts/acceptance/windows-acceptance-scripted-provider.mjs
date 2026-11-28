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
//   * a request that carries the aabb PPTX Mission goal (the fixed first line
//     'Windows real-install acceptance: register the pptx already in the
//     workspace', or two or more mission-goal phrases) is answered with ONE
//     scripted `rovai_loom` tool call per round instead: loom.status ->
//     loom.plan (1 task, task-1, assigneeAgentId from 'member ID is <id>') ->
//     loom.release -> loom.claim -> loom.evidence (relativePath
//     'acceptance.pptx') -> loom.submit (evidenceIds [<artifactId read back
//     from the evidence tool result>]) -> one short completion. A tool-call id
//     encodes its step and operation, so the `role: 'tool'` messages of the
//     next request say which step already returned; an evidence result with no
//     artifactId/evidenceId/id is answered with an empty completion (the Run
//     fails honestly) and never with a fabricated id;
//   * <requests-file> records counts, byte lengths, stall flags, and for the
//     Mission chain only the step number and operation name. The prompt body,
//     the goal text, model-supplied arguments, headers and any credential are
//     never persisted;
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
export const MISSION_TOOL_NAME = 'rovai_loom'
// The verbatim first line of the aabb final-acceptance mission goal
// (windows-real-install-acceptance.draft.ps1, Test-PptxPreviewInterface $goal).
export const MISSION_GOAL_PRIMARY = 'Windows real-install acceptance: register the pptx already in the workspace'
// Fallback signals for a reworded goal; two of them together are the mission, one is not.
export const MISSION_GOAL_SIGNALS = Object.freeze([
  'register the pptx already in the workspace',
  'acceptance.pptx is already in this mission workspace',
  'use rovai_loom in order',
  'loom.evidence with relativepath=',
  'loom.submit to submit the returned artifactid'
])
export const MISSION_TASK_ID = 'task-1'
export const MISSION_EVIDENCE_PATH = 'acceptance.pptx'
// Shape of managed-workflow-tool.ts:599 only; a real member id comes from the goal.
export const MISSION_PLACEHOLDER_MEMBER_ID = 'member-agent-id'
export const MISSION_TOOL_CALL_ID_PREFIX = 'loom-acceptance-call-'
export const MISSION_COMPLETION_TEXT = 'SCRIPTED LOOM acceptance: the pptx delivery chain was issued in order and the candidate now waits for User acceptance.'
export const MISSION_FAILURE_REASONS = Object.freeze({
  TOOL_NOT_OFFERED: 'tool_not_offered',
  EVIDENCE_ID_MISSING: 'evidence_result_missing_identifier'
})
export const HEARTBEAT_INTERVAL_MS = 15_000
export const CLOSE_SERVER_TIMEOUT_MS = 5_000
const TOKEN_PATTERN = /LOOM-REPLY-\d+/g
const MARKER_PATTERN = /LOOM-DOCX-MARKER-\d+/g
const MISSION_MEMBER_PATTERN = /member\s+ID\s+is\s+([A-Za-z0-9][A-Za-z0-9_.:-]{0,199})/i
const MISSION_TOOL_CALL_ID_PATTERN = /^loom-acceptance-call-(\d+)-/

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

// ---------------------------------------------------------------------------
// Scripted PPTX Mission tool-use chain
// ---------------------------------------------------------------------------
//
// The real-machine final acceptance (aabb965fba31c7c90c334bc57fd6ba0e827c6d23,
// windows-real-install-acceptance.draft.ps1, Test-PptxPreviewInterface $goal) creates a quick_chat
// Mission whose description is the fixed goal below and then waits for Core's
// loom.artifacts.list to report relativePath 'acceptance.pptx'. Registration, release, claim,
// evidence and submit are not Web capabilities: the bundled agent reaches them only through the
// one managed tool `rovai_loom` (crates/rovai-core/src/pi/managed-workflow-tool.ts:48,556-581), so
// this provider drives the exact chain the goal names, one tool call per round:
//
//   loom.status {} -> loom.plan {1 task task-1, assigneeAgentId from the goal} ->
//   loom.release {taskId} -> loom.claim {taskId} ->
//   loom.evidence {relativePath:'acceptance.pptx', taskId} ->
//   loom.submit {taskId, evidenceIds:[<artifactId from the evidence tool result>]}
//   -> one short completion
//
// The chain is derived from the request alone: the tool-call id carries its step and operation,
// so the `role: 'tool'` messages of a later request say which steps already returned. When the
// evidence result carries no artifactId/evidenceId/id the provider answers with an empty
// completion so the Run fails honestly, and records the reason instead of an invented id.

export const MISSION_STEPS = Object.freeze([
  Object.freeze({ operation: 'loom.status', build: () => ({}) }),
  Object.freeze({
    operation: 'loom.plan',
    // managed-workflow-tool.ts:599 example shape: goal/criteria/tasks, nothing else.
    build: ({ memberId }) => ({
      goal: 'Register acceptance.pptx already in this Mission workspace and submit the candidate',
      criteria: [{ criterionId: 'file', text: 'acceptance.pptx is registered as evidence and awaits User acceptance' }],
      tasks: [{
        taskId: MISSION_TASK_ID,
        title: 'Register the pptx already in the workspace',
        assigneeAgentId: memberId,
        acceptanceCriteria: [{ criterionId: 'file', text: 'acceptance.pptx is registered as evidence for task-1' }]
      }]
    })
  }),
  Object.freeze({ operation: 'loom.release', build: () => ({ taskId: MISSION_TASK_ID }) }),
  Object.freeze({ operation: 'loom.claim', build: () => ({ taskId: MISSION_TASK_ID }) }),
  Object.freeze({ operation: 'loom.evidence', build: () => ({ relativePath: MISSION_EVIDENCE_PATH, taskId: MISSION_TASK_ID }) }),
  Object.freeze({ operation: 'loom.submit', build: ({ artifactId }) => ({ taskId: MISSION_TASK_ID, evidenceIds: [artifactId] }) })
])

const MISSION_EVIDENCE_STEP_INDEX = MISSION_STEPS.findIndex((step) => step.operation === 'loom.evidence')

// JSON escapes folded back to characters and whitespace collapsed, case preserved: a member id
// must come back exactly as the goal wrote it.
function decodedBodyText(rawBody) {
  return String(rawBody)
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\s+/g, ' ')
}

export function missionGoalRequested(rawBody) {
  const haystack = decodedBodyText(rawBody).toLowerCase()
  if (haystack.includes(MISSION_GOAL_PRIMARY.toLowerCase())) return true
  const signals = MISSION_GOAL_SIGNALS.filter((signal) => haystack.includes(signal.toLowerCase()))
  return signals.length >= 2
}

export function extractMissionMemberId(rawBody) {
  const match = MISSION_MEMBER_PATTERN.exec(decodedBodyText(rawBody))
  if (!match) return null
  // The goal writes "member ID is <id>.", so the sentence period is never part of the id.
  const id = match[1].replace(/[.,;:]+$/, '')
  return id.length > 0 ? id : null
}

/** Deterministic, self-describing tool-call id: the step number and the operation slug. */
export function missionToolCallId(stepIndex, operation) {
  const slug = String(operation).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return `${MISSION_TOOL_CALL_ID_PREFIX}${Number(stepIndex) + 1}-${slug}`
}

/** The zero-based step a tool-result id answers, or null for any id this provider did not issue. */
export function missionStepFromToolCallId(id) {
  const match = MISSION_TOOL_CALL_ID_PATTERN.exec(String(id ?? ''))
  if (!match) return null
  const step = Number(match[1]) - 1
  return Number.isInteger(step) && step >= 0 && step < MISSION_STEPS.length ? step : null
}

function toolResultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (part && typeof part.text === 'string' ? part.text : '')))
      .join('\n')
  }
  if (content === null || content === undefined) return ''
  try { return JSON.stringify(content) } catch { return '' }
}

// Breadth-first so the closest identifier wins; `id` is the last, weakest alias.
function findStringKey(root, key, budget = 5_000) {
  const queue = [root]
  for (let cursor = 0; cursor < queue.length && cursor < budget; cursor += 1) {
    const node = queue[cursor]
    if (Array.isArray(node)) {
      for (const item of node) if (item && typeof item === 'object') queue.push(item)
      continue
    }
    if (!node || typeof node !== 'object') continue
    if (typeof node[key] === 'string' && node[key].length > 0) return node[key]
    for (const value of Object.values(node)) if (value && typeof value === 'object') queue.push(value)
  }
  return null
}

/**
 * The artifact identifier carried by one evidence tool result: `artifactId`, then `evidenceId`,
 * then a bare `id`. Returns null rather than any placeholder, so a missing id can never turn into
 * a submitted delivery that claims an artifact nobody registered.
 */
export function extractArtifactId(content) {
  const text = toolResultText(content)
  let parsed = null
  try { parsed = JSON.parse(text) } catch { parsed = null }
  if (parsed && typeof parsed === 'object') {
    for (const key of ['artifactId', 'evidenceId', 'id']) {
      const found = findStringKey(parsed, key)
      if (found) return found
    }
  }
  for (const key of ['artifactId', 'evidenceId', 'id']) {
    const match = new RegExp(`"${key}"\\s*:\\s*"([^"]{1,200})"`).exec(text)
    if (match) return match[1]
  }
  return null
}

function missionToolResults(messages) {
  const results = new Map()
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const role = typeof message.role === 'string' ? message.role : ''
    if (role !== 'tool' && role !== 'function') continue
    const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : message.toolCallId
    const step = missionStepFromToolCallId(id)
    if (step === null || results.has(step)) continue
    results.set(step, message)
  }
  return results
}

/** null when the request declares no tools at all; the offered names otherwise. */
function offeredToolNames(parsed) {
  const tools = Array.isArray(parsed?.tools) ? parsed.tools : null
  if (!tools || tools.length === 0) return null
  return tools.map((tool) => String(tool?.function?.name ?? tool?.name ?? '')).filter(Boolean)
}

/**
 * Decide the next scripted turn for this request, or null when the request is not the mission.
 * One of: { kind:'tool_call', ... } | { kind:'complete' } | { kind:'fail', reason }.
 */
export function planMissionTurn(parsed, rawBody) {
  if (!missionGoalRequested(rawBody)) return null
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : []
  const results = missionToolResults(messages)
  let stepIndex = 0
  while (stepIndex < MISSION_STEPS.length && results.has(stepIndex)) stepIndex += 1
  if (stepIndex >= MISSION_STEPS.length) return { kind: 'complete' }

  const toolNames = offeredToolNames(parsed)
  if (toolNames !== null && !toolNames.includes(MISSION_TOOL_NAME)) {
    return { kind: 'fail', reason: MISSION_FAILURE_REASONS.TOOL_NOT_OFFERED }
  }

  const step = MISSION_STEPS[stepIndex]
  const memberId = extractMissionMemberId(rawBody)
  const artifactId = results.has(MISSION_EVIDENCE_STEP_INDEX)
    ? extractArtifactId(results.get(MISSION_EVIDENCE_STEP_INDEX).content ?? results.get(MISSION_EVIDENCE_STEP_INDEX).text ?? null)
    : null
  if (step.operation === 'loom.submit' && !artifactId) {
    return { kind: 'fail', reason: MISSION_FAILURE_REASONS.EVIDENCE_ID_MISSING }
  }

  const input = step.build({ memberId: memberId ?? MISSION_PLACEHOLDER_MEMBER_ID, artifactId })
  return {
    kind: 'tool_call',
    stepIndex,
    operation: step.operation,
    input,
    memberFromGoal: memberId !== null,
    toolCallId: missionToolCallId(stepIndex, step.operation),
    argumentsJson: JSON.stringify({ operation: step.operation, input })
  }
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
    missionRequests: 0,
    missionToolCalls: 0,
    missionCompletions: 0,
    missionFailures: 0,
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
      // Precedence, documented in the file header: a stop probe always stalls, an explicit
      // LOOM-REPLY/LOOM-DOCX-MARKER request is always answered with that token or marker (the
      // existing contract), and only a request that asks for neither may start the Mission chain.
      const missionTurn = isStall || tokenMatches || markerMatches
        ? null
        : planMissionTurn(parsed, rawBody)
      const model = typeof parsed.model === 'string' && parsed.model.length > 0 ? parsed.model : DEFAULT_MODEL_ECHO
      const streaming = parsed.stream === true
      const replyText = missionTurn === null
        ? buildReplyText(rawBody)
        : (missionTurn.kind === 'complete' ? MISSION_COMPLETION_TEXT : '')
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
        replyKind: isStall
          ? 'stall'
          : missionTurn === null
            ? (tokenMatches || markerMatches ? 'marker' : 'plain')
            : missionTurn.kind === 'tool_call'
              ? 'mission-tool-call'
              : missionTurn.kind === 'complete' ? 'mission-completion' : 'mission-failed',
        replyChars: isStall ? 0 : replyText.length,
        stalled: isStall
      }
      if (missionTurn) {
        // Only the step number, the operation name and our own fixed reason leave the process.
        // The goal text, the member id, the relative path and the tool-call arguments do not.
        record.mission = true
        if (missionTurn.kind === 'tool_call') {
          record.missionStep = missionTurn.stepIndex + 1
          record.missionOperation = missionTurn.operation
          record.toolCallId = missionTurn.toolCallId
          record.argumentsChars = missionTurn.argumentsJson.length
          // A boolean, never the member id itself: the goal's identifiers stay out of the file.
          record.missionMemberFromGoal = missionTurn.memberFromGoal
        } else if (missionTurn.kind === 'fail') {
          record.missionFailureReason = missionTurn.reason
        }
      }
      records.push(record)
      totals.requests += 1
      totals.bodyBytes += bodyBytes
      if (isStall) {
        totals.stalls += 1
        totals.openStalls += 1
      } else if (missionTurn) {
        totals.missionRequests += 1
        if (missionTurn.kind === 'tool_call') totals.missionToolCalls += 1
        else if (missionTurn.kind === 'complete') totals.missionCompletions += 1
        else totals.missionFailures += 1
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

      if (missionTurn && missionTurn.kind === 'tool_call') {
        // Exactly ONE tool call per round, in the delta shape
        // scripts/lib/loom-v2-qa-scripted-pi-provider.mjs:34-38 uses: the tool call first with
        // finish_reason null, then an empty delta carrying finish_reason 'tool_calls'.
        const toolCall = {
          index: 0,
          id: missionTurn.toolCallId,
          type: 'function',
          function: { name: MISSION_TOOL_NAME, arguments: missionTurn.argumentsJson }
        }
        const usage = {
          prompt_tokens: 8,
          completion_tokens: missionTurn.argumentsJson.length,
          total_tokens: 8 + missionTurn.argumentsJson.length
        }
        if (!streaming) {
          const payload = {
            id: base.id,
            object: 'chat.completion',
            created,
            model,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: toolCall.id, type: 'function', function: toolCall.function }]
              },
              finish_reason: 'tool_calls'
            }],
            usage
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
        emit({
          ...base,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [toolCall] }, finish_reason: null }]
        })
        emit({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage })
        res.end('data: [DONE]\n\n')
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
  'The aabb PPTX Mission goal is answered with the scripted rovai_loom tool-use chain:',
  'loom.status -> loom.plan (1 task, task-1) -> loom.release -> loom.claim ->',
  'loom.evidence (acceptance.pptx) -> loom.submit (artifactId from the evidence result).',
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

    // -----------------------------------------------------------------------
    // PPTX Mission tool-use chain (the aabb final-acceptance goal).
    // -----------------------------------------------------------------------
    const missionMember = 'member-selftest-7f3a'
    // Verbatim goal of windows-real-install-acceptance.draft.ps1 (Test-PptxPreviewInterface $goal).
    const missionGoal = [
      'Windows real-install acceptance: register the pptx already in the workspace and submit the candidate, do not rewrite the file.',
      `You are the Default Lead and the only executor; member ID is ${missionMember}.`,
      'acceptance.pptx is already in this Mission workspace; do not rewrite, regenerate or rename it.',
      `Use rovai_loom in order: loom.status -> loom.plan (exactly 1 task, assigneeAgentId set to ${missionMember}) -> loom.release -> loom.claim.`,
      "Then use loom.evidence with relativePath='acceptance.pptx' to register that file and bind it to that task, and loom.submit to submit the returned artifactId.",
      'Then stop: the candidate stays pending; do not review, do not accept, do not use bash/shell/MCP, and write no other files.'
    ].join('\r\n')
    const missionTools = [
      { type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object' } } },
      { type: 'function', function: { name: MISSION_TOOL_NAME, description: 'LOOM', parameters: { type: 'object' } } }
    ]
    const missionBody = (exchanges, extra = {}) => ({
      model: 'deepseek-v4.1-flash',
      stream: true,
      tools: missionTools,
      messages: [{ role: 'system', content: 'LOOM managed workflow' }, { role: 'user', content: missionGoal }, ...exchanges],
      ...extra
    })
    const toolCallDeltas = (reply) => sseChunks(reply.text)
      .flatMap((chunk) => chunk?.choices?.[0]?.delta?.tool_calls ?? [])
    const firstToolCall = (reply) => toolCallDeltas(reply)[0] ?? null
    const pushExchange = (exchanges, call, content) => {
      exchanges.push({ role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: call.function }] })
      exchanges.push({ role: 'tool', tool_call_id: call.id, content })
    }

    // A Mission body whose Run cannot call rovai_loom is answered honestly with an empty
    // completion: the chain is never invented for a tool the Run was not granted.
    const noTool = await rawPost(port, '/v1/chat/completions', {
      ...missionBody([]),
      tools: [{ type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object' } } }]
    })
    check('a Mission body without rovai_loom gets an empty completion, not a tool call',
      noTool.status === 200 && sseContent(noTool.text) === '' && !noTool.text.includes('"tool_calls"'))

    // One goal phrase alone is not the Mission: the plain-reply contract still answers.
    const oneSignal = await rawPost(port, '/v1/chat/completions', {
      model: 'loom-plain', stream: true,
      messages: [{ role: 'user', content: 'Use rovai_loom in order: loom.status and then say hello.' }]
    })
    check('one mission-like phrase alone does not start the tool chain',
      sseContent(oneSignal.text) === PLAIN_REPLY && !oneSignal.text.includes('"tool_calls"'))

    // An explicit LOOM-REPLY request keeps the existing contract even next to the goal.
    const tokenWins = await rawPost(port, '/v1/chat/completions', {
      model: 'deepseek-v4.1-flash', stream: true, tools: missionTools,
      messages: [{ role: 'user', content: `${missionGoal}\r\nAlso reply with exactly LOOM-REPLY-313131.` }]
    })
    check('an explicit LOOM-REPLY request is still answered with the token, not a tool call',
      tokenWins.text.includes('LOOM-REPLY-313131') && !tokenWins.text.includes('"tool_calls"'))

    // Non-streaming Mission callers get the same single tool call as JSON.
    const nonStream = await rawPost(port, '/v1/chat/completions', { ...missionBody([]), stream: false })
    let nonStreamBody = null
    try { nonStreamBody = JSON.parse(nonStream.text) } catch { nonStreamBody = null }
    const nonStreamCall = nonStreamBody?.choices?.[0]?.message?.tool_calls?.[0] ?? null
    check('a non-streaming Mission turn answers one tool_call with finish_reason tool_calls',
      nonStream.status === 200
      && nonStreamBody?.choices?.[0]?.finish_reason === 'tool_calls'
      && nonStreamBody?.choices?.[0]?.message?.tool_calls?.length === 1
      && nonStreamCall?.function?.name === MISSION_TOOL_NAME)
    check('the non-streaming tool_call starts at loom.status with an empty input',
      nonStreamCall?.function?.arguments === '{"operation":"loom.status","input":{}}',
      String(nonStreamCall?.function?.arguments))

    // Walk the whole chain, feeding each scripted operation a plausible tool result.
    const expectedOperations = MISSION_STEPS.map((step) => step.operation)
    const evidenceArtifactId = 'artifact-selftest-9c1d'
    const stepResults = {
      'loom.status': '{"missionId":"mission-selftest","tasks":[],"replayed":false}',
      'loom.plan': '{"planId":"plan-selftest","missionId":"mission-selftest","acceptanceCriteriaVersion":"1","taskIds":["task-1"],"dependencyIds":[]}',
      'loom.release': '{"taskId":"task-1","planId":"plan-selftest","missionId":"mission-selftest","status":"released"}',
      'loom.claim': '{"claimId":"claim-selftest","taskId":"task-1","fenceGeneration":1,"leaseExpiresAt":"2024-01-01T00:00:00Z","replayed":false}',
      'loom.evidence': `{"artifact":{"artifactId":"${evidenceArtifactId}","relativePath":"acceptance.pptx","sha256":"${'0'.repeat(64)}","sizeBytes":128},"replayed":false}`,
      'loom.submit': '{"candidateId":"candidate-selftest","taskId":"task-1","verificationStatus":"pending","acceptanceStatus":"pending","replayed":false}'
    }
    const exchanges = []
    const issued = []
    for (const operation of expectedOperations) {
      const reply = await rawPost(port, '/v1/chat/completions', missionBody(exchanges))
      const deltas = toolCallDeltas(reply)
      const call = deltas[0] ?? null
      let parsedArguments = null
      try { parsedArguments = JSON.parse(String(call?.function?.arguments ?? '')) } catch { parsedArguments = null }
      check(`Mission turn ${issued.length + 1} answers exactly one rovai_loom ${operation} tool call`,
        reply.status === 200
        && String(reply.headers['content-type']).startsWith('text/event-stream')
        && deltas.length === 1
        && call?.type === 'function'
        && call?.function?.name === MISSION_TOOL_NAME
        && parsedArguments?.operation === operation
        && reply.text.includes('"finish_reason":"tool_calls"')
        && reply.text.trimEnd().endsWith('data: [DONE]'),
        `got ${String(parsedArguments?.operation ?? 'no tool call')}`)
      check(`Mission turn ${issued.length + 1} sends no assistant content beside the tool call`,
        !sseChunks(reply.text).some((chunk) => {
          const content = chunk?.choices?.[0]?.delta?.content
          return typeof content === 'string' && content.length > 0
        }))
      if (!call || !parsedArguments || parsedArguments.operation !== operation) break
      issued.push({ operation, id: call.id, input: parsedArguments.input ?? null })
      pushExchange(exchanges, call, stepResults[operation])
    }
    check('the six Mission operations were issued in the goal order',
      issued.map((entry) => entry.operation).join(' -> ') === expectedOperations.join(' -> '),
      issued.map((entry) => entry.operation).join(' -> '))
    check('every Mission tool_call id encodes its step and operation',
      issued.length === MISSION_STEPS.length && issued.every((entry, index) => entry.id === missionToolCallId(index, entry.operation)),
      issued.map((entry) => entry.id).join(','))
    const planInput = issued[1]?.input
    check('loom.plan carries exactly one task-1 assigned to the member id from the goal',
      planInput?.tasks?.length === 1
      && planInput.tasks[0].taskId === MISSION_TASK_ID
      && planInput.tasks[0].assigneeAgentId === missionMember
      && Array.isArray(planInput.criteria) && planInput.criteria.length >= 1,
      JSON.stringify(planInput?.tasks?.[0] ?? null))
    check('loom.release and loom.claim name task-1',
      issued[2]?.input?.taskId === MISSION_TASK_ID && issued[3]?.input?.taskId === MISSION_TASK_ID)
    check('loom.evidence registers acceptance.pptx for task-1',
      issued[4]?.input?.relativePath === MISSION_EVIDENCE_PATH && issued[4]?.input?.taskId === MISSION_TASK_ID)
    check('loom.submit submits the artifactId read back from the evidence tool result',
      issued[5]?.input?.taskId === MISSION_TASK_ID
      && JSON.stringify(issued[5]?.input?.evidenceIds) === JSON.stringify([evidenceArtifactId]),
      JSON.stringify(issued[5]?.input ?? null))

    const missionCompletion = await rawPost(port, '/v1/chat/completions', missionBody(exchanges))
    check('the Mission ends with one plain short completion and no further tool call',
      missionCompletion.status === 200
      && !missionCompletion.text.includes('"tool_calls"')
      && missionCompletion.text.includes('"finish_reason":"stop"')
      && sseContent(missionCompletion.text) === MISSION_COMPLETION_TEXT,
      JSON.stringify(sseContent(missionCompletion.text)))

    // An evidence result that carries no identifier must fail honestly, never with result.md.
    const missingIdExchanges = []
    for (let index = 0; index < MISSION_EVIDENCE_STEP_INDEX + 1; index += 1) {
      const operation = expectedOperations[index]
      const id = missionToolCallId(index, operation)
      missingIdExchanges.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: MISSION_TOOL_NAME, arguments: JSON.stringify({ operation, input: {} }) } }] })
      missingIdExchanges.push({
        role: 'tool',
        tool_call_id: id,
        content: index === MISSION_EVIDENCE_STEP_INDEX
          ? '{"artifact":{"relativePath":"acceptance.pptx"},"replayed":false}'
          : '{"ok":true}'
      })
    }
    const honestFail = await rawPost(port, '/v1/chat/completions', missionBody(missingIdExchanges))
    check('an evidence result without any artifact identifier fails honestly with an empty completion',
      honestFail.status === 200
      && sseContent(honestFail.text) === ''
      && !honestFail.text.includes('"tool_calls"')
      && honestFail.text.includes('"finish_reason":"stop"'))

    const missionTotals = readJson(requestsFile).totals
    check('Mission requests are counted apart from plain replies',
      missionTotals.missionRequests === 10
      && missionTotals.missionToolCalls === 7
      && missionTotals.missionCompletions === 1
      && missionTotals.missionFailures === 2,
      JSON.stringify({
        requests: missionTotals.missionRequests,
        toolCalls: missionTotals.missionToolCalls,
        completions: missionTotals.missionCompletions,
        failures: missionTotals.missionFailures
      }))
    const missionRecords = readJson(requestsFile).requests.filter((entry) => entry.mission === true)
    check('Mission records name only the step and the operation',
      missionRecords.length === 10
      && missionRecords.some((entry) => entry.missionOperation === 'loom.evidence' && entry.missionStep === 5)
      && missionRecords.some((entry) => entry.missionOperation === 'loom.plan' && entry.missionMemberFromGoal === true)
      && missionRecords.some((entry) => entry.replyKind === 'mission-tool-call')
      && missionRecords.some((entry) => entry.replyKind === 'mission-completion')
      && missionRecords.some((entry) => entry.replyKind === 'mission-failed' && entry.missionFailureReason)
      && missionRecords.every((entry) => !JSON.stringify(entry).includes(missionMember)),
      JSON.stringify(missionRecords.at(-1) ?? null))

    const big = await rawPost(port, '/v1/chat/completions', `{"model":"m","pad":"${'x'.repeat(MAX_BODY_BYTES)}"}`)
    check('body over 1 MiB is rejected with 413', big.status === 413, String(big.status))

    const badJson = await rawPost(port, '/v1/chat/completions', '{not json')
    check('invalid JSON is rejected with 400', badJson.status === 400, String(badJson.status))

    const wrongPath = await rawPost(port, '/v1/models', { model: 'm' })
    check('non chat-completions path is rejected with 404', wrongPath.status === 404, String(wrongPath.status))

    const recordsText = readFileSync(requestsFile, 'utf8')
    check('requests-file persists no prompt body', !recordsText.includes(nonce) && !recordsText.includes(marker) && !recordsText.includes('prompt-selftest'))
    check('requests-file persists no Mission goal, member id, file path or tool name',
      !recordsText.includes(missionMember)
      && !recordsText.includes(MISSION_EVIDENCE_PATH)
      && !recordsText.includes('Windows real-install acceptance')
      && !recordsText.includes(MISSION_TOOL_NAME)
      && !recordsText.includes(evidenceArtifactId))
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
  console.log('never-finishing stall until client disconnect, 1 MiB cap, 400/404 rejects, the pptx')
  console.log('Mission rovai_loom chain (status -> plan -> release -> claim -> evidence -> submit),')
  console.log('and a requests-file that records counts/lengths/stall flags/operation names only.')
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

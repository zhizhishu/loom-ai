// LOOM V2 P1-C · 两 Bot 真 Pi 并发 loopback runner — 两个真实 Pi 0.85.1 RPC 进程 + 各自独立
// profile + 各自独立 127.0.0.1 随机端口 fake provider，同轮并发执行。
//
// Scope (P1-C handoff 2026-11-15, 交接文档 :19 「真正的两个受管 Pi RPC 进程」→ 「两个 Worker 真执行」的最小补齐):
// - Two bots, exactly two. Each bot gets its OWN `createLoopbackProvider()` (own 127.0.0.1:0 OS-assigned
//   port) and its OWN `mkdtemp` temp root + `createIsolatedPiProfile()` profile. Nothing is shared.
// - The two real Pi processes are launched CONCURRENTLY (`Promise.allSettled`), not serially: the runner
//   records each worker's start/finish wall-clock and fails closed unless the two intervals genuinely
//   overlap.
// - Every bot must produce, on its own: a real `agent_settled` event, at least one real chat-completion
//   request seen by ITS fake provider, a distinct sessionId, a distinct profile, and its own
//   providerSystemPromptSha256 list. With the default bot set (one `off`, one `append`) the last system
//   prompt hash MUST differ between the two workers; otherwise the purge never reached the provider and
//   the run fails closed.
// - Evidence ceiling is identical to scripts/loom-v2-pi-loopback-provider.mjs: only sha256 digests,
//   byte counts, booleans and counters leave this module. No system prompt text, no user message body,
//   no api key, no authorization header. `assertNoSecrets()` enforces that on the finished evidence and
//   throws if anything key-shaped appears.
// - Envelope is fixed and narrow: { mockProvider:true, providerPromptSeen:true, realExternalProvider:false,
//   coreIntegrated:false, realCommercialModel:false, userCredentialsUsed:false }. This module is NOT Core
//   integration, produces no Artifact/Review, and never claims a real commercial model ran.
// - Teardown is fail-closed and never masked: every provider socket is closed, every temp root is
//   removed, and any cleanup failure is re-thrown (AggregateError alongside the primary error) instead of
//   being swallowed into a green result.
// - This module never touches: the real user ~/.pi, any user database, the five pre-existing WIP files,
//   port 64851, Bero/GitHub, the Pi bundle sources, the staged pi-purge sources, or the private
//   _artifacts/loom-v2-20261115/p1b-sandbox profile dirs (all state is mkdtemp + removed).
// - It imports the already-accepted loopback provider module and modifies nothing in it.

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  ALLOWED_CHAT_PATH,
  DUMMY_API_KEY,
  LOOPBACK_HOST,
  LOOPBACK_PROVIDER_ID,
  MOCK_ASSISTANT_REPLY,
  MOCK_MODEL_ID,
  PI_BUNDLE_LOCKED_VERSION,
  PI_PURGE_COMMIT,
  PI_PURGE_EXTENSION_SHA256,
  PI_PURGE_STAGE_DIRNAME,
  assertPinnedPiBundle,
  assertStagedPiPurge,
  createIsolatedPiProfile,
  createLoopbackProvider,
  defaultP1bSandboxRoot,
  defaultPiBin,
  runPiLoopbackScenario,
  sha256Hex
} from './loom-v2-pi-loopback-provider.mjs'

// ---------------------------------------------------------------------------
// Locked contract constants
// ---------------------------------------------------------------------------

/** Same id grammar as scripts/loom-pi-purge-bridge.mjs:54 — a botId is an opaque validated label here. */
export const BOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/
export const WORKER_MODES = Object.freeze(['off', 'append'])
export const TWO_WORKER_COUNT = 2
export const DEFAULT_TWO_WORKER_PROMPT =
  'Please reply with one short sentence confirming you received this harmless local loopback test message.'

/** One worker stays purge-off, the other turns purge on, so the OFF/APPEND prompt difference is observable. */
export const TWO_WORKER_DEFAULT_BOTS = Object.freeze([
  Object.freeze({ botId: 'bot_worker_a', mode: 'off' }),
  Object.freeze({ botId: 'bot_worker_b', mode: 'append' })
])

/**
 * The only evidence envelope this module may ever claim.
 * mockProvider/providerPromptSeen describe THIS local fake provider; realExternalProvider,
 * coreIntegrated, realCommercialModel and userCredentialsUsed are permanently false.
 */
export const TWO_WORKER_EVIDENCE_ENVELOPE = Object.freeze({
  mockProvider: true,
  providerPromptSeen: true,
  realExternalProvider: false,
  coreIntegrated: false,
  realCommercialModel: false,
  userCredentialsUsed: false
})

const SECRET_SHAPES = Object.freeze([
  { label: 'dummy_api_key_leaked', test: (text) => text.includes(DUMMY_API_KEY) },
  { label: 'provider_key_shape_leaked', test: (text) => /sk-[A-Za-z0-9]{8,}/.test(text) },
  { label: 'authorization_header_leaked', test: (text) => /"authorization"/i.test(text) },
  { label: 'api_key_field_leaked', test: (text) => /"apiKey"/.test(text) }
])

// ---------------------------------------------------------------------------
// Input validation (fail closed before any process or socket exists)
// ---------------------------------------------------------------------------

export function assertBotId(botId) {
  if (typeof botId !== 'string' || !BOT_ID_PATTERN.test(botId)) {
    throw new Error(`botId must match ${String(BOT_ID_PATTERN)} (got ${JSON.stringify(botId)})`)
  }
  return botId
}

/** Normalize and validate the two-bot set. Exactly two distinct bots, each with a known mode. */
export function normalizeTwoWorkerBots(bots = TWO_WORKER_DEFAULT_BOTS) {
  if (!Array.isArray(bots) || bots.length !== TWO_WORKER_COUNT) {
    const actual = Array.isArray(bots) ? `array(${bots.length})` : typeof bots
    throw new Error(`two-worker loopback requires exactly ${TWO_WORKER_COUNT} bots, got ${actual}`)
  }
  const seen = new Set()
  return bots.map((bot, index) => {
    if (!bot || typeof bot !== 'object' || Array.isArray(bot)) {
      throw new Error(`bots[${index}] must be a plain object`)
    }
    const botId = assertBotId(bot.botId)
    if (seen.has(botId)) throw new Error(`duplicate botId in the two-worker set: ${botId}`)
    seen.add(botId)
    const mode = bot.mode ?? 'off'
    if (!WORKER_MODES.includes(mode)) {
      throw new Error(`bots[${index}].mode must be one of ${WORKER_MODES.join('|')}, got ${String(mode)}`)
    }
    return Object.freeze({ botId, mode })
  })
}

/** Throw if the evidence (or any string) carries a key, an authorization header or a key-shaped token. */
export function assertNoSecrets(value, { label = 'two-worker loopback evidence' } = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const violations = SECRET_SHAPES.filter((shape) => shape.test(text)).map((shape) => shape.label)
  if (violations.length > 0) {
    throw new Error(`${label} contains secret material: ${violations.join(',')}`)
  }
  return true
}

// ---------------------------------------------------------------------------
// Per-worker isolation (own provider socket + own temp root + own profile)
// ---------------------------------------------------------------------------

async function prepareWorker(bot) {
  const provider = await createLoopbackProvider()
  let parentDir = null
  try {
    parentDir = await mkdtemp(join(tmpdir(), 'loom-v2-two-worker-'))
    const profile = await createIsolatedPiProfile({
      parentDir,
      port: provider.port,
      name: `pi-${bot.botId}`
    })
    return { bot, provider, parentDir, profile }
  } catch (error) {
    // Fail closed on a half-built worker: never leak a bound socket or a temp root.
    try { await provider.close() } catch {}
    if (parentDir) { try { await rm(parentDir, { recursive: true, force: true }) } catch {} }
    throw error
  }
}

function assertWorkerIsolation(prepared) {
  const ports = prepared.map((worker) => worker.provider.port)
  const agentDirs = prepared.map((worker) => resolve(worker.profile.agentDir))
  const roots = prepared.map((worker) => resolve(worker.parentDir))

  if (new Set(ports).size !== ports.length) {
    throw new Error(`two workers must not share a loopback port: ${JSON.stringify(ports)}`)
  }
  if (new Set(agentDirs).size !== agentDirs.length) {
    throw new Error(`two workers must not share a Pi profile dir: ${JSON.stringify(agentDirs)}`)
  }
  if (new Set(roots).size !== roots.length) {
    throw new Error(`two workers must not share a temp root: ${JSON.stringify(roots)}`)
  }
  for (const worker of prepared) {
    if (worker.provider.host !== LOOPBACK_HOST) {
      throw new Error(`worker ${worker.bot.botId} provider bound ${worker.provider.host}, not ${LOOPBACK_HOST}`)
    }
    if (!resolve(worker.profile.agentDir).startsWith(resolve(worker.parentDir))) {
      throw new Error(`worker ${worker.bot.botId} profile dir escaped its temp root`)
    }
    if (!worker.profile.baseUrl.endsWith(`:${worker.provider.port}/v1`)) {
      throw new Error(`worker ${worker.bot.botId} profile baseUrl ${worker.profile.baseUrl} is not its own port ${worker.provider.port}`)
    }
  }
  return { distinctPorts: true, distinctAgentDirs: true, distinctTempRoots: true }
}

/**
 * Read back the generated profile and prove it points at THIS worker's loopback port with the dummy
 * test key. Read-only; the key itself never leaves this function.
 */
async function verifyProfileWiring(worker) {
  const botId = worker.bot.botId
  const models = JSON.parse(await readFile(worker.profile.modelsPath, 'utf8'))
  const settings = JSON.parse(await readFile(worker.profile.settingsPath, 'utf8'))
  const auth = JSON.parse(await readFile(worker.profile.authPath, 'utf8'))

  const provider = models?.providers?.[LOOPBACK_PROVIDER_ID]
  if (!provider) throw new Error(`worker ${botId} profile has no ${LOOPBACK_PROVIDER_ID} provider entry`)

  const expectedBaseUrl = `http://${LOOPBACK_HOST}:${worker.provider.port}/v1`
  if (provider.baseUrl !== expectedBaseUrl) {
    throw new Error(`worker ${botId} profile baseUrl ${String(provider.baseUrl)} != own ${expectedBaseUrl}`)
  }
  if (provider.api !== 'openai-completions') {
    throw new Error(`worker ${botId} profile api ${String(provider.api)} != openai-completions`)
  }
  const modelIds = Array.isArray(provider.models) ? provider.models.map((model) => model?.id) : []
  if (!modelIds.includes(MOCK_MODEL_ID)) {
    throw new Error(`worker ${botId} profile does not expose ${MOCK_MODEL_ID}: ${JSON.stringify(modelIds)}`)
  }
  if (settings?.defaultProvider !== LOOPBACK_PROVIDER_ID || settings?.defaultModel !== MOCK_MODEL_ID) {
    throw new Error(`worker ${botId} settings do not default to the loopback mock model: ${JSON.stringify(settings)}`)
  }
  if (auth?.[LOOPBACK_PROVIDER_ID]?.key !== DUMMY_API_KEY) {
    throw new Error(`worker ${botId} profile auth key is not the loopback dummy test key`)
  }
  return { baseUrl: expectedBaseUrl, api: 'openai-completions', modelId: MOCK_MODEL_ID, apiKeyIsDummy: true }
}

// ---------------------------------------------------------------------------
// Concurrent execution of the two real Pi processes
// ---------------------------------------------------------------------------

async function runWorkersConcurrently({ prepared, piBin, staged, prompt, requestTimeoutMs, promptTimeoutMs }) {
  const timings = prepared.map(() => ({ startedAt: 0, finishedAt: 0 }))

  const settled = await Promise.allSettled(prepared.map((worker, index) => {
    const options = {
      piBin,
      extensionPath: staged.extensionPath,
      profile: worker.profile,
      provider: worker.provider,
      mode: worker.bot.mode,
      prompt
    }
    if (requestTimeoutMs !== undefined) options.requestTimeoutMs = requestTimeoutMs
    if (promptTimeoutMs !== undefined) options.promptTimeoutMs = promptTimeoutMs
    timings[index].startedAt = Date.now()
    return runPiLoopbackScenario(options).then(
      (value) => {
        timings[index].finishedAt = Date.now()
        return value
      },
      (error) => {
        timings[index].finishedAt = Date.now()
        throw error
      }
    )
  }))

  const failures = []
  settled.forEach((entry, index) => {
    if (entry.status === 'rejected') {
      const reason = entry.reason instanceof Error ? entry.reason.message : String(entry.reason)
      failures.push(new Error(`worker ${prepared[index].bot.botId} (${prepared[index].bot.mode}) failed: ${reason}`))
    }
  })
  if (failures.length > 0) {
    throw new AggregateError(failures, `two-worker loopback run failed for ${failures.length}/${prepared.length} workers`)
  }
  return { results: settled.map((entry) => entry.value), timings }
}

function buildWorkerEvidence({ worker, result, timing }) {
  const botId = worker.bot.botId
  const requests = Array.isArray(result.providerRequests) ? result.providerRequests : []

  if (result.mockProvider !== true) throw new Error(`worker ${botId} did not report mockProvider=true`)
  if (result.realExternalProvider !== false) throw new Error(`worker ${botId} reported realExternalProvider!=false`)
  if (result.providerPromptSeen !== true) throw new Error(`worker ${botId} did not observe a provider prompt`)
  if (result.agentSettledObserved !== true) throw new Error(`worker ${botId} did not observe a real agent_settled`)
  if (result.purgeCommandFound !== true) throw new Error(`worker ${botId} did not load the staged pi-purge command`)
  if (result.purgeSourceMatches !== true) {
    throw new Error(`worker ${botId} purge source ${String(result.purgeSourcePath)} is not the staged extension`)
  }
  if (typeof result.sessionId !== 'string' || result.sessionId.length === 0) {
    throw new Error(`worker ${botId} produced no sessionId`)
  }
  if (requests.length < 1) throw new Error(`worker ${botId} produced no provider request`)

  const hashes = []
  const promptBytes = []
  for (const request of requests) {
    if (typeof request.systemPrompt !== 'string' || request.systemPrompt.length === 0) {
      throw new Error(`worker ${botId} provider request carried no system prompt`)
    }
    const recomputed = sha256Hex(request.systemPrompt)
    if (request.systemPromptSha256 !== recomputed) {
      throw new Error(`worker ${botId} systemPromptSha256 does not match the recorded prompt bytes`)
    }
    if (request.remoteAddress !== LOOPBACK_HOST) {
      throw new Error(`worker ${botId} provider request came from ${String(request.remoteAddress)}, not ${LOOPBACK_HOST}`)
    }
    if (request.path !== ALLOWED_CHAT_PATH) {
      throw new Error(`worker ${botId} provider request used path ${String(request.path)}`)
    }
    if (request.model !== MOCK_MODEL_ID) {
      throw new Error(`worker ${botId} provider request asked for model ${String(request.model)}`)
    }
    if (request.toolsSchema !== null) {
      throw new Error(`worker ${botId} provider request carried a tool schema; the --no-tools contract broke`)
    }
    if (request.authorizationIsDummyBearer !== true) {
      throw new Error(`worker ${botId} provider request did not use the loopback dummy test key`)
    }
    hashes.push(recomputed)
    promptBytes.push(Buffer.byteLength(request.systemPrompt, 'utf8'))
  }

  const assistantReply = typeof result.assistantReply === 'string' ? result.assistantReply : ''
  const notifyMessages = Array.isArray(result.notifyMessages) ? result.notifyMessages : []
  // The reply must come from the local fake provider; accept the exact fixture text or its marker.
  const assistantReplyFromMockProvider = assistantReply.includes(MOCK_ASSISTANT_REPLY)
    || assistantReply.includes('loopback mock reply')

  return {
    botId,
    mode: worker.bot.mode,
    providerPort: worker.provider.port,
    // Temp profile dir; its parent is removed in the runner's teardown (proof of cleanup for tests).
    agentDir: worker.profile.agentDir,
    sessionId: result.sessionId,
    model: result.model ?? null,
    agentSettledObserved: true,
    settledEventIndex: result.settledEventIndex,
    messageCountAfter: result.messageCountAfter ?? null,
    providerRequestCount: requests.length,
    providerSystemPromptSha256: hashes,
    providerSystemPromptSha256Verified: true,
    providerSystemPromptBytes: promptBytes,
    assistantReplyFromMockProvider,
    assistantReplyLength: assistantReply.length,
    purgeCommandFound: true,
    purgeSourceMatches: true,
    notifyCount: notifyMessages.length,
    loopbackOnly: true,
    dummyAuthOnly: true,
    toolsSchemaAbsent: true,
    startedAt: timing.startedAt,
    finishedAt: timing.finishedAt,
    durationMs: Math.max(0, timing.finishedAt - timing.startedAt)
  }
}

function assertCrossWorkerContract(workers, concurrency) {
  if (!concurrency.overlapped) {
    throw new Error(
      `the two Pi workers did not actually run concurrently (latest start ${concurrency.latestStart} >= earliest end ${concurrency.earliestEnd})`
    )
  }
  if (new Set(workers.map((worker) => worker.sessionId)).size !== workers.length) {
    throw new Error(`the two workers shared a sessionId: ${JSON.stringify(workers.map((worker) => worker.sessionId))}`)
  }

  const lastHash = (worker) => worker.providerSystemPromptSha256[worker.providerSystemPromptSha256.length - 1]
  const hashesDiffer = lastHash(workers[0]) !== lastHash(workers[1])
  const modes = new Set(workers.map((worker) => worker.mode))
  if (modes.has('off') && modes.has('append') && !hashesDiffer) {
    throw new Error(
      'the OFF worker and the APPEND worker saw the same system prompt hash; the purge never reached the provider'
    )
  }
  return { systemPromptHashesDiffer: hashesDiffer }
}

function computeConcurrency(timings) {
  const starts = timings.map((timing) => timing.startedAt)
  const ends = timings.map((timing) => timing.finishedAt)
  const latestStart = Math.max(...starts)
  const earliestEnd = Math.min(...ends)
  return {
    latestStart,
    earliestEnd,
    overlapped: latestStart < earliestEnd,
    overlapWindowMs: Math.max(0, earliestEnd - latestStart),
    totalWallClockMs: Math.max(0, Math.max(...ends) - Math.min(...starts))
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the two-bot real-Pi loopback scenario.
 *
 * @param {object} [options]
 * @param {ReadonlyArray<{botId: string, mode?: 'off'|'append'}>} [options.bots] exactly two bots
 * @param {string} [options.prompt] harmless user prompt sent to both workers
 * @param {boolean} [options.preflightOnly] identity + isolation + profile wiring only, no Pi spawn
 * @param {string} [options.piBin] test-only override; still verified against the pinned bundle identity
 */
export async function runTwoWorkerLoopbackEvidence({
  bots = TWO_WORKER_DEFAULT_BOTS,
  prompt = DEFAULT_TWO_WORKER_PROMPT,
  preflightOnly = false,
  piBin = defaultPiBin(),
  requestTimeoutMs,
  promptTimeoutMs
} = {}) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('two-worker loopback requires a non-empty harmless prompt')
  }
  const normalizedBots = normalizeTwoWorkerBots(bots)

  // Identity lock first: nothing is spawned or bound before the pinned identities verify.
  const piBundle = await assertPinnedPiBundle(piBin)
  if (piBundle.piVersion !== PI_BUNDLE_LOCKED_VERSION) {
    throw new Error(`pinned Pi bundle version drift: ${String(piBundle.piVersion)} != ${PI_BUNDLE_LOCKED_VERSION}`)
  }
  const stageDir = join(defaultP1bSandboxRoot(), PI_PURGE_STAGE_DIRNAME)
  const staged = assertStagedPiPurge(stageDir)
  if (staged.commit !== PI_PURGE_COMMIT) {
    throw new Error(`staged pi-purge commit drift: ${String(staged.commit)} != ${PI_PURGE_COMMIT}`)
  }
  if (staged.extensionSha256 !== PI_PURGE_EXTENSION_SHA256) {
    throw new Error(`staged pi-purge.ts sha256 drift: ${String(staged.extensionSha256)} != ${PI_PURGE_EXTENSION_SHA256}`)
  }

  const prepared = []
  let evidence = null
  let mainError = null

  try {
    for (const bot of normalizedBots) {
      prepared.push(await prepareWorker(bot))
    }
    const isolation = assertWorkerIsolation(prepared)

    if (preflightOnly) {
      const workers = []
      for (const worker of prepared) {
        const wiring = await verifyProfileWiring(worker)
        workers.push({
          botId: worker.bot.botId,
          mode: worker.bot.mode,
          providerPort: worker.provider.port,
          agentDir: worker.profile.agentDir,
          baseUrl: wiring.baseUrl,
          api: wiring.api,
          modelId: wiring.modelId,
          apiKeyIsDummy: wiring.apiKeyIsDummy,
          piLaunched: false
        })
      }
      evidence = {
        ok: true,
        ...TWO_WORKER_EVIDENCE_ENVELOPE,
        // Honesty override: preflight binds sockets and wires profiles but never prompts a model.
        providerPromptSeen: false,
        preflightOnly: true,
        piBundle: { piVersion: piBundle.piVersion, launcher: piBundle.launcher },
        stagedExtension: {
          commit: staged.commit,
          extensionSha256: staged.extensionSha256,
          treeSha256: staged.treeSha256
        },
        isolation,
        workers,
        prompt
      }
    } else {
      const { results, timings } = await runWorkersConcurrently({
        prepared,
        piBin,
        staged,
        prompt,
        requestTimeoutMs,
        promptTimeoutMs
      })
      const workers = prepared.map((worker, index) => buildWorkerEvidence({
        worker,
        result: results[index],
        timing: timings[index]
      }))
      const concurrency = computeConcurrency(timings)
      const crossWorker = assertCrossWorkerContract(workers, concurrency)
      evidence = {
        ok: true,
        ...TWO_WORKER_EVIDENCE_ENVELOPE,
        preflightOnly: false,
        piBundle: { piVersion: piBundle.piVersion, launcher: piBundle.launcher },
        stagedExtension: {
          commit: staged.commit,
          extensionSha256: staged.extensionSha256,
          treeSha256: staged.treeSha256
        },
        isolation,
        concurrency: {
          ...concurrency,
          distinctPorts: isolation.distinctPorts,
          distinctAgentDirs: isolation.distinctAgentDirs,
          distinctSessionIds: new Set(workers.map((worker) => worker.sessionId)).size === workers.length
        },
        ...crossWorker,
        workers,
        prompt
      }
    }
    assertNoSecrets(evidence)
  } catch (error) {
    mainError = error
  }

  const cleanupErrors = []
  for (const worker of prepared) {
    try {
      await worker.provider.close()
    } catch (error) {
      cleanupErrors.push(new Error(`provider close failed for ${worker.bot.botId}: ${error instanceof Error ? error.message : String(error)}`))
    }
  }
  for (const worker of prepared) {
    if (!worker.parentDir) continue
    try {
      await rm(worker.parentDir, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(new Error(`temp profile removal failed for ${worker.bot.botId}: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  if (cleanupErrors.length > 0) {
    const errors = mainError ? [mainError, ...cleanupErrors] : cleanupErrors
    throw new AggregateError(errors, 'two-worker loopback teardown failed; refusing to report a green run')
  }
  if (mainError) throw mainError
  return evidence
}

// ---------------------------------------------------------------------------
// Direct CLI entry: node scripts/loom-v2-two-worker-loopback.mjs
// ---------------------------------------------------------------------------

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  runTwoWorkerLoopbackEvidence()
    .then((evidence) => {
      console.log(JSON.stringify(evidence, null, 2))
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error))
      process.exitCode = 1
    })
}

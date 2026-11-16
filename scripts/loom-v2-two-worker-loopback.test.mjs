// LOOM V2 P1-C · Tests for the two-bot concurrent real-Pi loopback runner.
//
// Run (Root, from loom/):  node --test --test-force-exit --test-timeout=420000 scripts/loom-v2-two-worker-loopback.test.mjs
//
// Coverage contract:
//   1. input contract      — botId grammar, exactly two distinct bots, known modes, prompt required
//   2. evidence envelope   — mockProvider=true / realExternalProvider=false / coreIntegrated=false and
//                            assertNoSecrets() rejects any key, authorization header or key-shaped token
//   3. identity lock       — pinned Pi 0.85.1 bundle + staged pi-purge (commit + pi-purge.ts sha256) are
//                            verified BEFORE anything binds or spawns; identity drift fails closed and
//                            leaves no temp root behind
//   4. isolation           — preflight: two workers get distinct 127.0.0.1 ports, distinct temp roots,
//                            distinct profile dirs, each profile wired to its own port with the dummy key
//   5. repeatability       — two consecutive preflight rounds succeed and never reuse a temp root
//   6. concurrent real run — both real Pi processes overlap in wall-clock time, each emits its own real
//                            agent_settled + its own provider request, distinct sessionIds, no tool
//                            schema, dummy bearer only, OFF/APPEND system prompt hashes differ
//   7. teardown            — every fake-provider port is closed after the run and every temp root is gone
//
// No test talks to the public internet, a real model, the user's real ~/.pi, a user database or any
// credential store. All Pi state lives in mkdtemp temp dirs and is removed by the runner's teardown.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  BOT_ID_PATTERN,
  DEFAULT_TWO_WORKER_PROMPT,
  TWO_WORKER_DEFAULT_BOTS,
  TWO_WORKER_EVIDENCE_ENVELOPE,
  assertBotId,
  assertNoSecrets,
  normalizeTwoWorkerBots,
  runTwoWorkerLoopbackEvidence
} from './loom-v2-two-worker-loopback.mjs'
import {
  DUMMY_API_KEY,
  LOOPBACK_HOST,
  MOCK_MODEL_ID,
  PI_BUNDLE_LOCKED_VERSION,
  PI_PURGE_COMMIT,
  PI_PURGE_EXTENSION_SHA256
} from './loom-v2-pi-loopback-provider.mjs'

const PI_TEST_TIMEOUT_MS = 420_000

// Populated by the concurrent real-run test; consumed by the teardown test.
// node:test runs top-level tests serially, so a missing value can only mean the real run failed —
// the teardown test then fails closed instead of passing vacuously.
const shared = { evidence: null }

// ---------------------------------------------------------------------------
// 1 · input contract
// ---------------------------------------------------------------------------

test('two-worker input contract: botId grammar, exactly two distinct bots, known modes, non-empty prompt', { timeout: 30_000 }, async () => {
  assert.ok(BOT_ID_PATTERN instanceof RegExp)
  assert.equal(assertBotId('bot_worker_a'), 'bot_worker_a')
  for (const bad of ['', 'a', ' bot', 'bot/a', 'bot a', 'bot\\a', 42, null, undefined, {}]) {
    assert.throws(() => assertBotId(bad), /botId must match/, `botId ${JSON.stringify(bad)} must be rejected`)
  }

  const defaults = normalizeTwoWorkerBots()
  assert.equal(defaults.length, 2)
  assert.deepEqual(defaults.map((bot) => bot.botId), ['bot_worker_a', 'bot_worker_b'])
  assert.deepEqual(defaults.map((bot) => bot.mode), ['off', 'append'],
    'the default pair must differ in purge mode so the OFF/APPEND prompt change is observable')
  assert.equal(Object.isFrozen(defaults[0]), true)

  // mode defaults to off when omitted.
  assert.deepEqual(
    normalizeTwoWorkerBots([{ botId: 'bot_x' }, { botId: 'bot_y' }]).map((bot) => bot.mode),
    ['off', 'off']
  )

  assert.throws(() => normalizeTwoWorkerBots([{ botId: 'bot_x' }]), /exactly 2 bots/)
  assert.throws(() => normalizeTwoWorkerBots([{ botId: 'bot_x' }, { botId: 'bot_y' }, { botId: 'bot_z' }]), /exactly 2 bots/)
  assert.throws(() => normalizeTwoWorkerBots('nope'), /exactly 2 bots/)
  assert.throws(() => normalizeTwoWorkerBots([{ botId: 'bot_x' }, { botId: 'bot_x' }]), /duplicate botId/)
  assert.throws(() => normalizeTwoWorkerBots([{ botId: 'bot_x', mode: 'strict' }, { botId: 'bot_y' }]), /mode must be one of/)
  assert.throws(() => normalizeTwoWorkerBots([null, { botId: 'bot_y' }]), /must be a plain object/)

  // A bad bot set or an empty prompt must fail before any socket or process exists.
  await assert.rejects(
    () => runTwoWorkerLoopbackEvidence({ bots: [{ botId: 'bot_only_one' }] }),
    /exactly 2 bots/
  )
  await assert.rejects(() => runTwoWorkerLoopbackEvidence({ prompt: '   ' }), /non-empty harmless prompt/)
})

// ---------------------------------------------------------------------------
// 2 · evidence envelope + secret guard
// ---------------------------------------------------------------------------

test('evidence envelope is loopback-only and assertNoSecrets rejects any key, authorization header or key-shaped token', { timeout: 30_000 }, async () => {
  assert.deepEqual({ ...TWO_WORKER_EVIDENCE_ENVELOPE }, {
    mockProvider: true,
    providerPromptSeen: true,
    realExternalProvider: false,
    coreIntegrated: false,
    realCommercialModel: false,
    userCredentialsUsed: false
  })

  // Clean evidence passes.
  assert.equal(assertNoSecrets({
    botId: 'bot_worker_a',
    providerSystemPromptSha256: ['0'.repeat(64)],
    apiKeyIsDummy: true,
    dummyAuthOnly: true
  }), true)

  // The dummy loopback key must never appear in evidence.
  assert.throws(() => assertNoSecrets({ leaked: DUMMY_API_KEY }), /dummy_api_key_leaked/)
  // A real-provider-shaped token must never appear either.
  assert.throws(() => assertNoSecrets({ leaked: `sk-${'a'.repeat(24)}` }), /provider_key_shape_leaked/)
  // An authorization header must not be echoed.
  assert.throws(() => assertNoSecrets({ authorization: 'Bearer x' }), /authorization_header_leaked/)
  // A raw apiKey field must not be echoed.
  assert.throws(() => assertNoSecrets({ apiKey: 'anything' }), /api_key_field_leaked/)
  // String input is accepted too.
  assert.throws(() => assertNoSecrets(JSON.stringify({ k: DUMMY_API_KEY })), /dummy_api_key_leaked/)
})

// ---------------------------------------------------------------------------
// 3 · identity lock fails closed (no Pi spawn, no socket leak)
// ---------------------------------------------------------------------------

test('identity lock: pinned Pi 0.85.1 bundle and staged pi-purge verify before launch, and identity drift fails closed', { timeout: 60_000 }, async () => {
  // A path with no pi-bundle.json must be rejected by the pinned-identity check before any worker
  // socket or temp profile is created — never silently falling back to the default bundle.
  const bogusPiBin = join(tmpdir(), `loom-v2-two-worker-missing-${Date.now()}`, 'pi.exe')
  await assert.rejects(
    () => runTwoWorkerLoopbackEvidence({ preflightOnly: true, piBin: bogusPiBin }),
    (error) => {
      assert.match(String(error.message), /pinned Pi bundle identity unreadable/)
      assert.ok(String(error.message).includes('loom-v2-two-worker-missing'),
        `the rejection must name the path actually checked, got: ${error.message}`)
      return true
    }
  )

  // The real pinned identities verify and the preflight proves profile wiring without spawning Pi.
  const evidence = await runTwoWorkerLoopbackEvidence({ preflightOnly: true })
  assert.equal(evidence.ok, true)
  assert.equal(evidence.preflightOnly, true)
  assert.equal(evidence.mockProvider, true)
  assert.equal(evidence.realExternalProvider, false)
  assert.equal(evidence.coreIntegrated, false)
  assert.equal(evidence.providerPromptSeen, false,
    'preflight must never claim a provider prompt was seen: no model was prompted')
  assert.equal(evidence.piBundle.piVersion, PI_BUNDLE_LOCKED_VERSION)
  assert.equal(evidence.piBundle.launcher, 'pi.exe')
  assert.equal(evidence.stagedExtension.commit, PI_PURGE_COMMIT)
  assert.equal(evidence.stagedExtension.extensionSha256, PI_PURGE_EXTENSION_SHA256)
  assert.match(String(evidence.stagedExtension.treeSha256), /^[0-9a-f]{64}$/)
  assert.equal(evidence.prompt, DEFAULT_TWO_WORKER_PROMPT)
  assert.equal(evidence.workers.length, 2)
  for (const worker of evidence.workers) {
    assert.equal(worker.piLaunched, false, 'preflight must never spawn Pi')
    assert.equal(worker.api, 'openai-completions')
    assert.equal(worker.modelId, MOCK_MODEL_ID)
    assert.equal(worker.apiKeyIsDummy, true)
  }
  assertNoSecrets(evidence)
})

// ---------------------------------------------------------------------------
// 4 · isolation: own port, own temp root, own profile, wired to its own port
// ---------------------------------------------------------------------------

test('preflight isolation: two workers get distinct 127.0.0.1 ports, temp roots and profile dirs wired to their own port', { timeout: 60_000 }, async () => {
  const evidence = await runTwoWorkerLoopbackEvidence({ preflightOnly: true })
  const [first, second] = evidence.workers

  assert.notEqual(first.providerPort, second.providerPort, 'the two workers must not share a loopback port')
  assert.notEqual(first.agentDir, second.agentDir, 'the two workers must not share a profile dir')
  for (const worker of evidence.workers) {
    assert.ok(Number.isInteger(worker.providerPort) && worker.providerPort > 0 && worker.providerPort < 65536)
    assert.equal(worker.baseUrl, `http://${LOOPBACK_HOST}:${worker.providerPort}/v1`,
      'each profile must point at its OWN loopback port')
  }
  assert.notEqual(dirname(first.agentDir), dirname(second.agentDir), 'the two workers must not share a temp root')

  assert.deepEqual(evidence.isolation, {
    distinctPorts: true,
    distinctAgentDirs: true,
    distinctTempRoots: true
  })

  // Preflight teardown: every temp root is already gone and every port is already closed.
  for (const worker of evidence.workers) {
    await assert.rejects(() => readdir(dirname(worker.agentDir)), /ENOENT/,
      `temp root ${dirname(worker.agentDir)} must be removed by the runner`)
    await assert.rejects(
      () => fetch(`http://${LOOPBACK_HOST}:${worker.providerPort}/v1/chat/completions`, { method: 'POST' }),
      /fetch failed|ECONNREFUSED/,
      'a closed preflight provider port must refuse connections'
    )
  }
})

// ---------------------------------------------------------------------------
// 5 · repeatability of the runner (identity + isolation + teardown, no Pi)
// ---------------------------------------------------------------------------

test('repeatable: two consecutive rounds each allocate fresh isolated workers and leave nothing behind', { timeout: 90_000 }, async () => {
  const rounds = []
  for (let round = 0; round < 2; round += 1) {
    rounds.push(await runTwoWorkerLoopbackEvidence({ preflightOnly: true }))
  }

  for (const evidence of rounds) {
    assert.equal(evidence.ok, true)
    assert.equal(evidence.workers.length, 2)
    assert.equal(evidence.isolation.distinctPorts, true)
    assert.equal(evidence.isolation.distinctAgentDirs, true)
    assert.equal(evidence.isolation.distinctTempRoots, true)
    assertNoSecrets(evidence)
  }

  const allAgentDirs = rounds.flatMap((evidence) => evidence.workers.map((worker) => worker.agentDir))
  assert.equal(new Set(allAgentDirs).size, allAgentDirs.length,
    `consecutive rounds must never reuse a profile dir: ${JSON.stringify(allAgentDirs)}`)
  for (const agentDir of allAgentDirs) {
    await assert.rejects(() => readdir(dirname(agentDir)), /ENOENT/,
      `round temp root ${dirname(agentDir)} must be removed`)
  }
})

// ---------------------------------------------------------------------------
// 6 · the real thing: two concurrent Pi 0.85.1 processes, each settling on its own fake provider
// ---------------------------------------------------------------------------

test('real two-bot concurrent run: both Pi processes overlap, each settles on its own loopback provider with distinct sessionId and OFF/APPEND system prompt hashes, no tools', { timeout: PI_TEST_TIMEOUT_MS }, async () => {
  const evidence = await runTwoWorkerLoopbackEvidence()
  shared.evidence = evidence

  assert.equal(evidence.ok, true)
  assert.equal(evidence.preflightOnly, false)
  assert.equal(evidence.mockProvider, true)
  assert.equal(evidence.providerPromptSeen, true)
  assert.equal(evidence.realExternalProvider, false)
  assert.equal(evidence.coreIntegrated, false)
  assert.equal(evidence.realCommercialModel, false)
  assert.equal(evidence.userCredentialsUsed, false)
  assert.equal(evidence.piBundle.piVersion, PI_BUNDLE_LOCKED_VERSION)
  assert.equal(evidence.stagedExtension.commit, PI_PURGE_COMMIT)
  assert.equal(evidence.stagedExtension.extensionSha256, PI_PURGE_EXTENSION_SHA256)

  // --- concurrency: the two intervals must genuinely overlap ---
  assert.equal(evidence.concurrency.overlapped, true,
    `the two Pi workers must run concurrently, got ${JSON.stringify(evidence.concurrency)}`)
  assert.ok(evidence.concurrency.overlapWindowMs > 0, 'the overlap window must be positive')
  assert.equal(evidence.concurrency.distinctPorts, true)
  assert.equal(evidence.concurrency.distinctAgentDirs, true)
  assert.equal(evidence.concurrency.distinctSessionIds, true)

  // --- per-worker independent evidence ---
  assert.equal(evidence.workers.length, 2)
  assert.deepEqual(evidence.workers.map((worker) => worker.botId), TWO_WORKER_DEFAULT_BOTS.map((bot) => bot.botId))
  assert.deepEqual(evidence.workers.map((worker) => worker.mode), ['off', 'append'])

  for (const worker of evidence.workers) {
    assert.equal(worker.agentSettledObserved, true, `${worker.botId} must observe a real agent_settled`)
    assert.ok(Number.isInteger(worker.settledEventIndex) && worker.settledEventIndex >= 0)
    assert.ok(worker.providerRequestCount >= 1, `${worker.botId} must produce a real provider request`)
    assert.equal(worker.providerSystemPromptSha256.length, worker.providerRequestCount)
    for (const hash of worker.providerSystemPromptSha256) {
      assert.match(hash, /^[0-9a-f]{64}$/, `${worker.botId} system prompt hash must be a sha256 hex digest`)
    }
    assert.equal(worker.providerSystemPromptSha256Verified, true)
    for (const bytes of worker.providerSystemPromptBytes) {
      assert.ok(bytes > 0, `${worker.botId} provider request must carry a non-empty system prompt`)
    }
    assert.ok(typeof worker.sessionId === 'string' && worker.sessionId.length > 0)
    assert.equal(worker.loopbackOnly, true, `${worker.botId} requests must all come from 127.0.0.1`)
    assert.equal(worker.dummyAuthOnly, true, `${worker.botId} must only ever send the dummy test key`)
    assert.equal(worker.toolsSchemaAbsent, true, `${worker.botId} must send no tool schema (--no-tools)`)
    assert.equal(worker.assistantReplyFromMockProvider, true,
      `${worker.botId} reply must come from the local fake provider`)
    assert.equal(worker.purgeCommandFound, true)
    assert.equal(worker.purgeSourceMatches, true, `${worker.botId} purge source must be the staged extension`)
    assert.ok(worker.durationMs >= 0)
    assert.ok(worker.finishedAt >= worker.startedAt)
  }

  // The append worker must have observed the two extension notifies (/purge mode append, /purge on).
  const appendWorker = evidence.workers.find((worker) => worker.mode === 'append')
  assert.ok(appendWorker.notifyCount >= 2,
    `the append worker must observe both purge notifies, got ${appendWorker.notifyCount}`)

  // --- isolation between the two workers ---
  const [first, second] = evidence.workers
  assert.notEqual(first.sessionId, second.sessionId, 'the two workers must not share a sessionId')
  assert.notEqual(first.providerPort, second.providerPort)
  assert.notEqual(dirname(first.agentDir), dirname(second.agentDir))

  // --- OFF vs APPEND: the prompt the provider actually received must differ ---
  assert.equal(evidence.systemPromptHashesDiffer, true,
    'the OFF worker and the APPEND worker must see different system prompts')

  // --- no secrets anywhere in the evidence ---
  assertNoSecrets(evidence)
  assert.ok(!JSON.stringify(evidence).includes(DUMMY_API_KEY))
})

// ---------------------------------------------------------------------------
// 7 · teardown after the real run: ports closed, temp roots removed
// ---------------------------------------------------------------------------

test('teardown after the real run: every fake-provider port is closed and every temp profile root is removed', { timeout: 60_000 }, async () => {
  assert.ok(shared.evidence, 'the real concurrent run (test 6) must have completed; refusing to assert teardown on nothing')

  for (const worker of shared.evidence.workers) {
    await assert.rejects(
      () => fetch(`http://${LOOPBACK_HOST}:${worker.providerPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: MOCK_MODEL_ID, stream: true, messages: [] })
      }),
      /fetch failed|ECONNREFUSED/,
      `${worker.botId} provider port ${worker.providerPort} must be closed after the run`
    )
    await assert.rejects(
      () => readdir(dirname(worker.agentDir)),
      /ENOENT/,
      `${worker.botId} temp profile root ${dirname(worker.agentDir)} must be removed after the run`
    )
  }
})

// LOOM V2 E3 · Core↔Pi 集成测试。
//
// 运行（在 loom/ 下，Root 受控执行；本测试**从不** cargo build）：
//   node --test --test-force-exit --test-timeout=900000 scripts/loom-v2-core-pi-integration.test.mjs
//
// 覆盖契约：
//   1. envelope         — 缓存预构建（coldBuilt=false）+ 本机假 Provider + OwnerReview pending 的固定声明
//   2. 缺二进制失败关闭 — 缺失的缓存二进制在任何 Core/Pi 启动前就报错
//   3. 真实集成（仅 win32）— 一个真实 Core + 两个并发真实 Pi（各自本机假 Provider）：
//        · 缓存二进制 path+sha256+metadata 校验通过，且显式声明非冷构建
//        · 同一 Core DB 内先有两个真实 claim/fence，再跑 Pi；两个独立 Task 同时 ready
//        · 两个 Host-hash artifact + 两个 pending/unverified candidate
//        · OwnerReview 保持 pending：reviews 为空，Task 停在 in_review，绝不 done
//        · 事实从 Core claims/candidates/artifacts + UI bundle API 读回
//        · teardown：provider 端口关闭、Pi 临时根删除、Core fixture 删除
//
// 绝不联网、绝不真实模型、绝不碰用户日常 DB / 64851 / ~/.pi / 全局 mcp / 全局 Skill Library。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  E3_EVIDENCE_ENVELOPE,
  TASK_A,
  TASK_B,
  isUnsupportedCoreMethodError,
  resolveUiBundleFacts,
  runCorePiIntegrationEvidence,
  verifyCachedCoreBinary
} from './loom-v2-core-pi-integration.mjs'
import { DEFAULT_TWO_WORKER_PROMPT, assertNoSecrets } from './loom-v2-two-worker-loopback.mjs'
import { DUMMY_API_KEY, LOOPBACK_HOST, MOCK_MODEL_ID } from './loom-v2-pi-loopback-provider.mjs'

const INTEGRATION_TIMEOUT_MS = 900_000

// ---------------------------------------------------------------------------
// 1 · evidence envelope contract (pure; runs on every host)
// ---------------------------------------------------------------------------

test('evidence envelope declares a cached prebuild + local mock provider + pending Owner review', () => {
  assert.deepEqual({ ...E3_EVIDENCE_ENVELOPE }, {
    scope: 'E3-sandbox-only',
    binarySource: 'cached-prebuild',
    coldBuilt: false,
    cargoBuildInvoked: false,
    mockProvider: true,
    realExternalProvider: false,
    realCommercialModel: false,
    userCredentialsUsed: false,
    coreIntegrated: true,
    providerPromptSeen: true,
    modelReplyIsRealCompletion: false,
    ownerReviewRecorded: false,
    candidateAutoApproved: false,
    technicalVerificationRecorded: false
  })
})

// ---------------------------------------------------------------------------
// 2 · a missing cached binary fails closed before any Core or Pi starts
// ---------------------------------------------------------------------------

test('a missing cached binary fails closed before any Core or Pi is started', async () => {
  const bogus = join(tmpdir(), `loom-e3-missing-${Date.now()}`, 'rovai-core.exe')
  await assert.rejects(() => verifyCachedCoreBinary(bogus), /rovai-core is missing/)
})

// ---------------------------------------------------------------------------
// 2b · UI bundle capability is OPTIONAL: both branches are unit-tested with mocked outcomes
// ---------------------------------------------------------------------------

test('UI bundle projection: strict when supported, honest downgrade when unsupported, and any other error is not ignored', () => {
  const expectations = { missionId: 'm-1', taskCount: 2, candidateCount: 2, artifactCount: 2 }

  // Supported branch: strict, bundleProjectionObserved:true.
  const supported = resolveUiBundleFacts(
    { ok: true, bundle: { missionId: 'm-1', tasks: [{}, {}], candidates: [{}, {}], artifacts: [{}, {}], reviews: [] } },
    expectations
  )
  assert.equal(supported.bundleProjectionObserved, true)
  assert.equal(supported.source, 'core_bundle')
  assert.equal(supported.reason, null)
  assert.equal(supported.bundleTaskCount, 2)
  assert.equal(supported.bundleCandidateCount, 2)
  assert.equal(supported.bundleArtifactCount, 2)
  assert.equal(supported.bundleReviewCount, 0)

  // Current fresh Core returns LoomArtifactsListResult, not the earlier fixture's array.
  const realCoreShape = resolveUiBundleFacts(
    { ok: true, bundle: { missionId: 'm-1', tasks: [{}, {}], candidates: [{}, {}],
      artifacts: { artifacts: [{ artifactId: 'a' }, { artifactId: 'b' }] }, reviews: [] } },
    expectations
  )
  assert.equal(realCoreShape.bundleProjectionObserved, true)
  assert.equal(realCoreShape.bundleArtifactCount, 2)
  assert.throws(
    () => resolveUiBundleFacts(
      { ok: true, bundle: { missionId: 'm-1', tasks: [{}, {}], candidates: [{}, {}],
        artifacts: { artifacts: [{}] }, reviews: [] } }, expectations
    ), /project 2 artifacts/
  )
  assert.throws(
    () => resolveUiBundleFacts(
      { ok: true, bundle: { missionId: 'm-1', tasks: [{}, {}], candidates: [{}, {}],
        artifacts: { count: 2 }, reviews: [] } }, expectations
    ), /artifact array/
  )

  // A supported-but-wrong projection must fail closed, not silently pass.
  assert.throws(
    () => resolveUiBundleFacts(
      { ok: true, bundle: { missionId: 'm-1', tasks: [{}], candidates: [{}, {}], artifacts: [{}, {}], reviews: [] } },
      expectations
    ),
    /project 2 Tasks/
  )

  // Explicit unsupported-method error: honest downgrade, never claimed verified.
  const unsupported = resolveUiBundleFacts(
    { ok: false, error: { kind: 'infrastructure_failure', code: 'CORE_REQUEST_FAILED', message: 'unsupported core method: loom.bundles.getMany' } },
    expectations
  )
  assert.equal(unsupported.bundleProjectionObserved, false)
  assert.equal(unsupported.source, 'core_list_calls')
  assert.equal(unsupported.reason, 'cached_binary_unsupported')
  assert.equal(unsupported.bundleTaskCount, 2)
  assert.equal(unsupported.bundleCandidateCount, 2)
  assert.equal(unsupported.bundleArtifactCount, 2)
  assert.equal(unsupported.bundleReviewCount, 0)

  // Any OTHER error must be rethrown, never downgraded.
  const otherError = { kind: 'infrastructure_failure', code: 'CORE_REQUEST_FAILED', message: 'some other core failure' }
  assert.throws(() => resolveUiBundleFacts({ ok: false, error: otherError }, expectations), (error) => error === otherError)

  // isUnsupportedCoreMethodError is precise: only the explicit unsupported-method shape matches.
  assert.equal(isUnsupportedCoreMethodError(otherError), false)
  assert.equal(isUnsupportedCoreMethodError({ message: 'unsupported core method: loom.bundles.getMany' }), true)
  assert.equal(isUnsupportedCoreMethodError({ message: 'unsupported core method: loom.some.other' }), false)
  assert.equal(isUnsupportedCoreMethodError(null), false)

  // E3 OwnerReview stays pending regardless of which bundle branch is taken.
  assert.equal(E3_EVIDENCE_ENVELOPE.ownerReviewRecorded, false)
  assert.equal(E3_EVIDENCE_ENVELOPE.candidateAutoApproved, false)
})

// ---------------------------------------------------------------------------
// 3 · the real integration (Windows-only; skipped, never green, elsewhere)
// ---------------------------------------------------------------------------

test('one real Core + two concurrent real Pi workers deliver two pending candidates under two real claims and never self-approve', {
  timeout: INTEGRATION_TIMEOUT_MS
}, async (t) => {
  if (process.platform !== 'win32') {
    t.skip(`E3 core-pi integration is Windows-only (protected DACL data-root + windows-x64 pi.exe); host is ${process.platform}`)
    return
  }
  const evidence = await runCorePiIntegrationEvidence({ prompt: DEFAULT_TWO_WORKER_PROMPT })

  // --- envelope: cached prebuild, mock provider, pending Owner review ---
  assert.equal(evidence.ok, true)
  assert.equal(evidence.scope, 'E3-sandbox-only')
  assert.equal(evidence.binarySource, 'cached-prebuild')
  assert.equal(evidence.coldBuilt, false)
  assert.equal(evidence.cargoBuildInvoked, false)
  assert.equal(evidence.mockProvider, true)
  assert.equal(evidence.realExternalProvider, false)
  assert.equal(evidence.realCommercialModel, false)
  assert.equal(evidence.userCredentialsUsed, false)
  assert.equal(evidence.coreIntegrated, true)
  assert.equal(evidence.providerPromptSeen, true)
  assert.equal(evidence.modelReplyIsRealCompletion, false)
  assert.equal(evidence.ownerReviewRecorded, false)
  assert.equal(evidence.candidateAutoApproved, false)
  assert.equal(evidence.technicalVerificationRecorded, false)

  // --- cached-binary honesty: path + sha256 + lstat metadata ---
  assert.ok(typeof evidence.coreBinary.path === 'string' && evidence.coreBinary.path.length > 0,
    `the evidence must name the cached binary path: ${JSON.stringify(evidence.coreBinary)}`)
  assert.match(evidence.coreBinary.sha256, /^[0-9a-f]{64}$/,
    `the evidence must carry the cached binary sha256: ${JSON.stringify(evidence.coreBinary)}`)
  assert.ok(evidence.coreBinary.sizeBytes > 0, `the evidence must record the binary byte size: ${JSON.stringify(evidence.coreBinary)}`)
  assert.equal(evidence.coreBinary.binarySource, 'cached-prebuild')
  assert.equal(evidence.coreBinary.coldBuilt, false)
  assert.equal(evidence.coreBinary.cargoBuildInvoked, false)

  // --- startup stage: ready was reached (never skipped) under a realistic bounded budget ---
  assert.equal(evidence.coreStartup.readySkipped, false, 'ready must never be skipped')
  assert.equal(evidence.coreStartup.reusedExistingProcess, false, 'a fresh Core process must be spawned, not reused')
  assert.ok(evidence.coreStartup.readyBudgetMs >= 120000,
    `the ready gate must use at least the realistic 120s budget: ${JSON.stringify(evidence.coreStartup)}`)
  assert.ok(Number.isInteger(evidence.coreStartup.readyElapsedMs) && evidence.coreStartup.readyElapsedMs >= 0,
    `ready elapsed must be recorded: ${JSON.stringify(evidence.coreStartup)}`)
  assert.ok(Number.isInteger(evidence.coreStartup.settledElapsedMs) && evidence.coreStartup.settledElapsedMs >= 0,
    `settled elapsed must be recorded: ${JSON.stringify(evidence.coreStartup)}`)

  // --- isolation: protected DACL root + independent skill/mcp, all contained ---
  assert.equal(evidence.isolation.dataRootIsProtectedWindowsRoot, true)
  assert.equal(evidence.isolation.dataRootInsideFixture, true)
  assert.equal(evidence.isolation.skillRootInsideDataRoot, true)
  assert.equal(evidence.isolation.mcpConfigInsideDataRoot, true)
  assert.equal(evidence.isolation.userScopedRootsRedirected, true)
  assert.equal(evidence.isolation.argvAllInsideFixture, true)
  assert.equal(evidence.isolation.userDatabaseTouched, false)
  assert.equal(evidence.isolation.port64851Touched, false)
  assert.equal(evidence.isolation.globalMcpConfigTouched, false)
  assert.equal(evidence.isolation.realPiProfileTouched, false)

  // --- concurrency: the two Pi workers genuinely overlap ---
  assert.equal(evidence.concurrency.overlapped, true, `the two Pi workers must overlap: ${JSON.stringify(evidence.concurrency)}`)
  assert.equal(evidence.systemPromptHashesDiffer, true, 'the OFF/APPEND system prompt hashes must differ')

  // --- the one Mission holds exactly the two independent Tasks ---
  assert.deepEqual(evidence.mission.taskIds, [TASK_A, TASK_B])
  assert.deepEqual(evidence.mission.dependencyIds, [], 'the two independent Tasks must carry no edges')

  // --- two real claims first, both held (unreleased) at submission time ---
  assert.equal(evidence.claims.count, 2, `Core must hold exactly two claims: ${JSON.stringify(evidence.claims)}`)
  assert.equal(new Set(evidence.claims.claimIds).size, 2, 'the two claims must be distinct')
  assert.deepEqual([...evidence.claims.taskIds].sort(), [TASK_A, TASK_B].sort(), 'the two claims must cover both Tasks')
  assert.equal(evidence.claims.allUnreleasedAtSubmit, true, 'both claims must still be held at submission time')

  // --- two workers, each its own session/port/settle, each pending & unverified ---
  assert.equal(evidence.workers.length, 2, `exactly two workers must report: ${evidence.workers.length}`)
  assert.deepEqual(evidence.workers.map((worker) => worker.taskId).sort(), [TASK_A, TASK_B].sort())
  for (const worker of evidence.workers) {
    assert.equal(worker.agentSettledObserved, true, `${worker.botId} must observe its own real agent_settled`)
    assert.ok(worker.providerRequestCount >= 1, `${worker.botId} must reach its own fake provider`)
    assert.ok(typeof worker.sessionId === 'string' && worker.sessionId.length > 0, `${worker.botId} must report a sessionId`)
    assert.ok(Number.isInteger(worker.providerPort) && worker.providerPort > 0, `${worker.botId} must report its provider port`)
    assert.equal(worker.verificationStatus, 'unverified', `${worker.botId} candidate must stay unverified`)
    assert.equal(worker.acceptanceStatus, 'pending', `${worker.botId} candidate must stay pending`)
    assert.match(worker.artifactSha256, /^[0-9a-f]{64}$/, `${worker.botId} must carry a Host-computed artifact digest`)
  }
  assert.equal(new Set(evidence.workers.map((worker) => worker.sessionId)).size, 2, 'the two workers must not share a sessionId')
  assert.equal(new Set(evidence.workers.map((worker) => worker.providerPort)).size, 2, 'the two workers must not share a provider port')

  // --- OwnerReview stays pending: nothing was recorded, nothing auto-approved ---
  assert.equal(evidence.ownerReview.recorded, false)
  assert.equal(evidence.ownerReview.pending, true)
  assert.equal(evidence.ownerReview.userUiApproval, false)
  assert.equal(evidence.ownerReview.reviewsCount, 0, 'no review may be recorded')
  assert.deepEqual(evidence.ownerReview.tasksStatus, { [TASK_A]: 'in_review', [TASK_B]: 'in_review' },
    'both Tasks must stay in review, never done')
  assert.deepEqual(evidence.ownerReview.candidatesAcceptanceStatus, { [TASK_A]: 'pending', [TASK_B]: 'pending' })

  // --- facts read back through the Core APIs; the UI bundle is optional and reported honestly ---
  assert.equal(evidence.uiFacts.bundleTaskCount, 2, 'the facts must project both Tasks')
  assert.equal(evidence.uiFacts.bundleCandidateCount, 2, 'the facts must project both candidates')
  assert.equal(evidence.uiFacts.bundleArtifactCount, 2, 'the facts must project both artifacts')
  assert.equal(evidence.uiFacts.bundleReviewCount, 0, 'the facts must project zero reviews')
  assert.equal(typeof evidence.uiFacts.bundleProjectionObserved, 'boolean')
  if (evidence.uiFacts.bundleProjectionObserved) {
    assert.equal(evidence.uiFacts.source, 'core_bundle', 'a supported bundle must be the observed source')
    assert.equal(evidence.uiFacts.reason, null)
  } else {
    // The cached binary may predate loom.bundles.getMany: the facts come from the list calls, never a
    // fake "bundle verified".
    assert.equal(evidence.uiFacts.source, 'core_list_calls', 'an unsupported bundle must fall back to the list calls')
    assert.equal(evidence.uiFacts.reason, 'cached_binary_unsupported')
  }

  // --- the ceiling holds on the finished object ---
  assertNoSecrets(evidence)
  const evidenceText = JSON.stringify(evidence)
  assert.equal(evidenceText.includes(DEFAULT_TWO_WORKER_PROMPT), false, 'the evidence must never carry the plaintext prompt')
  assert.equal(evidenceText.includes(DUMMY_API_KEY), false, 'the evidence must never carry the dummy api key')

  // --- teardown: provider ports closed, Pi temp roots gone, Core fixture removed ---
  for (const worker of evidence.workers) {
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
  await assert.rejects(
    () => readdir(evidence.fixturePath),
    /ENOENT/,
    `the Core fixture ${evidence.fixturePath} must be removed after the run`
  )
})

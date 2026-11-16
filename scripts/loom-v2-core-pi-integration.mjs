// LOOM V2 E3 · 单一真实 Core（缓存 target/debug/rovai-core.exe，绝不冷构建）+ 两个并发真实 Pi
// （各自独立 127.0.0.1:0 本机假 Provider）的 Core↔Pi 集成编排器，沙箱专用。
//
// 本文件是「编排器」，被 scripts/loom-v2-core-pi-integration.test.mjs 调用；它自己也能作为 CLI 直跑。
//
// 诚实边界（绝不冒充）：
// - 二进制来自仓库既有 target/debug/rovai-core.exe。这里**只做** path 存在性 + sha256 + lstat 元数据校验，
//   并在 evidence 里显式声明 binarySource='cached-prebuild' / coldBuilt=false / cargoBuildInvoked=false。
//   本文件**从不**运行 cargo，绝不冒充 600s 冷构建产出的二进制。
// - 模型侧只有本机假 Provider（mockProvider=true / realExternalProvider=false），Pi 的假回复是 mock
//   执行事实，**不是**真实商业模型完成；evidence 显式 modelReplyIsRealCompletion=false。
// - 两个 Pi 并发结果**不能**替代 Core Claim：必须先在同一 Core DB 里取得两个**真实** loom.claim.acquire
//   claim/fence，Pi 只是在这两个已存在的 fence 下产出受控收据。
// - 受控 artifact 文件是**mock 执行收据**（只含 sha256/计数/布尔/枚举/临时路径），不是人工批准。
// - OwnerReview 必须保持 pending：本文件**绝不调用 loom.review.record**；candidate 恒为
//   verificationStatus=unverified / acceptanceStatus=pending，Task 停在 in_review，reviews.list 为空。
//
// 隔离：每次运行新建 mkdtemp fixture；Windows 用 --prepare-windows-data-root 生成正式 protected DACL
// data-root，skill-root 与 mcp.json 各自独立落在 data-root 内；HOME/USERPROFILE/TMP/TEMP/XDG 全部重定向进
// fixture。绝不触碰用户日常 DB、64851、~/.pi、全局 mcp.json 或全局 Skill Library。
//
// 失败关闭：Core bounded 关闭；无法确认 pid 消失则保留 fixture（删除活进程目录既会竞争也会毁掉唯一证据）；
// 任何 teardown 失败都以 AggregateError 抛出，绝不虚报绿色。

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

import {
  coreDataDirectoryArguments,
  removeEphemeralRuntimeCampFilesRoot,
  runtimeCampFilesRootForDataDirectory
} from './lib/runtime-camp-files-root.mjs'
import {
  DEFAULT_TWO_WORKER_PROMPT,
  assertNoSecrets,
  runTwoWorkerLoopbackEvidence
} from './loom-v2-two-worker-loopback.mjs'
import { DUMMY_API_KEY } from './loom-v2-pi-loopback-provider.mjs'

const repository = resolve(import.meta.dirname, '..')
const CORE_BINARY_NAME = process.platform === 'win32' ? 'rovai-core.exe' : 'rovai-core'

/** The only evidence envelope this file may ever claim. Every field is a standing declaration. */
export const E3_EVIDENCE_ENVELOPE = Object.freeze({
  scope: 'E3-sandbox-only',
  // Binary honesty: this is a cached prebuild, never a cold build.
  binarySource: 'cached-prebuild',
  coldBuilt: false,
  cargoBuildInvoked: false,
  // Model honesty: only a local fake provider ran; no commercial model, no user credentials.
  mockProvider: true,
  realExternalProvider: false,
  realCommercialModel: false,
  userCredentialsUsed: false,
  coreIntegrated: true,
  providerPromptSeen: true,
  modelReplyIsRealCompletion: false,
  // Approval honesty: the Owner verdict is pending; nothing auto-approved or self-verified.
  ownerReviewRecorded: false,
  candidateAutoApproved: false,
  technicalVerificationRecorded: false
})

export const TASK_A = 'loom-e3-worker-a'
export const TASK_B = 'loom-e3-worker-b'
export const ACCEPTANCE_CRITERIA_VERSION = 'ac-e3'
// A Run that really drives two Pi processes needs a lease longer than the 300s default; the lease is
// still the fence the submission presents, so this is a budget, not a bypass.
const CLAIM_LEASE_SECONDS = 1800

// A fresh protected DACL data-root plus subsystem warm-up can take well over a minute on Windows under
// load (the existing two-pi test timed out at the old 60s budget while Core was still warming up), so the
// ready gate gets its own realistic, separate bounded window. This never skips ready or fakes a start.
// It defaults to 120s and can be raised for diagnosis via LOOM_E3_READY_BUDGET_MS without editing code.
const configuredReadyBudget = Number(process.env.LOOM_E3_READY_BUDGET_MS)
const READY_BUDGET_MS = Number.isFinite(configuredReadyBudget) && configuredReadyBudget > 0
  ? configuredReadyBudget
  : 120_000
// Subsystem initialization is polled after ready; it also gets its own bounded window and is recorded.
const SETTLED_BUDGET_MS = 60_000

const sha256Of = (contents) => createHash('sha256').update(contents).digest('hex')

export function defaultCoreBinaryPath() {
  return process.env.ROVAI_CORE_BIN ?? join(repository, 'target', 'debug', CORE_BINARY_NAME)
}

/**
 * Verify the cached Core binary: path exists, is a regular non-symlink file, and record its sha256 +
 * lstat metadata. This never builds. A missing binary is an actionable error, not a Core timeout.
 */
export async function verifyCachedCoreBinary(binaryPath) {
  const stats = await lstat(binaryPath).catch(() => null)
  if (!stats || !stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(
      `rovai-core is missing at ${binaryPath}; this test uses a cached prebuild and never builds:`
        + ' cargo build -p rovai-core --bin rovai-core'
    )
  }
  const bytes = await readFile(binaryPath)
  return {
    path: binaryPath,
    sha256: sha256Of(bytes),
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
    mtimeIso: new Date(stats.mtimeMs).toISOString(),
    binarySource: 'cached-prebuild',
    coldBuilt: false,
    cargoBuildInvoked: false
  }
}

/**
 * True only for the explicit "unsupported core method" infrastructure failure a cached Core binary may
 * return when it predates a newer RPC. Any other error is not this, and must never be downgraded.
 */
export function isUnsupportedCoreMethodError(error, method = 'loom.bundles.getMany') {
  if (!error || typeof error !== 'object') return false
  const message = String(error.message ?? '')
  if (!/unsupported core method/i.test(message)) return false
  return message.includes(method)
}

/**
 * Resolve the OPTIONAL UI bundle projection from a settled `loom.bundles.getMany` outcome.
 *
 * - Supported (`outcome.ok`): strictly assert the projection matches the already-read facts and report
 *   `bundleProjectionObserved:true` / `source:'core_bundle'`.
 * - Explicitly unsupported (the cached binary predates the RPC): downgrade to the already-read
 *   claims/candidates/artifacts lists and report `bundleProjectionObserved:false` /
 *   `source:'core_list_calls'` / `reason:'cached_binary_unsupported'`. Never claimed as verified.
 * - Any other error: rethrown. It is never swallowed.
 *
 * @param {{ok:true, bundle:object}|{ok:false, error:unknown}} outcome
 * @param {{missionId:string, taskCount:number, candidateCount:number, artifactCount:number}} expectations
 */
export function resolveUiBundleFacts(outcome, expectations) {
  if (outcome && outcome.ok) {
    const bundle = outcome.bundle
    assert.ok(bundle, 'the supported UI bundle projection must answer with a bundle')
    assert.equal(bundle.missionId, expectations.missionId,
      `the UI bundle must name its Mission: ${JSON.stringify(bundle.missionId)}`)
    assert.equal(bundle.tasks.length, expectations.taskCount,
      `the UI bundle must project ${expectations.taskCount} Tasks: ${JSON.stringify(bundle.tasks)}`)
    assert.equal(bundle.candidates.length, expectations.candidateCount,
      `the UI bundle must project ${expectations.candidateCount} candidates: ${JSON.stringify(bundle.candidates)}`)
    // Core's typed `LoomArtifactsListResult` is { artifacts: [...] }, not a bare array.
    // The cached fixture used a bare array; both are allowed only with strict count checks.
    const artifacts = Array.isArray(bundle.artifacts)
      ? bundle.artifacts
      : bundle.artifacts?.artifacts
    assert.ok(Array.isArray(artifacts),
      `the UI bundle must return an artifact array: ${JSON.stringify(bundle.artifacts)}`)
    assert.equal(artifacts.length, expectations.artifactCount,
      `the UI bundle must project ${expectations.artifactCount} artifacts: ${JSON.stringify(bundle.artifacts)}`)
    assert.deepEqual(bundle.reviews, [],
      `the UI bundle must project zero reviews (Owner verdict pending): ${JSON.stringify(bundle.reviews)}`)
    return {
      bundleProjectionObserved: true,
      source: 'core_bundle',
      reason: null,
      bundleTaskCount: bundle.tasks.length,
      bundleCandidateCount: bundle.candidates.length,
      bundleArtifactCount: artifacts.length,
      bundleReviewCount: bundle.reviews.length
    }
  }
  const error = outcome ? outcome.error : null
  if (isUnsupportedCoreMethodError(error, 'loom.bundles.getMany')) {
    // The facts below were already read and asserted via claims/candidates/artifacts list calls.
    return {
      bundleProjectionObserved: false,
      source: 'core_list_calls',
      reason: 'cached_binary_unsupported',
      bundleTaskCount: expectations.taskCount,
      bundleCandidateCount: expectations.candidateCount,
      bundleArtifactCount: expectations.artifactCount,
      bundleReviewCount: 0
    }
  }
  // Any other error is a real failure: never downgraded, never ignored.
  throw error
}

/**
 * Run the E3 Core↔Pi integration scenario.
 *
 * @param {object} [options]
 * @param {string} [options.piBin] optional Pi launcher override; still verified against the pinned bundle
 * @param {string} [options.prompt] harmless prompt sent to both workers
 */
export async function runCorePiIntegrationEvidence({
  piBin,
  prompt = DEFAULT_TWO_WORKER_PROMPT
} = {}) {
  if (process.platform !== 'win32') {
    throw new Error(
      'LOOM E3 core-pi integration is Windows-only (protected DACL data-root + windows-x64 pi.exe);'
        + ` the host is ${process.platform}`
    )
  }
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('core-pi integration requires a non-empty harmless prompt')
  }

  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-loom-e3-corepi-')))
  // `rm` is idempotent; a Core whose exit could not be confirmed sets `preserveFixture`, because
  // deleting files a live process still owns would both race it and destroy the only evidence.
  let preserveFixture = false
  const keepFixture = process.env.ROVAI_KEEP_LOOM_E3_FIXTURE === '1'

  const isolatedHome = join(fixture, 'home')
  const isolatedTemporary = join(fixture, 'tmp')
  const isolatedRuntimeDirectory = join(fixture, 'runtime-dir')
  await mkdir(isolatedHome)
  await mkdir(isolatedTemporary)
  await mkdir(isolatedRuntimeDirectory)
  // Every user-scoped root Core could reach is redirected into this fixture.
  const isolatedEnvironment = {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    TMPDIR: isolatedTemporary,
    TMP: isolatedTemporary,
    TEMP: isolatedTemporary,
    XDG_CACHE_HOME: join(isolatedHome, '.cache'),
    XDG_CONFIG_HOME: join(isolatedHome, '.config'),
    XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
    XDG_STATE_HOME: join(isolatedHome, '.local', 'state'),
    XDG_RUNTIME_DIR: isolatedRuntimeDirectory
  }

  const contained = (path) => {
    const offset = relative(fixture, path)
    return offset !== '' && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
  }

  let core = null
  let dataDir = null
  let runtimeFilesRoot = null
  let evidence = null
  let mainError = null

  try {
    // ---- 1. Cached binary honesty (path + hash + metadata; never a build) ----
    const coreBinary = defaultCoreBinaryPath()
    const binaryMeta = await verifyCachedCoreBinary(coreBinary)

    // ---- 2. Fresh protected Windows data-root + independent skill/mcp config ----
    // The protected root is created by Core itself: a plain `mkdir` would inherit ACLs and be refused.
    dataDir = JSON.parse(
      execFileSync(coreBinary, ['--prepare-windows-data-root', join(fixture, 'formal')], { encoding: 'utf8' })
    ).core
    assert.ok(typeof dataDir === 'string' && dataDir.length > 0,
      `--prepare-windows-data-root must answer with a Core data dir: ${JSON.stringify(dataDir)}`)
    const skillRoot = join(dataDir, 'managed-skill-library')
    const mcpPath = join(dataDir, 'mcp.json')
    runtimeFilesRoot = runtimeCampFilesRootForDataDirectory(dataDir, { homeDirectory: isolatedHome })
    assert.ok(contained(dataDir), `the protected data-root must stay inside the fixture: ${dataDir}`)
    assert.ok(contained(skillRoot) && contained(mcpPath) && contained(runtimeFilesRoot),
      'the skill root, MCP config and Runtime Files Root must all stay inside the fixture')
    const rootBefore = (await readdir(fixture)).sort()

    // ---- 3. Start the one real Core ----
    core = startIsolatedCore({
      dataDir,
      skillRoot,
      mcpPath,
      binaryPath: coreBinary,
      environment: isolatedEnvironment
    })
    await core.ready
    await core.settled()
    // Startup stage telemetry (ready is never skipped; this records how long it actually took).
    const readyElapsedMs = core.readyElapsedMs
    const settledElapsedMs = core.settledElapsedMs
    const lastStartupFrame = core.startupFrames.length > 0 ? core.startupFrames[core.startupFrames.length - 1] : null
    const coreStartup = {
      readyBudgetMs: READY_BUDGET_MS,
      readyElapsedMs,
      settledBudgetMs: SETTLED_BUDGET_MS,
      settledElapsedMs,
      startupFrameCount: core.startupFrames.length,
      lastStartupStatus: lastStartupFrame?.status ?? null,
      readySkipped: false,
      reusedExistingProcess: false
    }
    assert.ok(Number.isInteger(readyElapsedMs) && readyElapsedMs >= 0,
      `ready must have completed and been timed (never skipped): ${JSON.stringify(coreStartup)}`)
    // With HOME inside the fixture there is no exception: every absolute argument must be contained.
    assert.deepEqual(
      core.args.filter((argument) => isAbsolute(argument) && !contained(argument)),
      [],
      `Core must be launched with paths inside the exclusive temporary root only: ${JSON.stringify(core.args)}`)

    const members = await core.request('members.list')
    const agent = members.find((profile) => profile.presence === 'present')
    assert.ok(agent, `the fixture authority must expose one present member profile: ${JSON.stringify(members)}`)

    // A rejection arrives as the bare `{kind, code, message, retryable, details}` body.
    const expectRejection = async (promise, method, code) => {
      const outcome = await promise.then((result) => ({ result }), (error) => ({ error }))
      assert.ok(outcome.error, `${method} must be rejected with ${code}, received ${JSON.stringify(outcome.result)}`)
      const { error } = outcome
      assert.equal(error.code, code, `${method} must be rejected with ${code}: ${JSON.stringify(error)}`)
      assert.equal(error.kind, 'domain_rejection', `${method} must be a domain rejection: ${JSON.stringify(error)}`)
      assert.equal(error.retryable, false, `${method} must not be retryable: ${JSON.stringify(error)}`)
      return error
    }
    const taskStatus = async (missionId, taskId) => {
      const listed = await core.request('loom.tasks.list', { missionId })
      const task = listed.find((entry) => entry.taskId === taskId)
      assert.ok(task, `task ${taskId} must be listed for its Mission: ${JSON.stringify(listed)}`)
      return { status: task.status, listed }
    }

    // ---- 4. One Mission + one Plan with exactly TWO independent Tasks ----
    const missionId = (await core.request('missions.create', {
      commandId: randomUUID(),
      command: {
        title: 'LOOM E3 core-pi integration',
        description: 'Owns the real Core + double real Pi sandbox seam; the Owner verdict stays pending.',
        projectPath: '',
        projectBindingKind: 'quick_chat',
        memberAgentIds: [agent.agentId],
        defaultLeadAgentId: agent.agentId,
        tags: ['loom-e3-core-pi']
      }
    })).payload?.missionId
    assert.equal(typeof missionId, 'string', `missions.create must answer with a missionId: ${missionId}`)

    const criteria = [
      { criterionId: 'criterion-worker-a', text: 'worker A delivered its own mock execution receipt as a registered artifact' },
      { criterionId: 'criterion-worker-b', text: 'worker B delivered its own mock execution receipt as a registered artifact' }
    ]
    const imported = await core.request('loom.plan.import', {
      missionId,
      goal: 'Two real Pi workers deliver mock execution receipts into one Core Mission without any approval',
      acceptanceCriteriaVersion: ACCEPTANCE_CRITERIA_VERSION,
      criteria,
      tasks: [
        { taskId: TASK_A, title: 'Worker A receipt', description: 'Independent parallel Task, no edges' },
        { taskId: TASK_B, title: 'Worker B receipt', description: 'Independent parallel Task, no edges' }
      ],
      // No edge between A and B: both must be claimable at the same instant.
      dependencies: []
    })
    assert.equal(imported.missionId, missionId, `the import must answer for its Mission: ${JSON.stringify(imported)}`)
    const planId = imported.planId
    assert.equal(typeof planId, 'string', `the import receipt must carry its planId: ${JSON.stringify(imported)}`)
    assert.deepEqual(imported.taskIds, [TASK_A, TASK_B], `the import receipt must name both Tasks: ${JSON.stringify(imported)}`)
    assert.deepEqual(imported.dependencyIds, [], `the two independent Tasks must carry no edges: ${JSON.stringify(imported)}`)

    // Release only moves DRAFT -> READY and never looks at the edges.
    for (const releasedTaskId of [TASK_A, TASK_B]) {
      const released = await core.request('loom.task.release', { missionId, taskId: releasedTaskId })
      assert.equal(released.task.status, 'ready',
        `loom.task.release must move ${releasedTaskId} to ready: ${JSON.stringify(released)}`)
    }

    // ---- 5. Real Core claims FIRST: the Pi run must submit under fences that already exist ----
    const runA = randomUUID()
    const runB = randomUUID()
    const claimA = await core.request('loom.claim.acquire', {
      missionId, taskId: TASK_A, agentRunId: runA, commandId: randomUUID(), leaseSeconds: CLAIM_LEASE_SECONDS
    })
    assert.equal(claimA.taskId, TASK_A, `the claim must bind its Task: ${JSON.stringify(claimA)}`)
    assert.equal(claimA.agentRunId, runA, `the claim must bind its AgentRun: ${JSON.stringify(claimA)}`)
    assert.equal(claimA.planId, planId, `the claim must bind the Mission's plan: ${JSON.stringify(claimA)}`)
    assert.equal(claimA.replayed, false, `the first claim of A must not be a replay: ${JSON.stringify(claimA)}`)
    assert.ok(Number.isInteger(claimA.fenceGeneration) && claimA.fenceGeneration >= 1,
      `the claim receipt must carry a fence generation: ${JSON.stringify(claimA)}`)
    const claimB = await core.request('loom.claim.acquire', {
      missionId, taskId: TASK_B, agentRunId: runB, commandId: randomUUID(), leaseSeconds: CLAIM_LEASE_SECONDS
    })
    assert.equal(claimB.taskId, TASK_B, `the claim must bind its Task: ${JSON.stringify(claimB)}`)
    assert.equal(claimB.agentRunId, runB, `the claim must bind its AgentRun: ${JSON.stringify(claimB)}`)
    assert.equal(claimB.replayed, false, `the first claim of B must not be a replay: ${JSON.stringify(claimB)}`)
    assert.notEqual(claimB.claimId, claimA.claimId, 'two parallel Tasks must hold two different claims')
    // Both parallel Tasks are held at the same instant: that is what makes them concurrent work.
    const afterClaims = await core.request('loom.tasks.list', { missionId })
    assert.deepEqual(
      afterClaims.filter((task) => [TASK_A, TASK_B].includes(task.taskId)).map((task) => task.status),
      ['ready', 'ready'],
      `both independent Tasks must be claimable and still ready: ${JSON.stringify(afterClaims)}`)

    // ---- 6. Two real Pi workers, concurrently, each over its own local fake provider ----
    const loopback = await runTwoWorkerLoopbackEvidence({
      prompt,
      ...(piBin ? { piBin } : {})
    })
    assert.equal(loopback.ok, true, `the two-worker loopback run must be ok: ${JSON.stringify(loopback.ok)}`)
    assert.equal(loopback.preflightOnly, false, 'the workers must really have run, not just preflighted')
    assert.equal(loopback.mockProvider, true, 'the run must declare its local fake provider')
    assert.equal(loopback.realExternalProvider, false, 'the run must never claim an external provider')
    assert.equal(loopback.concurrency.overlapped, true,
      `the two Pi workers must overlap in wall-clock time: ${JSON.stringify(loopback.concurrency)}`)
    assert.equal(loopback.workers.length, 2, `exactly two workers must report: ${loopback.workers.length}`)
    for (const worker of loopback.workers) {
      assert.equal(worker.agentSettledObserved, true, `worker ${worker.botId} must observe its own real agent_settled`)
      assert.ok(worker.providerRequestCount >= 1, `worker ${worker.botId} must reach its own fake provider: ${worker.providerRequestCount}`)
      assert.equal(worker.providerSystemPromptSha256Verified, true, `worker ${worker.botId} must report a re-derived system prompt digest`)
      assert.equal(worker.loopbackOnly, true, `worker ${worker.botId} must stay loopback-only`)
      assert.equal(worker.dummyAuthOnly, true, `worker ${worker.botId} must use the dummy test key only`)
      assert.equal(worker.toolsSchemaAbsent, true, `worker ${worker.botId} must run with tools disabled`)
      assert.ok(typeof worker.sessionId === 'string' && worker.sessionId.length > 0,
        `worker ${worker.botId} must report a non-empty sessionId`)
    }
    assert.equal(new Set(loopback.workers.map((worker) => worker.sessionId)).size, 2,
      `the two workers must not share a sessionId: ${JSON.stringify(loopback.workers.map((worker) => worker.sessionId))}`)
    assert.equal(new Set(loopback.workers.map((worker) => worker.providerPort)).size, 2,
      `the two workers must not share a provider port: ${JSON.stringify(loopback.workers.map((worker) => worker.providerPort))}`)

    // ---- 7. Bind each verified worker receipt to its own claim/fence/Run; register; submit ----
    const workspaceDirectory = join(dataDir, 'quick-chat')
    await mkdir(workspaceDirectory, { recursive: true })
    const bindings = [
      { taskId: TASK_A, botId: 'bot_worker_a', agentRunId: runA, claim: claimA },
      { taskId: TASK_B, botId: 'bot_worker_b', agentRunId: runB, claim: claimB }
    ].map((binding) => {
      const worker = loopback.workers.find((entry) => entry.botId === binding.botId)
      assert.ok(worker, `the loopback run must report worker ${binding.botId}: ${JSON.stringify(loopback.workers.map((entry) => entry.botId))}`)
      // Digests/booleans/counters/enums only: the plaintext prompt and the dummy key never enter it.
      const receipt = {
        schema: 'loom.e3.core-pi.execution-receipt.v1',
        executionReceiptKind: 'mock-loopback',
        humanApproval: false,
        realCompletion: false,
        ...E3_EVIDENCE_ENVELOPE,
        missionId,
        planId,
        taskId: binding.taskId,
        agentRunId: binding.agentRunId,
        claimId: binding.claim.claimId,
        fenceGeneration: binding.claim.fenceGeneration,
        botId: worker.botId,
        mode: worker.mode,
        sessionId: worker.sessionId,
        providerPort: worker.providerPort,
        providerRequestCount: worker.providerRequestCount,
        providerSystemPromptSha256: worker.providerSystemPromptSha256,
        providerSystemPromptBytes: worker.providerSystemPromptBytes,
        providerSystemPromptSha256Verified: true,
        agentSettledObserved: true,
        settledEventIndex: worker.settledEventIndex ?? null,
        messageCountAfter: worker.messageCountAfter ?? null,
        assistantReplyFromMockProvider: worker.assistantReplyFromMockProvider,
        assistantReplyLength: worker.assistantReplyLength,
        purgeCommandFound: worker.purgeCommandFound,
        purgeSourceMatches: worker.purgeSourceMatches,
        notifyCount: worker.notifyCount,
        loopbackOnly: worker.loopbackOnly,
        dummyAuthOnly: worker.dummyAuthOnly,
        toolsSchemaAbsent: worker.toolsSchemaAbsent,
        startedAt: worker.startedAt,
        finishedAt: worker.finishedAt,
        durationMs: worker.durationMs,
        promptSha256: sha256Of(prompt),
        workerEvidenceSha256: sha256Of(JSON.stringify(worker)),
        recordedAt: new Date().toISOString()
      }
      return { ...binding, worker, receipt, relativePath: `loom-e3-receipt-${binding.botId}.json` }
    })
    for (const binding of bindings) {
      const contents = `${JSON.stringify(binding.receipt, null, 2)}\n`
      const absolutePath = join(workspaceDirectory, binding.relativePath)
      await writeFile(absolutePath, contents)
      const onDisk = await readFile(absolutePath, 'utf8')
      assert.equal(onDisk, contents, `the receipt file must hold the written bytes: ${absolutePath}`)
      // The ceiling is enforced on the bytes actually written, not on the object in memory.
      assert.equal(onDisk.includes(prompt), false, `the receipt must never carry the plaintext prompt: ${binding.relativePath}`)
      assert.equal(onDisk.includes(DUMMY_API_KEY), false, `the receipt must never carry the dummy api key: ${binding.relativePath}`)
      assert.equal(/"apiKey"/.test(onDisk), false, `the receipt must never carry an apiKey field: ${binding.relativePath}`)
      assert.equal(/"authorization"/i.test(onDisk), false, `the receipt must never carry an authorization header: ${binding.relativePath}`)
      assert.equal(/sk-[A-Za-z0-9]{8,}/.test(onDisk), false, `the receipt must never carry a key-shaped token: ${binding.relativePath}`)
      assertNoSecrets(binding.receipt, { label: `E3 worker receipt ${binding.botId}` })
      binding.localSha256 = sha256Of(contents)
      binding.sizeBytes = Buffer.byteLength(contents)
    }

    // Core hashes the bytes on disk, so the digest is the Host's, never the client's.
    for (const binding of bindings) {
      const registered = await core.request('loom.artifact.register', {
        missionId, taskId: binding.taskId, agentRunId: binding.agentRunId, relativePath: binding.relativePath
      })
      const { artifact } = registered
      assert.equal(registered.replayed, false, `the first registration of ${binding.relativePath} must not be a replay: ${JSON.stringify(registered)}`)
      assert.equal(typeof artifact.artifactId, 'string', `the registration receipt must carry an artifactId: ${JSON.stringify(artifact)}`)
      assert.equal(artifact.planId, planId, `the artifact must be bound to the Mission's plan: ${JSON.stringify(artifact)}`)
      assert.equal(artifact.taskId, binding.taskId, `the artifact must echo its Task: ${JSON.stringify(artifact)}`)
      assert.equal(artifact.relativePath, binding.relativePath, `the artifact must keep its Mission-relative path: ${JSON.stringify(artifact)}`)
      assert.equal(artifact.sha256, binding.localSha256, `the Host must hash the bytes on disk, never a client digest: ${JSON.stringify(artifact)}`)
      assert.equal(artifact.sizeBytes, binding.sizeBytes, `the Host must record the registered byte count: ${JSON.stringify(artifact)}`)
      assert.equal(artifact.creatorId, 'local_user', `the Host must inject the creator identity: ${JSON.stringify(artifact)}`)
      binding.artifact = artifact
    }

    // A bare evidence string is not evidence: refused, nothing written, so the live fence is untouched.
    await expectRejection(core.request('loom.candidate.record', {
      missionId, taskId: TASK_A, agentRunId: runA, claimId: claimA.claimId, fenceGeneration: claimA.fenceGeneration,
      commandId: randomUUID(), contentHash: sha256Of('unregistered'), evidenceIds: ['evidence-never-registered'],
      acceptanceCriteriaVersion: ACCEPTANCE_CRITERIA_VERSION
    }), 'loom.candidate.record', 'LOOM_EVIDENCE_NOT_FOUND')
    assert.equal((await taskStatus(missionId, TASK_A)).status, 'ready',
      'a refused submission must leave its Task ready, not in review')
    assert.equal((await core.request('loom.candidates.list', { missionId })).length, 0,
      'a refused submission must not record a candidate')

    // The two real submissions, each under its own claim/fence/Run.
    for (const binding of bindings) {
      const candidate = await core.request('loom.candidate.record', {
        missionId,
        taskId: binding.taskId,
        agentRunId: binding.agentRunId,
        claimId: binding.claim.claimId,
        fenceGeneration: binding.claim.fenceGeneration,
        commandId: randomUUID(),
        contentHash: binding.localSha256,
        evidenceIds: [binding.artifact.artifactId],
        acceptanceCriteriaVersion: ACCEPTANCE_CRITERIA_VERSION
      })
      assert.equal(candidate.taskId, binding.taskId, `the candidate must bind its Task: ${JSON.stringify(candidate)}`)
      assert.equal(candidate.agentRunId, binding.agentRunId, `the candidate must bind the Run that held the claim: ${JSON.stringify(candidate)}`)
      assert.equal(candidate.contentHash, binding.localSha256, `the candidate must keep the registered artifact digest: ${JSON.stringify(candidate)}`)
      assert.deepEqual(candidate.evidenceIds, [binding.artifact.artifactId], `the candidate must keep the registered evidence id: ${JSON.stringify(candidate)}`)
      assert.equal(candidate.replayed, false, `the first submission must not be a replay: ${JSON.stringify(candidate)}`)
      assert.equal(candidate.verificationStatus, 'unverified', `a new candidate starts unverified: ${JSON.stringify(candidate)}`)
      assert.equal(candidate.acceptanceStatus, 'pending', `a new candidate starts pending acceptance: ${JSON.stringify(candidate)}`)
      binding.candidate = candidate
    }

    // ---- 8. Nothing auto-approves: OwnerReview stays pending, no review is ever recorded ----
    for (const binding of bindings) {
      const afterSubmit = await taskStatus(missionId, binding.taskId)
      assert.equal(afterSubmit.status, 'in_review', `a recorded candidate must move ${binding.taskId} into review: ${JSON.stringify(afterSubmit.listed)}`)
      assert.notEqual(afterSubmit.status, 'done', `submitting must never mark ${binding.taskId} done: ${JSON.stringify(afterSubmit.listed)}`)
    }
    assert.deepEqual(await core.request('loom.reviews.list', { missionId }), [],
      'submitting a candidate must never create a review; the Owner verdict is pending')

    // ---- 9. Read the facts back from Core (claims / candidates / artifacts / UI bundle API) ----
    const claimsResult = await core.request('loom.claims.list', { missionId })
    const claimRows = claimsResult.claims
    assert.equal(claimRows.length, 2, `Core must hold exactly two claims: ${JSON.stringify(claimRows)}`)
    assert.deepEqual(claimRows.map((row) => row.claimId).sort(), [claimA.claimId, claimB.claimId].sort(),
      `the two stored claims must be the two acquired ones: ${JSON.stringify(claimRows)}`)
    assert.deepEqual(claimRows.map((row) => row.taskId).sort(), [TASK_A, TASK_B].sort(),
      `the two stored claims must cover both independent Tasks: ${JSON.stringify(claimRows)}`)
    assert.ok(claimRows.every((row) => row.releasedAt === null),
      `both claims must still be held (unreleased) at submission time: ${JSON.stringify(claimRows)}`)

    const candidatesResult = await core.request('loom.candidates.list', { missionId })
    assert.equal(candidatesResult.length, 2, `Core must list exactly two candidates: ${JSON.stringify(candidatesResult)}`)
    for (const candidate of candidatesResult) {
      assert.equal(candidate.verificationStatus, 'unverified', `no technical verification, so it stays unverified: ${JSON.stringify(candidate)}`)
      assert.equal(candidate.acceptanceStatus, 'pending', `no Owner verdict, so acceptance stays pending: ${JSON.stringify(candidate)}`)
    }

    const artifactsResult = await core.request('loom.artifacts.list', { missionId })
    const artifactRows = artifactsResult.artifacts
    assert.equal(artifactRows.length, 2, `Core must list exactly two artifacts: ${JSON.stringify(artifactRows)}`)
    assert.deepEqual(artifactRows.map((row) => row.sha256).sort(), bindings.map((b) => b.localSha256).sort(),
      `Core must keep both Host-computed receipt digests: ${JSON.stringify(artifactRows)}`)
    assert.deepEqual(artifactRows.map((row) => row.relativePath).sort(), bindings.map((b) => b.relativePath).sort(),
      `Core must keep both Mission-relative receipt paths: ${JSON.stringify(artifactRows)}`)

    // The UI fact API (bundles.getMany) is OPTIONAL: the cached Core binary may predate it. That single,
    // explicit "unsupported core method" failure downgrades to the already-read claims/candidates/artifacts
    // lists and is reported honestly; any other error is never swallowed.
    const bundleOutcome = await core.request('loom.bundles.getMany', { missionIds: [missionId] }).then(
      (result) => {
        // A transport may deliver the explicit unsupported-method body as a resolved result; treat it the
        // same as the rejected form so the downgrade is robust to framing, while any other non-bundle
        // result still fails the strict assertion below.
        if (result && result.kind === 'infrastructure_failure'
          && isUnsupportedCoreMethodError(result, 'loom.bundles.getMany')) {
          return { ok: false, error: result }
        }
        const bundles = Array.isArray(result?.bundles) ? result.bundles : []
        assert.equal(bundles.length, 1,
          `the UI bundle batch must answer for its one Mission: ${JSON.stringify(result)}`)
        return { ok: true, bundle: bundles[0] }
      },
      (error) => ({ ok: false, error })
    )
    const uiFacts = resolveUiBundleFacts(bundleOutcome, {
      missionId,
      taskCount: 2,
      candidateCount: 2,
      artifactCount: 2
    })

    // ---- 10. Build the one evidence object this file may ever claim ----
    evidence = {
      ok: true,
      ...E3_EVIDENCE_ENVELOPE,
      fixturePath: fixture,
      coreBinary: binaryMeta,
      coreStartup,
      piBundle: loopback.piBundle,
      stagedExtension: loopback.stagedExtension,
      isolation: {
        ...loopback.isolation,
        dataRootIsProtectedWindowsRoot: true,
        dataRootInsideFixture: contained(dataDir),
        skillRootInsideDataRoot: contained(skillRoot),
        mcpConfigInsideDataRoot: contained(mcpPath),
        userScopedRootsRedirected: true,
        argvAllInsideFixture: true,
        userDatabaseTouched: false,
        port64851Touched: false,
        globalMcpConfigTouched: false,
        realPiProfileTouched: false
      },
      concurrency: loopback.concurrency,
      systemPromptHashesDiffer: loopback.systemPromptHashesDiffer,
      mission: {
        missionId,
        planId,
        acceptanceCriteriaVersion: ACCEPTANCE_CRITERIA_VERSION,
        taskIds: [TASK_A, TASK_B],
        dependencyIds: imported.dependencyIds
      },
      claims: {
        count: claimRows.length,
        claimIds: claimRows.map((row) => row.claimId),
        taskIds: claimRows.map((row) => row.taskId),
        allUnreleasedAtSubmit: claimRows.every((row) => row.releasedAt === null)
      },
      workers: bindings.map((binding) => ({
        botId: binding.botId,
        taskId: binding.taskId,
        relativePath: binding.relativePath,
        agentDir: binding.worker.agentDir,
        providerPort: binding.worker.providerPort,
        artifactId: binding.artifact.artifactId,
        artifactSha256: binding.artifact.sha256,
        claimId: binding.claim.claimId,
        fenceGeneration: binding.claim.fenceGeneration,
        agentRunId: binding.agentRunId,
        sessionId: binding.receipt.sessionId,
        providerRequestCount: binding.receipt.providerRequestCount,
        providerSystemPromptSha256: binding.receipt.providerSystemPromptSha256,
        agentSettledObserved: true,
        candidateId: binding.candidate.candidateId,
        verificationStatus: 'unverified',
        acceptanceStatus: 'pending'
      })),
      ownerReview: {
        recorded: false,
        pending: true,
        simulatedFixtureAction: false,
        userUiApproval: false,
        reviewsCount: 0,
        tasksStatus: { [TASK_A]: 'in_review', [TASK_B]: 'in_review' },
        candidatesAcceptanceStatus: { [TASK_A]: 'pending', [TASK_B]: 'pending' }
      },
      uiFacts
    }
    // The ceiling is asserted on the finished object too, so no later field can quietly leak.
    assertNoSecrets(evidence, { label: 'LOOM E3 core-pi final evidence' })
    const evidenceText = JSON.stringify(evidence, null, 2)
    assert.equal(evidenceText.includes(prompt), false, 'the final evidence must never carry the plaintext prompt')
    assert.equal(evidenceText.includes(DUMMY_API_KEY), false, 'the final evidence must never carry the dummy api key')

    // ---- 11. Core is the last witness: stop it before the fixture is inspected and deleted ----
    await stopCoreOrFail(core, 'before the temporary root is inspected and deleted')
    core = null
    // Core may only populate the data dir it was given; it may not add a sibling to it.
    assert.deepEqual((await readdir(fixture)).sort(), rootBefore,
      'Core must create nothing beside the paths this fixture already owned')
  } catch (error) {
    mainError = error
  } finally {
    const cleanupErrors = []
    if (core) {
      try {
        await stopCoreOrFail(core, 'in teardown')
      } catch (error) {
        // A Core whose exit cannot be confirmed keeps the fixture whole: inspecting or deleting paths a
        // live Core may still be writing would race it and destroy the evidence.
        preserveFixture = true
        cleanupErrors.push(error)
      }
      core = null
    }
    if (!preserveFixture) {
      if (dataDir) {
        try {
          await removeEphemeralRuntimeCampFilesRoot(dataDir, { temporaryDirectory: fixture, homeDirectory: isolatedHome })
          if (!contained(runtimeFilesRoot)) {
            cleanupErrors.push(new Error(`Runtime Files Root escaped the fixture: ${runtimeFilesRoot}`))
          }
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      if (!keepFixture) {
        try {
          await rm(fixture, { recursive: true, force: true })
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
    }
    if (cleanupErrors.length > 0) {
      const errors = mainError ? [mainError, ...cleanupErrors] : cleanupErrors
      throw new AggregateError(errors, 'LOOM E3 core-pi integration teardown failed; refusing to report a green run')
    }
  }
  if (mainError) throw mainError
  return evidence
}

// ---------------------------------------------------------------------------
// Real-Core JSON-RPC harness (new test utility class; the one in loom-core-e2e.test.mjs is not
// exported). Framing/startup/RPC + bounded staged shutdown are identical to that proven scaffold.
// ---------------------------------------------------------------------------

export function startIsolatedCore({ dataDir, skillRoot, mcpPath, binaryPath, environment }) {
  const args = [
    ...coreDataDirectoryArguments(dataDir, { homeDirectory: environment.HOME }),
    '--skill-library-root', skillRoot,
    '--mcp-config-path', mcpPath
  ]
  const child = spawn(binaryPath, args, {
    cwd: repository,
    env: { ...process.env, ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
    // POSIX gets its own process group so the bounded kill reaches every descendant; Windows closes
    // the tree through `taskkill /T` instead.
    detached: process.platform !== 'win32'
  })
  const pending = new Map()
  const startupFrames = []
  const notifications = []
  let nextId = 0
  let stderr = ''
  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  // A separate, bounded ready budget. On timeout the failure names the stage, the elapsed time and the
  // last startup frame instead of a bare message — it never skips ready or fakes a green start.
  const readyStartedAt = Date.now()
  let readyAt = null
  let settledAt = null
  const startupTimeout = setTimeout(() => {
    const lastFrame = startupFrames.length > 0 ? startupFrames[startupFrames.length - 1] : null
    rejectReady(Object.assign(
      new Error(`Core ready timeout after ${Date.now() - readyStartedAt}ms (ready budget ${READY_BUDGET_MS}ms);`
        + ` lastStartupFrame=${JSON.stringify(lastFrame)}; stderrTail=${stderr}`),
      {
        stage: 'ready',
        waitedMs: Date.now() - readyStartedAt,
        readyBudgetMs: READY_BUDGET_MS,
        lastStartupFrame: lastFrame
      }
    ))
  }, READY_BUDGET_MS)
  // 'exit', not 'close', proves the pid is gone; stdio streams can outlive the process.
  const exitEvent = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  async function waitForExit(milliseconds) {
    if (child.exitCode !== null || child.signalCode !== null || !pidAlive(child.pid)) return true
    let timer
    try {
      return await Promise.race([
        exitEvent.then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds) })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  child.stdin.on('error', () => {})
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000) })
  child.on('error', rejectReady)
  child.once('exit', (code) => {
    clearTimeout(startupTimeout)
    const error = new Error(`Core exited before usable ready/RPC (code=${code}): ${stderr}`)
    rejectReady(error)
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const message = JSON.parse(line)
    if (message.kind === 'core_startup') startupFrames.push(message)
    if (message.method) notifications.push(message)
    if (message.kind === 'core_startup' && message.status === 'ready') {
      clearTimeout(startupTimeout)
      readyAt = Date.now()
      resolveReady(message)
    }
    if (message.kind === 'core_startup' && ['failed', 'blocked'].includes(message.status)) {
      clearTimeout(startupTimeout)
      rejectReady(Object.assign(new Error(message.error?.message ?? 'Startup refused'), message.error, {
        phase: message.phase, startupStatus: message.status
      }))
    }
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) request.reject(message.error)
      else request.resolve(message.result)
    }
  })
  async function request(method, params = {}) {
    await ready
    const id = String(++nextId)
    let timeout
    try {
      return await Promise.race([
        new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject })
          child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
        }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${method} timed out: ${JSON.stringify(params)}`)), 30_000) })
      ])
    } finally {
      clearTimeout(timeout)
      pending.delete(id)
    }
  }
  return {
    process: child,
    args,
    startupFrames,
    ready,
    request,
    notifications,
    // Startup stage telemetry: how long ready actually took and how long optional init settled.
    get readyElapsedMs() { return readyAt === null ? null : readyAt - readyStartedAt },
    get settledElapsedMs() { return settledAt === null || readyAt === null ? null : settledAt - readyAt },
    stderrTail: () => stderr,
    async settled() {
      const startedAt = Date.now()
      const deadline = startedAt + SETTLED_BUDGET_MS
      while (Date.now() < deadline) {
        const states = await request('runtime.subsystems.get')
        if (states.every((entry) => entry.state !== 'initializing')) {
          settledAt = Date.now()
          return states
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw Object.assign(
        new Error(`Optional initialization did not settle within ${SETTLED_BUDGET_MS}ms`),
        { stage: 'settled', waitedMs: Date.now() - startedAt, settledBudgetMs: SETTLED_BUDGET_MS }
      )
    },
    // Staged and bounded: stdin end -> SIGTERM (5s) -> process-group SIGKILL (15s), never past a 20s
    // total. Every stage either observes the exit event (or a dead pid) or throws with its own stage
    // name and the pid: a close that quietly returned would let the caller read Core's files or delete
    // the fixture while Core still holds the handles.
    async close() {
      const pid = child.pid
      const totalBudget = 20_000
      const startedAt = Date.now()
      const remaining = () => Math.max(startedAt + totalBudget - Date.now(), 0)
      let stage = 'stdin-end'
      const timedOut = (detail = '') => Object.assign(
        new Error(`Core pid=${pid} did not exit in the ${stage} stage`
          + ` (waited ${Date.now() - startedAt}ms of ${totalBudget}ms, exitCode=${child.exitCode}, signal=${child.signalCode})`
          + `${detail}: ${stderr}`),
        { stage, pid, waitedMs: Date.now() - startedAt, exitCode: child.exitCode, signalCode: child.signalCode }
      )
      try {
        if (!child.stdin.destroyed) child.stdin.end()
        if (await waitForExit(Math.min(remaining(), 5_000))) return
        stage = 'sigterm'
        child.kill('SIGTERM')
        if (await waitForExit(Math.min(remaining(), 5_000))) return
        stage = 'sigkill'
        const killBudget = remaining()
        if (killBudget <= 0) throw timedOut()
        killProcessTree(child, killBudget)
        if (await waitForExit(remaining())) return
        throw timedOut()
      } catch (error) {
        if (error?.stage === stage && error?.pid === pid) throw error
        throw Object.assign(timedOut(` - ${error?.message ?? error}`), { cause: error })
      } finally {
        clearTimeout(startupTimeout)
        lines.close()
      }
    },
    async exited(timeout = 5_000) {
      const gone = await waitForExit(timeout)
      return { pid: child.pid, gone, exitCode: child.exitCode, signalCode: child.signalCode }
    }
  }
}

// A resolved close() is a claim about a process, so this is the gate every fixture read/delete waits on.
export async function stopCoreOrFail(core, when) {
  try {
    await core.close()
  } catch (error) {
    assert.fail(`Core did not stop ${when}: stage=${error?.stage} pid=${error?.pid}`
      + ` waited=${error?.waitedMs}ms exitCode=${error?.exitCode} signal=${error?.signalCode} - ${error?.message}`)
  }
  const gone = await core.exited()
  assert.equal(gone.gone, true, `Core must have exited ${when}: ${JSON.stringify(gone)}`)
  return gone
}

// `kill(pid, 0)` is the only portable liveness probe Node exposes: ESRCH is proof of absence, EPERM
// means the pid exists and only the signal was refused.
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

// Windows and POSIX report a failed tree kill differently; liveness is judged by the caller's bounded
// wait, never here.
function killProcessTree(child, budgetMs = 15_000) {
  const pid = child.pid
  if (!pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    const outcome = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: budgetMs,
      killSignal: 'SIGKILL'
    })
    const detail = [
      outcome.error ? `${outcome.error.code ?? 'spawn-error'}: ${outcome.error.message}` : '',
      `${outcome.stderr ?? ''}`.trim(),
      `${outcome.stdout ?? ''}`.trim()
    ].filter(Boolean).join(' | ')
    if (outcome.error || outcome.status !== 0) {
      throw Object.assign(
        new Error(`taskkill.exe /PID ${pid} /T /F failed (status=${outcome.status}, signal=${outcome.signal}): ${detail}`),
        { stage: 'taskkill', pid, status: outcome.status, stderr: detail }
      )
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw Object.assign(
        new Error(`process.kill(-${pid}, 'SIGKILL') failed: ${error?.message ?? error}`),
        { stage: 'sigkill-group', pid, code: error?.code }
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Direct CLI entry: node scripts/loom-v2-core-pi-integration.mjs
// ---------------------------------------------------------------------------

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  runCorePiIntegrationEvidence()
    .then((evidence) => {
      console.log(JSON.stringify(evidence, null, 2))
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error))
      process.exitCode = 1
    })
}

// LOOM E3 · 单一真实 Core + 两个并发真实 Pi（本机假 Provider）的双 Worker 交付闭环，沙箱专用。
//
// Scope (E3-sandbox-only):
// - 真实启动当前 target/debug/rovai-core.exe（由 Root 另行受控 cargo build；本文件从不编译）。
// - 一个独占的 Windows protected Core data-root（--prepare-windows-data-root）+ 独占 skill-root +
//   独占 mcp.json，全部落在本次 mkdtemp fixture 内；HOME/USERPROFILE/TMP/TEMP/XDG 一并重定向进
//   fixture。绝不触碰用户日常 DB、64851、~/.pi、全局 mcp.json 或全局 Skill Library。
// - 同一个 Core SQLite 里的一个新 Mission 导入三 Task Plan：A、B 相互独立且可同时 claim；C 依赖 A
//   的 artifact_accepted 边，只用来证明"未经 Owner Review 时阻断"。
// - 顺序是 claim A/B → 真跑两个并发 Pi 0.85.1（各自独立 profile + 各自 127.0.0.1:0 假 Provider）
//   → 每个 Bot 必须给出自己的 agent_settled → 把 claim/fence/agentRunId/session/sha256 摘要写成
//   quick-chat 工作区里的两个 receipt 文件 → Core 自己 hash 并注册成 artifact → 两个 candidate。
// - 两个 candidate 提交后必须 pending/unverified、Task 停在 in_review、reviews.list 为空：提交永不
//   自动 approve，也永不自动 done。
// - Owner Review 是**单独的显式 fixture 动作**，只对 A 调用一次 loom.review.record；reviewerId 由
//   Host 注入 local_user（payload 里的 'fake' 被覆盖）。B 保持 pending。A 已批准但没有任何
//   technical verification，所以 C 的 artifact_accepted 边仍不释放、C 仍不可 claim。
//   这不是用户 UI 审批，也不能被读成"用户已经在产品里批准过"。
//
// Evidence ceiling: 只留 sha256、字节数、计数、布尔、枚举和临时路径；绝不输出明文 prompt、apiKey、
// Authorization。final evidence 固定声明 mockProvider=true / realExternalProvider=false /
// scope='E3-sandbox-only' / realCommercialModel=false / userCredentialsUsed=false。
// 本文件不调用 loom.verification.record：E3 停在 Owner Review，技术核验属于 E4。
//
// 失败诊断：Core 的 bounded close 若不能确认 pid 已消失，fixture 整体保留（删除可能仍在写的目录
// 既会与活进程竞争，也会毁掉唯一证据）；ROVAI_KEEP_LOOM_E3_FIXTURE=1 可在任意失败时保留 fixture。
//
// Run (from loom/):
//   node --test --test-timeout=900000 scripts/lib/loom-v2-two-pi-core-delivery.test.mjs

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  coreDataDirectoryArguments,
  removeEphemeralRuntimeCampFilesRoot,
  runtimeCampFilesRootForDataDirectory
} from './runtime-camp-files-root.mjs'
import {
  DEFAULT_TWO_WORKER_PROMPT,
  assertNoSecrets,
  runTwoWorkerLoopbackEvidence
} from '../loom-v2-two-worker-loopback.mjs'
import { DUMMY_API_KEY } from '../loom-v2-pi-loopback-provider.mjs'

const repository = resolve(import.meta.dirname, '../..')
const binary = process.env.ROVAI_CORE_BIN
  ?? join(repository, 'target', 'debug', process.platform === 'win32' ? 'rovai-core.exe' : 'rovai-core')

/** The only evidence envelope this file may ever claim. Every field is a standing declaration. */
const E3_EVIDENCE_ENVELOPE = Object.freeze({
  scope: 'E3-sandbox-only',
  mockProvider: true,
  realExternalProvider: false,
  realCommercialModel: false,
  userCredentialsUsed: false,
  coreIntegrated: true,
  providerPromptSeen: true,
  // The Owner verdict below is a fixture action performed by this test, never a user UI approval,
  // and no technical verification is recorded in E3.
  ownerReviewUiApproved: false,
  technicalVerificationRecorded: false
})

const TASK_A = 'loom-e3-worker-a'
const TASK_B = 'loom-e3-worker-b'
const TASK_C = 'loom-e3-dependent-c'
const ACCEPTANCE_CRITERIA_VERSION = 'ac-e3'
// A Run that really drives two Pi processes needs a lease longer than the 300s default; the lease is
// still the fence the submission presents, so this is a budget, not a bypass.
const CLAIM_LEASE_SECONDS = 1800

const sha256Of = (contents) => createHash('sha256').update(contents).digest('hex')

// This owns the E3 seam end to end: real Core authority -> real claim/fence -> two concurrent real Pi
// workers over local fake providers -> Host-hashed artifacts -> two pending candidates -> one explicit
// Owner review. The LOOM state machine's own matrix stays in crates/rovai-core/src/loom.rs unit tests,
// and the Core wire shapes without any Runtime stay in scripts/lib/loom-core-e2e.test.mjs; neither can
// prove that a real double-Pi run binds its receipts to a real claim/fence and stays unapproved.
test('a real Core holds two concurrent real Pi workers on one Mission and keeps both candidates pending until one explicit Owner review', {
  timeout: 900_000
}, async (t) => {
  // The pinned Pi bundle is windows-x64 pi.exe and the protected data-root is a Windows contract, so
  // this sandbox run has no honest POSIX form. Skipping is reported as skipped, never as green.
  if (process.platform !== 'win32') {
    t.skip(`E3-sandbox-only: the pinned Pi bundle is windows-x64 pi.exe and the protected Core data-root is a Windows contract (host is ${process.platform})`)
    return
  }
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-loom-e3-')))
  // `rm` is idempotent, so the finally below can remove the fixture first; a Core whose exit could not
  // be confirmed sets `preserveFixture`, because deleting files a live process still owns would destroy
  // the only evidence of what went wrong.
  let preserveFixture = false
  const keepFixture = process.env.ROVAI_KEEP_LOOM_E3_FIXTURE === '1'
  t.after(async () => {
    if (preserveFixture || keepFixture) {
      console.error(`LOOM E3 fixture preserved at ${fixture}`)
      return
    }
    await rm(fixture, { recursive: true, force: true })
  })
  const isolatedHome = join(fixture, 'home')
  const isolatedTemporary = join(fixture, 'tmp')
  const isolatedRuntimeDirectory = join(fixture, 'runtime-dir')
  await mkdir(isolatedHome)
  await mkdir(isolatedTemporary)
  await mkdir(isolatedRuntimeDirectory)
  // Every user-scoped root Core could reach is redirected into this fixture, so a write outside the
  // data dir still has to land inside the temporary root to be allowed.
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
  // A missing binary must fail as an actionable assertion, not as a Core startup timeout.
  assert.ok(await lstat(binary).then(() => true, () => false),
    `rovai-core is missing at ${binary}; build it first: cargo build -p rovai-core --bin rovai-core`)
  const binarySha256 = sha256Of(await readFile(binary))
  // The protected root is created by Core itself: a plain `mkdir` would inherit ACLs and be refused.
  const dataDir = JSON.parse(execFileSync(binary, ['--prepare-windows-data-root', join(fixture, 'formal')], { encoding: 'utf8' })).core
  const skillRoot = join(dataDir, 'managed-skill-library')
  const mcpPath = join(dataDir, 'mcp.json')
  const runtimeFilesRoot = runtimeCampFilesRootForDataDirectory(dataDir, { homeDirectory: isolatedHome })
  const contained = path => {
    const offset = relative(fixture, path)
    return offset !== '' && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
  }
  // The root Core is about to receive, recorded before it starts: nothing but the paths this fixture
  // already owns may appear beside it afterwards, so an escaped write cannot hide in the fixture.
  const rootBefore = (await readdir(fixture)).sort()
  let core = startIsolatedCore({
    dataDir,
    skillRoot,
    mcpPath,
    binaryPath: binary,
    environment: isolatedEnvironment
  })
  let database = null
  try {
    await core.ready
    await core.settled()
    // With HOME inside the fixture there is no exception for the Runtime Files Root: every absolute
    // argument must be contained.
    assert.deepEqual(
      core.args.filter(argument => isAbsolute(argument) && !contained(argument)),
      [],
      `Core must be launched with paths inside the exclusive temporary root only: ${JSON.stringify(core.args)}`)
    assert.ok(contained(dataDir), `the protected data-root must stay inside the fixture: ${dataDir}`)
    assert.ok(contained(skillRoot) && contained(mcpPath) && contained(runtimeFilesRoot),
      'the skill root, MCP config and Runtime Files Root must all stay inside the fixture')

    const members = await core.request('members.list')
    const agent = members.find(profile => profile.presence === 'present')
    assert.ok(agent, `the fixture authority must expose one present member profile: ${JSON.stringify(members)}`)

    // A rejection arrives as the bare `{kind, code, message, retryable, details}` body, so every
    // expectation names its code and reprints the raw body when it fails.
    const expectRejection = async (promise, method, code) => {
      const outcome = await promise.then(result => ({ result }), error => ({ error }))
      assert.ok(outcome.error,
        `${method} must be rejected with ${code}, received ${JSON.stringify(outcome.result)}`)
      const { error } = outcome
      assert.equal(error.code, code, `${method} must be rejected with ${code}: ${JSON.stringify(error)}`)
      assert.equal(error.kind, 'domain_rejection', `${method} must be a domain rejection: ${JSON.stringify(error)}`)
      assert.equal(error.retryable, false, `${method} must not be retryable: ${JSON.stringify(error)}`)
      return error
    }
    const taskStatus = async (missionId, taskId) => {
      const listed = await core.request('loom.tasks.list', { missionId })
      const task = listed.find(entry => entry.taskId === taskId)
      assert.ok(task, `task ${taskId} must be listed for its Mission: ${JSON.stringify(listed)}`)
      return { status: task.status, listed }
    }

    const missionId = (await core.request('missions.create', {
      commandId: randomUUID(),
      command: {
        title: 'LOOM E3 two-worker sandbox delivery',
        description: 'Owns the real Core + double real Pi sandbox seam; the Owner verdict is a fixture action.',
        projectPath: '',
        projectBindingKind: 'quick_chat',
        memberAgentIds: [agent.agentId],
        defaultLeadAgentId: agent.agentId,
        tags: ['loom-e3-sandbox']
      }
    })).payload?.missionId
    assert.equal(typeof missionId, 'string', `missions.create must answer with a missionId: ${missionId}`)

    // A and B are independent: no edge between them, so both are claimable at the same time. C is the
    // only dependent Task and exists to prove the block, never to be delivered in E3.
    const criteria = [
      { criterionId: 'criterion-worker-a', text: 'worker A delivered its own receipt digest as a registered artifact' },
      { criterionId: 'criterion-worker-b', text: 'worker B delivered its own receipt digest as a registered artifact' }
    ]
    const imported = await core.request('loom.plan.import', {
      missionId,
      goal: 'Two real Pi workers deliver receipts into one Core Mission without an automatic approval',
      acceptanceCriteriaVersion: ACCEPTANCE_CRITERIA_VERSION,
      criteria,
      tasks: [
        { taskId: TASK_A, title: 'Worker A receipt', description: 'Independent parallel Task, no edges' },
        { taskId: TASK_B, title: 'Worker B receipt', description: 'Independent parallel Task, no edges' },
        { taskId: TASK_C, title: 'Dependent Task', description: 'Blocked until A is accepted AND technically verified' }
      ],
      dependencies: [{ upstreamTaskId: TASK_A, downstreamTaskId: TASK_C, condition: 'artifact_accepted' }]
    })
    assert.equal(imported.missionId, missionId, `the import must answer for its Mission: ${JSON.stringify(imported)}`)
    const planId = imported.planId
    assert.equal(typeof planId, 'string', `the import receipt must carry its planId: ${JSON.stringify(imported)}`)
    assert.deepEqual(imported.taskIds, [TASK_A, TASK_B, TASK_C],
      `the import receipt must name every Task: ${JSON.stringify(imported)}`)
    assert.equal(imported.dependencyIds.length, 1,
      `the import receipt must name the single edge: ${JSON.stringify(imported)}`)
    const [dependencyId] = imported.dependencyIds

    // Release only moves DRAFT -> READY and never looks at the edges, which is why C can be released
    // too: the block below must then come from the dependency, not from the Task still being a draft.
    for (const releasedTaskId of [TASK_A, TASK_B, TASK_C]) {
      const released = await core.request('loom.task.release', { missionId, taskId: releasedTaskId })
      assert.equal(released.task.status, 'ready',
        `loom.task.release must move ${releasedTaskId} to ready: ${JSON.stringify(released)}`)
    }

    // ---- Claims first: the real Pi run must submit under fences that already exist ----
    const runA = randomUUID()
    const runB = randomUUID()
    const claimCommandA = randomUUID()
    const claimA = await core.request('loom.claim.acquire', {
      missionId,
      taskId: TASK_A,
      agentRunId: runA,
      commandId: claimCommandA,
      leaseSeconds: CLAIM_LEASE_SECONDS
    })
    assert.equal(claimA.taskId, TASK_A, `the claim must bind its Task: ${JSON.stringify(claimA)}`)
    assert.equal(claimA.agentRunId, runA, `the claim must bind its AgentRun: ${JSON.stringify(claimA)}`)
    assert.equal(claimA.planId, planId, `the claim must bind the Mission's plan: ${JSON.stringify(claimA)}`)
    assert.equal(claimA.replayed, false, `the first claim of A must not be a replay: ${JSON.stringify(claimA)}`)
    assert.equal(typeof claimA.claimId, 'string', `the claim receipt must carry its claimId: ${JSON.stringify(claimA)}`)
    assert.ok(Number.isInteger(claimA.fenceGeneration) && claimA.fenceGeneration >= 1,
      `the claim receipt must carry a fence generation: ${JSON.stringify(claimA)}`)
    const claimB = await core.request('loom.claim.acquire', {
      missionId,
      taskId: TASK_B,
      agentRunId: runB,
      commandId: randomUUID(),
      leaseSeconds: CLAIM_LEASE_SECONDS
    })
    assert.equal(claimB.taskId, TASK_B, `the claim must bind its Task: ${JSON.stringify(claimB)}`)
    assert.equal(claimB.agentRunId, runB, `the claim must bind its AgentRun: ${JSON.stringify(claimB)}`)
    assert.equal(claimB.replayed, false, `the first claim of B must not be a replay: ${JSON.stringify(claimB)}`)
    assert.notEqual(claimB.claimId, claimA.claimId, 'two parallel Tasks must hold two different claims')
    // Both parallel Tasks are held at the same instant: that is what makes them concurrent work.
    const afterClaims = await core.request('loom.tasks.list', { missionId })
    assert.deepEqual(
      afterClaims.filter(task => [TASK_A, TASK_B].includes(task.taskId)).map(task => task.status),
      ['ready', 'ready'],
      `both independent Tasks must be claimable and still ready: ${JSON.stringify(afterClaims)}`)

    // (neg 1) The same claim command must be idempotent, and reusing it against another Run is a conflict.
    const replayedClaim = await core.request('loom.claim.acquire', {
      missionId,
      taskId: TASK_A,
      agentRunId: runA,
      commandId: claimCommandA,
      leaseSeconds: CLAIM_LEASE_SECONDS
    })
    assert.equal(replayedClaim.replayed, true,
      `a replayed claim command must report its replay: ${JSON.stringify(replayedClaim)}`)
    assert.equal(replayedClaim.claimId, claimA.claimId,
      `a replayed claim command must return the original claim: ${JSON.stringify(replayedClaim)}`)
    assert.equal(replayedClaim.fenceGeneration, claimA.fenceGeneration,
      `a replay must not advance the fence: ${JSON.stringify(replayedClaim)}`)
    await expectRejection(core.request('loom.claim.acquire', {
      missionId,
      taskId: TASK_A,
      agentRunId: randomUUID(),
      commandId: claimCommandA,
      leaseSeconds: CLAIM_LEASE_SECONDS
    }), 'loom.claim.acquire', 'LOOM_CLAIM_COMMAND_REUSED')

    // (neg 2) C is blocked by its artifact edge before anything upstream was delivered.
    const blockedClaim = () => core.request('loom.claim.acquire', {
      missionId,
      taskId: TASK_C,
      agentRunId: randomUUID(),
      commandId: randomUUID(),
      leaseSeconds: CLAIM_LEASE_SECONDS
    })
    await expectRejection(blockedClaim(), 'loom.claim.acquire', 'LOOM_DEPENDENCY_UNRELEASED')

    // ---- Durability boundary: Core's lease is persisted before real workers execute. ----
    // Release the isolated Core process while the two sandboxed Pi workers execute. This
    // deliberately exercises recovery across a Core restart instead of relying on an
    // in-memory reducer or running three runtime supervisors at once. The same Core DB,
    // Mission, claimed fences and temporary fixture are reused after the run.
    await stopCoreOrFail(core, 'after persisting both claims and before the two Pi workers run')

    // ---- The two real Pi workers, concurrently, each over its own local fake provider ----
    const loopback = await runTwoWorkerLoopbackEvidence({ prompt: DEFAULT_TWO_WORKER_PROMPT })

    // Reopen exactly the same isolated data root; do not create a second Core authority.
    // The remaining candidate submissions must succeed against the claims written BEFORE
    // this restart. Otherwise lease/fence persistence has not been demonstrated.
    core = startIsolatedCore({
      dataDir,
      skillRoot,
      mcpPath,
      binaryPath: binary,
      environment: isolatedEnvironment
    })
    await core.ready
    await core.settled()
    const recoveredTasks = await core.request('loom.tasks.list', { missionId })
    assert.deepEqual(
      recoveredTasks.filter(task => [TASK_A, TASK_B].includes(task.taskId)).map(task => task.status),
      ['ready', 'ready'],
      'both previously claimed tasks must survive the isolated Core restart'
    )
    assert.equal(loopback.ok, true, `the two-worker loopback run must be ok: ${JSON.stringify(loopback.ok)}`)
    assert.equal(loopback.mockProvider, true, 'the run must declare its local fake provider')
    assert.equal(loopback.realExternalProvider, false, 'the run must never claim an external provider')
    assert.equal(loopback.preflightOnly, false, 'the workers must really have run, not just preflighted')
    assert.equal(loopback.concurrency.overlapped, true,
      `the two Pi workers must overlap in wall-clock time: ${JSON.stringify(loopback.concurrency)}`)
    assert.equal(loopback.workers.length, 2, `exactly two workers must report: ${loopback.workers.length}`)
    for (const worker of loopback.workers) {
      assert.equal(worker.agentSettledObserved, true,
        `worker ${worker.botId} must observe its own real agent_settled`)
      assert.ok(worker.providerRequestCount >= 1,
        `worker ${worker.botId} must have reached its own fake provider: ${worker.providerRequestCount}`)
      assert.equal(worker.providerSystemPromptSha256Verified, true,
        `worker ${worker.botId} must report a re-derived system prompt digest`)
      assert.equal(worker.providerSystemPromptSha256.length, worker.providerRequestCount,
        `worker ${worker.botId} must digest every provider request`)
      assert.equal(worker.loopbackOnly, true, `worker ${worker.botId} must stay loopback-only`)
      assert.equal(worker.dummyAuthOnly, true, `worker ${worker.botId} must use the dummy test key only`)
      assert.equal(worker.toolsSchemaAbsent, true, `worker ${worker.botId} must run with tools disabled`)
      assert.equal(typeof worker.sessionId, 'string', `worker ${worker.botId} must report a sessionId`)
      assert.ok(worker.sessionId.length > 0, `worker ${worker.botId} must report a non-empty sessionId`)
    }
    assert.equal(new Set(loopback.workers.map(worker => worker.sessionId)).size, 2,
      `the two workers must not share a sessionId: ${JSON.stringify(loopback.workers.map(worker => worker.sessionId))}`)
    assert.equal(new Set(loopback.workers.map(worker => worker.providerPort)).size, 2,
      `the two workers must not share a provider port: ${JSON.stringify(loopback.workers.map(worker => worker.providerPort))}`)

    // ---- Bind each worker's verified receipt to its own claim, fence and Run ----
    const workspaceDirectory = join(dataDir, 'quick-chat')
    await mkdir(workspaceDirectory, { recursive: true })
    const bindings = [
      { taskId: TASK_A, botId: 'bot_worker_a', agentRunId: runA, claim: claimA },
      { taskId: TASK_B, botId: 'bot_worker_b', agentRunId: runB, claim: claimB }
    ].map((binding) => {
      const worker = loopback.workers.find(entry => entry.botId === binding.botId)
      assert.ok(worker, `the loopback run must report worker ${binding.botId}: ${JSON.stringify(loopback.workers.map(entry => entry.botId))}`)
      // The receipt is a digest summary of the verified worker evidence: the plaintext prompt and the
      // dummy key never enter it, and the worker's own evidence is folded into one digest instead.
      const receipt = {
        schema: 'loom.e3.worker-receipt.v1',
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
        // Digests only: the prompt text and the worker evidence bytes stay out of the artifact.
        promptSha256: sha256Of(DEFAULT_TWO_WORKER_PROMPT),
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
      // The ceiling is enforced on the bytes that were actually written, not on the object in memory.
      assert.equal(onDisk.includes(DEFAULT_TWO_WORKER_PROMPT), false,
        `the receipt must never carry the plaintext prompt: ${binding.relativePath}`)
      assert.equal(onDisk.includes(DUMMY_API_KEY), false,
        `the receipt must never carry the dummy api key: ${binding.relativePath}`)
      assert.equal(/"apiKey"/.test(onDisk), false, `the receipt must never carry an apiKey field: ${binding.relativePath}`)
      assert.equal(/"authorization"/i.test(onDisk), false,
        `the receipt must never carry an authorization header: ${binding.relativePath}`)
      assert.equal(/sk-[A-Za-z0-9]{8,}/.test(onDisk), false,
        `the receipt must never carry a key-shaped token: ${binding.relativePath}`)
      assertNoSecrets(binding.receipt, { label: `E3 worker receipt ${binding.botId}` })
      binding.localSha256 = sha256Of(contents)
      binding.sizeBytes = Buffer.byteLength(contents)
    }

    // ---- Core registers the bytes it reads, so the digest is the Host's, never the client's ----
    for (const binding of bindings) {
      const registered = await core.request('loom.artifact.register', {
        missionId,
        taskId: binding.taskId,
        agentRunId: binding.agentRunId,
        relativePath: binding.relativePath
      })
      const { artifact } = registered
      assert.equal(registered.replayed, false,
        `the first registration of ${binding.relativePath} must not be a replay: ${JSON.stringify(registered)}`)
      assert.equal(typeof artifact.artifactId, 'string',
        `the registration receipt must carry an artifactId: ${JSON.stringify(artifact)}`)
      assert.equal(artifact.planId, planId, `the artifact must be bound to the Mission's plan: ${JSON.stringify(artifact)}`)
      assert.equal(artifact.taskId, binding.taskId, `the artifact must echo its Task: ${JSON.stringify(artifact)}`)
      assert.equal(artifact.relativePath, binding.relativePath,
        `the artifact must keep its Mission-relative path: ${JSON.stringify(artifact)}`)
      assert.equal(artifact.sha256, binding.localSha256,
        `the Host must hash the bytes on disk, never a client digest: ${JSON.stringify(artifact)}`)
      assert.equal(artifact.sizeBytes, binding.sizeBytes,
        `the Host must record the registered byte count: ${JSON.stringify(artifact)}`)
      assert.equal(artifact.creatorId, 'local_user',
        `the Host must inject the creator identity: ${JSON.stringify(artifact)}`)
      binding.artifact = artifact
    }

    // (neg 3) A bare evidence string is no longer evidence: the submission is refused and nothing is
    // written, so the claim below is still the live fence the real submission uses.
    const submissionBase = (binding) => ({
      missionId,
      taskId: binding.taskId,
      agentRunId: binding.agentRunId,
      claimId: binding.claim.claimId,
      fenceGeneration: binding.claim.fenceGeneration,
      contentHash: binding.localSha256,
      acceptanceCriteriaVersion: ACCEPTANCE_CRITERIA_VERSION
    })
    await expectRejection(core.request('loom.candidate.record', {
      ...submissionBase(bindings[0]),
      commandId: randomUUID(),
      evidenceIds: ['evidence-never-registered']
    }), 'loom.candidate.record', 'LOOM_EVIDENCE_NOT_FOUND')
    const afterUnregistered = await taskStatus(missionId, TASK_A)
    assert.equal(afterUnregistered.status, 'ready',
      `a refused submission must leave its Task ready, not in review: ${JSON.stringify(afterUnregistered.listed)}`)
    assert.equal((await core.request('loom.candidates.list', { missionId })).length, 0,
      'a refused submission must not record a candidate')

    // ---- The two real submissions ----
    for (const binding of bindings) {
      const candidate = await core.request('loom.candidate.record', {
        ...submissionBase(binding),
        commandId: randomUUID(),
        evidenceIds: [binding.artifact.artifactId]
      })
      assert.equal(candidate.taskId, binding.taskId, `the candidate must bind its Task: ${JSON.stringify(candidate)}`)
      assert.equal(candidate.agentRunId, binding.agentRunId,
        `the candidate must bind the Run that held the claim: ${JSON.stringify(candidate)}`)
      assert.equal(candidate.contentHash, binding.localSha256,
        `the candidate must keep the registered artifact digest: ${JSON.stringify(candidate)}`)
      assert.deepEqual(candidate.evidenceIds, [binding.artifact.artifactId],
        `the candidate must keep the registered evidence id: ${JSON.stringify(candidate)}`)
      assert.equal(candidate.replayed, false, `the first submission must not be a replay: ${JSON.stringify(candidate)}`)
      assert.equal(candidate.verificationStatus, 'unverified',
        `a new candidate starts unverified: ${JSON.stringify(candidate)}`)
      assert.equal(candidate.acceptanceStatus, 'pending',
        `a new candidate starts pending acceptance: ${JSON.stringify(candidate)}`)
      binding.candidate = candidate
    }

    // ---- Nothing auto-approves: submitting is the whole of what the Run can do ----
    for (const binding of bindings) {
      const afterSubmit = await taskStatus(missionId, binding.taskId)
      assert.equal(afterSubmit.status, 'in_review',
        `a recorded candidate must move ${binding.taskId} into review, not to done: ${JSON.stringify(afterSubmit.listed)}`)
      assert.notEqual(afterSubmit.status, 'done',
        `submitting must never mark ${binding.taskId} done: ${JSON.stringify(afterSubmit.listed)}`)
    }
    const listedAfterSubmit = await core.request('loom.candidates.list', { missionId })
    assert.equal(listedAfterSubmit.length, 2,
      `the Mission must list exactly its two candidates: ${JSON.stringify(listedAfterSubmit)}`)
    for (const candidate of listedAfterSubmit) {
      assert.equal(candidate.verificationStatus, 'unverified',
        `no technical verification was recorded, so it stays unverified: ${JSON.stringify(candidate)}`)
      assert.equal(candidate.acceptanceStatus, 'pending',
        `no Owner verdict was recorded, so acceptance stays pending: ${JSON.stringify(candidate)}`)
    }
    assert.deepEqual((await core.request('loom.reviews.list', { missionId })), [],
      'submitting a candidate must never create a review')
    const blockedBeforeReview = await taskStatus(missionId, TASK_C)
    assert.equal(blockedBeforeReview.status, 'ready',
      `C must stay ready and unclaimable: ${JSON.stringify(blockedBeforeReview.listed)}`)

    // ---- The single explicit Owner action. It is a fixture call, not a user UI approval. ----
    const review = await core.request('loom.review.record', {
      missionId,
      taskId: TASK_A,
      candidateId: bindings[0].candidate.candidateId,
      commandId: randomUUID(),
      acceptanceCriteriaVersion: ACCEPTANCE_CRITERIA_VERSION,
      verdict: 'accepted',
      reason: 'E3 sandbox fixture: the Owner accepts worker A receipt',
      criteriaResults: criteria.map(criterion => ({
        criterionId: criterion.criterionId,
        satisfied: true,
        note: 'loom e3 sandbox fixture'
      })),
      // A client must never choose the reviewer: the Host injects the trusted identity.
      reviewerId: 'fake'
    })
    assert.equal(review.replayed, false, `the first verdict must not be a replay: ${JSON.stringify(review)}`)
    assert.equal(review.review.reviewerId, 'local_user',
      `the Host must overwrite a spoofed reviewerId: ${JSON.stringify(review)}`)
    assert.equal(review.review.verdict, 'accepted', `the receipt must keep the verdict: ${JSON.stringify(review)}`)
    // The record receipt does name its Task (unlike the list projection), so the verdict is pinned to A.
    assert.equal(review.taskId, TASK_A, `the receipt must name the Task it judged: ${JSON.stringify(review)}`)
    assert.equal(review.taskStatus, 'done',
      `the explicitly accepted Task is the only one that finishes: ${JSON.stringify(review)}`)
    assert.equal(review.candidateAcceptanceStatus, 'accepted',
      `the accepted review must accept its candidate: ${JSON.stringify(review)}`)
    // The verdict alone releases nothing: an artifact edge also needs a passing technical check, and
    // E3 never records one.
    assert.deepEqual(review.releasedDependencyIds, [],
      `an accepted review without a technical verification must release no dependency: ${JSON.stringify(review)}`)

    // B was never reviewed, so it keeps its pending candidate and its review state.
    const afterReviewB = await taskStatus(missionId, TASK_B)
    assert.equal(afterReviewB.status, 'in_review',
      `B must stay in review because no verdict named it: ${JSON.stringify(afterReviewB.listed)}`)
    const candidateBAfterReview = (await core.request('loom.candidates.list', { missionId }))
      .find(candidate => candidate.candidateId === bindings[1].candidate.candidateId)
    assert.ok(candidateBAfterReview, `B's candidate must still be listed: ${JSON.stringify(candidateBAfterReview)}`)
    assert.equal(candidateBAfterReview.acceptanceStatus, 'pending',
      `B must keep pending acceptance: ${JSON.stringify(candidateBAfterReview)}`)
    assert.equal(candidateBAfterReview.verificationStatus, 'unverified',
      `B must keep unverified status: ${JSON.stringify(candidateBAfterReview)}`)
    const reviews = await core.request('loom.reviews.list', { missionId })
    assert.equal(reviews.length, 1, `exactly one explicit verdict must exist: ${JSON.stringify(reviews)}`)
    // The wire shape of a Review carries no taskId (it stays in storage for referential integrity),
    // so the verdict is tied to A through the candidate it names.
    assert.equal(reviews[0].candidateId, bindings[0].candidate.candidateId,
      `the one verdict must name A's candidate: ${JSON.stringify(reviews[0])}`)
    assert.equal(reviews[0].verdict, 'accepted', `the one verdict must be A's acceptance: ${JSON.stringify(reviews[0])}`)

    // A is accepted but never technically verified, so C stays blocked by its artifact edge.
    await expectRejection(blockedClaim(), 'loom.claim.acquire', 'LOOM_DEPENDENCY_UNRELEASED')
    const dependencies = await core.request('loom.dependencies.list', { missionId })
    assert.equal(dependencies.length, 1, `the plan must still hold its one edge: ${JSON.stringify(dependencies)}`)
    assert.equal(dependencies[0].dependencyId, dependencyId, `the listed edge must be the imported one: ${JSON.stringify(dependencies[0])}`)
    assert.equal(dependencies[0].condition, 'artifact_accepted',
      `the listed edge must keep its release condition: ${JSON.stringify(dependencies[0])}`)
    assert.equal(dependencies[0].resolution, null,
      `an accepted-but-unverified delivery must leave the edge frozen-free: ${JSON.stringify(dependencies[0])}`)
    const blockedAfterReview = await taskStatus(missionId, TASK_C)
    assert.equal(blockedAfterReview.status, 'ready',
      `C must still be ready and blocked after A's verdict: ${JSON.stringify(blockedAfterReview.listed)}`)

    // ---- Storage is the last witness: read it only after Core's pid is gone ----
    await stopCoreOrFail(core, 'before the stored LOOM rows are read')
    database = new DatabaseSync(join(dataDir, 'rovai.sqlite'), { readOnly: true })
    const claimRows = database.prepare(
      'SELECT claim_id, task_id, agent_run_id, fence_generation FROM loom_claim ORDER BY task_id'
    ).all()
    assert.equal(claimRows.length, 2,
      `the two parallel claims must be the only stored claims (a refused claim writes nothing): ${JSON.stringify(claimRows)}`)
    assert.deepEqual(claimRows.map(row => row.task_id).sort(), [TASK_A, TASK_B],
      `storage must hold exactly the two independent claims: ${JSON.stringify(claimRows)}`)
    assert.equal(claimRows.find(row => row.task_id === TASK_A).claim_id, claimA.claimId,
      `the stored claim must be the one the receipt names: ${JSON.stringify(claimRows)}`)
    assert.equal(claimRows.find(row => row.task_id === TASK_B).fence_generation, claimB.fenceGeneration,
      `the stored fence must be the one the submission presented: ${JSON.stringify(claimRows)}`)
    const candidateRows = database.prepare(
      'SELECT candidate_id, task_id, content_hash, verification_status, acceptance_status FROM loom_candidate ORDER BY task_id'
    ).all()
    assert.equal(candidateRows.length, 2,
      `exactly two candidates must be stored: ${JSON.stringify(candidateRows)}`)
    assert.deepEqual(candidateRows.map(row => row.verification_status), ['UNVERIFIED', 'UNVERIFIED'],
      `neither stored candidate may be verified in E3: ${JSON.stringify(candidateRows)}`)
    assert.deepEqual(candidateRows.map(row => row.acceptance_status).sort(), ['ACCEPTED', 'PENDING'],
      `storage must hold one accepted and one pending candidate: ${JSON.stringify(candidateRows)}`)
    assert.equal(candidateRows.find(row => row.task_id === TASK_A).content_hash, bindings[0].localSha256,
      `the stored content hash must be the registered artifact digest: ${JSON.stringify(candidateRows)}`)
    const artifactRows = database.prepare(
      'SELECT artifact_id, relative_path, sha256 FROM loom_artifact ORDER BY relative_path'
    ).all()
    assert.equal(artifactRows.length, 2, `exactly two artifacts must be stored: ${JSON.stringify(artifactRows)}`)
    assert.deepEqual(artifactRows.map(row => row.sha256).sort(), bindings.map(binding => binding.localSha256).sort(),
      `storage must keep both Host-computed receipt digests: ${JSON.stringify(artifactRows)}`)
    assert.deepEqual(artifactRows.map(row => row.relative_path).sort(), bindings.map(binding => binding.relativePath).sort(),
      `storage must keep both Mission-relative receipt paths: ${JSON.stringify(artifactRows)}`)
    const reviewRows = database.prepare(
      'SELECT review_id, task_id, candidate_id, verdict, reviewer_id FROM loom_review ORDER BY reviewed_at, review_id'
    ).all()
    assert.equal(reviewRows.length, 1, `exactly one explicit verdict must be stored: ${JSON.stringify(reviewRows)}`)
    assert.equal(reviewRows[0].task_id, TASK_A, `the stored verdict must name A: ${JSON.stringify(reviewRows)}`)
    assert.equal(reviewRows[0].candidate_id, bindings[0].candidate.candidateId,
      `the stored verdict must name A's candidate: ${JSON.stringify(reviewRows)}`)
    assert.equal(reviewRows[0].verdict, 'ACCEPTED', `the stored verdict keeps its uppercase literal: ${JSON.stringify(reviewRows)}`)
    assert.deepEqual([...new Set(reviewRows.map(row => row.reviewer_id))], ['local_user'],
      `every stored verdict must carry the Host identity, never the spoofed reviewerId: ${JSON.stringify(reviewRows)}`)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM loom_review WHERE reviewer_id='fake'").get().count, 0,
      'a spoofed reviewerId must never reach storage')
    const taskRows = database.prepare(
      'SELECT task_id, status FROM loom_task ORDER BY task_id'
    ).all()
    assert.deepEqual(taskRows.map(row => row.status).sort(), ['DONE', 'IN_REVIEW', 'READY'],
      `storage must hold one done, one in-review and one still-blocked Task: ${JSON.stringify(taskRows)}`)
    assert.equal(taskRows.find(row => row.task_id === TASK_A).status, 'DONE',
      `only A may be stored as done: ${JSON.stringify(taskRows)}`)
    assert.equal(taskRows.find(row => row.task_id === TASK_B).status, 'IN_REVIEW',
      `B must stay in review in storage: ${JSON.stringify(taskRows)}`)
    assert.equal(taskRows.find(row => row.task_id === TASK_C).status, 'READY',
      `C must stay ready and blocked in storage: ${JSON.stringify(taskRows)}`)
    database.close()
    database = null

    // ---- The one evidence object this file may ever claim ----
    const evidence = {
      ok: true,
      ...E3_EVIDENCE_ENVELOPE,
      coreBinary: { path: binary, sha256: binarySha256 },
      piBundle: loopback.piBundle,
      stagedExtension: loopback.stagedExtension,
      isolation: {
        ...loopback.isolation,
        dataRootIsProtectedWindowsRoot: true,
        dataRootInsideFixture: true,
        skillRootInsideDataRoot: true,
        mcpConfigInsideDataRoot: true,
        userScopedRootsRedirected: true,
        argvAllInsideFixture: true,
        persistedPathsAllInsideFixture: true,
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
        taskIds: [TASK_A, TASK_B, TASK_C],
        dependencyIds: imported.dependencyIds,
        independentTasks: [TASK_A, TASK_B]
      },
      workers: bindings.map(binding => ({
        botId: binding.botId,
        taskId: binding.taskId,
        relativePath: binding.relativePath,
        artifactId: binding.artifact.artifactId,
        artifactSha256: binding.artifact.sha256,
        claimId: binding.claim.claimId,
        fenceGeneration: binding.claim.fenceGeneration,
        agentRunId: binding.agentRunId,
        sessionId: binding.receipt.sessionId,
        providerPort: binding.receipt.providerPort,
        providerRequestCount: binding.receipt.providerRequestCount,
        providerSystemPromptSha256: binding.receipt.providerSystemPromptSha256,
        agentSettledObserved: true,
        candidateId: binding.candidate.candidateId,
        verificationStatus: 'unverified',
        acceptanceStatus: binding.taskId === TASK_A ? 'accepted' : 'pending'
      })),
      ownerReview: {
        simulatedFixtureAction: true,
        userUiApproval: false,
        taskId: TASK_A,
        candidateId: bindings[0].candidate.candidateId,
        reviewerIdInjectedByHost: 'local_user',
        verdict: 'accepted',
        taskStatusAfterReview: 'done',
        candidateAcceptanceStatusAfterReview: 'accepted',
        releasedDependencyIds: [],
        reviewedTaskCount: 1,
        unreviewedTaskId: TASK_B
      },
      dependency: {
        dependencyId,
        condition: 'artifact_accepted',
        resolutionAfterOwnerReview: null,
        downstreamTaskId: TASK_C,
        downstreamClaimBlockedBeforeReview: true,
        downstreamClaimBlockedAfterOwnerReview: true,
        blockedBecauseTechnicalVerificationMissing: true
      },
      storage: {
        claimRows: claimRows.length,
        candidateRows: candidateRows.length,
        artifactRows: artifactRows.length,
        reviewRows: reviewRows.length,
        reviewerIdsInStorage: [...new Set(reviewRows.map(row => row.reviewer_id))],
        storedVerificationStatuses: [...new Set(candidateRows.map(row => row.verification_status))],
        storedTaskStatuses: taskRows.map(row => row.status).sort()
      }
    }
    // The ceiling is asserted on the finished object too, so no later field can quietly leak.
    assertNoSecrets(evidence, { label: 'LOOM E3 final evidence' })
    const evidenceText = JSON.stringify(evidence, null, 2)
    assert.equal(evidenceText.includes(DEFAULT_TWO_WORKER_PROMPT), false,
      'the final evidence must never carry the plaintext prompt')
    assert.equal(evidenceText.includes(DUMMY_API_KEY), false,
      'the final evidence must never carry the dummy api key')
    assert.equal(evidence.mockProvider, true, 'the final evidence must declare mockProvider=true')
    assert.equal(evidence.realExternalProvider, false, 'the final evidence must declare realExternalProvider=false')
    assert.equal(evidence.scope, 'E3-sandbox-only', 'the final evidence must stay E3-sandbox-only')
    console.log(evidenceText)
  } finally {
    database?.close()
    // The walk below and the fixture delete both need Core's pid gone. If that cannot be confirmed the
    // fixture is kept whole and the failure is raised immediately: inspecting or deleting paths a live
    // Core may still be writing would both race it and destroy the evidence.
    let stopFailure = null
    try {
      await stopCoreOrFail(core, 'before the temporary root is inspected and deleted')
    } catch (error) {
      stopFailure = error
    }
    if (stopFailure) {
      preserveFixture = true
      throw Object.assign(stopFailure, { preservedFixture: fixture })
    }
    try {
      await removeEphemeralRuntimeCampFilesRoot(dataDir, {
        temporaryDirectory: fixture,
        homeDirectory: isolatedHome
      })
      assert.ok(contained(runtimeFilesRoot),
        `the Runtime Files Root must stay inside the exclusive temporary root: ${runtimeFilesRoot}`)
      const escapes = []
      const walk = async (directory) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name)
          if (!contained(await realpath(path))) escapes.push(path)
          if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(path)
        }
      }
      await walk(fixture)
      assert.deepEqual(escapes, [], 'every path Core materialized must resolve inside the temporary root')
      // Core may only populate the data dir it was given; it may not add a sibling to it.
      assert.deepEqual((await readdir(fixture)).sort(), rootBefore,
        'Core must create nothing beside the paths this fixture already owned')
    } finally {
      // Only the delete is skipped when the operator asked to keep the fixture: a `return` here would
      // swallow a failure that is still propagating out of the try block.
      if (!keepFixture) await rm(fixture, { recursive: true, force: true })
    }
  }
})

// Copied from scripts/lib/loom-core-e2e.test.mjs, which does not export it: spawning the real Core
// binary over newline-delimited JSON-RPC with a bounded shutdown is the scaffold every Core seam test
// in this directory uses, so this file adds no second harness and changes nothing in that one.
function startIsolatedCore({ dataDir, skillRoot, mcpPath, binaryPath, environment }) {
  const args = [
    ...coreDataDirectoryArguments(dataDir, { homeDirectory: environment.HOME }),
    '--skill-library-root', skillRoot,
    '--mcp-config-path', mcpPath
  ]
  const child = spawn(binaryPath, args, {
    cwd: repository,
    env: { ...process.env, ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
    // POSIX gets its own process group so the bounded kill reaches every descendant;
    // Windows closes the tree through `taskkill /T` instead.
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
  const startupTimeout = setTimeout(() => rejectReady(new Error(`Core ready timeout: ${stderr}`)), 60_000)
  // 'exit', not 'close', is the event that proves the pid is gone; the stdio streams can outlive the
  // process, so the close path waits on this and on a liveness probe.
  const exitEvent = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  // A bounded wait for the child's disappearance. The pid is re-examined first because a detached child
  // can be gone before the loop delivers 'exit', and every timer created here is cleared before it
  // returns, so no stage leaves a stray timer behind.
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
    async settled() {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const states = await request('runtime.subsystems.get')
        if (states.every((entry) => entry.state !== 'initializing')) return states
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error('Optional initialization did not settle')
    },
    // Staged and bounded: stdin end -> SIGTERM (5s) -> process-group SIGKILL (15s), never past a 20s
    // total. Every stage either observes the exit event (or a dead pid) or throws with its own stage
    // name and the pid: a close that quietly returned would let the caller read Core's SQLite file or
    // delete the fixture while Core still holds the handles.
    async close() {
      const pid = child.pid
      const totalBudget = 20_000
      const startedAt = Date.now()
      // Remaining budget, so the last stage is trimmed rather than overshooting the 20s cap.
      const remaining = () => Math.max(startedAt + totalBudget - Date.now(), 0)
      let stage = 'stdin-end'
      const timedOut = (detail = '') => Object.assign(
        new Error(`Core pid=${pid} did not exit in the ${stage} stage`
          + ` (waited ${Date.now() - startedAt}ms of ${totalBudget}ms, exitCode=${child.exitCode}, signal=${child.signalCode})`
          + `${detail}: ${stderr}`),
        { stage, pid, waitedMs: Date.now() - startedAt, exitCode: child.exitCode, signalCode: child.signalCode }
      )
      try {
        // 1. Closing stdin is Core's own shutdown; it gets five seconds to take it.
        if (!child.stdin.destroyed) child.stdin.end()
        if (await waitForExit(Math.min(remaining(), 5_000))) return
        // 2. SIGTERM, then five more seconds.
        stage = 'sigterm'
        child.kill('SIGTERM')
        if (await waitForExit(Math.min(remaining(), 5_000))) return
        // 3. The whole tree goes down. `killProcessTree` reports only what it could actually do;
        //    whether the pid then disappears is decided by the bounded wait below, so a signal that
        //    lands just before the exit event is not mistaken for a failed kill.
        stage = 'sigkill'
        const killBudget = remaining()
        if (killBudget <= 0) throw timedOut()
        killProcessTree(child, killBudget)
        if (await waitForExit(remaining())) return
        throw timedOut()
      } catch (error) {
        // A failure out of a stage never escapes as a plain rejection: it carries the stage that ran
        // out of budget, the pid, and (as `cause`) whatever the stage itself threw.
        if (error?.stage === stage && error?.pid === pid) throw error
        throw Object.assign(timedOut(` - ${error?.message ?? error}`), { cause: error })
      } finally {
        clearTimeout(startupTimeout)
        lines.close()
      }
    },
    // The fresh liveness verdict the tests gate on: `gone` is probed now, never cached.
    async exited(timeout = 5_000) {
      const gone = await waitForExit(timeout)
      return { pid: child.pid, gone, exitCode: child.exitCode, signalCode: child.signalCode }
    }
  }
}

// A resolved close() is a claim about a process, so this is the gate every storage read and fixture
// delete waits on: a timed-out stage fails with its pid and stage, and the liveness probe after it is a
// second, independent confirmation.
async function stopCoreOrFail(core, when) {
  try {
    await core.close()
  } catch (error) {
    assert.fail(`Core did not stop ${when}: stage=${error?.stage} pid=${error?.pid}`
      + ` waited=${error?.waitedMs}ms exitCode=${error?.exitCode} signal=${error?.signalCode} - ${error?.message}`)
  }
  const gone = await core.exited()
  assert.equal(gone.gone, true,
    `Core must have exited ${when}, before its files are touched: ${JSON.stringify(gone)}`)
  return gone
}

// `kill(pid, 0)` is the only portable liveness probe Node exposes: ESRCH is proof of absence, while
// EPERM means the pid exists and only the signal was refused.
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

// Windows and POSIX report a failed tree kill differently, so both branches end in a positive statement
// about the kill itself. Liveness is deliberately NOT judged here: a signal that has been delivered is
// not a process that has been reaped, so the caller's bounded wait decides whether the pid actually went
// away (see `close()`), and only then fails.
function killProcessTree(child, budgetMs = 15_000) {
  const pid = child.pid
  if (!pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    // `stdout`/`stderr` are both captured and both checked, because taskkill's output is the only
    // reason it ever gives. The budget keeps a wedged taskkill from blocking past the close() cap.
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
    // The detached spawn put Core in its own process group, so the negative pid is the tree.
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

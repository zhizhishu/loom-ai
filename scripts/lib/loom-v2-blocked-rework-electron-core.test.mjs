// End-to-end acceptance for the stage-review BLOCKED → Owner 退回重做 → REWORK chain.
//
// One chain, three real transports and a synthetic model:
//
//   real `rovai-core`  ←→  real `rovai` CLI  ←→  scripts/fixtures/loom-control-acp.mjs
//   (isolated data dir)                            (ACP handshake + CLI calls, no LLM)
//
//   real isolated Core  ←→  nonce-gated 127.0.0.1 proxy  ←→  production renderer
//                            (scripts/fixtures/loom-real-core-review → shipped ArtifactView)
//                                                          pressed by Electron `sendInputEvent`
//
// What this proves, in order:
//   1. the first stage verdict `blocked` parks the task (`blockedReason` = `stage review: …`) and
//      mints nothing further — a block is not a rework;
//   2. an actual mouse press on `[data-action="release-stage-review"]` inside the shipped
//      `ArtifactView` writes exactly ONE `loom.task.release` (counted by the proxy, not by the UI);
//   3. that Owner release — never the test — is what the real scheduler reads to hand the same
//      delivery back to its assignee as one REWORK;
//   4. the synthetic agent redoes the work (v2) and the second stage review passes;
//   5. the Owner's `loom.review.record` finishes the task (DONE) and releases the `task_done` edge;
//   6. the BLOCKED verdict is still there afterwards, byte for byte: a redo decision is a later
//      fact, never an edit of the verdict.
//
// NOT a provider acceptance: no vendor runtime, no account, no credentials, no LLM. The "model" is a
// protocol fixture. The UI input is automation, not a human click.
//
//   ROVAI_CORE_BIN=/abs/target/debug/rovai-core \
//     xvfb-run -a node --test --test-force-exit --test-concurrency=1 \
//     scripts/lib/loom-v2-blocked-rework-electron-core.test.mjs
//
// A headless Linux VM needs `xvfb-run` (the fixture window is `show:true` and the pointer input has
// to reach a real compositor). ROVAI_CORE_BIN is the only required input and nothing is built.
//
// Knobs, all optional: LOOM_BLOCKED_REWORK_FIXTURE / `--fixture <abs new dir>` (where the isolated
// Core tree lives), LOOM_BLOCKED_REWORK_KEEP_FIXTURE=1 (keep that tree for inspection instead of
// removing it after the run), LOOM_BLOCKED_REWORK_QUIET_MS (how long a block must stay a block
// before the pointer press is allowed, default 3000ms). The evidence bundle in `_artifacts/` is the
// artifact of record either way.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { rm } from 'node:fs/promises'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import electron from 'electron'
import react from '@vitejs/plugin-react'
import { build } from 'vite'
import { coreDataDirectoryArguments, removeEphemeralRuntimeCampFilesRoot } from './runtime-camp-files-root.mjs'
import { admitElectronIntegrationTest } from './electron-sandbox-capability.mjs'
import { defaultCoreBinaryPath, verifyCachedCoreBinary, stopCoreOrFail } from '../loom-v2-core-pi-integration.mjs'

const root = resolve(import.meta.dirname, '../..')
const TASK = 'task-main'
const DOWNSTREAM = 'task-downstream'
const PRODUCER = 'agent_1'
const REVIEWER = 'agent_2'
const CRITERIA_VERSION = 'ac-1'
const BLOCK_PREFIX = 'stage review: '
// The exact dispatch order one approved round is: the block replaces the first `request_changes`,
// and the Owner's release supplies the one REWORK a request for changes would otherwise have sent.
const DISPATCH_ORDER = ['EXECUTE', 'REVIEW', 'REWORK', 'REVIEW', 'HANDOFF']

test('stage verdict BLOCKED -> real Electron pointer 退回重做 -> REWORK -> PASS -> Owner accept', {
  timeout: 600_000
}, async context => {
  if (!admitElectronIntegrationTest(context)) return
  // The synthetic Copilot runtime is a `/bin/sh` wrapper that re-enters Node, exactly like
  // `scripts/smoke-loom-control.mjs`; Windows cannot run that chain, and the target is Linux.
  assert.notEqual(process.platform, 'win32',
    'This harness needs a POSIX /bin/sh wrapper for the synthetic ACP runtime (target: Linux Devin VM)')

  // `--fixture` for a plain run, the env var for `node --test` (which may not forward argv).
  const explicitFixture = argumentOf('--fixture') ?? process.env.LOOM_BLOCKED_REWORK_FIXTURE ?? null
  const fixture = explicitFixture === null
    ? mkdtempSync(join(tmpdir(), 'loom-blocked-rework-'))
    : resolve(explicitFixture)
  if (explicitFixture !== null) {
    assert.ok(isAbsolute(explicitFixture), '--fixture must be absolute')
    assert.equal(existsSync(fixture), false, 'the --fixture directory must not exist yet')
    mkdirSync(fixture)
  }
  const data = join(fixture, 'data')
  const home = join(fixture, 'home')
  const temporary = join(fixture, 'tmp')
  const journal = join(fixture, 'loom-cli-journal.jsonl')
  const wrapper = join(fixture, 'copilot-fixture')
  const runtimeFixture = join(root, 'scripts', 'fixtures', 'loom-control-acp.mjs')
  for (const directory of [data, home, temporary]) mkdirSync(directory, { recursive: true })
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  // The opt-in first verdict lives on the wrapper, so it reaches the fixture no matter what Core
  // forwards to the runtime. The smoke's own wrapper carries no variable and keeps its chain.
  writeFileSync(wrapper, '#!/bin/sh\n'
    + "export LOOM_CONTROL_FIXTURE_FIRST_VERDICT='blocked'\n"
    + `exec ${quote(process.execPath)} ${quote(runtimeFixture)} --fixture-journal ${quote(journal)} "$@"\n`)
  chmodSync(wrapper, 0o700)

  // Scrubbed PATH on purpose: `runtime.discovery.rescan` must find only the wrapper, never a real
  // vendor CLI that happens to be installed on the host — that would silently become a real model.
  const environment = {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_RUNTIME_DIR: join(home, 'runtime-dir'),
    PATH: '/usr/bin:/bin',
    ROVAI_BUNDLED_SKILLS_ROOT: join(root, 'skills'),
    ROVAI_COPILOT_BIN: wrapper
  }
  const evidenceDirectory = join(root, '_artifacts', `loom-v2-automation-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`,
    `blocked-rework-${randomUUID()}`)
  mkdirSync(evidenceDirectory, { recursive: true })

  let core = null
  let database = null
  let proxy = null
  let child = null
  let closed = null
  let preserved = false
  const report = {
    name: 'loom-blocked-rework',
    subject: 'real rovai-core + real rovai CLI + synthetic ACP protocol process + real Electron pointer on the shipped ArtifactView',
    realModelCalled: false,
    vendorRuntimeAcceptance: false,
    credentialsUsed: false,
    databaseWritesByTest: false,
    databaseAccess: 'readOnly DatabaseSync for cross-checks; the release is written by the shipped UI, everything else by public RPC or the CLI',
    platform: process.platform,
    fixture,
    evidence: evidenceDirectory,
    coreBinary: null,
    coreBinarySha256: null,
    corePid: null,
    startedAt: new Date().toISOString(),
    counts: {},
    cases: []
  }

  const writeReport = () => {
    writeFileSync(join(evidenceDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  const until = async (read, description, budgetMs = 180_000) => {
    const deadline = Date.now() + budgetMs
    let last = null
    while (Date.now() < deadline) {
      const value = await read()
      if (value) return value
      last = value
      await new Promise(done => setTimeout(done, 250))
    }
    throw new Error(`Timeout waiting for ${description}${last === null ? '' : ` (last: ${JSON.stringify(last)})`}`)
  }
  const journalEntries = async () => (existsSync(journal)
    ? readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [])

  try {
    const binary = defaultCoreBinaryPath()
    const binaryInfo = await verifyCachedCoreBinary(binary)
    report.coreBinary = binary
    report.coreBinarySha256 = binaryInfo.sha256

    // ---------------------------------------------------------------------------------------
    // 1. The real scheduler drives the approved chain until the first stage verdict BLOCKS it.
    // ---------------------------------------------------------------------------------------
    core = startCore({ binary, data, home, cwd: fixture, environment })
    report.corePid = core.process.pid
    await core.ready
    await core.request('health.check')
    await core.request('runtime.discovery.rescan', { interactiveShell: false })
    await core.request('runtime.product.check', { runtimeKind: 'copilot-cli' })
    const installation = await until(async () => (await core.request('runtime.installations.list'))
      .find(entry => entry.adapterKind === 'copilot-cli' && entry.snapshot?.probeStatus === 'ready'),
    'the synthetic Copilot capability check')
    assert.ok(installation.memberRuntimeDefaults, 'the installation must publish member runtime defaults')
    // One synthetic runtime for both members: agent_1 produces, agent_2 reviews.
    for (const agentId of [PRODUCER, REVIEWER]) {
      const profile = await core.request('members.get', { agentId })
      const configured = await core.request('members.runtime.set', {
        commandId: randomUUID(),
        command: { agentId, expectedVersion: profile.version, adapterKind: 'copilot-cli', ...installation.memberRuntimeDefaults }
      })
      assert.equal(configured.status, 'applied', `members.runtime.set ${agentId}: ${JSON.stringify(configured)}`)
    }
    const created = await core.request('missions.create', {
      commandId: randomUUID(),
      command: {
        title: 'LOOM blocked rework smoke',
        description: 'Owns the stage-review block and the Owner 退回重做 release; the model is a protocol fixture.',
        projectPath: '',
        projectBindingKind: 'quick_chat',
        memberAgentIds: [PRODUCER, REVIEWER],
        defaultLeadAgentId: PRODUCER,
        tags: ['loom-blocked-rework']
      }
    })
    assert.equal(created.status, 'applied', JSON.stringify(created))
    const missionId = created.payload.missionId
    const criteria = [{ criterionId: 'c1', text: 'the delivered artifact answers the task' }]
    const imported = await core.request('loom.plan.import', {
      missionId,
      goal: 'Deliver one reviewed artifact through the approved handoff, after one Owner redo decision',
      acceptanceCriteriaVersion: CRITERIA_VERSION,
      criteria,
      tasks: [
        { taskId: TASK, title: 'Deliver the artifact', description: 'Produced by agent_1', assigneeAgentId: PRODUCER },
        { taskId: DOWNSTREAM, title: 'Consume the artifact', description: 'Waits for task_done' }
      ],
      dependencies: [{ upstreamTaskId: TASK, downstreamTaskId: DOWNSTREAM, condition: 'task_done' }]
    })
    assert.equal(typeof imported.planId, 'string', JSON.stringify(imported))
    const control = await core.request('loom.control.configure', {
      missionId,
      commandId: randomUUID(),
      expectedRevision: 0,
      enabled: true,
      taskIds: [TASK],
      reviewers: [{ taskId: TASK, reviewerAgentId: REVIEWER }],
      // One approved round is five dispatches; the extra slot is slack, never a second round.
      maxDispatches: 6,
      maxReworksPerTask: 1,
      expiresAt: new Date(Date.now() + 20 * 60_000).toISOString()
    })
    assert.equal(control.policy.enabled, true, JSON.stringify(control))
    const authorizationRevision = control.policy.authorizationRevision
    report.cases.push({ name: 'the User approved one task with agent_2 as its reviewer', status: 'passed' })

    database = new DatabaseSync(join(data, 'rovai.sqlite'), { readOnly: true })
    const threadId = database.prepare('SELECT camp_id FROM mission WHERE id = ?').get(missionId)?.camp_id
    assert.equal(typeof threadId, 'string', 'the Mission must own one Thread')

    const controlSnapshot = () => core.request('loom.control.get', { missionId })
    const candidates = () => core.request('loom.candidates.list', { missionId })
    const tasks = () => core.request('loom.tasks.list', { missionId })
    const taskOf = async taskId => (await tasks()).find(task => task.taskId === taskId) ?? null
    const candidatesOf = async taskId => (await candidates()).filter(candidate => candidate.taskId === taskId)
    const dispatchKinds = snapshot => snapshot.dispatches.map(dispatch => dispatch.kind.toUpperCase())
    const reworkRequestEvents = () => database.prepare(
      "SELECT event_id, actor_type, actor_id, payload_json, created_at FROM event_log\n"
      + "WHERE event_type='loom.task_rework_requested' AND entity_type='loom_task' AND entity_id=?\n"
      + 'ORDER BY created_at, rowid'
    ).all(TASK)
    const ledgerRows = () => database.prepare(
      'SELECT kind, candidate_id, recipient_agent_id, status, delivery_id, dedupe_key, created_at\n'
      + 'FROM loom_control_dispatch WHERE plan_id = ? ORDER BY created_at, rowid'
    ).all(imported.planId)

    const parked = await until(async () => {
      const failed = (await journalEntries()).filter(entry => entry.status === 'failed')
      assert.deepEqual(failed, [], `the synthetic agent reported a failed step: ${JSON.stringify(failed)}`)
      const runs = (await core.request('threads.snapshot', { threadId })).agentRuns
      assert.ok(runs.every(run => !['failed', 'cancelled'].includes(run.status)),
        `the chain stopped: ${JSON.stringify(runs.map(run => ({ id: run.id, status: run.status, lastErrorCode: run.lastErrorCode })))}`)
      const snapshot = await controlSnapshot()
      const reviews = snapshot.stageReviews.filter(review => review.taskId === TASK)
      // The opt-in verdict has to be the one that ran: a silently ignored fixture flag would
      // otherwise look like a slow chain and end in a timeout instead of an answer.
      if (reviews.length >= 1 && reviews[0].verdict !== 'blocked') {
        throw new Error('the opt-in first verdict did not take effect: the first stage verdict is '
          + `${reviews[0].verdict}, not blocked`)
      }
      if (reviews.length < 1) return null
      const task = await taskOf(TASK)
      if (task?.status !== 'blocked') return null
      const produced = await candidatesOf(TASK)
      if (produced.length !== 1) return null
      if (snapshot.dispatches.length < 2) return null
      return { snapshot, review: reviews[0], candidate: produced[0], task }
    }, 'the first stage verdict to park the task as BLOCKED')

    const blockedReview = parked.review
    const firstCandidate = parked.candidate
    const blockedReason = String(parked.task.blockedReason ?? '')
    assert.equal(blockedReview.verdict, 'blocked', JSON.stringify(blockedReview))
    assert.equal(blockedReview.reviewerAgentId, REVIEWER, 'the block must be the assigned reviewer')
    assert.equal(blockedReview.candidateId, firstCandidate.candidateId, 'the block names the delivery it judged')
    assert.equal(blockedReview.policyRevision, authorizationRevision,
      'a stage review binds the authorization revision that approved it')
    assert.equal(firstCandidate.previousCandidateId, null, 'the first candidate chains to nothing')
    assert.equal(blockedReason.startsWith(BLOCK_PREFIX), true,
      `a stage block carries its own reason prefix: ${blockedReason}`)
    assert.deepEqual(dispatchKinds(parked.snapshot), ['EXECUTE', 'REVIEW'],
      `a blocked delivery is handed to nobody: ${JSON.stringify(parked.snapshot.dispatches.map(row => row.kind))}`)
    const artifactId = firstCandidate.evidenceIds?.[0]
    assert.equal(typeof artifactId, 'string', 'the first candidate must cite the artifact it delivered')
    report.counts.blockedStageReviewId = blockedReview.stageReviewId
    report.counts.firstCandidateId = firstCandidate.candidateId
    report.cases.push({
      name: 'the first stage verdict BLOCKED parked the task with its own reason and minted nothing',
      status: 'passed', taskStatus: parked.task.status, blockedReason
    })

    // The block is terminal for the scheduler: nothing may become a REWORK without the Owner.
    const quietMs = positiveInteger(process.env.LOOM_BLOCKED_REWORK_QUIET_MS, 3_000)
    const quietUntil = Date.now() + quietMs
    while (Date.now() < quietUntil) {
      await new Promise(done => setTimeout(done, 250))
      assert.deepEqual(dispatchKinds(await controlSnapshot()), ['EXECUTE', 'REVIEW'],
        'a BLOCKED verdict must not be redispatched while no Owner decision exists')
      assert.equal(reworkRequestEvents().length, 0, 'no redo decision may exist before the pointer press')
    }
    report.cases.push({
      name: `a blocked delivery stayed untouched for ${quietMs}ms without an Owner decision`,
      status: 'passed'
    })

    // ---------------------------------------------------------------------------------------
    // 2. The shipped ArtifactView, driven by real Electron mouse input, presses 退回重做 once.
    // ---------------------------------------------------------------------------------------
    const source = join(root, 'scripts', 'fixtures', 'loom-real-core-review')
    const built = join(fixture, 'renderer')
    await build({
      configFile: false,
      root: source,
      base: './',
      logLevel: 'error',
      plugins: [react()],
      resolve: { alias: { '@contracts': join(root, 'packages/contracts/src/index.ts') } },
      build: { outDir: built, minify: false }
    })
    const userData = join(fixture, 'electron-user-data')
    const output = join(fixture, 'electron-evidence')
    mkdirSync(userData, { recursive: true })
    mkdirSync(output, { recursive: true })

    // Electron main's stdin is not a reliable RPC channel on every host, so this Core is reached
    // through a nonce-gated, loopback-only, bounded test proxy. NEVER expose Core or any user
    // database to the network; this Core is disposable and isolated.
    const nonce = randomUUID()
    // The minimum the shipped renderer needs to *read* this Mission plus the ONE write under test.
    // `loom.review.record` stays out: this flow may not accept anything from the UI.
    const allowed = new Set(['preferences.tasks.get', 'loom.tasks.list', 'loom.candidates.list',
      'loom.artifacts.list', 'loom.reviews.list', 'loom.artifact.preview', 'loom.task.release'])
    let rpcCount = 0
    let releaseRequests = 0
    const releaseWrites = []
    const rpcTrace = []
    proxy = createServer((request, response) => {
      const send = (status, data) => {
        if (response.writableEnded) return
        response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify(data))
      }
      if (request.method !== 'POST' || request.headers['x-loom-qa-token'] !== nonce) {
        send(403, { ok: false, error: { code: 'FIXTURE_TRANSPORT_DENIED', message: 'Isolated nonce required' } })
        return
      }
      const chunks = []
      let bytes = 0
      request.on('data', part => { bytes += part.length; if (bytes <= 131_072) chunks.push(part) })
      request.on('end', () => {
        if (bytes > 131_072) { send(413, { ok: false, error: { code: 'FIXTURE_REQUEST_TOO_LARGE' } }); return }
        let call
        try { call = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
          send(400, { ok: false, error: { code: 'FIXTURE_JSON_INVALID' } }); return
        }
        if (!allowed.has(call.method)
          || (call.method !== 'preferences.tasks.get' && call.params?.missionId !== missionId)) {
          send(403, { ok: false, error: { code: 'FIXTURE_CORE_SCOPE_DENIED' } }); return
        }
        rpcCount += 1
        if (call.method === 'loom.task.release') {
          releaseRequests += 1
          releaseWrites.push({ method: call.method, params: call.params })
        }
        void core.request(call.method, call.params).then(result => {
          rpcTrace.push({ method: call.method, result: 'ok' })
          send(200, { ok: true, result })
        }, error => {
          rpcTrace.push({ method: call.method, result: error?.code || 'error' })
          send(200, { ok: false, error: { kind: error.kind, code: error.code, message: error.message } })
        })
      })
    })
    await new Promise((done, fail) => { proxy.once('error', fail); proxy.listen(0, '127.0.0.1', done) })
    const port = proxy.address().port
    // Nothing moved while the renderer was being built: the block is still the newest fact.
    assert.deepEqual(dispatchKinds(await controlSnapshot()), ['EXECUTE', 'REVIEW'],
      'the block must still have minted nothing just before the pointer press')
    assert.equal(reworkRequestEvents().length, 0, 'no redo decision may exist just before the pointer press')
    assert.equal(releaseRequests, 0, 'no release may exist before the pointer presses anything')

    const electronEnvironment = {
      ...process.env,
      ...environment,
      ROVAI_ALLOW_ISOLATED_INSTANCE: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      LOOM_QA_TOKEN: nonce
    }
    delete electronEnvironment.ELECTRON_RUN_AS_NODE
    let outputText = ''
    let stderr = ''
    child = spawn(electron, [join(source, 'main.cjs'), join(built, 'index.html'), userData, output,
      missionId, artifactId, String(port), 'release-stage-review'], {
      env: electronEnvironment, stdio: ['ignore', 'pipe', 'pipe']
    })
    closed = once(child, 'close')
    child.stdout.on('data', chunk => { outputText += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    const electronTimer = setTimeout(() => child.kill(), 240_000)
    let exitCode
    try {
      ;[exitCode] = await closed
    } finally {
      clearTimeout(electronTimer)
    }
    assert.equal(exitCode, 0, 'the Electron pointer fixture exited non-zero: '
      + stderr.slice(-2500) + '\n' + outputText.slice(-2500) + '\n' + JSON.stringify(rpcTrace))
    const pointerReport = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'))
    assert.equal(pointerReport.ok, true, JSON.stringify(pointerReport))
    assert.equal(pointerReport.mode, 'release-stage-review', JSON.stringify(pointerReport.mode))
    assert.equal(pointerReport.realCore, true)
    assert.equal(pointerReport.actualElectronPointerInput, true,
      'the release must be an actual Electron pointer input, never a scripted click')
    assert.equal(pointerReport.actualHumanUserClick, false)
    assert.equal(pointerReport.taskStatusBefore, 'blocked', JSON.stringify(pointerReport))
    assert.equal(pointerReport.blockedReason, blockedReason, 'the UI acted on the reason Core wrote')
    assert.notEqual(pointerReport.taskStatusAfter, 'blocked',
      'the refreshed projection must have left BLOCKED, not merely hidden the notice')
    // The truth about "only one release" is what reached Core, not what the UI claims.
    assert.equal(releaseRequests, 1,
      `the renderer must issue exactly ONE loom.task.release, not ${releaseRequests}: ${JSON.stringify(releaseWrites)}`)
    assert.deepEqual(Object.keys(releaseWrites[0].params).sort(), ['missionId', 'taskId'],
      'the release names only the real projected identity and invents no command/reason')
    assert.equal(releaseWrites[0].params.missionId, missionId)
    assert.equal(releaseWrites[0].params.taskId, TASK)
    assert.ok(rpcCount >= 8, `the renderer must have read the real projection: ${rpcCount}`)
    report.counts.electronRpcRequests = rpcCount
    report.counts.releaseRequests = releaseRequests
    report.counts.pointerPresses = pointerReport.pointerPresses
    report.cases.push({
      name: 'real Electron pointer on the shipped ArtifactView wrote exactly one loom.task.release',
      status: 'passed',
      pointerPresses: pointerReport.pointerPresses,
      secondPress: pointerReport.secondPress,
      taskStatusBefore: pointerReport.taskStatusBefore,
      taskStatusAfter: pointerReport.taskStatusAfter
    })
    proxy.closeAllConnections()
    await new Promise(done => proxy.close(done))
    proxy = null

    // The release is one recorded Owner decision about that very verdict — nothing else moved.
    const reworkRequests = reworkRequestEvents()
    assert.equal(reworkRequests.length, 1,
      `one release writes exactly one redo decision: ${JSON.stringify(reworkRequests)}`)
    const redoDecision = JSON.parse(reworkRequests[0].payload_json)
    assert.equal(reworkRequests[0].actor_type, 'user', 'only the Owner may return a blocked delivery')
    assert.equal(reworkRequests[0].actor_id, 'local_user', 'Core injects the authenticated local identity')
    assert.equal(redoDecision.candidateId, firstCandidate.candidateId, 'the redo names the delivery it is about')
    assert.equal(redoDecision.stageReviewId, blockedReview.stageReviewId,
      'the redo names the exact verdict it overrides, so it can never release a different one')
    assert.equal(redoDecision.blockedReason, blockedReason, 'the redo keeps the reason it overrides')
    report.cases.push({
      name: 'the release recorded one loom.task_rework_requested event naming that verdict',
      status: 'passed',
      stageReviewId: blockedReview.stageReviewId
    })

    // ---------------------------------------------------------------------------------------
    // 3. The scheduler, not the test, hands the delivery back: REWORK -> v2 -> REVIEW pass -> HANDOFF.
    // ---------------------------------------------------------------------------------------
    const chain = await until(async () => {
      const failed = (await journalEntries()).filter(entry => entry.status === 'failed')
      assert.deepEqual(failed, [], `the synthetic agent reported a failed step: ${JSON.stringify(failed)}`)
      const runs = (await core.request('threads.snapshot', { threadId })).agentRuns
      assert.ok(runs.every(run => !['failed', 'cancelled'].includes(run.status)),
        `the chain stopped: ${JSON.stringify(runs.map(run => ({ id: run.id, status: run.status, lastErrorCode: run.lastErrorCode })))}`)
      const snapshot = await controlSnapshot()
      const reviews = snapshot.stageReviews.filter(review => review.taskId === TASK)
      const produced = await candidatesOf(TASK)
      if (reviews.length < 2 || produced.length < 2 || snapshot.dispatches.length < 5) return null
      if (runs.length !== 5 || runs.some(run => run.status !== 'succeeded')) return null
      return { snapshot, reviews, produced }
    }, 'the released rework to be redone, re-reviewed and handed off')

    const [v1, v2] = chain.produced
    assert.equal(v1.candidateId, firstCandidate.candidateId, 'the first delivery must be the one that was blocked')
    assert.notEqual(v1.candidateId, v2.candidateId, 'the rework must produce a different candidate')
    assert.equal(v2.previousCandidateId, v1.candidateId, 'v2 must point at the candidate it answers')
    const [firstReview, secondReview] = chain.reviews
    assert.equal(firstReview.stageReviewId, blockedReview.stageReviewId, 'the first verdict was never rewritten')
    assert.equal(firstReview.verdict, 'blocked', 'the block survives the redo untouched')
    assert.equal(secondReview.verdict, 'pass', JSON.stringify(secondReview))
    assert.equal(secondReview.candidateId, v2.candidateId, 'the second review judges the redone delivery')
    assert.equal(secondReview.reviewerAgentId, REVIEWER, 'the review stays with the assigned reviewer')
    assert.notEqual(firstReview.reviewerAgentRunId, secondReview.reviewerAgentRunId,
      'each stage review is run by its own authenticated Run')
    report.counts.candidates = chain.produced.length
    report.counts.stageReviews = chain.reviews.length
    report.cases.push({
      name: 'the release (not the test) produced one REWORK, v2 and a passing second review',
      status: 'passed', v1: v1.candidateId, v2: v2.candidateId
    })

    // `pass` is internal only: the Task waits for the Owner and the edge stays frozen-free.
    assert.equal((await taskOf(TASK)).status, 'in_review', 'a pass must not accept the delivery')
    const dependencies = await core.request('loom.dependencies.list', { missionId })
    assert.equal(dependencies.length, 1, JSON.stringify(dependencies))
    assert.equal(dependencies[0].resolution, null, 'task_done must stay unreleased until the Owner accepts')

    // Ledger order and multiplicity: one round, five dispatches, each with its own Delivery.
    const rows = ledgerRows()
    assert.deepEqual(rows.map(row => row.kind), DISPATCH_ORDER,
      `one approved round is five dispatches around the block: ${JSON.stringify(rows.map(row => row.kind))}`)
    assert.deepEqual(dispatchKinds(chain.snapshot), DISPATCH_ORDER,
      'the control snapshot must agree with the ledger')
    assert.equal(new Set(rows.map(row => row.dedupe_key)).size, rows.length, 'every dispatch has its own dedupe key')
    for (const row of rows) {
      assert.equal(typeof row.delivery_id, 'string', `dispatch ${row.kind} must own a Delivery`)
      assert.ok(row.delivery_id.length > 0)
      assert.notEqual(row.status, 'WAITING', `dispatch ${row.kind} was never delivered`)
    }
    const reworkRow = rows[2]
    assert.equal(reworkRow.candidate_id, v1.candidateId, 'the rework redoes the blocked delivery, not a new one')
    assert.equal(reworkRow.recipient_agent_id, PRODUCER, 'the rework goes back to the task assignee')
    assert.equal(rows[3].candidate_id, v2.candidateId, 'the second review judges the redone delivery')
    assert.equal(rows[3].recipient_agent_id, REVIEWER)
    // The block is only ever released after the Owner's decision: the event predates the REWORK.
    assert.ok(reworkRequests[0].created_at <= reworkRow.created_at,
      `the redo decision must predate the dispatch it authorises: ${reworkRequests[0].created_at} vs ${reworkRow.created_at}`)
    report.counts.dispatches = rows.length
    report.counts.dispatchKinds = rows.map(row => row.kind)
    report.cases.push({
      name: 'EXECUTE/REVIEW/REWORK/REVIEW/HANDOFF: one round, one Delivery each, one release',
      status: 'passed'
    })

    // Every write the synthetic agent made went through the real CLI, and it never released anything.
    const entries = await journalEntries()
    const failedEntries = entries.filter(entry => entry.status === 'failed')
    assert.deepEqual(failedEntries, [], `failed Built-in Tool calls: ${JSON.stringify(failedEntries)}`)
    const cliNames = entries.filter(entry => entry.step === 'cli').map(entry => entry.argv.slice(0, 2).join(' '))
    for (const expected of ['loom claim', 'loom evidence', 'loom submit', 'loom inspect', 'loom stage-review']) {
      assert.ok(cliNames.includes(expected), `the agent must have run \`rovai ${expected}\`: ${JSON.stringify(cliNames)}`)
    }
    assert.equal(cliNames.includes('loom release'), false,
      'the agent may never release a task: 退回重做 is the Owner decision under test')
    // The synthetic agent's own record of what it was asked to do: one execute, one blocked review,
    // one rework, the passing review and the handoff — in that order, each exactly once.
    const handoffKinds = entries
      .filter(entry => entry.step === 'handoff' && entry.status === 'completed')
      .map(entry => entry.kind)
    assert.deepEqual(handoffKinds, ['execute', 'review', 'rework', 'review', 'handoff'],
      `the synthetic agent ran one round around the block: ${JSON.stringify(handoffKinds)}`)
    report.counts.cliCalls = cliNames.length
    report.cases.push({
      name: 'every Agent write went through the real rovai CLI; the release came from the UI',
      status: 'passed', cliCalls: cliNames.length
    })

    // ---------------------------------------------------------------------------------------
    // 4. Only the Owner accepts. The block is history, the task is done and the edge is released.
    // ---------------------------------------------------------------------------------------
    await until(async () => {
      const snapshot = await core.request('threads.snapshot', { threadId })
      return snapshot.agentRuns.every(run => run.status !== 'running') ? snapshot : null
    }, 'the approved chain to settle before the Owner decision')
    const accepted = await core.request('loom.review.record', {
      missionId,
      taskId: TASK,
      candidateId: v2.candidateId,
      commandId: randomUUID(),
      acceptanceCriteriaVersion: CRITERIA_VERSION,
      verdict: 'accepted',
      reason: 'the v2 artifact answers the acceptance criterion',
      criteriaResults: criteria.map(criterion => ({
        criterionId: criterion.criterionId, satisfied: true, note: 'accepted by the harness Owner'
      })),
      reviewerId: 'never-this'
    })
    assert.equal(accepted.review.reviewerId, 'local_user', 'the Host must inject the User identity')
    assert.equal(accepted.taskStatus, 'done', `the accepted task must be done: ${JSON.stringify(accepted)}`)
    assert.equal((await taskOf(TASK)).status, 'done')
    const released = await core.request('loom.dependencies.list', { missionId })
    assert.ok(released[0].resolution !== null,
      `an accepted task_done edge must freeze its resolution: ${JSON.stringify(released[0])}`)

    const finalControl = await controlSnapshot()
    const finalReviews = finalControl.stageReviews.filter(review => review.taskId === TASK)
    assert.equal(finalReviews.length, 2, `acceptance writes no third stage verdict: ${JSON.stringify(finalReviews.map(row => row.verdict))}`)
    assert.equal(finalReviews[0].stageReviewId, blockedReview.stageReviewId)
    assert.equal(finalReviews[0].verdict, 'blocked', 'the blocked verdict is still there after DONE')
    assert.deepEqual(finalReviews.map(row => row.verdict), ['blocked', 'pass'])
    assert.equal((await candidatesOf(TASK)).filter(candidate => candidate.acceptanceStatus === 'accepted').length, 1)
    assert.deepEqual(dispatchKinds(finalControl), DISPATCH_ORDER, 'acceptance mints no further dispatch')
    assert.equal(reworkRequestEvents().length, 1, 'one Owner decision, never a second redo')
    assert.deepEqual(await core.request('loom.reviews.list', { missionId }).then(rows => rows.map(row => row.verdict)),
      ['accepted'])
    report.cases.push({
      name: 'the Owner acceptance finished the task and released the task_done edge',
      status: 'passed'
    })
    report.cases.push({
      name: 'the BLOCKED verdict and its single redo decision survived the whole chain',
      status: 'passed'
    })

    report.counts.ownerReviews = 1
    report.counts.redoDecisions = 1
    report.status = 'passed'
    writeReport()
    copyEvidence(join(output, 'report.json'), join(evidenceDirectory, 'electron-report.json'))
    if (pointerReport.screenshotCaptured) {
      copyEvidence(join(output, 'real-core-after-release.png'), join(evidenceDirectory, 'real-core-after-release.png'))
    } else {
      assert.equal(pointerReport.screenshotFailure, 'display_capture_unavailable',
        'a missing capture must stay explicit in the evidence')
    }
    copyEvidence(journal, join(evidenceDirectory, 'loom-cli-journal.jsonl'))
    console.log(JSON.stringify({
      passed: true,
      scope: 'blocked-stage-review-release-to-done',
      evidence: report.evidence,
      coreBinarySha256: report.coreBinarySha256,
      stageReviews: ['blocked', 'pass'],
      dispatches: report.counts.dispatchKinds,
      releaseRequests: report.counts.releaseRequests,
      pointerPresses: report.counts.pointerPresses,
      actualElectronPointerInput: true,
      actualHumanUserClick: false,
      realPiExecutedInThisScenario: false,
      provider: 'NONE'
    }))
  } catch (error) {
    report.status = 'failed'
    report.error = error?.message ?? String(error)
    report.stack = error?.stack
    writeReport()
    console.error(core?.stderr().slice(-12_000))
    throw error
  } finally {
    if (proxy) {
      proxy.closeAllConnections()
      await new Promise(done => proxy.close(done))
      proxy = null
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill()
      if (closed) await closed.catch(() => {})
    }
    database?.close()
    database = null
    if (core) {
      try {
        await stopCoreOrFail(core, 'after the blocked-rework Electron chain')
        core = null
      } catch (error) {
        preserved = true
        throw error
      }
    }
    if (!preserved && process.env.LOOM_BLOCKED_REWORK_KEEP_FIXTURE !== '1') {
      // Core keeps the Runtime Files Root's `camps` directory execute-only (0o100) on purpose, so a
      // plain `rm(fixture)` would scandir a directory it may not read and die with EACCES. Drop the
      // owned Runtime Files Root first — it chmods 0700 while walking without following links, and
      // refuses a tree whose ownership marker is not this data directory — then the rest. A `false`
      // means Core never created that root (the marker lands before `camps`), so there is nothing
      // unreadable left to trip over.
      await removeEphemeralRuntimeCampFilesRoot(data, {
        temporaryDirectory: fixture,
        homeDirectory: home
      })
      await rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
    } else {
      console.log(`fixture kept for inspection: ${fixture}`)
    }
  }
})

function argumentOf(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function positiveInteger(raw, fallback) {
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function copyEvidence(from, to) {
  if (existsSync(from)) copyFileSync(from, to)
}

// The isolated Core bootstrap is the one `scripts/smoke-loom-control.mjs` proved: scrubbed
// environment, real JSON-RPC over stdio, real `/bin/sh` runtime wrapper. It is duplicated here rather
// than extracted so the existing smoke stays byte-identical while this harness ships.
function startCore({ binary, data: dataDirectory, home: homeDirectory, cwd, environment }) {
  const child = spawn(binary, [
    ...coreDataDirectoryArguments(dataDirectory, { homeDirectory }),
    '--skill-library-root', join(dataDirectory, 'managed-skill-library'),
    '--mcp-config-path', join(dataDirectory, 'mcp.json')
  ], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: environment })
  const pending = new Map()
  let nextId = 0
  let stderr = ''
  let resolveReady
  let rejectReady
  const ready = new Promise((resolveReadyPromise, rejectReadyPromise) => {
    resolveReady = resolveReadyPromise
    rejectReady = rejectReadyPromise
  })
  const startupTimer = setTimeout(() => rejectReady(new Error(`Core ready timeout: ${stderr}`)), 60_000)
  // `exit`, not `close`: stdio streams can outlive the process, and a stopped Core is a claim about
  // a pid, never about a readable pipe.
  const exitEvent = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })))
  const exitedWithin = async milliseconds => {
    if (child.exitCode !== null || child.signalCode !== null) return true
    let timer
    try {
      return await Promise.race([
        exitEvent.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds) })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  child.stdin.on('error', () => {})
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000) })
  child.on('error', rejectReady)
  createInterface({ input: child.stdout }).on('line', line => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.kind === 'core_startup' && message.status === 'ready') {
      clearTimeout(startupTimer)
      resolveReady(message)
      return
    }
    if (message.kind === 'core_startup' && ['failed', 'blocked'].includes(message.status)) {
      clearTimeout(startupTimer)
      rejectReady(Object.assign(new Error(message.error?.message ?? 'Startup refused'), message.error, {
        phase: message.phase,
        startupStatus: message.status
      }))
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(message.id)
    if (message.error) entry.reject(Object.assign(new Error(message.error.message ?? 'Core error'), message.error))
    else entry.resolve(message.result)
  })
  child.once('close', code => {
    clearTimeout(startupTimer)
    const error = new Error(`Core exited (code=${code}): ${stderr}`)
    rejectReady(error)
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  })
  return {
    process: child,
    ready,
    stderr: () => stderr,
    request(method, params = {}) {
      const id = ++nextId
      return ready.then(() => new Promise((resolveResult, rejectResult) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          rejectResult(new Error(`Timeout: ${method}`))
        }, 60_000)
        pending.set(id, { resolve: resolveResult, reject: rejectResult, timer })
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      }))
    },
    // The two members `scripts/loom-v2-core-pi-integration.mjs`'s `stopCoreOrFail` drives: a
    // bounded staged shutdown and a liveness answer that is checked, never assumed.
    async close() {
      if (await exitedWithin(0)) return
      if (!child.stdin.destroyed) child.stdin.end()
      if (await exitedWithin(5_000)) return
      child.kill('SIGTERM')
      if (await exitedWithin(5_000)) return
      child.kill('SIGKILL')
      if (await exitedWithin(10_000)) return
      throw Object.assign(
        new Error(`Core pid=${child.pid} did not exit: exitCode=${child.exitCode}, signal=${child.signalCode}`),
        { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }
      )
    },
    async exited(timeout = 5_000) {
      const gone = await exitedWithin(timeout)
      return { pid: child.pid, gone, exitCode: child.exitCode, signalCode: child.signalCode }
    }
  }
}

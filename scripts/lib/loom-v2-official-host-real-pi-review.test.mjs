// E3 evidence: the official rovai-host (it owns an embedded Core, crates/rovai-host/src/lib.rs:203)
// on ONE disposable Windows protected data-root, TWO real guarded Pi 0.85.1 `write` runs driven by a
// scripted 127.0.0.1 provider, then the official Web Bearer v5 surface records ONE explicit review.
//
// Scope limits, deliberately not upgradable by a green run:
//   - the provider is a scripted loopback mock, never a commercial model  => E4 NOT_RUN
//   - no human clicked a UI; no Mikka Electron render is asserted here    => humanClickedUI false
//   - the Host binary is a cached local build; its digest is RECORDED, a fresh build is NOT_VERIFIED
//   - nothing touches the daily database, port 64851, user secrets, global configs or a remote
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { launchHost } from './host-test-client.mjs'
import { coreDataDirectoryArguments, removeEphemeralRuntimeCampFilesRoot } from './runtime-camp-files-root.mjs'
import { startQaGuardedWriteProvider } from './loom-v2-qa-scripted-pi-provider.mjs'
import { runAuthorizedExecution } from '../loom-v2-runtime-execution.mjs'
import { submitGuardedCandidateToCore } from '../loom-v2-core-authorized-receipt.mjs'
import { DUMMY_API_KEY, MOCK_MODEL_ID } from '../loom-v2-pi-loopback-provider.mjs'

const repository = resolve(import.meta.dirname, '../..')
const binary = process.env.ROVAI_HOST_BIN
  ?? join(repository, 'target/debug', process.platform === 'win32' ? 'rovai-host.exe' : 'rovai-host')
const WORKER_KEY = 'LOOM_BRIDGE_MOCK_ONLY'
const CRITERIA_VERSION = 'official-host-real-pi-review-v1'
const CRITERION = 'pi-artifact-inspected'
const WORKERS = [
  {
    taskId: 'official-host-pi-a',
    botId: 'qa-host-pi-a',
    relativePath: 'official-host-pi-a.md',
    text: '# Guarded Pi output A\n\nWritten by a real Pi 0.85.1 write ToolCall. Review required.\n'
  },
  {
    taskId: 'official-host-pi-b',
    botId: 'qa-host-pi-b',
    relativePath: 'official-host-pi-b.md',
    text: '# Guarded Pi output B\n\nWritten by a real Pi 0.85.1 write ToolCall. Must stay pending.\n'
  }
]
// The shared Host helper caps every step at 15s; a fresh protected data-root plus subsystem
// warm-up can exceed that, so the ready gate gets its own bounded window.
const configuredReady = Number(process.env.LOOM_E3_READY_BUDGET_MS)
const READY_BUDGET_MS = Number.isFinite(configuredReady) && configuredReady > 0 ? configuredReady : 180_000
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

const readyWithin = (ready, label) => Promise.race([
  ready,
  new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} was not ready within ${READY_BUDGET_MS}ms`)), READY_BUDGET_MS).unref()
  })
])

// A credential-shaped parent variable must never reach the Host. Everything else (PATH, SystemRoot,
// PATHEXT, COMSPEC ...) is kept because the Host cannot spawn otherwise; every data location the
// Host resolves is then pointed inside the disposable fixture.
const CREDENTIAL_SHAPED = /(API_?KEY|_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION)/i
function isolatedHostEnvironment({ fixture, home, temporary, runtime }) {
  const environment = {}
  const dropped = []
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (CREDENTIAL_SHAPED.test(key)) { dropped.push(key); continue }
    environment[key] = value
  }
  delete environment[WORKER_KEY]
  Object.assign(environment, {
    HOME: home, USERPROFILE: home, TMP: temporary, TEMP: temporary, TMPDIR: temporary,
    XDG_CACHE_HOME: join(home, '.cache'), XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_RUNTIME_DIR: runtime,
    APPDATA: join(fixture, 'appdata'), LOCALAPPDATA: join(fixture, 'localappdata')
  })
  return { environment, dropped }
}

test('official rovai-host + two real guarded Pi writes -> Web Bearer v5 -> ONE explicit Owner Review on one isolated Core', {
  timeout: 600_000,
  skip: process.platform !== 'win32' && 'Windows protected DACL data-root required'
}, async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'loom-v2-official-host-real-pi-')))
  const home = join(fixture, 'home')
  const temporary = join(fixture, 'tmp')
  const runtimeDir = join(fixture, 'runtime')
  const ui = join(fixture, 'web-ui')
  for (const directory of [home, temporary, runtimeDir, ui]) await mkdir(directory)
  // A fixture Web shell only satisfies the production "absolute directory with index.html" gate.
  // This test asserts nothing about rendering.
  await writeFile(join(ui, 'index.html'), '<!doctype html><title>Fixture Web shell</title>')
  await writeFile(join(ui, 'preview.html'), '<!doctype html><title>Fixture preview shell</title>')
  const { environment, dropped } = isolatedHostEnvironment({ fixture, home, temporary, runtime: runtimeDir })
  const contained = (path) => {
    const offset = relative(fixture, path)
    return offset !== '' && offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset)
  }
  let host = null
  let core = null
  let origin = null
  let preserve = false
  const providers = []
  const oldKey = process.env[WORKER_KEY]
  try {
    // Provenance is recorded, not asserted: a cached binary is what it is, and a fresh build
    // stays NOT_VERIFIED no matter how green this run is.
    const hostSha256 = sha256(await readFile(binary))
    // The private root must be created by the product, not by an inherited-ACL mkdir. The DACL
    // itself is enforced by the binary; this test does not independently verify the ACL.
    core = JSON.parse(execFileSync(binary, ['--prepare-windows-data-root', join(fixture, 'formal')], {
      encoding: 'utf8', env: environment
    })).core
    assert.ok(isAbsolute(core), 'the prepared Core data-root must be absolute')
    assert.ok(contained(core), 'the prepared Core data-root must stay inside the disposable fixture')
    const skillRoot = join(core, 'managed-skill-library')
    const mcpPath = join(core, 'mcp.json')
    assert.ok(contained(skillRoot) && contained(mcpPath), 'Skill Library and MCP config stay inside the fixture')
    const args = [
      ...coreDataDirectoryArguments(core, { homeDirectory: home }),
      '--skill-library-root', skillRoot, '--mcp-config-path', mcpPath
    ]
    const launch = () => launchHost(binary, args, { cwd: repository, env: environment })
    console.log(JSON.stringify({
      channel: 'automatic_acceptance', scope: 'E3-official-host-real-pi-owner-review',
      fixture, dataDir: core, skillLibraryRoot: skillRoot, mcpConfigPath: mcpPath,
      uiDirectory: ui, home, hostSha256, hostFreshBuild: 'NOT_VERIFIED',
      droppedCredentialShapedEnvKeys: dropped.length, runtime: false, electron: false
    }))

    host = launch()
    await readyWithin(host.ready, 'rovai-host')
    const members = await host.request('members.list')
    const member = members.find(row => row.presence === 'present') ?? members[0]
    assert.ok(member?.agentId, 'Core must expose a trusted fixture member')

    // Seeding uses the trusted local Host pipe, the same seam the Desktop owns. None of these
    // producer methods is admitted over HTTP (crates/rovai-web/src/operations.rs:44-72).
    const missionId = (await host.request('missions.create', {
      commandId: randomUUID(),
      command: {
        title: 'Official Host real guarded Pi Owner Review',
        description: 'Two real Pi write receipts; one explicit Owner verdict over authenticated HTTP.',
        projectPath: '', projectBindingKind: 'quick_chat',
        memberAgentIds: [member.agentId], defaultLeadAgentId: member.agentId,
        tags: ['official-pi-review']
      }
    })).payload?.missionId
    assert.ok(typeof missionId === 'string' && missionId, 'Host pipe must create the Mission')
    const plan = await host.request('loom.plan.import', {
      missionId, goal: 'Two real guarded Pi artifacts; only the first is reviewed',
      acceptanceCriteriaVersion: CRITERIA_VERSION,
      criteria: [{ criterionId: CRITERION, text: 'Read the exact archived Pi bytes before any verdict' }],
      tasks: WORKERS.map(worker => ({
        taskId: worker.taskId, title: worker.botId, description: 'Independent guarded Pi tool run'
      })),
      dependencies: []
    })
    assert.ok(plan.planId, 'Host pipe must import the LOOM plan')

    // A quick_chat Mission's evidence root is camp.project_path = <dataDir>/quick-chat
    // (crates/rovai-core/src/application.rs:11305, crates/rovai-core/src/loom.rs:2147). If this
    // guess were wrong, loom.artifact.register would refuse the path instead of passing falsely.
    const workspaceRoot = join(core, 'quick-chat')
    await mkdir(workspaceRoot, { recursive: true })
    assert.ok(contained(workspaceRoot), 'the Pi workspace must stay inside the fixture')

    process.env[WORKER_KEY] = DUMMY_API_KEY
    const prepared = []
    for (const worker of WORKERS) {
      const released = await host.request('loom.task.release', { missionId, taskId: worker.taskId })
      assert.equal(released.task.status, 'ready')
      const agentRunId = randomUUID()
      const claim = await host.request('loom.claim.acquire', {
        missionId, taskId: worker.taskId, agentRunId, commandId: randomUUID(), leaseSeconds: 1800
      })
      assert.equal(claim.agentRunId, agentRunId, 'Core must issue the Claim for this Run')
      const provider = await startQaGuardedWriteProvider(worker)
      providers.push(provider)
      const grant = {
        runId: agentRunId, botId: worker.botId, workspaceRoot, allowedTools: ['write'],
        isolatedSelfOwnedWorkspace: true, expiresAt: Date.now() + 600_000
      }
      const model = {
        providerId: 'loom-mock', baseUrl: 'http://127.0.0.1:' + provider.port + '/v1',
        modelId: MOCK_MODEL_ID, api: 'openai-completions', apiKeyEnvVar: WORKER_KEY
      }
      prepared.push({ worker, agentRunId, claim, grant, model, provider })
    }

    const runs = await Promise.all(prepared.map(async (run) => ({
      ...run,
      receipt: await runAuthorizedExecution({
        grant: run.grant,
        model: run.model,
        prompt: 'Use only the granted write tool to create the single isolated fixture file the local provider describes. Never read or write anything outside the granted workspace.',
        expectedArtifactPaths: [run.worker.relativePath],
        promptTimeoutMs: 180_000
      })
    })))
    assert.equal(runs.length, 2)
    assert.notEqual(runs[0].receipt.launch.sessionId, runs[1].receipt.launch.sessionId,
      'the two runs must be two distinct Pi processes')
    assert.notEqual(runs[0].provider.port, runs[1].provider.port)
    for (const run of runs) {
      const onDisk = await readFile(join(workspaceRoot, run.worker.relativePath))
      assert.equal(run.receipt.status, 'settled')
      assert.equal(run.receipt.mockProvider, true)
      assert.equal(run.receipt.guard.loaded, true)
      assert.equal(run.receipt.guard.unguardedExecutions, 0)
      assert.equal(run.receipt.tools.executedCount, 1)
      assert.equal(run.receipt.tools.deniedAttempts.length, 0)
      assert.equal(run.receipt.tools.executions[0].toolName, 'write')
      assert.deepEqual(run.provider.requests[0].tools, ['write'], 'the real Pi run was offered only the guarded write tool')
      assert.equal(run.provider.requests.length, 2)
      assert.equal(onDisk.toString('utf8'), run.worker.text)
      assert.equal(run.receipt.artifacts[0].sha256, sha256(onDisk))
    }

    // Registration goes through the SAME trusted local Host pipe: the Host owns the Core, so the
    // Host re-hashes the Pi bytes on disk and issues the Candidate. This is not the QA proxy.
    const submissions = await Promise.all(runs.map(run => submitGuardedCandidateToCore({
      core: host, missionId, taskId: run.worker.taskId, agentRunId: run.agentRunId,
      botId: run.worker.botId, claim: run.claim, grant: run.grant, receipt: run.receipt,
      workspaceRoot, artifactRelativePath: run.worker.relativePath,
      acceptanceCriteriaVersion: CRITERIA_VERSION, commandId: randomUUID()
    })))
    assert.equal(submissions.length, 2)
    assert.ok(submissions.every(row => row.coreIntegrated && row.coreArtifactHashVerified
      && row.artifactAuthorshipLinkedToToolCall && row.candidatePending && !row.ownerReviewRecorded))

    const artifacts = (await host.request('loom.artifacts.list', { missionId })).artifacts
    const candidates = await host.request('loom.candidates.list', { missionId })
    assert.equal(artifacts.length, 2)
    assert.equal(candidates.length, 2)
    assert.ok(candidates.every(row => row.acceptanceStatus === 'pending' && row.verificationStatus === 'unverified'))
    assert.deepEqual(await host.request('loom.reviews.list', { missionId }), [],
      'registering two Candidates must never auto-record an Owner Review')
    for (const run of runs) {
      const artifact = artifacts.find(row => row.taskId === run.worker.taskId)
      const onDisk = await readFile(join(workspaceRoot, run.worker.relativePath))
      assert.equal(artifact?.sha256, sha256(onDisk), 'the Host-registered digest is the Pi file digest')
      const preview = await host.request('loom.artifact.preview', { missionId, artifactId: artifact.artifactId })
      assert.equal(preview.text, run.worker.text)
    }

    const started = await host.request('host.web.start', { listen: '127.0.0.1:0', uiDirectory: ui })
    assert.equal(started.enabled, true)
    // The restart below binds a new port, so the base origin stays reassignable.
    origin = started.origin
    const post = async (path, body, token) => {
      const response = await fetch(`${origin}/api/v1/${path}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body)
      })
      return { status: response.status, body: await response.json().catch(() => null) }
    }
    const request = (token, operation, params = {}) => post('request', { operation, params }, token)
    const candidateStatuses = async token => Object.fromEntries(
      (await request(token, 'loom.candidates.list', { missionId })).body.result
        .map(row => [row.taskId, row.acceptanceStatus]))

    // Negative: no Bearer, a foreign Bearer, and an incompatible protocol version.
    assert.equal((await request(null, 'loom.reviews.list', { missionId })).status, 401,
      'the public request route requires a Bearer Session')
    assert.equal((await request('0'.repeat(64), 'loom.reviews.list', { missionId })).status, 401,
      'an unknown Bearer is not a Session')
    const staleProtocol = await post('login', { protocolVersion: 4, administratorToken: started.administratorToken })
    assert.equal(staleProtocol.status, 409)
    assert.equal(staleProtocol.body.error.code, 'protocol_incompatible')

    const login = await post('login', { protocolVersion: 5, administratorToken: started.administratorToken })
    assert.equal(login.status, 200)
    assert.equal(login.body.protocolVersion, 5)
    assert.match(login.body.token, /^[0-9a-f]{64}$/)
    const session = login.body.token

    // Negative: the producer side stays off the network capability even with a valid Session.
    for (const operation of ['loom.artifact.register', 'loom.plan.import', 'loom.candidate.record',
      'loom.claim.acquire', 'loom.task.release']) {
      const denied = await request(session, operation, {
        missionId, taskId: WORKERS[0].taskId, agentRunId: runs[0].agentRunId,
        relativePath: WORKERS[0].relativePath
      })
      assert.equal(denied.status, 400, operation)
      assert.equal(denied.body.error.code, 'operation_not_admitted', operation)
    }

    // Reading archived evidence over HTTP is not a verdict.
    for (const run of runs) {
      const artifact = artifacts.find(row => row.taskId === run.worker.taskId)
      const preview = await request(session, 'loom.artifact.preview', { missionId, artifactId: artifact.artifactId })
      assert.equal(preview.status, 200)
      assert.equal(preview.body.error, null)
      assert.equal(preview.body.result.text, run.worker.text, 'HTTP must return the exact Pi-written bytes')
      assert.equal(preview.body.result.sha256, artifact.sha256)
    }
    const unknown = await request(session, 'loom.artifact.preview', { missionId, artifactId: 'artifact_missing' })
    assert.equal(unknown.status, 200)
    assert.equal(unknown.body.result, null, 'an unknown artifact must not read as archived text')
    assert.ok(unknown.body.error, 'an unknown artifact must surface a read error')
    assert.deepEqual((await request(session, 'loom.reviews.list', { missionId })).body.result, [],
      'previewing valid or unknown artifacts must never record a Review')
    assert.deepEqual(await candidateStatuses(session),
      { [WORKERS[0].taskId]: 'pending', [WORKERS[1].taskId]: 'pending' })

    // The explicit Owner verdict: the client sends no reviewer identity, and this is a FIXTURE
    // intent recorded over the official Web API, not a human click.
    const firstArtifact = artifacts.find(row => row.taskId === WORKERS[0].taskId)
    const firstCandidate = candidates.find(row => row.taskId === WORKERS[0].taskId)
    const reviewParams = {
      missionId, taskId: WORKERS[0].taskId, candidateId: firstCandidate.candidateId,
      commandId: randomUUID(), acceptanceCriteriaVersion: CRITERIA_VERSION, verdict: 'accepted',
      reason: 'Read the exact archived Pi bytes over the official Web API before this verdict',
      criteriaResults: [{
        criterionId: CRITERION, satisfied: true, evidenceIds: [firstArtifact.artifactId], note: null
      }]
    }
    const recorded = await request(session, 'loom.review.record', reviewParams)
    assert.equal(recorded.status, 200, JSON.stringify(recorded.body))
    assert.equal(recorded.body.error, null)
    assert.equal(recorded.body.result.replayed, false)
    assert.equal(recorded.body.result.review.reviewerId, 'local_user',
      'Core must inject the trusted reviewer identity, never a payload one')
    assert.equal(recorded.body.result.candidateAcceptanceStatus, 'accepted')

    // Same commandId replays the recorded verdict instead of stacking a second one.
    const replay = await request(session, 'loom.review.record', reviewParams)
    assert.equal(replay.status, 200)
    assert.equal(replay.body.error, null)
    assert.equal(replay.body.result.replayed, true)
    assert.equal(replay.body.result.review.reviewId, recorded.body.result.review.reviewId)

    // A NEW commandId for the same Candidate is a second verdict, and Core refuses it.
    const duplicate = await request(session, 'loom.review.record', { ...reviewParams, commandId: randomUUID() })
    assert.equal(duplicate.status, 200)
    assert.ok(duplicate.body.error, 'a second verdict for the same Candidate must be refused')
    assert.equal(duplicate.body.error.code, 'LOOM_REVIEW_EXISTS')

    const reviews = (await request(session, 'loom.reviews.list', { missionId })).body.result
    assert.equal(reviews.length, 1, 'replay and the refused duplicate leave exactly one Review')
    assert.deepEqual(await candidateStatuses(session),
      { [WORKERS[0].taskId]: 'accepted', [WORKERS[1].taskId]: 'pending' },
      'only the reviewed Candidate is accepted; the second stays pending')

    // Explicit logout revokes the Session for every later HTTP call.
    assert.equal((await post('logout', {}, session)).status, 204)
    assert.equal((await request(session, 'loom.reviews.list', { missionId })).status, 401,
      'a revoked Bearer cannot keep calling the business API')

    // The verdict is durable in the same SQLite, not Host memory.
    assert.equal((await host.request('host.web.stop')).enabled, false)
    assert.equal((await host.request('core.shutdown', { protocolVersion: 3, deadlineMs: 10_000 }))
      .controlledShutdownCyclePersisted, true)
    assert.equal((await host.closed).code, 0)
    host = launch()
    await readyWithin(host.ready, 'restarted rovai-host')
    const restarted = await host.request('host.web.start', { listen: '127.0.0.1:0', uiDirectory: ui })
    assert.equal(restarted.administratorToken, started.administratorToken, 'the local credential is retained')
    origin = restarted.origin
    const reopened = await post('login', { protocolVersion: 5, administratorToken: restarted.administratorToken })
    assert.equal(reopened.status, 200)
    assert.equal((await request(session, 'loom.reviews.list', { missionId })).status, 401,
      'a revoked Bearer stays revoked after the Host restarts')
    const recoveredReviews = await request(reopened.body.token, 'loom.reviews.list', { missionId })
    assert.equal(recoveredReviews.status, 200)
    assert.equal(recoveredReviews.body.result.length, 1, 'the Review is durable in the same SQLite')
    assert.equal(recoveredReviews.body.result[0].reviewerId, 'local_user')
    assert.equal(recoveredReviews.body.result[0].candidateId, firstCandidate.candidateId)
    assert.deepEqual(await candidateStatuses(reopened.body.token),
      { [WORKERS[0].taskId]: 'accepted', [WORKERS[1].taskId]: 'pending' })
    const restoredArtifacts = (await host.request('loom.artifacts.list', { missionId })).artifacts
    assert.deepEqual(restoredArtifacts.map(row => row.sha256).sort(), artifacts.map(row => row.sha256).sort(),
      'the same SQLite keeps both Host-computed Pi digests')
    for (const run of runs) {
      const artifact = restoredArtifacts.find(row => row.taskId === run.worker.taskId)
      const preview = await request(reopened.body.token, 'loom.artifact.preview',
        { missionId, artifactId: artifact.artifactId })
      assert.equal(preview.body.result.text, run.worker.text,
        'the archived Pi bytes stay readable after the Host restarts')
    }

    console.log(JSON.stringify({
      scope: 'E3-official-host-real-pi-owner-review',
      hostSha256, hostFreshBuild: 'NOT_VERIFIED',
      officialHostEmbeddedCore: true, protectedDataRootPreparedByBinary: true,
      protectedDaclIndependentlyVerified: false,
      realPiExecutedHere: true, piVersionFromReceipt: runs[0].receipt.piBundle?.piVersion ?? null,
      piExeSha256: runs[0].receipt.piBundle?.piExeSha256 ?? null,
      realPiWriteToolCalls: 2, distinctPiSessions: true, distinctProviderPorts: true,
      mockProvider: true, realExternalProvider: false, humanClickedUI: false,
      hostRegisteredArtifacts: artifacts.length, candidatesPendingBeforeReview: 2,
      reviewsBeforeWeb: 0, officialWebLoginProtocolVersion: 5,
      nonAdmittedProducerStatus: 400, unauthenticatedStatus: 401,
      protocolMismatchStatus: 409, revokedSessionStatus: 401,
      reviewsAfterReview: 1, acceptedCandidates: 1, pendingCandidates: 1,
      reviewerIdentity: 'local_user', sameCommandIdReplays: true,
      newCommandIdRejected: 'LOOM_REVIEW_EXISTS', durableAcrossHostRestart: true,
      dailyDatabaseTouched: false, port64851Touched: false,
      userSecretsRead: false, globalConfigTouched: false, remoteTouched: false,
      E4: 'NOT_RUN', E5: 'NOT_RUN', E6: 'NOT_RUN', E7: 'NOT_RUN'
    }))
  } finally {
    let closeFailure = null
    if (host) {
      try { await host.close() } catch (error) { preserve = true; closeFailure = error }
    }
    await Promise.all(providers.map(provider => provider.close().catch(() => {})))
    if (oldKey === undefined) delete process.env[WORKER_KEY]
    else process.env[WORKER_KEY] = oldKey
    if (!preserve) {
      if (core) await removeEphemeralRuntimeCampFilesRoot(core, { temporaryDirectory: fixture, homeDirectory: home })
      await rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
    }
    // A Host that will not stop is a real failure, never a cleanup detail.
    if (closeFailure) throw closeFailure
  }
})

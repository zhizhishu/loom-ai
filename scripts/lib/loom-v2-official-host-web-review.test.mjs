// E3 evidence: the production rovai-host official Web surface on one real isolated Core.
//
// One real Host process owns one real Core + SQLite inside a disposable Windows protected
// data-root. A synthetic Owner seeds two fixture Candidates through the trusted local Host
// pipe (never HTTP), then drives the actual authenticated HTTP API: `/api/v1/login`
// protocolVersion 5, `/api/v1/request` preview, and one explicit `loom.review.record`.
// No Pi run, no model, no commercial Provider, no real user, no daily data.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { launchHost } from './host-test-client.mjs'
import { coreDataDirectoryArguments, removeEphemeralRuntimeCampFilesRoot } from './runtime-camp-files-root.mjs'

const repository = resolve(import.meta.dirname, '../..')
const binary = process.env.ROVAI_HOST_BIN ?? join(repository, 'target/debug', process.platform === 'win32' ? 'rovai-host.exe' : 'rovai-host')
const CRITERIA_VERSION = 'official-host-web-review-v1'
const CRITERION = 'evidence-visible'
const TASKS = ['official-web-worker-a', 'official-web-worker-b']
// The shared Host helper caps every step at 15s; a fresh protected DACL data-root plus
// subsystem warm-up can exceed that, so the ready gate gets its own bounded window.
const configuredReady = Number(process.env.LOOM_E3_READY_BUDGET_MS)
const READY_BUDGET_MS = Number.isFinite(configuredReady) && configuredReady > 0 ? configuredReady : 180_000
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

const readyWithin = (ready, label) => Promise.race([
  ready,
  new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} was not ready within ${READY_BUDGET_MS}ms`)), READY_BUDGET_MS).unref()
  })
])

test('official Web authentication gates an explicit LOOM Owner Review on one isolated Core', {
  timeout: 300_000,
  skip: process.platform !== 'win32' && 'Windows protected DACL data-root required'
}, async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'loom-v2-official-host-web-review-')))
  const home = join(fixture, 'home')
  const temporary = join(fixture, 'tmp')
  const runtime = join(fixture, 'runtime')
  const ui = join(fixture, 'web-ui')
  for (const directory of [home, temporary, runtime, ui]) await mkdir(directory)
  // A fixture Web shell only satisfies the production "absolute directory with index.html"
  // gate. This test asserts nothing about rendering.
  await writeFile(join(ui, 'index.html'), '<!doctype html><title>Fixture Web shell</title>')
  await writeFile(join(ui, 'preview.html'), '<!doctype html><title>Fixture preview shell</title>')
  const environment = {
    ...process.env,
    HOME: home, USERPROFILE: home, TMP: temporary, TEMP: temporary, TMPDIR: temporary,
    XDG_CACHE_HOME: join(home, '.cache'), XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_RUNTIME_DIR: runtime, APPDATA: join(fixture, 'appdata'), LOCALAPPDATA: join(fixture, 'localappdata')
  }
  const contained = path => {
    const offset = relative(fixture, path)
    return offset !== '' && offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset)
  }
  let host = null
  let core = null
  let preserve = false
  try {
    const hostSha256 = sha256(await readFile(binary))
    // A private root must be created by the product, not by an inherited-ACL mkdir.
    core = JSON.parse(execFileSync(binary, ['--prepare-windows-data-root', join(fixture, 'formal')], {
      encoding: 'utf8', env: environment
    })).core
    assert.ok(contained(core), 'the prepared Core data-root must stay inside the fixture')
    const skillRoot = join(core, 'managed-skill-library')
    const mcpPath = join(core, 'mcp.json')
    const args = [
      ...coreDataDirectoryArguments(core, { homeDirectory: home }),
      '--skill-library-root', skillRoot, '--mcp-config-path', mcpPath
    ]
    const launch = () => launchHost(binary, args, { cwd: repository, env: environment })
    console.log(JSON.stringify({
      channel: 'automatic_acceptance', scope: 'E3-official-host-web-authentication',
      fixture, dataDir: core, skillLibraryRoot: skillRoot, mcpConfigPath: mcpPath,
      uiDirectory: ui, home, hostSha256, runtime: false
    }))

    host = launch()
    await readyWithin(host.ready, 'rovai-host')
    const members = await host.request('members.list')
    const member = members.find(row => row.presence === 'present') ?? members[0]
    assert.ok(member?.agentId, 'Core must expose a trusted fixture member')

    // Seeding uses the trusted local Host pipe, the same seam the Desktop owns. None of
    // these producer methods is admitted over HTTP.
    const missionId = (await host.request('missions.create', {
      commandId: randomUUID(),
      command: {
        title: 'Official Web Owner Review isolated fixture',
        description: 'Two synthetic artifacts; one explicit Owner verdict over authenticated HTTP.',
        projectPath: '', projectBindingKind: 'quick_chat',
        memberAgentIds: [member.agentId], defaultLeadAgentId: member.agentId,
        tags: ['official-host-web-review']
      }
    })).payload?.missionId
    assert.ok(typeof missionId === 'string' && missionId, 'Host pipe must create the Mission')
    const plan = await host.request('loom.plan.import', {
      missionId, goal: 'Two fixture Candidates; only the first is reviewed',
      acceptanceCriteriaVersion: CRITERIA_VERSION,
      criteria: [{ criterionId: CRITERION, text: 'Inspect archived fixture text' }],
      tasks: TASKS.map(taskId => ({ taskId, title: taskId, description: 'Fixture-only work' })),
      dependencies: []
    })
    assert.ok(plan.planId, 'Host pipe must import the LOOM plan')
    const workspace = join(core, 'quick-chat')
    await mkdir(workspace, { recursive: true })
    const artifacts = []
    const candidates = []
    for (const [index, taskId] of TASKS.entries()) {
      await host.request('loom.task.release', { missionId, taskId })
      const agentRunId = randomUUID()
      const claim = await host.request('loom.claim.acquire', {
        missionId, taskId, agentRunId, commandId: randomUUID(), leaseSeconds: 1200
      })
      const contents = `# Fixture worker ${index + 1}\nSynthetic isolated review text.\n`
      const relativePath = `official-web-fixture-${index + 1}.md`
      await writeFile(join(workspace, relativePath), contents)
      const artifact = (await host.request('loom.artifact.register', {
        missionId, taskId, agentRunId, relativePath
      })).artifact
      assert.equal(artifact.sha256, sha256(contents), 'the Host must hash the fixture bytes')
      const candidate = await host.request('loom.candidate.record', {
        missionId, taskId, agentRunId, claimId: claim.claimId, fenceGeneration: claim.fenceGeneration,
        commandId: randomUUID(), contentHash: artifact.sha256,
        evidenceIds: [artifact.artifactId], acceptanceCriteriaVersion: CRITERIA_VERSION
      })
      assert.equal(candidate.acceptanceStatus, 'pending')
      artifacts.push({ ...artifact, contents })
      candidates.push(candidate)
    }
    assert.deepEqual(await host.request('loom.reviews.list', { missionId }), [],
      'two Candidate inserts must never auto-record an Owner Review')

    const started = await host.request('host.web.start', { listen: '127.0.0.1:0', uiDirectory: ui })
    assert.equal(started.enabled, true)
    // The restart below binds a new port, so the base origin stays reassignable.
    let origin = started.origin
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
        .map(candidate => [candidate.taskId, candidate.acceptanceStatus]))

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

    // Negative: producer methods stay off the network capability even with a valid Session.
    for (const operation of ['loom.artifact.register', 'loom.plan.import', 'loom.candidate.record']) {
      const denied = await request(session, operation, {
        missionId, taskId: TASKS[0], agentRunId: candidates[0].agentRunId, relativePath: 'x.md'
      })
      assert.equal(denied.status, 400, operation)
      assert.equal(denied.body.error.code, 'operation_not_admitted', operation)
    }

    // Reading archived evidence over HTTP is not a verdict.
    for (const artifact of artifacts) {
      const preview = await request(session, 'loom.artifact.preview', { missionId, artifactId: artifact.artifactId })
      assert.equal(preview.status, 200)
      assert.equal(preview.body.error, null)
      assert.equal(preview.body.result.text, artifact.contents)
      assert.equal(preview.body.result.sha256, artifact.sha256)
    }
    const unknown = await request(session, 'loom.artifact.preview', { missionId, artifactId: 'artifact_missing' })
    assert.equal(unknown.status, 200)
    assert.equal(unknown.body.result, null, 'an unknown artifact must not read as archived text')
    assert.ok(unknown.body.error, 'an unknown artifact must surface a read error')
    assert.deepEqual((await request(session, 'loom.reviews.list', { missionId })).body.result, [],
      'previewing valid or unknown artifacts must never record a Review')
    assert.deepEqual(await candidateStatuses(session),
      { [TASKS[0]]: 'pending', [TASKS[1]]: 'pending' })

    // The explicit Owner verdict: the client sends no reviewer identity.
    const reviewParams = {
      missionId, taskId: TASKS[0], candidateId: candidates[0].candidateId, commandId: randomUUID(),
      acceptanceCriteriaVersion: CRITERIA_VERSION, verdict: 'accepted',
      reason: 'Read the archived fixture and accepted it explicitly',
      criteriaResults: [{ criterionId: CRITERION, satisfied: true, evidenceIds: [artifacts[0].artifactId], note: null }]
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
    assert.equal(replay.body.error, null)
    assert.equal(replay.body.result.replayed, true)
    assert.equal(replay.body.result.review.reviewId, recorded.body.result.review.reviewId)
    const reviews = (await request(session, 'loom.reviews.list', { missionId })).body.result
    assert.equal(reviews.length, 1, 'a replayed commandId leaves exactly one Review')
    assert.deepEqual(await candidateStatuses(session),
      { [TASKS[0]]: 'accepted', [TASKS[1]]: 'pending' },
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
    assert.equal(recoveredReviews.body.result[0].candidateId, candidates[0].candidateId)
    assert.deepEqual(await candidateStatuses(reopened.body.token),
      { [TASKS[0]]: 'accepted', [TASKS[1]]: 'pending' })

    console.log(JSON.stringify({
      scope: 'E3-official-host-web-authentication',
      hostSha256, protocolVersion: 5,
      officialWebAuthentication: true, trustedHostPipeSeeding: true,
      syntheticFixtureArtifacts: artifacts.length,
      autoReviewRecorded: false, reviews: 1,
      acceptedCandidates: 1, pendingCandidates: 1,
      reviewerIdentity: 'local_user', sameCommandIdReplays: true,
      revokedSessionStatus: 401, nonAdmittedOperationStatus: 400,
      durableAcrossHostRestart: true,
      piExecutedHere: false, modelExecutedHere: false, humanClickedUI: false,
      E4: 'NOT_RUN', E5: 'NOT_RUN', E6: 'NOT_RUN', E7: 'NOT_RUN'
    }))
  } finally {
    if (host) {
      try { await host.close() } catch (error) { preserve = true; throw error }
    }
    if (!preserve) {
      if (core) await removeEphemeralRuntimeCampFilesRoot(core, { temporaryDirectory: fixture, homeDirectory: home })
      await rm(fixture, { recursive: true, force: true })
    }
  }
})

// E3 evidence: ONE fresh official rovai-host (it owns an embedded Core, crates/rovai-host/src/lib.rs:203)
// on ONE disposable Windows protected data-root, TWO real guarded Pi 0.85.1 `write` runs driven by a
// scripted 127.0.0.1 provider, the production React Web LoomApp served by that same Host, and ONE
// explicit review recorded by REAL Electron mouse input inside the production ArtifactView.
//
// This is the seam neither existing E3 file owns on its own:
//   - loom-v2-official-host-real-pi-review.test.mjs has the official Host + real Pi, but its Web UI is
//     an empty index.html shell (it records nothing about rendering).
//   - loom-v2-guarded-pi-electron-review.test.mjs renders the production ArtifactView, but through a
//     nonce-gated QA transport over a non-official Core, i.e. not the shipping Host.
// Here the browser talks to the official Host over its own authenticated Web Bearer v5 session; there
// is no QA nonce, no fixture proxy and no renderer seam.
//
// Scope limits, deliberately not upgradable by a green run:
//   - the provider is a scripted loopback mock, never a commercial model  => E4 NOT_RUN
//   - no human clicked anything: a fixture Owner intent is driven by CDP mouse events in an isolated
//     Electron profile                                             => humanClickedUI false
//   - the Host binary is a cached local build; its digest is RECORDED, a fresh build is NOT_VERIFIED
//   - the production Web UI is a PREBUILT out/web (this test never runs build:web; a missing or
//     non-production index.html fails closed)
//   - nothing touches the daily database, port 64851, user secrets, global configs or a remote
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, copyFile, mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import electron from 'electron'
import { launchHost } from './host-test-client.mjs'
import { launchAcceptanceBrowser } from './host-web-browser.mjs'
import { admitElectronIntegrationTest } from './electron-sandbox-capability.mjs'
import { coreDataDirectoryArguments, removeEphemeralRuntimeCampFilesRoot } from './runtime-camp-files-root.mjs'
import { startQaGuardedWriteProvider } from './loom-v2-qa-scripted-pi-provider.mjs'
import { runAuthorizedExecution } from '../loom-v2-runtime-execution.mjs'
import { submitGuardedCandidateToCore } from '../loom-v2-core-authorized-receipt.mjs'
import { DUMMY_API_KEY, MOCK_MODEL_ID } from '../loom-v2-pi-loopback-provider.mjs'

const repository = resolve(import.meta.dirname, '../..')
const binary = process.env.ROVAI_HOST_BIN
  ?? join(repository, 'target/debug', process.platform === 'win32' ? 'rovai-host.exe' : 'rovai-host')
// The production Web bundle. Same convention as the other Host Web acceptances, and never built here.
const uiDirectory = process.env.ROVAI_WEB_UI ?? join(repository, 'out/web')
// Bare Electron shell with an isolated profile and remote debugging. It only renders the Host origin;
// it is not the daily App and it never spawns a Core of its own.
const parityShell = join(repository, 'scripts/fixtures/host-web-parity/main.cjs')
const WORKER_KEY = 'LOOM_BRIDGE_MOCK_ONLY'
const CRITERIA_VERSION = 'official-host-electron-review-v1'
const CRITERION = 'pi-artifact-inspected'
const REVIEW_REASON = 'Fixture Owner intent: read the archived Pi bytes in the production Web ArtifactView'
const MARKERS = ['PI_OFFICIAL_ELECTRON_A_BYTES', 'PI_OFFICIAL_ELECTRON_B_BYTES']
const WORKERS = [
  {
    taskId: 'official-host-electron-a',
    botId: 'qa-host-electron-a',
    relativePath: 'official-host-electron-a.md',
    text: `# Guarded Pi output A\n\n${MARKERS[0]} written by a real Pi 0.85.1 write ToolCall. Review required.\n`
  },
  {
    taskId: 'official-host-electron-b',
    botId: 'qa-host-electron-b',
    relativePath: 'official-host-electron-b.md',
    text: `# Guarded Pi output B\n\n${MARKERS[1]} written by a real Pi 0.85.1 write ToolCall. Must stay pending.\n`
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

// A credential-shaped parent variable must never reach the Host or the acceptance browser. Everything
// else (PATH, SystemRoot, PATHEXT, COMSPEC ...) is kept because the Host cannot spawn otherwise; every
// data location either process resolves is then pointed inside the disposable fixture.
const CREDENTIAL_SHAPED = /(API_?KEY|_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION)/i
function isolatedEnvironment({ fixture, home, temporary, runtime }) {
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

// Fail closed, never build: an empty fixture shell would silently downgrade the whole point of this
// file, and a stale bundle is Root's problem to rebuild, not something this test may paper over.
async function requireProductionWebBuild() {
  const entry = join(uiDirectory, 'index.html')
  await access(entry).catch(() => {
    throw new Error(`production Web UI build is missing: ${entry}. Run "pnpm build:web" first; this test never builds it.`)
  })
  const html = await readFile(entry, 'utf8')
  assert.match(html, /id="root"/, `the Web UI entry must be the production LoomApp build, not an empty shell: ${entry}`)
  assert.match(html, /assets\/[^"']+\.js/, `the Web UI entry must reference built assets, not a fixture shell: ${entry}`)
  return entry
}

test('official rovai-host + two real guarded Pi writes -> production Web LoomApp in Electron -> ONE explicit Owner Review', {
  timeout: 900_000,
  skip: process.platform !== 'win32' && 'Windows protected DACL data-root required'
}, async (t) => {
  if (!admitElectronIntegrationTest(t)) return
  const webEntry = await requireProductionWebBuild()
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'loom-v2-official-host-electron-')))
  const home = join(fixture, 'home')
  const temporary = join(fixture, 'tmp')
  const runtimeDir = join(fixture, 'runtime')
  const electronProfile = join(fixture, 'electron-profile')
  for (const directory of [home, temporary, runtimeDir, electronProfile]) await mkdir(directory)
  const { environment, dropped } = isolatedEnvironment({ fixture, home, temporary, runtime: runtimeDir })
  // The bare Electron shell must never inherit ELECTRON_RUN_AS_NODE from the test runner.
  const browserEnvironment = { ...environment }
  delete browserEnvironment.ELECTRON_RUN_AS_NODE
  const contained = (path) => {
    const offset = relative(fixture, path)
    return offset !== '' && offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset)
  }
  let host = null
  let browser = null
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
    assert.ok(contained(electronProfile), 'the Electron profile must stay inside the fixture')
    const args = [
      ...coreDataDirectoryArguments(core, { homeDirectory: home }),
      '--skill-library-root', skillRoot, '--mcp-config-path', mcpPath
    ]
    const launch = () => launchHost(binary, args, { cwd: repository, env: environment })
    console.log(JSON.stringify({
      channel: 'automatic_acceptance', scope: 'E3-official-host-production-web-electron-owner-review',
      fixture, dataDir: core, skillLibraryRoot: skillRoot, mcpConfigPath: mcpPath,
      webUiDirectory: uiDirectory, webUiEntry: webEntry, electronProfile,
      home, hostSha256, hostFreshBuild: 'NOT_VERIFIED',
      droppedCredentialShapedEnvKeys: dropped.length, runtime: false, electron: true
    }))

    host = launch()
    await readyWithin(host.ready, 'rovai-host')
    const members = await host.request('members.list')
    const member = members.find(row => row.presence === 'present') ?? members[0]
    assert.ok(member?.agentId, 'Core must expose a trusted fixture member')

    // Seeding uses the trusted local Host pipe, the same seam the Desktop owns. None of these
    // producer methods is admitted over HTTP (crates/rovai-web/src/operations.rs:44-73).
    const missionId = (await host.request('missions.create', {
      commandId: randomUUID(),
      command: {
        title: 'Official Host real guarded Pi Owner Review in production Web',
        description: 'Two real Pi write receipts; one explicit fixture Owner verdict over authenticated HTTP.',
        projectPath: '', projectBindingKind: 'quick_chat',
        memberAgentIds: [member.agentId], defaultLeadAgentId: member.agentId,
        tags: ['official-pi-web-review']
      }
    })).payload?.missionId
    assert.ok(typeof missionId === 'string' && missionId, 'Host pipe must create the Mission')
    const plan = await host.request('loom.plan.import', {
      missionId, goal: 'Two real guarded Pi artifacts; only the first is reviewed in the production Web UI',
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
    assert.notEqual(prepared[0].claim.claimId, prepared[1].claim.claimId,
      'the two guarded runs must hold two independent Claims')

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
    const digests = artifacts.map(row => row.sha256)
    assert.equal(new Set(digests).size, 2, 'the two Host-registered digests are two independent Pi files')
    for (const run of runs) {
      const artifact = artifacts.find(row => row.taskId === run.worker.taskId)
      const onDisk = await readFile(join(workspaceRoot, run.worker.relativePath))
      assert.equal(artifact?.sha256, sha256(onDisk), 'the Host-registered digest is the Pi file digest')
      const preview = await host.request('loom.artifact.preview', { missionId, artifactId: artifact.artifactId })
      assert.equal(preview.text, run.worker.text)
    }

    const started = await host.request('host.web.start', { listen: '127.0.0.1:0', uiDirectory })
    assert.equal(started.enabled, true)
    origin = started.origin
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/, 'the acceptance origin must stay on loopback')
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

    // Negative: the public request route requires a Bearer Session, and no ambient cookie session
    // exists. This is the exact gate the browser must pass to record anything.
    assert.equal((await request(null, 'loom.reviews.list', { missionId })).status, 401,
      'the public request route requires a Bearer Session')

    // The browser: the production React Web LoomApp served by the official Host, driven by real
    // Electron mouse input inside an isolated profile. No QA nonce, no fixture proxy, no IPC bridge.
    browser = await launchAcceptanceBrowser({
      startupBudgetMs: 60_000,
      executable: electron,
      args: [parityShell, electronProfile],
      env: browserEnvironment
    })
    await browser.send('Page.bringToFront')
    await browser.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await browser.send('Page.navigate', { url: origin })
    await browser.wait(`document.querySelector('#administrator-token') !== null`, 30_000)
    await browser.click(`document.querySelector('#administrator-token')`)
    await browser.send('Input.insertText', { text: started.administratorToken })
    await browser.click(`document.querySelector('.web-login button[type=submit]')`)
    // The production client refuses a session whose protocolVersion is not 5 (apps/web/src/client.ts:11,605),
    // so a mounted LoomApp is evidence of an accepted Web Bearer v5 session.
    await browser.wait(`document.querySelector('.web-login-overlay') === null`, 60_000)
    await browser.wait(`document.querySelector('.ln-app') !== null`, 60_000)
    assert.equal(await browser.evaluate(`typeof window.rovai`), 'undefined',
      'the Browser surface must be production Web, never the Electron IPC bridge')
    assert.match(await browser.evaluate(`JSON.parse(sessionStorage.getItem('rovai.web.session.v1')).editor.clientId`),
      /^[0-9a-f]{64}$/, 'the Host issued this browser a real Session identity')
    // Same-origin fetch with no Authorization header must be refused: the Host has no ambient auth.
    assert.equal(await browser.evaluate(
      `fetch(${JSON.stringify(origin + '/api/v1/request')}, { method: 'POST', headers: { 'Content-Type': 'application/json' },`
      + ` body: JSON.stringify({ operation: 'loom.reviews.list', params: { missionId: ${JSON.stringify(missionId)} } }) })`
      + `.then(response => response.status)`), 401,
      'the browser has no cookie-backed session; every call needs an explicit Bearer')

    // Production navigation: rail workspace -> assets tab -> the exact Pi artifact row.
    const rowSelector = `[...document.querySelectorAll('.ln-asset-row')].find(row => row.textContent.includes(${JSON.stringify(WORKERS[0].relativePath)}))`
    await browser.wait(`document.querySelector('.ln-rail button[aria-label="工作空间"]') !== null`, 30_000)
    await browser.click(`document.querySelector('.ln-rail button[aria-label="工作空间"]')`)
    await browser.wait(`document.querySelector('#workspace-tab-assets') !== null`, 30_000)
    await browser.click(`document.querySelector('#workspace-tab-assets')`)
    await browser.wait(`Boolean(${rowSelector})`, 60_000)
    const noticeBeforeOpen = await browser.evaluate(`document.querySelector('.ln-notice')?.innerText ?? null`)
    await browser.click(rowSelector)
    await browser.wait(`document.querySelector('.ln-artifact-dialog') !== null`, 30_000)
    // The dialog body is loom.artifact.preview over HTTP: the exact archived Pi bytes, not a fixture.
    await browser.wait(`document.querySelector('.ln-artifact-document')?.innerText.includes(${JSON.stringify(MARKERS[0])})`, 30_000)
    assert.equal(await browser.evaluate(`document.querySelector('.ln-artifact-doc-title').innerText.trim()`),
      'Guarded Pi output A')

    // The fixture Owner intent is an explicit pointer action in the production ArtifactView. Opening a
    // file is not a verdict: Core must still hold ZERO reviews at this exact moment.
    assert.deepEqual(await host.request('loom.reviews.list', { missionId }), [],
      'opening the artifact in the production UI must not record a Review')
    await browser.wait(`document.querySelector('.ln-artifact-review-composer .ln-artifact-accept') !== null`, 30_000)
    await browser.click(`document.querySelector('.ln-artifact-review-composer .ln-artifact-accept')`)
    await browser.wait(`document.querySelector('.ln-artifact-review-form') !== null`, 20_000)
    await browser.wait(`document.querySelector('.ln-artifact-review-criteria label') !== null`, 20_000)
    await browser.click(`document.querySelector('.ln-artifact-review-criteria label')`)
    await browser.click(`document.querySelector('#ln-artifact-reason')`)
    await browser.send('Input.insertText', { text: REVIEW_REASON })
    await browser.wait(`document.querySelector('.ln-artifact-review-form button[type=submit]').disabled === false`, 20_000)
    await browser.click(`document.querySelector('.ln-artifact-review-form button[type=submit]')`)
    await browser.wait(`document.querySelector('.ln-artifact-review-record')?.dataset.verdict === 'accepted'`, 60_000)
    await browser.wait(`(() => { const mark = document.querySelector('img.ln-brand-mark'); return mark?.complete && mark.naturalWidth === 256 && mark.alt === 'LOOM' })()`, 20_000)
    assert.match(await browser.evaluate(`document.querySelector('link[rel="icon"]')?.href ?? ''`), /loom-favicon-9bd461c1\.png$/)
    const screenshotFile = join(fixture, 'web-artifact-accepted.png')
    const screenshot = await browser.capture(screenshotFile).then(() => true, () => false)
    if (process.env.LOOM_E3_CAPTURE_DIR) {
      const captureRoot = resolve(process.env.LOOM_E3_CAPTURE_DIR)
      const captureRelative = relative(join(repository, '_artifacts'), captureRoot)
      assert.ok(captureRelative && !isAbsolute(captureRelative) && captureRelative !== '..' && !captureRelative.startsWith(`..${sep}`), 'optional visual evidence must stay in the repository artifact area')
      assert.ok(screenshot, 'explicit visual acceptance requested a real screenshot')
      await mkdir(captureRoot, { recursive: true })
      await copyFile(screenshotFile, join(captureRoot, `official-host-brand-${randomUUID()}.png`))
    }

    // Core read-back: the verdict exists in the same SQLite because of that pointer action.
    const reviews = await host.request('loom.reviews.list', { missionId })
    assert.equal(reviews.length, 1, 'the production UI pointer recorded exactly one Owner Review')
    assert.equal(reviews[0].reviewerId, 'local_user',
      'Core must inject the trusted reviewer identity, never a payload one')
    assert.equal(reviews[0].verdict, 'accepted')
    assert.ok(reviews[0].reason.includes(REVIEW_REASON), 'the recorded reason is the text typed in the UI')
    // The Review wire record references the Candidate, not a redundant taskId.
    const firstCandidate = candidates.find(row => row.taskId === WORKERS[0].taskId)
    assert.equal(reviews[0].candidateId, firstCandidate.candidateId)
    const after = await host.request('loom.candidates.list', { missionId })
    assert.equal(after.find(row => row.taskId === WORKERS[0].taskId).acceptanceStatus, 'accepted')
    assert.equal(after.find(row => row.taskId === WORKERS[1].taskId).acceptanceStatus, 'pending',
      'the second Pi artifact stays pending: only the clicked artifact was reviewed')

    // Close the browser before the Host is restarted, so its session cannot be confused with the
    // post-restart one. Everything below is the official Host's own HTTP surface.
    await browser.close()
    browser = null

    const login = await post('login', { protocolVersion: 5, administratorToken: started.administratorToken })
    assert.equal(login.status, 200)
    assert.equal(login.body.protocolVersion, 5)
    assert.match(login.body.token, /^[0-9a-f]{64}$/)
    const session = login.body.token

    // Negative: the producer side stays off the network capability even with a valid Session.
    for (const operation of ['loom.artifact.register', 'loom.plan.import', 'loom.candidate.record',
      'loom.claim.acquire']) {
      const denied = await request(session, operation, {
        missionId, taskId: WORKERS[0].taskId, agentRunId: runs[0].agentRunId,
        relativePath: WORKERS[0].relativePath
      })
      assert.equal(denied.status, 400, operation)
      assert.equal(denied.body.error.code, 'operation_not_admitted', operation)
    }

    // A NEW commandId for the same Candidate is a second verdict, and Core refuses it: the UI's
    // review is a real recorded verdict, not a repeatable transport side effect.
    const duplicate = await request(session, 'loom.review.record', {
      missionId, taskId: WORKERS[0].taskId, candidateId: firstCandidate.candidateId,
      commandId: randomUUID(), acceptanceCriteriaVersion: CRITERIA_VERSION, verdict: 'accepted',
      reason: 'A second verdict for the same Candidate must be refused',
      criteriaResults: [{
        criterionId: CRITERION, satisfied: true,
        evidenceIds: [artifacts.find(row => row.taskId === WORKERS[0].taskId).artifactId], note: null
      }]
    })
    assert.equal(duplicate.status, 200)
    assert.ok(duplicate.body.error, 'a second verdict for the same Candidate must be refused')
    assert.equal(duplicate.body.error.code, 'LOOM_REVIEW_EXISTS')
    assert.equal((await request(session, 'loom.reviews.list', { missionId })).body.result.length, 1,
      'the refused duplicate leaves exactly one Review')

    // The verdict is durable in the same SQLite, not Host or browser memory.
    assert.equal((await host.request('host.web.stop')).enabled, false)
    assert.equal((await host.request('core.shutdown', { protocolVersion: 3, deadlineMs: 10_000 }))
      .controlledShutdownCyclePersisted, true)
    assert.equal((await host.closed).code, 0)
    host = launch()
    await readyWithin(host.ready, 'restarted rovai-host')
    const restarted = await host.request('host.web.start', { listen: '127.0.0.1:0', uiDirectory })
    assert.equal(restarted.administratorToken, started.administratorToken, 'the local credential is retained')
    origin = restarted.origin
    assert.equal((await request(session, 'loom.reviews.list', { missionId })).status, 401,
      'a pre-restart Bearer is not silently resurrected as a new Session')
    const reopened = await post('login', { protocolVersion: 5, administratorToken: restarted.administratorToken })
    assert.equal(reopened.status, 200)
    const recoveredReviews = await request(reopened.body.token, 'loom.reviews.list', { missionId })
    assert.equal(recoveredReviews.status, 200)
    assert.equal(recoveredReviews.body.result.length, 1, 'the Review is durable in the same SQLite')
    assert.equal(recoveredReviews.body.result[0].reviewerId, 'local_user')
    assert.equal(recoveredReviews.body.result[0].candidateId, firstCandidate.candidateId)
    assert.deepEqual(await candidateStatuses(reopened.body.token),
      { [WORKERS[0].taskId]: 'accepted', [WORKERS[1].taskId]: 'pending' })
    const restoredArtifacts = (await host.request('loom.artifacts.list', { missionId })).artifacts
    const acceptanceReportPath = `.loom/acceptance/${WORKERS[0].taskId}.md`
    const acceptanceReport = restoredArtifacts.find(row => row.relativePath === acceptanceReportPath)
    assert.ok(acceptanceReport, 'the accepted Candidate produces the durable acceptance report artifact')
    assert.equal(restoredArtifacts.length, 3, 'the same SQLite keeps two Pi digests plus the acceptance report')
    assert.deepEqual(restoredArtifacts.map(row => row.sha256).sort(), [...digests, acceptanceReport.sha256].sort(),
      'the same SQLite keeps both Host-computed Pi digests and the acceptance report digest')
    for (const run of runs) {
      const artifact = restoredArtifacts.find(row => row.taskId === run.worker.taskId)
      const preview = await request(reopened.body.token, 'loom.artifact.preview',
        { missionId, artifactId: artifact.artifactId })
      assert.equal(preview.body.result.text, run.worker.text,
        'the archived Pi bytes stay readable after the Host restarts')
    }

    console.log(JSON.stringify({
      scope: 'E3-official-host-production-web-electron-owner-review',
      hostSha256, hostFreshBuild: 'NOT_VERIFIED',
      officialHostEmbeddedCore: true, protectedDataRootPreparedByBinary: true,
      protectedDaclIndependentlyVerified: false,
      productionWebBuild: relative(repository, uiDirectory).replaceAll('\\', '/'),
      webBuildFreshness: 'NOT_VERIFIED (prebuilt by Root; this test never builds)',
      browserSurface: 'electron-shell + production React Web LoomApp', electronIpcBridgeInBrowser: false,
      qaNonceTransport: false, fixtureProxy: false, officialHostWebBearerProtocolVersion: 5,
      realPiExecutedHere: true, piVersionFromReceipt: runs[0].receipt.piBundle?.piVersion ?? null,
      piExeSha256: runs[0].receipt.piBundle?.piExeSha256 ?? null,
      realPiWriteToolCalls: 2, distinctPiSessions: true, distinctProviderPorts: true,
      distinctCoreClaims: true, mockProvider: true, realExternalProvider: false,
      hostRegisteredArtifacts: artifacts.length, distinctHostHashedDigests: new Set(digests).size,
      candidatesPendingBeforeInterface: 2, reviewsBeforeInterface: 0,
      uiOpenedArtifactWithoutVerdict: true, uiArtifactPreviewFromCoreBytes: true,
      actualElectronPointerInput: true, humanClickedUI: false,
      fixtureOwnerIntent: true, uiReviewSubmission: 'explicit accept + criterion + reason',
      reviewsAfterInterface: 1, acceptedCandidates: 1, pendingCandidates: 1,
      reviewerIdentity: 'local_user', unauthenticatedStatus: 401,
      browserWithoutBearerStatus: 401, nonAdmittedProducerStatus: 400,
      newCommandIdRejected: 'LOOM_REVIEW_EXISTS',
      durableAcrossHostRestart: true, preRestartBearerAfterRestartStatus: 401,
      noticePresentBeforeOpen: noticeBeforeOpen, screenshotCaptured: screenshot,
      dailyDatabaseTouched: false, port64851Touched: false,
      userSecretsRead: false, globalConfigTouched: false, remoteTouched: false,
      E4: 'NOT_RUN', E5: 'NOT_RUN', E6: 'NOT_RUN', E7: 'NOT_RUN'
    }))
  } finally {
    let closeFailure = null
    if (browser) {
      try { await browser.close() } catch (error) { preserve = true; closeFailure ??= error }
    }
    if (host) {
      try { await host.close() } catch (error) { preserve = true; closeFailure ??= error }
    }
    await Promise.all(providers.map(provider => provider.close().catch(() => {})))
    if (oldKey === undefined) delete process.env[WORKER_KEY]
    else process.env[WORKER_KEY] = oldKey
    if (!preserve) {
      if (core) await removeEphemeralRuntimeCampFilesRoot(core, { temporaryDirectory: fixture, homeDirectory: home })
      await rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
    }
    // A Host or browser that will not stop is a real failure, never a cleanup detail.
    if (closeFailure) throw closeFailure
  }
})

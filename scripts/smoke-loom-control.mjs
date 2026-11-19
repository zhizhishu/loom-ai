// LOOM control smoke: real `rovai-core` + real `rovai` CLI + a synthetic ACP protocol process.
//
// What is real: Core, the Built-in Tool transport, the CLI, the control policy, the dispatch
// ledger, the Delivery lane and every state transition they write.
// What is synthetic: the "model". `scripts/fixtures/loom-control-acp.mjs` speaks the ACP
// handshake and then performs the work by calling the CLI that Core injected, so no vendor
// runtime, no account and no LLM call is involved. This is therefore NOT a provider acceptance.
//
//   node scripts/smoke-loom-control.mjs --core /abs/target/debug/rovai-core --fixture /abs/empty-dir
//
// The fixture directory (data dir, Skills, MCP, HOME/XDG/TMP, journal, wrapper and report.json)
// is kept for independent inspection; only this round's Core is closed. The DSH is never touched.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { coreDataDirectoryArguments } from './lib/runtime-camp-files-root.mjs'

if (process.platform === 'win32') throw new Error('This smoke requires macOS or Linux')
const root = resolve(import.meta.dirname, '..')
const argumentOf = name => {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}
const coreArgument = argumentOf('--core')
const fixtureArgument = argumentOf('--fixture')
if (!coreArgument || !isAbsolute(coreArgument)) throw new Error('--core must be an absolute path to rovai-core')
if (!fixtureArgument || !isAbsolute(fixtureArgument)) throw new Error('--fixture must be an absolute, not yet existing directory')
const coreBinary = resolve(coreArgument)
const fixture = resolve(fixtureArgument)
await access(coreBinary)
await assert.rejects(access(fixture), 'the fixture directory must not exist yet')
await mkdir(fixture, { recursive: false })
const data = join(fixture, 'data')
const home = join(fixture, 'home')
const temporary = join(fixture, 'tmp')
const journal = join(fixture, 'loom-cli-journal.jsonl')
const reportPath = join(fixture, 'report.json')
const wrapper = join(fixture, 'copilot-fixture')
const runtimeFixture = join(root, 'scripts', 'fixtures', 'loom-control-acp.mjs')
await Promise.all([data, home, temporary].map(path => mkdir(path, { recursive: true })))
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
await writeFile(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runtimeFixture)} --fixture-journal ${quote(journal)} "$@"\n`)
await chmod(wrapper, 0o700)

const isolatedEnvironment = {
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
const coreSha256 = createHash('sha256').update(await readFile(coreBinary)).digest('hex')
const report = {
  name: 'loom-control',
  // The disclosure the report owes the reader: the model is a protocol fixture, not a vendor.
  subject: 'real rovai-core + real rovai CLI + synthetic ACP protocol process',
  realModelCalled: false,
  vendorRuntimeAcceptance: false,
  credentialsUsed: false,
  databaseWritesByTest: false,
  databaseAccess: 'readOnly DatabaseSync for cross-checks; every write goes through public RPC or the CLI',
  platform: process.platform,
  fixture,
  coreBinary,
  coreBinarySha256: coreSha256,
  corePid: null,
  startedAt: new Date().toISOString(),
  counts: {},
  cases: []
}

let core = null
let database = null
let reportWritten = false
const writeReport = async () => {
  reportWritten = true
  report.finishedAt = new Date().toISOString()
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}
const until = async (read, description, budgetMs = 120_000) => {
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
const journalEntries = async () => readFile(journal, 'utf8')
  .then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
  .catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })

try {
  core = startCore()
  report.corePid = core.process.pid
  await core.ready
  await core.request('health.check')
  await core.request('runtime.discovery.rescan', { interactiveShell: false })
  await core.request('runtime.product.check', { runtimeKind: 'copilot-cli' })
  const installation = await until(async () => (await core.request('runtime.installations.list'))
    .find(entry => entry.adapterKind === 'copilot-cli' && entry.snapshot?.probeStatus === 'ready'), 'the synthetic Copilot capability check')
  assert.ok(installation.memberRuntimeDefaults, 'the installation must publish member runtime defaults')

  // Both members get the same synthetic runtime: agent_1 produces, agent_2 reviews.
  for (const agentId of ['agent_1', 'agent_2']) {
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
      title: 'LOOM control smoke',
      description: 'Owns the authorized stage-review and rework handoff; the model is a protocol fixture.',
      projectPath: '',
      projectBindingKind: 'quick_chat',
      memberAgentIds: ['agent_1', 'agent_2'],
      defaultLeadAgentId: 'agent_1',
      tags: ['loom-control-smoke']
    }
  })
  assert.equal(created.status, 'applied', JSON.stringify(created))
  const missionId = created.payload.missionId

  const criteria = [{ criterionId: 'c1', text: 'the delivered artifact answers the task' }]
  const imported = await core.request('loom.plan.import', {
    missionId,
    goal: 'Deliver one reviewed artifact through the approved handoff',
    acceptanceCriteriaVersion: 'ac-1',
    criteria,
    tasks: [
      { taskId: 'task-main', title: 'Deliver the artifact', description: 'Produced by agent_1', assigneeAgentId: 'agent_1' },
      { taskId: 'task-downstream', title: 'Consume the artifact', description: 'Waits for task_done' }
    ],
    dependencies: [{ upstreamTaskId: 'task-main', downstreamTaskId: 'task-downstream', condition: 'task_done' }]
  })
  const planId = imported.planId
  assert.equal(typeof planId, 'string', JSON.stringify(imported))

  const expiresAt = new Date(Date.now() + 20 * 60_000).toISOString()
  const configured = await core.request('loom.control.configure', {
    missionId,
    commandId: randomUUID(),
    expectedRevision: 0,
    enabled: true,
    taskIds: ['task-main'],
    reviewers: [{ taskId: 'task-main', reviewerAgentId: 'agent_2' }],
    maxDispatches: 5,
    maxReworksPerTask: 1,
    expiresAt
  })
  assert.equal(configured.policy.enabled, true, JSON.stringify(configured))
  report.cases.push({ name: 'the User approved one task with agent_2 as its reviewer', status: 'passed' })

  database = new DatabaseSync(join(data, 'rovai.sqlite'), { readOnly: true })
  // `missions.create` answers with the Mission id; its Thread is the Mission's camp, read here so
  // nothing has to guess a payload field that may not exist.
  const threadId = database.prepare('SELECT camp_id FROM mission WHERE id = ?').get(missionId)?.camp_id
  assert.equal(typeof threadId, 'string', 'the Mission must own one Thread')
  const controlSnapshot = () => core.request('loom.control.get', { missionId })
  const candidates = () => core.request('loom.candidates.list', { missionId })
  const tasks = () => core.request('loom.tasks.list', { missionId })
  const taskStatusOf = async taskId => (await tasks()).find(task => task.taskId === taskId)?.status ?? null
  const candidatesForMain = async () => (await candidates()).filter(candidate => candidate.taskId === 'task-main')

  // 1. The scheduler must drive the whole approved chain without any User or test RPC forging an
  //    Agent action: execute -> review(request_changes) -> rework -> review(pass) -> handoff.
  const chain = await until(async () => {
    const failed = (await journalEntries()).filter(entry => entry.status === 'failed')
    assert.deepEqual(failed, [], `runtime fixture failed: ${JSON.stringify(failed)}`)
    const runs = (await core.request('threads.snapshot', { threadId })).agentRuns
    assert.ok(runs.every(run => !['failed', 'cancelled'].includes(run.status)), `runtime stopped: ${JSON.stringify(runs.map(run => ({ id: run.id, status: run.status, lastErrorCode: run.lastErrorCode })))}`)
    const control = await controlSnapshot()
    const reviews = control.stageReviews.filter(review => review.taskId === 'task-main')
    const produced = await candidatesForMain()
    if (reviews.length < 2 || produced.length < 2 || control.dispatches.length < 5) return null
    if (runs.length !== 5 || runs.some(run => run.status !== 'succeeded')) return null
    return { reviews, produced }
  }, 'two candidates and two stage reviews recorded by the real scheduler')

  const [v1, v2] = chain.produced
  assert.notEqual(v1.candidateId, v2.candidateId, 'the rework must produce a different candidate')
  assert.equal(v1.previousCandidateId, null, 'the first candidate chains to nothing')
  assert.equal(v2.previousCandidateId, v1.candidateId, 'v2 must point at the candidate it answers')
  report.cases.push({ name: 'rework produced a chained v2 candidate', status: 'passed', v1: v1.candidateId, v2: v2.candidateId })

  const [firstReview, secondReview] = chain.reviews
  assert.equal(firstReview.verdict, 'request_changes', JSON.stringify(firstReview))
  assert.equal(secondReview.verdict, 'pass', JSON.stringify(secondReview))
  assert.equal(firstReview.reviewerAgentId, 'agent_2', 'the review must be the assigned reviewer')
  assert.equal(secondReview.reviewerAgentId, 'agent_2', 'the review must be the assigned reviewer')
  assert.notEqual(firstReview.reviewerAgentRunId, secondReview.reviewerAgentRunId,
    'each stage review is run by its own authenticated Run')
  assert.equal(firstReview.candidateId, v1.candidateId, 'the first review names v1')
  assert.equal(secondReview.candidateId, v2.candidateId, 'the second review names v2')
  assert.equal(firstReview.policyRevision, configured.policy.authorizationRevision,
    'a stage review binds the authorization revision that approved it')
  report.cases.push({
    name: 'both stage reviews came from agent_2 in two distinct Runs',
    status: 'passed',
    runs: [firstReview.reviewerAgentRunId, secondReview.reviewerAgentRunId]
  })

  // 2. `pass` is internal only: the Task stays in review and the downstream edge stays frozen-free
  //    until the User accepts.
  assert.equal(await taskStatusOf('task-main'), 'in_review', 'a pass must not accept the delivery')
  const dependencies = await core.request('loom.dependencies.list', { missionId })
  assert.equal(dependencies.length, 1, JSON.stringify(dependencies))
  assert.equal(dependencies[0].resolution, null, 'task_done must stay unreleased until the User accepts')
  assert.equal(dependencies[0].resolvedArtifactId, null)
  report.cases.push({ name: 'pass left the task in review and the dependency unreleased', status: 'passed' })

  // 3. Exactly one round of five dispatches, each carrying its own Delivery, none duplicated.
  const ledgerRows = database
    .prepare('SELECT * FROM loom_control_dispatch WHERE plan_id = ? ORDER BY created_at, rowid')
    .all(planId)
  const kinds = ledgerRows.map(row => row.kind)
  assert.deepEqual(kinds, ['EXECUTE', 'REVIEW', 'REWORK', 'REVIEW', 'HANDOFF'],
    `one approved round is five dispatches: ${JSON.stringify(kinds)}`)
  const dedupeKeys = ledgerRows.map(row => row.dedupe_key)
  assert.equal(new Set(dedupeKeys).size, dedupeKeys.length, 'every dispatch has its own dedupe key')
  assert.equal(new Set(ledgerRows.map(row => row.dispatch_id)).size, ledgerRows.length)
  for (const row of ledgerRows) {
    assert.equal(typeof row.delivery_id, 'string', `dispatch ${row.dispatch_id} must own a Delivery`)
    assert.ok(row.delivery_id.length > 0)
    assert.notEqual(row.status, 'WAITING', `dispatch ${row.dispatch_id} was never delivered`)
  }
  const snapshotDispatches = (await controlSnapshot()).dispatches
  assert.equal(snapshotDispatches.length, 5, `loom.control.get must agree with the ledger: ${JSON.stringify(snapshotDispatches.map(dispatch => dispatch.kind))}`)
  report.counts.dispatches = ledgerRows.length
  report.counts.dispatchKinds = kinds
  report.cases.push({ name: 'one five-dispatch round, each with its own Delivery and dedupe key', status: 'passed' })

  // 4. Every CLI call the synthetic agent made must have succeeded; a failed call is a failure
  //    here even though the Run still ends.
  const entries = await journalEntries()
  const failed = entries.filter(entry => entry.status === 'failed')
  assert.deepEqual(failed, [], `the synthetic agent reported failed Built-in Tool calls: ${JSON.stringify(failed)}`)
  const cliNames = entries.filter(entry => entry.step === 'cli').map(entry => entry.argv.slice(0, 2).join(' '))
  for (const expected of ['loom claim', 'loom evidence', 'loom submit', 'loom inspect', 'loom stage-review']) {
    assert.ok(cliNames.includes(expected), `the agent must have run \`rovai ${expected}\`: ${JSON.stringify(cliNames)}`)
  }
  report.counts.cliCalls = cliNames.length
  report.cases.push({ name: 'every Agent write went through the real rovai CLI', status: 'passed', cliCalls: cliNames.length })

  // 5. Wait for the Runs to settle, then let the User accept. Only the User can do this, and the
  //    Host injects the identity: the payload below cannot nominate itself.
  await until(async () => {
    const snapshot = await core.request('threads.snapshot', { threadId })
    return snapshot.agentRuns.every(run => run.status !== 'running') ? snapshot : null
  }, 'the approved chain to settle before the User decision')

  const accepted = await core.request('loom.review.record', {
    missionId,
    taskId: 'task-main',
    candidateId: v2.candidateId,
    commandId: randomUUID(),
    acceptanceCriteriaVersion: 'ac-1',
    verdict: 'accepted',
    reason: 'the v2 artifact answers the acceptance criterion',
    criteriaResults: criteria.map(criterion => ({ criterionId: criterion.criterionId, satisfied: true, note: 'accepted by the smoke User' })),
    reviewerId: 'never-this'
  })
  assert.equal(accepted.review.reviewerId, 'local_user', 'the Host must inject the User identity')
  assert.equal(accepted.taskStatus, 'done', `the accepted task must be done: ${JSON.stringify(accepted)}`)
  assert.equal(await taskStatusOf('task-main'), 'done')
  const released = await core.request('loom.dependencies.list', { missionId })
  assert.ok(released[0].resolution !== null, `an accepted task_done edge must freeze its resolution: ${JSON.stringify(released[0])}`)
  assert.equal(released[0].resolution.upstreamTaskRevision > 0, true)
  report.cases.push({ name: 'the User acceptance finished the task and released the task_done edge', status: 'passed' })

  report.counts.candidates = (await candidatesForMain()).length
  report.counts.stageReviews = (await controlSnapshot()).stageReviews.length
  report.status = 'passed'
  await writeReport()
  console.log(JSON.stringify({
    passed: true,
    fixture,
    report: reportPath,
    coreBinarySha256: coreSha256,
    corePid: report.corePid,
    dispatches: report.counts.dispatches,
    candidates: report.counts.candidates,
    stageReviews: report.counts.stageReviews
  }))
} catch (error) {
  report.status = 'failed'
  report.error = error?.message ?? String(error)
  if (!reportWritten) await writeReport().catch(() => {})
  console.error(core?.stderr().slice(-12_000))
  throw error
} finally {
  database?.close()
  await core?.stop()
}

function startCore() {
  const child = spawn(coreBinary, [
    ...coreDataDirectoryArguments(data, { homeDirectory: home }),
    '--skill-library-root', join(data, 'managed-skill-library'),
    '--mcp-config-path', join(data, 'mcp.json')
  ], { cwd: fixture, stdio: ['pipe', 'pipe', 'pipe'], env: isolatedEnvironment })
  const pending = new Map()
  let nextId = 0
  let stderr = ''
  let resolveReady
  let rejectReady
  const ready = new Promise((resolveReadyPromise, rejectReadyPromise) => {
    resolveReady = resolveReadyPromise
    rejectReady = rejectReadyPromise
  })
  const startupTimer = setTimeout(() => rejectReady(new Error(`Core ready timeout: ${stderr}`)), 30_000)
  const closed = new Promise(resolveClosed => child.once('close', resolveClosed))
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
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGTERM'), 5000)
      try {
        await closed
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

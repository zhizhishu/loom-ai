import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { lstat, mkdtemp, realpath, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
// The delivery-chain seam below needs a digest, a bounded tree kill, directory setup and a
// read-only authority inspection. They are added as their own bindings so the harness the
// plan-import seam already owns stays untouched.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  coreDataDirectoryArguments,
  removeEphemeralRuntimeCampFilesRoot,
  runtimeCampFilesRootForDataDirectory
} from './runtime-camp-files-root.mjs'

const repository = resolve(import.meta.dirname, '../..')
const binary = process.env.ROVAI_CORE_BIN
  ?? join(repository, 'target', 'debug', process.platform === 'win32' ? 'rovai-core.exe' : 'rovai-core')

// This owns the real Core seam for LOOM orchestration: binary startup -> JSON-RPC
// -> one transaction -> read model. The plan/Task state machine and every rejection
// branch stay in crates/rovai-core/src/loom.rs unit tests; no Runtime is invoked and
// no Rust-level fixture can prove the wire shapes asserted here.
test('a real Core persists one LOOM plan, its Tasks and its dependency edges inside the isolated data dir', {
  timeout: 120_000
}, async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-loom-core-')))
  const dataDir = process.platform === 'win32'
    ? JSON.parse(execFileSync(binary, ['--prepare-windows-data-root', join(fixture, 'formal')], { encoding: 'utf8' })).core
    : join(fixture, 'data')
  const skillRoot = join(dataDir, 'managed-skill-library')
  const mcpPath = join(dataDir, 'mcp.json')
  const runtimeFilesRoot = runtimeCampFilesRootForDataDirectory(dataDir)
  // A missing binary must fail as an actionable assertion, not as a Core timeout.
  assert.ok(await lstat(binary).then(() => true, () => false),
    `rovai-core is missing at ${binary}; build it first: cargo build -p rovai-core --bin rovai-core`)
  const contained = path => {
    const offset = relative(fixture, path)
    return offset !== '' && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
  }
  const core = startCore(dataDir, skillRoot, mcpPath)
  try {
    await core.ready
    await core.settled()

    // Every path Core was given resolves inside the temporary fixture, except the one
    // platform-mandated Runtime Files Root the shared helper owns on POSIX. Core refuses
    // to infer daily userData, so an unpinned path cannot slip in through argv.
    assert.deepEqual(
      core.args.filter(argument => isAbsolute(argument) && !contained(argument) && argument !== runtimeFilesRoot),
      [],
      'Core must be launched with temporary-fixture paths only')

    const agent = (await core.request('members.list')).find(profile => profile.presence === 'present')
    assert.ok(agent, 'the fixture authority must expose one present member profile')
    const created = await core.request('missions.create', {
      commandId: randomUUID(),
      command: {
        title: 'LOOM plan import fixture',
        description: 'Owns the Core plan-import seam; no Runtime is launched.',
        projectPath: '',
        projectBindingKind: 'quick_chat',
        memberAgentIds: [agent.agentId],
        defaultLeadAgentId: agent.agentId,
        tags: ['loom-core-e2e']
      }
    })
    assert.equal(created.status, 'applied', JSON.stringify(created))
    const missionId = created.payload.missionId
    assert.equal(await core.request('loom.plan.get', { missionId }), null,
      'a Mission gains orchestration facts only through an import')

    const goal = 'Ship the LOOM plan import seam'
    const criteria = [
      { criterionId: 'criterion-import', text: 'one Mission imports exactly one Plan' },
      { criterionId: 'criterion-edges', text: 'dependency edges keep their release condition' }
    ]
    const tasks = [
      { taskId: 'loom-task-author', title: 'Author the plan', description: 'First half of the fixture' },
      { taskId: 'loom-task-verify', title: 'Verify the plan', description: 'Second half of the fixture' }
    ]
    const imported = await core.request('loom.plan.import', {
      missionId,
      goal,
      acceptanceCriteriaVersion: 'ac-1',
      criteria,
      tasks,
      dependencies: [{
        upstreamTaskId: 'loom-task-author',
        downstreamTaskId: 'loom-task-verify',
        condition: 'task_done'
      }]
    })
    assert.equal(imported.missionId, missionId)
    assert.equal(imported.acceptanceCriteriaVersion, 'ac-1')
    assert.equal(typeof imported.planId, 'string')
    assert.deepEqual(imported.taskIds, tasks.map(task => task.taskId))
    assert.equal(imported.dependencyIds.length, 1)

    const plan = await core.request('loom.plan.get', { missionId })
    assert.equal(plan.planId, imported.planId)
    assert.equal(plan.missionId, missionId)
    assert.equal(plan.goal, goal)
    assert.equal(plan.revision, 1)
    // The snapshot is `{version, criteria[]}`, never a bare criterion list.
    assert.deepEqual(plan.acceptanceCriteria, { version: 'ac-1', criteria })

    const listedTasks = await core.request('loom.tasks.list', { missionId })
    assert.equal(listedTasks.length, 2)
    assert.deepEqual(listedTasks.map(task => task.taskId), ['loom-task-author', 'loom-task-verify'])
    for (const task of listedTasks) {
      // Persistence keeps DRAFT uppercase; only the wire shape is lowercase.
      assert.equal(task.status, 'draft')
      assert.equal(task.planId, imported.planId)
      assert.equal(task.revision, 1)
      assert.equal(task.assigneeAgentId, null)
      assert.equal(task.blockedReason, null)
      assert.deepEqual(task.acceptanceCriteria, { version: 'ac-1', criteria })
    }
    assert.equal(listedTasks[0].title, 'Author the plan')
    assert.equal(listedTasks[1].description, 'Second half of the fixture')

    const dependencies = await core.request('loom.dependencies.list', { missionId })
    assert.equal(dependencies.length, 1)
    const [dependency] = dependencies
    assert.equal(dependency.dependencyId, imported.dependencyIds[0])
    assert.equal(dependency.planId, imported.planId)
    assert.equal(dependency.upstreamTaskId, 'loom-task-author')
    assert.equal(dependency.downstreamTaskId, 'loom-task-verify')
    assert.equal(dependency.condition, 'task_done')
    assert.equal(dependency.resolvedArtifactId, null)
    // Nothing released this edge, so there is no frozen resolution trace.
    assert.equal(dependency.resolution, null)
    assert.equal(typeof dependency.createdAt, 'string')

    // A Mission keeps exactly one Plan: the second import is a domain rejection,
    // not a replacement plan.
    await assert.rejects(core.request('loom.plan.import', {
      missionId,
      goal: 'A second plan must not replace the first',
      acceptanceCriteriaVersion: 'ac-2',
      criteria: [{ criterionId: 'criterion-replacement', text: 'never persisted' }],
      tasks: [{ taskId: 'loom-task-replacement', title: 'Never written' }],
      dependencies: []
    }), error => error.code === 'LOOM_PLAN_EXISTS'
      && error.kind === 'domain_rejection'
      && error.retryable === false)
    // The rejected import leaves no half graph behind.
    assert.deepEqual((await core.request('loom.tasks.list', { missionId })).map(task => task.taskId),
      ['loom-task-author', 'loom-task-verify'])
    assert.equal((await core.request('loom.dependencies.list', { missionId })).length, 1)

    // The authority, and therefore every plan it stores, lives inside the fixture.
    assert.ok(await lstat(join(dataDir, 'rovai.sqlite')))
    // A recursive walk catches an escape the argv check cannot see: a link below the
    // fixture that resolves outside it.
    const escapes = []
    const walk = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (!contained(await realpath(path))) escapes.push(path)
        if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(path)
      }
    }
    await walk(fixture)
    assert.deepEqual(escapes, [], 'every persisted path must stay inside the temporary userData')
  } finally {
    await core.close()
    // The only path Core may materialize outside the fixture is the shared helper's
    // instance-bound Runtime Files Root (`$HOME/.rovai/instances/<key>` on POSIX,
    // where Core refuses every other non-standalone root). Windows already keeps it
    // inside the data dir, so containment is the whole assertion there.
    await removeEphemeralRuntimeCampFilesRoot(dataDir, { temporaryDirectory: fixture })
    if (process.platform === 'win32') {
      assert.ok(contained(runtimeFilesRoot), 'Windows keeps the Runtime Files Root inside the data dir')
    } else {
      const survivor = await lstat(runtimeFilesRoot).then(() => true, (error) => {
        if (error.code === 'ENOENT') return false
        throw error
      })
      assert.equal(survivor, false, 'the ephemeral Runtime Files Root must not survive the run')
    }
    await rm(fixture, { recursive: true, force: true })
  }
})

// Copied from scripts/lib/core-startup-availability.test.mjs, which does not export
// it: spawning the real Core binary over newline-delimited JSON-RPC is the scaffold
// every Core seam test in this directory uses, so this file adds no second harness.
function startCore(dataDir, skillRoot, mcpPath) {
  const args = [
    ...coreDataDirectoryArguments(dataDir),
    '--skill-library-root', skillRoot,
    '--mcp-config-path', mcpPath
  ]
  const child = spawn(binary, args, { cwd: repository, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  const startupFrames = []
  let nextId = 0
  let stderr = ''
  const notifications = []
  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const startupTimeout = setTimeout(() => rejectReady(new Error(`Core ready timeout: ${stderr}`)), 15000)
  const closed = new Promise((resolve) => child.once('close', resolve))
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
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 10000) })
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
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        const states = await request('runtime.subsystems.get')
        if (states.every((entry) => entry.state !== 'initializing')) return states
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error('Optional initialization did not settle')
    },
    async close() {
      child.stdin.end()
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000)
      await closed
      clearTimeout(timeout)
      clearTimeout(startupTimeout)
      lines.close()
    }
  }
}

// This owns the real Core delivery seam: release -> claim -> candidate -> review ->
// verification -> dependency release, plus every branch that must NOT release a dependency
// and every replay/conflict fence. The LOOM state machine's own matrix stays in
// crates/rovai-core/src/loom.rs unit tests; nothing there can prove these wire shapes, the
// Host-injected identities, or which rows reached storage. No Runtime is launched.
test('a real Core carries one LOOM delivery through release, claim, candidate, review and verification before the dependency is released', {
  // The empty CARGO_TARGET_DIR below makes this test compile rovai-core and its whole
  // dependency tree, so the budget belongs to cargo, not to the RPCs.
  timeout: 900_000
}, async (t) => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-loom-chain-')))
  // Registered before the build: even a failed build must leave no temporary root behind.
  // `rm` is idempotent, so the `finally` below can remove it first.
  t.after(async () => { await rm(fixture, { recursive: true, force: true }) })
  const cargoTargetDir = join(fixture, 'cargo-target')
  const isolatedHome = join(fixture, 'home')
  const isolatedTemporary = join(fixture, 'tmp')
  const isolatedRuntimeDirectory = join(fixture, 'runtime-dir')
  // An empty target directory is the point of the build: no artifact an earlier run left
  // behind can be launched, so the binary under test is the one this test just produced.
  await mkdir(cargoTargetDir)
  await mkdir(isolatedHome)
  await mkdir(isolatedTemporary)
  await mkdir(isolatedRuntimeDirectory)
  // Core is launched with every user-scoped root redirected into this fixture, so a write
  // outside the data dir still has to land inside the temporary root to be allowed.
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
  const builtBinary = join(cargoTargetDir, 'debug', process.platform === 'win32' ? 'rovai-core.exe' : 'rovai-core')
  // Whole seconds, so a coarse filesystem timestamp cannot fail the "just built" assertion.
  const buildStartedAt = Math.floor(Date.now() / 1000) * 1000
  try {
    execFileSync('cargo', ['build', '-p', 'rovai-core', '--bin', 'rovai-core'], {
      cwd: repository,
      env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDir },
      stdio: 'pipe',
      timeout: 600_000
    })
  } catch (error) {
    assert.fail(`cargo build -p rovai-core --bin rovai-core failed against an empty CARGO_TARGET_DIR: ${error.message}`)
  }
  const built = await lstat(builtBinary)
  assert.ok(built.mtimeMs >= buildStartedAt,
    `${builtBinary} must be the artifact this build wrote, not a leftover (mtime ${built.mtime.toISOString()})`)
  // ROVAI_CORE_BIN still decides what is launched, so a supervisor can point this seam at a
  // release build; the freshly built artifact is the default.
  const launchBinary = process.env.ROVAI_CORE_BIN ?? builtBinary
  assert.ok(await lstat(launchBinary).then(() => true, () => false),
    `rovai-core is missing at ${launchBinary}; build it first: cargo build -p rovai-core --bin rovai-core`)
  const digest = createHash('sha256').update(await readFile(launchBinary)).digest('hex')
  console.log(`LOOM delivery e2e binary ${launchBinary} sha256=${digest} builtAt=${built.mtime.toISOString()}`)
  const dataDir = process.platform === 'win32'
    ? JSON.parse(execFileSync(launchBinary, ['--prepare-windows-data-root', join(fixture, 'formal')], { encoding: 'utf8' })).core
    : join(fixture, 'data')
  if (process.platform !== 'win32') await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const skillRoot = join(dataDir, 'managed-skill-library')
  const mcpPath = join(dataDir, 'mcp.json')
  const runtimeFilesRoot = runtimeCampFilesRootForDataDirectory(dataDir, { homeDirectory: isolatedHome })
  const contained = path => {
    const offset = relative(fixture, path)
    return offset !== '' && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
  }
  // The root Core is about to receive, recorded before it starts: nothing but the data dir
  // itself may appear beside it afterwards, so an escaped write cannot hide in the fixture.
  const rootBefore = (await readdir(fixture)).sort()
  const core = startIsolatedCore({
    dataDir,
    skillRoot,
    mcpPath,
    binaryPath: launchBinary,
    environment: isolatedEnvironment
  })
  const claims = new Set()
  let database = null
  try {
    await core.ready
    await core.settled()
    // Unlike the plan-import seam there is no exception for the Runtime Files Root here: with
    // HOME inside the fixture, every absolute argument must be contained.
    assert.deepEqual(
      core.args.filter(argument => isAbsolute(argument) && !contained(argument)),
      [],
      `Core must be launched with paths inside the exclusive temporary root only: ${JSON.stringify(core.args)}`)

    const members = await core.request('members.list')
    const agent = members.find(profile => profile.presence === 'present')
    assert.ok(agent, `the fixture authority must expose one present member profile: ${JSON.stringify(members)}`)

    // A rejection arrives as the bare `{kind, code, message, retryable, details}` body, so
    // every expectation names its code and reprints the raw body when it fails.
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
    const criterionResults = (criteria, satisfied) => criteria.map(criterion => ({
      criterionId: criterion.criterionId,
      satisfied,
      note: 'loom delivery chain fixture'
    }))
    const createMission = async (title) => {
      const created = await core.request('missions.create', {
        commandId: randomUUID(),
        command: {
          title,
          description: 'Owns the real Core LOOM delivery chain; no Runtime is launched.',
          projectPath: '',
          projectBindingKind: 'quick_chat',
          memberAgentIds: [agent.agentId],
          defaultLeadAgentId: agent.agentId,
          tags: ['loom-core-e2e']
        }
      })
      assert.equal(created.status, 'applied', `missions.create must apply: ${JSON.stringify(created)}`)
      return created.payload.missionId
    }
    const importPlan = async ({ missionId, version, criteria, tasks, dependencies }) => {
      const imported = await core.request('loom.plan.import', {
        missionId,
        goal: `LOOM delivery chain ${version}`,
        acceptanceCriteriaVersion: version,
        criteria,
        tasks,
        dependencies
      })
      assert.equal(imported.missionId, missionId,
        `loom.plan.import must answer for its Mission: ${JSON.stringify(imported)}`)
      assert.equal(imported.acceptanceCriteriaVersion, version,
        `the import receipt must name the imported version: ${JSON.stringify(imported)}`)
      assert.deepEqual(imported.taskIds, tasks.map(task => task.taskId),
        `the import receipt must name every Task: ${JSON.stringify(imported)}`)
      assert.equal(imported.dependencyIds.length, dependencies.length,
        `the import receipt must name every edge: ${JSON.stringify(imported)}`)
      return imported
    }
    // Returns the listing too, so every status assertion can print the raw response.
    const taskStatus = async (missionId, taskId) => {
      const listed = await core.request('loom.tasks.list', { missionId })
      const task = listed.find(entry => entry.taskId === taskId)
      assert.ok(task, `task ${taskId} must be listed for its Mission: ${JSON.stringify(listed)}`)
      return { status: task.status, listed }
    }
    // A replay must not append a row, so the list itself is the evidence.
    const expectListLength = async (method, missionId, expected, message) => {
      const listed = await core.request(method, { missionId })
      assert.equal(listed.length, expected, `${message}: ${JSON.stringify(listed)}`)
    }
    // Both anti-cheat chains submit through the same side; only the verdict differs.
    const deliverCandidate = async ({ missionId, taskId, downstreamTaskId, version }) => {
      for (const releasedTaskId of [taskId, downstreamTaskId]) {
        const released = await core.request('loom.task.release', { missionId, taskId: releasedTaskId })
        assert.equal(released.task.status, 'ready',
          `loom.task.release must move ${releasedTaskId} to ready: ${JSON.stringify(released)}`)
      }
      const agentRunId = randomUUID()
      const claim = await core.request('loom.claim.acquire', {
        missionId,
        taskId,
        agentRunId,
        commandId: randomUUID()
      })
      assert.equal(claim.replayed, false,
        `the first claim of ${taskId} must not be a replay: ${JSON.stringify(claim)}`)
      claims.add(claim.claimId)
      const candidate = await core.request('loom.candidate.record', {
        missionId,
        taskId,
        agentRunId,
        claimId: claim.claimId,
        fenceGeneration: claim.fenceGeneration,
        commandId: randomUUID(),
        contentHash: createHash('sha256').update(`${version} artifact`).digest('hex'),
        evidenceIds: [`evidence-${version}`],
        acceptanceCriteriaVersion: version
      })
      assert.equal(candidate.taskId, taskId, `the candidate must bind its Task: ${JSON.stringify(candidate)}`)
      return { agentRunId, claim, candidate }
    }

    // ---- The accepted delivery: every step of the chain, in contract order ----
    const missionId = await createMission('LOOM delivery chain fixture')
    const version = 'ac-chain'
    const criteria = [
      { criterionId: 'criterion-artifact', text: 'the delivery names the artifact it produced' },
      { criterionId: 'criterion-chain', text: 'the delivery was reviewed before it was verified' }
    ]
    const upstreamTaskId = 'loom-chain-upstream'
    const downstreamTaskId = 'loom-chain-downstream'
    const imported = await importPlan({
      missionId,
      version,
      criteria,
      tasks: [
        { taskId: upstreamTaskId, title: 'Produce the artifact', description: 'Upstream half of the chain' },
        { taskId: downstreamTaskId, title: 'Consume the artifact', description: 'Downstream half of the chain' }
      ],
      dependencies: [{ upstreamTaskId, downstreamTaskId, condition: 'artifact_accepted' }]
    })
    assert.equal(typeof imported.planId, 'string', `the import receipt must carry its planId: ${JSON.stringify(imported)}`)
    const [dependencyId] = imported.dependencyIds

    // Release is only a DRAFT -> READY move and does not look at the edges, which is why both
    // Tasks can be released before anything upstream was delivered.
    for (const releasedTaskId of [upstreamTaskId, downstreamTaskId]) {
      const released = await core.request('loom.task.release', { missionId, taskId: releasedTaskId })
      assert.equal(released.missionId, missionId,
        `loom.task.release must answer for its Mission: ${JSON.stringify(released)}`)
      assert.equal(released.planId, imported.planId,
        `the release receipt must name the plan: ${JSON.stringify(released)}`)
      assert.equal(released.task.taskId, releasedTaskId,
        `the release receipt must name its Task: ${JSON.stringify(released)}`)
      assert.equal(released.task.status, 'ready',
        `loom.task.release must move ${releasedTaskId} to ready: ${JSON.stringify(released)}`)
    }

    const claimCommandId = randomUUID()
    const upstreamRunId = randomUUID()
    const claim = await core.request('loom.claim.acquire', {
      missionId,
      taskId: upstreamTaskId,
      agentRunId: upstreamRunId,
      commandId: claimCommandId
    })
    assert.equal(claim.taskId, upstreamTaskId, `the claim must bind its Task: ${JSON.stringify(claim)}`)
    assert.equal(claim.agentRunId, upstreamRunId, `the claim must bind its AgentRun: ${JSON.stringify(claim)}`)
    assert.equal(claim.replayed, false, `the first claim must not be a replay: ${JSON.stringify(claim)}`)
    assert.equal(typeof claim.claimId, 'string', `the claim receipt must carry its claimId: ${JSON.stringify(claim)}`)
    assert.ok(Number.isInteger(claim.fenceGeneration) && claim.fenceGeneration >= 1,
      `the claim receipt must carry a fence generation: ${JSON.stringify(claim)}`)
    claims.add(claim.claimId)

    const contentHash = createHash('sha256').update('loom delivery chain artifact').digest('hex')
    const candidateParams = {
      missionId,
      taskId: upstreamTaskId,
      agentRunId: upstreamRunId,
      claimId: claim.claimId,
      fenceGeneration: claim.fenceGeneration,
      commandId: randomUUID(),
      contentHash,
      evidenceIds: ['evidence-loom-chain'],
      acceptanceCriteriaVersion: version
    }
    const candidate = await core.request('loom.candidate.record', candidateParams)
    assert.equal(candidate.taskId, upstreamTaskId, `the candidate must bind its Task: ${JSON.stringify(candidate)}`)
    assert.equal(candidate.agentRunId, upstreamRunId, `the candidate must bind its AgentRun: ${JSON.stringify(candidate)}`)
    assert.equal(candidate.contentHash, contentHash, `the candidate must keep its content hash: ${JSON.stringify(candidate)}`)
    assert.equal(candidate.replayed, false, `the first submission must not be a replay: ${JSON.stringify(candidate)}`)
    assert.equal(typeof candidate.candidateId, 'string',
      `the candidate receipt must carry its candidateId: ${JSON.stringify(candidate)}`)
    assert.equal(candidate.verificationStatus, 'unverified',
      `a new candidate starts unverified: ${JSON.stringify(candidate)}`)
    assert.equal(candidate.acceptanceStatus, 'pending',
      `a new candidate starts pending acceptance: ${JSON.stringify(candidate)}`)
    const afterCandidate = await taskStatus(missionId, upstreamTaskId)
    assert.equal(afterCandidate.status, 'in_review',
      `a recorded candidate must move its Task into review: ${JSON.stringify(afterCandidate.listed)}`)

    const reviewParams = {
      missionId,
      taskId: upstreamTaskId,
      candidateId: candidate.candidateId,
      commandId: randomUUID(),
      acceptanceCriteriaVersion: version,
      verdict: 'accepted',
      reason: 'the recorded artifact answers both criteria',
      criteriaResults: criterionResults(criteria, true),
      // A client must never choose the reviewer: the Host injects the trusted identity and
      // overwrites whatever the payload carries.
      reviewerId: 'fake'
    }
    const review = await core.request('loom.review.record', reviewParams)
    assert.equal(review.replayed, false, `the first verdict must not be a replay: ${JSON.stringify(review)}`)
    assert.equal(review.review.verdict, 'accepted', `the receipt must keep the verdict: ${JSON.stringify(review)}`)
    assert.equal(review.review.reviewerId, 'local_user',
      `the Host must overwrite a spoofed reviewerId: ${JSON.stringify(review)}`)
    assert.equal(review.taskStatus, 'done',
      `an accepted review must finish its Task: ${JSON.stringify(review)}`)
    assert.equal(review.candidateAcceptanceStatus, 'accepted',
      `an accepted review must accept its candidate: ${JSON.stringify(review)}`)
    const reviewId = review.review.reviewId
    // (a) The verdict alone releases nothing, so the trace stays absent.
    assert.deepEqual(review.releasedDependencyIds, [],
      `an accepted review without a verification must release no dependency: ${JSON.stringify(review)}`)
    const frozenFree = await core.request('loom.dependencies.list', { missionId })
    assert.equal(frozenFree.length, 1, `the plan must still hold its one edge: ${JSON.stringify(frozenFree)}`)
    assert.equal(frozenFree[0].dependencyId, dependencyId,
      `the listed edge must be the imported one: ${JSON.stringify(frozenFree)}`)
    assert.equal(frozenFree[0].condition, 'artifact_accepted',
      `the listed edge must keep its release condition: ${JSON.stringify(frozenFree)}`)
    assert.equal(frozenFree[0].resolution, null,
      `an unreleased artifact edge must keep no frozen resolution: ${JSON.stringify(frozenFree)}`)

    // (b) A downstream Task cannot be claimed while its artifact edge is frozen-free.
    await expectRejection(core.request('loom.claim.acquire', {
      missionId,
      taskId: downstreamTaskId,
      agentRunId: randomUUID(),
      commandId: randomUUID()
    }), 'loom.claim.acquire', 'LOOM_DEPENDENCY_UNRELEASED')

    const verificationParams = {
      missionId,
      taskId: upstreamTaskId,
      candidateId: candidate.candidateId,
      commandId: randomUUID(),
      method: 'e2e',
      result: 'passed',
      evidenceIds: ['evidence-loom-chain'],
      // Same spoof on the evidence axis: the Host owns the executor identity too.
      executorId: 'fake'
    }
    const verification = await core.request('loom.verification.record', verificationParams)
    assert.equal(verification.replayed, false, `the first check must not be a replay: ${JSON.stringify(verification)}`)
    assert.equal(verification.candidateVerificationStatus, 'verified',
      `a passing check must verify the candidate: ${JSON.stringify(verification)}`)
    assert.equal(verification.verification.executorId, 'local_user',
      `the Host must overwrite a spoofed executorId: ${JSON.stringify(verification)}`)
    assert.equal(verification.verification.method, 'e2e',
      `the receipt must keep the verification method: ${JSON.stringify(verification)}`)
    assert.equal(verification.verification.result, 'passed',
      `the receipt must keep the verification result: ${JSON.stringify(verification)}`)
    assert.deepEqual(verification.releasedDependencyIds, [dependencyId],
      `a passing verification must release the accepted artifact edge: ${JSON.stringify(verification)}`)

    // (f) The frozen trace must name the exact candidate and review the receipts named.
    const releasedEdges = await core.request('loom.dependencies.list', { missionId })
    assert.equal(releasedEdges.length, 1, `the plan must still hold its one edge: ${JSON.stringify(releasedEdges)}`)
    const [edge] = releasedEdges
    assert.ok(edge.resolution, `a released artifact edge must freeze its trace: ${JSON.stringify(edge)}`)
    assert.equal(edge.resolution.candidateId, candidate.candidateId,
      `the trace must name the verified candidate: ${JSON.stringify(edge.resolution)}`)
    assert.equal(edge.resolution.reviewId, reviewId,
      `the trace must name the accepting review: ${JSON.stringify(edge.resolution)}`)
    assert.ok(Number.isInteger(edge.resolution.upstreamTaskRevision) && edge.resolution.upstreamTaskRevision > 0,
      `the trace must name the completing revision: ${JSON.stringify(edge.resolution)}`)
    assert.equal(typeof edge.resolution.resolvedAt, 'string',
      `the trace must name when it froze: ${JSON.stringify(edge.resolution)}`)

    // (c) With the edge released, the same downstream Task is claimable under a new command.
    const downstreamRunId = randomUUID()
    const downstreamClaim = await core.request('loom.claim.acquire', {
      missionId,
      taskId: downstreamTaskId,
      agentRunId: downstreamRunId,
      commandId: randomUUID()
    })
    assert.equal(downstreamClaim.taskId, downstreamTaskId,
      `the released downstream Task must be claimable: ${JSON.stringify(downstreamClaim)}`)
    assert.equal(downstreamClaim.agentRunId, downstreamRunId,
      `the downstream claim must bind its AgentRun: ${JSON.stringify(downstreamClaim)}`)
    assert.equal(downstreamClaim.replayed, false,
      `the downstream claim is a new command, not a replay: ${JSON.stringify(downstreamClaim)}`)
    claims.add(downstreamClaim.claimId)

    // (g) Idempotency. The same command at the same target returns the original row; the same
    // command at another target is a conflict; neither writes a row.
    const replayedClaim = await core.request('loom.claim.acquire', {
      missionId,
      taskId: upstreamTaskId,
      agentRunId: upstreamRunId,
      commandId: claimCommandId
    })
    assert.equal(replayedClaim.replayed, true,
      `a replayed claim command must report its replay: ${JSON.stringify(replayedClaim)}`)
    assert.equal(replayedClaim.claimId, claim.claimId,
      `a replayed claim command must return the original claim: ${JSON.stringify(replayedClaim)}`)
    assert.equal(replayedClaim.fenceGeneration, claim.fenceGeneration,
      `a replay must not advance the fence: ${JSON.stringify(replayedClaim)}`)
    await expectRejection(core.request('loom.claim.acquire', {
      missionId,
      taskId: upstreamTaskId,
      agentRunId: randomUUID(),
      commandId: claimCommandId
    }), 'loom.claim.acquire', 'LOOM_CLAIM_COMMAND_REUSED')

    const replayedCandidate = await core.request('loom.candidate.record', candidateParams)
    assert.equal(replayedCandidate.replayed, true,
      `a replayed candidate command must report its replay: ${JSON.stringify(replayedCandidate)}`)
    assert.equal(replayedCandidate.candidateId, candidate.candidateId,
      `a replayed candidate command must return the original candidate: ${JSON.stringify(replayedCandidate)}`)
    await expectListLength('loom.candidates.list', missionId, 1,
      'a replayed candidate command must not record a second candidate')
    await expectRejection(core.request('loom.candidate.record', { ...candidateParams, agentRunId: randomUUID() }),
      'loom.candidate.record', 'LOOM_CANDIDATE_COMMAND_REUSED')

    const replayedReview = await core.request('loom.review.record', reviewParams)
    assert.equal(replayedReview.replayed, true,
      `a replayed review command must report its replay: ${JSON.stringify(replayedReview)}`)
    assert.equal(replayedReview.review.reviewId, reviewId,
      `a replayed review command must return the original review: ${JSON.stringify(replayedReview)}`)
    assert.deepEqual(replayedReview.releasedDependencyIds, [],
      `a replayed review must not claim a release it did not perform: ${JSON.stringify(replayedReview)}`)
    await expectListLength('loom.reviews.list', missionId, 1,
      'a replayed review command must not record a second review')
    await expectRejection(core.request('loom.review.record', { ...reviewParams, candidateId: 'candidate-other' }),
      'loom.review.record', 'LOOM_REVIEW_REPLAY_CONFLICT')

    const replayedVerification = await core.request('loom.verification.record', verificationParams)
    assert.equal(replayedVerification.replayed, true,
      `a replayed verification command must report its replay: ${JSON.stringify(replayedVerification)}`)
    assert.equal(replayedVerification.verification.verificationId, verification.verification.verificationId,
      `a replayed verification command must return the original check: ${JSON.stringify(replayedVerification)}`)
    assert.deepEqual(replayedVerification.releasedDependencyIds, [],
      `a replayed verification must not claim a release it did not perform: ${JSON.stringify(replayedVerification)}`)
    await expectListLength('loom.verifications.list', missionId, 1,
      'a replayed verification command must not record a second verification')
    await expectRejection(core.request('loom.verification.record', { ...verificationParams, candidateId: 'candidate-other' }),
      'loom.verification.record', 'LOOM_VERIFICATION_REPLAY_CONFLICT')

    // The two axes stay independent in the read model, pinned to the Plan's snapshot.
    const [storedCandidate] = await core.request('loom.candidates.list', { missionId })
    assert.equal(storedCandidate.candidateId, candidate.candidateId,
      `the Mission must list exactly its candidate: ${JSON.stringify(storedCandidate)}`)
    assert.equal(storedCandidate.verificationStatus, 'verified',
      `the listed candidate must stay verified: ${JSON.stringify(storedCandidate)}`)
    assert.equal(storedCandidate.acceptanceStatus, 'accepted',
      `the listed candidate must stay accepted: ${JSON.stringify(storedCandidate)}`)
    assert.deepEqual(storedCandidate.acceptanceCriteria, { version, criteria },
      `the listed candidate must keep its frozen criteria snapshot: ${JSON.stringify(storedCandidate)}`)
    const afterAcceptance = await taskStatus(missionId, upstreamTaskId)
    assert.equal(afterAcceptance.status, 'done',
      `the accepted and verified Task must stay done: ${JSON.stringify(afterAcceptance.listed)}`)

    // (d) Anti-cheat: an edge needs the pair - an accepting review AND a passing check.
    // Neither half alone may release it.
    const verificationOnlyMissionId = await createMission('LOOM verification without an accepting review')
    const verificationOnlyUpstreamId = 'loom-verify-only-upstream'
    const verificationOnlyDownstreamId = 'loom-verify-only-downstream'
    const verificationOnlyPlan = await importPlan({
      missionId: verificationOnlyMissionId,
      version: 'ac-verify-only',
      criteria: [{ criterionId: 'criterion-verify-only', text: 'a check alone never releases the edge' }],
      tasks: [
        { taskId: verificationOnlyUpstreamId, title: 'Produce the artifact', description: 'Checked but never reviewed' },
        { taskId: verificationOnlyDownstreamId, title: 'Consume the artifact', description: 'Must stay blocked' }
      ],
      dependencies: [{
        upstreamTaskId: verificationOnlyUpstreamId,
        downstreamTaskId: verificationOnlyDownstreamId,
        condition: 'artifact_accepted'
      }]
    })
    assert.equal(verificationOnlyPlan.dependencyIds.length, 1,
      `the verification-only plan must keep its edge: ${JSON.stringify(verificationOnlyPlan)}`)
    const verificationOnlyArtifact = await deliverCandidate({
      missionId: verificationOnlyMissionId,
      taskId: verificationOnlyUpstreamId,
      downstreamTaskId: verificationOnlyDownstreamId,
      version: 'ac-verify-only'
    })
    const verificationOnly = await core.request('loom.verification.record', {
      missionId: verificationOnlyMissionId,
      taskId: verificationOnlyUpstreamId,
      candidateId: verificationOnlyArtifact.candidate.candidateId,
      commandId: randomUUID(),
      method: 'e2e',
      result: 'passed',
      evidenceIds: ['evidence-ac-verify-only'],
      executorId: 'fake'
    })
    assert.equal(verificationOnly.candidateVerificationStatus, 'verified',
      `the check still verifies the candidate: ${JSON.stringify(verificationOnly)}`)
    assert.deepEqual(verificationOnly.releasedDependencyIds, [],
      `a passing verification without an accepting review must release no dependency: ${JSON.stringify(verificationOnly)}`)
    assert.equal((await core.request('loom.dependencies.list', { missionId: verificationOnlyMissionId }))[0].resolution, null,
      'a verification-only delivery must leave the artifact edge frozen-free')
    const afterVerificationOnly = await taskStatus(verificationOnlyMissionId, verificationOnlyUpstreamId)
    assert.equal(afterVerificationOnly.status, 'in_review',
      `a verification alone must not move the Task out of review: ${JSON.stringify(afterVerificationOnly.listed)}`)
    await expectRejection(core.request('loom.claim.acquire', {
      missionId: verificationOnlyMissionId,
      taskId: verificationOnlyDownstreamId,
      agentRunId: randomUUID(),
      commandId: randomUUID()
    }), 'loom.claim.acquire', 'LOOM_DEPENDENCY_UNRELEASED')

    const rejectedMissionId = await createMission('LOOM verification after a rejected review')
    const rejectedUpstreamId = 'loom-reject-upstream'
    const rejectedDownstreamId = 'loom-reject-downstream'
    const rejectedCriteria = [{ criterionId: 'criterion-rejected', text: 'a rejected verdict keeps the edge closed' }]
    const rejectedPlan = await importPlan({
      missionId: rejectedMissionId,
      version: 'ac-reject',
      criteria: rejectedCriteria,
      tasks: [
        { taskId: rejectedUpstreamId, title: 'Produce the artifact', description: 'Rejected then checked' },
        { taskId: rejectedDownstreamId, title: 'Consume the artifact', description: 'Must stay blocked' }
      ],
      dependencies: [{
        upstreamTaskId: rejectedUpstreamId,
        downstreamTaskId: rejectedDownstreamId,
        condition: 'artifact_accepted'
      }]
    })
    assert.equal(rejectedPlan.dependencyIds.length, 1,
      `the rejected-delivery plan must keep its edge: ${JSON.stringify(rejectedPlan)}`)
    const rejectedArtifact = await deliverCandidate({
      missionId: rejectedMissionId,
      taskId: rejectedUpstreamId,
      downstreamTaskId: rejectedDownstreamId,
      version: 'ac-reject'
    })
    const rejectedReview = await core.request('loom.review.record', {
      missionId: rejectedMissionId,
      taskId: rejectedUpstreamId,
      candidateId: rejectedArtifact.candidate.candidateId,
      commandId: randomUUID(),
      acceptanceCriteriaVersion: 'ac-reject',
      verdict: 'rejected',
      reason: 'the delivery does not answer the criterion',
      criteriaResults: criterionResults(rejectedCriteria, false),
      reviewerId: 'fake'
    })
    assert.equal(rejectedReview.replayed, false,
      `the rejection must not be a replay: ${JSON.stringify(rejectedReview)}`)
    assert.equal(rejectedReview.taskStatus, 'ready',
      `a rejected review must return the Task to ready: ${JSON.stringify(rejectedReview)}`)
    assert.equal(rejectedReview.candidateAcceptanceStatus, 'rejected',
      `a rejected review must reject its candidate: ${JSON.stringify(rejectedReview)}`)
    assert.deepEqual(rejectedReview.releasedDependencyIds, [],
      `a rejected review must release no dependency: ${JSON.stringify(rejectedReview)}`)
    const verificationAfterRejection = await core.request('loom.verification.record', {
      missionId: rejectedMissionId,
      taskId: rejectedUpstreamId,
      candidateId: rejectedArtifact.candidate.candidateId,
      commandId: randomUUID(),
      method: 'e2e',
      result: 'passed',
      evidenceIds: ['evidence-ac-reject'],
      executorId: 'fake'
    })
    assert.equal(verificationAfterRejection.candidateVerificationStatus, 'verified',
      `the check still verifies the candidate: ${JSON.stringify(verificationAfterRejection)}`)
    assert.deepEqual(verificationAfterRejection.releasedDependencyIds, [],
      `a rejection keeps the edge closed even after a passing verification: ${JSON.stringify(verificationAfterRejection)}`)
    assert.equal((await core.request('loom.dependencies.list', { missionId: rejectedMissionId }))[0].resolution, null,
      'a rejected delivery must leave the artifact edge frozen-free')
    await expectRejection(core.request('loom.claim.acquire', {
      missionId: rejectedMissionId,
      taskId: rejectedDownstreamId,
      agentRunId: randomUUID(),
      commandId: randomUUID()
    }), 'loom.claim.acquire', 'LOOM_DEPENDENCY_UNRELEASED')

    // (e) The injected identities are only visible in the authority itself, so the last
    // assertions read the file directly - read-only, after Core has closed it.
    await core.close()
    database = new DatabaseSync(join(dataDir, 'rovai.sqlite'), { readOnly: true })
    const reviewRows = database.prepare(
      'SELECT review_id, candidate_id, verdict, reviewer_id FROM loom_review ORDER BY reviewed_at, review_id'
    ).all()
    assert.equal(reviewRows.length, 2,
      `exactly one accepted and one rejected review must be stored: ${JSON.stringify(reviewRows)}`)
    assert.deepEqual([...new Set(reviewRows.map(row => row.reviewer_id))], ['local_user'],
      `every stored review must carry the Host identity, never the spoofed reviewerId: ${JSON.stringify(reviewRows)}`)
    const storedAcceptedReview = reviewRows.find(row => row.review_id === reviewId)
    assert.ok(storedAcceptedReview, `the accepted review must be stored: ${JSON.stringify(reviewRows)}`)
    assert.equal(storedAcceptedReview.verdict, 'ACCEPTED',
      `the stored verdict keeps its uppercase literal: ${JSON.stringify(storedAcceptedReview)}`)
    assert.equal(storedAcceptedReview.candidate_id, candidate.candidateId,
      `the stored review must keep its candidate: ${JSON.stringify(storedAcceptedReview)}`)
    const verificationRows = database.prepare(
      'SELECT verification_id, candidate_id, method, result, executor_id FROM loom_verification ORDER BY verified_at, verification_id'
    ).all()
    assert.equal(verificationRows.length, 3,
      `every passing check must be stored once: ${JSON.stringify(verificationRows)}`)
    assert.deepEqual([...new Set(verificationRows.map(row => row.executor_id))], ['local_user'],
      `every stored verification must carry the Host identity, never the spoofed executorId: ${JSON.stringify(verificationRows)}`)
    assert.ok(verificationRows.every(row => row.result === 'PASSED' && row.method === 'e2e'),
      `every stored verification keeps its stored method and result: ${JSON.stringify(verificationRows)}`)
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM loom_review WHERE reviewer_id='fake'").get().count, 0,
      'a spoofed reviewerId must never reach storage')
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM loom_verification WHERE executor_id='fake'").get().count, 0,
      'a spoofed executorId must never reach storage')
    // Row counts, not just receipts: a replay or a rejected attempt writes nothing.
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM loom_claim').get().count, claims.size,
      `a replayed or rejected claim command must not write a row (expected ${claims.size} accepted claims)`)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM loom_candidate').get().count, 3,
      'each of the three chains records exactly one candidate')
    database.close()
    database = null
  } finally {
    database?.close()
    await core.close()
    try {
      await removeEphemeralRuntimeCampFilesRoot(dataDir, {
        temporaryDirectory: fixture,
        homeDirectory: isolatedHome
      })
      // Core keeps its Runtime Files Root outside the data dir (inside the fixture HOME), so
      // it still has to be contained: nothing Core creates may leave the temporary root.
      assert.ok(contained(runtimeFilesRoot),
        `the Runtime Files Root must stay inside the exclusive temporary root: ${runtimeFilesRoot}`)
      const escapes = []
      const walk = async (directory) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name)
          // cargo's build tree is this test's, not Core's, and holds no Core-written path.
          if (path === cargoTargetDir) continue
          if (!contained(await realpath(path))) escapes.push(path)
          if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(path)
        }
      }
      await walk(fixture)
      assert.deepEqual(escapes, [], 'every path Core materialized must resolve inside the temporary root')
      // Core may only populate the data dir it was given; it may not add a sibling to it.
      assert.deepEqual((await readdir(fixture)).sort(), rootBefore,
        'Core must create nothing beside the data dir it was given')
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  }
})

// The delivery-chain seam owns its own user-scoped roots, so it needs a harness that can
// launch Core with a redirected environment and can kill the whole tree on a deadline.
// Framing, startup frames and the RPC/pending map stay identical to `startCore` above.
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
  const closed = new Promise((resolve) => child.once('close', resolve))
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
    async close() {
      if (!child.stdin.destroyed) child.stdin.end()
      const graceful = setTimeout(() => child.kill('SIGTERM'), 5_000)
      const forced = setTimeout(() => killProcessTree(child), 15_000)
      try {
        await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 20_000))])
      } finally {
        clearTimeout(graceful)
        clearTimeout(forced)
        clearTimeout(startupTimeout)
        lines.close()
      }
    }
  }
}

function killProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    return
  }
  try {
    // The detached spawn put Core in its own process group, so the negative pid is the tree.
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

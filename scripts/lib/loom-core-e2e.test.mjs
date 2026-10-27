import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { lstat, mkdtemp, realpath, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
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

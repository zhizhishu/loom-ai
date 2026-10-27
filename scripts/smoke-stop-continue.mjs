// Real Core + synthetic ACP process. All user operations go through public RPC;
// SQLite is read-only evidence. --shutdown-text verifies normal exit/reopen;
// the default stop/continue scenario never restarts or repairs state directly.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { createConfiguredCampAndSend } from './lib/create-configured-camp.mjs'
import { coreDataDirectoryArguments, removeEphemeralRuntimeCampFilesRoot } from './lib/runtime-camp-files-root.mjs'

if (process.platform === 'win32') throw new Error('This shell fixture requires macOS or Linux')
const root = resolve(import.meta.dirname, '..')
const fixture = await realpath(process.env.ROVAI_STOP_CONTINUE_FIXTURE_ROOT ?? await mkdtemp(join(tmpdir(), 'rovai-stop-continue-')))
const data = join(fixture, 'core'), home = join(fixture, 'home'), workspace = join(fixture, 'workspace')
const journal = join(fixture, 'prompts.jsonl'), executable = join(fixture, 'copilot-fixture')
const shutdownText = process.argv.includes('--shutdown-text')
const expectedText = '退出前已接收的正文🙂\n'.repeat(process.argv.includes('--spooled') ? 5000 : 16)
const textFile = join(fixture, 'unfinished-text.txt')
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
await Promise.all([data, home, workspace].map(path => mkdir(path)))
if (shutdownText) await writeFile(textFile, expectedText)
await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, 'scripts/fixtures/missing-completion-acp-runtime.mjs'))} --fixture-journal ${quote(journal)} ${shutdownText ? `--fixture-text ${quote(textFile)} ` : ''}"$@"\n`)
await chmod(executable, 0o700)
console.error(`Automatic acceptance: data=${data}; skills=${join(data, 'managed-skill-library')}; MCP=${join(data, 'mcp.json')}`)
let core, database
try {
  core = startCore()
  await core.request('health.check')
  await core.request('runtime.discovery.rescan', { interactiveShell: false })
  await core.request('runtime.product.check', { runtimeKind: 'copilot-cli' })
  const installation = await until(async () => (await core.request('runtime.installations.list'))
    .find(item => item.adapterKind === 'copilot-cli' && item.snapshot?.probeStatus === 'ready'), 'synthetic capability check')
  const profile = await core.request('members.get', { agentId: 'agent_1' })
  const configured = await core.request('members.runtime.set', { commandId: crypto.randomUUID(), command: {
    agentId: 'agent_1', expectedVersion: profile.version, adapterKind: 'copilot-cli',
    model: installation.memberRuntimeDefaults.model, permissions: installation.memberRuntimeDefaults.permissions
  } })
  assert.equal(configured.status, 'applied')
  const created = await createConfiguredCampAndSend(core.request, {
    commandId: crypto.randomUUID(), name: 'Missing completion recovery', workspace: { projectPath: workspace },
    memberAgentIds: ['agent_1'], defaultLeadAgentId: 'agent_1',
    body: 'Perform the fixture work.', purpose: 'Verify stop and explicit continuation'
  })
  const threadId = created.payload.threadId
  database = new DatabaseSync(join(data, 'rovai.sqlite'), { readOnly: true })
  const prompts = async () => readFile(journal, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(JSON.parse)).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const snapshot = () => core.request('threads.snapshot', { threadId })
  await until(async () => (await prompts()).length === 1, 'first native prompt')
  const first = await until(async () => {
    const run = (await snapshot()).agentRuns.find(run => run.status === 'running')
    return run && database.prepare("SELECT 1 FROM agent_run_execution_evidence WHERE agent_run_id=? AND event_type='agent.text.block'").get(run.id)
      ? run : null
  }, 'running source with recorded output but no completion')
  const native = (await prompts())[0]
  process.kill(native.pid, 0)
  const delivery = database.prepare('SELECT status,accepted_at FROM runtime_input_delivery WHERE agent_run_id=?').get(first.id)
  assert.equal(delivery.accepted_at, null, 'missing completion has not been accepted')
  if (shutdownText) {
    const streamed = await until(async () => (await snapshot()).executionEvidence.find(item =>
      item.agentRunId === first.id && item.eventType === 'agent.text.block'
      && item.payload.status === 'streaming' && item.payload.text === expectedText), 'complete unfinished text in memory/spool')
    const placeholder = JSON.parse(database.prepare('SELECT payload_preview_json FROM agent_run_execution_evidence WHERE id=?').get(streamed.id).payload_preview_json)
    assert.equal(placeholder.text, '', 'the body has not already been finalized')
    const started = Date.now()
    const report = await core.request('core.shutdown', { protocolVersion: 3, deadlineMs: 10_000 })
    assert.equal(report.status, 'completed')
    assert.equal(report.deadlineExpired, false)
    const [exitCode, signal] = await core.exited()
    assert.equal(exitCode, 0)
    assert.equal(signal, null, 'Core exits without a test kill signal')
    const elapsedMs = Date.now() - started
    assert.ok(elapsedMs < 10_000, `Shutdown exceeded hard deadline: ${elapsedMs}ms`)
    assert.throws(() => process.kill(native.pid, 0), { code: 'ESRCH' })
    core = startCore()
    await core.request('health.check')
    const reopened = await snapshot()
    assert.equal(reopened.agentRuns.find(run => run.id === first.id).status, 'cancelled')
    const content = await core.request('agentRunEvidence.getContent', { threadId, evidenceId: streamed.id })
    assert.equal(content.payload.text, expectedText)
    assert.equal(content.payload.status, 'interrupted')
    assert.equal((await prompts()).length, 1, 'reopening does not replay the cancelled input')
    console.log(JSON.stringify({ passed: true, scenario: 'shutdown-text', elapsedMs,
      bytes: Buffer.byteLength(expectedText), appRestarted: true, databaseModifiedByTest: false }))
  } else {
    const stopped = await core.request('agentRuns.cancel', {
      commandId: crypto.randomUUID(), command: { threadId, agentRunId: first.id, expectedVersion: first.version }
    })
    assert.equal(stopped.status, 'applied')
    await until(() => database.prepare('SELECT cancel_acknowledged_at FROM agent_run WHERE id=?').get(first.id)?.cancel_acknowledged_at,
      'owned process cleanup acknowledgment')
    assert.throws(() => process.kill(native.pid, 0), { code: 'ESRCH' }, 'the old process was stopped')
    assert.equal((await prompts()).length, 1, 'stopping does not replay input')
    const oldState = database.prepare('SELECT * FROM agent_run WHERE id=?').get(first.id)
    assert.equal(oldState.status, 'cancelled')
    const oldDelivery = database.prepare('SELECT * FROM runtime_input_delivery WHERE agent_run_id=?').get(first.id)
    assert.equal(oldDelivery.status, 'delivery_unknown')
    const continued = await core.request('agentRuns.continue', {
      commandId: crypto.randomUUID(), command: { threadId, agentRunId: first.id }
    })
    assert.equal(continued.status, 'applied')
    const second = await until(async () => (await snapshot()).agentRuns.find(run => run.id !== first.id && run.status === 'succeeded'),
      'new successful run after user continuation')
    assert.equal((await prompts()).length, 2, 'one user continuation creates exactly one attempt')
    assert.deepEqual(database.prepare('SELECT * FROM agent_run WHERE id=?').get(first.id), oldState, 'source Run stays terminal and unchanged')
    assert.deepEqual(database.prepare('SELECT * FROM runtime_input_delivery WHERE agent_run_id=?').get(first.id), oldDelivery,
      'continuation preserves the unknown result of the source input')
    assert.equal(database.prepare('SELECT status FROM runtime_input_delivery WHERE agent_run_id=?').get(second.id).status, 'accepted')
    console.log(JSON.stringify({ passed: true, sourceStatus: oldState.status, successorStatus: second.status,
      cleanupAcknowledged: true, appRestarted: false, databaseModifiedByTest: false }))
  }
} catch (error) {
  console.error(core?.stderr().slice(-12_000))
  throw error
} finally {
  database?.close()
  await core?.stop()
  await removeEphemeralRuntimeCampFilesRoot(data, { homeDirectory: home })
  await rm(fixture, { recursive: true, force: true })
}

async function until(read, description) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timeout waiting for ${description}`)
}

function startCore() {
  const child = spawn(join(root, 'target/debug/rovai-core'), [
    ...coreDataDirectoryArguments(data, { homeDirectory: home }),
    '--skill-library-root', join(data, 'managed-skill-library'), '--mcp-config-path', join(data, 'mcp.json')
  ], { cwd: fixture, stdio: ['pipe', 'pipe', 'pipe'], env: {
    HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh', TMPDIR: fixture, ROVAI_COPILOT_BIN: executable
  } })
  const closed = once(child, 'close'), pending = new Map()
  let nextId = 0, stderr = ''
  child.stderr.on('data', value => { stderr += value })
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line), entry = pending.get(message.id)
    if (!entry) return
    clearTimeout(entry.timer); pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  child.on('close', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`Core exited: ${stderr}`)) }
    pending.clear()
  })
  return {
    stderr: () => stderr,
    async exited() {
      let timer
      try {
        return await Promise.race([closed, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Core failed to exit normally')), 10_000)
        })])
      } finally { clearTimeout(timer) }
    },
    request(method, params = {}) {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)) }, 30_000)
        pending.set(id, { resolve, reject, timer })
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      })
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGTERM'), 3000)
      try { await closed } finally { clearTimeout(timer) }
    }
  }
}

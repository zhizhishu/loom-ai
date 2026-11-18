// Real rovai CLI process -> synthetic local IPC -> actual managed Pi bridge. No Core/model/provider.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { FILE_GRANT_SCHEMA, REQUEST_ID_ENV, planInvocation, runInvocation, workflowContracts } from '../../crates/rovai-core/src/pi/managed-workflow-tool.ts'

const enabled = Boolean(process.env.LOOM_MANAGED_WORKFLOW_CLI)
test('real CLI preserves projected receipts for the native bridge and ordinary CLI projection', {
  skip: enabled ? false : 'explicit current CLI path required', timeout: 45_000
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'loom-cli-ipc-'))
  const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\rovai-ai-' + process.pid + '-' + randomUUID() : join(root, 'core.sock')
  const endpoint = process.platform === 'win32' ? { transport: 'windows_named_pipe', name: pipe } : { transport: 'unix_socket', path: pipe }
  const contextPath = join(root, 'context.json')
  await writeFile(contextPath, JSON.stringify({ contractVersion: 45, ipcProtocolVersion: 3,
    coreEndpoint: endpoint, processId: 'synthetic-process', processToken: 'synthetic-token', tasksEnabled: true,
    lease: { executionRoot: root, runTmp: root, leaseId: 'synthetic-lease', leaseGeneration: 1, leaseToken: 'synthetic-lease-token' }
  }), { mode: 0o600 })
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
  Object.assign(env, { ROVAI_CLI_CONTEXT: contextPath, TEMP: root, TMP: root, APPDATA: root, LOCALAPPDATA: root, XDG_DATA_HOME: root })
  const contracts = workflowContracts(JSON.parse(await readFile(new URL('../fixtures/pi-workflow/core-input-contract.json', import.meta.url), 'utf8')))
  const grant = { schema: FILE_GRANT_SCHEMA, runId: 'synthetic-run', botId: 'synthetic-bot', executionEpoch: 1,
    workspaceReal: root, allowedTools: ['read', 'write', 'edit', 'rovai_loom'], expiresAtEpochMs: Date.now() + 60_000, logPath: join(root, 'guard.jsonl') }
  const business = { missionId: 'synthetic-mission', plan: null, tasks: [], dependencies: [], claims: [], evaluatedAt: '2026-11-18T00:00:00Z' }
  let replyMode = 'ok'
  const requests = [], sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      if (!buffer.includes('\n')) return
      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')))
      requests.push(request)
      const envelope = { contractVersion: 2, ok: true, operation: request.operation, requestId: request.request_id, result: business }
      if (replyMode === 'wrong-id') envelope.requestId = randomUUID()
      if (replyMode === 'wrong-operation') envelope.operation = 'loom.status'
      if (replyMode === 'malformed') envelope.result = {}
      if (replyMode === 'rejected' || replyMode === 'unknown') {
        delete envelope.result; envelope.ok = false
        envelope.error = replyMode === 'unknown'
          ? { code: 'builtin_tool.outcome_indeterminate', message: 'synthetic-private-diagnostic', recovery: 'confirm_outcome', details: { requestId: 'synthetic-private-identity' } }
          : { code: 'loom.plan_exists', message: 'A plan already exists', recovery: 'stop' }
      }
      socket.end(JSON.stringify({ kind: 'envelope', envelope }) + '\n')
    })
  })
  server.listen(pipe); await once(server, 'listening')
  let serial = 0
  async function bridge(binary, params = { operation: 'loom.status', input: {} }) {
    const planned = planInvocation({ toolCallId: 'actual-cli-' + (++serial), params, contracts, grant,
      binding: { agentRunId: grant.runId, executionEpoch: 1 }, nowMs: Date.now(), cliPath: resolve(binary), baseEnv: env })
    assert.equal(planned.ok, true)
    const before = requests.length
    const result = await runInvocation({ spawn, plan: planned.plan, timeoutMs: 5_000 })
    assert.equal(requests.length, before + 1, 'one real child must dispatch exactly once')
    assert.equal(requests.at(-1).request_id, planned.plan.requestId)
    assert.equal(requests.at(-1).operation, params.operation)
    assert.deepEqual(requests.at(-1).input, params.input)
    return result
  }
  try {
    if (process.env.LOOM_MANAGED_WORKFLOW_BASELINE_CLI) {
      const baseline = await bridge(process.env.LOOM_MANAGED_WORKFLOW_BASELINE_CLI)
      assert.equal(baseline.isError, true)
      assert.equal(baseline.code, 'builtin_tool.invalid_output', 'the unchanged old CLI must reproduce the actual failure')
      assert.match(baseline.text, /\(exit 0\)/u, 'the old CLI accepted the business result but removed its machine metadata')
      t.diagnostic('unchanged local baseline reproduced invalid_output after an accepted business result and exit 0')
    }
    const current = await bridge(process.env.LOOM_MANAGED_WORKFLOW_CLI)
    assert.equal(current.isError, false)
    assert.deepEqual(JSON.parse(current.text), business)
    const ordinary = await new Promise((resolveResult, reject) => {
      const child = spawn(process.env.LOOM_MANAGED_WORKFLOW_CLI, ['loom', 'status'], { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      child.stdout.setEncoding('utf8'); child.stdout.on('data', text => { stdout += text })
      child.stderr.resume(); child.on('error', reject); child.on('close', code => resolveResult({ code, stdout }))
      child.stdin.end('{}')
    })
    assert.equal(ordinary.code, 0)
    assert.deepEqual(JSON.parse(ordinary.stdout), business, 'ordinary CLI must still omit machine metadata')
    assert.equal(Object.hasOwn(env, REQUEST_ID_ENV), false)
    replyMode = 'wrong-id'
    assert.equal((await bridge(process.env.LOOM_MANAGED_WORKFLOW_CLI)).code, 'loom_request_id_mismatch')
    replyMode = 'wrong-operation'
    assert.equal((await bridge(process.env.LOOM_MANAGED_WORKFLOW_CLI, { operation: 'loom.inspect', input: { taskId: 'task-1' } })).code, 'loom_operation_mismatch')
    replyMode = 'malformed'
    assert.equal((await bridge(process.env.LOOM_MANAGED_WORKFLOW_CLI)).code, 'builtin_tool.invalid_output', 'invalid business output must not receive a matching successful receipt')
    replyMode = 'rejected'
    const rejected = await bridge(process.env.LOOM_MANAGED_WORKFLOW_CLI, { operation: 'loom.plan', input: { goal: 'Synthetic plan', criteria: [{ criterionId: 'one', text: 'One file' }], tasks: [{ taskId: 'task-1', title: 'Write file' }] } })
    assert.equal(rejected.isError, true); assert.equal(rejected.code, 'loom.plan_exists'); assert.equal(rejected.indeterminate, false)
    replyMode = 'unknown'
    const unknown = await bridge(process.env.LOOM_MANAGED_WORKFLOW_CLI)
    assert.equal(unknown.code, 'builtin_tool.outcome_indeterminate'); assert.equal(unknown.indeterminate, true)
    assert.equal(unknown.text.includes('synthetic-private'), false, 'existing error projection must still remove internal diagnostics')
    assert.equal(requests.length, process.env.LOOM_MANAGED_WORKFLOW_BASELINE_CLI ? 8 : 7)
    t.diagnostic('new success, ordinary projection, identity mismatch, output-schema rejection and sanitized unknown outcome passed through 7 real CLI processes')
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(done => server.close(done))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

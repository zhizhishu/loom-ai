// LOOM V2 — managed `rovai_loom` workflow bridge contract (pure helper + injected child runtime).
//
// Run (Root, from loom/): node --test --test-force-exit --test-timeout=120000 scripts/loom-v2-workflow-tool.test.mjs
//
// What this proves (no network, no model, no real CLI process, no user data):
//   1  the operation table is exactly the ten LOOM business operations, and argv is two fixed words
//      taken from that table — never model text, never a shell, never `--input-file`;
//   2  the tool parameters are closed: `operation` plus an `input` object whose keys follow the existing
//      Core schemas; Run/bot/Mission/creator/command identity is refused before any child starts;
//   3  a call only plans when the live grant is bound to this Run, still grants the tool, and has not
//      expired — an old policy, a re-bound Host or an expired grant refuses;
//   4  the request id is deterministic over (Run, epoch, operation, toolCallId) and is set as a
//      per-child environment value, so two concurrent calls cannot cross request ids;
//   5  the trusted CLI path is absolute, regular and non-script; relative and `.cmd` paths are refused
//      with no PATH fallback;
//   6  a child that times out, dies, or answers unreadably is reported as indeterminate — never retried
//      with a fresh id and never turned into a fabricated success.
//
// The Rust side asserts the same name/operation set from the embedded sources
// (`crates/rovai-core/src/pi.rs`, `mod managed_workflow_source_tests`).

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import managedHost from '../crates/rovai-core/src/pi/managed-host.ts'

import {
  CLI_ENV,
  ENVELOPE_VERSION,
  EXIT_CODES,
  FILE_GRANT_SCHEMA,
  LOOM_INPUT_KEYS,
  LOOM_OPERATIONS,
  LOOM_OPERATION_ARGV,
  LOOM_TOOL_NAME,
  MAX_STDIN_BYTES,
  REQUEST_ID_ENV,
  deriveRequestId,
  evidencePathProblem,
  loomToolDescription,
  loomToolParameters as nativeToolParameters,
  parseEnvelope,
  planInvocation,
  piToolResult,
  readWorkflowContracts,
  resolveTrustedCli,
  runInvocation,
  validateLoomParams as validateNativeParams,
  workflowContracts,
} from '../crates/rovai-core/src/pi/managed-workflow-tool.ts'

const CORE_CONTRACT = JSON.parse(readFileSync(new URL('./fixtures/pi-workflow/core-input-contract.json', import.meta.url), 'utf8'))
const CONTRACTS = workflowContracts(CORE_CONTRACT)
const validateLoomParams = params => validateNativeParams(params, CONTRACTS)
const loomToolParameters = () => nativeToolParameters(CONTRACTS)

test('Core input contracts replace guessed fields and reject incomplete operations before dispatch', async () => {
  const fields = loomToolParameters().properties.input
  assert.equal(fields.additionalProperties, false)
  assert.deepEqual(fields.properties.relativePath, CONTRACTS['loom.evidence'].properties.relativePath)
  assert.deepEqual(fields.properties.tasks.items.required, ['taskId', 'title'])
  for (const operation of LOOM_OPERATION_NAMES.filter(name => name !== 'loom.status')) {
    assert.equal(validateLoomParams({ operation, input: {} }).ok, false, operation + ' empty input')
  }
  for (const key of ['path', 'files', 'filePath', 'paths', 'file']) {
    assert.equal(fields.properties[key], undefined)
    assert.equal(validateLoomParams({ operation: 'loom.evidence', input: { [key]: 'result.md' } }).code, 'loom_input_not_allowed:' + key)
  }
  const help = loomToolDescription(CONTRACTS)
  for (const line of help.split('\n').filter(line => line.includes('. Example: '))) {
    const example = JSON.parse(line.split('. Example: ')[1])
    assert.equal(validateLoomParams(example).ok, true, example.operation)
  }
  assert.match(help, /loom.plan: required input fields: goal, criteria, tasks/u)
  assert.match(help, /loom.evidence: required input fields: relativePath/u)
  assert.match(help, /Claim a released task before writing/u)
  const fixturePath = new URL('./fixtures/pi-workflow/core-input-contract.json', import.meta.url)
  assert.deepEqual(readWorkflowContracts(fileURLToPath(fixturePath)), CONTRACTS)
  const changed = structuredClone(CORE_CONTRACT)
  changed.operations[0].inputSchema.properties.missionId = { type: 'string' }
  assert.throws(() => workflowContracts(changed), /loom_contract_keys_changed/u)
  assert.throws(() => workflowContracts({ schemaVersion: 1, operations: [] }), /loom_contract_invalid/u)
  // Exercise the actual extension load path, including the adjacent Core schema file. No child
  // can start: the only invocation deliberately lacks the required plan input.
  const current = fixture()
  const previous = Object.fromEntries(['ROVAI_PI_HOST_BINDING_FILE', 'ROVAI_PI_FILE_GRANT_FILE', CLI_ENV]
    .map(key => [key, process.env[key]]))
  const bootstrap = 'synthetic managed extension binding'
  const bindingFile = join(current.root, 'binding.json')
  const grantFile = join(current.root, 'grant.json')
  writeFileSync(bindingFile, JSON.stringify({
    schemaVersion: 3, extensionVersion: 'rovai-pi-host-v12', hostInstanceId: 'fixture-host',
    hostBindingGeneration: 1, agentRunId: current.grant.runId, executionEpoch: current.grant.executionEpoch,
    nativeBindingId: 'fixture-binding', nativeBindingGeneration: 1, expectedNativeSessionId: null,
    bootstrap, bootstrapPayloadDigest: createHash('sha256').update(bootstrap).digest('hex')
  }), { mode: 0o600 })
  writeFileSync(grantFile, JSON.stringify(current.grant))
  writeFileSync(join(current.root, 'loom-workflow-contract.json'), JSON.stringify(CORE_CONTRACT))
  try {
    process.env.ROVAI_PI_HOST_BINDING_FILE = bindingFile
    process.env.ROVAI_PI_FILE_GRANT_FILE = grantFile
    process.env[CLI_ENV] = current.cliPath
    const registered = []
    managedHost({ registerTool: definition => registered.push(definition), on() {} })
    assert.equal(registered.length, 1)
    assert.equal(registered[0].name, LOOM_TOOL_NAME)
    assert.deepEqual(registered[0].parameters, loomToolParameters())
    assert.equal(registered[0].description, help)
    await assert.rejects(() => registered[0].execute('empty-plan', { operation: 'loom.plan', input: {} }), /loom_input_required:goal,criteria,tasks/u)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(current.root, { recursive: true, force: true })
  }
})

test('plan release claim write evidence submit retain exact JSON fields and native failure semantics', async () => {
  const current = fixture()
  const calls = [
    { operation: 'loom.plan', input: { goal: 'Write one file', criteria: [{ criterionId: 'file', text: 'Real registered file' }], tasks: [{ taskId: 't1', title: 'Write file', assigneeAgentId: 'bot-workflow' }] } },
    { operation: 'loom.release', input: { taskId: 't1' } },
    { operation: 'loom.claim', input: { taskId: 't1' } },
    { operation: 'loom.evidence', input: { relativePath: 'result.md', taskId: 't1' } },
    { operation: 'loom.submit', input: { taskId: 't1', evidenceIds: ['artifact-1'] } },
  ]
  let claimed = false
  try {
    for (const [index, params] of calls.entries()) {
      if (params.operation === 'loom.evidence') {
        assert.equal(claimed, true)
        writeFileSync(join(current.root, 'result.md'), '# Actual fixture file\n')
      }
      const planned = plan(current, params, { toolCallId: 'sequence-' + index })
      assert.equal(planned.ok, true)
      const fake = fakeSpawn()
      fake.onEnd((record, emit) => {
        assert.deepEqual(JSON.parse(record.stdin), params.input)
        const result = params.operation === 'loom.evidence' ? { artifact: { artifactId: 'artifact-1' } }
          : params.operation === 'loom.submit' ? { candidateId: 'candidate-1', acceptanceStatus: 'pending' } : { taskId: 't1' }
        emit('stdout', JSON.stringify({ contractVersion: ENVELOPE_VERSION, ok: true, operation: params.operation, requestId: planned.plan.requestId, result }))
        emit('close', 0)
      })
      const native = piToolResult(await runInvocation({ spawn: fake.spawn, plan: planned.plan, timeoutMs: 1000 }))
      assert.equal(fake.calls.length, 1)
      assert.ok(native.content[0].text)
      if (params.operation === 'loom.claim') claimed = true
      if (params.operation === 'loom.submit') assert.equal(JSON.parse(native.content[0].text).acceptanceStatus, 'pending')
    }
    for (const indeterminate of [false, true]) {
      assert.throws(() => piToolResult({ isError: true, code: 'loom.claim_absent', text: 'No current claim', indeterminate }), error => {
        assert.equal(error.code, 'loom.claim_absent'); assert.equal(error.indeterminate, indeterminate)
        if (indeterminate) assert.match(error.message, /do not replay/u)
        return true
      })
    }
  } finally { await rm(current.root, { recursive: true, force: true }) }
})

test('Pi 0.85 SDK distinguishes a returned error flag from a thrown Core rejection', {
  skip: process.env.LOOM_PI_AGENT_LOOP_MODULE ? false : 'explicit installed Pi SDK module path required'
}, async () => {
  const { runAgentLoop } = await import(pathToFileURL(process.env.LOOM_PI_AGENT_LOOP_MODULE).href)
  const run = async (params, execute) => {
    const assistant = { role: 'assistant', content: [{ type: 'toolCall', id: 'offline-call', name: LOOM_TOOL_NAME, arguments: params }], stopReason: 'toolUse', timestamp: 1 }
    const response = { async *[Symbol.asyncIterator]() { yield { type: 'done', message: assistant } }, async result() { return assistant } }
    let providerCalls = 0
    const messages = await runAgentLoop([{ role: 'user', content: 'synthetic offline tool protocol regression', timestamp: 0 }],
      { systemPrompt: '', messages: [], tools: [{ name: LOOM_TOOL_NAME, label: 'LOOM', description: loomToolDescription(CONTRACTS), parameters: loomToolParameters(), execute }] },
      { model: { provider: 'offline', id: 'offline', api: 'openai-completions' }, convertToLlm: messages => messages, shouldStopAfterTurn: () => true },
      () => {}, undefined, () => { providerCalls += 1; return response })
    assert.equal(providerCalls, 1)
    return messages.find(message => message.role === 'toolResult')
  }
  const rejection = { isError: true, code: 'loom.claim_absent', text: 'No current claim', indeterminate: false }
  const valid = { operation: 'loom.status', input: {} }
  const previous = await run(valid, async () => ({ content: [{ type: 'text', text: 'No current claim' }], isError: true }))
  assert.equal(previous.isError, false, 'reproduce the old fulfilled-handler false success')
  const fixed = await run(valid, async () => piToolResult(rejection))
  assert.equal(fixed.isError, true)
  assert.match(fixed.content[0].text, /loom.claim_absent/u)
  let dispatched = 0
  const badPath = await run({ operation: 'loom.evidence', input: { path: 'result.md' } }, async () => { dispatched += 1 })
  assert.equal(badPath.isError, true); assert.equal(dispatched, 0)
  const emptyPlan = await run({ operation: 'loom.plan', input: {} }, async (_id, params) => {
    const checked = validateLoomParams(params)
    if (!checked.ok) throw new Error(checked.code)
    dispatched += 1
  })
  assert.equal(emptyPlan.isError, true); assert.equal(dispatched, 0)
  assert.match(emptyPlan.content[0].text, /loom_input_required:goal,criteria,tasks/u)
})

const LOOM_OPERATION_NAMES = [
  'loom.status',
  'loom.skill_suggest',
  'loom.plan',
  'loom.release',
  'loom.claim',
  'loom.claim_heartbeat',
  'loom.evidence',
  'loom.submit',
  'loom.inspect',
  'loom.stage-review',
]

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** A grant document in the exact Core shape, plus a temp trusted CLI file. */
function fixture(options = {}) {
  const root = freshDir('loom-workflow-')
  const cliPath = join(root, 'rovai.exe')
  writeFileSync(cliPath, 'fixture cli\n', 'utf8')
  const grant = {
    schema: FILE_GRANT_SCHEMA,
    runId: options.runId ?? 'run-workflow-1',
    botId: 'bot-workflow',
    executionEpoch: options.executionEpoch ?? 4,
    workspaceReal: root,
    allowedTools: options.allowedTools ?? ['read', 'write', 'edit', LOOM_TOOL_NAME],
    expiresAtEpochMs: options.expiresAtEpochMs ?? Date.now() + 600_000,
    logPath: join(root, 'guard.jsonl'),
    // P0 step 2: the same claim triple Core now writes into every grant. A workspace_workflow Run is
    // bound to a LOOM Task, so the fixture carries a live claim instead of the empty unbound triple.
    claimId: options.claimId ?? 'claim-workflow-1',
    fenceGeneration: options.fenceGeneration ?? 1,
    leaseExpiresAtEpochMs: options.leaseExpiresAtEpochMs ?? Date.now() + 600_000,
    // P0 step 3: the same document also states the claim is REQUIRED, which is what makes every
    // `write`/`edit` of a LOOM-bound Run depend on that claim staying live.
    requiresClaim: options.requiresClaim ?? true,
  }
  return { root, cliPath, grant, binding: { agentRunId: grant.runId, executionEpoch: grant.executionEpoch } }
}

function plan(fixtureValue, params, overrides = {}) {
  return planInvocation({
    toolCallId: overrides.toolCallId ?? 'call-1',
    params,
    contracts: CONTRACTS,
    grant: Object.hasOwn(overrides, 'grant') ? overrides.grant : fixtureValue.grant,
    binding: overrides.binding ?? fixtureValue.binding,
    nowMs: overrides.nowMs ?? Date.now(),
    cliPath: overrides.cliPath ?? fixtureValue.cliPath,
    baseEnv: overrides.baseEnv ?? { PATH: '/usr/bin', [CLI_ENV]: fixtureValue.cliPath },
  })
}

/** A fake spawn that answers with the registered responder. Records every invocation it received. */
function fakeSpawn(options = {}) {
  const calls = []
  const killEmitsClose = options.killEmitsClose !== false
  let responder = null
  const spawn = (command, args, spawnOptions) => {
    const record = { command, args: [...args], options: spawnOptions, stdin: '', stdinClosed: false, killed: false }
    calls.push(record)
    const handlers = new Map()
    const emit = (event, payload) => {
      const handler = handlers.get(event)
      if (handler) handler(payload)
    }
    const child = {
      stdin: {
        write(chunk) {
          record.stdin += chunk
        },
        end() {
          record.stdinClosed = true
          if (responder) setImmediate(() => responder(record, emit))
        },
        on() {},
      },
      stdout: { on(_event, handler) { handlers.set('stdout', handler) } },
      stderr: { on(_event, handler) { handlers.set('stderr', handler) } },
      on(event, handler) { handlers.set(event, handler) },
      kill() {
        record.killed = true
        if (killEmitsClose) emit('close', 137)
      },
    }
    return child
  }
  return { spawn, calls, onEnd(fn) { responder = fn } }
}

// ---------------------------------------------------------------------------
// 1 · operation table and argv
// ---------------------------------------------------------------------------

test('1 · the tool reaches exactly the ten LOOM operations through fixed argv words', () => {
  assert.equal(LOOM_TOOL_NAME, 'rovai_loom')
  assert.deepEqual([...LOOM_OPERATIONS], LOOM_OPERATION_NAMES)
  assert.equal(new Set(LOOM_OPERATIONS).size, LOOM_OPERATION_NAMES.length, 'no duplicate operations')
  for (const operation of LOOM_OPERATION_NAMES) {
    const argv = LOOM_OPERATION_ARGV[operation]
    assert.ok(Array.isArray(argv), `${operation} must map to argv`)
    assert.equal(argv.length, 2, `${operation} argv is exactly two words`)
    assert.equal(argv[0], 'loom')
    // The fixed CLI word is the operation suffix with underscores hyphenated (`claim_heartbeat`
    // reaches `rovai loom claim-heartbeat`), so the assertion still pins the exact word.
    assert.equal(argv[1], operation.slice('loom.'.length).replace(/_/gu, '-'))
    assert.ok(LOOM_INPUT_KEYS[operation], `${operation} must declare its closed input keys`)
  }
  // Anything outside the ten has no argv and no input keys.
  for (const operation of ['loom.workspace.list', 'loom.workspace.run', 'bash', 'thread.message.send', '']) {
    assert.equal(LOOM_OPERATION_ARGV[operation], undefined)
    assert.equal(LOOM_INPUT_KEYS[operation], undefined)
  }
  // The provider-facing schema offers exactly the closed enum.
  const schema = loomToolParameters()
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ['operation', 'input'])
  assert.deepEqual([...schema.properties.operation.enum], LOOM_OPERATION_NAMES)
  assert.deepEqual(Object.keys(schema.properties).sort(), ['input', 'operation'])
})

// ---------------------------------------------------------------------------
// 2 · parameters are closed
// ---------------------------------------------------------------------------

test('2 · parameters accept only a known operation and its existing input keys', () => {
  assert.equal(validateLoomParams({ operation: 'loom.status' }).ok, true)
  assert.equal(validateLoomParams({ operation: 'loom.status', input: {} }).ok, true)
  assert.equal(validateLoomParams({ operation: 'loom.claim', input: { taskId: 't1' } }).ok, true)
  assert.equal(validateLoomParams({ operation: 'loom.evidence', input: { relativePath: 'out/report.md' } }).ok, true)

  const refused = [
    null,
    'loom.status',
    [],
    {},
    { operation: 'loom.accept' },
    { operation: 'bash' },
    { operation: 'loom.status', command: 'ls' },
    { operation: 'loom.status', input: [] },
    { operation: 'loom.claim', input: { taskId: 't1', leaseSeconds: 60, shell: 'ls' } },
  ]
  for (const params of refused) {
    assert.equal(validateLoomParams(params).ok, false, `${JSON.stringify(params)} must be refused`)
  }

  // Identity can never be claimed from the payload.
  for (const key of [
    'agentRunId', 'runId', 'botId', 'missionId', 'campId', 'creatorId',
    'commandId', 'requestId', 'executionEpoch', 'reviewerAgentId',
  ]) {
    const outcome = validateLoomParams({ operation: 'loom.submit', input: { taskId: 't1', evidenceIds: [], [key]: 'forged' } })
    assert.equal(outcome.ok, false, `${key} must be refused`)
    assert.match(outcome.code, /loom_identity_not_allowed/)
  }
  // The lease identity is the one pair a caller may name, and only to `loom.claim_heartbeat`: every
  // other operation's closed key set still refuses it, so it can never become a second authority.
  for (const key of ['claimId', 'fenceGeneration']) {
    const outcome = validateLoomParams({ operation: 'loom.submit', input: { taskId: 't1', evidenceIds: [], [key]: 'forged' } })
    assert.equal(outcome.ok, false, `${key} must be refused outside a heartbeat`)
    assert.match(outcome.code, /loom_input_not_allowed/)
  }
  assert.equal(
    validateLoomParams({ operation: 'loom.claim_heartbeat', input: { claimId: 'claim-1', fenceGeneration: 1 } }).ok,
    true,
    'a heartbeat names the claim it renews'
  )
  // A field that is legal for another operation is still refused here.
  assert.match(
    validateLoomParams({ operation: 'loom.release', input: { evidenceIds: [] } }).code,
    /loom_input_not_allowed/
  )
})

test('2b · evidence paths are pre-checked before any child is started', () => {
  assert.equal(evidencePathProblem('out/report.md'), null)
  assert.equal(evidencePathProblem('report.md'), null)
  const cases = [
    ['', /path_missing/],
    ['../outside/report.md', /path_parent_escape/],
    ['/etc/passwd', /path_not_relative/],
    ['C:\\Windows\\win.ini', /path_not_relative/],
    ['\\\\server\\share\\x.md', /path_not_relative/],
    ['a.txt:stream', /path_alternate_data_stream/],
    ['trailing.md ', /path_trailing_dot_or_space/],
    ['CON', /path_reserved_device_name/],
    [`nul${String.fromCharCode(0)}byte.md`, /path_nul_byte/],
  ]
  for (const [value, pattern] of cases) {
    assert.match(String(evidencePathProblem(value)), pattern, `${value} must be refused`)
  }
  // And the refusal surfaces through the parameter gate, not only through the helper.
  for (const [relativePath, pattern] of [['../x.md', /loom_evidence_path_parent_escape/], ['/abs.md', /loom_evidence_path_not_relative/]]) {
    const outcome = validateLoomParams({ operation: 'loom.evidence', input: { relativePath } })
    assert.equal(outcome.ok, false)
    assert.match(outcome.code, pattern)
  }
})

// ---------------------------------------------------------------------------
// 3 · the grant, not the payload, authorizes the call
// ---------------------------------------------------------------------------

test('3 · a call plans only for a grant bound to this Run that still carries the tool', async () => {
  const current = fixture()
  try {
    const planned = plan(current, { operation: 'loom.status' })
    assert.equal(planned.ok, true)
    assert.equal(planned.plan.operation, 'loom.status')
    assert.deepEqual([...planned.plan.argv], ['loom', 'status'])
    assert.equal(planned.plan.stdin, '{}', 'parameters travel on stdin as one JSON object')

    const expired = plan(current, { operation: 'loom.status' }, { nowMs: current.grant.expiresAtEpochMs })
    assert.equal(expired.ok, false)
    assert.equal(expired.code, 'loom_grant_expired')

    const otherRun = plan(current, { operation: 'loom.status' }, {
      grant: { ...current.grant, runId: 'run-other' },
    })
    assert.equal(otherRun.ok, false)
    assert.equal(otherRun.code, 'loom_grant_binding_mismatch')

    const otherEpoch = plan(current, { operation: 'loom.status' }, {
      grant: { ...current.grant, executionEpoch: current.grant.executionEpoch + 1 },
    })
    assert.equal(otherEpoch.ok, false)
    assert.equal(otherEpoch.code, 'loom_grant_binding_mismatch')

    // The legacy policies never carry the tool, so the call refuses even if the name is guessed.
    for (const allowedTools of [['read'], ['read', 'write', 'edit']]) {
      const legacy = plan(current, { operation: 'loom.status' }, {
        grant: { ...current.grant, allowedTools },
      })
      assert.equal(legacy.ok, false)
      assert.equal(legacy.code, 'loom_tool_not_granted')
    }
    // No grant at all (legacy native policy) refuses too.
    assert.equal(plan(current, { operation: 'loom.status' }, { grant: null }).code, 'loom_grant_missing')

    // A tool call id is mandatory: without one there is no stable request identity.
    assert.equal(plan(current, { operation: 'loom.status' }, { toolCallId: '' }).code, 'loom_tool_call_id_missing')
    assert.equal(plan(current, { operation: 'loom.status' }, { toolCallId: 7 }).code, 'loom_tool_call_id_missing')
  } finally {
    await rm(current.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4 · stable, per-child request identity
// ---------------------------------------------------------------------------

test('4 · the request id is stable per call and never shared between concurrent children', async () => {
  const current = fixture()
  try {
    const a = plan(current, { operation: 'loom.evidence', input: { relativePath: 'out/report.md' } }, { toolCallId: 'call-a' })
    const aAgain = plan(current, { operation: 'loom.evidence', input: { relativePath: 'out/report.md' } }, { toolCallId: 'call-a' })
    const b = plan(current, { operation: 'loom.evidence', input: { relativePath: 'out/report.md' } }, { toolCallId: 'call-b' })
    assert.equal(a.plan.requestId, aAgain.plan.requestId, 'a retried call must reuse its request id')
    assert.notEqual(a.plan.requestId, b.plan.requestId, 'two calls must not share an id')
    assert.match(a.plan.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.equal(a.plan.env[REQUEST_ID_ENV], a.plan.requestId)
    // The id is bound to the authenticated Run and to the operation, not to the payload.
    assert.notEqual(
      deriveRequestId({ runId: 'run-1', executionEpoch: 1, operation: 'loom.status', toolCallId: 'x' }),
      deriveRequestId({ runId: 'run-2', executionEpoch: 1, operation: 'loom.status', toolCallId: 'x' })
    )
    assert.notEqual(
      deriveRequestId({ runId: 'run-1', executionEpoch: 1, operation: 'loom.status', toolCallId: 'x' }),
      deriveRequestId({ runId: 'run-1', executionEpoch: 1, operation: 'loom.claim', toolCallId: 'x' })
    )
    // `process.env` is never touched, so a concurrent call cannot observe or mutate the other's id.
    assert.equal(process.env[REQUEST_ID_ENV], undefined)

    const fake = fakeSpawn()
    const results = await Promise.all([
      runInvocation({ spawn: fake.spawn, plan: a.plan, timeoutMs: 200 }),
      runInvocation({ spawn: fake.spawn, plan: b.plan, timeoutMs: 200 }),
    ])
    assert.equal(fake.calls.length, 2)
    const envs = fake.calls.map((call) => call.options.env[REQUEST_ID_ENV])
    assert.equal(envs[0], a.plan.requestId)
    assert.equal(envs[1], b.plan.requestId)
    assert.notEqual(envs[0], envs[1])
    for (const call of fake.calls) {
      assert.equal(call.options.shell, false, 'no shell, ever')
      assert.deepEqual(call.args, ['loom', 'evidence'])
      assert.equal(JSON.parse(call.stdin).relativePath, 'out/report.md')
      assert.equal(call.stdinClosed, true)
    }
    // The fake children never answered: an unreadable outcome is indeterminate, not a success.
    for (const result of results) {
      assert.equal(result.isError, true)
      assert.equal(result.indeterminate, true)
    }
  } finally {
    await rm(current.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5 · trusted executable
// ---------------------------------------------------------------------------

test('5 · the CLI path must be an absolute non-script regular file with no fallback', async () => {
  const current = fixture()
  try {
    assert.equal(resolveTrustedCli(current.cliPath).ok, true)
    assert.equal(resolveTrustedCli(undefined).code, 'loom_cli_missing')
    assert.equal(resolveTrustedCli('').code, 'loom_cli_missing')
    assert.equal(resolveTrustedCli('rovai.exe').code, 'loom_cli_not_absolute')
    assert.equal(resolveTrustedCli(join(current.root, 'missing.exe')).code, 'loom_cli_missing')
    // No PATH search: a bare name is never resolved to an executable.
    assert.equal(plan(current, { operation: 'loom.status' }, { cliPath: 'rovai' }).ok, false)
    // A directory is not an executable.
    assert.equal(resolveTrustedCli(current.root).code, 'loom_cli_not_regular_file')

    for (const script of ['rovai.cmd', 'rovai.bat', 'rovai.ps1', 'rovai.js', 'rovai.sh']) {
      const path = join(current.root, script)
      writeFileSync(path, 'fixture\n', 'utf8')
      assert.equal(resolveTrustedCli(path).code, 'loom_cli_not_executable', `${script} must be refused`)
    }

    // A symlinked CLI path is refused on every platform that can create one.
    const linkPath = join(current.root, 'linked.exe')
    let symlinked = false
    try {
      symlinkSync(current.cliPath, linkPath, 'file')
      symlinked = true
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
    }
    if (symlinked) {
      assert.equal(resolveTrustedCli(linkPath).code, 'loom_cli_symlink')
    }
  } finally {
    await rm(current.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6 · outcomes: success, rejection, unknown
// ---------------------------------------------------------------------------

test('6 · a failed or unknown child outcome is reported honestly and never re-sent', async () => {
  const current = fixture()
  try {
    const planned = plan(current, { operation: 'loom.submit', input: { taskId: 't1', evidenceIds: ['e1'] } })
    assert.equal(planned.ok, true)

    // Success: one envelope, bounded, without stderr content.
    const okFake = fakeSpawn()
    okFake.onEnd((record, emit) => {
      emit('stdout', JSON.stringify({ contractVersion: 2, ok: true, operation: 'loom.submit', requestId: planned.plan.requestId, result: { candidateId: 'c1' } }))
      emit('close', 0)
    })
    const ok = await runInvocation({ spawn: okFake.spawn, plan: planned.plan, timeoutMs: 5_000 })
    assert.equal(ok.isError, false)
    assert.equal(ok.indeterminate, false)
    assert.equal(ok.code, 'ok')
    assert.match(ok.text, /c1/)

    // Core rejection: the code and message come from Core, never from stderr.
    const rejectedFake = fakeSpawn()
    rejectedFake.onEnd((_record, emit) => {
      emit('stdout', JSON.stringify({ contractVersion: 2, ok: false, operation: 'loom.submit', requestId: planned.plan.requestId, error: { code: 'loom.claim_fence_stale', message: 'stale fence' } }))
      emit('stderr', 'API_KEY=super-secret-value')
      emit('close', 1)
    })
    const rejected = await runInvocation({ spawn: rejectedFake.spawn, plan: planned.plan, timeoutMs: 5_000 })
    assert.equal(rejected.isError, true)
    assert.equal(rejected.indeterminate, false)
    assert.equal(rejected.code, 'loom.claim_fence_stale')
    assert.equal(rejected.text.includes('secret'), false, 'stderr must never reach the model')

    // Indeterminate: the CLI could not say what happened.
    const indeterminateFake = fakeSpawn()
    indeterminateFake.onEnd((_record, emit) => {
      emit('stderr', 'boom')
      emit('close', 3)
    })
    const indeterminate = await runInvocation({ spawn: indeterminateFake.spawn, plan: planned.plan, timeoutMs: 5_000 })
    assert.equal(indeterminate.isError, true)
    assert.equal(indeterminate.indeterminate, true)

    // A result for another operation is refused outright.
    const wrongOpFake = fakeSpawn()
    wrongOpFake.onEnd((_record, emit) => {
      emit('stdout', JSON.stringify({ contractVersion: 2, ok: true, operation: 'loom.claim', requestId: planned.plan.requestId, result: {} }))
      emit('close', 0)
    })
    const wrongOp = await runInvocation({ spawn: wrongOpFake.spawn, plan: planned.plan, timeoutMs: 5_000 })
    assert.equal(wrongOp.code, 'loom_operation_mismatch')
    assert.equal(wrongOp.indeterminate, true)

    // Timeout: killed and reported as unknown, with exactly one child started (no retry).
    const hangFake = fakeSpawn()
    const timedOut = await runInvocation({ spawn: hangFake.spawn, plan: planned.plan, timeoutMs: 20 })
    assert.equal(timedOut.code, 'loom_timed_out')
    assert.equal(timedOut.indeterminate, true)
    assert.equal(hangFake.calls.length, 1)
    assert.equal(hangFake.calls[0].killed, true)

    // Cancellation behaves the same way.
    const abortFake = fakeSpawn()
    const controller = new AbortController()
    const cancelledPromise = runInvocation({ spawn: abortFake.spawn, plan: planned.plan, signal: controller.signal, timeoutMs: 5_000 })
    controller.abort()
    const cancelled = await cancelledPromise
    assert.equal(cancelled.code, 'loom_cancelled')
    assert.equal(cancelled.indeterminate, true)
  } finally {
    await rm(current.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7 · envelope parsing
// ---------------------------------------------------------------------------

test('7 · only one bounded JSON envelope counts as a result', () => {
  const good = parseEnvelope(JSON.stringify({ ok: true, operation: 'loom.status', requestId: 'r', result: { planId: 'p' } }))
  assert.equal(good.ok, true)
  assert.equal(good.operation, 'loom.status')

  for (const value of [null, '', '   ', 'not json', '{"ok":"yes"}', '[]', `${'x'.repeat(70 * 1024)}`]) {
    const outcome = parseEnvelope(value)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'builtin_tool.invalid_output')
  }
})

// ---------------------------------------------------------------------------
// 8 · only THIS call's envelope counts (identity, version, exit code)
// ---------------------------------------------------------------------------

function reply(fields) {
  return JSON.stringify({ contractVersion: ENVELOPE_VERSION, ...fields })
}

/** Run one planned call against a fake child that prints `stdout` and exits with `exitCode`. */
async function runOnce(current, planned, stdout, exitCode) {
  const fake = fakeSpawn()
  fake.onEnd((_record, emit) => {
    if (stdout !== null) emit('stdout', stdout)
    emit('close', exitCode)
  })
  const result = await runInvocation({ spawn: fake.spawn, plan: planned.plan, timeoutMs: 5_000 })
  return { result, fake }
}

test('8 · a missing or mismatched call identity is never a success', async () => {
  const current = fixture()
  try {
    const planned = plan(current, { operation: 'loom.claim', input: { taskId: 't1' } })
    assert.equal(planned.ok, true)
    const cases = [
      ['operation missing', reply({ ok: true, requestId: planned.plan.requestId, result: { claimId: 'c' } }), 'loom_operation_mismatch'],
      ['operation wrong', reply({ ok: true, operation: 'loom.submit', requestId: planned.plan.requestId, result: {} }), 'loom_operation_mismatch'],
      ['requestId missing', reply({ ok: true, operation: 'loom.claim', result: { claimId: 'c' } }), 'loom_request_id_mismatch'],
      ['requestId foreign', reply({ ok: true, operation: 'loom.claim', requestId: 'a-foreign-id', result: {} }), 'loom_request_id_mismatch'],
      ['requestId of another call', reply({ ok: true, operation: 'loom.claim', requestId: plan(current, { operation: 'loom.claim', input: { taskId: 't1' } }, { toolCallId: 'other' }).plan.requestId, result: {} }), 'loom_request_id_mismatch'],
      ['contractVersion missing', JSON.stringify({ ok: true, operation: 'loom.claim', requestId: planned.plan.requestId, result: {} }), 'loom_envelope_version_mismatch'],
      ['contractVersion wrong', JSON.stringify({ contractVersion: ENVELOPE_VERSION + 1, ok: true, operation: 'loom.claim', requestId: planned.plan.requestId, result: {} }), 'loom_envelope_version_mismatch'],
    ]
    for (const [label, stdout, expected] of cases) {
      // A clean exit 0 does not rescue a foreign envelope.
      const { result } = await runOnce(current, planned, stdout, EXIT_CODES.ok)
      assert.equal(result.isError, true, `${label} must not be a success`)
      assert.equal(result.indeterminate, true, `${label} must stay an unknown outcome`)
      assert.equal(result.code, expected, `${label}: ${result.code}`)
    }
  } finally {
    await rm(current.root, { recursive: true, force: true })
  }
})

test('9 · success requires exit 0 and a result; a rejection requires the contract exit code', async () => {
  const current = fixture()
  try {
    const planned = plan(current, { operation: 'loom.status' })
    const requestId = planned.plan.requestId

    const scenarios = [
      ['ok with exit 1', reply({ ok: true, operation: 'loom.status', requestId, result: {} }), 1, 'loom_exit_mismatch', true],
      ['ok with exit 3', reply({ ok: true, operation: 'loom.status', requestId, result: {} }), EXIT_CODES.outcomeIndeterminate, 'loom_exit_mismatch', true],
      ['ok without result', reply({ ok: true, operation: 'loom.status', requestId }), EXIT_CODES.ok, 'loom_result_missing', true],
      ['ok with an error', reply({ ok: true, operation: 'loom.status', requestId, result: {}, error: { code: 'x' } }), EXIT_CODES.ok, 'loom_result_missing', true],
      ['reject with exit 0', reply({ ok: false, operation: 'loom.status', requestId, error: { code: 'loom.task_not_found', message: 'gone' } }), EXIT_CODES.ok, 'loom_exit_mismatch', true],
      ['reject with exit 3', reply({ ok: false, operation: 'loom.status', requestId, error: { code: 'loom.task_not_found', message: 'gone' } }), EXIT_CODES.outcomeIndeterminate, 'loom_exit_mismatch', true],
      ['reject without a code', reply({ ok: false, operation: 'loom.status', requestId, error: { message: 'gone' } }), EXIT_CODES.rejection, 'loom_rejection_malformed', true],
      ['disabled feature', reply({ ok: false, operation: 'loom.status', requestId, error: { code: 'task.feature_disabled', message: 'disabled' } }), EXIT_CODES.featureDisabled, 'task.feature_disabled', false],
      ['indeterminate rejection', reply({ ok: false, operation: 'loom.status', requestId, error: { code: 'builtin_tool.outcome_indeterminate', message: 'unknown' } }), EXIT_CODES.outcomeIndeterminate, 'builtin_tool.outcome_indeterminate', true],
      ['matching rejection', reply({ ok: false, operation: 'loom.status', requestId, error: { code: 'loom.claim_fence_stale', message: 'stale' } }), EXIT_CODES.rejection, 'loom.claim_fence_stale', false],
    ]
    for (const [label, stdout, exitCode, expectedCode, expectedUnknown] of scenarios) {
      const { result } = await runOnce(current, planned, stdout, exitCode)
      assert.equal(result.code, expectedCode, `${label}: ${result.code}`)
      assert.equal(result.indeterminate, expectedUnknown, `${label} indeterminate`)
      assert.equal(result.isError, expectedUnknown || expectedCode !== 'ok', `${label} isError`)
    }

    // The one fully valid shape is still a success.
    const { result: ok } = await runOnce(current, planned, reply({ ok: true, operation: 'loom.status', requestId, result: { planId: 'p' } }), EXIT_CODES.ok)
    assert.equal(ok.isError, false)
    assert.equal(ok.indeterminate, false)
    assert.equal(ok.code, 'ok')
  } finally {
    await rm(current.root, { recursive: true, force: true })
  }
})

test('10 · unreadable output is unknown even on a clean exit', async () => {
  const current = fixture()
  try {
    const planned = plan(current, { operation: 'loom.inspect', input: { taskId: 't1' } })
    for (const stdout of [null, '', 'not json', '{"ok":', '[]']) {
      for (const exitCode of [EXIT_CODES.ok, EXIT_CODES.rejection]) {
        const { result } = await runOnce(current, planned, stdout, exitCode)
        assert.equal(result.isError, true)
        assert.equal(result.indeterminate, true, 'Core may already have committed the operation')
        assert.equal(result.code, 'builtin_tool.invalid_output')
      }
    }
  } finally {
    await rm(current.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 11 · byte accounting and multibyte decoding
// ---------------------------------------------------------------------------

test('11 · a multibyte character split across stdout chunks is decoded, not corrupted', async () => {
  const current = fixture()
  try {
    const planned = plan(current, { operation: 'loom.status' })
    const body = reply({
      ok: true,
      operation: 'loom.status',
      requestId: planned.plan.requestId,
      result: { note: '验收通过 — 报告已提交' },
    })
    const bytes = Buffer.from(body, 'utf8')
    const firstNonAscii = bytes.findIndex((byte) => byte >= 0x80)
    assert.ok(firstNonAscii > 0, 'the fixture must contain multibyte text')
    const cut = firstNonAscii + 1 // inside the first multibyte sequence
    const fake = fakeSpawn()
    fake.onEnd((_record, emit) => {
      emit('stdout', bytes.subarray(0, cut))
      emit('stdout', bytes.subarray(cut, cut + 2))
      emit('stdout', bytes.subarray(cut + 2))
      emit('close', EXIT_CODES.ok)
    })
    const result = await runInvocation({ spawn: fake.spawn, plan: planned.plan, timeoutMs: 5_000 })
    assert.equal(result.isError, false, result.text)
    assert.equal(result.indeterminate, false)
    assert.match(result.text, /验收通过 — 报告已提交/)
  } finally {
    await rm(current.root, { recursive: true, force: true })
  }
})

test('12 · an oversized JSON stdin payload is refused before any child exists', async () => {
  const current = fixture()
  try {
    // MAX_STDIN_BYTES/3 CJK characters are MAX_STDIN_BYTES *bytes* plus the rest of the JSON, so a
    // character-count budget would have let this through.
    const oversized = plan(current, {
      operation: 'loom.plan',
      input: {
        goal: '验'.repeat(Math.ceil(MAX_STDIN_BYTES / 3) + 64),
        criteria: [{ criterionId: 'c1', text: 'x' }],
        tasks: [{ taskId: 't1', title: 'y' }],
      },
    })
    assert.equal(oversized.ok, false)
    assert.equal(oversized.code, 'loom_input_too_large')
    assert.equal('plan' in oversized, false, 'an oversized call has no invocation to spawn')

    // A payload that fits in bytes is accepted, and its stdin is exactly the parameter JSON.
    const fitting = plan(current, {
      operation: 'loom.plan',
      input: {
        goal: '验'.repeat(100),
        criteria: [{ criterionId: 'c1', text: 'x' }],
        tasks: [{ taskId: 't1', title: 'y' }],
      },
    })
    assert.equal(fitting.ok, true)
    assert.ok(Buffer.byteLength(fitting.plan.stdin, 'utf8') <= MAX_STDIN_BYTES)
    assert.equal(JSON.parse(fitting.plan.stdin).goal.length, 100)
  } finally {
    await rm(current.root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 13 · a child that never confirms termination
// ---------------------------------------------------------------------------

test('13 · an aborted child that never closes is reported as unknown, not as a clean cancellation', async () => {
  const current = fixture()
  try {
    const planned = plan(current, { operation: 'loom.submit', input: { taskId: 't1', evidenceIds: ['e1'] } })
    const fake = fakeSpawn({ killEmitsClose: false })
    const controller = new AbortController()
    const started = Date.now()
    const promise = runInvocation({
      spawn: fake.spawn,
      plan: planned.plan,
      signal: controller.signal,
      timeoutMs: 5_000,
      killConfirmMs: 40,
    })
    controller.abort()
    const result = await promise
    assert.equal(result.isError, true)
    assert.equal(result.indeterminate, true)
    assert.equal(result.code, 'loom_kill_unconfirmed')
    assert.equal(fake.calls.length, 1, 'no automatic retry with a fresh request id')
    assert.equal(fake.calls[0].killed, true)
    assert.ok(Date.now() - started >= 30, 'the result must wait for the bounded kill confirmation')
    assert.equal(/\b\d{3,}\b/.test(result.text), false, 'no pid or other process fact is reported')
  } finally {
    await rm(current.root, { recursive: true, force: true })
  }
})

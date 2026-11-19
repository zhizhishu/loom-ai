import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync, renameSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { apply, readinessService } from '../../crates/rovai-core/src/dsh/bootstrap.mjs'
import { installLocalHooks, validateLaunch, validatePolicy, rootBinding, rejectKnownSandboxBypass } from '../../crates/rovai-core/src/dsh/local-hooks.mjs'
import { hookExecutorEnvironment, validateExecutor } from '../../crates/rovai-core/src/dsh/local-hook-executor.mjs'
import { prepareModels, withResponsesDefaults, observeNativeImport } from '../../crates/rovai-core/src/dsh/models.mjs'

test('DSH Web supplementation preserves whole native routes and localizes unknown sources', () => {
  const route = (url, model = 'same-model') => ({ api: 'openai-responses', baseURL: url,
    apiKeyEnv: 'PRIVATE_KEY_REFERENCE', models: [{ id: model }] })
  const native = { providers: { relay: route('https://native.invalid'), unknown: route('https://unknown.invalid'), disabled: null } }
  const web = { relay: route('https://web.invalid'), extra: route('https://extra.invalid'),
    unknown: route('https://unsafe.invalid'), disabled: route('https://enable.invalid') }
  const diagnostics = []
  const prepared = prepareModels(native, web, new Set(['relay', 'disabled']), diagnostics)
  assert.deepEqual(prepared.config.providers.relay, native.providers.relay)
  assert.deepEqual(prepared.config.providers.unknown, native.providers.unknown)
  assert.equal(prepared.config.providers.disabled, null)
  assert.deepEqual(prepared.webProviders, ['extra'])
  assert.deepEqual(prepared.config.providers.extra, web.extra)
  assert.equal(prepareModels(native, { relay: native.providers.relay }, new Set(['relay']), []).webProviders.length, 0)
  assert.equal(JSON.stringify(diagnostics).includes('https://'), false)
  assert.equal(JSON.stringify(diagnostics).includes('PRIVATE_KEY'), false)
  const builtin = prepareModels({ providers: { relay: {} } }, { relay: web.relay }, new Set(), [], new Set(['relay']))
  assert.deepEqual(builtin.webProviders, ['relay'])
  const opaque = { __jsExpr: 'configurationFromEnvironment()' }
  assert.equal(prepareModels(opaque, web, new Set(), []).config, opaque)
  const partial = prepareModels({ providers: {} }, { bad: opaque, good: web.extra }, new Set(), [])
  assert.deepEqual(partial.webProviders, ['good'])
  assert.deepEqual(partial.rejectedProviders, ['bad'])
  for (const source of [opaque, null, false]) {
    const failed = prepareModels(native, { relay: source, disabled: source, unknown: source,
      extra: source }, new Set(['relay', 'disabled']), [])
    assert.deepEqual(failed.config.providers, native.providers)
    assert.deepEqual(failed.webProviders, [])
    assert.deepEqual(failed.rejectedProviders, ['extra'], 'Web failure must not reject preserved native routes')
  }
})

test('DSH Responses defaults preserve explicit Provider and Model compatibility parameters', () => {
  // Successor of the Rust settings-file transformation owner: all its positive,
  // negative and explicit null cases now exercise the runtime transformation.
  const original = { providers: {
    gateway: { api: 'openai-responses', baseURL: 'https://private.invalid/v1',
      headers: { Authorization: 'private-test-credential' }, models: [{ id: 'model', compat: { supportsStrictMode: false } }] },
    off: { api: 'openai-responses', compat: { supportsStrictMode: false } },
    on: { api: 'openai-responses', compat: { supportsStrictMode: true } },
    null: { api: 'openai-responses', compat: { supportsStrictMode: null } },
    completions: { api: 'openai-completions' }, anthropic: { api: 'anthropic-messages' }, builtin: {},
  } }
  const snapshot = structuredClone(original)
  const prepared = withResponsesDefaults(original)
  assert.deepEqual(prepared, { providers: { ...original.providers,
    gateway: { ...original.providers.gateway, compat: { supportsStrictMode: true } } } })
  assert.deepEqual(original, snapshot)
  assert.deepEqual(withResponsesDefaults({ providers: {} }, original).providers, { gateway: { compat: { supportsStrictMode: true } } })
  for (const config of [{}, { providers: {} }, { __jsExpr: 'nativeExpression()' }]) {
    assert.deepEqual(withResponsesDefaults(config), config.providers ? config : config.__jsExpr ? config : { providers: {} })
  }
})

test('DSH Patch isolation waits for native writes after rename and verifies swallowed failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rovai-dsh-migration-test-'))
  try {
    const legacy = join(root, 'settings.yaml')
    const bytes = '{"llm-pi-ai":{"providers":{"relay":{"apiKeyEnv":"REFERENCE"}}}}'
    writeFileSync(legacy, bytes)
    let release, finished = false, user
    const gate = new Promise(resolve => { release = resolve })
    const settings = {
      describe: () => [{ ns: 'llm-pi-ai', user }],
      async update(ns, patch) { user = patch },
      async importLegacyDocument() {
        renameSync(legacy, `${legacy}.imported`)
        await gate
        await this.update('llm-pi-ai', JSON.parse(bytes)['llm-pi-ai'])
      },
    }
    const diagnostics = []
    const observed = observeNativeImport(settings, { home: root }, diagnostics).then(() => { finished = true })
    assert(existsSync(legacy)) // observation never invokes native migration
    const importing = settings.importLegacyDocument()
    await Promise.resolve()
    assert(existsSync(`${legacy}.imported`))
    assert.equal(finished, false)
    const backup = readdirSync(join(root, 'backups'))[0]
    assert.equal(readFileSync(join(root, 'backups', backup), 'utf8'), bytes)
    release()
    await importing
    await observed
    assert.deepEqual(diagnostics, [])
    settings.update = async () => { throw new Error('private-endpoint-or-key') }
    settings.importLegacyDocument = async function () { try { await this.update('llm-pi-ai', {}) } catch {} }
    const failed = observeNativeImport(settings, { home: root }, diagnostics)
    await settings.importLegacyDocument()
    await failed
    assert.deepEqual(diagnostics, [{ code: 'native_model_import_failed' }])
    await observeNativeImport({}, { home: root }, []) // old DSH has no import wait
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('DSH official prompt seam binds immutable root identity per session and fails closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rovai-dsh-host-test-'))
  try {
    const variables = new Map(), sections = [], events = new Map(), provided = new Map()
    let denied = []
    await apply({ loader: { entries: () => [] }, tools: { schemas: () => ['mcp__fixture__echo', 'mcp__fixture__native_only', 'read'].map(name => ({ name })) }, systemPrompt: {
      variable: (key, fn) => variables.set(key, fn), section: section => sections.push(section)
    }, provide: (key, value) => provided.set(key, value), on: (name, fn) => events.set(name, fn) },
    { bindingRoot: root, observationRoot: root, mcpServerNames: ['fixture'] })
    assert.deepEqual(provided.get(readinessService), { ready: true })
    let toolChangeEvent
    events.get('agent/created')({ agent: { session: { header: {} }, ctx: {
      tools: { restrict: ({ deny }) => { denied = deny; return () => {} } }, on: name => { toolChangeEvent = name }
    } } })
    assert.deepEqual(denied, ['mcp__fixture__echo', 'mcp__fixture__native_only'])
    assert.equal(toolChangeEvent, 'tools/change')
    assert.equal(events.has('tools/pre-execute'), false)
    assert.equal(events.has('tools/post-execute'), false, 'an unselected Hook must install no executor')
    const bootstrap = 'Member A: {{literal}}'
    const binding = { schemaVersion: 1, sessionId: 'session-a', bootstrap,
      sha256: createHash('sha256').update(bootstrap).digest('hex') }
    writeFileSync(join(root, 'session-a.json'), JSON.stringify(binding))
    const render = (id, header = {}) => variables.get('rovai_bootstrap')({ agent: { session: { id, header } } })
    assert.equal(render('session-a'), bootstrap)
    assert.equal(render('session-a'), bootstrap) // same assembly after a native compact
    assert.throws(() => render('session-b'))
    assert.equal(render('session-child', { parentSession: 'session-a' }), '')
    assert.throws(() => render('../session-a'))
    writeFileSync(join(root, 'session-a.json'), JSON.stringify({ ...binding, bootstrap: 'tampered' }))
    assert.throws(() => render('session-a'), /binding_invalid/)
    assert.deepEqual(sections, [{ name: 'rovai:bootstrap', order: 11000, text: '{{rovai_bootstrap}}' }])
    events.get('tools/result')({ name: 'bash', callId: 'call', agent: { session: { id: 'session-a', header: {} } } },
      { isError: false, value: { exitCode: 7, stdout: { text: 'private body' } } })
    const observation = readdirSync(root).find(name => name !== 'session-a.json')
    const result = JSON.parse(readFileSync(join(root, observation), 'utf8'))
    assert.equal(result.exitCode, 7)
    assert.equal(result.sessionId, 'session-a')
    assert.equal(JSON.stringify(result).includes('private body'), false)
    events.get('tools/result')({ name: 'edit', callId: 'edit-call', agent: { session: { id: 'session-a', header: {} } } },
      { isError: false, value: { path: '/workspace/example.txt', before: 'old\n', after: 'new\n', output: 'private output' } })
    const editKey = createHash('sha256').update(JSON.stringify(['session-a', 'edit-call'])).digest('hex')
    const edit = JSON.parse(readFileSync(join(root, `${editKey}.json`), 'utf8'))
    assert.deepEqual({ path: edit.path, before: edit.before, after: edit.after }, {
      path: '/workspace/example.txt', before: 'old\n', after: 'new\n'
    })
    assert.equal(JSON.stringify(edit).includes('private output'), false)
    events.get('tools/result')({ name: 'write', callId: 'write-create', agent: { session: { id: 'session-a', header: {} } } },
      { isError: false, value: { path: '/workspace/created.txt', before: null, after: 'created\n' } })
    const createKey = createHash('sha256').update(JSON.stringify(['session-a', 'write-create'])).digest('hex')
    const create = JSON.parse(readFileSync(join(root, `${createKey}.json`), 'utf8'))
    assert.deepEqual({ path: create.path, before: create.before, after: create.after }, {
      path: '/workspace/created.txt', before: null, after: 'created\n'
    })
    for (const [name, callId, value] of [
      ['write', 'write-missing-before', { path: '/workspace/missing-before.txt', after: 'created\n' }],
      ['write', 'write-missing-after', { path: '/workspace/missing-after.txt', before: null }],
      ['write', 'write-malformed-before', { path: '/workspace/malformed-before.txt', before: 0, after: 'created\n' }],
      ['edit', 'edit-null-before', { path: '/workspace/invalid-edit.txt', before: null, after: 'changed\n' }],
      ['edit', 'edit-malformed-after', { path: '/workspace/malformed-edit.txt', before: 'old\n', after: null }],
      ['write', 'write-oversized', { path: '/workspace/oversized.txt', before: null, after: 'x'.repeat(2 * 1024 * 1024 + 1) }]
    ]) {
      events.get('tools/result')({ name, callId, agent: { session: { id: 'session-a', header: {} } } },
        { isError: false, value })
      const observationKey = createHash('sha256').update(JSON.stringify(['session-a', callId])).digest('hex')
      const fallback = JSON.parse(readFileSync(join(root, `${observationKey}.json`), 'utf8'))
      assert.equal(fallback.path, value.path)
      assert.equal(Object.hasOwn(fallback, 'before'), false)
      assert.equal(Object.hasOwn(fallback, 'after'), false)
    }
    events.get('session/event')({ id: 'session-a', header: {} }, { type: 'assistant/message', seq: 12,
      data: { turn: 2, usage: { inputTokens: 10, outputTokens: 3, totalTokens: 103, cacheReadTokens: 90 }, message: { content: 'private reply' } } })
    const usageFile = readdirSync(root).find(name => name.includes('.usage-'))
    const usage = JSON.parse(readFileSync(join(root, usageFile), 'utf8'))
    assert.deepEqual(usage.usage, { inputTokens: 10, outputTokens: 3, totalTokens: 103, cacheReadTokens: 90 })
    assert.equal(usage.seq, 12)
    assert.equal(JSON.stringify(usage).includes('private reply'), false)
    const observe = event => events.get('session/event')({ id: 'session-a', header: {} }, event)
    observe({ type:'compaction/start', seq:13, data:{compactionId:'auto-1',turn:2} })
    observe({ type:'compaction/summary', seq:14, data:{compactionId:'auto-1',summary:'private summary',usage:{inputTokens:20,outputTokens:4}} })
    observe({ type:'compaction/end', seq:15, data:{compactionId:'auto-1',turn:2} })
    const compactionFile=readdirSync(root).find(name=>name.endsWith('.usage-14.json'))
    const compaction=JSON.parse(readFileSync(join(root,compactionFile),'utf8'))
    assert.equal(compaction.turn,2)
    assert.equal(compaction.sourceEvent,'compaction/summary')
    assert.deepEqual(compaction.usage,{inputTokens:20,outputTokens:4})
    assert.equal(JSON.stringify(compaction).includes('private summary'),false)
    observe({ type:'compaction/start', seq:16, data:{compactionId:'manual-1',turn:null} })
    observe({ type:'compaction/summary', seq:17, data:{compactionId:'manual-1',usage:{inputTokens:999}} })
    observe({ type:'compaction/end', seq:18, data:{compactionId:'manual-1',turn:null} })
    observe({ type:'compaction/summary', seq:19, data:{compactionId:'auto-1',usage:{inputTokens:999}} })
    assert.equal(readdirSync(root).filter(name=>name.includes('.usage-')).length,2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('DSH bootstrap publishes ACP readiness only after native MCP entries settle', async () => {
  let release
  const activation = new Promise(resolve => { release = resolve })
  const calls = []
  const nativeMcp = {
    disabled: false,
    options: { name: '@deepseek-ai/dsh-mcp-client' },
    async refresh() { calls.push('refresh'); await activation },
    async _await() { calls.push('await') }
  }
  let ready = false
  const pending = apply({
    loader: { entries: () => [nativeMcp] },
    tools: { schemas: () => [] },
    systemPrompt: { variable: () => {}, section: () => {} },
    on: () => {},
    provide: key => { assert.equal(key, readinessService); ready = true }
  }, { bindingRoot: '/unused', observationRoot: '/unused', mcpServerNames: [] })
  await Promise.resolve()
  assert.equal(ready, false)
  assert.deepEqual(calls, ['refresh'])
  release()
  await pending
  assert.equal(ready, true)
  assert.deepEqual(calls, ['refresh', 'await'])
})

test('DSH selected local Hook fences the root session, exact command, policy and disposal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rovai-dsh-local-hook-test-'))
  const launch = { schemaVersion: 1, agentRunId: 'run-a', executionEpoch: 2,
    snapshotDigest: 'a'.repeat(64), hookId: 'reviewed-hook', workspaceRoot: root,
    sandboxMode: 'workspace-write', model: 'reviewed-model',
    settings: { hooks: { PostToolUse: [{ matcher: '^read$', hooks: [
      { type: 'command', command: 'reviewed command', timeout: 1 }
    ] }] } } }
  try {
    assert.deepEqual(validateLaunch(launch), { tool: 'read', command: 'reviewed command', timeoutSec: 1 })
    for (const mutate of [
      x => { x.settings.hooks.Stop = [] },
      x => { x.settings.hooks.PostToolUse[0].matcher = '.*' },
      x => { x.settings.hooks.PostToolUse[0].hooks[0].timeout = 6 },
      x => { x.settings.hooks.PostToolUse[0].hooks[0].async = true },
      x => { x.sandboxMode = 'danger-full-access' }
    ]) {
      const invalid = structuredClone(launch); mutate(invalid)
      assert.throws(() => validateLaunch(invalid), /local_hook_/)
    }
    const policy = { mode: launch.sandboxMode, workspaceRoot: root, additionalWritableRoots: [] }
    assert.doesNotThrow(() => validatePolicy(policy, launch))
    assert.throws(() => validatePolicy({ ...policy, mode: 'read-only' }, launch), /scope_mismatch/)
    assert.throws(() => validatePolicy({ ...policy, additionalWritableRoots: [root] }, launch), /scope_mismatch/)
    const config = { localHook: launch, bindingRoot: root, observationRoot: root,
      localHookExecutor: { schemaVersion: 1, node: process.execPath, root,
        launchPath: join(root, 'local-hook-launch.json'), manifestDigest: 'b'.repeat(64), launchDigest: 'c'.repeat(64) } }
    assert.doesNotThrow(() => validateExecutor(config.localHookExecutor))
    assert.throws(() => validateExecutor({ ...config.localHookExecutor, launchPath: 'relative' }))
    assert.deepEqual(hookExecutorEnvironment({ PATH: 'path', SystemRoot: 'root',
      PROVIDER_API_KEY: 'secret', NODE_OPTIONS: '--require=untrusted', LOOM_E4_PROVIDER_KEY: 'secret',
      DSH_HOME: 'native-home', npm_config_userconfig: 'credentials' }), { PATH: 'path', SystemRoot: 'root' })
    const bind = id => {
      const bootstrap = 'Frozen root bootstrap for ' + id
      writeFileSync(join(root, id + '.json'), JSON.stringify({ schemaVersion: 1, sessionId: id, bootstrap,
        sha256: createHash('sha256').update(bootstrap).digest('hex') }))
    }
    bind('session-a'); bind('session-b')
    assert.equal(rootBinding(config, { id: 'session-a', header: {} }), true)
    assert.equal(rootBinding(config, { id: 'child', header: { parentSession: 'session-a' } }), false)
    assert.throws(() => rootBinding(config, { id: '../session-a', header: {} }), /session_invalid/)

    // This is an adapter contract test. The separate native sandbox acceptance
    // is required before any claim about actual process confinement.
    const events = new Map(), cleanups = []
    let calls = 0, parked = false, settled = false, sequence = 1
    const execute = async (executor, exactLaunch, mode, input, signal) => {
      assert.deepEqual(executor, config.localHookExecutor)
      assert.deepEqual(exactLaunch, launch)
      if (mode === 'verify') return { manifestDigest: executor.manifestDigest }
      calls++
      assert.equal(input.payload.tool_name, 'read')
      assert.equal(input.payload.cwd, root)
      assert.equal(input.sessionId, 'session-a')
      if (parked) {
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
        settled = true
        return { output: { exitCode: undefined, stderr: 'cancelled-private-text' }, durationMs: 1,
          facts: { aborted: true, timedOut: false, sandboxEnforcement: 'partial', sandboxDenied: false } }
      }
      return { output: { exitCode: 0, stderr: 'private hook stderr' }, durationMs: 1,
        facts: { aborted: false, timedOut: false, sandboxEnforcement: 'partial', sandboxDenied: false } }
    }
    const protocol = {
      appendHookInvoked(session, record) { session.append('hook/invoked', record) },
      appendHookResult(session, { output, ...record }) {
        session.append('hook/result', { ...record, exitCode: output.exitCode,
          stderrSummary: output.stderr, decision: 'pass' })
      }
    }
    assert.throws(() => rejectKnownSandboxBypass({ confine(argv) {
      // [dsh-purge] sandbox bypass
      return { argv: [...argv], enforcement: 'full' }
    } }), /native_sandbox_modified/)
    const local = {
      sandbox: { confine() { throw new Error('contract fixture never executes an OS process') } },
      loader: { import: async name => { assert(name.endsWith('hook-protocol')); return protocol } },
      get shell() { throw new Error('the native global shell must never execute a reviewed local Hook') },
      sandboxPolicy: { resolve: () => policy },
      agents: { turnBoundaryOf: () => ({ lastTurn: 7 }) },
      workingDirectory: { ensure: async () => root },
      effect: factory => cleanups.push(factory()),
      on: (name, listener) => events.set(name, listener)
    }
    const ctx = { plugin: definition => { const task = definition.apply(local); return { await: () => task } } }
    await installLocalHooks(ctx, config, execute)
    const ready = JSON.parse(readFileSync(join(root, 'local-hook-ready.json'), 'utf8'))
    assert.equal(ready.agentRunId, launch.agentRunId)
    assert.equal(ready.chain, 'private-pinned')
    assert.equal(ready.manifestDigest, config.localHookExecutor.manifestDigest)
    const session = { id: 'session-a', header: {},
      append(type, data) { events.get('session/event')(this, { type, data, seq: sequence++ }) } }
    const exec = { agent: { session }, name: 'read', callId: 'native-call', arguments: {},
      signal: new AbortController().signal }
    const invoke = events.get('tools/post-execute')
    const result = { content: [{ type: 'text', text: 'owned tool output' }] }
    await invoke({ ...exec, name: 'write' }, result, async () => ({ kind: 'pass' }))
    await invoke({ ...exec, agent: { session: { id: 'child', header: { parentSession: 'session-a' } } } },
      result, async () => ({ kind: 'pass' }))
    assert.equal(calls, 0)
    await invoke(exec, result, async () => ({ kind: 'pass' }))
    assert.equal(calls, 1)
    const observations = () => readdirSync(root).filter(name => name.includes('.hook-'))
      .map(name => JSON.parse(readFileSync(join(root, name), 'utf8')))
    const records = observations()
    assert.deepEqual(records.map(row => row.kind), ['invoked', 'result'])
    for (const row of records) {
      assert.equal(row.agentRunId, 'run-a'); assert.equal(row.executionEpoch, 2)
      assert.equal(row.sessionId, 'session-a'); assert.equal(row.snapshotDigest, launch.snapshotDigest)
      assert.equal(JSON.stringify(row).includes('private hook stderr'), false)
      assert.equal(JSON.stringify(row).includes('reviewed command'), false)
    }
    assert.equal(records[1].sandboxEnforcement, 'partial')
    assert.match(records[1].stderrDigest, /^sha256:[a-f0-9]{64}$/)
    await assert.rejects(invoke({ ...exec, agent: { session: { ...session, id: 'session-b' } } },
      result, async () => ({ kind: 'pass' })), /second_root_session/)
    assert.equal(calls, 1)
    parked = true
    const pending = invoke({ ...exec, callId: 'cancelled-call' }, result, async () => ({ kind: 'pass' }))
    const rejected = assert.rejects(pending)
    while (calls !== 2) await Promise.resolve()
    await cleanups[0]()
    await rejected
    assert.equal(settled, true, 'disposal must wait for the owned executor to settle')
    assert.equal(observations().filter(row => row.kind === 'result' && row.aborted).length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('DSH concurrent local Hook callbacks preserve separate native handler receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rovai-dsh-hook-concurrent-'))
  try {
    const launch = { schemaVersion: 1, agentRunId: 'run-concurrent', executionEpoch: 4,
      snapshotDigest: 'a'.repeat(64), hookId: 'reviewed-hook', workspaceRoot: root,
      sandboxMode: 'workspace-write', model: 'model',
      settings: { hooks: { PostToolUse: [{ matcher: '^read$', hooks: [
        { type: 'command', command: 'reviewed command', timeout: 1 }
      ] }] } } }
    const config = { localHook: launch, bindingRoot: root, observationRoot: root,
      localHookExecutor: { schemaVersion: 1, node: process.execPath, root,
        launchPath: join(root, 'local-hook-launch.json'), manifestDigest: 'b'.repeat(64),
        launchDigest: 'c'.repeat(64) } }
    const bootstrap = 'Concurrent root binding'
    writeFileSync(join(root, 'session-a.json'), JSON.stringify({ schemaVersion: 1,
      sessionId: 'session-a', bootstrap,
      sha256: createHash('sha256').update(bootstrap).digest('hex') }))
    const events = new Map(), seen = []
    const policy = { mode: 'workspace-write', workspaceRoot: root, additionalWritableRoots: [] }
    let entered = 0, releaseEnsure, bothWaiting
    const gate = new Promise(resolve => { releaseEnsure = resolve })
    const waiting = new Promise(resolve => { bothWaiting = resolve })
    const protocol = {
      appendHookInvoked(session, record) { session.append('hook/invoked', record) },
      appendHookResult(session, { output, ...record }) {
        session.append('hook/result', { ...record, exitCode: output.exitCode,
          stderrSummary: output.stderr, decision: 'pass' })
      }
    }
    const local = {
      loader: { import: async name => { assert(name.endsWith('hook-protocol')); return protocol } },
      sandboxPolicy: { resolve: () => policy },
      agents: { turnBoundaryOf: () => ({ lastTurn: 7 }) },
      workingDirectory: { async ensure() {
        if (++entered === 2) bothWaiting()
        await gate
        return root
      } },
      effect: () => {},
      on: (name, listener) => events.set(name, listener)
    }
    const ctx = { plugin: definition => {
      const task = definition.apply(local)
      return { await: () => task }
    } }
    const calls = []
    await installLocalHooks(ctx, config, async (executor, actualLaunch, mode, input) => {
      if (mode === 'verify') return { manifestDigest: executor.manifestDigest }
      assert.deepEqual(actualLaunch, launch)
      calls.push(input)
      return { output: { exitCode: 0, stderr: 'private error summary' }, durationMs: 1,
        facts: { aborted: false, timedOut: false, sandboxEnforcement: 'partial', sandboxDenied: false } }
    })
    let seq = 1
    const session = { id: 'session-a', header: {},
      append(type, data) {
        seen.push({ type, ...data })
        events.get('session/event')(this, { type, data, seq: seq++ })
      } }
    const exec = { agent: { session }, name: 'read', arguments: {},
      signal: new AbortController().signal }
    const content = { content: [{ type: 'text', text: 'read output' }] }
    const invoke = events.get('tools/post-execute')
    const next = async () => ({ kind: 'pass' })
    const first = invoke({ ...exec, callId: 'native-call-1' }, content, next)
    const second = invoke({ ...exec, callId: 'native-call-2' }, content, next)
    await waiting
    releaseEnsure()
    assert.deepEqual(await Promise.all([first, second]), [{ kind: 'pass' }, { kind: 'pass' }])
    assert.deepEqual(calls.map(row => row.payload.tool_use_id), ['native-call-1', 'native-call-2'])
    const handlerIds = calls.map(row => row.handlerId)
    assert.equal(new Set(handlerIds).size, 2, 'overlapping callbacks must not share handlerId')
    for (const id of handlerIds) {
      assert.equal(seen.filter(row => row.type === 'hook/invoked' && row.handlerId === id).length, 1)
      assert.equal(seen.filter(row => row.type === 'hook/result' && row.handlerId === id).length, 1)
    }
    const receipts = readdirSync(root).filter(name => name.includes('.hook-'))
    assert.equal(receipts.length, 4)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// DSH 0.2 removed `workingDirectory` and the `agents` turn-boundary helper. A
// projection-era Host therefore has no way to supply a guessed cwd or turn, and
// these cases pin the exact fields it must supply instead.
const projectionFixture = root => {
  const launch = { schemaVersion: 1, agentRunId: 'run-projection', executionEpoch: 5,
    snapshotDigest: 'a'.repeat(64), hookId: 'reviewed-hook', workspaceRoot: root,
    sandboxMode: 'workspace-write', model: 'reviewed-model',
    settings: { hooks: { PostToolUse: [{ matcher: '^read$', hooks: [
      { type: 'command', command: 'reviewed command', timeout: 1 }
    ] }] } } }
  const bootstrap = 'Projection root binding'
  writeFileSync(join(root, 'session-a.json'), JSON.stringify({ schemaVersion: 1,
    sessionId: 'session-a', bootstrap,
    sha256: createHash('sha256').update(bootstrap).digest('hex') }))
  return { launch, config: { localHook: launch, bindingRoot: root, observationRoot: root,
    localHookExecutor: { schemaVersion: 1, node: process.execPath, root,
      launchPath: join(root, 'local-hook-launch.json'), manifestDigest: 'b'.repeat(64),
      launchDigest: 'c'.repeat(64) } } }
}

const projectionProtocol = () => ({
  appendHookInvoked(session, record) { session.append('hook/invoked', record) },
  appendHookResult(session, { output, ...record }) {
    session.append('hook/result', { ...record, exitCode: output.exitCode,
      stderrSummary: output.stderr, decision: 'pass' })
  }
})

// One Host object: the projection registry is reachable only through
// `reflect.get`, and the removed `workingDirectory` service throws on read.
const projectionHost = ({ events, cleanups, resolve, projections, alsoAgentTurn }) => ({
  reflect: { get: name => ({
    sessionProjections: projections,
    agents: alsoAgentTurn ? { turnBoundaryOf: () => ({ lastTurn: 99 }) } : undefined,
    workingDirectory: undefined
  })[name] },
  loader: { import: async name => { assert(name.endsWith('hook-protocol')); return projectionProtocol() } },
  get shell() { throw new Error('the native global shell must never execute a reviewed local Hook') },
  get workingDirectory() { throw new Error('0.2 has no workingDirectory service') },
  sandboxPolicy: { resolve },
  effect: factory => cleanups.push(factory()),
  on: (name, listener) => events.set(name, listener)
})

test('DSH 0.2 Session contract supplies the turn, the header cwd and the Session policy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rovai-dsh-projection-'))
  try {
    const { launch, config } = projectionFixture(root)
    const events = new Map(), cleanups = [], resolved = [], calls = []
    const policy = { mode: 'workspace-write', workspaceRoot: root, additionalWritableRoots: [],
      sessionId: 'session-a' }
    let seq = 1
    const session = { id: 'session-a', header: { cwd: root },
      append(type, data) { events.get('session/event')(this, { type, data, seq: seq++ }) } }
    const projections = { stateOf: (target, key) => {
      assert.equal(target, session)
      assert.equal(key, 'turnBoundary')
      return { lastTurn: 7 }
    } }
    const local = projectionHost({ events, cleanups, projections, alsoAgentTurn: true,
      resolve: request => {
        resolved.push(request === undefined ? 'default' : request.session.id)
        return policy
      } })
    const ctx = { plugin: definition => { const task = definition.apply(local); return { await: () => task } } }
    await installLocalHooks(ctx, config, async (executor, exactLaunch, mode, input) => {
      if (mode === 'verify') return { manifestDigest: executor.manifestDigest }
      assert.deepEqual(exactLaunch, launch)
      calls.push(input)
      return { output: { exitCode: 0, stderr: '' }, durationMs: 1,
        facts: { aborted: false, timedOut: false, sandboxEnforcement: 'partial', sandboxDenied: false } }
    })
    // Startup can only check the deployment default; every callback re-resolves
    // for its own Session, which is how a 0.2 policy reports the effective mode.
    assert.deepEqual(resolved, ['default'])
    const exec = { agent: { session }, name: 'read', callId: 'native-call',
      arguments: { path: 'proof.txt' }, signal: new AbortController().signal }
    assert.deepEqual(await events.get('tools/post-execute')(exec,
      { content: [{ type: 'text', text: 'owned output' }] }, async () => ({ kind: 'pass' })),
    { kind: 'pass' })
    assert.deepEqual(resolved, ['default', 'session-a'])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].turn, 7, 'the native projection outranks the legacy turn helper')
    assert.equal(calls[0].payload.cwd, root, 'the frozen Session header is the only directory source')
    assert.equal(calls[0].payload.turn_id, '7')
    assert.equal(calls[0].payload.tool_use_id, 'native-call')
    const receipts = readdirSync(root).filter(name => name.includes('.hook-'))
      .map(name => JSON.parse(readFileSync(join(root, name), 'utf8')))
    assert.deepEqual(receipts.map(row => [row.kind, row.turn, row.handlerId]),
      [['invoked', 7, calls[0].handlerId], ['result', 7, calls[0].handlerId]])
    assert.equal(receipts.every(row => row.sessionId === 'session-a'), true)
    assert.equal(receipts.every(row => row.agentRunId === 'run-projection'), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('DSH 0.2 refuses a guessed turn, a guessed directory or a foreign Session policy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rovai-dsh-projection-refuse-'))
  try {
    const { config } = projectionFixture(root)
    const rejections = async ({ projections, header, resolve, alsoAgentTurn, error }) => {
      const events = new Map(), cleanups = [], calls = []
      const local = projectionHost({ events, cleanups, resolve, projections, alsoAgentTurn })
      const ctx = { plugin: definition => { const task = definition.apply(local); return { await: () => task } } }
      await installLocalHooks(ctx, config, async (executor, exactLaunch, mode, input) => {
        if (mode === 'verify') return { manifestDigest: executor.manifestDigest }
        calls.push(input)
        return { output: { exitCode: 0, stderr: '' }, durationMs: 1,
          facts: { aborted: false, timedOut: false, sandboxEnforcement: 'partial', sandboxDenied: false } }
      })
      const session = { id: 'session-a', header,
        append() { throw new Error('a refused Hook must not record a receipt') } }
      const exec = { agent: { session }, name: 'read', callId: 'native-call',
        arguments: {}, signal: new AbortController().signal }
      await assert.rejects(events.get('tools/post-execute')(exec, { content: [] },
        async () => ({ kind: 'pass' })), error)
      assert.equal(calls.length, 0, 'a refused Hook never starts the reviewed command')
      assert.equal(readdirSync(root).filter(name => name.includes('.hook-')).length, 0)
    }
    const policy = { mode: 'workspace-write', workspaceRoot: root, additionalWritableRoots: [],
      sessionId: 'session-a' }
    const projection = lastTurn => ({ stateOf: () => ({ lastTurn }) })
    // 0.2 keeps the open turn in the projection registry; a missing state is not turn 0.
    await rejections({ projections: projection(undefined), header: { cwd: root }, resolve: () => policy,
      error: /native_turn_invalid/ })
    // The Session header is the boundary. Without it 0.2 supplies no directory at all.
    await rejections({ projections: projection(7), header: {}, resolve: () => policy,
      error: /workspace_missing/ })
    // A policy resolved for another Session is the wrong fence.
    await rejections({ projections: projection(7), header: { cwd: root },
      resolve: () => ({ ...policy, sessionId: 'session-b' }), error: /sandbox_session_mismatch/ })
    // A Session override outranks the deployment default, so the old no-argument
    // resolve is not evidence of the mode this call actually runs under.
    await rejections({ projections: projection(7), header: { cwd: root },
      resolve: request => request === undefined ? policy : { ...policy, mode: 'read-only' },
      error: /scope_mismatch/ })
    // A Host exposing neither contract is refused even though `agents` exists.
    await rejections({ projections: undefined, header: { cwd: root }, alsoAgentTurn: false,
      resolve: () => policy, error: /session_contract_unavailable/ })
  } finally { rmSync(root, { recursive: true, force: true }) }
})


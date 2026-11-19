// LOOM V2 — isolated RUNTIME SAFETY tests for the authorized Pi execution entry + the native file guard.
//
// Run (Root, from loom/):  node --test --test-force-exit scripts/loom-v2-runtime-safety.test.mjs
//
// Scope (Root approval 2026-11-16, option C): this file is NEW and additive. It does not replace
// scripts/loom-v2-runtime-execution.test.mjs and it does not touch any source module.
//
// Hard boundaries — every case here is pure local and process-local:
//   * no live provider, no real model, no network listener, no outbound socket;
//   * no Pi process is ever spawned (the only `runAuthorizedExecution` calls are the pre-spawn
//     fail-closed cases that must reject BEFORE any bundle read or temp root exists);
//   * no user auth/models config, no ~/.pi, no global config, no database, no port 64851;
//   * every filesystem fixture is inside one mkdtemp root per test, removed in `finally`;
//   * every process.env mutation is saved and restored in `finally`.
//
// Requires Node >= 24 (package.json engines): the guard is imported straight from its `.ts` file,
// which relies on native type stripping. The guard file is plain JS with JSDoc types, so stripping
// is a no-op — the extension is only there so Pi can load it.
//
// Coverage contract (T1–T10, the reviewed safety surface):
//   T1  fail-closed grant        — expired/blank/invalid grant and blank prompt reject before any
//                                  bundle access, temp root or spawn; ordering is asserted explicitly.
//   T2  model endpoint + cred    — endpoint kind derived from the URL (never a caller flag), env-var-
//                                  NAME-only credential, missing credential fails closed.
//   T3  Pi CLI argv              — exact flag vector, granted tool subset, explicit guard extension,
//                                  and the absence of `--no-tools` / `--approve` / `--no-approve`.
//   T4  tool execution vs intent — a model `toolcall_start` is never an execution; an unterminated
//                                  call stays unfinished; payload text never reaches the evidence.
//   T5  guard log schema         — `readGuardLog` round-trip (blank lines, last `guard_ready` wins,
//                                  bad lines counted) and every `summarizeGuard` rejection.
//   T6  guard fail-closed grant  — all eleven `loadGrant` reasons block EVERY tool call, in-process,
//                                  through the real extension factory.
//   T7  guard allow/deny pairing — real guard instance: allow only inside the workspace, block on
//                                  traversal / absolute escape / sensitive path / tool / cwd, then
//                                  cross-check decisions against executions both ways.
//   T8  explicit artifacts       — nested positive hashing; absolute, `..`, duplicate, `.env*`,
//                                  sensitive suffix, NUL, missing, directory and symlink all refused.
//   T9  log-write fail-closed    — an unrecordable guard log refuses at startup AND refuses an
//                                  otherwise-allowable decision (fail closed, never fail open).
//   T10 run/bot binding          — `guard_ready` must be bound to this run: mismatched non-null
//                                  strings are rejected by both the post-run and pre-prompt gates.
//
// The source files below are owned by another writer and are treated as READ ONLY here:
//   scripts/loom-v2-runtime-execution.mjs, scripts/loom-v2-runtime-file-guard.ts
// Anchors cited in comments are from the read at authoring time and may drift.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  RUNTIME_GUARD_ENV,
  RUNTIME_GUARD_SCHEMA,
  RUNTIME_TOOL_ALLOWLIST,
  assertAuthorizedModelConfig,
  assertPerRunGrant,
  assertPrePromptGuard,
  buildAuthorizedEnv,
  buildAuthorizedPiArgv,
  defaultGuardPath,
  extractToolExecutions,
  hashExpectedArtifacts,
  readGuardLog,
  resolveApiKeyValue,
  runAuthorizedExecution,
  summarizeGuard,
  waitForFreshGuardReady
} from './loom-v2-runtime-execution.mjs'
import loomRuntimeFileGuard, { evaluatePath } from './loom-v2-runtime-file-guard.ts'

const RUN_ID = 'run-safety-1'
const BOT_ID = 'bot_safety'
const KEY_ENV = 'LOOM_SAFETY_TEST_KEY'
const KEY_VALUE = 'loom-safety-local-key-value'
const UNSET_KEY_ENV = 'LOOM_SAFETY_ABSENT_KEY'
const IS_WIN = process.platform === 'win32'

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Restore one env var exactly (including "was absent") after `fn` settles. */
async function withEnv(name, value, fn) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

/** The guard writes `[loom-guard] <reason>` to stderr; keep the runner output clean. */
async function withSilencedStderr(fn) {
  const original = process.stderr.write
  const captured = []
  process.stderr.write = (chunk) => {
    captured.push(String(chunk))
    return true
  }
  try {
    const value = await fn()
    return { value, captured }
  } finally {
    process.stderr.write = original
  }
}

function makeFakePi() {
  const handlers = new Map()
  return {
    handlers,
    pi: {
      on(type, handler) {
        handlers.set(type, handler)
        return undefined
      }
    }
  }
}

/**
 * Load the REAL guard extension with an explicit `LOOM_RUN_GUARD` payload.
 * The env var is restored immediately after the factory returns: the factory reads the grant once,
 * so the returned `tool_call` handler is self-contained and safe to call afterwards.
 */
async function initGuard(rawConfig, { silence = true } = {}) {
  const fake = makeFakePi()
  const run = () => loomRuntimeFileGuard(fake.pi)
  await withEnv(RUNTIME_GUARD_ENV, rawConfig, async () => {
    if (silence) await withSilencedStderr(run)
    else await run()
  })
  return fake
}

function guardConfig({ logPath, workspaceReal, overrides = {} }) {
  return {
    schema: RUNTIME_GUARD_SCHEMA,
    runId: RUN_ID,
    botId: BOT_ID,
    logPath,
    workspaceReal,
    allowedTools: ['read', 'write'],
    expiresAtEpochMs: Date.now() + 300_000,
    ...overrides
  }
}

function toolEvent(toolName, toolCallId, input = {}) {
  return { toolName, toolCallId, input }
}

function guardLogRecord(overrides = {}) {
  return {
    t: 'guard_ready',
    at: Date.now(),
    pid: process.pid,
    ppid: 1,
    runId: RUN_ID,
    botId: BOT_ID,
    schema: RUNTIME_GUARD_SCHEMA,
    workspaceReal: '/loom-safety/ws',
    allowedTools: ['read'],
    expiresAtEpochMs: Date.now() + 60_000,
    cwdReal: '/loom-safety/ws',
    selfTestFailures: 0,
    ...overrides
  }
}

function guardSelfTestRecord(overrides = {}) {
  return { t: 'guard_selftest', at: Date.now(), cases: 16, failures: 0, failureDetail: [], ...overrides }
}

function executionRecord(toolCallId, toolName = 'read') {
  return { toolCallId, toolName, started: true, finished: true, isError: false }
}

function toolEvidenceFor(executions) {
  return {
    executions,
    executedCount: executions.filter((execution) => execution.finished).length,
    unfinishedCount: executions.filter((execution) => !execution.finished).length,
    toolResultCount: executions.length,
    modelToolcallIntentions: 0
  }
}

/** A model config that validates. It is never dialled: no test in this file opens a socket. */
function localMockModel(overrides = {}) {
  return {
    providerId: 'loom-mock',
    baseUrl: 'http://127.0.0.1:1/v1',
    modelId: 'loom-safety-model',
    api: 'openai-completions',
    apiKeyEnvVar: KEY_ENV,
    ...overrides
  }
}

function futureGrant(workspaceRoot, overrides = {}) {
  return {
    runId: RUN_ID,
    botId: BOT_ID,
    workspaceRoot,
    allowedTools: ['read'],
    expiresAt: Date.now() + 120_000,
    ...overrides
  }
}

/** A piBin that does not exist. Reaching it means a pre-spawn gate failed to stop the run. */
function absentPiBin() {
  return join(tmpdir(), 'loom-safety-no-such-pi-bundle-9f3c', 'pi.exe')
}

// ---------------------------------------------------------------------------
// T1 · fail-closed grant: nothing is spawned before authorization
// ---------------------------------------------------------------------------

test('T1 · fail-closed grant: expired grant and blank prompt reject before any bundle access', { timeout: 30_000 }, async () => {
  const root = freshDir('loom-safety-t1-')
  const workspace = join(root, 'ws')
  mkdirSync(workspace)
  try {
    // The piBin does not exist. If the grant gate were evaluated after bundle access, this would
    // surface as `pinned_bundle_unreadable` instead — so the error code proves the ordering.
    await assert.rejects(
      runAuthorizedExecution({
        grant: futureGrant(workspace, { expiresAt: Date.now() - 1_000 }),
        model: localMockModel(),
        prompt: 'harmless local safety fixture',
        piBin: absentPiBin()
      }),
      /grant_expired/
    )

    await assert.rejects(
      runAuthorizedExecution({
        grant: futureGrant(workspace),
        model: localMockModel(),
        prompt: '   ',
        piBin: absentPiBin()
      }),
      /prompt_must_be_non_empty_string/
    )

    await assert.rejects(
      runAuthorizedExecution({
        grant: futureGrant('relative/workspace'),
        model: localMockModel(),
        prompt: 'harmless local safety fixture',
        piBin: absentPiBin()
      }),
      /grant_workspaceRoot_must_be_absolute/
    )

    await assert.rejects(
      runAuthorizedExecution({
        grant: futureGrant(workspace, { allowedTools: ['bash'] }),
        model: localMockModel(),
        prompt: 'harmless local safety fixture',
        piBin: absentPiBin()
      }),
      /grant_tool_not_permitted/
    )

    // Ordering proof, positive direction: with a VALID grant the runner advances exactly to the
    // pinned-bundle check and stops there — it never creates a temp root or spawns a process.
    await withEnv(KEY_ENV, KEY_VALUE, async () => {
      await assert.rejects(
        runAuthorizedExecution({
          grant: futureGrant(workspace),
          model: localMockModel(),
          prompt: 'harmless local safety fixture',
          piBin: absentPiBin()
        }),
        /pinned_bundle_unreadable/
      )
    })

    // The grant object is frozen and digest-bound: a caller cannot mutate it after the fact.
    const granted = assertPerRunGrant(futureGrant(workspace))
    assert.equal(Object.isFrozen(granted), true)
    assert.equal(Object.isFrozen(granted.allowedTools), true)
    assert.match(granted.grantSha256, /^[0-9a-f]{64}$/)
    assert.deepEqual([...RUNTIME_TOOL_ALLOWLIST], ['read', 'write', 'edit'])

    // Deterministic expiry windows, no wall-clock dependence.
    const now = 1_700_000_000_000
    assert.throws(() => assertPerRunGrant(futureGrant(workspace, { expiresAt: now }), { now }), /grant_expired/)
    assert.throws(() => assertPerRunGrant(futureGrant(workspace, { expiresAt: now + 24 * 60 * 60 * 1000 + 1 }), { now }), /grant_window_too_long/)
    assert.equal(assertPerRunGrant(futureGrant(workspace, { expiresAt: now + 60_000 }), { now }).expiresAtEpochMs, now + 60_000)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// T2 · model endpoint + credential
// ---------------------------------------------------------------------------

test('T2 · model endpoint and credential: kind derived from URL, env-name-only secret, fail closed', { timeout: 30_000 }, async () => {
  const root = freshDir('loom-safety-t2-')
  const workspace = join(root, 'ws')
  mkdirSync(workspace)
  try {
    const loopback = assertAuthorizedModelConfig(localMockModel())
    assert.equal(loopback.providerConnection, 'loopback-mock')
    assert.equal(loopback.mockProvider, true)
    assert.equal(loopback.baseUrlPort, 1)

    const external = assertAuthorizedModelConfig(localMockModel({
      providerId: 'acme',
      baseUrl: 'https://api.example.invalid/v1',
      modelId: 'acme-model-1'
    }))
    assert.equal(external.providerConnection, 'external')
    assert.equal(external.mockProvider, false)

    // The connection kind is derived from the endpoint only: caller-supplied flags are ignored, so a
    // real https endpoint can never be mislabelled as a mock (and a mock id can never ride a real one).
    const spoofed = assertAuthorizedModelConfig(localMockModel({
      providerId: 'acme',
      baseUrl: 'https://api.example.invalid/v1',
      providerConnection: 'loopback-mock',
      mockProvider: true
    }))
    assert.equal(spoofed.providerConnection, 'external', 'a caller flag must not override the derived kind')
    assert.equal(spoofed.mockProvider, false)

    const reject = (overrides, pattern) => {
      assert.throws(() => assertAuthorizedModelConfig(localMockModel(overrides)), pattern)
    }
    reject({ baseUrl: 'http://api.example.invalid/v1', providerId: 'acme' }, /model_baseUrl_http_must_be_loopback/)
    reject({ baseUrl: 'https://127.0.0.1:1/v1', providerId: 'acme' }, /model_baseUrl_https_loopback_ambiguous/)
    reject({ providerId: 'acme' }, /model_loopback_endpoint_requires_mock_provider_id/)
    reject({ baseUrl: 'https://api.example.invalid/v1' }, /model_external_endpoint_must_not_use_mock_provider_id/)
    reject({ baseUrl: 'https://u:p@api.example.invalid/v1', providerId: 'acme' }, /model_baseUrl_must_not_embed_credentials/)
    reject({ baseUrl: 'https://api.example.invalid/v1?key=1', providerId: 'acme' }, /model_baseUrl_must_not_carry_query_or_hash/)
    reject({ baseUrl: 'https://api.example.invalid/v1#frag', providerId: 'acme' }, /model_baseUrl_must_not_carry_query_or_hash/)
    reject({ baseUrl: 'ftp://api.example.invalid', providerId: 'acme' }, /model_baseUrl_protocol_not_permitted/)
    reject({ apiKeyEnvVar: 'lower_case' }, /model_apiKeyEnvVar_invalid/)
    reject({ apiKeyEnvVar: 'LOOM-SAFETY-KEY' }, /model_apiKeyEnvVar_invalid/)
    reject({ api: 'anthropic-messages' }, /model_api_must_be_openai_completions/)
    reject({ modelId: 'has space' }, /model_modelId_invalid/)
    reject({ contextWindow: 8 }, /model_contextWindow_invalid/)
    reject({ maxTokens: 0 }, /model_maxTokens_invalid/)

    // The credential is resolved by NAME from an explicit env object; nothing is stored or hashed.
    assert.equal(resolveApiKeyValue(loopback, { env: { [KEY_ENV]: KEY_VALUE } }), KEY_VALUE)
    assert.throws(() => resolveApiKeyValue(loopback, { env: {} }), /credential_env_missing:LOOM_SAFETY_TEST_KEY/)
    assert.throws(() => resolveApiKeyValue(loopback, { env: { [KEY_ENV]: 'short' } }), /credential_env_value_invalid/)
    assert.throws(() => resolveApiKeyValue(loopback, { env: { [KEY_ENV]: 'has a space' } }), /credential_env_value_invalid/)

    // Fail closed at the orchestrator: a valid grant + an ABSENT credential env var stops before the
    // pinned bundle is ever read (the bogus piBin would otherwise report `pinned_bundle_unreadable`).
    await withEnv(UNSET_KEY_ENV, undefined, async () => {
      await assert.rejects(
        runAuthorizedExecution({
          grant: futureGrant(workspace),
          model: localMockModel({ apiKeyEnvVar: UNSET_KEY_ENV }),
          prompt: 'harmless local safety fixture',
          piBin: absentPiBin()
        }),
        /credential_env_missing:LOOM_SAFETY_ABSENT_KEY/
      )
    })

    // The isolated env carries the guard config and the one authorized credential — and nothing else
    // credential-shaped from the ambient environment. (See the report: `buildIsolatedEnv` drops
    // non-allowlisted baseEnv keys, so an inherited API key can never reach the child at all.)
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const env = buildAuthorizedEnv({
      agentDir,
      model: loopback,
      apiKeyValue: KEY_VALUE,
      guardConfig: guardConfig({ logPath: join(root, 'guard.jsonl'), workspaceReal: root }),
      baseEnv: { PATH: process.env.PATH, HOME: '/home/someone', OPENAI_API_KEY: 'must-not-appear', GITHUB_TOKEN: 'must-not-appear' }
    })
    assert.equal(env[KEY_ENV], KEY_VALUE)
    assert.equal(JSON.parse(env[RUNTIME_GUARD_ENV]).schema, RUNTIME_GUARD_SCHEMA)
    assert.equal(env.PI_CODING_AGENT_DIR, agentDir)
    for (const forbidden of ['OPENAI_API_KEY', 'GITHUB_TOKEN']) {
      assert.equal(Object.prototype.hasOwnProperty.call(env, forbidden), false, `${forbidden} must never be inherited`)
    }
    assert.throws(
      () => buildAuthorizedEnv({ agentDir, model: loopback, apiKeyValue: '', guardConfig: {}, baseEnv: {} }),
      /apiKeyValue_missing/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// T3 · Pi CLI argv
// ---------------------------------------------------------------------------

test('T3 · Pi CLI argv: exact flags, granted tool subset, explicit guard extension', { timeout: 20_000 }, () => {
  const guardPath = defaultGuardPath()
  assert.ok(guardPath.endsWith('loom-v2-runtime-file-guard.ts'))

  assert.deepEqual(buildAuthorizedPiArgv({ guardPath, tools: ['read', 'write'] }), [
    '--mode', 'rpc',
    '--offline',
    '--no-session',
    '--no-context-files',
    '--no-skills',
    '--no-extensions',
    '--tools', 'read,write',
    '--extension', guardPath
  ])

  const single = buildAuthorizedPiArgv({ guardPath, tools: ['read'] })
  assert.equal(single[single.indexOf('--tools') + 1], 'read')
  assert.equal(single.includes('--no-tools'), false, '--no-tools would contradict the granted tools')
  assert.equal(single.includes('--approve'), false, 'project trust is not an authorization mechanism')
  assert.equal(single.includes('--no-approve'), false, 'project trust is not an authorization mechanism')

  assert.throws(() => buildAuthorizedPiArgv({ guardPath, tools: ['bash'] }), /tool_not_permitted/)
  assert.throws(() => buildAuthorizedPiArgv({ guardPath, tools: [] }), /tools_must_be_non_empty_array/)
  assert.throws(() => buildAuthorizedPiArgv({ guardPath, tools: 'read' }), /tools_must_be_non_empty_array/)
  assert.throws(() => buildAuthorizedPiArgv({ guardPath: 'relative/guard.ts', tools: ['read'] }), /guard_path_must_be_absolute/)
  assert.throws(() => buildAuthorizedPiArgv({ guardPath: resolve(tmpdir(), 'guard.js'), tools: ['read'] }), /guard_path_must_be_typescript_extension/)
})

// ---------------------------------------------------------------------------
// T4 · tool execution vs model intent
// ---------------------------------------------------------------------------

test('T4 · tool execution vs intent: intentions never count as executions; payload text never leaks', { timeout: 20_000 }, () => {
  const events = [
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start' } },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end' } },
    { type: 'tool_execution_start', toolCallId: 'call_ok', toolName: 'read', args: { path: 'notes.md' } },
    { type: 'tool_execution_end', toolCallId: 'call_ok', toolName: 'read', result: { content: 'body' }, isError: false },
    { type: 'message_end', message: { role: 'toolResult', toolCallId: 'call_ok', isError: false } },
    { type: 'tool_execution_start', toolCallId: 'call_open', toolName: 'write', args: { path: 'out.txt', content: 'x' } }
  ]
  const evidence = extractToolExecutions(events)
  assert.equal(evidence.executions.length, 2)
  assert.equal(evidence.modelToolcallIntentions, 1, 'the model intention is counted separately, never as an execution')
  assert.equal(evidence.executedCount, 1)
  assert.equal(evidence.unfinishedCount, 1)
  assert.equal(evidence.toolResultCount, 1)

  const ok = evidence.executions.find((execution) => execution.toolCallId === 'call_ok')
  assert.equal(ok.finished, true)
  assert.equal(ok.isError, false)
  assert.equal(ok.toolResultLinked, true)
  assert.equal(ok.toolResultIsError, false)
  assert.match(ok.argsSha256, /^[0-9a-f]{64}$/)
  assert.match(ok.resultSha256, /^[0-9a-f]{64}$/)
  assert.ok(ok.argsBytes > 0)

  const open = evidence.executions.find((execution) => execution.toolCallId === 'call_open')
  assert.equal(open.finished, false)
  assert.equal(open.resultSha256, null)
  assert.equal(open.toolResultLinked, false)

  // A `toolResult` with no matching execution start is reported, never promoted to an execution.
  const orphan = extractToolExecutions([{ type: 'message_end', message: { role: 'toolResult', toolCallId: 'call_ghost', isError: true } }])
  assert.equal(orphan.executions.length, 0)
  assert.equal(orphan.executedCount, 0)
  assert.equal(orphan.toolResultCount, 1)

  // Only digests and byte counts leave this function: no path, no content.
  const text = JSON.stringify(evidence)
  assert.equal(text.includes('notes.md'), false)
  assert.equal(text.includes('out.txt'), false)
  assert.equal(text.includes('body'), false)
})

// ---------------------------------------------------------------------------
// T5 · guard log schema + summarizeGuard rejections
// ---------------------------------------------------------------------------

test('T5 · guard log: parsing round-trip and every summarizeGuard rejection', { timeout: 30_000 }, async () => {
  const root = freshDir('loom-safety-t5-')
  const workspaceReal = resolve(root, 'ws')
  mkdirSync(workspaceReal)
  const logPath = join(root, 'guard.jsonl')
  try {
    // Missing log file: present:false, and summarizeGuard refuses to call that a guarded run.
    const missing = readGuardLog(join(root, 'no-such-guard.jsonl'))
    assert.deepEqual(missing, { present: false, ready: null, selfTest: null, decisions: [], badLines: 0 })
    assert.throws(() => summarizeGuard(missing, toolEvidenceFor([]), { allowedTools: ['read'], workspaceReal }), /guard_not_loaded/)

    // Round-trip: blank lines ignored, unparsable lines counted, the LAST guard_ready wins.
    const first = guardLogRecord({ workspaceReal, at: 1 })
    const last = guardLogRecord({ workspaceReal, at: 2, runId: RUN_ID })
    writeFileSync(logPath, [
      JSON.stringify(guardSelfTestRecord()),
      '',
      JSON.stringify(first),
      'not-json',
      JSON.stringify(last),
      JSON.stringify({ t: 'decision', toolCallId: 'call_1', toolName: 'read', decision: 'allow', reasonCode: 'in_workspace', relPath: 'notes.md' }),
      ''
    ].join('\n'), 'utf8')

    const parsed = readGuardLog(logPath)
    assert.equal(parsed.present, true)
    assert.equal(parsed.badLines, 1)
    assert.equal(parsed.ready.at, 2, 'the last guard_ready must win')
    assert.equal(parsed.selfTest.failures, 0)
    assert.equal(parsed.decisions.length, 1)
    assert.throws(() => summarizeGuard(parsed, toolEvidenceFor([executionRecord('call_1')]), { allowedTools: ['read'], workspaceReal }), /guard_log_unparsable_lines:1/)

    const cleanLog = { ...parsed, badLines: 0 }
    const summary = summarizeGuard(cleanLog, toolEvidenceFor([executionRecord('call_1')]), { allowedTools: ['read'], workspaceReal })
    assert.equal(summary.loaded, true)
    assert.equal(summary.allowedCount, 1)
    assert.equal(summary.blockedCount, 0)
    assert.equal(summary.unguardedExecutions, 0)
    assert.equal(summary.runId, RUN_ID)
    assert.equal(summary.botId, BOT_ID)

    const reject = (log, toolEvidence, pattern) => {
      assert.throws(() => summarizeGuard(log, toolEvidence, { allowedTools: ['read'], workspaceReal }), pattern)
    }
    const oneExecution = toolEvidenceFor([executionRecord('call_1')])

    reject({ ...cleanLog, ready: null }, oneExecution, /guard_not_loaded/)
    reject({ ...cleanLog, selfTest: null }, oneExecution, /guard_selftest_missing/)
    reject({ ...cleanLog, selfTest: guardSelfTestRecord({ failures: 2 }) }, oneExecution, /guard_selftest_failed:2/)
    reject({ ...cleanLog, ready: guardLogRecord({ workspaceReal, selfTestFailures: 1 }) }, oneExecution, /guard_ready_reports_selftest_failures/)
    reject({ ...cleanLog, ready: guardLogRecord({ workspaceReal, schema: 'loom.runtime.file-guard.v0' }) }, oneExecution, /guard_schema_mismatch/)
    reject({ ...cleanLog, ready: guardLogRecord({ workspaceReal: resolve(root, 'other-ws') }) }, oneExecution, /guard_workspace_mismatch/)
    reject({ ...cleanLog, ready: guardLogRecord({ workspaceReal, allowedTools: ['read', 'write'] }) }, oneExecution, /guard_tools_mismatch/)

    // Decision/execution pairing, both directions.
    reject({ ...cleanLog, decisions: [] }, oneExecution, /execution_without_guard_allow/)
    reject(
      { ...cleanLog, decisions: [{ t: 'decision', toolCallId: 'call_1', toolName: 'read', decision: 'block', reasonCode: 'path_outside_workspace' }] },
      oneExecution,
      /execution_despite_guard_block/
    )
    reject(cleanLog, toolEvidenceFor([]), /guard_allow_without_execution/)

    // Unknown decision values are normalized to `block` and unparsable ids to `null` — never `allow`.
    const normalized = summarizeGuard(
      {
        ...cleanLog,
        decisions: [
          { t: 'decision', toolCallId: 'call_9', toolName: 'read', decision: 'maybe', reasonCode: 7 },
          { t: 'decision', toolCallId: 42, toolName: 'read', decision: 'block' }
        ]
      },
      toolEvidenceFor([]),
      { allowedTools: ['read'], workspaceReal }
    )
    assert.equal(normalized.decisions[0].decision, 'block')
    assert.equal(normalized.decisions[0].reasonCode, 'unknown')
    assert.equal(normalized.decisions[0].relPath, null)
    assert.equal(normalized.decisions[1].toolCallId, null)
    assert.equal(normalized.blockedCount, 2)
    assert.equal(normalized.allowedCount, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// T6 · guard fail-closed grant (in-process, real extension factory)
// ---------------------------------------------------------------------------

test('T6 · guard fail-closed grant: every invalid grant blocks every tool call', { timeout: 30_000 }, async () => {
  const root = freshDir('loom-safety-t6-')
  const workspace = join(root, 'ws')
  mkdirSync(workspace)
  const workspaceReal = realpathSync(workspace)
  const logPath = join(root, 'guard.jsonl')
  const valid = guardConfig({ logPath, workspaceReal })
  const event = toolEvent('read', 'call_grant', { path: 'notes.md' })
  try {
    // (raw config, expected reason code) — the eleven `loadGrant` refusals.
    const cases = [
      [undefined, 'guard_config_missing'],
      ['   ', 'guard_config_missing'],
      ['{not json', 'guard_config_unparsable'],
      ['[]', 'guard_config_not_object'],
      ['null', 'guard_config_not_object'],
      ['"a string"', 'guard_config_not_object'],
      [JSON.stringify({ ...valid, schema: 'wrong.schema.v1' }), 'guard_schema_mismatch'],
      [JSON.stringify({ ...valid, runId: '' }), 'guard_run_id_missing'],
      [JSON.stringify({ ...valid, botId: '' }), 'guard_bot_id_missing'],
      [JSON.stringify({ ...valid, logPath: '' }), 'guard_log_path_missing'],
      [JSON.stringify({ ...valid, workspaceReal: 'relative/ws' }), 'guard_workspace_missing'],
      [JSON.stringify({ ...valid, allowedTools: [] }), 'guard_tools_missing'],
      [JSON.stringify({ ...valid, allowedTools: ['bash'] }), 'guard_tools_not_permitted'],
      [JSON.stringify({ ...valid, expiresAtEpochMs: 0 }), 'guard_expiry_missing'],
      [JSON.stringify({ ...valid, expiresAtEpochMs: 'soon' }), 'guard_expiry_missing']
    ]

    for (const [rawConfig, expected] of cases) {
      const fake = await initGuard(rawConfig)
      const handler = fake.handlers.get('tool_call')
      assert.equal(typeof handler, 'function', `the guard must register a tool_call handler for ${expected}`)
      // Fail-closed handlers are called without a ctx on purpose: no grant means no context trust.
      const outcome = handler(event)
      assert.equal(outcome?.block, true, `${expected} must block the tool call`)
      assert.match(String(outcome.reason), new RegExp(expected), `${expected} must be reported as the block reason`)
    }

    // A fail-closed guard never writes a log, so it can never be mistaken for a guarded run.
    assert.equal(existsSync(logPath), false, 'an invalid grant must not produce guard evidence')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// T7 · guard allow/deny decisions + execution pairing
// ---------------------------------------------------------------------------

test('T7 · guard decisions: allow only inside the workspace, deny escapes, pair with executions', { timeout: 30_000 }, async () => {
  const root = freshDir('loom-safety-t7-')
  const workspace = join(root, 'ws')
  const outside = join(root, 'outside')
  mkdirSync(workspace)
  mkdirSync(outside)
  mkdirSync(join(workspace, 'sub'))
  mkdirSync(join(workspace, 'certs'))
  mkdirSync(join(workspace, '.git'))
  writeFileSync(join(workspace, 'notes.md'), 'in-workspace body\n', 'utf8')
  writeFileSync(join(workspace, 'sub', 'notes.md'), 'nested body\n', 'utf8')
  writeFileSync(join(workspace, '.git', 'config'), 'x', 'utf8')
  writeFileSync(join(workspace, 'id_rsa'), 'x', 'utf8')
  writeFileSync(join(workspace, 'certs', 'key.pem'), 'x', 'utf8')
  writeFileSync(join(workspace, '.env'), 'x', 'utf8')
  writeFileSync(join(outside, 'secret.txt'), 'outside secret\n', 'utf8')

  const workspaceReal = realpathSync(workspace)
  const logPath = join(root, 'guard.jsonl')
  const allowedTools = ['read', 'write']
  try {
    const fake = await initGuard(JSON.stringify(guardConfig({ logPath, workspaceReal })))
    const call = (event, cwd = workspaceReal) => fake.handlers.get('tool_call')(event, { cwd })

    // --- allows: in-workspace regular files, nested, and a new file for `write` ---
    assert.equal(call(toolEvent('read', 'c_read', { path: 'notes.md' })), undefined)
    assert.equal(call(toolEvent('read', 'c_read_nested', { path: 'sub/notes.md' })), undefined)
    assert.equal(call(toolEvent('write', 'c_write_new', { path: 'sub/new.txt', content: 'x' })), undefined)

    // --- denies: tool policy ---
    assert.match(String(call(toolEvent('bash', 'c_bash', { path: 'notes.md' })).reason), /tool_not_allowed/)
    assert.match(String(call(toolEvent('edit', 'c_edit', { path: 'notes.md' })).reason), /tool_not_granted/)

    // --- denies: cwd binding ---
    assert.match(String(call(toolEvent('read', 'c_cwd', { path: 'notes.md' }), outside).reason), /cwd_mismatch/)
    assert.match(String(call(toolEvent('read', 'c_cwd_missing', { path: 'notes.md' }), join(workspace, 'no-such-dir')).reason), /cwd_unresolvable/)

    // --- denies: path escapes and sensitive targets ---
    const denials = [
      ['c_traversal', toolEvent('write', 'c_traversal', { path: '../escape.txt' }), /path_parent_escape/],
      ['c_absolute', toolEvent('read', 'c_absolute', { path: join(outside, 'secret.txt') }), /path_outside_workspace/],
      ['c_git', toolEvent('read', 'c_git', { path: '.git/config' }), /sensitive_path:\.git/],
      ['c_key', toolEvent('read', 'c_key', { path: 'id_rsa' }), /sensitive_path:id_rsa/],
      ['c_pem', toolEvent('read', 'c_pem', { path: 'certs/key.pem' }), /sensitive_path_suffix/],
      ['c_env', toolEvent('read', 'c_env', { path: '.env' }), /sensitive_env_file/],
      ['c_nul', toolEvent('read', 'c_nul', { path: 'notes.md\0' }), /path_nul_byte/],
      ['c_empty', toolEvent('read', 'c_empty', { path: '' }), /path_missing/],
      ['c_root', toolEvent('read', 'c_root', { path: '.' }), /path_is_workspace_root/]
    ]
    for (const [label, event, pattern] of denials) {
      const outcome = call(event)
      assert.equal(outcome?.block, true, `${label} must be blocked`)
      assert.match(String(outcome.reason), pattern, `${label} must report its reason code`)
    }

    // --- direct path policy: platform syntax forms, no filesystem probes (fsMode:false) ---
    const syntaxBlocked = (rawPath, expected) => {
      const outcome = evaluatePath(rawPath, { cwd: workspaceReal, workspaceReal, toolName: 'read', fsMode: false })
      assert.equal(outcome.decision, 'block', `${JSON.stringify(rawPath)} must be blocked`)
      assert.equal(outcome.reasonCode, expected, `${JSON.stringify(rawPath)} must report ${expected}`)
    }
    syntaxBlocked('', 'path_missing')
    syntaxBlocked('notes\0.md', 'path_nul_byte')
    syntaxBlocked('sub/../notes.md', 'path_parent_escape')
    syntaxBlocked('../notes.md', 'path_parent_escape')
    syntaxBlocked('.', 'path_is_workspace_root')
    syntaxBlocked('.git/config', 'sensitive_path:.git')
    syntaxBlocked('.env.local', 'sensitive_env_file')
    if (IS_WIN) {
      // Windows-only path syntax: UNC, device namespace, drive-relative, ADS, device names, trailing
      // dot/space. Portable hosts skip these; the same code runs on Windows CI.
      syntaxBlocked('\\\\server\\share\\x.txt', 'path_unc')
      syntaxBlocked('\\\\?\\C:\\Windows\\win.ini', 'path_device_namespace')
      syntaxBlocked('C:relative.txt', 'path_drive_relative')
      syntaxBlocked('sub\\file.txt:stream', 'path_alternate_data_stream')
      syntaxBlocked('CON', 'path_reserved_device_name')
      syntaxBlocked('sub\\notes.txt ', 'path_trailing_dot_or_space')
    }
    const pureAllow = evaluatePath('sub/notes.md', { cwd: workspaceReal, workspaceReal, toolName: 'read', fsMode: false })
    assert.equal(pureAllow.decision, 'allow')
    assert.equal(pureAllow.reasonCode, 'in_workspace')

    // Nothing escaped: the traversal target and the outside file are untouched.
    assert.equal(existsSync(join(root, 'escape.txt')), false)
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'outside secret\n')

    // --- the log is real evidence and pairs with the allows above ---
    const guardLog = readGuardLog(logPath)
    assert.equal(guardLog.present, true)
    assert.equal(guardLog.badLines, 0)
    assert.equal(guardLog.ready.schema, RUNTIME_GUARD_SCHEMA)
    assert.equal(guardLog.ready.workspaceReal, workspaceReal)
    assert.equal(guardLog.ready.runId, RUN_ID)
    assert.equal(guardLog.ready.botId, BOT_ID)
    assert.equal(guardLog.ready.selfTestFailures, 0)
    assert.equal(guardLog.selfTest.failures, 0)
    assert.ok(guardLog.selfTest.cases >= 10, 'the load-time self-test must have run')

    const allowRead = guardLog.decisions.find((decision) => decision.toolCallId === 'c_read')
    assert.equal(allowRead.decision, 'allow')
    assert.equal(allowRead.reasonCode, 'in_workspace')
    assert.equal(allowRead.relPath, 'notes.md')
    assert.equal(allowRead.pathSha256, sha256('notes.md'), 'the raw path is hashed, and only the relative path is stored')
    const allowWrite = guardLog.decisions.find((decision) => decision.toolCallId === 'c_write_new')
    assert.equal(allowWrite.decision, 'allow')
    assert.equal(allowWrite.reasonCode, 'in_workspace_new_file')
    const blockTraversal = guardLog.decisions.find((decision) => decision.toolCallId === 'c_traversal')
    assert.equal(blockTraversal.decision, 'block')
    assert.equal(blockTraversal.relPath, null, 'an out-of-scope path is never written in plaintext')
    // The outside absolute path never appears in the log.
    assert.equal(readFileSync(logPath, 'utf8').includes('secret.txt'), false)

    // --- pairing: real executions only, and only for allowed calls ---
    const executed = ['c_read', 'c_read_nested', 'c_write_new'].map((id) => executionRecord(id))
    const summary = summarizeGuard(guardLog, toolEvidenceFor(executed), { allowedTools, workspaceReal, runId: RUN_ID, botId: BOT_ID })
    assert.equal(summary.loaded, true)
    assert.equal(summary.unguardedExecutions, 0)
    assert.equal(summary.executedCount, 3)
    assert.ok(summary.allowedCount >= 3)
    assert.ok(summary.blockedCount >= 9)

    assert.throws(
      () => summarizeGuard(guardLog, toolEvidenceFor([...executed, executionRecord('c_traversal', 'write')]), { allowedTools, workspaceReal }),
      /execution_despite_guard_block/,
      'a blocked call that somehow executed must fail the run'
    )
    assert.throws(
      () => summarizeGuard(guardLog, toolEvidenceFor([executionRecord('c_unknown')]), { allowedTools, workspaceReal }),
      /execution_without_guard_allow/
    )
    assert.throws(
      () => summarizeGuard(guardLog, toolEvidenceFor(executed.slice(1)), { allowedTools, workspaceReal }),
      /guard_allow_without_execution/,
      'a guard allow with no execution means the log and the event stream disagree'
    )

    // --- an expired grant blocks even a perfectly valid path ---
    const expired = await initGuard(JSON.stringify(guardConfig({ logPath: join(root, 'expired.jsonl'), workspaceReal, overrides: { expiresAtEpochMs: Date.now() - 1_000 } })))
    const expiredOutcome = expired.handlers.get('tool_call')(toolEvent('read', 'c_expired', { path: 'notes.md' }), { cwd: workspaceReal })
    assert.equal(expiredOutcome?.block, true)
    assert.match(String(expiredOutcome.reason), /grant_expired/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// T8 · explicit artifact hashing
// ---------------------------------------------------------------------------

test('T8 · artifacts: explicit nested hashing, and every secret/escape form is refused', { timeout: 30_000 }, async () => {
  const root = freshDir('loom-safety-t8-')
  const workspace = join(root, 'ws')
  const outside = join(root, 'outside')
  mkdirSync(workspace)
  mkdirSync(outside)
  mkdirSync(join(workspace, 'sub'))
  mkdirSync(join(workspace, 'certs'))
  mkdirSync(join(workspace, '.git'))
  writeFileSync(join(workspace, 'out.txt'), 'artifact body\n', 'utf8')
  writeFileSync(join(workspace, 'sub', 'nested.txt'), 'nested body\n', 'utf8')
  writeFileSync(join(workspace, 'certs', 'key.pem'), 'x', 'utf8')
  writeFileSync(join(workspace, '.env.local'), 'x', 'utf8')
  writeFileSync(join(workspace, 'id_rsa'), 'x', 'utf8')
  writeFileSync(join(workspace, '.git', 'config'), 'x', 'utf8')
  writeFileSync(join(outside, 'secret.txt'), 'outside secret\n', 'utf8')
  try {
    // Positive: only the explicit list is read, nested paths normalize to `/`.
    const artifacts = hashExpectedArtifacts({ workspaceRoot: workspace, expectedArtifactPaths: ['out.txt', 'sub/nested.txt'] })
    assert.equal(artifacts.length, 2)
    assert.deepEqual(artifacts.map((artifact) => artifact.relativePath), ['out.txt', 'sub/nested.txt'])
    assert.equal(artifacts[0].sha256, sha256('artifact body\n'))
    assert.equal(artifacts[0].sizeBytes, 14)
    assert.equal(artifacts[1].sha256, sha256('nested body\n'))
    assert.deepEqual(hashExpectedArtifacts({ workspaceRoot: workspace, expectedArtifactPaths: [] }), [])

    const reject = (paths, pattern) => {
      assert.throws(() => hashExpectedArtifacts({ workspaceRoot: workspace, expectedArtifactPaths: paths }), pattern)
    }
    reject('out.txt', /artifacts_list_must_be_array/)
    reject([''], /artifact_path_invalid/)
    reject([42], /artifact_path_invalid/)
    reject(['notes\0.md'], /artifact_path_nul_byte/)
    reject([join(outside, 'secret.txt')], /artifact_path_must_be_relative/)
    reject(['../escape.txt'], /artifact_path_parent_escape/)
    reject(['sub/../../escape.txt'], /artifact_path_parent_escape/)
    reject(['out.txt', 'out.txt'], /artifact_path_duplicate/)
    reject(['.git/config'], /artifact_path_sensitive/)
    reject(['id_rsa'], /artifact_path_sensitive/)
    reject(['.env'], /artifact_path_sensitive/)
    reject(['.env.local'], /artifact_path_sensitive/)
    reject(['certs/key.pem'], /artifact_path_sensitive_suffix/)
    reject(['missing.txt'], /artifact_path_missing/)
    reject(['.'], /artifact_path_not_regular_file/)
    reject(['sub'], /artifact_path_not_regular_file/)

    assert.throws(() => hashExpectedArtifacts({ workspaceRoot: 'relative/ws', expectedArtifactPaths: [] }), /artifacts_workspaceRoot_must_be_absolute/)
    assert.throws(() => hashExpectedArtifacts({ workspaceRoot: join(root, 'no-such-ws'), expectedArtifactPaths: [] }), /artifacts_workspaceRoot_unresolvable/)

    // A symlink inside the workspace pointing outside is refused, never followed.
    const linkPath = join(workspace, 'link.txt')
    try {
      symlinkSync(join(outside, 'secret.txt'), linkPath, 'file')
      reject(['link.txt'], /artifact_path_symlink/)
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
      // Windows without developer mode cannot create the fixture; the guard-level denial in T7
      // still covers the symlink escape on this host.
    }

    // The outside file was never read into evidence.
    assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'outside secret\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// T9 · guard log-write failure is fail-closed
// ---------------------------------------------------------------------------

test('T9 · guard log write failure: an unrecordable guard refuses instead of allowing', { timeout: 30_000 }, async () => {
  const root = freshDir('loom-safety-t9-')
  const workspace = join(root, 'ws')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'notes.md'), 'body\n', 'utf8')
  const workspaceReal = realpathSync(workspace)
  const event = toolEvent('read', 'call_logfail', { path: 'notes.md' })
  try {
    // (a) The log directory does not exist: BOTH startup records fail, so the run is unguarded.
    const unwritableLog = join(root, 'no-such-dir', 'guard.jsonl')
    const startupFake = await initGuard(JSON.stringify(guardConfig({ logPath: unwritableLog, workspaceReal })))
    const startupOutcome = startupFake.handlers.get('tool_call')(event, { cwd: workspaceReal })
    assert.equal(startupOutcome?.block, true, 'a guard that cannot write its own evidence must block')
    assert.match(String(startupOutcome.reason), /guard_log_write_failed/)
    assert.equal(existsSync(unwritableLog), false)

    // (b) Startup succeeds, then the log destination disappears: an otherwise-allowable decision
    //     must still be refused, because an unrecordable allow is indistinguishable from no guard.
    const logDir = join(root, 'logdir')
    mkdirSync(logDir)
    const lateLog = join(logDir, 'guard.jsonl')
    const lateFake = await initGuard(JSON.stringify(guardConfig({ logPath: lateLog, workspaceReal })))
    assert.equal(readGuardLog(lateLog).present, true, 'startup records must have been written')
    assert.equal(lateFake.handlers.get('tool_call')(event, { cwd: workspaceReal }), undefined, 'the same call is allowed while the log is writable')

    let removed = true
    try {
      rmSync(logDir, { recursive: true, force: true })
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EACCES' && error?.code !== 'EBUSY') throw error
      removed = false
    }
    if (removed) {
      const lateOutcome = lateFake.handlers.get('tool_call')(toolEvent('read', 'call_late', { path: 'notes.md' }), { cwd: workspaceReal })
      assert.equal(lateOutcome?.block, true, 'an unrecordable allow must be refused')
      assert.match(String(lateOutcome.reason), /guard_log_write_failed/)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// T10 · guard ↔ run binding (post-run and pre-prompt gates)
// ---------------------------------------------------------------------------

test('T10 · run binding: guard_ready must belong to this run, before and after the prompt', { timeout: 30_000 }, async () => {
  const root = freshDir('loom-safety-t10-')
  const workspace = join(root, 'ws')
  mkdirSync(workspace)
  const workspaceReal = realpathSync(workspace)
  const logPath = join(root, 'guard.jsonl')
  const allowedTools = ['read']
  try {
    const ready = guardLogRecord({ workspaceReal, allowedTools, pid: process.pid, ppid: 1 })
    const guardLog = { present: true, ready, selfTest: guardSelfTestRecord(), decisions: [], badLines: 0 }

    // --- post-run gate: mismatched NON-NULL strings are rejected ---
    assert.throws(
      () => summarizeGuard(guardLog, toolEvidenceFor([]), { allowedTools, workspaceReal, runId: 'run-other-2', botId: BOT_ID }),
      /guard_run_id_mismatch/
    )
    assert.throws(
      () => summarizeGuard(guardLog, toolEvidenceFor([]), { allowedTools, workspaceReal, runId: RUN_ID, botId: 'bot_other' }),
      /guard_bot_id_mismatch/
    )
    // The legacy two-key call shape (no binding requested) still works, but the binding is echoed.
    const unbound = summarizeGuard(guardLog, toolEvidenceFor([]), { allowedTools, workspaceReal })
    assert.equal(unbound.runId, RUN_ID)
    assert.equal(unbound.botId, BOT_ID)

    // --- pre-prompt gate: the same binding, enforced BEFORE any prompt is sent ---
    const expected = { runId: RUN_ID, botId: BOT_ID, workspaceReal, allowedTools, spawnedPid: process.pid }
    const verified = assertPrePromptGuard(guardLog, expected)
    assert.equal(verified.prePromptVerified, true)
    assert.equal(verified.pidMatches, true)
    assert.equal(verified.selfTestFailures, 0)

    // The native launcher may re-exec the bundled node, so a direct child also counts.
    const childGuard = { ...guardLog, ready: { ...ready, pid: 999_999, ppid: process.pid } }
    const childVerified = assertPrePromptGuard(childGuard, expected)
    assert.equal(childVerified.pidMatches, false)
    assert.equal(childVerified.ppidMatches, true)

    const preReject = (log, patch, pattern) => {
      assert.throws(() => assertPrePromptGuard(log, { ...expected, ...patch }), pattern)
    }
    preReject({ ...guardLog, ready: null }, {}, /guard_ready_missing_before_prompt/)
    preReject({ ...guardLog, selfTest: null }, {}, /guard_selftest_missing_before_prompt/)
    preReject({ ...guardLog, selfTest: guardSelfTestRecord({ failures: 1 }) }, {}, /guard_selftest_failed_before_prompt:1/)
    preReject({ ...guardLog, ready: { ...ready, selfTestFailures: 1 } }, {}, /guard_ready_selftest_failures_before_prompt/)
    preReject({ ...guardLog, ready: { ...ready, schema: 'wrong.v1' } }, {}, /guard_schema_mismatch_before_prompt/)
    preReject(guardLog, { runId: 'run-other-2' }, /guard_run_id_mismatch_before_prompt/)
    preReject(guardLog, { botId: 'bot_other' }, /guard_bot_id_mismatch_before_prompt/)
    preReject(guardLog, { workspaceReal: resolve(root, 'other-ws') }, /guard_workspace_mismatch_before_prompt/)
    preReject(guardLog, { allowedTools: ['read', 'write'] }, /guard_tools_mismatch_before_prompt/)
    // A guard from another process tree cannot vouch for this run.
    preReject({ ...guardLog, ready: { ...ready, pid: 111_111, ppid: 222_222 } }, {}, /guard_pid_mismatch_before_prompt/)
    // A null/missing run id is a mismatch too — `undefined` is the only "do not check" value, and the
    // pre-prompt gate is strict (it compares with `!==`, never with a truthiness test).
    preReject(guardLog, { runId: null }, /guard_run_id_mismatch_before_prompt/)

    // --- waitForFreshGuardReady: a real log file resolves; a missing one times out fail-closed ---
    writeFileSync(logPath, `${JSON.stringify(guardSelfTestRecord())}\n${JSON.stringify(ready)}\n`, 'utf8')
    const fresh = await waitForFreshGuardReady({ guardLogPath: logPath, timeoutMs: 2_000, pollMs: 10 })
    assert.equal(fresh.ready.runId, RUN_ID)
    await assert.rejects(
      waitForFreshGuardReady({ guardLogPath: join(root, 'never-written.jsonl'), timeoutMs: 120, pollMs: 10 }),
      /guard_ready_missing_before_prompt/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

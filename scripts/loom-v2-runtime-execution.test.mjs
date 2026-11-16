// LOOM V2 — tests for the authorized per-run Pi execution entry + the native file guard.
//
// Run (Root, from loom/):  node --test --test-force-exit --test-timeout=420000 scripts/loom-v2-runtime-execution.test.mjs
//
// Coverage contract (Root review 2026-11-16):
//   1  grant contract        — runId/botId grammar, absolute workspace, tool allowlist, expiry window
//   2  model config          — https external vs http loopback mock, no embedded credentials/query,
//                              env-var-name-only credential, missing env fails closed
//   3  launch contract       — exact flags, `--tools` subset enforced, NO `--no-tools`, explicit
//                              `--extension <guard.ts>`, no `--approve`/`--no-approve`
//   4  env contract          — only the authorized credential is injected, guard config present,
//                              PI_CODING_AGENT_DIR forced to the private agent dir
//   5  profile contract      — apiKey stored as `$ENV_VAR`, no literal secret on disk, no auth.json
//   6  isolation contract    — agentDir inside the temp root, workspace overlap / ~/.pi refused
//   7  artifact contract     — only explicit relative in-workspace regular files; absolute, `..`,
//                              sensitive, symlink, missing and duplicate all rejected
//   8  execution extraction  — model `toolcall_start` intention is NOT an execution; start without
//                              end is unfinished; toolResult linking is reported
//   9  guard cross-check     — missing guard / failed self-test / execution-without-allow /
//                              allow-without-execution all throw (never a warning)
//   10 real Pi + guard       — mock provider: guard loads, self-test 0 failures, provider sees exactly
//                              the granted tool schema, run settles, artifact hashed, temp root removed
//   11 real Pi + guard, real tool calls — out-of-scope write/read are blocked and NOT executed
//                              (no file created, no execution event), in-scope write+read execute
//   12 timeout               — status unknown_outcome, replayable:false, process stopped
//
// No test reaches the public internet, a real model, the user's ~/.pi, a user database or a real
// credential. Every Pi state lives in mkdtemp dirs; the guard log is read back as evidence.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  API_KEY_ENV_PATTERN,
  RUNTIME_EXECUTION_SCHEMA,
  RUNTIME_GUARD_ENV,
  RUNTIME_GUARD_SCHEMA,
  RUNTIME_TOOL_ALLOWLIST,
  RUN_STATUSES,
  assertAuthorizedModelConfig,
  assertPerRunGrant,
  assertPrePromptGuard,
  assertRunIsolation,
  buildAuthorizedEnv,
  buildAuthorizedPiArgv,
  defaultGuardPath,
  extractToolExecutions,
  hashExpectedArtifacts,
  classifyRpcEvent,
  isRunReplayable,
  resolveRunStatus,
  RETAINED_RPC_EVENT_TYPES,
  readGuardLog,
  resolveApiKeyValue,
  runAuthorizedExecution,
  sanitizeDiagnosticText,
  summarizeGuard,
  waitForFreshGuardReady,
  writeAuthorizedProfile
} from './loom-v2-runtime-execution.mjs'
import { DUMMY_API_KEY, MOCK_MODEL_ID, createLoopbackProvider } from './loom-v2-pi-loopback-provider.mjs'

const MOCK_KEY_ENV = 'LOOM_RUN_MOCK_KEY'
// The loopback fixture provider only accepts its own dummy bearer, so the env-referenced mock
// credential IS that dummy value. It is still injected by env reference only, never written to disk.
const MOCK_KEY_VALUE = DUMMY_API_KEY
const REAL_PI_TIMEOUT_MS = 240_000
const REAL_PI_SUPPORTED = process.platform === 'win32'
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function freshDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function mockModel(port, overrides = {}) {
  return {
    providerId: 'loom-mock',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    modelId: MOCK_MODEL_ID,
    api: 'openai-completions',
    apiKeyEnvVar: MOCK_KEY_ENV,
    ...overrides
  }
}

function withMockKey(callback) {
  const previous = process.env[MOCK_KEY_ENV]
  process.env[MOCK_KEY_ENV] = MOCK_KEY_VALUE
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      if (previous === undefined) delete process.env[MOCK_KEY_ENV]
      else process.env[MOCK_KEY_ENV] = previous
    })
}

// ---------------------------------------------------------------------------
// A scripted OpenAI-compatible SSE provider (test-local fixture only).
//
// It exists because the accepted loopback provider always answers with fixed text and therefore can
// never exercise a real tool call. Steps are consumed in order; when the script is exhausted the
// provider answers with plain text so the agent can settle. `stall` never answers at all.
// ---------------------------------------------------------------------------

async function createScriptedProvider(steps = []) {
  const requests = []
  const sockets = new Set()
  let closed = false
  const queue = [...steps]

  const server = createServer((req, res) => {
    if (closed) {
      res.writeHead(503, { connection: 'close' }).end('{"error":"closed"}')
      return
    }
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400, { connection: 'close' }).end('{"error":"bad_json"}')
        return
      }
      const toolNames = Array.isArray(body.tools)
        ? body.tools.map((tool) => tool?.function?.name ?? tool?.name ?? null).filter((name) => typeof name === 'string')
        : []
      requests.push({
        seq: requests.length + 1,
        model: typeof body.model === 'string' ? body.model : null,
        toolNames,
        messageRoles: Array.isArray(body.messages) ? body.messages.map((message) => message?.role ?? null) : []
      })

      const step = queue.shift() ?? { type: 'text', text: 'scripted final answer' }
      if (step.type === 'stall') return

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive'
      })
      const base = { id: `chatcmpl-scripted-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: body.model ?? 'scripted' }
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`)

      if (step.type === 'tool_call') {
        send({
          ...base,
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [{
                index: 0,
                id: step.toolCallId ?? `call_${requests.length}`,
                type: 'function',
                function: { name: step.toolName, arguments: JSON.stringify(step.args ?? {}) }
              }]
            },
            finish_reason: null
          }]
        })
        send({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }
        })
      } else {
        const text = String(step.text ?? 'scripted final answer')
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })
        send({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 8, completion_tokens: text.length, total_tokens: 8 + text.length }
        })
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  return {
    port: address.port,
    requests,
    close: async () => {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise((resolveClose) => server.close(() => resolveClose(true)))
    }
  }
}

// ---------------------------------------------------------------------------
// 1 · grant contract
// ---------------------------------------------------------------------------

test('1 · grant contract: identifiers, absolute workspace, tool allowlist, expiry window', { timeout: 20_000 }, () => {
  const workspace = freshDir('loom-grant-ws-')
  const base = {
    runId: 'run-authorized-1',
    botId: 'bot_main',
    workspaceRoot: workspace,
    allowedTools: ['read'],
    expiresAt: Date.now() + 60_000
  }
  const granted = assertPerRunGrant(base)
  assert.equal(granted.runId, 'run-authorized-1')
  assert.equal(granted.botId, 'bot_main')
  assert.deepEqual([...granted.allowedTools], ['read'])
  assert.match(granted.grantSha256, /^[0-9a-f]{64}$/)

  const reject = (patch, pattern) => {
    assert.throws(() => assertPerRunGrant({ ...base, ...patch }), pattern)
  }
  reject({ runId: '' }, /grant_runId_invalid/)
  reject({ runId: 'x' }, /grant_runId_invalid/)
  reject({ botId: 'has space' }, /grant_botId_invalid/)
  reject({ workspaceRoot: 'relative/dir' }, /grant_workspaceRoot_must_be_absolute/)
  reject({ allowedTools: [] }, /grant_allowedTools_must_be_non_empty_array/)
  reject({ allowedTools: ['bash'] }, /grant_tool_not_permitted/)
  reject({ allowedTools: ['read', 'read'] }, /grant_allowedTools_has_duplicates/)
  reject({ expiresAt: 'not-a-date' }, /grant_expiresAt_invalid/)
  reject({ expiresAt: Date.now() - 1_000 }, /grant_expired/)
  reject({ expiresAt: Date.now() + 48 * 60 * 60 * 1000 }, /grant_window_too_long/)
  assert.throws(() => assertPerRunGrant(null), /grant_must_be_object/)
  // Read-only is the default posture: write/edit need an explicitly isolated, self-owned workspace.
  assert.throws(
    () => assertPerRunGrant({ ...base, allowedTools: ['write'] }),
    /grant_write_requires_isolated_self_owned_workspace/
  )
  assert.throws(
    () => assertPerRunGrant({ ...base, allowedTools: ['read', 'edit'] }),
    /grant_write_requires_isolated_self_owned_workspace/
  )
  assert.throws(
    () => assertPerRunGrant({ ...base, allowedTools: ['write'], isolatedSelfOwnedWorkspace: 'yes' }),
    /grant_write_requires_isolated_self_owned_workspace/
  )
  const writable = assertPerRunGrant({ ...base, allowedTools: ['read', 'write'], isolatedSelfOwnedWorkspace: true })
  assert.equal(writable.workspaceOwnership, 'isolated-self-owned')
  assert.equal(assertPerRunGrant(base).workspaceOwnership, 'read-only-grant')
  // The hard cap: nothing outside read/write/edit is ever representable in a grant.
  assert.deepEqual([...RUNTIME_TOOL_ALLOWLIST], ['read', 'write', 'edit'])
})

// ---------------------------------------------------------------------------
// 2 · model configuration
// ---------------------------------------------------------------------------

test('2 · model config: mock vs external classification, env-var-only credential, fail closed', { timeout: 20_000 }, () => {
  const mock = assertAuthorizedModelConfig(mockModel(41234))
  assert.equal(mock.providerConnection, 'loopback-mock')
  assert.equal(mock.mockProvider, true)

  const external = assertAuthorizedModelConfig({
    providerId: 'deepseek',
    baseUrl: 'https://api.example.invalid/v1',
    modelId: 'deepseek-v4.1-flash',
    api: 'openai-completions',
    apiKeyEnvVar: 'LOOM_RUN_REAL_KEY'
  })
  assert.equal(external.providerConnection, 'external')
  assert.equal(external.mockProvider, false)
  assert.equal(external.declaredModelId ?? external.modelId, 'deepseek-v4.1-flash')

  const reject = (patch, pattern) => {
    assert.throws(() => assertAuthorizedModelConfig({ ...mockModel(41234), ...patch }), pattern)
  }
  // http is only ever a loopback mock; https loopback is ambiguous and refused.
  reject({ baseUrl: 'http://api.example.invalid/v1', providerId: 'deepseek' }, /model_baseUrl_http_must_be_loopback/)
  reject({ baseUrl: 'https://127.0.0.1:4444/v1', providerId: 'deepseek' }, /model_baseUrl_https_loopback_ambiguous/)
  // A loopback endpoint must declare a mock provider id and vice versa.
  reject({ providerId: 'deepseek' }, /model_loopback_endpoint_requires_mock_provider_id/)
  reject({ baseUrl: 'https://api.example.invalid/v1' }, /model_external_endpoint_must_not_use_mock_provider_id/)
  // Credentials must never ride inside the URL, and no query/hash is carried into evidence.
  reject({ baseUrl: 'https://user:pass@api.example.invalid/v1', providerId: 'deepseek' }, /model_baseUrl_must_not_embed_credentials/)
  reject({ baseUrl: 'https://api.example.invalid/v1?key=1', providerId: 'deepseek' }, /model_baseUrl_must_not_carry_query_or_hash/)
  reject({ apiKeyEnvVar: 'lowercase_name' }, /model_apiKeyEnvVar_invalid/)
  reject({ apiKeyEnvVar: 'LOOM-KEY' }, /model_apiKeyEnvVar_invalid/)
  reject({ api: 'anthropic-messages' }, /model_api_must_be_openai_completions/)
  reject({ modelId: 'bad model id' }, /model_modelId_invalid/)
  reject({ baseUrl: 'ftp://api.example.invalid' }, /model_baseUrl_protocol_not_permitted/)
  assert.match(API_KEY_ENV_PATTERN.source, /\[A-Z\]/)

  // The credential is read by NAME from the caller's env, and a missing value fails closed.
  assert.equal(resolveApiKeyValue(external, { env: { LOOM_RUN_REAL_KEY: 'a-real-looking-key-value' } }), 'a-real-looking-key-value')
  assert.throws(() => resolveApiKeyValue(external, { env: {} }), /credential_env_missing/)
  assert.throws(() => resolveApiKeyValue(external, { env: { LOOM_RUN_REAL_KEY: 'short' } }), /credential_env_value_invalid/)
  assert.throws(() => resolveApiKeyValue(external, { env: { LOOM_RUN_REAL_KEY: 'has space in it' } }), /credential_env_value_invalid/)
})

// ---------------------------------------------------------------------------
// 3 · launch contract
// ---------------------------------------------------------------------------

test('3 · launch contract: exact flags, tool subset, explicit guard extension, no --no-tools', { timeout: 20_000 }, () => {
  const guardPath = defaultGuardPath()
  assert.ok(guardPath.endsWith('loom-v2-runtime-file-guard.ts'))
  const args = buildAuthorizedPiArgv({ guardPath, tools: ['read', 'write'] })

  assert.deepEqual(args.slice(0, 2), ['--mode', 'rpc'])
  assert.ok(args.includes('--offline'))
  assert.ok(args.includes('--no-session'))
  assert.ok(args.includes('--no-context-files'))
  assert.ok(args.includes('--no-skills'))
  assert.ok(args.includes('--no-extensions'), 'auto-discovery must be off; the guard is explicit')
  assert.equal(args[args.indexOf('--tools') + 1], 'read,write')
  assert.equal(args[args.indexOf('--extension') + 1], guardPath)
  assert.equal(args.includes('--no-tools'), false, '--no-tools would contradict the granted tools')
  assert.equal(args.includes('--approve'), false, 'project trust is not an authorization mechanism')
  assert.equal(args.includes('--no-approve'), false, 'project trust is not an authorization mechanism')

  assert.throws(() => buildAuthorizedPiArgv({ guardPath, tools: ['bash'] }), /tool_not_permitted/)
  assert.throws(() => buildAuthorizedPiArgv({ guardPath, tools: [] }), /tools_must_be_non_empty_array/)
  assert.throws(() => buildAuthorizedPiArgv({ guardPath: 'relative.ts', tools: ['read'] }), /guard_path_must_be_absolute/)
  assert.throws(() => buildAuthorizedPiArgv({ guardPath: '/tmp/guard.js', tools: ['read'] }), /guard_path_must_be_typescript_extension/)
})

// ---------------------------------------------------------------------------
// 4 · env contract
// ---------------------------------------------------------------------------

test('4 · env contract: only the authorized credential is injected; guard config and agent dir are forced', { timeout: 20_000 }, () => {
  const agentDir = freshDir('loom-env-agent-')
  const model = assertAuthorizedModelConfig(mockModel(41235))
  const guardConfig = { schema: RUNTIME_GUARD_SCHEMA, logPath: join(agentDir, 'guard.jsonl') }
  const env = buildAuthorizedEnv({
    agentDir,
    model,
    apiKeyValue: MOCK_KEY_VALUE,
    guardConfig,
    baseEnv: {
      PATH: '/usr/bin',
      HOME: '/home/someone',
      ANTHROPIC_API_KEY: 'should-never-appear',
      OPENAI_API_KEY: 'should-never-appear',
      GITHUB_TOKEN: 'should-never-appear'
    }
  })
  assert.equal(env.PI_CODING_AGENT_DIR, agentDir)
  assert.equal(env.PI_TELEMETRY, '0')
  assert.equal(env[MOCK_KEY_ENV], MOCK_KEY_VALUE)
  assert.equal(JSON.parse(env[RUNTIME_GUARD_ENV]).schema, RUNTIME_GUARD_SCHEMA)
  for (const forbidden of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN']) {
    assert.equal(Object.prototype.hasOwnProperty.call(env, forbidden), false, `${forbidden} must not be inherited`)
  }
  const filteredEnv = buildAuthorizedEnv({
    agentDir, model, apiKeyValue: MOCK_KEY_VALUE, guardConfig,
    baseEnv: { SOME_API_KEY: 'x' }
  })
  assert.equal(Object.hasOwn(filteredEnv, 'SOME_API_KEY'), false, 'inherited credentials are filtered before launch')
  // And a caller that tries to smuggle a second credential through the explicit channel is refused.
  assert.throws(
    () => buildAuthorizedEnv({ agentDir, model, apiKeyValue: MOCK_KEY_VALUE, guardConfig, additionalEnv: { SOME_API_KEY: 'x' } }),
    /env_credential_not_authorized/
  )
})

// ---------------------------------------------------------------------------
// 5 · profile contract
// ---------------------------------------------------------------------------

test('5 · profile contract: apiKey is an env reference, no literal secret on disk, no auth.json', { timeout: 20_000 }, async () => {
  const agentDir = freshDir('loom-profile-')
  const model = assertAuthorizedModelConfig(mockModel(41236))
  const profile = await writeAuthorizedProfile({ agentDir, model })

  const modelsText = readFileSync(profile.modelsPath, 'utf8')
  const settingsText = readFileSync(profile.settingsPath, 'utf8')
  assert.equal(modelsText.includes(`"apiKey": "$${MOCK_KEY_ENV}"`), true)
  assert.equal(modelsText.includes(MOCK_KEY_VALUE), false, 'the literal credential must never be written')
  assert.equal(JSON.parse(modelsText).providers['loom-mock'].api, 'openai-completions')
  assert.deepEqual(JSON.parse(settingsText), { defaultProvider: 'loom-mock', defaultModel: MOCK_MODEL_ID })
  assert.equal(existsSync(join(agentDir, 'auth.json')), false, 'no auth.json is ever written')
  assert.deepEqual(readdirSync(agentDir).sort(), ['models.json', 'settings.json'])
  assert.equal(profile.apiKeyIsEnvReference, true)
  assert.equal(profile.authFileWritten, false)
  assert.equal(profile.modelsSha256, sha256(modelsText))
})

// ---------------------------------------------------------------------------
// 6 · isolation contract
// ---------------------------------------------------------------------------

test('6 · isolation contract: agentDir inside the temp root; workspace overlap and ~/.pi refused', { timeout: 20_000 }, async () => {
  const tempRoot = freshDir('loom-iso-root-')
  const agentDir = join(tempRoot, 'agent')
  mkdirSync(agentDir)
  const workspace = freshDir('loom-iso-ws-')
  const home = freshDir('loom-iso-home-')
  mkdirSync(join(home, '.pi'))

  const ok = assertRunIsolation({ tempRoot, agentDir, workspaceRoot: workspace, homeDir: home })
  assert.equal(ok.workspaceReal, resolve(workspace))

  assert.throws(() => assertRunIsolation({ tempRoot, agentDir, workspaceRoot: tempRoot, homeDir: home }), /isolation_workspace_and_tempRoot_overlap/)
  assert.throws(() => assertRunIsolation({ tempRoot, agentDir, workspaceRoot: join(tempRoot, 'agent'), homeDir: home }), /isolation_workspace_and_tempRoot_overlap/)
  assert.throws(() => assertRunIsolation({ tempRoot, agentDir, workspaceRoot: join(home, '.pi'), homeDir: home }), /forbidden_user_pi/)
  assert.throws(() => assertRunIsolation({ tempRoot, agentDir, workspaceRoot: home, homeDir: home }), /isolation_workspace_covers_home/)
  assert.throws(() => assertRunIsolation({ tempRoot, agentDir: tempRoot, workspaceRoot: workspace, homeDir: home }), /isolation_agentDir_must_be_below_tempRoot/)
  // agentDir genuinely OUTSIDE the temp root is refused for the right reason.
  const outsideAgent = freshDir('loom-iso-agent-outside-')
  assert.throws(() => assertRunIsolation({ tempRoot, agentDir: outsideAgent, workspaceRoot: workspace, homeDir: home }), /isolation_agentDir_outside_tempRoot/)
  assert.throws(() => assertRunIsolation({ tempRoot, agentDir, workspaceRoot: join(workspace, 'missing'), homeDir: home }), /isolation_workspaceRoot_missing/)

  // A symlinked workspace is refused outright (a junction would be the same escape).
  const linkParent = freshDir('loom-iso-link-')
  const link = join(linkParent, 'linked-ws')
  try {
    symlinkSync(workspace, link, 'junction')
    assert.throws(() => assertRunIsolation({ tempRoot, agentDir, workspaceRoot: link, homeDir: home }), /isolation_workspaceRoot_symlink/)
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
  }
  await rm(tempRoot, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
  await rm(outsideAgent, { recursive: true, force: true })
  await rm(linkParent, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 7 · artifact contract
// ---------------------------------------------------------------------------

test('7 · artifact contract: explicit relative in-workspace regular files only', { timeout: 20_000 }, async () => {
  const workspace = freshDir('loom-artifacts-')
  writeFileSync(join(workspace, 'out.txt'), 'artifact body\n', 'utf8')
  mkdirSync(join(workspace, '.git'))
  writeFileSync(join(workspace, '.git', 'config'), 'x', 'utf8')
  writeFileSync(join(workspace, 'id_rsa'), 'x', 'utf8')
  const outside = freshDir('loom-artifacts-outside-')
  writeFileSync(join(outside, 'secret.txt'), 'x', 'utf8')

  const artifacts = hashExpectedArtifacts({ workspaceRoot: workspace, expectedArtifactPaths: ['out.txt'] })
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].relativePath, 'out.txt')
  assert.equal(artifacts[0].sha256, sha256('artifact body\n'))
  assert.equal(artifacts[0].sizeBytes, 14)
  assert.deepEqual(hashExpectedArtifacts({ workspaceRoot: workspace, expectedArtifactPaths: [] }), [])

  const reject = (paths, pattern) => {
    assert.throws(() => hashExpectedArtifacts({ workspaceRoot: workspace, expectedArtifactPaths: paths }), pattern)
  }
  reject([join(outside, 'secret.txt')], /artifact_path_must_be_relative/)
  reject(['../escape.txt'], /artifact_path_parent_escape/)
  reject(['.git/config'], /artifact_path_sensitive/)
  reject(['id_rsa'], /artifact_path_sensitive/)
  reject(['missing.txt'], /artifact_path_missing/)
  reject(['out.txt', 'out.txt'], /artifact_path_duplicate/)
  reject(['.'], /artifact_path_not_regular_file/)

  const linkTarget = join(workspace, 'link.txt')
  try {
    symlinkSync(join(outside, 'secret.txt'), linkTarget, 'file')
    reject(['link.txt'], /artifact_path_symlink/)
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
  }

  // A hardlink is invisible to lstat/realpath: only the link count reveals it.
  const hardTarget = join(workspace, 'hard.txt')
  let hardlinkCreated = false
  try {
    linkSync(join(outside, 'secret.txt'), hardTarget)
    hardlinkCreated = true
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
  }
  if (hardlinkCreated) {
    reject(['hard.txt'], /artifact_path_hardlink/)
    // The very same bytes written as a normal file are still accepted (positive control).
    writeFileSync(join(workspace, 'copy.txt'), readFileSync(join(outside, 'secret.txt')))
    assert.equal(hashExpectedArtifacts({ workspaceRoot: workspace, expectedArtifactPaths: ['copy.txt'] }).length, 1)
  } else {
    // Explicit, never silent: hardlink creation was refused by this filesystem.
    assert.ok(true, 'hardlink creation not permitted here (EPERM/EACCES); hardlink artifact case skipped')
  }

  await rm(workspace, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 8 · execution extraction
// ---------------------------------------------------------------------------

test('8 · execution extraction: intentions are not executions; unfinished calls stay unfinished', { timeout: 20_000 }, () => {
  const events = [
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start' } },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end' } },
    { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'read', args: { path: 'in.txt' } },
    { type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'read', result: { content: 'x' }, isError: false },
    { type: 'message_end', message: { role: 'toolResult', toolCallId: 'call_1', isError: false } },
    { type: 'tool_execution_start', toolCallId: 'call_2', toolName: 'write', args: { path: 'out.txt', content: 'y' } }
  ]
  const evidence = extractToolExecutions(events)
  assert.equal(evidence.executions.length, 2)
  assert.equal(evidence.modelToolcallIntentions, 1, 'the model intention is counted separately, never as an execution')
  assert.equal(evidence.executedCount, 1)
  assert.equal(evidence.unfinishedCount, 1)
  assert.equal(evidence.toolResultCount, 1)
  const read = evidence.executions.find((execution) => execution.toolCallId === 'call_1')
  assert.equal(read.finished, true)
  assert.equal(read.toolResultLinked, true)
  assert.match(read.argsSha256, /^[0-9a-f]{64}$/)
  assert.match(read.resultSha256, /^[0-9a-f]{64}$/)
  const write = evidence.executions.find((execution) => execution.toolCallId === 'call_2')
  assert.equal(write.finished, false)
  assert.equal(write.resultSha256, null)
  // Payload text is never carried: only digests and byte counts.
  assert.equal(JSON.stringify(evidence).includes('in.txt'), false)
  assert.equal(JSON.stringify(evidence).includes('out.txt'), false)
})

// ---------------------------------------------------------------------------
// 9 · guard cross-check
// ---------------------------------------------------------------------------

test('9 · guard cross-check: missing guard, failed self-test and unguarded executions all throw', { timeout: 20_000 }, () => {
  const allowedTools = ['read']
  const workspaceReal = resolve(freshDir('loom-guardcheck-'))
  const baseReady = {
    t: 'guard_ready',
    schema: RUNTIME_GUARD_SCHEMA,
    workspaceReal,
    allowedTools,
    selfTestFailures: 0
  }
  const baseSelfTest = { t: 'guard_selftest', cases: 16, failures: 0 }
  const execution = { toolCallId: 'call_1', toolName: 'read', finished: true }
  const toolEvidence = { executions: [execution], executedCount: 1, unfinishedCount: 0, toolResultCount: 1, modelToolcallIntentions: 0 }

  const okLog = {
    present: true,
    ready: baseReady,
    selfTest: baseSelfTest,
    decisions: [{ t: 'decision', toolCallId: 'call_1', toolName: 'read', decision: 'allow', reasonCode: 'in_workspace' }],
    badLines: 0
  }
  const summary = summarizeGuard(okLog, toolEvidence, { allowedTools, workspaceReal })
  assert.equal(summary.loaded, true)
  assert.equal(summary.allowedCount, 1)
  assert.equal(summary.unguardedExecutions, 0)

  assert.throws(() => summarizeGuard({ ...okLog, present: false, ready: null }, toolEvidence, { allowedTools, workspaceReal }), /guard_not_loaded/)
  assert.throws(() => summarizeGuard({ ...okLog, ready: null }, toolEvidence, { allowedTools, workspaceReal }), /guard_not_loaded/)
  assert.throws(() => summarizeGuard({ ...okLog, selfTest: { ...baseSelfTest, failures: 2 } }, toolEvidence, { allowedTools, workspaceReal }), /guard_selftest_failed/)
  assert.throws(() => summarizeGuard({ ...okLog, selfTest: null }, toolEvidence, { allowedTools, workspaceReal }), /guard_selftest_missing/)
  assert.throws(() => summarizeGuard({ ...okLog, badLines: 1 }, toolEvidence, { allowedTools, workspaceReal }), /guard_log_unparsable_lines/)
  assert.throws(() => summarizeGuard({ ...okLog, ready: { ...baseReady, workspaceReal: resolve(tmpdir()) } }, toolEvidence, { allowedTools, workspaceReal }), /guard_workspace_mismatch/)
  assert.throws(() => summarizeGuard({ ...okLog, ready: { ...baseReady, allowedTools: ['read', 'write'] } }, toolEvidence, { allowedTools, workspaceReal }), /guard_tools_mismatch/)
  // An executed tool without a guard allow is a hard failure, never a warning.
  assert.throws(() => summarizeGuard({ ...okLog, decisions: [] }, toolEvidence, { allowedTools, workspaceReal }), /execution_without_guard_allow/)
  assert.throws(
    () => summarizeGuard({
      ...okLog,
      decisions: [{ t: 'decision', toolCallId: 'call_1', toolName: 'read', decision: 'block', reasonCode: 'path_outside_workspace' }]
    }, toolEvidence, { allowedTools, workspaceReal }),
    /execution_despite_guard_block/
  )
  // A guard allow with no execution means the log and the event stream disagree.
  assert.throws(
    () => summarizeGuard(okLog, { ...toolEvidence, executions: [], executedCount: 0 }, { allowedTools, workspaceReal }),
    /guard_allow_without_execution/
  )
  assert.equal(readGuardLog(join(tmpdir(), 'definitely-missing-guard-log.jsonl')).present, false)
})

// ---------------------------------------------------------------------------
// 9b · pre-prompt guard gate (must refuse BEFORE any model request)
// ---------------------------------------------------------------------------

test('9b · pre-prompt gate: missing/mismatched guard refuses before the prompt is sent', { timeout: 30_000 }, async () => {
  const dir = freshDir('loom-preprompt-')
  const guardLogPath = join(dir, 'guard.jsonl')
  const workspaceReal = resolve(dir)
  const expected = {
    runId: 'run-preprompt',
    botId: 'bot_worker_a',
    workspaceReal,
    allowedTools: ['read'],
    spawnedPid: 4242
  }

  // No log at all => refuse (Pi kept running with no guard).
  await assert.rejects(waitForFreshGuardReady({ guardLogPath, timeoutMs: 150, pollMs: 25 }), /guard_ready_missing_before_prompt/)

  const readyRecord = {
    t: 'guard_ready',
    at: Date.now(),
    pid: 4242,
    ppid: 1,
    runId: 'run-preprompt',
    botId: 'bot_worker_a',
    schema: RUNTIME_GUARD_SCHEMA,
    workspaceReal,
    allowedTools: ['read'],
    expiresAtEpochMs: Date.now() + 60_000,
    selfTestFailures: 0
  }
  const selfTestRecord = { t: 'guard_selftest', at: Date.now(), cases: 14, failures: 0 }
  writeFileSync(guardLogPath, `${JSON.stringify(selfTestRecord)}\n${JSON.stringify(readyRecord)}\n`, 'utf8')

  const log = await waitForFreshGuardReady({ guardLogPath, timeoutMs: 1_000 })
  const ok = assertPrePromptGuard(log, expected)
  assert.equal(ok.prePromptVerified, true)
  assert.equal(ok.guardPid, 4242)
  assert.equal(ok.selfTestFailures, 0)

  // The native launcher may re-exec the bundled node, so a direct child pid is also accepted.
  assert.equal(assertPrePromptGuard(log, { ...expected, spawnedPid: 1 }).ppidMatches, true)

  const withReady = (patch) => {
    writeFileSync(guardLogPath, `${JSON.stringify(selfTestRecord)}\n${JSON.stringify({ ...readyRecord, ...patch })}\n`, 'utf8')
    return waitForFreshGuardReady({ guardLogPath, timeoutMs: 1_000 })
  }
  assert.throws(() => assertPrePromptGuard(log, { ...expected, runId: 'run-other' }), /guard_run_id_mismatch_before_prompt/)
  assert.throws(() => assertPrePromptGuard(log, { ...expected, botId: 'bot_other' }), /guard_bot_id_mismatch_before_prompt/)
  assert.throws(() => assertPrePromptGuard(log, { ...expected, workspaceReal: resolve(tmpdir()) }), /guard_workspace_mismatch_before_prompt/)
  assert.throws(() => assertPrePromptGuard(log, { ...expected, allowedTools: ['read', 'write'] }), /guard_tools_mismatch_before_prompt/)
  assert.throws(() => assertPrePromptGuard(log, { ...expected, spawnedPid: 999_999 }), /guard_pid_mismatch_before_prompt/)
  assert.throws(() => assertPrePromptGuard({ ...log, selfTest: { ...selfTestRecord, failures: 1 } }, expected), /guard_selftest_failed_before_prompt/)
  assert.throws(() => assertPrePromptGuard({ ...log, selfTest: null }, expected), /guard_selftest_missing_before_prompt/)
  assert.throws(() => assertPrePromptGuard({ ...log, ready: null }, expected), /guard_ready_missing_before_prompt/)

  const drifted = await withReady({ schema: 'loom.runtime.file-guard.v0' })
  assert.throws(() => assertPrePromptGuard(drifted, expected), /guard_schema_mismatch_before_prompt/)
  const selfTestBad = await withReady({ selfTestFailures: 1 })
  assert.throws(() => assertPrePromptGuard(selfTestBad, expected), /guard_ready_selftest_failures_before_prompt/)

  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 10 · real Pi + guard, no tool calls (mock provider)
// ---------------------------------------------------------------------------

test('10 · real Pi + guard: guard loads, self-test passes, provider sees exactly the granted tools', { timeout: REAL_PI_TIMEOUT_MS, skip: !REAL_PI_SUPPORTED && 'pinned Pi bundle is windows-x64 only' }, async () => {
  const provider = await createLoopbackProvider()
  const workspace = freshDir('loom-real-run-ws-')
  writeFileSync(join(workspace, 'artifact.txt'), 'host hashed this\n', 'utf8')
  try {
    const evidence = await withMockKey(() => runAuthorizedExecution({
      grant: {
        runId: 'run-guard-basic',
        botId: 'bot_worker_a',
        workspaceRoot: workspace,
        allowedTools: ['read'],
        expiresAt: Date.now() + 300_000
      },
      model: mockModel(provider.port),
      prompt: 'Reply with one short sentence confirming this harmless local test message was received.',
      expectedArtifactPaths: ['artifact.txt'],
      promptTimeoutMs: 180_000
    }))

    assert.equal(evidence.schema, RUNTIME_EXECUTION_SCHEMA)
    assert.ok(RUN_STATUSES.includes(evidence.status))
    assert.equal(evidence.status, 'settled', `stderr tail: ${evidence.stderrTail}`)
    assert.equal(evidence.mockProvider, true)
    assert.equal(evidence.providerConnection, 'loopback-mock')
    assert.equal(evidence.actualBackendVerified, false)
    assert.equal(evidence.userCredentialsUsed, false)
    assert.equal(evidence.credentialValueRecorded, false)
    assert.equal(evidence.osSandbox, false)
    assert.equal(evidence.coreIntegrated, false)
    assert.equal(evidence.ownerReviewRecorded, false)
    assert.equal(evidence.replayable, false)

    // The guard really loaded inside Pi and its own self-test passed.
    assert.equal(evidence.guard.loaded, true)
    assert.equal(evidence.guard.selfTestFailures, 0)
    assert.ok(evidence.guard.selfTestCases >= 11)
    assert.equal(evidence.guard.runId, 'run-guard-basic')
    assert.equal(evidence.guard.botId, 'bot_worker_a')
    // ... and it was proven BEFORE the prompt was sent, bound to this run's process tree.
    assert.equal(evidence.pathGuard.prePromptVerified, true)
    assert.equal(evidence.pathGuard.guardPidMatchesSpawned, true)
    assert.equal(evidence.pathGuard.osSandbox, false)
    assert.equal(evidence.pathGuard.toctouConcurrentMutationGuarantee, false)
    assert.equal(evidence.pathGuard.workspaceOwnership, 'read-only-grant')
    assert.equal(evidence.promptDeliveryKnown, true)
    assert.equal(evidence.guard.executedCount, 0)
    assert.equal(evidence.tools.executedCount, 0)
    assert.deepEqual(evidence.tools.allowlist, ['read'])

    // The tool allowlist reached the provider: exactly `read`, no bash/write/edit.
    assert.ok(provider.requests.length >= 1, 'the mock provider must have been called')
    const toolNames = (provider.requests[0].toolsSchema ?? []).map((tool) => tool?.function?.name ?? tool?.name)
    assert.deepEqual(toolNames, ['read'])
    assert.equal(provider.requests[0].authorizationIsDummyBearer, true)

    // Host-side artifact hashing uses the explicit list only.
    assert.equal(evidence.artifacts.length, 1)
    assert.equal(evidence.artifacts[0].relativePath, 'artifact.txt')
    assert.equal(evidence.artifacts[0].sha256, sha256('host hashed this\n'))

    // No credential, no prompt body, no query string in the receipt.
    const text = JSON.stringify(evidence)
    assert.equal(text.includes(MOCK_KEY_VALUE), false)
    assert.equal(text.includes(DUMMY_API_KEY), false)
    assert.equal(/[?&](api[_-]?key|token)=/i.test(text), false)
    assert.equal(text.includes('Reply with one short sentence'), false)

    // The temp root (profile + guard log) is removed by teardown.
    assert.equal(existsSync(evidence.isolation.tempRootReal), false, 'the run temp root must be removed')
    assert.equal(existsSync(workspace), true, 'the caller-owned workspace is never deleted')
  } finally {
    await provider.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 11 · real Pi + guard, real tool calls: out-of-scope refused, in-scope executed
// ---------------------------------------------------------------------------

test('11 · real Pi + guard: out-of-scope read/write blocked and not executed; in-scope write+read execute', { timeout: REAL_PI_TIMEOUT_MS, skip: !REAL_PI_SUPPORTED && 'pinned Pi bundle is windows-x64 only' }, async () => {
  const outsideDir = freshDir('loom-outside-')
  writeFileSync(join(outsideDir, 'secret.txt'), 'outside secret\n', 'utf8')
  const outsideAbsolute = join(outsideDir, 'secret.txt')

  const provider = await createScriptedProvider([
    // 1. write escaping the workspace through `..`
    { type: 'tool_call', toolCallId: 'call_escape_rel', toolName: 'write', args: { path: '../escape.txt', content: 'escaped\n' } },
    // 2. read of an absolute path outside the workspace
    { type: 'tool_call', toolCallId: 'call_escape_abs', toolName: 'read', args: { path: outsideAbsolute } },
    // 3. in-scope write
    { type: 'tool_call', toolCallId: 'call_write_in', toolName: 'write', args: { path: 'out.txt', content: 'in scope body\n' } },
    // 4. in-scope read
    { type: 'tool_call', toolCallId: 'call_read_in', toolName: 'read', args: { path: 'in.txt' } },
    // 5. final answer so the agent settles
    { type: 'text', text: 'scripted done' }
  ])

  const workspace = freshDir('loom-tool-run-ws-')
  writeFileSync(join(workspace, 'in.txt'), 'in scope source\n', 'utf8')
  try {
    const evidence = await withMockKey(() => runAuthorizedExecution({
      grant: {
        runId: 'run-guard-tools',
        botId: 'bot_worker_b',
        workspaceRoot: workspace,
        allowedTools: ['read', 'write'],
        isolatedSelfOwnedWorkspace: true,
        expiresAt: Date.now() + 300_000
      },
      model: mockModel(provider.port),
      prompt: 'Use the granted file tools exactly as scripted; this is a harmless local fixture.',
      expectedArtifactPaths: ['out.txt'],
      promptTimeoutMs: 180_000
    }))

    assert.equal(evidence.status, 'settled', `stderr tail: ${evidence.stderrTail}`)
    assert.ok(provider.requests.length >= 5, `the scripted provider must have been called 5 times: ${provider.requests.length}`)
    assert.deepEqual(provider.requests[0].toolNames.slice().sort(), ['read', 'write'])

    // --- negatives: the guard refused, and nothing executed or was created ---
    const blocked = evidence.guard.decisions.filter((decision) => decision.decision === 'block')
    assert.ok(blocked.length >= 2, `expected >=2 guard blocks: ${JSON.stringify(evidence.guard.decisions)}`)
    const blockedCodes = blocked.map((decision) => decision.reasonCode)
    assert.ok(blockedCodes.includes('path_parent_escape'), `expected path_parent_escape in ${JSON.stringify(blockedCodes)}`)
    assert.ok(
      blockedCodes.includes('path_outside_workspace') || blockedCodes.includes('path_realpath_outside_workspace'),
      `expected an outside-workspace refusal in ${JSON.stringify(blockedCodes)}`
    )
    assert.equal(existsSync(join(workspace, '..', 'escape.txt')), false, 'a traversal write must never create a file')
    const blockedCallIds = new Set(blocked.map((decision) => decision.toolCallId))
    for (const execution of evidence.tools.executions) {
      assert.equal(blockedCallIds.has(execution.toolCallId), false, `blocked call ${execution.toolCallId} must not execute`)
    }
    assert.equal(evidence.tools.executions.some((execution) => execution.toolCallId === 'call_escape_rel'), false)
    assert.equal(evidence.tools.executions.some((execution) => execution.toolCallId === 'call_escape_abs'), false)
    // The outside file is untouched and its content never appears in the receipt.
    assert.equal(readFileSync(outsideAbsolute, 'utf8'), 'outside secret\n')
    assert.equal(JSON.stringify(evidence).includes('outside secret'), false)

    // --- positives: in-scope write and read really executed ---
    const writeExecution = evidence.tools.executions.find((execution) => execution.toolCallId === 'call_write_in')
    assert.ok(writeExecution, `in-scope write must execute: ${JSON.stringify(evidence.tools.executions)}`)
    assert.equal(writeExecution.toolName, 'write')
    assert.equal(writeExecution.finished, true)
    assert.equal(writeExecution.isError, false)
    assert.equal(readFileSync(join(workspace, 'out.txt'), 'utf8'), 'in scope body\n')

    const readExecution = evidence.tools.executions.find((execution) => execution.toolCallId === 'call_read_in')
    assert.ok(readExecution, `in-scope read must execute: ${JSON.stringify(evidence.tools.executions)}`)
    assert.equal(readExecution.toolName, 'read')
    assert.equal(readExecution.finished, true)
    assert.equal(readExecution.isError, false)

    // Every executed call has a guard allow; the guard and the event stream agree.
    assert.equal(evidence.guard.unguardedExecutions, 0)
    assert.equal(evidence.guard.executedCount, evidence.tools.executedCount)
    assert.ok(evidence.guard.allowedCount >= 2)
    assert.equal(evidence.pathGuard.prePromptVerified, true)
    assert.equal(evidence.pathGuard.workspaceOwnership, 'isolated-self-owned')

    // Host-side artifact hash matches the file the tool actually wrote.
    assert.equal(evidence.artifacts.length, 1)
    assert.equal(evidence.artifacts[0].relativePath, 'out.txt')
    assert.equal(evidence.artifacts[0].sha256, sha256('in scope body\n'))
    assert.equal(existsSync(evidence.isolation.tempRootReal), false)
  } finally {
    await provider.close()
    await rm(workspace, { recursive: true, force: true })
    await rm(outsideDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 12 · timeout → unknown_outcome, not replayable
// ---------------------------------------------------------------------------

test('12 · timeout: status unknown_outcome, replayable false, process stopped', { timeout: REAL_PI_TIMEOUT_MS, skip: !REAL_PI_SUPPORTED && 'pinned Pi bundle is windows-x64 only' }, async () => {
  const provider = await createScriptedProvider([{ type: 'stall' }])
  const workspace = freshDir('loom-timeout-ws-')
  try {
    const evidence = await withMockKey(() => runAuthorizedExecution({
      grant: {
        runId: 'run-timeout',
        botId: 'bot_worker_c',
        workspaceRoot: workspace,
        allowedTools: ['read'],
        expiresAt: Date.now() + 300_000
      },
      model: mockModel(provider.port),
      prompt: 'This harmless local fixture deliberately never answers.',
      promptTimeoutMs: 4_000,
      settleAfterAbortMs: 4_000
    }))

    assert.equal(evidence.status, 'unknown_outcome', `stderr tail: ${evidence.stderrTail}`)
    assert.equal(evidence.replayable, false, 'an unconfirmed settle must never be replayable')
    assert.equal(evidence.promptAccepted, true)
    assert.equal(evidence.abortRequested, true)
    // The prompt was delivered; the provider never answered, so the settle wait timed out and the run
    // is reported as unknown regardless of whether the abort later produced an agent_settled.
    assert.equal(evidence.settleWaitTimedOut, true)
    assert.equal(evidence.guard.loaded, true)
    assert.equal(evidence.pathGuard.prePromptVerified, true)
    assert.equal(evidence.pathGuard.workspaceOwnership, 'read-only-grant')
    assert.equal(evidence.promptDeliveryKnown, true)
    assert.equal(existsSync(evidence.isolation.tempRootReal), false, 'the temp root must be removed after a timeout')
  } finally {
    await provider.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// diagnostics redaction
// ---------------------------------------------------------------------------

test('13 · diagnostics: bearer tokens, key-shaped tokens and query strings are redacted', { timeout: 20_000 }, () => {
  const raw = 'request failed: Authorization: Bearer abc.def-123 status=401 url=https://api.example.invalid/v1?key=SECRET&x=1 key=sk-live-abcdef123456 api_key=topsecret'
  const sanitized = sanitizeDiagnosticText(raw)
  assert.equal(sanitized.includes('abc.def-123'), false)
  assert.equal(sanitized.includes('sk-live-abcdef123456'), false)
  assert.equal(sanitized.includes('SECRET'), false)
  assert.equal(sanitized.includes('topsecret'), false)
  assert.equal(sanitized.includes('?key='), false)
  assert.ok(sanitized.length <= 4_000)
})

// ---------------------------------------------------------------------------
// 14 · real Pi + guard: hardlink escape is refused, new-file write is not affected
// ---------------------------------------------------------------------------

test('14 · real Pi + guard: hardlink read refused (path_hardlink_escape); new-file write unaffected', { timeout: REAL_PI_TIMEOUT_MS, skip: !REAL_PI_SUPPORTED && 'pinned Pi bundle is windows-x64 only' }, async (t) => {
  const outsideDir = freshDir('loom-hardlink-outside-')
  const outsideFile = join(outsideDir, 'secret.txt')
  const outsidePayload = 'hardlink secret payload\n'
  writeFileSync(outsideFile, outsidePayload, 'utf8')

  const workspace = freshDir('loom-hardlink-ws-')
  const hardlinkPath = join(workspace, 'notes.md')
  try {
    linkSync(outsideFile, hardlinkPath)
  } catch (error) {
    await rm(workspace, { recursive: true, force: true })
    await rm(outsideDir, { recursive: true, force: true })
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      // Explicit skip with the real reason — never a silent pass on every platform.
      t.skip(`hardlink creation refused by this filesystem (${error.code})`)
      return
    }
    throw error
  }

  const provider = await createScriptedProvider([
    { type: 'tool_call', toolCallId: 'call_hardlink_read', toolName: 'read', args: { path: 'notes.md' } },
    { type: 'tool_call', toolCallId: 'call_fresh_write', toolName: 'write', args: { path: 'fresh.txt', content: 'fresh body\n' } },
    { type: 'text', text: 'scripted hardlink done' }
  ])

  try {
    const evidence = await withMockKey(() => runAuthorizedExecution({
      grant: {
        runId: 'run-hardlink',
        botId: 'bot_worker_h',
        workspaceRoot: workspace,
        allowedTools: ['read', 'write'],
        isolatedSelfOwnedWorkspace: true,
        expiresAt: Date.now() + 300_000
      },
      model: mockModel(provider.port),
      prompt: 'Read the workspace note and write a fresh file; harmless local fixture.',
      expectedArtifactPaths: ['fresh.txt'],
      promptTimeoutMs: 180_000
    }))

    assert.equal(evidence.status, 'settled', `stderr tail: ${evidence.stderrTail}`)

    // The hardlinked read must be refused by the guard for the hardlink reason specifically.
    const hardlinkDecision = evidence.guard.decisions.find((decision) => decision.toolCallId === 'call_hardlink_read')
    assert.ok(hardlinkDecision, `the guard must have decided on the hardlink read: ${JSON.stringify(evidence.guard.decisions)}`)
    assert.equal(hardlinkDecision.decision, 'block')
    assert.equal(hardlinkDecision.reasonCode, 'path_hardlink_escape')

    // ... and it must not have been executed.
    assert.equal(evidence.tools.executions.some((execution) => execution.toolCallId === 'call_hardlink_read'), false)
    assert.ok(evidence.tools.deniedAttempts.some((attempt) => attempt.toolCallId === 'call_hardlink_read'))
    // The outside payload never reaches the receipt.
    assert.equal(JSON.stringify(evidence).includes('hardlink secret payload'), false)

    // Creating a NEW file is unaffected by the hardlink rule.
    const freshExecution = evidence.tools.executions.find((execution) => execution.toolCallId === 'call_fresh_write')
    assert.ok(freshExecution, `the new-file write must execute: ${JSON.stringify(evidence.tools.executions)}`)
    assert.equal(freshExecution.finished, true)
    assert.equal(freshExecution.isError, false)
    assert.equal(readFileSync(join(workspace, 'fresh.txt'), 'utf8'), 'fresh body\n')
    assert.equal(evidence.artifacts.length, 1)
    assert.equal(evidence.artifacts[0].relativePath, 'fresh.txt')

    // The outside file is untouched.
    assert.equal(readFileSync(outsideFile, 'utf8'), outsidePayload)
  } finally {
    await provider.close()
    await rm(workspace, { recursive: true, force: true })
    await rm(outsideDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 15 · cancel / status ordering (pure state function, no process)
// ---------------------------------------------------------------------------

test('15 · status ordering: before-send, during-ack (receipt lost), after-settle, timeout, budget', { timeout: 20_000 }, () => {
  const base = { promptAttempted: true, promptAccepted: true, promptDeliveryKnown: true, settledObserved: true }

  // Cancel before anything was sent: a clean cancel, nothing ran.
  assert.equal(resolveRunStatus({ cancelledBeforeSend: true, promptAttempted: false }), 'cancelled')
  assert.equal(resolveRunStatus({ promptAttempted: false }), 'failed')
  assert.equal(isRunReplayable({ status: 'failed', promptAttempted: false }), true)

  // Cancel while the prompt receipt is still in flight and then lost: NOT a clean cancel.
  assert.equal(
    resolveRunStatus({ cancelledBeforeSettle: true, promptAttempted: true, promptAccepted: false, promptDeliveryKnown: false }),
    'unknown_outcome'
  )
  assert.equal(isRunReplayable({ status: 'unknown_outcome', promptAttempted: true }), false)

  // Attempted and delivery proven failed: a definite failure, but still never replayable.
  assert.equal(
    resolveRunStatus({ promptAttempted: true, promptAccepted: false, promptDeliveryKnown: true }),
    'failed'
  )
  assert.equal(isRunReplayable({ status: 'failed', promptAttempted: true }), false)

  // Cancel AFTER a genuine settle must not downgrade the run.
  assert.equal(resolveRunStatus({ ...base, cancelledBeforeSettle: false }), 'settled')
  assert.equal(resolveRunStatus({ ...base, cancelledBeforeSettle: false, providerError: true }), 'failed')

  // Cancel that was confirmed by a settle before the timeout: an honest cancel.
  assert.equal(resolveRunStatus({ ...base, cancelledBeforeSettle: true }), 'cancelled')

  // Timeout / unsettled always unknown.
  assert.equal(resolveRunStatus({ ...base, settleWaitTimedOut: true }), 'unknown_outcome')
  assert.equal(resolveRunStatus({ ...base, settledObserved: false }), 'unknown_outcome')

  // Incomplete tool evidence (event budget overflow) is unknown, never a false success.
  assert.equal(resolveRunStatus({ ...base, evidenceBudgetExceeded: true }), 'unknown_outcome')
})

// ---------------------------------------------------------------------------
// 16 · RPC retention: stream deltas are dropped, structured evidence is kept
// ---------------------------------------------------------------------------

test('16 · rpc retention: deltas dropped, tool/terminal events kept, intentions counted', { timeout: 20_000 }, () => {
  assert.ok(RETAINED_RPC_EVENT_TYPES.includes('tool_execution_start'))
  assert.ok(RETAINED_RPC_EVENT_TYPES.includes('tool_execution_end'))
  assert.ok(RETAINED_RPC_EVENT_TYPES.includes('agent_settled'))
  assert.equal(RETAINED_RPC_EVENT_TYPES.includes('message_update'), false)

  assert.deepEqual(classifyRpcEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } }), { retain: false, intentionDelta: 0 })
  assert.deepEqual(classifyRpcEvent({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start' } }), { retain: false, intentionDelta: 1 })
  assert.deepEqual(classifyRpcEvent({ type: 'entry_appended' }), { retain: false, intentionDelta: 0 })
  assert.deepEqual(classifyRpcEvent({ type: 'response', command: 'prompt' }), { retain: false, intentionDelta: 0 })
  assert.deepEqual(classifyRpcEvent({ type: 'tool_execution_start', toolCallId: 'c1' }), { retain: true, intentionDelta: 0 })
  assert.deepEqual(classifyRpcEvent({ type: 'tool_execution_end', toolCallId: 'c1' }), { retain: true, intentionDelta: 0 })
  assert.deepEqual(classifyRpcEvent({ type: 'agent_settled' }), { retain: true, intentionDelta: 0 })
  assert.deepEqual(classifyRpcEvent(null), { retain: false, intentionDelta: 0 })

  // The intention counter survives even though no message_update event is buffered.
  const evidence = extractToolExecutions(
    [{ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: { path: 'a.txt' } }],
    { intentionCount: 3 }
  )
  assert.equal(evidence.modelToolcallIntentions, 3)
  assert.equal(evidence.executions.length, 1)
  assert.equal(evidence.executedCount, 0)
})

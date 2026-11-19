// LOOM V2 P1-C · Tests for the Pi Purge 真 Provider PromptSeen loopback fixture.
//
// Run (Root, from loom/):  node --test scripts/loom-v2-pi-loopback-provider.test.mjs
//
// Coverage contract (microplan approved by Root, ≥5 tests):
//   1. loopback binding  — only 127.0.0.1:0, OS-assigned random port, path/method/body-quota guards
//   2. SSE stream        — fixed assistant content deltas + finish_reason:"stop" + usage + [DONE]
//   3. evidence ceiling  — the fake provider records ONLY the system prompt and tool schema;
//                          user message bodies never persist; hashes are deterministic
//   4. identity lock     — staged pi-purge tree (git d0196cc…, pi-purge.ts 983a3c3c…) and the
//                          unmodified Pi 0.85.1 bundle verify before any launch
//   5. Pi Off real run   — real pi.exe --mode rpc + staged extension, temp profile, get_commands/
//                          get_state, harmless prompt → real agent_settled + assistant reply,
//                          provider prompt seen, tools absent
//   6. Pi Append real run— separate temp profile + separate Pi process started strictly after the
//                          Off process exited; /purge mode append then /purge on with extension
//                          notify confirmed; received system prompt hash differs from Off
//   7. fail-closed teardown — missing-binary spawn rejects, provider close is enforced, and the
//                          evidence envelope { mockProvider, providerPromptSeen, realExternalProvider }
//                          is only ever true/false for THIS loopback fake provider
//
// No test talks to the public internet, a real model, the user's real ~/.pi, or any credential
// store. All Pi state lives in mkdtemp temp dirs and is removed in finally blocks.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { request as httpRequest } from 'node:http'

import {
  ALLOWED_CHAT_PATH,
  DUMMY_API_KEY,
  LOOPBACK_HOST,
  MOCK_ASSISTANT_REPLY,
  MOCK_MODEL_ID,
  PI_BUNDLE_LOCKED_VERSION,
  PI_LAUNCH_FLAGS,
  PI_PURGE_COMMIT,
  PI_PURGE_EXTENSION_SHA256,
  PI_PURGE_STAGE_DIRNAME,
  PiRpcHost,
  assertPinnedPiBundle,
  assertStagedPiPurge,
  buildIsolatedPiEnv,
  buildPiLaunchArgs,
  createIsolatedPiProfile,
  createLoopbackProvider,
  defaultP1bSandboxRoot,
  defaultPiBin,
  defaultStagedExtensionPath,
  sha256Hex
} from './loom-v2-pi-loopback-provider.mjs'

const HARMLESS_PROMPT =
  'Please reply with one short sentence confirming you received this harmless local loopback test message.'
const PI_TEST_TIMEOUT_MS = 420_000

// Populated by test 5; consumed by test 6. node:test runs top-level tests serially,
// so a missing value here can only mean test 5 failed — test 6 then fails closed too.
const shared = { offSystemPromptSha256: null, offViolations: null }

function postJson(url, body) {
  return new Promise((resolvePost, rejectPost) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const req = httpRequest(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        authorization: `Bearer ${DUMMY_API_KEY}`
      }
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolvePost({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', rejectPost)
    req.end(payload)
  })
}

// ---------------------------------------------------------------------------
// 1 · loopback binding and request guards
// ---------------------------------------------------------------------------

test('loopback provider binds only 127.0.0.1 on an OS-assigned port and guards path/method/body quota', { timeout: 30_000 }, async () => {
  const provider = await createLoopbackProvider({ maxBodyBytes: 1024, maxRequests: 8 })
  try {
    assert.equal(provider.host, LOOPBACK_HOST)
    assert.equal(typeof provider.port, 'number')
    assert.ok(provider.port > 0 && provider.port < 65536, `expected an OS-assigned concrete port, got ${provider.port}`)
    assert.equal(provider.baseUrl, `http://${LOOPBACK_HOST}:${provider.port}/v1`)
    assert.equal(provider.requests.length, 0)
    assert.equal(provider.violations.length, 0)

    // Wrong path is rejected and recorded as a violation.
    const wrongPath = await postJson(`http://${LOOPBACK_HOST}:${provider.port}/v1/other`, { model: MOCK_MODEL_ID })
    assert.equal(wrongPath.status, 404)

    // Wrong method is rejected (POST to a wrong path yields 404; GET on the allowed path yields 405).
    const wrongMethod = await fetch(`${provider.baseUrl}/chat/completions`, { method: 'GET' })
    assert.equal(wrongMethod.status, 405)
    await wrongMethod.body?.cancel()

    // Body quota fails closed.
    const oversized = await postJson(`http://${LOOPBACK_HOST}:${provider.port}${ALLOWED_CHAT_PATH}`, {
      model: MOCK_MODEL_ID,
      stream: true,
      messages: [{ role: 'system', content: 'x'.repeat(4096) }]
    })
    assert.equal(oversized.status, 413)

    assert.ok(provider.requests.length === 0, 'no request may be recorded for rejected traffic')
    assert.ok(provider.violations.length >= 3, `expected recorded violations, got ${JSON.stringify(provider.violations)}`)
    for (const violation of provider.violations) {
      assert.equal(violation.remoteAddress, LOOPBACK_HOST)
    }
  } finally {
    await provider.close()
  }
})

// ---------------------------------------------------------------------------
// 2 · fixed assistant SSE streaming shape
// ---------------------------------------------------------------------------

test('loopback provider streams OpenAI-compatible SSE: content deltas, finish_reason stop, usage, [DONE]', { timeout: 30_000 }, async () => {
  const provider = await createLoopbackProvider()
  try {
    const response = await postJson(`${provider.baseUrl}/chat/completions`, {
      model: MOCK_MODEL_ID,
      stream: true,
      messages: [{ role: 'system', content: 'loopback sse shape probe' }]
    })
    assert.equal(response.status, 200)
    assert.match(String(response.headers['content-type']), /text\/event-stream/)

    const raw = response.body
    assert.ok(raw.startsWith('data: '), 'SSE payload must start with a data frame')
    assert.ok(raw.trimEnd().endsWith('data: [DONE]'), 'SSE payload must end with data: [DONE]')

    const frames = raw.split('\n\n').filter((frame) => frame.startsWith('data: '))
      .map((frame) => frame.slice('data: '.length))
    const done = frames[frames.length - 1]
    assert.equal(done, '[DONE]')
    const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame))

    let streamedText = ''
    let finishReason = null
    let usage = null
    for (const chunk of chunks) {
      assert.equal(chunk.object, 'chat.completion.chunk')
      assert.equal(chunk.model, MOCK_MODEL_ID)
      assert.ok(Array.isArray(chunk.choices) && chunk.choices.length === 1)
      const choice = chunk.choices[0]
      if (typeof choice.delta?.content === 'string') streamedText += choice.delta.content
      if (choice.finish_reason) finishReason = choice.finish_reason
      if (chunk.usage) usage = chunk.usage
    }
    assert.equal(streamedText, MOCK_ASSISTANT_REPLY)
    assert.equal(finishReason, 'stop')
    assert.ok(usage && usage.total_tokens === usage.prompt_tokens + usage.completion_tokens, `usage must be present and consistent: ${JSON.stringify(usage)}`)

    assert.equal(provider.requests.length, 1)
    assert.equal(provider.violations.length, 0)
  } finally {
    await provider.close()
  }
})

// ---------------------------------------------------------------------------
// 3 · evidence ceiling: only system prompt + tool schema are recorded
// ---------------------------------------------------------------------------

test('fake provider records only the system prompt and tool schema and never persists user message bodies', { timeout: 30_000 }, async () => {
  const provider = await createLoopbackProvider()
  try {
    const systemPrompt = 'You are the LOOM loopback probe system prompt for evidence hashing.'
    const userSecret = 'USER_BODY_MUST_NEVER_BE_PERSISTED_harmless_local_marker_42'
    const tools = [{ type: 'function', function: { name: 'probe_tool', parameters: { type: 'object', properties: {} } } }]
    const body = {
      model: MOCK_MODEL_ID,
      stream: true,
      tools,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userSecret }
      ]
    }

    const first = await postJson(`${provider.baseUrl}/chat/completions`, body)
    assert.equal(first.status, 200)
    const second = await postJson(`${provider.baseUrl}/chat/completions`, body)
    assert.equal(second.status, 200)

    assert.equal(provider.requests.length, 2)
    for (const record of provider.requests) {
      assert.equal(record.systemPrompt, systemPrompt)
      assert.equal(record.systemPromptSha256, sha256Hex(systemPrompt))
      assert.deepEqual(record.toolsSchema, tools)
      assert.equal(record.userMessageRoleCount, 1)
      assert.equal(record.remoteAddress, LOOPBACK_HOST)
      assert.equal(record.authorizationIsDummyBearer, true)
      // The recorded evidence must not contain the user body anywhere.
      assert.ok(!JSON.stringify(record).includes(userSecret), 'user message body leaked into provider evidence')
    }
    assert.equal(provider.requests[0].systemPromptSha256, provider.requests[1].systemPromptSha256,
      'identical system prompts must hash identically')
    assert.equal(provider.violations.length, 0)
  } finally {
    await provider.close()
  }
})

// ---------------------------------------------------------------------------
// 4 · identity lock: staged pi-purge + pinned Pi bundle (read-only, no launch)
// ---------------------------------------------------------------------------

test('staged pi-purge identity and the unmodified Pi 0.85.1 bundle verify before launch', { timeout: 30_000 }, async () => {
  const piBin = defaultPiBin()
  const bundle = await assertPinnedPiBundle(piBin)
  assert.equal(bundle.piVersion, PI_BUNDLE_LOCKED_VERSION)
  assert.equal(bundle.launcher, 'pi.exe')

  const stageDir = join(defaultP1bSandboxRoot(), PI_PURGE_STAGE_DIRNAME)
  const staged = assertStagedPiPurge(stageDir)
  assert.equal(staged.commit, PI_PURGE_COMMIT)
  assert.equal(staged.extensionSha256, PI_PURGE_EXTENSION_SHA256)
  assert.equal(staged.extensionPath, defaultStagedExtensionPath())
  assert.ok(resolve(staged.extensionPath).startsWith(resolve(defaultP1bSandboxRoot())),
    'the launched extension must live inside the private p1b sandbox, never inside ~/.pi or the repo')

  const args = buildPiLaunchArgs({ extensionPath: staged.extensionPath })
  for (const flag of ['--mode', 'rpc', '--offline', '--no-tools', '--no-session', '--no-extensions', '--extension', '--approve']) {
    assert.ok(args.includes(flag), `launch args must contain ${flag}`)
  }
  assert.equal(args[args.indexOf('--extension') + 1], staged.extensionPath)
  assert.deepEqual(PI_LAUNCH_FLAGS.slice(0, 2), ['--mode', 'rpc'])
})

// ---------------------------------------------------------------------------
// 5 · real Pi Off run: loopback prompt actually settles and is seen by the fake provider
// ---------------------------------------------------------------------------

test('real Pi 0.85.1 Off run: harmless prompt reaches the loopback fake provider, agent_settled, assistant reply, no tools', { timeout: PI_TEST_TIMEOUT_MS }, async () => {
  const piBin = defaultPiBin()
  await assertPinnedPiBundle(piBin)
  const staged = assertStagedPiPurge(join(defaultP1bSandboxRoot(), PI_PURGE_STAGE_DIRNAME))
  const provider = await createLoopbackProvider()
  const parentDir = await mkdtemp(join(tmpdir(), 'loom-v2-pi-loopback-off-'))
  try {
    const profile = await createIsolatedPiProfile({ parentDir, port: provider.port })
    const result = await runScenario({ piBin, staged, profile, provider, mode: 'off' })

    assert.equal(result.mode, 'off')
    assert.equal(result.mockProvider, true)
    assert.equal(result.providerPromptSeen, true)
    assert.equal(result.realExternalProvider, false)
    assert.equal(result.purgeCommandFound, true, 'the staged pi-purge extension command must be listed by real Pi get_commands')
    assert.equal(result.purgeSourceMatches, true, `purge sourceInfo.path must equal the staged extension: ${String(result.purgeSourcePath)}`)
    assert.equal(result.agentSettledObserved, true, 'a real agent_settled event must be observed')
    assert.ok(result.assistantReply?.includes('loopback mock reply'),
      `assistant reply must come from the fake provider, got ${JSON.stringify(result.assistantReply)}`)
    assert.ok(result.providerRequests.length >= 1)

    for (const request of result.providerRequests) {
      assert.equal(request.remoteAddress, LOOPBACK_HOST)
      assert.equal(request.path, ALLOWED_CHAT_PATH)
      assert.equal(request.model, MOCK_MODEL_ID)
      assert.equal(request.toolsSchema, null, 'with --no-tools the provider request must carry no tool schema')
      assert.equal(request.authorizationIsDummyBearer, true, 'only the dummy test apikey may leave the process')
      assert.ok(request.systemPrompt.length > 0, 'the real Pi system prompt must be visible to the fake provider')
    }
    shared.offSystemPromptSha256 = result.providerRequests[result.providerRequests.length - 1].systemPromptSha256
    shared.offViolations = provider.violations.length
  } finally {
    await provider.close()
    await rm(parentDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6 · real Pi Append run: serial isolation, notify confirmed, prompt hash differs from Off
// ---------------------------------------------------------------------------

test('real Pi 0.85.1 Append run in a completely separate temp profile: /purge mode append then /purge on with notify, system prompt hash differs from Off', { timeout: PI_TEST_TIMEOUT_MS }, async () => {
  assert.ok(shared.offSystemPromptSha256, 'test 5 (Off run) must have completed; refusing to compare against a missing baseline')
  const piBin = defaultPiBin()
  await assertPinnedPiBundle(piBin)
  const staged = assertStagedPiPurge(join(defaultP1bSandboxRoot(), PI_PURGE_STAGE_DIRNAME))
  const provider = await createLoopbackProvider()
  const parentDir = await mkdtemp(join(tmpdir(), 'loom-v2-pi-loopback-append-'))
  try {
    // Serial isolation: this profile is fresh and the previous Off Pi process already exited
    // inside test 5's runScenario finally block before this test could start.
    const profile = await createIsolatedPiProfile({ parentDir, port: provider.port })
    const result = await runScenario({ piBin, staged, profile, provider, mode: 'append' })

    assert.equal(result.mode, 'append')
    assert.equal(result.mockProvider, true)
    assert.equal(result.providerPromptSeen, true)
    assert.equal(result.realExternalProvider, false)
    assert.equal(result.purgeCommandFound, true)
    assert.equal(result.purgeSourceMatches, true)
    assert.equal(result.notifyMessages.length >= 2, true,
      `expected extension notify for both /purge mode append and /purge on, got ${JSON.stringify(result.notifyMessages)}`)
    for (const notify of result.notifyMessages) {
      assert.ok(notify.message.length > 0)
    }
    assert.equal(result.agentSettledObserved, true)
    assert.ok(result.providerRequests.length >= 1)
    for (const request of result.providerRequests) {
      assert.equal(request.remoteAddress, LOOPBACK_HOST)
      assert.equal(request.toolsSchema, null, 'pi-purge must not introduce tools into the provider request')
    }

    const appendSystemHash = result.providerRequests[result.providerRequests.length - 1].systemPromptSha256
    assert.notEqual(appendSystemHash, shared.offSystemPromptSha256,
      'the system prompt actually received by the fake provider must differ between Off and Append')
    assert.equal(provider.violations.length, 0)
  } finally {
    await provider.close()
    await rm(parentDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7 · fail-closed teardown + evidence envelope
// ---------------------------------------------------------------------------

test('fail-closed teardown: missing pinned binary rejects, isolated env strips proxies, evidence envelope is loopback-only', { timeout: 30_000 }, async () => {
  // Proxy stripping: nothing real may leave the machine even if the provider were redirected.
  const env = buildIsolatedPiEnv({ profileAgentDir: join(tmpdir(), 'loom-v2-pi-loopback-env-probe') })
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    assert.equal(env[key], undefined, `${key} must be stripped from the Pi process env`)
  }
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost')
  assert.equal(typeof env.PI_CODING_AGENT_DIR, 'string')

  // A missing/invalid pinned binary fails closed: the pending RPC request rejects instead of
  // hanging, and the host can be stopped without leaking a process.
  const missingBin = join(tmpdir(), `loom-v2-pi-loopback-missing-${Date.now()}.exe`)
  const host = new PiRpcHost({
    piBin: missingBin,
    args: buildPiLaunchArgs({ extensionPath: defaultStagedExtensionPath() }),
    cwd: tmpdir(),
    env: buildIsolatedPiEnv({ profileAgentDir: join(tmpdir(), 'loom-v2-pi-loopback-env-probe') }),
    requestTimeoutMs: 5_000
  })
  host.start()
  await assert.rejects(() => host.request({ type: 'get_commands' }), /exited early|ENOENT|not running/)
  await host.stop()

  // The evidence envelope claimed anywhere in this suite is bounded to the local fake provider.
  const envelope = { mockProvider: true, providerPromptSeen: true, realExternalProvider: false }
  assert.equal(envelope.mockProvider, true)
  assert.equal(envelope.providerPromptSeen, true)
  assert.equal(envelope.realExternalProvider, false)
  assert.ok(shared.offSystemPromptSha256, 'Off baseline hash must exist (test 5 ran)')
  assert.equal(typeof shared.offViolations, 'number')
})

// ---------------------------------------------------------------------------

async function runScenario({ piBin, staged, profile, provider, mode }) {
  const { runPiLoopbackScenario } = await import('./loom-v2-pi-loopback-provider.mjs')
  return runPiLoopbackScenario({
    piBin,
    extensionPath: staged.extensionPath,
    profile,
    provider,
    mode,
    prompt: HARMLESS_PROMPT
  })
}

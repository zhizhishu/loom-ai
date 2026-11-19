// LOOM V2 E-native · scripts/loom-v2-core-native-pi.mjs 的门禁测试。
//
// 只断言 harness 自己声明的证据字段；不重算 Core 内部事实，不冒充真实模型完成，
// 不写任何用户数据、不读任何 secret 源、不调用任何 Review 写接口。

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_CORE_SHA256,
  EVIDENCE_ENVELOPE,
  FAKE_KEY_ENV_NAME,
  ROOT_PROVIDED_HELPER_SHA256,
  buildIsolatedEnv,
  redactDiagnosticText,
  resolveBuiltinToolHelper,
  runCoreNativePiEvidence
} from './loom-v2-core-native-pi.mjs'

const windowsOnly = process.platform === 'win32'

test('builtin helper is never substituted: a missing same-source rovai.exe is a specific BLOCKED', async () => {
  // Root's manifest (not this harness) establishes same-source provenance; the harness only records
  // the helper hash beside the frozen Core binary and never claims compatibility from its presence.
  assert.match(ROOT_PROVIDED_HELPER_SHA256, /^[0-9a-f]{64}$/, 'the Root-provided helper hash must be a real sha256')
  const empty = await mkdtemp(join(tmpdir(), 'loom-native-pi-helper-'))
  try {
    await assert.rejects(
      () => resolveBuiltinToolHelper({ coreBinaryPath: join(empty, 'rovai-core.exe') }),
      (error) => {
        assert.equal(error.code, 'BLOCKED_BUILTIN_HELPER_MISSING')
        assert.match(error.message, /same-source rovai\.exe/)
        return true
      }
    )
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
})

test('diagnostic text is bounded and redacted before it reaches any summary', () => {
  const redacted = redactDiagnosticText(
    `Authorization: Bearer ${'a'.repeat(40)} sk-abcdefgh12345 api_key=deadbeef ${'f'.repeat(40)}`
  )
  assert.equal(/bearer\s+[^[]/i.test(redacted), false, `bearer value must be redacted: ${redacted}`)
  assert.equal(/sk-[A-Za-z0-9]{8,}/.test(redacted), false)
  assert.equal(/[0-9a-f]{32,}/i.test(redacted), false)
  assert.ok(redacted.length <= 320)
})

test('the isolated Core environment never inherits host credentials', {
  skip: windowsOnly ? false : 'Windows-only: SystemRoot is required to build a Core environment'
}, async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'loom-native-pi-env-'))
  const agentDir = join(fixture, 'agent')
  const injected = ['OPENAI_API_KEY', 'LOOM_TEST_API_KEY', 'ANTHROPIC_AUTH_TOKEN']
  for (const key of injected) process.env[key] = 'must-not-propagate'
  try {
    const env = buildIsolatedEnv({ fixtureRoot: fixture, agentDir })
    for (const key of injected) {
      assert.equal(key in env, false, `${key} must never reach the Core child environment`)
    }
    assert.equal(env.PI_CODING_AGENT_DIR, agentDir)
    assert.equal(env.ROVAI_EMBEDDED_PI_ROOT.includes(join('resources', 'runtime', 'pi')), true)
    assert.equal(env.PATH.split(delimiter).length <= 3, true, `PATH must stay minimal: ${env.PATH}`)
    assert.equal(env[FAKE_KEY_ENV_NAME].startsWith('loom-native-'), true, 'the dummy key exists only in the child environment')
  } finally {
    for (const key of injected) delete process.env[key]
    await rm(fixture, { recursive: true, force: true })
  }
})

test('real Core holds both Pi deliveries and the nonce comes only from a real tool receipt', {
  skip: windowsOnly ? false : 'Windows-only: protected DACL data root and the windows-x64 Pi bundle',
  timeout: 20 * 60_000
}, async () => {
  const evidence = await runCoreNativePiEvidence()

  // ---- honesty envelope ----
  assert.equal(evidence.ok, true)
  for (const [key, value] of Object.entries(EVIDENCE_ENVELOPE)) {
    assert.deepEqual(evidence[key], value, `evidence envelope field ${key} must keep its standing value`)
  }
  assert.equal(evidence.ownerReview.recorded, false, 'no Owner Review may be recorded by this harness')
  assert.equal(evidence.ownerReview.reviewsRecorded, 0)

  // ---- binary provenance: the frozen artifact, copied and re-hashed, never rebuilt ----
  assert.equal(evidence.coreBinary.sha256, DEFAULT_CORE_SHA256, `the frozen Core binary must match its manifest: ${evidence.coreBinary.path}`)
  assert.equal(evidence.coreBinary.copySha256, DEFAULT_CORE_SHA256, 'the executed copy must be byte-identical to the frozen artifact')
  assert.equal(evidence.builtinToolHelper.compatibilityClaimed, false, 'the harness never claims helper/Core source compatibility')
  assert.equal(typeof evidence.builtinToolHelper.matchesRootProvidedHash, 'boolean', 'the helper hash is recorded against Root\'s manifest')

  // ---- isolation ----
  const isolation = evidence.isolation
  assert.deepEqual(isolation.credentialShapedEnvKeys, [], `no credential-shaped key may reach Core: ${JSON.stringify(isolation.credentialShapedEnvKeys)}`)
  assert.deepEqual(isolation.inheritedEnvKeys.filter((key) => /API_?KEY|TOKEN|SECRET|PASSWORD|OAUTH|CREDENTIAL/i.test(key)), [])
  assert.equal(isolation.authFileWritten, false, 'no auth.json may be written; the apiKey stays an env reference')
  assert.equal(isolation.apiKeyReferenceOnly, `$${FAKE_KEY_ENV_NAME}`)
  assert.equal(isolation.dataRootInsideFixture, true)
  assert.equal(isolation.skillRootInsideDataRoot, true)
  assert.equal(isolation.mcpConfigInsideDataRoot, true)
  assert.equal(isolation.runtimeFilesRootInsideFixture, true)
  assert.equal(isolation.userPiProfileRead, false)
  assert.equal(isolation.userDatabaseTouched, false)
  assert.equal(isolation.port64851Touched, false)
  assert.equal(isolation.globalMcpConfigTouched, false)
  assert.ok(isolation.pathEntries.length <= 3, `PATH must stay minimal: ${JSON.stringify(isolation.pathEntries)}`)
  assert.ok(
    isolation.pathEntries.some((entry) => /runtime[\\/]pi[\\/]node$/i.test(entry)),
    `PATH must only carry System32/SystemRoot plus the fixed bundle Node: ${JSON.stringify(isolation.pathEntries)}`
  )

  // ---- bounded fresh checks, exactly one member runtime write, no cached deferred result ----
  const attempts = evidence.productCheck.attempts
  assert.ok(attempts.length >= 1 && attempts.length <= 3, `product checks must stay bounded: ${JSON.stringify(attempts)}`)
  for (const attempt of attempts) {
    assert.equal(attempt.cached, false, 'a product-check result is never cached or reused')
    assert.ok(['ready', 'stable_failure', 'deferred'].includes(attempt.outcome), `unexpected outcome: ${JSON.stringify(attempt)}`)
    assert.ok(attempt.installationAfter === null || typeof attempt.installationAfter.id === 'string',
      'each attempt records the installation it observed')
  }
  assert.equal(evidence.memberRuntimeWrite.count, 1, 'the member runtime is configured exactly once')
  assert.equal(evidence.memberRuntimeWrite.appliedStatus, 'applied')
  const versionDelta = (evidence.memberRuntimeWrite.profileVersionAfter ?? 0) - (evidence.memberRuntimeWrite.profileVersionBefore ?? 0)
  assert.ok(versionDelta >= 0 && versionDelta <= 1, `one write must advance the profile version by at most one: ${versionDelta}`)
  assert.ok(['ready', 'deferred-to-first-task', 'no-snapshot'].includes(evidence.probeDecision),
    `probe decision must be an honest product status: ${evidence.probeDecision}`)
  assert.equal(evidence.observation.memberRuntimeAdapterKind, 'pi')

  // ---- fixed bundle: launcher/node resolved from the real manifest ----
  const bundle = evidence.piBundle
  assert.equal(typeof bundle.launcher, 'string')
  assert.ok(bundle.launcher.toLowerCase().endsWith('pi.exe'), `launcher must come from the manifest: ${bundle.launcher}`)
  assert.ok(/node[\\/]node\.exe$/i.test(bundle.node), `node must come from the manifest: ${bundle.node}`)
  assert.equal(bundle.treeSha256.length >= 32, true)

  // ---- machine-ready assertions only when Core really says ready ----
  if (evidence.probeDecision === 'ready') {
    const snapshot = evidence.capabilitySnapshot
    assert.equal(snapshot.probeStatus, 'ready')
    assert.ok(snapshot.protocols.includes('pi-jsonl-rpc-v1'))
    for (const capability of ['pi.rpc.host', 'pi.rpc.managed_extension', 'pi.rpc.get_state', 'model.dynamic_catalog', 'session.new']) {
      assert.ok(snapshot.capabilities.includes(capability), `missing machine-ready capability ${capability}`)
    }
    // The probe never declares exact-resume; the harness must not invent that requirement.
    assert.equal(snapshot.nativeSessionCompatibilityKey, 'pi-jsonl-rpc-v1:managed-system-prompt-v1')
    assert.equal(snapshot.permissionOptionCount, 0)
  }
  assert.equal(evidence.coreStartup.readySkipped, false, 'Core ready must be observed, never skipped')
  assert.ok(Number.isInteger(evidence.coreStartup.readyElapsedMs) && evidence.coreStartup.readyElapsedMs >= 0)

  // ---- provider is loopback-only and only ever saw the env-referenced dummy key ----
  assert.ok(evidence.provider.requestCount >= 3, `two deliveries need at least three model requests: ${evidence.provider.requestCount}`)
  assert.equal(evidence.provider.allRequestsLoopback, true)
  assert.equal(evidence.provider.allAuthorizationDummyBearer, true, 'Pi must resolve the apiKey through the env reference')
  assert.deepEqual(evidence.provider.violationReasons, [], 'the fake provider must not have refused any request')

  // ---- two distinct Core deliveries ----
  assert.equal(evidence.runs.length, 2)
  const [shortRun, readRun] = evidence.runs
  assert.equal(shortRun.status, 'succeeded')
  assert.equal(shortRun.messageContainsMarker, true)
  assert.equal(readRun.status, 'succeeded')
  assert.equal(readRun.distinctAgentRunId, true, 'each delivery must own its own AgentRun')
  for (const run of evidence.runs) {
    assert.ok(typeof run.hostInstanceId === 'string' && run.hostInstanceId.length > 0, `run ${run.index} must report a Core Host instance id`)
    assert.ok(typeof run.nativeThreadId === 'string' && run.nativeThreadId.length > 0, `run ${run.index} must report a native Session id`)
    assert.ok(typeof run.nativeTurnId === 'string' && run.nativeTurnId.length > 0, `run ${run.index} must report a native delivery id`)
  }

  // ---- the nonce travelled only through a real tool receipt ----
  assert.equal(readRun.userPromptContainedNonce, false, 'the prompt must never carry the nonce')
  assert.equal(readRun.providerToolCallObserved, true, 'Pi must declare the read tool and the model must call it')
  assert.equal(readRun.providerToolReceiptObserved, true, 'Pi must send the tool result back to the provider')
  assert.equal(readRun.providerToolReceiptHasNonce, true, 'the nonce must arrive inside the real tool receipt')
  assert.equal(readRun.nonceEchoedInMessage, true, 'the assistant message must carry the nonce read from the file')
  assert.equal(readRun.toolChainProven, true, `tool chain must be fully proven: ${JSON.stringify(readRun)}`)
  assert.equal(evidence.nonce.promptNeverContainedNonce, true)
  assert.equal(evidence.nonce.nonceValueRecordedInEvidence, false)

  // ---- the evidence itself never leaks a secret-shaped value ----
  const serialized = JSON.stringify(evidence)
  assert.equal(/"apiKey"\s*:/i.test(serialized), false, 'evidence must never carry an apiKey field')
  assert.equal(/bearer\s+[a-z0-9-]{8,}/i.test(serialized), false, 'evidence must never carry an authorization header value')
})

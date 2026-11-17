// Unit tests for the real Core → DSH capability acceptance helpers.
//
// Boundary: nothing here starts a Core, a Runtime, a model or a provider call, and
// nothing here simulates a remote answer. Every assertion below is a pure decision
// over explicit inputs plus one local temp directory used to prove that a missing
// receipt stays missing. A passing suite says the script refuses unproven evidence
// and refuses to over-claim; it says nothing about a real model.
//
// Run: node --test scripts/lib/accept-core-dsh-capabilities.test.mjs

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import {
  DSH_APPROVAL_POLICIES,
  DSH_PERMISSION_MODES,
  DELIVERED_SKILL_STATUSES,
  EXIT,
  HOMELIKE_ENV_NAMES,
  MAX_OBSERVATIONS,
  PROVIDER_KEY_ENVS,
  SETUP_REQUEST_MS,
  SETUP_TOTAL_MS,
  UsageError,
  applyNegativeScope,
  applySelectionStability,
  assertNoSecrets,
  assertModelOptions,
  buildDshAcpPatch,
  buildDshNativeSettings,
  buildIsolatedEnvironment,
  bindingPathInsideFixture,
  compareModelIdentity,
  decodeRelayModel,
  countLines,
  fileOrNull,
  findSecret,
  fixturePaths,
  frozenManifest,
  hookTransportFor,
  hookVerdict,
  mcpVerdict,
  messageText,
  nativeModelReadback,
  observationAllowed,
  ordinarySubroots,
  overallVerdict,
  parseArguments,
  parseWindowsDataRootLayout,
  readCoreWindowsLocator,
  readPublicConfig,
  redact,
  relayModelPair,
  resolveDshProgramPath,
  ruleVerdict,
  ruleBindingVerdict,
  runNarration,
  selectProviderKey,
  selectRelayCatalogEntry,
  setupLog,
  setupOutcome,
  setupRequestTimeout,
  sha256,
  skillDocument,
  skillExposureVerdict,
  skillSourceLayout,
  skillVerdict,
  startupSaveEdits,
  startupSaveParams,
  windowsDataRootPreparationArgs,
  windowsLocatorVerdict
} from '../accept-core-dsh-capabilities.mjs'

const SKILL_MARK = 'SKILL_MARK_0123456789abcdef'
const RULE_MARK = 'RULE_MARK_0123456789abcdef'
const ECHO = 'accept:MCP_MARK_0123456789abcdef'
const SKILL_ID = 'library:9f2a-skill'
const RULE_ID = 'rule_accept_1'

/* --------------------------------------------------------------- arguments */

test('arguments default to a non-danger sandbox and never expose danger-full-access', () => {
  const options = parseArguments([])
  assert.equal(options.permissionMode, 'workspace-write')
  assert.equal(options.approvalPolicy, 'never')
  assert.equal(options.prepareOnly, false)
  assert.deepEqual([...DSH_PERMISSION_MODES], ['read-only', 'workspace-write'])
  assert.equal(DSH_PERMISSION_MODES.includes('danger-full-access'), false)
  assert.deepEqual([...DSH_APPROVAL_POLICIES], ['ask', 'never'])
})

test('arguments refuse danger-full-access and malformed input instead of silently accepting it', () => {
  assert.throws(() => parseArguments(['--permission-mode', 'danger-full-access']), error => {
    assert.ok(error instanceof UsageError)
    assert.equal(error.code, 'usage')
    return true
  })
  assert.throws(() => parseArguments(['--approval-policy', 'always']), UsageError)
  assert.throws(() => parseArguments(['--nonsense']), UsageError)
  assert.throws(() => parseArguments(['--evidence']), UsageError)
  assert.throws(() => parseArguments(['--evidence', '--prepare-only']), UsageError)
  assert.throws(() => parseArguments(['--run-timeout-ms', '1000']), UsageError)
  assert.throws(() => parseArguments(['--run-timeout-ms', '99999999']), UsageError)
  assert.throws(() => parseArguments(['--label', 'has space']), UsageError)
})

test('arguments accept the documented flags and narrow permission modes only', () => {
  const options = parseArguments([
    '--prepare-only', '--skip-negative', '--keep-fixture',
    '--permission-mode', 'read-only',
    '--approval-policy', 'ask',
    '--dsh-bin', '/opt/dsh/bin/dsh',
    '--run-timeout-ms', '60000',
    '--label', 'de-bero-1'
  ])
  assert.equal(options.prepareOnly, true)
  assert.equal(options.skipNegative, true)
  assert.equal(options.keepFixture, true)
  assert.equal(options.permissionMode, 'read-only')
  assert.equal(options.approvalPolicy, 'ask')
  assert.equal(options.dshBin, '/opt/dsh/bin/dsh')
  assert.equal(options.runTimeoutMs, 60_000)
  assert.equal(options.label, 'de-bero-1')
})

/* ----------------------------------------------------------------- secrets */

test('the provider key comes only from the two documented environment names', () => {
  assert.deepEqual([...PROVIDER_KEY_ENVS], ['LOOM_E4_PROVIDER_KEY', 'OCT_API_KEY'])
  assert.deepEqual(selectProviderKey({ OCT_API_KEY: 'oct-value' }), { name: 'OCT_API_KEY', value: 'oct-value' })
  assert.deepEqual(
    selectProviderKey({ LOOM_E4_PROVIDER_KEY: 'loom-value', OCT_API_KEY: 'oct-value' }),
    { name: 'LOOM_E4_PROVIDER_KEY', value: 'loom-value' }
  )
  assert.equal(selectProviderKey({}), null)
  assert.equal(selectProviderKey({ LOOM_E4_PROVIDER_KEY: '   ' }), null)
  assert.equal(selectProviderKey({ SOME_OTHER_KEY: 'x' }), null)
})

test('a credential is found anywhere in evidence and is never written out', () => {
  const secret = 'sk-do-not-persist'
  assert.equal(findSecret({ a: 'safe', b: [{ c: `prefix-${secret}` }] }, [secret]), secret)
  assert.equal(findSecret({ a: 'safe' }, [secret]), null)
  assert.equal(findSecret({ [secret]: true }, [secret]), secret)
  assert.equal(redact(`token=${secret}`, [secret]), 'token=[redacted]')
  assert.throws(() => assertNoSecrets({ nested: { body: `x ${secret}` } }, [secret]), error => {
    assert.equal(error.code, 'secret_leak')
    return true
  })
  assert.deepEqual(assertNoSecrets({ status: 'NOT_RUN' }, [secret]), { status: 'NOT_RUN' })
})

test('an empty secret list cannot redact anything and never throws', () => {
  assert.equal(findSecret({ value: 'anything' }, []), null)
  assert.equal(redact('anything', []), 'anything')
  assert.deepEqual(assertNoSecrets({ value: 'anything' }, []), { value: 'anything' })
})

/* ------------------------------------------------------------ public route */

test('a public route supplies baseUrl, wire api and model identity and refuses credentials', () => {
  const parsed = readPublicConfig(JSON.stringify({
    provider: { baseUrl: 'https://route.example/v1', api: 'openai-completions' },
    model: { id: 'deepseek-v4.1-flash', contextWindow: 1_000_000, maxTokens: 384_000 }
  }))
  assert.deepEqual(parsed, {
    declaredModelId: 'deepseek-v4.1-flash',
    providerOrigin: 'https://route.example',
    providerApi: 'openai-completions',
    baseUrl: 'https://route.example/v1',
    contextWindow: 1_000_000,
    maxTokens: 384_000
  })
  assert.throws(() => readPublicConfig('{'), UsageError)
  assert.throws(() => readPublicConfig(JSON.stringify({ model: { id: 'm' } })), UsageError)
  // The wire protocol is never inferred from the URL.
  assert.throws(() => readPublicConfig(JSON.stringify({ model: { id: 'm' }, provider: { baseUrl: 'https://x.example/v1' } })), error => error.code === 'public_config')
  for (const forbidden of ['apiKey', 'token', 'authorization', 'headers', 'envKey', 'password', 'apiKeyEnv']) {
    assert.throws(
      () => readPublicConfig(JSON.stringify({ model: { id: 'm' }, provider: { baseUrl: 'https://x.example/v1', api: 'openai-responses', [forbidden]: 'x' } })),
      error => error.code === 'public_config',
      `${forbidden} must be refused as a credential channel`
    )
  }
})

test('the isolated DSH settings carry the env NAME and never the credential value', () => {
  const route = readPublicConfig(JSON.stringify({
    provider: { baseUrl: 'https://route.example/v1', api: 'openai-completions' },
    model: { id: 'deepseek-v4.1-flash', contextWindow: 1_000_000, maxTokens: 384_000 }
  }))
  const settings = buildDshNativeSettings({ publicConfig: route, apiKeyEnv: 'LOOM_E4_PROVIDER_KEY' })
  assert.deepEqual(settings, {
    'llm-pi-ai': {
      providers: {
        relay: {
          api: 'openai-completions',
          baseURL: 'https://route.example/v1',
          apiKeyEnv: 'LOOM_E4_PROVIDER_KEY',
          models: [{ id: 'deepseek-v4.1-flash', contextWindow: 1_000_000, maxTokens: 384_000 }]
        }
      }
    }
  })
  const serialized = JSON.stringify(settings)
  assert.equal(serialized.includes('sk-'), false)
  assert.equal(serialized.includes('Bearer'), false)
  // A synthetic key value must not be reachable from the settings object at all.
  assert.equal(findSecret(settings, ['sk-live-secret']), null)
  assert.throws(() => buildDshNativeSettings({ publicConfig: route, apiKeyEnv: 'not a name' }), UsageError)
  assert.throws(() => buildDshNativeSettings({ publicConfig: route, apiKeyEnv: '' }), UsageError)
})

test('every home-like name is redirected inside the fixture and only the provider key survives', () => {
  const root = join('tmp-tests', 'rovai-accept-dsh-env')
  const paths = fixturePaths(root)
  const inherited = {
    HOME: '/home/operator',
    USERPROFILE: 'C:\\Users\\operator',
    APPDATA: 'C:\\Users\\operator\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\operator\\AppData\\Local',
    TEMP: '/tmp',
    TMP: '/tmp',
    XDG_CONFIG_HOME: '/home/operator/.config',
    CODEX_HOME: '/home/operator/.codex',
    CLAUDE_CONFIG_DIR: '/home/operator/.claude',
    PI_CODING_AGENT_DIR: '/home/operator/.pi',
    DSH_HOME: '/home/operator/.dsh',
    DSH_AGENTS_HOME: '/home/operator/.dsh/agents',
    OCT_API_KEY: 'inherited-oct',
    LOOM_E4_PROVIDER_KEY: 'selected-key',
    ANTHROPIC_AUTH_TOKEN: 'inherited-anthropic',
    GITHUB_TOKEN: 'inherited-github',
    SOME_PASSWORD: 'inherited-password',
    PATH: '/usr/bin'
  }
  const isolated = buildIsolatedEnvironment({ paths, providerKeyName: 'LOOM_E4_PROVIDER_KEY', env: inherited })

  // Every homelike name resolves inside this fixture, never to the operator's own home.
  for (const name of HOMELIKE_ENV_NAMES) {
    const value = isolated.overrides[name]
    assert.equal(typeof value, 'string', `${name} must be redirected`)
    assert.ok(value.startsWith(`${root}${sep}`), `${name} must stay inside ${root}`)
    assert.notEqual(value, inherited[name], `${name} must not keep the inherited value`)
  }

  // Only the selected provider key is allowed to carry a credential-shaped value.
  const definedCredentialNames = Object.entries(isolated.overrides)
    .filter(([name, value]) => value !== undefined && /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)/u.test(name))
    .map(([name]) => name)
  assert.deepEqual(definedCredentialNames, [])
  assert.equal(Object.hasOwn(isolated.overrides, 'LOOM_E4_PROVIDER_KEY'), false)
  assert.equal(isolated.overrides.OCT_API_KEY, undefined)
  assert.equal(isolated.overrides.ANTHROPIC_AUTH_TOKEN, undefined)
  assert.equal(isolated.overrides.GITHUB_TOKEN, undefined)
  assert.equal(isolated.overrides.SOME_PASSWORD, undefined)
  // Masking is expressed as undefined (spawn skips it), never the string "undefined".
  for (const value of Object.values(isolated.overrides)) {
    assert.notEqual(value, 'undefined')
  }
  assert.deepEqual(isolated.maskedSort, ['ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN', 'OCT_API_KEY', 'SOME_PASSWORD'])
  assert.equal(Object.hasOwn(isolated.overrides, 'PATH'), false)
})

test('Windows never mkdirs the formal root and hands Core the exact native preparation call', () => {
  const root = join('tmp-tests', 'rovai-accept-dsh-win')
  const paths = fixturePaths(root)
  assert.deepEqual(windowsDataRootPreparationArgs(paths.formal), ['--prepare-windows-data-root', paths.formal])

  const win = ordinarySubroots(paths, 'win32')
  assert.equal(win.includes(paths.formal), false, 'the formal root is created only by Core')
  assert.equal(win.includes(paths.data), false, 'the Windows data dir is the Core-declared child')
  assert.ok(win.includes(paths.dshHome) && win.includes(paths.home) && win.includes(paths.temp))
  for (const value of win) assert.ok(value.startsWith(`${root}${sep}`))

  const linux = ordinarySubroots(paths, 'linux')
  assert.ok(linux.includes(paths.data), 'Linux keeps its ordinary data directory')
  assert.equal(linux.includes(paths.formal), false)
})

test('the native Windows layout frame is trusted only when Core returned exactly its own shape', () => {
  const root = 'C:\\fixtures\\rovai-accept'
  const layout = {
    root,
    core: `${root}\\Core`,
    electronUserData: `${root}\\Electron\\User Data`,
    electronSessionData: `${root}\\Electron\\Session Data`,
    logs: `${root}\\Logs`,
    crashDumps: `${root}\\CrashDumps`
  }
  assert.deepEqual(parseWindowsDataRootLayout(`${JSON.stringify(layout)}\r\n`, root), {
    ok: true, core: `${root}\\Core`, root, logs: `${root}\\Logs`
  })

  assert.equal(parseWindowsDataRootLayout(`${JSON.stringify(layout)}\n${JSON.stringify(layout)}`, root).code, 'win32_data_root_frame_invalid')
  assert.equal(parseWindowsDataRootLayout('not json', root).code, 'win32_data_root_json_invalid')
  assert.equal(parseWindowsDataRootLayout(JSON.stringify({ ...layout, extra: 'x' }), root).code, 'win32_data_root_layout_unknown_shape')
  assert.equal(parseWindowsDataRootLayout(JSON.stringify({ ...layout, core: 'C:\\other' }), root).code, 'win32_data_root_core_outside_root')
  assert.equal(parseWindowsDataRootLayout(JSON.stringify({ ...layout, root: 'C:\\other' }), root).code, 'win32_data_root_root_mismatch')
  assert.equal(parseWindowsDataRootLayout(JSON.stringify({ ...layout, core: '' }), root).code, 'win32_data_root_layout_invalid')
})

test('the startup save is the current field-edit shape and never the retired one', () => {
  const edits = startupSaveEdits({ beforeProgramPath: null, afterProgramPath: 'C:\\dsh\\dsh.cmd' })
  assert.deepEqual(edits, [{ path: ['programPath'], before: null, after: 'C:\\dsh\\dsh.cmd', label: 'isolated DSH acceptance' }])
  assert.deepEqual(startupSaveEdits({ beforeProgramPath: '/old/dsh', afterProgramPath: '/new/dsh' })[0].before, '/old/dsh')
  // An empty or non-string current value is expressed as null, never ''.
  assert.equal(startupSaveEdits({ beforeProgramPath: '', afterProgramPath: '/x' })[0].before, null)
  assert.equal(startupSaveEdits({ beforeProgramPath: undefined, afterProgramPath: '/x' })[0].before, null)

  const params = startupSaveParams({ runtimeKind: 'deepseek-harness', edits })
  assert.deepEqual(Object.keys(params).sort(), ['edits', 'runtimeKind'])
  assert.equal(Object.hasOwn(params, 'expectedRevision'), false)
  assert.equal(Object.hasOwn(params, 'configuration'), false)
  assert.deepEqual(params.edits, edits)
})

test('the bounded setup budget stops observation without repeating a write', () => {
  assert.equal(SETUP_TOTAL_MS, 120_000)
  assert.equal(SETUP_REQUEST_MS, 60_000)
  assert.equal(MAX_OBSERVATIONS, 3)

  const deadline = 1_000_000
  assert.equal(observationAllowed({ attemptsMade: 0, now: deadline - 1, deadline }), true)
  assert.equal(observationAllowed({ attemptsMade: 2, now: deadline - 1, deadline }), true)
  // Fourth observation is never taken, and an expired budget stops earlier.
  assert.equal(observationAllowed({ attemptsMade: 3, now: deadline - 1, deadline }), false)
  assert.equal(observationAllowed({ attemptsMade: 0, now: deadline, deadline }), false)
  assert.equal(observationAllowed({ attemptsMade: 0, now: deadline + 1, deadline }), false)

  // A single request can never outlive the 120s budget.
  assert.equal(setupRequestTimeout({ deadline: 1_000_000, now: 999_000 }), 1_000)
  assert.equal(setupRequestTimeout({ deadline: 1_000_000, now: 200_000 }), SETUP_REQUEST_MS)
  assert.equal(setupRequestTimeout({ deadline: 1_000_000, now: 1_000_000 }), 0)
  assert.equal(setupRequestTimeout({ deadline: 1_000_000, now: 1_000_001 }), 0)
})

test('setup stage logs and outcomes carry only stage, method and a closed-set code', () => {
  assert.deepEqual(setupLog('startup', 'runtime.startup.get', 'ok'), { stage: 'startup', method: 'runtime.startup.get', status: 'ok' })
  assert.deepEqual(
    setupLog('startup', 'runtime.startup.save', setupOutcome({ code: 'x', message: 'save rejected: invalid' })),
    { stage: 'startup', method: 'runtime.startup.save', code: 'rejected' }
  )
  assert.deepEqual(
    setupLog('observe', 'runtime.product.check', setupOutcome(new Error('timed out waiting for runtime.product.check'))),
    { stage: 'observe', method: 'runtime.product.check', code: 'timeout' }
  )
  assert.equal(setupOutcome({ code: 'x', message: 'boom' }).code, 'rejected')
  assert.equal(setupOutcome(new Error('unexpected')).code, 'rejected')

  // A log entry never carries an environment value, a profile path or a key.
  const entry = setupLog('startup', 'runtime.startup.save', setupOutcome(new Error(`sk-live-secret at /home/operator/.dsh`)))
  assert.deepEqual(Object.keys(entry).sort(), ['code', 'method', 'stage'])
  assert.equal(findSecret(entry, ['sk-live-secret']), null)
  assert.equal(JSON.stringify(entry).includes('/home/operator'), false)
})

test("the fixture skill directory's last segment equals the SKILL frontmatter name", () => {
  const root = join('tmp-tests', 'rovai-accept-dsh-skill')
  const skillSourceRoot = join(root, 'skill-source')
  const name = `dsh-accept-${'ab12cd34'}`
  const layout = skillSourceLayout({ skillSourceRoot, skillName: name, marker: SKILL_MARK })

  // Core rejects a name that differs from the source directory name.
  assert.equal(layout.basename, name)
  assert.equal(layout.directory.endsWith(`${sep}${name}`), true)
  assert.equal(layout.document.split('\n')[1], `name: ${name}`)
  assert.equal(layout.document.split(SKILL_MARK).length - 1, 1)
  // Still inside the fixture root, never at a fixed absolute location.
  assert.ok(layout.directory.startsWith(`${skillSourceRoot}${sep}`))
  assert.equal(layout.directory.includes('skill-source'), true)
})

test('the skill fixture directory is derived, not hard-coded, and refuses unsafe names', () => {
  const root = join('tmp-tests', 'rovai-accept-dsh-skill-2')
  const skillSourceRoot = join(root, 'skill-source')
  for (const name of ['dsh-accept-0f0f0f0f', 'dsh-accept-ffffffff']) {
    const layout = skillSourceLayout({ skillSourceRoot, skillName: name, marker: SKILL_MARK })
    assert.equal(layout.basename, name)
    assert.ok(layout.directory.startsWith(`${skillSourceRoot}${sep}`))
  }
  for (const bad of ['', 'has space', '../escape', 'a/b', 'x'.repeat(81)]) {
    assert.throws(() => skillSourceLayout({ skillSourceRoot, skillName: bad, marker: SKILL_MARK }), error => error.code === 'skill_fixture')
  }
})

test('a Run only accepts its own context manifest, never a neighbour Run', () => {
  const snapshot = {
    contextManifests: [
      { id: 'm-other', agentRunId: 'run-other', skillExposure: { skills: [] } },
      { id: 'm-mine', agentRunId: 'run-mine', bootstrap: { conversationId: 's1' } }
    ]
  }
  assert.equal(frozenManifest(snapshot, 'run-mine').id, 'm-mine')
  assert.equal(frozenManifest(snapshot, 'run-missing'), null)
  assert.equal(frozenManifest({}, 'run-mine'), null)
})

test('Skill exposure must match the imported revision, digest and a delivered status', () => {
  assert.deepEqual(DELIVERED_SKILL_STATUSES, ['ready'])
  const expected = { skillId: 'library:9f2a-skill', revisionId: 'rev-1', contentDigest: 'digest-1' }
  const exposure = skills => ({ schemaVersion: 2, skills })
  const entry = overrides => ({
    skillId: '9f2a-skill', name: 'dsh-accept', revisionId: 'rev-1', contentDigest: 'digest-1',
    groupKey: 'dsh', deliveredViaGroupKey: null, status: 'ready', entryPath: null,
    reasonCode: null, conflictStatuses: [], ...overrides
  })

  assert.equal(skillExposureVerdict({ skillExposure: exposure([entry({})]), expected }).status, 'PASS')
  // The catalog id carries the library: prefix, the exposure entry does not.
  assert.equal(skillExposureVerdict({ skillExposure: exposure([entry({})]), expected }).entry.skillId, '9f2a-skill')
  assert.deepEqual(skillExposureVerdict({ skillExposure: exposure([entry({ revisionId: 'rev-0' })]), expected }).reasons, ['skill_revision_mismatch'])
  assert.deepEqual(skillExposureVerdict({ skillExposure: exposure([entry({ contentDigest: 'other' })]), expected }).reasons, ['skill_digest_mismatch'])
  assert.deepEqual(skillExposureVerdict({ skillExposure: exposure([entry({ status: 'stale' })]), expected }).reasons, ['skill_status_stale'])
  assert.deepEqual(skillExposureVerdict({ skillExposure: exposure([entry({ status: 'unknown-new' })]), expected }).reasons, ['skill_status_unknown-new'])
  assert.deepEqual(skillExposureVerdict({ skillExposure: exposure([entry({ status: 'shadowed' })]), expected }).reasons, ['skill_status_shadowed'])
  assert.equal(skillExposureVerdict({ skillExposure: exposure([entry({ status: 'shadowed', deliveredViaGroupKey: 'codex' })]), expected }).status, 'NOT_RUN')
  assert.deepEqual(skillExposureVerdict({ skillExposure: exposure([entry({ skillId: 'other-skill' })]), expected }).reasons, ['skill_not_in_run_exposure'])
  assert.deepEqual(skillExposureVerdict({ skillExposure: null, expected }).reasons, ['skill_not_in_run_exposure'])
})

test('a DSH Bootstrap binding proves the Rule only with the same session, a re-computed digest and the marker', () => {
  const bootstrap = '# Charter\nIsolated acceptance rule marker RULE_MARK_1\n'
  const binding = { schemaVersion: 1, sessionId: 'session-a', bootstrap, sha256: sha256(bootstrap) }
  assert.equal(ruleBindingVerdict({ binding, sessionId: 'session-a', marker: 'RULE_MARK_1' }).status, 'PASS')
  assert.deepEqual(ruleBindingVerdict({ binding, sessionId: 'session-b', marker: 'RULE_MARK_1' }).reasons, ['dsh_binding_other_session'])
  assert.deepEqual(
    ruleBindingVerdict({ binding: { ...binding, sha256: sha256('tampered') }, sessionId: 'session-a', marker: 'RULE_MARK_1' }).reasons,
    ['dsh_binding_digest_mismatch']
  )
  assert.deepEqual(ruleBindingVerdict({ binding, sessionId: 'session-a', marker: 'OTHER_MARK' }).reasons, ['rule_marker_not_in_bootstrap'])
  assert.deepEqual(ruleBindingVerdict({ binding: { ...binding, schemaVersion: 2 }, sessionId: 'session-a', marker: 'RULE_MARK_1' }).reasons, ['dsh_binding_schema_mismatch'])
  assert.deepEqual(ruleBindingVerdict({ binding: null, sessionId: 'session-a', marker: 'RULE_MARK_1' }).reasons, ['dsh_binding_not_found'])
})

test('marker-only output can never pass either capability cell', () => {
  const exposed = skillExposureVerdict({ skillExposure: null, expected: { skillId: 'library:x', revisionId: 'r', contentDigest: 'd' } })
  const skill = skillVerdict({
    prompt: 'no marker here',
    reply: `answered ${SKILL_MARK}`,
    itemId: 'library:x',
    marker: SKILL_MARK,
    exposed
  })
  assert.equal(skill.status, 'NOT_RUN')
  assert.deepEqual(skill.reasons, ['exposure_skill_not_in_run_exposure'])

  const rule = ruleVerdict({
    prompt: 'no marker here',
    reply: `answered ${RULE_MARK}`,
    itemId: RULE_ID,
    marker: RULE_MARK,
    binding: { status: 'NOT_RUN', reasons: ['dsh_binding_not_found'] }
  })
  assert.equal(rule.status, 'NOT_RUN')
  assert.deepEqual(rule.reasons, ['binding_dsh_binding_not_found'])
})

test('a binding path outside the fixture or reached through a symlink is refused', () => {
  const root = join('tmp-tests', 'rovai-accept-dsh-binding')
  assert.deepEqual(bindingPathInsideFixture({ realPath: join(root, 'data', 'bindings', 's1.json'), fixtureRoot: root, isSymbolicLink: false }), { ok: true })
  assert.equal(bindingPathInsideFixture({ realPath: root, fixtureRoot: root, isSymbolicLink: false }).code, 'binding_path_outside_fixture')
  assert.equal(bindingPathInsideFixture({ realPath: join(root, 'data'), fixtureRoot: root, isSymbolicLink: false }).ok, true)
  assert.equal(bindingPathInsideFixture({ realPath: join('tmp-tests', 'other', 's1.json'), fixtureRoot: root, isSymbolicLink: false }).code, 'binding_path_outside_fixture')
  assert.equal(bindingPathInsideFixture({ realPath: join(root, 's1.json'), fixtureRoot: root, isSymbolicLink: true }).code, 'binding_path_is_symlink')
})

test('the ACP profile patch declares the relay provider and the explicit default row', () => {
  const route = readPublicConfig(JSON.stringify({
    provider: { baseUrl: 'https://route.example/v1', api: 'openai-completions' },
    model: { id: 'deepseek-v4.1-flash', contextWindow: 1_000_000, maxTokens: 384_000 }
  }))
  const nativeSettings = buildDshNativeSettings({ publicConfig: route, apiKeyEnv: 'LOOM_E4_PROVIDER_KEY' })
  const patch = buildDshAcpPatch({ nativeSettings, modelId: route.declaredModelId })

  assert.deepEqual(patch, [
    { id: 'llm-pi-ai', config: { providers: { relay: nativeSettings['llm-pi-ai'].providers.relay } } },
    { id: 'acp', config: { provider: 'relay', model: 'deepseek-v4.1-flash' } }
  ])
  // The declaration carries the env NAME only, and the model is the bare provider id.
  assert.equal(JSON.stringify(patch).includes('sk-'), false)
  assert.equal(patch[1].config.model, route.declaredModelId)
  assert.throws(() => buildDshAcpPatch({ nativeSettings: {}, modelId: 'x' }), error => error.code === 'public_route')
})

test('the relay pair is decoded, never trusted as an opaque string', () => {
  assert.equal(relayModelPair({ modelId: 'm' }), '["relay","m"]')
  assert.deepEqual(decodeRelayModel({ modelId: '["relay","m"]' }), { provider: 'relay', model: 'm' })
  // Core's provisional default is not a route pair at all.
  assert.equal(decodeRelayModel({ modelId: 'deepseek-harness://runtime-default' }), null)
  assert.equal(decodeRelayModel({ modelId: '["relay"]' }), null)
  assert.equal(decodeRelayModel({ modelId: '["relay","m","x"]' }), null)
  assert.equal(decodeRelayModel({ modelId: '["relay",1]' }), null)
  assert.equal(decodeRelayModel({ modelId: undefined }), null)
})

test('only one live native relay catalog entry is accepted', () => {
  const expectedId = relayModelPair({ modelId: 'm' })
  const entry = overrides => ({ id: expectedId, isDefault: false, options: [], runtimeMetadata: { dshSource: 'native' }, ...overrides })

  assert.equal(selectRelayCatalogEntry({ models: [entry({})], expectedId }).entry.id, expectedId)
  assert.equal(selectRelayCatalogEntry({ models: [], expectedId }).code, 'relay_not_in_catalog')
  assert.equal(selectRelayCatalogEntry({ models: [entry({}), entry({})], expectedId }).code, 'relay_catalog_ambiguous')
  assert.equal(selectRelayCatalogEntry({ models: [entry({ runtimeMetadata: { dshSource: 'web' } })], expectedId }).code, 'relay_catalog_web_only')
  assert.equal(selectRelayCatalogEntry({ models: [entry({ hidden: true })], expectedId }).code, 'relay_catalog_hidden')
  assert.equal(selectRelayCatalogEntry({ models: [entry({ deprecated: true })], expectedId }).code, 'relay_catalog_deprecated')
  const official = entry({ id: relayModelPair({ provider: 'deepseek-official', modelId: 'm' }) })
  assert.equal(selectRelayCatalogEntry({ models: [official], expectedId }).code, 'relay_not_in_catalog')
  assert.equal(selectRelayCatalogEntry({ models: [entry({})], expectedId, provider: 'other' }).code, 'relay_catalog_wrong_provider')
})

test('ModelSelection.options must be an object, never the catalog descriptor list', () => {
  assert.deepEqual(assertModelOptions({}), {})
  assert.deepEqual(assertModelOptions({ reasoning_effort: 'high' }), { reasoning_effort: 'high' })
  for (const bad of [[], [{ key: 'reasoning_effort', values: [] }], 'high', 42, null, undefined]) {
    assert.throws(() => assertModelOptions(bad), error => error.code === 'model_options')
  }
})

test('the native readback must agree on provider and decoded model id', () => {
  const expected = { provider: 'relay', modelId: 'deepseek-v4.1-flash' }
  const pass = nativeModelReadback({ modelId: relayModelPair({ modelId: 'deepseek-v4.1-flash' }), expected })
  assert.equal(pass.status, 'PASS')
  assert.equal(pass.decoded.model, 'deepseek-v4.1-flash')
  // report.modelIdentity compares the decoded id, not the JSON pair.
  assert.equal(compareModelIdentity('deepseek-v4.1-flash', pass.decoded.model).matches, true)

  assert.deepEqual(nativeModelReadback({ modelId: relayModelPair({ provider: 'deepseek-official', modelId: 'deepseek-v4.1-flash' }), expected }).reasons, ['model_provider_drift'])
  assert.deepEqual(nativeModelReadback({ modelId: relayModelPair({ modelId: 'other' }), expected }).reasons, ['model_id_drift'])
  assert.deepEqual(nativeModelReadback({ modelId: 'deepseek-harness://runtime-default', expected }).reasons, ['model_id_not_native_pair'])
  assert.equal(nativeModelReadback({ modelId: '', expected }).status, 'NOT_RUN')
})

test('the Adapter wire id is compared, never guessed', () => {
  assert.deepEqual(compareModelIdentity('m', 'm'), { comparable: true, matches: true, reason: 'exact' })
  assert.deepEqual(
    compareModelIdentity('m', JSON.stringify(['provider', 'm'])),
    { comparable: true, matches: true, reason: 'adapter_wire_id_last_element' }
  )
  assert.deepEqual(
    compareModelIdentity('m', JSON.stringify(['provider', 'other'])),
    { comparable: true, matches: false, reason: 'adapter_wire_id_last_element' }
  )
  // An incomparable shape is not a mismatch: it is refused, and cannot become a FAIL.
  assert.deepEqual(compareModelIdentity('m', 'provider/m'), { comparable: false, matches: false, reason: 'model_identity_shape_not_comparable' })
  assert.deepEqual(compareModelIdentity('', 'm'), { comparable: false, matches: false, reason: 'model_identity_missing' })
})

test('Windows refuses an unownable entrypoint before Core starts and never parses a shim', () => {
  assert.equal(resolveDshProgramPath({ platform: 'linux', dshBin: '/opt/dsh/bin/dsh' }).ok, true)
  assert.equal(resolveDshProgramPath({ platform: 'linux', dshBin: '/opt/dsh/bin/dsh' }).shimInterpretation, 'native-executable')
  const exe = resolveDshProgramPath({ platform: 'win32', dshBin: 'C:\\dsh\\dsh.exe' })
  assert.equal(exe.ok, true)
  assert.equal(exe.shimInterpretation, 'core-locator-only')
  // A .cmd/.bat is handed to Core untouched: Core's locator owns the shim, not this script.
  for (const shim of ['C:\\dsh\\dsh.cmd', 'C:\\dsh\\dsh.BAT']) {
    const resolved = resolveDshProgramPath({ platform: 'win32', dshBin: shim })
    assert.equal(resolved.ok, true)
    assert.equal(resolved.programPath, shim)
    assert.equal(resolved.shimInterpretation, 'core-locator-only')
  }
  // Anything Core cannot own is refused with an explicit code, before any Core start.
  const refused = resolveDshProgramPath({ platform: 'win32', dshBin: 'C:\\dsh\\dsh.ps1' })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'win32_unsupported_entrypoint')
  assert.match(refused.reason, /before Core starts/u)
  assert.equal(resolveDshProgramPath({ platform: 'win32', dshBin: 'dsh' }).ok, false)
  assert.equal(resolveDshProgramPath({ platform: 'linux', dshBin: '' }).code, 'dsh_binary_missing')
  assert.equal(resolveDshProgramPath({ platform: 'linux', dshBin: undefined }).code, 'dsh_binary_missing')
})

test('Windows may only run after Core bound a fixed interpreter + target pair', () => {
  const bound = readCoreWindowsLocator({
    adapterKind: 'deepseek-harness',
    locator: { canonicalInterpreterPath: 'C:\\node\\node.exe', resolvedTargetPath: 'C:\\dsh\\lib\\bin.js', entrypointKind: 'npm_shim' }
  })
  assert.deepEqual(bound, {
    interpreterPath: 'C:\\node\\node.exe',
    targetPath: 'C:\\dsh\\lib\\bin.js',
    entrypointKind: 'npm_shim'
  })
  assert.equal(windowsLocatorVerdict({ platform: 'win32', executionGranted: true, locator: bound }).status, 'PASS')

  // Unresolved locator: NOT_RUN, never a pass, and never a shell fallback.
  const unresolved = windowsLocatorVerdict({ platform: 'win32', executionGranted: true, locator: readCoreWindowsLocator({}) })
  assert.equal(unresolved.status, 'NOT_RUN')
  assert.deepEqual(unresolved.reasons.sort(), ['win32_interpreter_not_resolved', 'win32_target_not_resolved'])
  assert.equal(unresolved.required, true)

  // A half-resolved or self-referential locator is a mismatch, not a shortcut.
  const half = windowsLocatorVerdict({ platform: 'win32', executionGranted: true, locator: { interpreterPath: 'C:\\node\\node.exe', targetPath: null } })
  assert.deepEqual(half.reasons, ['win32_target_not_resolved'])
  const same = windowsLocatorVerdict({ platform: 'win32', executionGranted: true, locator: { interpreterPath: 'C:\\x.exe', targetPath: 'C:\\x.exe' } })
  assert.equal(same.status, 'NOT_RUN')
  assert.ok(same.reasons.includes('win32_locator_not_a_fixed_pair'))

  // Non-Windows has no locator requirement: DE-BERO must not be blocked by it.
  assert.deepEqual(windowsLocatorVerdict({ platform: 'linux', executionGranted: true, locator: null }), { status: 'PASS', reasons: [], required: false })
})

/* ---------------------------------------------------------------- verdicts */

const skillInput = {
  prompt: 'Use the isolated acceptance skill and return its marker.',
  reply: `done ${SKILL_MARK}`,
  projectedSkills: [{ id: SKILL_ID, name: 'dsh-accept', body: 'description', origin: 'explicit' }],
  itemId: SKILL_ID,
  marker: SKILL_MARK
}
const ruleInput = {
  prompt: 'Return the rule marker from your selected rule.',
  reply: `rule ${RULE_MARK}`,
  projectedRules: [{ id: RULE_ID, name: 'accept-rule', body: `answer ${RULE_MARK}`, origin: 'explicit' }],
  itemId: RULE_ID,
  marker: RULE_MARK
}

test('a Skill cell passes only when load, projection and reply agree', () => {
  assert.deepEqual(skillVerdict(skillInput), { status: 'PASS', reasons: [] })
  assert.deepEqual(skillVerdict({ ...skillInput, prompt: `leak ${SKILL_MARK}` }).reasons, ['marker_in_user_prompt'])
  assert.deepEqual(skillVerdict({ ...skillInput, projectedSkills: [] }).reasons, ['skill_not_selected_in_projection'])
  assert.deepEqual(skillVerdict({ ...skillInput, reply: 'done' }).reasons, ['marker_not_returned_by_model'])
  assert.equal(skillVerdict({ ...skillInput, reply: 'done' }).status, 'FAIL')
})

test('a Rule cell needs the marker in the selected rule body and in the reply', () => {
  assert.deepEqual(ruleVerdict(ruleInput), { status: 'PASS', reasons: [] })
  assert.deepEqual(ruleVerdict({ ...ruleInput, projectedRules: [] }).reasons, ['rule_not_selected_in_projection'])
  assert.deepEqual(
    ruleVerdict({ ...ruleInput, projectedRules: [{ id: RULE_ID, name: 'r', body: 'no marker', origin: 'explicit' }] }).reasons,
    ['rule_body_missing_marker_in_projection']
  )
  assert.deepEqual(ruleVerdict({ ...ruleInput, prompt: `leak ${RULE_MARK}` }).reasons, ['marker_in_user_prompt'])
  assert.equal(ruleVerdict({ ...ruleInput, reply: 'ok' }).status, 'FAIL')
})

test('an MCP cell needs exactly one real call and a round-tripped payload', () => {
  assert.deepEqual(
    mcpVerdict({ callsBefore: 0, callsAfter: 1, reply: `echo ${ECHO}`, echo: ECHO }),
    { status: 'PASS', reasons: [] }
  )
  assert.deepEqual(
    mcpVerdict({ callsBefore: 3, callsAfter: 4, reply: `echo ${ECHO}`, echo: ECHO }).status,
    'PASS'
  )
  assert.deepEqual(
    mcpVerdict({ callsBefore: 0, callsAfter: 0, reply: `echo ${ECHO}`, echo: ECHO }).reasons,
    ['mcp_call_delta_0']
  )
  assert.deepEqual(
    mcpVerdict({ callsBefore: 0, callsAfter: 2, reply: `echo ${ECHO}`, echo: ECHO }).reasons,
    ['mcp_call_delta_2']
  )
  assert.deepEqual(
    mcpVerdict({ callsBefore: 0, callsAfter: 1, reply: 'no tool text', echo: ECHO }).reasons,
    ['echo_payload_not_returned_by_model']
  )
})

test('only Codex has a command-hook transport in Core today', () => {
  assert.equal(hookTransportFor('codex-cli'), 'codex-command-hooks')
  for (const adapter of ['deepseek-harness', 'claude-code', 'pi', 'opencode-cli']) {
    assert.equal(hookTransportFor(adapter), 'none')
  }
})

test('an unsupported Hook is NOT_RUN and can never be counted as a pass', () => {
  const unsupported = hookVerdict({ receiptExists: false, hookTransport: 'none', selectionRefusedCode: null })
  assert.equal(unsupported.status, 'NOT_RUN')
  assert.ok(unsupported.reasons.includes('no_hook_transport_for_adapter'))
  assert.match(unsupported.note, /codex_hook_grant/u)

  const refused = hookVerdict({
    receiptExists: false,
    hookTransport: 'none',
    selectionRefusedCode: 'capability.hook_review_required'
  })
  assert.equal(refused.status, 'NOT_RUN')
  assert.ok(refused.reasons.some(reason => reason.startsWith('selection_refused_capability.hook_review_required')))

  // A receipt without a transport is a real anomaly, not a silent pass.
  const suspicious = hookVerdict({ receiptExists: true, hookTransport: 'none', selectionRefusedCode: null })
  assert.equal(suspicious.status, 'FAIL')
  assert.ok(suspicious.reasons.includes('unexpected_receipt_without_transport'))

  assert.deepEqual(
    hookVerdict({ receiptExists: true, hookTransport: 'codex-command-hooks', selectionRefusedCode: null }),
    { status: 'PASS', reasons: [] }
  )
  assert.equal(
    hookVerdict({ receiptExists: false, hookTransport: 'codex-command-hooks', selectionRefusedCode: null }).status,
    'FAIL'
  )
})

/* ---------------------------------------------------------------- overall */

const passCells = () => ({
  skill: { status: 'PASS', reasons: [] },
  rule: { status: 'PASS', reasons: [] },
  mcp: { status: 'PASS', reasons: [] },
  hook: { status: 'PASS', reasons: [] }
})

test('overall acceptance passes only when all four cells pass', () => {
  const all = overallVerdict(passCells())
  assert.equal(all.status, 'PASS')
  assert.equal(all.exitCode, EXIT.PASS)
  assert.deepEqual(all.counts, { pass: 4, fail: 0, notRun: 0 })
})

test('one NOT_RUN cell blocks overall acceptance even with three passes', () => {
  const cells = passCells()
  cells.hook = { status: 'NOT_RUN', reasons: ['no_hook_transport_for_adapter'] }
  const overall = overallVerdict(cells)
  assert.equal(overall.status, 'NOT_RUN')
  assert.equal(overall.exitCode, EXIT.NOT_RUN)
  assert.deepEqual(overall.counts, { pass: 3, fail: 0, notRun: 1 })
})

test('a FAIL cell outranks a NOT_RUN cell and a missing cell is NOT_RUN', () => {
  const cells = passCells()
  cells.hook = { status: 'NOT_RUN', reasons: ['no_hook_transport_for_adapter'] }
  cells.mcp = { status: 'FAIL', reasons: ['mcp_call_delta_0'] }
  const overall = overallVerdict(cells)
  assert.equal(overall.status, 'FAIL')
  assert.equal(overall.exitCode, EXIT.FAIL)
  assert.deepEqual(overall.counts, { pass: 2, fail: 1, notRun: 1 })

  const partial = overallVerdict({ skill: { status: 'PASS', reasons: [] } })
  assert.equal(partial.status, 'NOT_RUN')
  assert.deepEqual(partial.cells.find(entry => entry.cell === 'hook').reasons, ['cell_missing'])
})

test('the deselection negative is required before overall acceptance can pass', () => {
  const all = overallVerdict(passCells())
  assert.equal(applyNegativeScope(all, { status: 'PASS', skillMarkerAbsent: true, ruleMarkerAbsent: true }).status, 'PASS')
  assert.equal(applyNegativeScope(all, { status: 'PASS' }).exitCode, EXIT.PASS)

  const leaked = applyNegativeScope(all, { status: 'FAIL', skillMarkerAbsent: false })
  assert.equal(leaked.status, 'FAIL')
  assert.equal(leaked.exitCode, EXIT.FAIL)
  assert.equal(leaked.negativeScope, 'FAIL')

  // Skipping the negative cannot produce a green run: scope stays unproven.
  const skipped = applyNegativeScope(all, undefined)
  assert.equal(skipped.status, 'NOT_RUN')
  assert.equal(skipped.exitCode, EXIT.NOT_RUN)
  assert.equal(skipped.negativeScope, 'NOT_RUN')

  const alreadyFailed = overallVerdict({ ...passCells(), mcp: { status: 'FAIL', reasons: ['mcp_call_delta_0'] } })
  const keptFailure = applyNegativeScope(alreadyFailed, undefined)
  assert.equal(keptFailure.status, 'FAIL')
  assert.equal(keptFailure.exitCode, EXIT.FAIL)
})

test('a selection that moved during the Run downgrades attribution instead of guessing', () => {
  const stable = applySelectionStability(passCells(), true)
  assert.equal(stable.skill.status, 'PASS')

  const unstable = applySelectionStability(passCells(), false)
  assert.equal(unstable.skill.status, 'NOT_RUN')
  assert.equal(unstable.rule.status, 'NOT_RUN')
  assert.deepEqual(unstable.skill.reasons, ['selection_changed_during_run'])
  // MCP and Hook are receipt-based, so their evidence survives a selection change.
  assert.equal(unstable.mcp.status, 'PASS')
  assert.equal(unstable.hook.status, 'PASS')
  assert.equal(overallVerdict(unstable).status, 'NOT_RUN')
})

test('an already failing cell is not relabelled by selection stability', () => {
  const cells = passCells()
  cells.skill = { status: 'FAIL', reasons: ['marker_not_returned_by_model'] }
  const unstable = applySelectionStability(cells, false)
  assert.equal(unstable.skill.status, 'FAIL')
  assert.deepEqual(unstable.skill.reasons, ['marker_not_returned_by_model'])
})

/* -------------------------------------------------------------- fixture I/O */

test('the isolated layout stays inside one root and gives every seam its own path', () => {
  const root = join('tmp-tests', 'rovai-accept-dsh-1')
  const paths = fixturePaths(root)
  const values = Object.values(paths)
  for (const value of values) {
    assert.ok(value === root || value.startsWith(`${root}${sep}`), `${value} must stay inside ${root}`)
  }
  assert.equal(new Set(values).size, values.length)
  assert.ok(paths.home !== paths.dshHome && paths.dshHome !== paths.dshAgentsHome)
  assert.ok(paths.mcpCalls.endsWith('mcp-calls.txt'))
  assert.ok(paths.hookReceipt.endsWith('hook-receipt.txt'))
})

test('a missing receipt file stays missing evidence, not a pass', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rovai-accept-dsh-test-'))
  try {
    const paths = fixturePaths(root)
    assert.equal(await fileOrNull(paths.hookReceipt), null)
    assert.equal(countLines(await fileOrNull(paths.mcpCalls)), 0)
    assert.equal(hookVerdict({
      receiptExists: (await fileOrNull(paths.hookReceipt)) !== null,
      hookTransport: hookTransportFor('deepseek-harness'),
      selectionRefusedCode: null
    }).status, 'NOT_RUN')

    writeFileSync(paths.mcpCalls, 'called\ncalled\n')
    assert.equal(countLines(await fileOrNull(paths.mcpCalls)), 2)
    assert.equal(countLines(''), 0)
    assert.equal(countLines(undefined), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the Skill marker is written only into the SKILL body', () => {
  const document = skillDocument('dsh-accept-abcd', SKILL_MARK)
  assert.equal(document.split(SKILL_MARK).length - 1, 1)
  assert.match(document, /^---\nname: dsh-accept-abcd\n/u)
  assert.match(document, /description: Isolated acceptance skill/u)
  assert.equal(document.includes('RULE_MARK'), false)
})

test('narration comes from this Run only, never another Run and never a tool payload alone', () => {
  const snapshot = {
    messages: [
      { sourceAgentRunId: 'run-1', body: `answer ${SKILL_MARK}` },
      { sourceAgentRunId: 'run-2', body: 'other run text' },
      { sourceAgentRunId: 'run-1', content: { segments: [{ kind: 'text', text: ' more' }] } },
      { body: 'user prompt echo' }
    ]
  }
  const narration = runNarration(snapshot, 'run-1')
  assert.ok(narration.includes(SKILL_MARK))
  assert.ok(narration.includes('more'))
  assert.equal(narration.includes('other run text'), false)
  assert.equal(narration.includes('user prompt echo'), false)
  assert.equal(runNarration(snapshot, 'run-3'), '')
  assert.equal(runNarration({}, 'run-1'), '')
})

test('message text is read from the shapes the Camp snapshot really uses', () => {
  assert.equal(messageText({ body: 'body text' }), 'body text')
  assert.equal(messageText({ content: { segments: [{ text: 'a' }, { kind: 'atom' }, { text: 'b' }] } }), 'ab')
  assert.equal(messageText({ content: 'plain' }), 'plain')
  assert.equal(messageText({}), '')
  assert.equal(messageText(null), '')
})

test('evidence digests are stable and short markers are not confused', () => {
  assert.equal(sha256('abc'), sha256('abc'))
  assert.notEqual(sha256('abc'), sha256('abd'))
  assert.equal(sha256('abc').length, 64)
  assert.equal(skillVerdict({ ...skillInput, reply: `x${SKILL_MARK.slice(0, 5)}` }).status, 'FAIL')
})

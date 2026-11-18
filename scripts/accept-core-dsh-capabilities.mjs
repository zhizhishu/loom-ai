#!/usr/bin/env node
// Real Core → DeepSeekRuntime (DSH) capability acceptance: Skill / MCP / Rule / Hook.
//
// Scope and honesty boundary (read before trusting any output):
//   * This drives the EXISTING production Core over its own stdio RPC. It adds no wire
//     field, no Adapter, no substitute scheduler and no second capability store.
//   * Only real product seams are used, with shapes taken from the implementation:
//       - threads.creationPreflight / members.get / members.runtime.set
//           (crates/rovai-core/src/application/web_commands.rs, scripts/configure-product-runtime.mjs)
//       - skills.import.inspect {path} / skills.import.commit {commandId, command}
//           (crates/rovai-core/src/skill.rs::inspect_import / commit_import)
//       - mcp.config.get / mcp.servers.create / mcp.servers.setMembers
//       - members.capabilityCatalog.get|set|putItem
//           (crates/rovai-core/src/member_capability.rs; set is deny_unknown_fields with
//            agentId, expectedRevision, acknowledgeHighRisk, selections, reviewedHooks)
//       - members.runProjection.preview {member} → {bootstrap, skills, rules, hooks}
//           (crates/rovai-core/src/run_projection.rs; ProjectedCapability = {id,name,body,origin})
//       - camps.snapshot {threadId} → agentRuns / messages / approvals / actions / contextManifests
//           (crates/rovai-core/src/read_model.rs:593-640 ContextManifestView, skill_projection.rs:190-193)
//       - threads.create + thread.messages.send via scripts/lib/create-configured-camp.mjs
//   * members.runProjection.preview is only consulted for its own limitation. DSH is rejected
//     there (run_projection.rs:272-286 runtime_required, :142-148 runtime_unsupported); that
//     refusal is recorded as `preview: NOT_RUN` and the Run still happens. Load evidence for
//     the cells comes from the Run's own frozen context manifest plus the DSH Bootstrap
//     binding file (dsh.rs:549-563 {schemaVersion,sessionId,bootstrap,sha256}), never from
//     members.runBundle.freeze (remote_run_bundle.rs:243-247 rejects DSH) and never from the
//     model's own wording.
//   * A cell is PASS only when the load, the Run and a native/actual receipt agree:
//       Skill  the random marker exists ONLY in the imported SKILL.md body; the Run's own
//              context manifest exposes that exact skillId/revisionId/contentDigest with a
//              delivered status; the model returns the marker while the prompt never had it;
//              deselecting the Skill makes the marker disappear in a second Run.
//       Rule   the marker exists ONLY in the selected rule body; the DSH Bootstrap binding
//              for the same native session re-hashes to its recorded sha256 and contains
//              that marker; the model returns it; deselecting removes it.
//       MCP    the fixed echo fixture records exactly ONE new real call and the echo
//              payload round-trips into the Run's own message text.
//       Hook   a unique receipt file appears in this isolated directory AND the adapter
//              really has a hook transport. DSH has none:
//              crates/rovai-core/src/remote_run_bundle/source.rs::codex_hook_grant
//              returns Ok(None) for every adapter other than CodexCli, and
//              crates/rovai-core/src/member_capability.rs::hook_review::validate_request
//              requires a Core-internal definition/scope digest pair this script must not
//              fabricate. DSH hooks are therefore reported `unsupported`, never "executed".
//   * Model text alone is never evidence of an execution. A missing receipt is FAIL or
//     NOT_RUN, never PASS, and overall acceptance cannot pass while any cell is NOT_RUN.
//   * Provider wiring never copies a global config, login state or DSH Home. The native
//     settings file written into the isolated DSH_HOME has exactly the production shape
//     used by scripts/smoke-dsh-responses-tools.mjs:84-95 and
//     scripts/smoke-dsh-model-configuration.mjs:66-73:
//       settings.yaml = {"llm-pi-ai":{"providers":{relay:{api,baseURL,apiKeyEnv,models:[{id,contextWindow,maxTokens}]}}}}
//     Only the provider base URL / wire api / model identity come from the passed public
//     route. `apiKeyEnv` is an environment VARIABLE NAME: the credential value stays in
//     the process environment (LOOM_E4_PROVIDER_KEY or OCT_API_KEY) and is never written
//     to the fixture or the evidence. No public route means NOT_RUN before any model.
//   * Windows uses only the Core-owned native shim locator. This script never parses,
//     re-wraps or forwards a .cmd/.bat, and never launches cmd.exe/pwsh. It rejects an
//     entrypoint Core cannot own BEFORE Core starts, then requires the resolver-derived
//     canonicalInterpreterPath + resolvedTargetPath (crates/rovai-core/src/runtime_discovery.rs:1774-1780)
//     to be present before any Run is allowed. A missing locator is NOT_RUN, not a pass.
//   * Permission is always `workspace-write` or `read-only`; `danger-full-access` is not
//     offered by this script at all.
//   * Without LOOM_ACCEPT_DSH_CAPABILITIES=1 nothing runs: the report is NOT_RUN and the
//     exit code is 2. `--prepare-only` prints the isolated paths (no secrets, no network,
//     no Core start) and exits 0.
//
// Exit codes: 0 every capability cell PASS and the deselection negative PASS · 1 a cell
// or the negative FAILED · 2 NOT_RUN (not opted in, or a cell/negative could not be
// proven) · 3 usage/setup refusal.
//
// Usage (all actual runs belong to the supervisor):
//   LOOM_ACCEPT_DSH_CAPABILITIES=1 LOOM_E4_PROVIDER_KEY=... \
//     node scripts/accept-core-dsh-capabilities.mjs \
//       --public-config <provider.baseUrl+api, model.id JSON> \
//       --dsh-bin /path/to/dsh --permission-mode workspace-write \
//       --evidence _artifacts/core-dsh-capabilities-<stamp>.json
//   node scripts/accept-core-dsh-capabilities.mjs --prepare-only
//
// `--public-config` is mandatory for a real run: without it the script exits 2 with
// no_public_route before starting Core, so a machine's own DSH Home is never borrowed.

import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, lstat, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createConfiguredCampAndSend } from './lib/create-configured-camp.mjs'
import { startQualificationCore } from './lib/qualification-core.mjs'
import { removeEphemeralRuntimeCampFilesRoot } from './lib/runtime-camp-files-root.mjs'
import { readFrozenRule, readSelectedMaterial, readNativeSelectedSkill } from './lib/dsh-frozen-evidence.mjs'

export const ACCEPT_VERSION = 1
export const SCRIPT_NAME = 'accept-core-dsh-capabilities'
export const OPT_IN_ENV = 'LOOM_ACCEPT_DSH_CAPABILITIES'
export const PROVIDER_KEY_ENVS = Object.freeze(['LOOM_E4_PROVIDER_KEY', 'OCT_API_KEY'])
export const ADAPTER_KIND = 'deepseek-harness'
export const CELLS = Object.freeze(['skill', 'rule', 'mcp', 'hook'])
/** dsh_permission_options(): the DSH sandbox values. danger-full-access is never offered. */
export const DSH_PERMISSION_MODES = Object.freeze(['read-only', 'workspace-write'])
export const DSH_APPROVAL_POLICIES = Object.freeze(['ask', 'never'])
export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, NOT_RUN: 2, REFUSED: 3 })

export class UsageError extends Error {
  constructor (code, message) { super(message); this.code = code; this.name = 'UsageError' }
}

/* --------------------------------------------------------------- arguments */

const VALUE_FLAGS = {
  '--evidence': 'evidence',
  '--fixture-root': 'fixtureRoot',
  '--core-binary': 'coreBinary',
  '--public-config': 'publicConfig',
  '--dsh-bin': 'dshBin',
  '--permission-mode': 'permissionMode',
  '--approval-policy': 'approvalPolicy',
  '--skill-transport': 'skillTransport',
  '--run-timeout-ms': 'runTimeoutMs',
  '--label': 'label'
}
const BOOLEAN_FLAGS = {
  '--prepare-only': 'prepareOnly',
  '--skip-negative': 'skipNegative',
  '--keep-fixture': 'keepFixture'
}

export function parseArguments (argv) {
  const options = {
    prepareOnly: false,
    skipNegative: false,
    keepFixture: false,
    permissionMode: 'workspace-write',
    approvalPolicy: 'never',
    runTimeoutMs: 240_000
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (BOOLEAN_FLAGS[flag]) { options[BOOLEAN_FLAGS[flag]] = true; continue }
    const key = VALUE_FLAGS[flag]
    if (!key) throw new UsageError('usage', `unknown option ${flag}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new UsageError('usage', `${flag} needs a value`)
    options[key] = value
    index += 1
  }
  if (!DSH_PERMISSION_MODES.includes(options.permissionMode)) {
    throw new UsageError('usage', `--permission-mode must be one of ${DSH_PERMISSION_MODES.join(', ')}`)
  }
  if (!DSH_APPROVAL_POLICIES.includes(options.approvalPolicy)) {
    throw new UsageError('usage', `--approval-policy must be one of ${DSH_APPROVAL_POLICIES.join(', ')}`)
  }
  if (options.skillTransport !== undefined && !['native-registry', 'core-index-read'].includes(options.skillTransport)) {
    throw new UsageError('usage', '--skill-transport must be native-registry or core-index-read')
  }
  const timeout = Number(options.runTimeoutMs)
  if (!Number.isInteger(timeout) || timeout < 30_000 || timeout > 1_800_000) {
    throw new UsageError('usage', '--run-timeout-ms must be an integer between 30000 and 1800000')
  }
  options.runTimeoutMs = timeout
  if (options.label !== undefined && !/^[A-Za-z0-9_.-]{1,60}$/u.test(options.label)) {
    throw new UsageError('usage', '--label must be 1..60 characters of letters, digits, _ . -')
  }
  return options
}

/* ----------------------------------------------------------------- secrets */

/** The only provider credential sources. The value never leaves this function. */
export function selectProviderKey (env = process.env) {
  for (const name of PROVIDER_KEY_ENVS) {
    const value = env[name]
    if (typeof value === 'string' && value.trim().length > 0) return { name, value }
  }
  return null
}

export function redact (text, secrets = []) {
  let out = String(text ?? '')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) out = out.split(secret).join('[redacted]')
  }
  return out
}

export function findSecret (value, secrets = []) {
  const list = secrets.filter(secret => typeof secret === 'string' && secret.length > 0)
  const visit = item => {
    if (typeof item === 'string') return list.find(secret => item.includes(secret)) ?? null
    if (Array.isArray(item)) {
      for (const nested of item) { const hit = visit(nested); if (hit) return hit }
      return null
    }
    if (item && typeof item === 'object') {
      for (const [key, nested] of Object.entries(item)) {
        const hit = visit(key) ?? visit(nested)
        if (hit) return hit
      }
    }
    return null
  }
  return visit(value)
}

/** Evidence that would carry a credential is refused, not silently rewritten. */
export function assertNoSecrets (value, secrets = []) {
  const hit = findSecret(value, secrets)
  if (hit) throw new UsageError('secret_leak', 'refusing to write evidence that contains a provider credential')
  return value
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** Separate acceptance variant for the already published frozen-resource path.
 * No provider configuration, permission, or native-registry support is changed.
 */
export function capabilityAcceptancePrompt({ skillTransport = 'native-registry', echoMarker }) {
  if (!['native-registry', 'core-index-read'].includes(skillTransport)) throw new UsageError('usage', 'unknown Skill transport')
  const reading = skillTransport === 'core-index-read'
  return [
    'This is an isolated LOOM acceptance. Use the provided capabilities exactly as instructed.',
    reading
      ? '1. Read exactly the SKILL.md of the isolated acceptance skill listed under this Run\'s [ROVAI_ADDITIONAL_SKILLS] root using the native read tool. Return its skill marker. This checks the published frozen-resource path, not the native skill registry; do not invoke skill(), glob, shell, or read a different resource.'
      : '1. Load the isolated acceptance skill and return the skill marker it contains.',
    '2. Return the rule marker from your selected rule.',
    `3. Call the parity MCP tool echo exactly once with text ${echoMarker} and return its actual result.`,
    '4. Then reply exactly DONE.',
    reading
      ? 'The single selected SKILL.md read above is the only permitted file read. Do not write any file or run a shell command. If the current index has no such skill or the native tool refuses, stop that step and report it; do not search other roots, change configuration, request broader permissions, or bypass the refusal.'
      : 'Do not read or write files, do not run shell commands, and do not ask for broader permissions.'
  ].join('\n')
}

/* ------------------------------------------------------------ public route */

/**
 * A passed-in public route supplies the provider base URL, wire api and model identity.
 * Any API key, token or authorization field is refused: the route is never a credential
 * channel, and no global configuration is read by this script.
 */
export function readPublicConfig (text) {
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new UsageError('public_config', 'public config is not JSON') }
  for (const forbidden of ['apiKey', 'api_key', 'token', 'authorization', 'headers', 'envKey', 'env_key', 'secret', 'password', 'apiKeyEnv']) {
    if (containsKey(parsed, forbidden)) {
      throw new UsageError('public_config', `public config must not carry a credential field (${forbidden})`)
    }
  }
  const declaredModelId = parsed?.model?.id
  if (typeof declaredModelId !== 'string' || declaredModelId.length === 0) {
    throw new UsageError('public_config', 'public config has no model.id')
  }
  const baseUrl = parsed?.provider?.baseUrl
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new UsageError('public_config', 'public config has no provider.baseUrl')
  }
  // The wire protocol is never inferred from the URL: it must be stated.
  const providerApi = parsed?.provider?.api
  if (typeof providerApi !== 'string' || providerApi.length === 0) {
    throw new UsageError('public_config', 'public config has no provider.api')
  }
  let providerOrigin = null
  try { providerOrigin = new URL(baseUrl).origin } catch { providerOrigin = null }
  const contextWindow = Number.isInteger(parsed?.model?.contextWindow) && parsed.model.contextWindow > 0
    ? parsed.model.contextWindow : null
  const maxTokens = Number.isInteger(parsed?.model?.maxTokens) && parsed.model.maxTokens > 0
    ? parsed.model.maxTokens : null
  return { declaredModelId, providerOrigin, providerApi, baseUrl, contextWindow, maxTokens }
}

export const DSH_MODEL_PLUGIN = 'llm-pi-ai'
export const DSH_PROVIDER_NAME = 'relay'

/**
 * SOURCE_ADOPTED: the ACP profile accepts a default `{provider, model}` declaration.
 * _artifacts/reference-repos/deepseek-harness apps/web/tests/session-log-upload.e2e.ts:19-24 and
 * scripts/smoke-dsh-model-availability.mjs:143-154,:360 write
 * `[{id:'llm-pi-ai',config:{providers:{relay:…}}},{id:'acp',config:{provider:'relay',model:'same-model'}}]`
 * and that run resolves dshSource:'native'. Nothing here invents a new shape.
 */
export function relayModelPair ({ provider = DSH_PROVIDER_NAME, modelId }) {
  return JSON.stringify([provider, modelId])
}

/** Decode a DSH wire model id; only a 2-segment JSON array carries a provider. */
export function decodeRelayModel ({ modelId }) {
  if (typeof modelId !== 'string') return null
  let parsed
  try { parsed = JSON.parse(modelId) } catch { return null }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null
  if (typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return null
  return { provider: parsed[0], model: parsed[1] }
}

export function modelProviderOf ({ modelId }) {
  return decodeRelayModel({ modelId })?.provider ?? null
}

/**
 * Exactly one live catalog entry for the relay pair, or a refusal code. A hidden,
 * deprecated, web-only, wrong-provider or duplicated id is never a native route.
 */
export function selectRelayCatalogEntry ({ models, expectedId, provider = DSH_PROVIDER_NAME }) {
  const entries = Array.isArray(models) ? models : []
  const matches = entries.filter(entry => entry?.id === expectedId)
  if (matches.length === 0) return { entry: null, code: 'relay_not_in_catalog' }
  if (matches.length > 1) return { entry: null, code: 'relay_catalog_ambiguous' }
  const entry = matches[0]
  if (entry.runtimeMetadata?.dshSource === 'web') return { entry: null, code: 'relay_catalog_web_only' }
  if (entry.hidden === true) return { entry: null, code: 'relay_catalog_hidden' }
  if (entry.deprecated === true) return { entry: null, code: 'relay_catalog_deprecated' }
  const decoded = decodeRelayModel({ modelId: entry.id })
  if (decoded === null || decoded.provider !== provider) return { entry: null, code: 'relay_catalog_wrong_provider' }
  return { entry, code: null }
}

/** ModelSelection.options is an object; catalog options are descriptors and never its source. */
export function assertModelOptions (options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new UsageError('model_options', 'ModelSelection.options must be a plain object')
  }
  return options
}

/** The readback must agree on both the provider and the decoded native model id. */
export function nativeModelReadback ({ modelId, expected }) {
  const reasons = []
  const decoded = decodeRelayModel({ modelId })
  if (decoded === null) reasons.push('model_id_not_native_pair')
  else {
    if (decoded.provider !== expected?.provider) reasons.push('model_provider_drift')
    if (decoded.model !== expected?.modelId) reasons.push('model_id_drift')
  }
  return { status: reasons.length === 0 ? 'PASS' : 'NOT_RUN', reasons, decoded }
}

/** The isolated ACP profile patch: relay provider plus the explicit default row. */
export function buildDshAcpPatch ({ nativeSettings, modelId, providerName = DSH_PROVIDER_NAME }) {
  const provider = nativeSettings?.[DSH_MODEL_PLUGIN]?.providers?.[providerName]
  if (!provider) throw new UsageError('public_route', 'relay provider settings are missing')
  return [
    { id: DSH_MODEL_PLUGIN, config: { providers: { [providerName]: provider } } },
    { id: 'acp', config: { provider: providerName, model: modelId } }
  ]
}

/** Every home-like location a Runtime, probe or helper could fall back to. */
export const HOMELIKE_ENV_NAMES = Object.freeze([
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR',
  'DSH_HOME', 'DSH_AGENTS_HOME'
])

export const CREDENTIAL_SHAPED_ENV =
  /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|AUTH|BEARER)(?:_|$)/iu

/**
 * The isolated child environment. Every home-like name is redirected into this fixture's
 * own root (docs/development/local-workflow.md:37-41 style isolation), and every inherited
 * credential-shaped variable is masked with `undefined` — Node's spawn skips undefined
 * values, so the child simply never receives the variable (never the string "undefined").
 * The single selected provider key is the only credential kept, and only by name.
 */
export function buildIsolatedEnvironment ({ paths, providerKeyName, env = process.env }) {
  const overrides = {
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.apdata,
    LOCALAPPDATA: paths.localAppData,
    TEMP: paths.temp,
    TMP: paths.temp,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_DATA_HOME: paths.xdgData,
    XDG_CACHE_HOME: paths.xdgCache,
    XDG_STATE_HOME: paths.xdgState,
    CODEX_HOME: paths.codexHome,
    CLAUDE_CONFIG_DIR: paths.claudeConfig,
    PI_CODING_AGENT_DIR: paths.piAgent,
    DSH_HOME: paths.dshHome,
    DSH_AGENTS_HOME: paths.dshAgentsHome
  }
  const masked = []
  for (const name of Object.keys(env)) {
    if (name === providerKeyName) continue
    if (HOMELIKE_ENV_NAMES.includes(name)) continue
    if (!CREDENTIAL_SHAPED_ENV.test(name)) continue
    overrides[name] = undefined
    masked.push(name)
  }
  return { overrides, maskedSort: masked.sort() }
}

const WINDOWS_DATA_ROOT_KEYS = [
  'root', 'core', 'electronUserData', 'electronSessionData', 'logs', 'crashDumps'
]

/** The exact native preparation call documented for the Windows formal layout. */
export function windowsDataRootPreparationArgs (formalRoot) {
  return ['--prepare-windows-data-root', formalRoot]
}

/**
 * Core prints exactly one JSON layout line for the formal root and creates it natively
 * (protected DACL). This script never mkdirs that root itself: it only reads `core`.
 */
export function parseWindowsDataRootLayout (stdout, requestedRoot) {
  const lines = String(stdout ?? '').trim().split(/\r?\n/u).filter(Boolean)
  if (lines.length !== 1) return { ok: false, code: 'win32_data_root_frame_invalid' }
  let parsed
  try { parsed = JSON.parse(lines[0]) } catch { return { ok: false, code: 'win32_data_root_json_invalid' } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'win32_data_root_layout_invalid' }
  }
  if (Object.keys(parsed).sort().join('\0') !== [...WINDOWS_DATA_ROOT_KEYS].sort().join('\0')) {
    return { ok: false, code: 'win32_data_root_layout_unknown_shape' }
  }
  if (WINDOWS_DATA_ROOT_KEYS.some(key => typeof parsed[key] !== 'string' || parsed[key].length === 0)) {
    return { ok: false, code: 'win32_data_root_layout_invalid' }
  }
  const lower = value => value.replaceAll('/', '\\').toLowerCase()
  if (lower(parsed.root) !== lower(requestedRoot)) {
    return { ok: false, code: 'win32_data_root_root_mismatch' }
  }
  if (!lower(parsed.core).startsWith(`${lower(parsed.root)}\\`)) {
    return { ok: false, code: 'win32_data_root_core_outside_root' }
  }
  return { ok: true, core: parsed.core, root: parsed.root, logs: parsed.logs }
}

/**
 * The production DSH native settings shape, built only from the passed public route.
 * `apiKeyEnv` is the ENV NAME; the credential itself never enters this object.
 */
export function buildDshNativeSettings ({ publicConfig, apiKeyEnv, providerName = DSH_PROVIDER_NAME }) {
  if (typeof apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(apiKeyEnv)) {
    throw new UsageError('public_route', 'apiKeyEnv must be an environment variable name')
  }
  const model = { id: publicConfig.declaredModelId }
  if (publicConfig.contextWindow !== null) model.contextWindow = publicConfig.contextWindow
  if (publicConfig.maxTokens !== null) model.maxTokens = publicConfig.maxTokens
  return {
    [DSH_MODEL_PLUGIN]: {
      providers: {
        [providerName]: {
          api: publicConfig.providerApi,
          baseURL: publicConfig.baseUrl,
          apiKeyEnv,
          models: [model]
        }
      }
    }
  }
}

function containsKey (value, needle) {
  if (Array.isArray(value)) return value.some(item => containsKey(item, needle))
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, nested]) =>
    key.toLowerCase() === needle.toLowerCase() || containsKey(nested, needle))
}

/**
 * DSH wire model ids are produced by the Adapter, not guessed here. A public route names
 * a bare model; the Adapter may report a `[provider, model]` wire id. Only an exact match
 * or a matching last element counts as comparable, and an incomparable pair is NOT a
 * mismatch: it is a shape we refuse to score.
 */
export function compareModelIdentity (declaredModelId, observedModelId) {
  if (typeof declaredModelId !== 'string' || declaredModelId.length === 0 ||
      typeof observedModelId !== 'string' || observedModelId.length === 0) {
    return { comparable: false, matches: false, reason: 'model_identity_missing' }
  }
  if (declaredModelId === observedModelId) return { comparable: true, matches: true, reason: 'exact' }
  let parsed
  try { parsed = JSON.parse(observedModelId) } catch { parsed = null }
  if (Array.isArray(parsed) && parsed.length > 0) {
    const last = parsed[parsed.length - 1]
    return { comparable: true, matches: last === declaredModelId, reason: 'adapter_wire_id_last_element' }
  }
  return { comparable: false, matches: false, reason: 'model_identity_shape_not_comparable' }
}

/**
 * The program path handed to Core. On Windows the official entrypoints are .exe/.cmd/.bat
 * (crates/rovai-core/src/runtime_discovery.rs:2014-2020). This script never interprets the
 * shim: an entrypoint Core cannot own is refused BEFORE Core starts, and the shim itself
 * is only ever resolved by Core's own locator.
 */
export function resolveDshProgramPath ({ platform, dshBin }) {
  if (typeof dshBin !== 'string' || dshBin.trim().length === 0) {
    return { ok: false, code: 'dsh_binary_missing', reason: 'pass --dsh-bin or set ROVAI_DEEPSEEK_HARNESS_BIN' }
  }
  if (platform === 'win32') {
    const lower = dshBin.toLowerCase()
    if (!/\.(exe|cmd|bat)$/u.test(lower)) {
      return {
        ok: false,
        code: 'win32_unsupported_entrypoint',
        reason: 'Core can only own a Windows .exe/.cmd/.bat entrypoint; refusing before Core starts instead of reading the shim here'
      }
    }
    return { ok: true, programPath: dshBin, shimInterpretation: 'core-locator-only' }
  }
  return { ok: true, programPath: dshBin, shimInterpretation: 'native-executable' }
}

const LOCATOR_INTERPRETER_KEYS = ['canonicalInterpreterPath', 'canonical_interpreter_path']
const LOCATOR_TARGET_KEYS = ['resolvedTargetPath', 'resolved_target_path']

function deepFindKey (value, keys, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null
  seen.add(value)
  for (const [key, nested] of Object.entries(value)) {
    if (keys.includes(key) && typeof nested === 'string' && nested.length > 0) return nested
  }
  for (const nested of Object.values(value)) {
    const hit = deepFindKey(nested, keys, seen)
    if (hit !== null) return hit
  }
  return null
}

/** The public locator Core resolved for this installation, read verbatim, never invented. */
export function readCoreWindowsLocator (installation) {
  return {
    interpreterPath: deepFindKey(installation, LOCATOR_INTERPRETER_KEYS),
    targetPath: deepFindKey(installation, LOCATOR_TARGET_KEYS),
    entrypointKind: deepFindKey(installation, ['entrypointKind', 'entrypoint_kind'])
  }
}

/**
 * Windows is only allowed to run after Core's resolver bound a fixed interpreter + target.
 * Anything else is NOT_RUN: this script never launches cmd.exe/pwsh and never trusts a
 * shim it parsed itself.
 */
export function windowsLocatorVerdict ({ platform, executionGranted, locator }) {
  if (platform !== 'win32') {
    return { status: 'PASS', reasons: [], required: false }
  }
  if (!executionGranted) return { status: 'NOT_RUN', reasons: ['win32_locator_unused'], required: true }
  const reasons = []
  if (!locator?.interpreterPath) reasons.push('win32_interpreter_not_resolved')
  if (!locator?.targetPath) reasons.push('win32_target_not_resolved')
  if (locator?.interpreterPath && locator?.targetPath && locator.interpreterPath === locator.targetPath) {
    reasons.push('win32_locator_not_a_fixed_pair')
  }
  return reasons.length === 0
    ? { status: 'PASS', reasons, required: true }
    : { status: 'NOT_RUN', reasons, required: true }
}

/** Bounded DSH setup. A refused startup edit is terminal, never a polling loop. */
export const SETUP_TOTAL_MS = 120_000
export const SETUP_REQUEST_MS = 60_000
export const MAX_OBSERVATIONS = 3

/**
 * The current formal startup save shape is a field edit, not expectedRevision+configuration
 * (crates/rovai-core/src/runtime_startup.rs:256-360, mirrored by
 * runtime_check_refresh_tests.rs:1283): {runtimeKind, edits:[{path,before,after,label}]}.
 */
export function startupSaveEdits ({ beforeProgramPath, afterProgramPath, label = 'isolated DSH acceptance' }) {
  return [{
    path: ['programPath'],
    before: typeof beforeProgramPath === 'string' && beforeProgramPath.length > 0 ? beforeProgramPath : null,
    after: afterProgramPath,
    label
  }]
}

export function startupSaveParams ({ runtimeKind, edits }) {
  return { runtimeKind, edits }
}

/** One write, then at most MAX_OBSERVATIONS read-only checks inside one total budget. */
export function observationAllowed ({ attemptsMade, now, deadline, maxAttempts = MAX_OBSERVATIONS }) {
  return attemptsMade < maxAttempts && Number(now) < Number(deadline)
}

/** Each setup request is capped by both the per-request limit and what is left of 120s. */
export function setupRequestTimeout ({ deadline, now, max = SETUP_REQUEST_MS }) {
  const remaining = Number(deadline) - Number(now)
  if (!Number.isFinite(remaining) || remaining <= 0) return 0
  return Math.min(max, remaining)
}

/** Closed-set setup outcome. Never carries a message, path, profile or credential. */
export function setupOutcome (error) {
  const text = String(error?.message ?? '')
  if (/timed out/iu.test(text)) return { status: 'refused', code: 'timeout' }
  if (error?.code) return { status: 'refused', code: 'rejected' }
  return { status: 'refused', code: 'rejected' }
}

/** Stage log entries carry only {stage, method, status|code}. */
export function setupLog (stage, method, outcome) {
  const entry = { stage, method }
  if (outcome !== null && typeof outcome === 'object') {
    if (outcome.code) entry.code = outcome.code
    else entry.status = String(outcome.status ?? outcome)
  } else {
    entry.status = String(outcome)
  }
  return entry
}

/**
 * The Run's own frozen context manifest. Only an exact agentRunId match counts; a
 * neighbouring Run's manifest can never justify this Run's capability cells.
 */
export function frozenManifest (snapshot, runId) {
  const manifests = Array.isArray(snapshot?.contextManifests) ? snapshot.contextManifests : []
  return manifests.find(manifest => manifest?.agentRunId === runId) ?? null
}

/** A project-owned conflicting skill can shadow different selected library bytes.
 * Its delivery-group label is not proof those selected bytes reached this Run. */
export const DELIVERED_SKILL_STATUSES = Object.freeze(['ready'])

/**
 * Exposure evidence for exactly the imported Skill: catalog ids carry the `library:`
 * prefix while SkillExposureEntry.skillId is the bare library id
 * (skill_projection.rs:175-186, :821), so the prefix is stripped before comparison.
 * An unknown status is never a delivery.
 */
export function skillExposureVerdict ({ skillExposure, expected }) {
  const entries = Array.isArray(skillExposure?.skills) ? skillExposure.skills : []
  const bareId = String(expected?.skillId ?? '').replace(/^library:/u, '')
  const entry = entries.find(candidate => candidate?.skillId === bareId) ?? null
  const reasons = []
  if (entry === null) reasons.push('skill_not_in_run_exposure')
  else {
    if (entry.revisionId !== expected?.revisionId) reasons.push('skill_revision_mismatch')
    if (entry.contentDigest !== expected?.contentDigest) reasons.push('skill_digest_mismatch')
    if (!DELIVERED_SKILL_STATUSES.includes(entry.status)) reasons.push(`skill_status_${entry.status ?? 'missing'}`)
  }
  return {
    status: reasons.length === 0 ? 'PASS' : 'NOT_RUN',
    reasons,
    entry: entry === null ? null : { skillId: entry.skillId, revisionId: entry.revisionId, status: entry.status, deliveredViaGroupKey: entry.deliveredViaGroupKey ?? null }
  }
}

/**
 * A DSH Bootstrap binding proves this Run only when the file names the same native
 * Session, its recorded sha256 re-computes, and the frozen text really carries the
 * selected Rule's own marker. Anything less is NOT_RUN (dsh.rs:549-563).
 */
export function ruleBindingVerdict ({ binding, sessionId, marker }) {
  const reasons = []
  if (binding === null) return { status: 'NOT_RUN', reasons: ['dsh_binding_not_found'] }
  if (binding.schemaVersion !== 1) reasons.push('dsh_binding_schema_mismatch')
  if (typeof sessionId !== 'string' || sessionId.length === 0) reasons.push('native_session_unknown')
  else if (binding.sessionId !== sessionId) reasons.push('dsh_binding_other_session')
  if (typeof binding.bootstrap !== 'string' || !binding.bootstrap.includes(marker)) reasons.push('rule_marker_not_in_bootstrap')
  if (binding.sha256 !== sha256(String(binding.bootstrap ?? ''))) reasons.push('dsh_binding_digest_mismatch')
  return {
    status: reasons.length === 0 ? 'PASS' : 'NOT_RUN',
    reasons,
    bootstrapSha256: typeof binding.bootstrap === 'string' ? sha256(binding.bootstrap) : null
  }
}

/**
 * Only a binding inside this fixture root can be trusted: no symlink is followed and
 * nothing outside the root is ever read.
 */
export function bindingPathInsideFixture ({ realPath, fixtureRoot, isSymbolicLink }) {
  if (isSymbolicLink) return { ok: false, code: 'binding_path_is_symlink' }
  const normalize = value => String(value).replaceAll('\\', '/').replace(/\/+$/u, '')
  const path = normalize(realPath)
  const root = normalize(fixtureRoot)
  if (path === root || !path.startsWith(`${root}/`)) return { ok: false, code: 'binding_path_outside_fixture' }
  return { ok: true }
}

/** Bounded, symlink-rejecting search for `<conversationId>.json` inside the fixture. */
export async function findDshBindingFile ({ root, sessionId, maxDepth = 6 }) {
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(String(sessionId ?? ''))) return { file: null, code: 'binding_session_id_invalid' }
  const wanted = `${sessionId}.json`
  const walk = async (directory, depth) => {
    if (depth > maxDepth) return null
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return null }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        const hit = await walk(path, depth + 1)
        if (hit !== null) return hit
      } else if (entry.isFile() && entry.name === wanted && entry.name === wanted) {
        let metadata
        try { metadata = await lstat(path) } catch { continue }
        if (metadata.isSymbolicLink()) continue
        const check = bindingPathInsideFixture({ realPath: await realpath(path), fixtureRoot: root, isSymbolicLink: false })
        if (!check.ok) return { file: null, code: check.code }
        const parsed = JSON.parse(await readFile(path, 'utf8'))
        if (parsed?.sessionId === sessionId) return { file: path, binding: parsed }
      }
    }
    return null
  }
  const found = await walk(root, 0)
  if (found === null) return { file: null, code: 'binding_file_absent' }
  if (found.file === undefined) return { file: null, code: found.code ?? 'binding_file_absent' }
  return found
}

/* ---------------------------------------------------------------- verdicts */

const hits = (text, marker) => typeof text === 'string' && text.length > 0 && text.includes(marker)

const projectedById = (projection, itemId) =>
  Array.isArray(projection) ? projection.filter(entry => entry?.id === itemId) : []

/** Skill: marker exclusively in the SKILL body, real Run exposure, returned by the model. */
export function skillVerdict ({ prompt, reply, projectedSkills, itemId, marker, exposed }) {
  const reasons = []
  if (hits(prompt, marker)) reasons.push('marker_in_user_prompt')
  if (exposed === undefined) {
    // Legacy judgement kept for pure tests; a real DSH Run always passes `exposed`.
    if (projectedById(projectedSkills, itemId).length === 0) reasons.push('skill_not_selected_in_projection')
  } else if (exposed.status !== 'PASS') {
    for (const reason of exposed.reasons) reasons.push(`exposure_${reason}`)
  }
  if (!hits(reply, marker)) reasons.push('marker_not_returned_by_model')
  return verdictOf(reasons)
}

/** Rule: marker exclusively in the selected rule body, proven by this Run's DSH binding. */
export function ruleVerdict ({ prompt, reply, projectedRules, itemId, marker, binding }) {
  const reasons = []
  if (hits(prompt, marker)) reasons.push('marker_in_user_prompt')
  if (binding === undefined) {
    const matches = projectedById(projectedRules, itemId)
    if (matches.length === 0) reasons.push('rule_not_selected_in_projection')
    else if (!matches.some(entry => hits(entry?.body, marker))) reasons.push('rule_body_missing_marker_in_projection')
  } else if (binding.status !== 'PASS') {
    for (const reason of binding.reasons) reasons.push(`binding_${reason}`)
  }
  if (!hits(reply, marker)) reasons.push('marker_not_returned_by_model')
  return verdictOf(reasons)
}

/** Missing frozen evidence is NOT_RUN; a contradicting observation is a FAIL. */
function verdictOf (reasons) {
  if (reasons.length === 0) return { status: 'PASS', reasons }
  const missing = reasons.some(reason => reason.startsWith('exposure_') || reason.startsWith('binding_'))
  return { status: missing ? 'NOT_RUN' : 'FAIL', reasons }
}

/** MCP: exactly one new real fixture call and the echo payload round-trips. */
export function mcpVerdict ({ callsBefore, callsAfter, reply, echo }) {
  const reasons = []
  const delta = Number(callsAfter) - Number(callsBefore)
  if (!Number.isInteger(delta) || delta !== 1) reasons.push(`mcp_call_delta_${Number.isFinite(delta) ? delta : 'unknown'}`)
  if (!hits(reply, echo)) reasons.push('echo_payload_not_returned_by_model')
  return reasons.length === 0 ? { status: 'PASS', reasons } : { status: 'FAIL', reasons }
}

/** Only Codex has a real command-hook transport in Core today. */
export function hookTransportFor (adapterKind) {
  return adapterKind === 'codex-cli' ? 'codex-command-hooks' : 'none'
}

/**
 * Hook: a receipt must exist for a PASS, and only an adapter with a real hook transport
 * may claim one. A selected DSH hook is `unsupported`, exactly like an unselected one.
 */
export function hookVerdict ({ receiptExists, hookTransport, selectionRefusedCode }) {
  const reasons = []
  if (hookTransport !== 'codex-command-hooks') {
    reasons.push('no_hook_transport_for_adapter')
    if (selectionRefusedCode) reasons.push(`selection_refused_${selectionRefusedCode}`)
    if (receiptExists) reasons.push('unexpected_receipt_without_transport')
    return {
      status: receiptExists ? 'FAIL' : 'NOT_RUN',
      reasons,
      note: 'remote_run_bundle/source.rs::codex_hook_grant returns None for every adapter other than CodexCli'
    }
  }
  if (!receiptExists) reasons.push('receipt_missing')
  return reasons.length === 0 ? { status: 'PASS', reasons } : { status: 'FAIL', reasons }
}

/**
 * The Skill/Rule cells are only attributable if the capability selection did not move
 * between the projection read and the Run. A revision that changed mid-Run downgrades
 * those two cells to NOT_RUN instead of guessing which selection the model saw.
 */
export function applySelectionStability (cells, stable) {
  if (stable) return cells
  const downgrade = cell => (cell.status === 'PASS'
    ? { ...cell, status: 'NOT_RUN', reasons: [...(cell.reasons ?? []), 'selection_changed_during_run'] }
    : cell)
  return { ...cells, skill: downgrade(cells.skill), rule: downgrade(cells.rule) }
}

/** Overall: PASS requires every cell PASS; a NOT_RUN cell can never be rounded up. */
export function overallVerdict (cells) {
  const list = CELLS.map(cell => ({ cell, ...(cells[cell] ?? { status: 'NOT_RUN', reasons: ['cell_missing'] }) }))
  const failed = list.filter(entry => entry.status === 'FAIL')
  const notRun = list.filter(entry => entry.status === 'NOT_RUN')
  const status = failed.length > 0 ? 'FAIL' : (notRun.length > 0 ? 'NOT_RUN' : 'PASS')
  return {
    status,
    exitCode: status === 'PASS' ? EXIT.PASS : (status === 'FAIL' ? EXIT.FAIL : EXIT.NOT_RUN),
    cells: list,
    counts: {
      pass: list.filter(entry => entry.status === 'PASS').length,
      fail: failed.length,
      notRun: notRun.length
    }
  }
}

/**
 * The Skill/Rule cells claim that the capability was selected for THIS instance. That
 * claim is only proven by the deselection Run: an unskipped negative that still returns
 * the marker, or a skipped negative, must not leave the whole acceptance green.
 */
export function deselectionVerdict ({ runId, runStatus, catalog, expectedRevision,
  skillId, ruleId, materialObservations, skillMarkerAbsent, ruleMarkerAbsent }) {
  const reasons = []
  if (runStatus !== 'succeeded') reasons.push('negative_run_not_succeeded')
  const selectionStable = typeof expectedRevision === 'string' && catalog?.revision === expectedRevision
  if (!selectionStable) reasons.push('negative_selection_changed')
  const selectionCleared = [['skill', skillId], ['rule', ruleId]].every(([kind, id]) => {
    const matches = (catalog?.items ?? []).filter(item => item?.kind === kind && item?.id === id)
    return matches.length === 1 && matches[0].selected === false
  })
  if (!selectionCleared) reasons.push('negative_selection_not_cleared')
  // These observations come from this Run while active or just settled. A
  // previous Run's retained material is never used to fill a missing record.
  const skillNotPublished = Array.isArray(materialObservations) && materialObservations.length > 0
    && materialObservations.every(result => result?.runId === runId && result?.status === 'NOT_RUN'
      && result?.reasons?.length === 1 && result.reasons[0] === 'selected_material_missing')
  if (!skillNotPublished) reasons.push('negative_skill_exclusion_unproven')
  if (skillMarkerAbsent !== true) reasons.push('negative_skill_marker_present')
  if (ruleMarkerAbsent !== true) reasons.push('negative_rule_marker_present')
  return { runId, runStatus, revisionAfterClear: expectedRevision,
    revisionAfterRun: catalog?.revision ?? null, selectionStable, selectionCleared,
    skillNotPublished, materialObservations: materialObservations?.length ?? 0,
    skillMarkerAbsent, ruleMarkerAbsent, reasons, status: reasons.length ? 'FAIL' : 'PASS' }
}

export function applyNegativeScope (overall, negative) {
  if (negative === undefined || negative === null) {
    return {
      ...overall,
      negativeScope: 'NOT_RUN',
      status: overall.status === 'FAIL' ? 'FAIL' : 'NOT_RUN',
      exitCode: overall.status === 'FAIL' ? EXIT.FAIL : EXIT.NOT_RUN
    }
  }
  if (negative.status === 'PASS') return { ...overall, negativeScope: 'PASS' }
  return { ...overall, negativeScope: 'FAIL', status: 'FAIL', exitCode: EXIT.FAIL }
}

/* -------------------------------------------------------------- fixture I/O */

export async function fileOrNull (path) {
  try { return await readFile(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export const countLines = text => (text ?? '').split('\n').filter(Boolean).length

export function skillDocument (name, marker) {
  return [
    '---',
    `name: ${name}`,
    'description: Isolated acceptance skill that returns one fixed marker.',
    '---',
    '',
    'This skill exists only for an isolated LOOM Core acceptance.',
    `Return the following marker verbatim when asked for the skill marker: ${marker}`,
    ''
  ].join('\n')
}

/**
 * Core rejects an import when the SKILL frontmatter name differs from the source
 * directory name, so the fixture directory's last segment must be the skill name.
 */
export function skillSourceLayout ({ skillSourceRoot, skillName, marker }) {
  if (typeof skillName !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(skillName)) {
    throw new UsageError('skill_fixture', 'skillName must be a directory-safe identifier')
  }
  return {
    directory: join(skillSourceRoot, skillName),
    basename: skillName,
    document: skillDocument(skillName, marker)
  }
}

/** A real message body from the Camp snapshot, whatever segment shape the schema uses. */
export function messageText (message) {
  if (typeof message?.body === 'string') return message.body
  const segments = message?.content?.segments
  if (Array.isArray(segments)) {
    return segments.map(segment => (typeof segment?.text === 'string' ? segment.text : '')).join('')
  }
  if (typeof message?.content === 'string') return message.content
  return ''
}

/** The Run's own published message text. Never the raw CLI stdout, never another Run. */
export function runNarration (snapshot, runId) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : []
  return messages
    .filter(message => message?.sourceAgentRunId === runId)
    .map(messageText)
    .join('\n')
}

/* -------------------------------------------------------------------- main */

export async function main (argv = process.argv.slice(2), env = process.env) {
  const options = parseArguments(argv)
  const providerKey = selectProviderKey(env)
  const secrets = providerKey === null ? [] : [providerKey.value]
  const dshBin = options.dshBin ?? env.ROVAI_DEEPSEEK_HARNESS_BIN ?? ''
  const program = resolveDshProgramPath({ platform: process.platform, dshBin })
  const coreBinary = resolve(options.coreBinary ?? join(repoRoot(), 'target', 'debug', 'rovai-core'))

  if (options.prepareOnly) {
    // No network, no Core, no key material: only the isolated layout this run would own.
    const root = await realpath(await mkdtemp(join(options.fixtureRoot ?? tmpdir(), 'rovai-accept-dsh-')))
    const paths = fixturePaths(root)
    const isolated = buildIsolatedEnvironment({ paths, providerKeyName: providerKey?.name ?? '', env })
    for (const directory of ordinarySubroots(paths)) await mkdir(directory, { recursive: true })
    process.stdout.write(`${JSON.stringify({
      script: SCRIPT_NAME,
      mode: 'prepare-only',
      adapterKind: ADAPTER_KIND,
      coreBinary,
      dshProgramPath: program.ok ? program.programPath : null,
      dshProgramRefusal: program.ok ? null : { code: program.code, reason: program.reason },
      permissionMode: options.permissionMode,
      approvalPolicy: options.approvalPolicy,
      isolated: paths,
      environmentNames: Object.keys(isolated.overrides).sort(),
      maskedCredentialNames: isolated.maskedSort,
      windowsDataRoot: process.platform === 'win32'
        ? { preparedBy: 'core', args: windowsDataRootPreparationArgs(paths.formal), note: 'the formal root is created only by rovai-core --prepare-windows-data-root; this script never mkdirs it' }
        : { preparedBy: 'script', note: 'Linux keeps the ordinary data directory' },
      optInEnv: OPT_IN_ENV,
      providerKeyEnvResolved: providerKey?.name ?? null,
      note: 'no credential is written here; export the provider key yourself when you run for real'
    }, null, 2)}\n`)
    return EXIT.PASS
  }

  if (env[OPT_IN_ENV] !== '1') {
    process.stdout.write(`${JSON.stringify({
      script: SCRIPT_NAME,
      status: 'NOT_RUN',
      reason: 'not_opted_in',
      requiredEnv: OPT_IN_ENV,
      note: 'this acceptance spends real provider calls; set the opt-in to run it'
    }, null, 2)}\n`)
    return EXIT.NOT_RUN
  }
  if (options.publicConfig === undefined) {
    // No route, no Run: nothing is started and no model is contacted.
    process.stdout.write(`${JSON.stringify({
      script: SCRIPT_NAME,
      status: 'NOT_RUN',
      reason: 'no_public_route',
      requiredFlag: '--public-config <provider.baseUrl+api, model.id>',
      note: 'the DSH provider route must be supplied explicitly; a global DSH Home or login state is never inherited'
    }, null, 2)}\n`)
    return EXIT.NOT_RUN
  }
  if (providerKey === null) {
    throw new UsageError('provider_key', `one of ${PROVIDER_KEY_ENVS.join(' | ')} must carry the real provider credential`)
  }
  if (!program.ok) throw new UsageError(program.code, program.reason)
  if (!existsSync(coreBinary)) {
    throw new UsageError('core_binary_missing', `${coreBinary} does not exist; build it with cargo build -p rovai-core --bins`)
  }

  const declared = readPublicConfig(await readFile(options.publicConfig, 'utf8'))
  const nativeSettings = buildDshNativeSettings({ publicConfig: declared, apiKeyEnv: providerKey.name })

  const root = await realpath(await mkdtemp(join(options.fixtureRoot ?? tmpdir(), 'rovai-accept-dsh-')))
  const paths = fixturePaths(root)
  const evidencePath = resolve(options.evidence ?? join(root, 'evidence.json'))
  const skillName = `dsh-accept-${randomBytes(4).toString('hex')}`
  const skillMarker = `SKILL_MARK_${randomBytes(8).toString('hex')}`
  const ruleMarker = `RULE_MARK_${randomBytes(8).toString('hex')}`
  const echoMarker = `MCP_MARK_${randomBytes(8).toString('hex')}`
  const hookMarker = `HOOK_MARK_${randomBytes(8).toString('hex')}`
  const events = []
  const skillTransport = options.skillTransport ?? 'native-registry'

  const report = {
    version: ACCEPT_VERSION,
    script: SCRIPT_NAME,
    adapterKind: ADAPTER_KIND,
    startedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    permissionMode: options.permissionMode,
    approvalPolicy: options.approvalPolicy,
    skillTransport,
    acceptanceVariant: skillTransport === 'core-index-read' ? 'core-frozen-resource-native-read-v1' : 'native-registry-v1',
    nativeSkillRegistryVerified: false,
    isolated: paths,
    providerKeyEnv: providerKey.name,
    providerKeyPersisted: false,
    declaredModelId: declared.declaredModelId,
    cells: {},
    runs: [],
    setupProgress: [],
    notes: [
      'a PASS cell needs load + Run + a native or actual receipt; model text alone is never an execution proof',
      'the DSH Hook cell is expected to be NOT_RUN: Core has no hook transport outside Codex'
    ]
  }
  let core = null
  try {
    const isolated = buildIsolatedEnvironment({ paths, providerKeyName: providerKey.name, env })
    report.maskedCredentialNames = isolated.maskedSort
    report.environmentNames = Object.keys(isolated.overrides).sort()

    // Ordinary fixture subroots only. The formal Windows root is never created here.
    for (const directory of ordinarySubroots(paths)) await mkdir(directory, { recursive: true })

    if (process.platform === 'win32') {
      // The formal data root must be created by Core's own native preparation: it owns the
      // protected DACL and returns the exact layout (docs/development/local-workflow.md:37-41).
      let stdout
      try {
        stdout = execFileSync(coreBinary, windowsDataRootPreparationArgs(paths.formal), {
          encoding: 'utf8', windowsHide: true, timeout: 120_000,
          env: { ...process.env, ...isolated.overrides }
        })
      } catch (error) {
        report.windowsDataRoot = { ok: false, code: 'win32_data_root_unprepared', detail: String(error?.message ?? error).slice(0, 400) }
        report.status = 'NOT_RUN'
        report.overall = { status: 'NOT_RUN', exitCode: EXIT.NOT_RUN, negativeScope: 'NOT_RUN', reasons: ['win32_data_root_unprepared'] }
        report.finishedAt = new Date().toISOString()
        await writeFile(evidencePath, `${JSON.stringify(assertNoSecrets(report, secrets), null, 2)}\n`, { mode: 0o600 })
        process.stdout.write(`overall NOT_RUN — win32_data_root_unprepared\nevidence ${evidencePath}\n`)
        return EXIT.NOT_RUN
      }
      const layout = parseWindowsDataRootLayout(stdout, paths.formal)
      report.windowsDataRoot = layout
      if (!layout.ok) {
        report.status = 'NOT_RUN'
        report.overall = { status: 'NOT_RUN', exitCode: EXIT.NOT_RUN, negativeScope: 'NOT_RUN', reasons: [layout.code] }
        report.finishedAt = new Date().toISOString()
        await writeFile(evidencePath, `${JSON.stringify(assertNoSecrets(report, secrets), null, 2)}\n`, { mode: 0o600 })
        process.stdout.write(`overall NOT_RUN — ${layout.code}\nevidence ${evidencePath}\n`)
        return EXIT.NOT_RUN
      }
      // Only the Core-declared child becomes the data directory.
      paths.data = layout.core
    }

    // The native DSH route comes only from the passed public config; the credential is an
    // env name, so nothing secret is written here. Shape: smoke-dsh-responses-tools.mjs:91-95.
    await writeFile(join(paths.dshHome, 'settings.yaml'), `${JSON.stringify(nativeSettings)}\n`, { mode: 0o600 })
    // The ACP profile itself must declare the relay provider and its explicit default row:
    // models.mjs only routes providers that a profile patch layer declares as explicit.
    const acpPatchPath = join(paths.dshHome, 'profiles', 'acp', 'cordis.patch.yml')
    const acpPatch = buildDshAcpPatch({ nativeSettings, modelId: declared.declaredModelId })
    await mkdir(join(paths.dshHome, 'profiles', 'acp'), { recursive: true })
    await writeFile(acpPatchPath, `${JSON.stringify(acpPatch)}\n`, { mode: 0o600 })
    await writeFile(join(paths.project, 'README.md'), '# Isolated DSH capability acceptance\n')
    execFileSync('git', ['init', '-b', 'main'], { cwd: paths.project, stdio: 'ignore' })
    execFileSync('git', ['-c', 'user.name=Runtime acceptance', '-c', 'user.email=runtime@rovai.local', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: paths.project, stdio: 'ignore' })
    // The Skill marker lives only here; the user prompt never contains it.
    const skillSource = skillSourceLayout({ skillSourceRoot: paths.skillSource, skillName, marker: skillMarker })
    await mkdir(skillSource.directory, { recursive: true })
    await writeFile(join(skillSource.directory, 'SKILL.md'), skillSource.document)

    core = startQualificationCore({
      coreExecutable: coreBinary,
      dataDirectory: paths.data,
      workingDirectory: repoRoot(),
      runtimeCacheDirectory: join(root, 'runtime-cache'),
      mcpConfigPath: join(paths.data, 'mcp.json'),
      onNotification: event => events.push(event),
      environmentOverrides: {
        ...isolated.overrides,
        DSH_TELEMETRY_DISABLED: '1',
        ROVAI_DEEPSEEK_HARNESS_BIN: program.programPath,
        [providerKey.name]: providerKey.value
      }
    })
    await core.request('health.check')
    const workspace = await core.request('workspaces.inspect', { path: paths.project })

    // --- member + real product permission ----------------------------------
    const preflight = await core.request('threads.creationPreflight')
    const present = (preflight?.presentMembers ?? []).map(entry => entry.agentId)
    const agentId = present.includes('agent_2') ? 'agent_2' : present[0]
    assert.ok(typeof agentId === 'string' && agentId.length > 0, 'the isolated Core must expose one present member')
    report.agentId = agentId

    // --- bounded DSH setup: one read, one field-edit write, <=3 observations --
    const setupDeadline = Date.now() + SETUP_TOTAL_MS
    const record = (stage, method, outcome) => {
      const entry = setupLog(stage, method, outcome)
      report.setupProgress.push(entry)
      process.stdout.write(`setup ${entry.stage} ${entry.method} ${entry.code ?? entry.status}\n`)
    }
    const readOnly = async (stage, method, params = {}) => {
      const timeoutMs = setupRequestTimeout({ deadline: setupDeadline, now: Date.now() })
      if (timeoutMs === 0) throw new UsageError('dsh_setup_budget_exhausted', 'setup budget exhausted before a read-only request')
      const result = await core.request(method, params, timeoutMs)
      record(stage, method, 'ok')
      return result
    }
    const abortSetup = async (code) => {
      report.status = 'NOT_RUN'
      report.overall = { status: 'NOT_RUN', exitCode: EXIT.NOT_RUN, negativeScope: 'NOT_RUN', reasons: [code] }
      report.finishedAt = new Date().toISOString()
      await writeFile(evidencePath, `${JSON.stringify(assertNoSecrets(report, secrets), null, 2)}\n`, { mode: 0o600 })
      process.stdout.write(`overall NOT_RUN — ${code}\nevidence ${evidencePath}\n`)
      return EXIT.NOT_RUN
    }

    const startup = await readOnly('startup', 'runtime.startup.get', { runtimeKind: ADAPTER_KIND })
    const beforeProgramPath = typeof startup?.configuration?.programPath === 'string'
      ? startup.configuration.programPath
      : null
    report.startupBefore = { programPathPresent: beforeProgramPath !== null, revision: startup?.revision ?? null }

    try {
      await core.request('runtime.startup.save', startupSaveParams({
        runtimeKind: ADAPTER_KIND,
        edits: startupSaveEdits({ beforeProgramPath, afterProgramPath: program.programPath, label: 'isolated DSH acceptance' })
      }), setupRequestTimeout({ deadline: setupDeadline, now: Date.now() }) || SETUP_REQUEST_MS)
      record('startup', 'runtime.startup.save', 'applied')
    } catch (error) {
      // Terminal for setup: the field edit is written exactly once.
      const outcome = setupOutcome(error)
      record('startup', 'runtime.startup.save', outcome)
      return await abortSetup(`dsh_startup_edit_${outcome.code}`)
    }

    let installation = null
    let observations = 0
    try {
      while (observationAllowed({ attemptsMade: observations, now: Date.now(), deadline: setupDeadline })) {
        observations += 1
        await readOnly('observe', 'runtime.product.check', { runtimeKind: ADAPTER_KIND })
        const list = await readOnly('observe', 'runtime.installations.list')
        installation = (Array.isArray(list) ? list : []).find(candidate =>
          candidate?.adapterKind === ADAPTER_KIND
          && candidate?.installationClass === 'managed_default'
          && candidate?.authScope === 'default'
          && candidate?.memberRuntimeDefaults) ?? null
        record('observe', 'runtime.installations.list', installation === null ? 'absent'
          : installation.snapshot?.probeStatus === 'ready' ? 'ready' : 'installed_unverified')
        if (installation !== null) break
      }
    } catch (error) {
      if (error?.code === 'dsh_setup_budget_exhausted') return await abortSetup('dsh_setup_budget_exhausted')
      throw error
    }
    if (installation === null) {
      // Distinguish "budget ran out" from "Core said nothing is installed".
      const deadlineHit = Date.now() >= setupDeadline
      return await abortSetup(deadlineHit
        ? 'dsh_setup_budget_exhausted'
        : (observations >= MAX_OBSERVATIONS ? 'dsh_installation_unavailable' : 'dsh_setup_aborted'))
    }
    // Availability and model discovery are distinct Core operations. Use the
    // same explicit model-menu request as the product instead of treating a
    // discovered executable as ready, or retrying a startup write.
    if (installation.snapshot?.probeStatus !== 'ready') {
      const originalInstallationId = installation.installationId ?? installation.id
      if (typeof originalInstallationId !== 'string' || !originalInstallationId) {
        return await abortSetup('dsh_installation_identity_missing')
      }
      const catalog = await readOnly('catalog', 'runtime.modelCatalog.open', {
        runtimeKind: ADAPTER_KIND, waitForRefresh: true
      })
      report.catalogDiscovery = { refreshStatus: catalog?.refreshStatus ?? null,
        diagnosticCode: catalog?.diagnosticCode ?? null,
        modelCount: Array.isArray(catalog?.models) ? catalog.models.length : 0 }
      const refreshed = await readOnly('catalog', 'runtime.installations.list')
      const exact = (Array.isArray(refreshed) ? refreshed : []).find(row =>
        (row.installationId ?? row.id) === originalInstallationId && row.adapterKind === ADAPTER_KIND)
      if (!exact || exact.snapshot?.probeStatus !== 'ready') {
        // Preserve Core's bounded public diagnostic on the exact installation.
        // A discovered executable alone cannot explain a failed model refresh.
        report.catalogDiscovery.probeFailure = exact?.lastProbeAttempt?.failure ?? null
        return await abortSetup('dsh_catalog_not_ready')
      }
      installation = exact
    }
    report.probeStatus = installation?.snapshot?.probeStatus ?? null
    report.dshDiscovery = {
      installationClass: installation.installationClass ?? null,
      authScope: installation.authScope ?? null,
      probeStatus: installation?.snapshot?.probeStatus ?? null,
      version: installation?.snapshot?.version ?? null,
      observations
    }

    // The public installation view intentionally omits the private locator
    // identity (runtime_discovery.rs uses serde(skip)). Absence is not a
    // runtime refusal and must not block exercising a Core-admitted adapter.
    // Do not invent private paths or claim they were independently observed.
    const locator = readCoreWindowsLocator(installation)
    const locatorVerdict = windowsLocatorVerdict({ platform: process.platform, executionGranted: true, locator })
    report.windowsLocator = { ...locatorVerdict, ...locator }
    if (locatorVerdict.status !== 'PASS') {
      report.windowsLocator.status = 'NOT_EXPOSED_BY_PUBLIC_VIEW'
      report.notes.push('Private Windows interpreter/locator identity was not independently observable; actual execution still requires Core readiness and normal native process admission. No shell fallback is used.')
    }
    assert.equal(installation.adapterKind, ADAPTER_KIND)
    assert.equal(installation.snapshot?.probeStatus, 'ready')
    assert.ok(typeof installation.executablePath === 'string' && installation.executablePath.length > 0)

    // One write, already at the requested sandbox: never danger-full-access first.
    const configuredMember = await readOnly('member', 'members.get', { agentId })
    const relayPair = relayModelPair({ modelId: declared.declaredModelId })
    const relayPick = selectRelayCatalogEntry({ models: installation.snapshot?.models, expectedId: relayPair })
    record('member', 'runtime.installations.list.models', relayPick.code ?? 'relay_found')
    if (relayPick.entry === null) return await abortSetup(relayPick.code)
    const configured = await core.request('members.runtime.set', {
      commandId: randomUUID(),
      command: {
        agentId,
        expectedVersion: configuredMember.version,
        adapterKind: ADAPTER_KIND,
        // The catalog entry id is the native route; neither pair nor provider is invented here.
        model: { mode: 'explicit', modelId: relayPick.entry.id, options: assertModelOptions({}) },
        permissions: {
          ...installation.memberRuntimeDefaults.permissions,
          values: { sandbox_mode: options.permissionMode, approval_policy: options.approvalPolicy }
        }
      }
    }, setupRequestTimeout({ deadline: setupDeadline, now: Date.now() }) || SETUP_REQUEST_MS)
    record('member', 'members.runtime.set', configured?.status === 'applied' ? 'applied' : 'rejected')
    if (configured?.status !== 'applied') return await abortSetup('dsh_member_runtime_set_rejected')
    const member = await readOnly('member', 'members.get', { agentId })
    report.effectivePermissions = member.runtimeConfiguration?.permissions?.values ?? null
    if (report.effectivePermissions?.sandbox_mode !== options.permissionMode) {
      return await abortSetup('dsh_sandbox_not_applied')
    }
    report.observedModelId = member.runtimeConfiguration?.model?.modelId ?? null
    const nativeReadback = nativeModelReadback({
      modelId: report.observedModelId ?? '',
      expected: { provider: DSH_PROVIDER_NAME, modelId: declared.declaredModelId }
    })
    record('member', 'members.get.model', nativeReadback.status === 'PASS' ? 'relay_native' : nativeReadback.reasons.join('+'))
    if (nativeReadback.status !== 'PASS') return await abortSetup(nativeReadback.reasons[0])
    report.memberRuntime = {
      adapterKind: member.runtimeConfiguration?.adapterKind ?? null,
      readiness: member.runtimeReadiness?.status ?? null
    }
    // The identity check compares the decoded native model id, never the JSON pair.
    report.modelIdentity = compareModelIdentity(declared.declaredModelId, nativeReadback.decoded?.model ?? '')
    report.publicRoute = {
      providerOrigin: declared.providerOrigin,
      providerApi: declared.providerApi,
      declaredModelId: declared.declaredModelId,
      apiKeyEnv: providerKey.name,
      settingsSha256: sha256(JSON.stringify(nativeSettings)),
      settingsPath: join(paths.dshHome, 'settings.yaml'),
      acpPatchPath,
      acpPatchSha256: sha256(JSON.stringify(acpPatch)),
      catalogModelId: relayPick.entry.id
    }

    // --- capability materialization through the real APIs -------------------
    const inspection = await core.request('skills.import.inspect', { path: paths.skillSource })
    const candidate = (inspection?.candidates ?? []).find(entry => entry?.name === skillName)
    assert.ok(candidate, `the Skill import inspection must offer ${skillName}: ${JSON.stringify(inspection?.rejectedCandidates ?? [])}`)
    const commit = await core.request('skills.import.commit', {
      commandId: randomUUID(),
      command: {
        stagingToken: inspection.stagingToken,
        candidateName: candidate.name,
        expectedDigest: candidate.contentDigest,
        expectedSkillVersion: candidate.existingSkillVersion ?? null,
        confirmUpdate: false
      }
    })
    assert.equal(commit.status, 'applied', `Skill import commit must apply: ${JSON.stringify(commit.payload)}`)
    const skillId = commit.payload?.skillId
    assert.ok(typeof skillId === 'string' && skillId.length > 0, 'the Skill import commit must return payload.skillId')
    const registeredSkill = await core.request('members.capabilityCatalog.putItem', {
      kind: 'skill', itemId: `library:${skillId}`, toolNames: []
    })

    const mcpConfig = await core.request('mcp.config.get')
    const created = await core.request('mcp.servers.create', {
      expectedConfigDigest: mcpConfig.configDigest,
      definitionJson: JSON.stringify({
        mcpServers: {
          parity: {
            command: process.execPath,
            args: [resolve(repoRoot(), 'crates/rovai-core/tests/fixtures/mcp-smoke-server.mjs')],
            env: { ROVAI_MCP_SMOKE_SOURCE: 'accept', ROVAI_MCP_SMOKE_CALL_MARKER: paths.mcpCalls }
          }
        }
      })
    })
    assert.equal(created?.status, 'ok', `mcp.servers.create must be ok: ${JSON.stringify(created?.status)}`)
    const afterCreate = await core.request('mcp.config.get')
    const serverId = (afterCreate.servers ?? []).find(server => server?.name === 'parity')?.serverId
      ?? (created?.config?.servers ?? []).find(server => server?.name === 'parity')?.serverId
    assert.ok(typeof serverId === 'string' && serverId.length > 0, 'the fixture MCP server must exist after create')
    const assigned = await core.request('mcp.servers.setMembers', {
      expectedConfigDigest: afterCreate.configDigest, serverId, agentIds: [agentId]
    })
    assert.equal(assigned?.status, 'ok', 'mcp.servers.setMembers must be ok')
    report.mcpServerId = serverId
    const mcpItem = await core.request('members.capabilityCatalog.putItem', {
      kind: 'mcp', itemId: serverId, toolNames: ['echo']
    })

    const ruleItem = await core.request('members.capabilityCatalog.putItem', {
      kind: 'rule',
      itemId: `rule_accept_${randomBytes(4).toString('hex')}`,
      name: `accept-rule-${randomBytes(3).toString('hex')}`,
      note: 'isolated acceptance rule',
      scope: 'cloud',
      body: `Isolated acceptance rule. When asked for the rule marker, answer exactly ${ruleMarker} and nothing else.`,
      toolNames: []
    })

    const hookItem = await core.request('members.capabilityCatalog.putItem', {
      kind: 'hook',
      itemId: `hook_accept_${randomBytes(4).toString('hex')}`,
      name: `accept-hook-${randomBytes(3).toString('hex')}`,
      note: 'isolated acceptance hook; expected to be unsupported for DSH',
      scope: 'cloud',
      body: JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: `printf '%s' '${hookMarker}' > '${paths.hookReceipt}'`, timeout: 5 }] }] }
      }),
      toolNames: []
    })

    const catalog = await core.request('members.capabilityCatalog.get', { agentId })
    const selectionIds = [
      { kind: 'skill', id: registeredSkill.id, selected: true },
      { kind: 'mcp', id: mcpItem.id, selected: true },
      { kind: 'rule', id: ruleItem.id, selected: true }
    ]
    const applied = await core.request('members.capabilityCatalog.set', {
      agentId,
      expectedRevision: catalog.revision,
      acknowledgeHighRisk: false,
      selections: selectionIds,
      reviewedHooks: []
    })
    report.selectionRevision = applied.revision
    report.selected = selectionIds

    // A hook is selected in its own CAS write so a refusal cannot invalidate the
    // Skill/Rule/MCP selection that the main Run relies on.
    let hookSelectionRefusedCode = null
    let hookSelected = false
    try {
      const hookApplied = await core.request('members.capabilityCatalog.set', {
        agentId,
        expectedRevision: applied.revision,
        acknowledgeHighRisk: true,
        selections: [{ kind: 'hook', id: hookItem.id, selected: true }],
        reviewedHooks: []
      })
      hookSelected = true
      report.selectionRevision = hookApplied.revision
    } catch (error) {
      hookSelectionRefusedCode = String(error?.message ?? 'hook_selection_refused').slice(0, 200)
      report.hookSelectionRefusedCode = redact(hookSelectionRefusedCode, secrets)
    }

    // --- pre-Run capability read: preview only reports its own limitation ---
    // Real frozen evidence comes from the Run's own context manifest after the Run.
    let projection = null
    try {
      projection = await core.request('members.runProjection.preview', { member: agentId }, SETUP_REQUEST_MS)
      record('preview', 'members.runProjection.preview', 'ok')
    } catch (error) {
      const code = error?.code
      if (!['runtime_required', 'runtime_unsupported'].includes(code)) throw error
      report.preview = { status: 'NOT_RUN', code, reasons: ['preview_runtime_unsupported'], observedAt: new Date().toISOString() }
      record('preview', 'members.runProjection.preview', { code })
    }
    report.preview ??= { status: 'PASS', code: null, reasons: [] }
    const revisionAtProjection = report.selectionRevision

    // --- Run ----------------------------------------------------------------
    const prompt = capabilityAcceptancePrompt({ skillTransport, echoMarker })
    assert.equal(prompt.includes(skillMarker), false, 'the Skill marker must never be in the user prompt')
    assert.equal(prompt.includes(ruleMarker), false, 'the Rule marker must never be in the user prompt')
    report.promptSha256 = sha256(prompt)

    const callsBefore = countLines(await fileOrNull(paths.mcpCalls))
    const intake = await createConfiguredCampAndSend(core.request, {
      commandId: randomUUID(),
      workspace,
      address: { mode: 'explicit', agentIds: [agentId] },
      memberAgentIds: [agentId],
      defaultLeadAgentId: agentId,
      purpose: 'Isolated DSH Skill/MCP/Rule/Hook capability acceptance',
      body: prompt
    })
    const command = intake.commandResult ?? intake
    assert.equal(command.status, 'accepted', `the acceptance message must be accepted: ${JSON.stringify(command.status)}`)
    const threadId = command.payload.threadId
    const runId = await waitForAdmittedRun(core, threadId, agentId, command.payload)
    let selectedMaterial = { status: 'NOT_RUN', reasons: ['selected_material_not_observed_during_run'] }
    const selectedSkillIdentity = {
      skillId: registeredSkill.id,
      revisionId: commit.payload?.revisionId ?? null,
      contentDigest: candidate.contentDigest
    }
    const snapshot = await waitForRun(core, threadId, runId, options.runTimeoutMs, async () => {
      if (selectedMaterial.status === 'PASS') return
      selectedMaterial = await readSelectedMaterial({ dataDir: paths.data, fixtureRoot: root,
        runId, memberId: agentId, expected: selectedSkillIdentity })
    })
    const narration = runNarration(snapshot, runId)
    const manifest = frozenManifest(snapshot, runId)
    const nativeSessionId = await readNativeSessionForManifest(paths.data, root, manifest, runId)
    const binding = await findDshBindingFile({ root, sessionId: nativeSessionId })
    // Teardown can remove the transient DSH binding. The immutable Core charter
    // is an independent evidence source, not a reconstructed native receipt.
    // A present but inconsistent binding is never silently ignored.
    const frozenRule = binding?.binding
      ? ruleBindingVerdict({ binding: binding.binding, sessionId: nativeSessionId, marker: ruleMarker })
      : await readFrozenRule({ dataDir: paths.data, fixtureRoot: root, manifest,
        runId, sessionId: nativeSessionId, marker: ruleMarker })
    report.contextManifest = manifest === null
      ? { present: false }
      : {
          present: true,
          manifestId: manifest.id,
          agentRunId: manifest.agentRunId,
          skillExposureDigest: manifest.skillExposureDigest ?? null,
          mcpExposureDigest: manifest.mcpExposureDigest ?? null,
          renderedPayloadDigest: manifest.renderedPayloadDigest ?? null,
          selectedMaterial,
          nativeSessionId,
          bootstrapEvidenceId: manifest.bootstrap?.id ?? null,
          sessionCharterDigest: manifest.bootstrap?.sessionCharterDigest ?? null,
          deliveryMode: manifest.bootstrap?.deliveryMode ?? null,
          skillExposureEntries: (manifest.skillExposure?.skills ?? []).map(entry => ({
            skillId: entry.skillId, revisionId: entry.revisionId, contentDigest: entry.contentDigest, status: entry.status
          }))
        }
    report.dshBinding = {
      found: binding.file !== null,
      code: binding.code ?? null,
      pathInsideFixture: binding.file === null ? null : 'enforced-by-bounded-search',
      sha256Matches: binding.binding ? binding.binding.sha256 === sha256(String(binding.binding.bootstrap ?? '')) : null,
      sessionMatches: binding.binding ? binding.binding.sessionId === nativeSessionId : null,
      ruleEvidence: frozenRule
    }
    const callsAfter = countLines(await fileOrNull(paths.mcpCalls))
    const hookReceipt = await fileOrNull(paths.hookReceipt)
    const actions = (snapshot.actions ?? [])
      .filter(action => action?.agentRunId === runId)
      .map(action => ({ title: action.title ?? null, kind: action.kind ?? null }))

    const revisionAfterRun = (await core.request('members.capabilityCatalog.get', { agentId })).revision
    const selectionStable = revisionAfterRun === revisionAtProjection
    report.runs.push({
      runId,
      status: snapshot.agentRuns.find(entry => entry?.id === runId)?.status ?? null,
      narrationSha256: sha256(narration),
      narrationBytes: narration.length,
      actionTitles: actions.map(action => action.title),
      selectionStable
    })

    const nativeSkillRead = skillTransport === 'core-index-read'
      ? await readNativeSelectedSkill({ dataDir: paths.data, fixtureRoot: root,
          runId, skillName, marker: skillMarker, selectedMaterial })
      : null
    const skillLoadEvidence = skillTransport === 'core-index-read'
      ? nativeSkillRead
      : selectedMaterial.status === 'PASS' ? selectedMaterial : skillExposureVerdict({
          skillExposure: manifest?.skillExposure, expected: selectedSkillIdentity
        })
    const verdicts = applySelectionStability({
      skill: skillVerdict({
        prompt,
        reply: narration,
        projectedSkills: projection?.skills,
        itemId: registeredSkill.id,
        marker: skillMarker,
        exposed: skillLoadEvidence
      }),
      rule: ruleVerdict({
        prompt,
        reply: narration,
        projectedRules: projection?.rules,
        itemId: ruleItem.id,
        marker: ruleMarker,
        binding: frozenRule
      }),
      mcp: mcpVerdict({ callsBefore, callsAfter, reply: narration, echo: `accept:${echoMarker}` }),
      hook: hookVerdict({
        receiptExists: hookReceipt !== null,
        hookTransport: hookTransportFor(ADAPTER_KIND),
        selectionRefusedCode: hookSelected ? null : hookSelectionRefusedCode
      })
    }, selectionStable)
    report.cells = {
      skill: { ...verdicts.skill, itemId: registeredSkill.id, markerSha256: sha256(skillMarker),
        transport: skillTransport, nativeRead: nativeSkillRead, nativeRegistryVerified: false },
      rule: { ...verdicts.rule, itemId: ruleItem.id, markerSha256: sha256(ruleMarker) },
      mcp: { ...verdicts.mcp, itemId: mcpItem.id, callsBefore, callsAfter },
      hook: { ...verdicts.hook, itemId: hookItem.id, selected: hookSelected, receiptExists: hookReceipt !== null }
    }
    report.receipts = {
      mcpCallLines: countLines(await fileOrNull(paths.mcpCalls)),
      hookReceiptBytes: hookReceipt === null ? null : Buffer.byteLength(hookReceipt),
      selectionStableAcrossRun: selectionStable,
      revisionBeforeRun: revisionAtProjection,
      revisionAfterRun,
      coreNotifications: events.length
    }

    // --- negative scope: the same Run shape with Skill/Rule deselected --------
    if (!options.skipNegative) {
      const before = await core.request('members.capabilityCatalog.get', { agentId })
      const cleared = await core.request('members.capabilityCatalog.set', {
        agentId,
        expectedRevision: before.revision,
        acknowledgeHighRisk: false,
        selections: [
          { kind: 'skill', id: registeredSkill.id, selected: false },
          { kind: 'rule', id: ruleItem.id, selected: false }
        ],
        reviewedHooks: []
      })
      const negativeIntake = await createConfiguredCampAndSend(core.request, {
        commandId: randomUUID(),
        workspace,
        address: { mode: 'explicit', agentIds: [agentId] },
        memberAgentIds: [agentId],
        defaultLeadAgentId: agentId,
        purpose: 'Isolated DSH capability deselection negative',
        body: 'Reply exactly NEGATIVE_DONE. Do not use any tool.'
      })
      const negativeCommand = negativeIntake.commandResult ?? negativeIntake
      assert.equal(negativeCommand.status, 'accepted')
      const negativeRunId = await waitForAdmittedRun(core, negativeCommand.payload.threadId, agentId, negativeCommand.payload)
      const negativeMaterial = []
      const negativeSnapshot = await waitForRun(core, negativeCommand.payload.threadId, negativeRunId,
        options.runTimeoutMs, async (_snapshot, run) => {
          if (!run || !['running', 'succeeded'].includes(run.status)) return
          const material = await readSelectedMaterial({ dataDir: paths.data, fixtureRoot: root,
            runId: negativeRunId, memberId: agentId, expected: selectedSkillIdentity })
          negativeMaterial.push({ ...material, runId: negativeRunId })
        })
      const negativeNarration = runNarration(negativeSnapshot, negativeRunId)
      const negativeCatalog = await core.request('members.capabilityCatalog.get', { agentId })
      report.negative = deselectionVerdict({
        runId: negativeRunId,
        expectedRevision: cleared.revision,
        catalog: negativeCatalog,
        skillId: registeredSkill.id,
        ruleId: ruleItem.id,
        materialObservations: negativeMaterial,
        runStatus: negativeSnapshot.agentRuns.find(entry => entry?.id === negativeRunId)?.status ?? null,
        skillMarkerAbsent: !negativeNarration.includes(skillMarker),
        ruleMarkerAbsent: !negativeNarration.includes(ruleMarker)
      })
    }

    const scoped = applyNegativeScope(overallVerdict(report.cells), report.negative)
    report.overall = scoped
    report.finishedAt = new Date().toISOString()
    await writeFile(evidencePath, `${JSON.stringify(assertNoSecrets(report, secrets), null, 2)}\n`, { mode: 0o600 })

    for (const entry of scoped.cells) {
      process.stdout.write(`cell ${entry.cell.padEnd(5)} ${entry.status}${entry.reasons?.length ? ` — ${entry.reasons.join('+')}` : ''}\n`)
    }
    process.stdout.write(`negative ${scoped.negativeScope}\n`)
    process.stdout.write(`overall ${scoped.status} (pass ${scoped.counts.pass} / fail ${scoped.counts.fail} / not_run ${scoped.counts.notRun})\n`)
    process.stdout.write(`evidence ${evidencePath}\n`)
    return scoped.exitCode
  } catch (error) {
    report.status = 'FAILED'
    report.error = {
      name: error?.name ?? 'Error',
      code: error?.code ?? null,
      message: redact(error?.message ?? String(error), secrets).slice(0, 4_000)
    }
    report.finishedAt = new Date().toISOString()
    try {
      await writeFile(evidencePath, `${JSON.stringify(assertNoSecrets(report, secrets), null, 2)}\n`, { mode: 0o600 })
    } catch { /* evidence is best-effort on failure; the thrown error still decides the exit */ }
    process.stderr.write(`${SCRIPT_NAME}: ${report.error.code ?? report.error.name}: ${report.error.message}\n`)
    return error instanceof UsageError ? EXIT.REFUSED : EXIT.FAIL
  } finally {
    if (core) await core.stop().catch(() => {})
    await removeEphemeralRuntimeCampFilesRoot(paths.data, { homeDirectory: paths.home }).catch(() => {})
    if (!options.keepFixture) await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

function repoRoot () { return resolve(import.meta.dirname, '..') }

/**
 * The fixture subroots this script may mkdir itself. The Windows formal root is excluded on
 * win32 because only Core may create it, and the data directory is excluded there too.
 */
export function ordinarySubroots (paths, platform = process.platform) {
  const list = [
    paths.home, paths.apdata, paths.localAppData, paths.temp,
    paths.xdgConfig, paths.xdgData, paths.xdgCache, paths.xdgState,
    paths.codexHome, paths.claudeConfig, paths.piAgent,
    paths.dshHome, paths.dshAgentsHome, paths.project, paths.skillSource
  ]
  if (platform !== 'win32') list.push(paths.data)
  return list
}

export function fixturePaths (root) {
  return {
    root,
    home: join(root, 'home'),
    apdata: join(root, 'appdata'),
    localAppData: join(root, 'local-appdata'),
    temp: join(root, 'temp'),
    xdgConfig: join(root, 'xdg', 'config'),
    xdgData: join(root, 'xdg', 'data'),
    xdgCache: join(root, 'xdg', 'cache'),
    xdgState: join(root, 'xdg', 'state'),
    codexHome: join(root, 'codex-home'),
    claudeConfig: join(root, 'claude-config'),
    piAgent: join(root, 'pi-agent'),
    dshHome: join(root, 'dsh-home'),
    dshAgentsHome: join(root, 'dsh-agents-home'),
    // Windows only: the formal native root. Never created by this script on win32.
    formal: join(root, 'formal'),
    data: join(root, 'data'),
    project: join(root, 'project'),
    skillSource: join(root, 'skill-source'),
    mcpCalls: join(root, 'mcp-calls.txt'),
    hookReceipt: join(root, 'hook-receipt.txt')
  }
}

async function waitForAdmittedRun (core, threadId, agentId, payload) {
  // Message admission precedes asynchronous Run creation. Never invent a Run ID
  // or treat an accepted message as completed model execution.
  const messageId = payload?.threadMessageId ?? payload?.messageId ?? null
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    const snapshot = await core.request('camps.snapshot', { threadId }, SETUP_REQUEST_MS)
    const runs = (snapshot?.agentRuns ?? []).filter(run => run.agentId === agentId
      && (messageId === null || run.anchorMessageId === messageId || run.inputMessageIds?.includes(messageId)))
    if (runs.length === 1) return runs[0].id
    if (runs.length > 1) throw new Error('ambiguous Run admission in the new isolated Thread')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('accepted isolated Thread message did not admit a Run')
}

async function readNativeSessionForManifest (dataDir, fixtureRoot, manifest, runId) {
  if (!manifest?.bootstrap || manifest.agentRunId !== runId) return null
  const databasePath = await realpath(join(dataDir, 'rovai.sqlite'))
  if (!bindingPathInsideFixture({ realPath: databasePath, fixtureRoot, isSymbolicLink: false }).ok) {
    throw new Error('isolated native binding database escaped its fixture')
  }
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const row = database.prepare(`SELECT c.native_session_id AS sessionId
      FROM conversation c JOIN agent_run r ON r.conversation_id=c.id
      WHERE r.id=? AND c.id=? AND c.native_binding_id=? AND c.native_binding_generation=?`)
      .get(runId, manifest.bootstrap.conversationId, manifest.bootstrap.nativeBindingId,
        manifest.bootstrap.nativeBindingGeneration)
    return typeof row?.sessionId === 'string' ? row.sessionId : null
  } finally { database.close() }
}

async function waitForRun (core, threadId, runId, budgetMs, observe = async () => {}) {
  const deadline = Date.now() + budgetMs
  let last = null
  while (Date.now() < deadline) {
    const snapshot = await core.request('camps.snapshot', { threadId })
    const run = (snapshot.agentRuns ?? []).find(entry => entry?.id === runId)
    last = run ?? last
    await observe(snapshot, run)
    if ((snapshot.approvals ?? []).some(approval => approval?.status === 'pending')) {
      throw new UsageError('approval_required', 'the Run asked for an interactive approval; this acceptance never grants one')
    }
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      if (run.status !== 'succeeded') {
        throw new UsageError(`run_${run.status}`, `the acceptance Run did not succeed: ${JSON.stringify(run.failure ?? null)}`)
      }
      return snapshot
    }
    await new Promise(done => setTimeout(done, 500))
  }
  throw new UsageError('run_timeout', `the Run did not settle within ${budgetMs}ms (last status ${last?.status ?? 'unknown'})`)
}

/* -------------------------------------------------------------------- entry */

const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main().then(
    code => { process.exitCode = code },
    error => {
      process.exitCode = error instanceof UsageError ? EXIT.REFUSED : EXIT.FAIL
      process.stderr.write(`${SCRIPT_NAME}: ${error?.code ?? 'error'}: ${redact(error?.message ?? String(error))}\n`)
    }
  )
}

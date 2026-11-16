// LOOM V2 P1-B Lane C — per-runtime capability materialization PLAN (dry-run only).
//
// Scope (docs/loom/LOOM-V2-P1B-PI-RUNTIME-INTEGRATION-2026-11-15.md, Lane C):
// turn an already-frozen Core capability snapshot into a per-runtime, per-kind
// materialization PLAN plus a plan-level evidence gate. This module never
// materializes anything: it does not install an MCP server, register a real Hook,
// copy Skill files, read a secret, spawn a process, touch the filesystem or the
// network, or call a model. The only import is node:crypto (for digests).
//
// Contract source of truth is the accepted Rust module
// crates/loom-protocol/src/v2_capability.rs (P1-A Lane C, 12 tests green):
// - four closed kinds, `memory` is NOT a fifth kind: v2_capability.rs:54, :62, :50-52
// - owner/scope compatibility matrix: :121, :137, :146-158 (`scope_allows`)
// - target resolution exact -> any -> unsupported: :222-236 (`support_for`)
// - frozen phases only (prepared/unsupported/failed/revoked): :294, :307
// - phase machine refuses skips and terminal escapes: :340-355
// - snapshot freeze marks unsupported as Unsupported: :445
// - receipt authority gate, incl. unsupported/failed/revoked: :554-584
// - invoke rules: MCP needs toolCallId, Rule forbids it, Hook needs a declared
//   event: :586-640
// - only constructors: LoadReceipt::issue :682, InvokeEvidence::issue :767
// - stable wire reject codes: :854-876
// Wire shapes also mirror docs/loom/loom-v2-runtime-capability-contract.schema.json
// (manifest :141, binding :295, effectiveSnapshot :365, grantRefs :398,
// snapshotDigest :410, entry phase :466, reasonCode :497).
//
// Honesty rules this module enforces:
// - selected != loaded != invoked. A plan row is always `loaded:false` and
//   `invoked:false`; only a receipt/evidence admission can change what a caller
//   may CLAIM, and even then the returned status is `simulated` or `plan`,
//   never "loaded"/"invoked"/"prompt_seen".
// - unsupported / revoked / failed rows are blocked, never planned, and never
//   admit a receipt — no matter how well-formed that receipt looks.
// - target support is never guessed: it is re-derived from the manifest targets
//   for the snapshot runtime+host, and an unknown runtime resolves to
//   `unsupported`. Only an explicit Core-delivered target may be planned.
// - plan-level refusals use a `plan_*` prefix so they can never be confused with
//   the Rust `capability_*` codes; REJECT_CATALOG maps each to its Rust
//   equivalent for diagnosis.

import { createHash } from 'node:crypto'

export const CAPABILITY_PLAN_API_VERSION = 'loom.v2alpha1'

// Exactly four. `memory` is the separate fifth layer and is deliberately absent.
export const CAPABILITY_KINDS = Object.freeze(['skill', 'mcp', 'rule', 'hook'])

// Canonical LOOM hook events (v2_capability.rs:72-90).
export const HOOK_EVENTS = Object.freeze([
  'run.before',
  'model.before',
  'tool.before',
  'tool.after',
  'run.after',
  'approval.requested',
  'run.failed'
])

// `any` is only meaningful inside a manifest target list, never as a host.
export const HOST_PLATFORMS = Object.freeze(['windows', 'linux', 'macos'])
export const TARGET_PLATFORMS = Object.freeze([...HOST_PLATFORMS, 'any'])
export const TARGET_SUPPORT = Object.freeze(['native', 'adapted', 'unsupported'])

// The runtimes LOOM can plan for. An unlisted runtime is not an error — it is
// simply unsupported until Core delivers an explicit target for it.
export const KNOWN_RUNTIMES = Object.freeze(['pi', 'dsh', 'codex', 'claude-code'])

// The only phases a frozen snapshot may carry (v2_capability.rs:307).
export const FROZEN_PHASES = Object.freeze(['prepared', 'unsupported', 'failed', 'revoked'])
export const ALL_PHASES = Object.freeze([
  'discovered', 'inspected', 'selected', 'configured',
  'prepared', 'loaded', 'invoked', 'evidenced',
  'unsupported', 'failed', 'revoked'
])
const STOP_PHASES = Object.freeze(['unsupported', 'failed', 'revoked'])
const STOP_REJECT = Object.freeze({
  unsupported: 'capability_unsupported',
  failed: 'capability_failed',
  revoked: 'capability_revoked'
})

// A plan may only ever report these two evidence statuses. Anything claiming a
// real load, a real invocation or a provider observation is refused.
export const EVIDENCE_STATUSES = Object.freeze(['simulated', 'plan'])
const DISHONEST_STATUSES = Object.freeze(['loaded', 'invoked', 'evidenced', 'prompt_seen', 'activated'])

export const OWNER_KINDS = Object.freeze(['user', 'workspace', 'bot', 'team'])
export const CAPABILITY_SCOPES = Object.freeze(['user', 'workspace', 'project', 'bot', 'team'])

// Mirrors `scope_allows` (v2_capability.rs:146-158).
const SCOPE_ALLOWS = Object.freeze({
  user: Object.freeze(['user']),
  workspace: Object.freeze(['workspace', 'project']),
  bot: Object.freeze(['bot']),
  team: Object.freeze(['team'])
})

// The dry-run action each kind would need, if Core ever authorized it. None of
// these are performed here; `dryRun:true` and the `authority` field say who owns
// the real effect (Core + DevicePort), never this planner.
export const PLAN_ACTIONS = Object.freeze({
  skill: 'skill.copy_files',
  mcp: 'mcp.register_declaration',
  rule: 'rule.inject_text',
  hook: 'hook.register_event'
})

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

const MANIFEST_KEYS = Object.freeze([
  'assetId', 'kind', 'assetVersion', 'contentDigest', 'provider', 'reference',
  'targets', 'requiredGrants', 'hookEvents'
])
const TARGET_KEYS = Object.freeze(['runtimeKind', 'platform', 'support', 'materializerVersion'])
const BINDING_KEYS = Object.freeze([
  'bindingId', 'assetId', 'assetDigest', 'owner', 'scope', 'scopeId', 'enabled', 'revision'
])
const OWNER_KEYS = Object.freeze(['kind', 'id'])
const SNAPSHOT_KEYS = Object.freeze([
  'snapshotId', 'owner', 'workspaceId', 'runtimeKind', 'runtimeVersion',
  'hostPlatform', 'resolverVersion', 'entries', 'grantRefs', 'snapshotDigest', 'createdAt'
])
const ENTRY_KEYS = Object.freeze([
  'assetId', 'assetDigest', 'kind', 'bindingId', 'scope', 'scopeId',
  'support', 'hookEvents', 'phase'
])
const ENTRY_OPTIONAL_KEYS = Object.freeze(['reasonCode'])
const PLAN_INPUT_KEYS = Object.freeze(['snapshot', 'assets'])

const RECEIPT_KEYS = Object.freeze([
  'snapshotId', 'snapshotDigest', 'assetId', 'assetDigest', 'kind', 'owner',
  'scope', 'scopeId', 'runtimeKind', 'eventId', 'proofDigest', 'loadedAt'
])
const RECEIPT_OPTIONAL_KEYS = Object.freeze(['materializerVersion'])
const EVIDENCE_KEYS = Object.freeze([
  'snapshotId', 'snapshotDigest', 'assetId', 'assetDigest', 'kind', 'owner',
  'scope', 'scopeId', 'runtimeKind', 'loadEventId', 'loadProofDigest',
  'eventId', 'proofDigest', 'invokedAt'
])
const EVIDENCE_OPTIONAL_KEYS = Object.freeze(['toolCallId', 'hookEvent'])

// Keys that would imply a real effect or a real secret. Their mere presence in a
// plan input is refused: this planner is dry-run only.
const EFFECTFUL_KEYS = new Set([
  'install', 'uninstall', 'materialize', 'execute', 'exec', 'spawn', 'argv',
  'command', 'cmd', 'env', 'environment', 'secret', 'secrets', 'secretref',
  'credential', 'credentials', 'token', 'apikey', 'password', 'endpoint', 'url'
])

// Every code this module can emit, with its Rust equivalent when one exists.
export const REJECT_CATALOG = Object.freeze({
  // Mirrors of CapabilityReject::code (v2_capability.rs:854-876).
  capability_identity: { family: 'capability', rustEquivalent: 'capability_identity', hint: 'identifier, digest or timestamp has the wrong shape' },
  capability_owner_scope: { family: 'capability', rustEquivalent: 'capability_owner_scope', hint: 'owner kind, scope or scope id disagree' },
  capability_kind: { family: 'capability', rustEquivalent: 'capability_kind', hint: 'kind claim does not fit the object (memory is not a kind)' },
  capability_hook_event: { family: 'capability', rustEquivalent: 'capability_hook_event', hint: 'hook event missing, unknown, duplicated or not declared' },
  capability_asset: { family: 'capability', rustEquivalent: 'capability_asset', hint: 'asset id or digest disagrees, or the asset is absent' },
  capability_disabled: { family: 'capability', rustEquivalent: 'capability_disabled', hint: 'binding is switched off, so nothing was selected' },
  capability_target: { family: 'capability', rustEquivalent: 'capability_target', hint: 'target list malformed or no usable target' },
  capability_duplicate: { family: 'capability', rustEquivalent: 'capability_duplicate', hint: 'duplicate target or duplicate snapshot entry' },
  capability_order: { family: 'capability', rustEquivalent: 'capability_order', hint: 'snapshot entries are not sorted by asset id' },
  capability_snapshot_phase: { family: 'capability', rustEquivalent: 'capability_snapshot_phase', hint: 'a frozen snapshot claimed a phase it may not claim (selected/loaded/invoked)' },
  capability_phase: { family: 'capability', rustEquivalent: 'capability_phase', hint: 'illegal transition: skip, regression or terminal escape' },
  capability_reason: { family: 'capability', rustEquivalent: 'capability_reason', hint: 'a stop phase lacks a reason, or a live phase carries one' },
  capability_unsupported: { family: 'capability', rustEquivalent: 'capability_unsupported', hint: 'no declared target covers this runtime and host' },
  capability_failed: { family: 'capability', rustEquivalent: 'capability_failed', hint: 'the capability failed and never became usable' },
  capability_revoked: { family: 'capability', rustEquivalent: 'capability_revoked', hint: 'the capability was revoked and never became usable' },
  capability_mismatch: { family: 'capability', rustEquivalent: 'capability_mismatch', hint: 'evidence belongs to another snapshot, asset, runtime, owner or receipt' },
  capability_tool_call: { family: 'capability', rustEquivalent: 'capability_tool_call', hint: 'per-kind tool call shape is wrong' },
  // Plan-only refusals. No Rust equivalent: Core has not defined these yet.
  plan_input_invalid: { family: 'plan', rustEquivalent: null, hint: 'input is not an object, has an unknown key, or misses a required key' },
  plan_snapshot_missing: { family: 'plan', rustEquivalent: null, hint: 'no frozen snapshot was supplied, so there is nothing to plan' },
  plan_asset_manifest_missing: { family: 'plan', rustEquivalent: null, hint: 'a snapshot entry names an asset whose manifest was not delivered' },
  plan_support_mismatch: { family: 'plan', rustEquivalent: 'capability_target', hint: 'the snapshot entry support disagrees with the manifest targets' },
  plan_grant_missing: { family: 'plan', rustEquivalent: null, hint: 'requiredGrants are not covered by snapshot.grantRefs; Core must deliver the grant first' },
  plan_dry_run_violation: { family: 'plan', rustEquivalent: null, hint: 'input carries an effectful or secret-bearing key; this planner is dry-run only' },
  plan_evidence_status_claimed: { family: 'plan', rustEquivalent: null, hint: 'a receipt claimed loaded/invoked/observed; only simulated or plan is allowed' }
})

export function describeReject(code) {
  const entry = REJECT_CATALOG[code]
  if (entry) return { code, ...entry }
  return { code, family: 'unknown', rustEquivalent: null, hint: 'unrecognized reject code' }
}

// ---------------------------------------------------------------------------
// small shape helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unknownKeys(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.includes(key))
}

function missingKeys(value, required) {
  return required.filter((key) => value[key] === undefined)
}

function isIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value)
}

function isDigest(value) {
  return typeof value === 'string' && DIGEST.test(value)
}

function isPlainText(value, maximum) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function isTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 && TIMESTAMP.test(value)
}

function sameOwner(left, right) {
  return isPlainObject(left) && isPlainObject(right) &&
    left.kind === right.kind && left.id === right.id
}

function hasEffectfulKeys(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    return value.some((item) => hasEffectfulKeys(item, seen))
  }
  if (!isPlainObject(value)) return false
  if (seen.has(value)) return false
  seen.add(value)
  for (const [key, nested] of Object.entries(value)) {
    if (EFFECTFUL_KEYS.has(key.toLowerCase())) return true
    if (hasEffectfulKeys(nested, seen)) return true
  }
  return false
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function sha256Digest(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

function pushCode(errors, code) {
  if (!errors.includes(code)) errors.push(code)
}

// ---------------------------------------------------------------------------
// manifest / binding validation (mirrors v2_capability.rs validate())
// ---------------------------------------------------------------------------

function collectManifest(manifest, errors) {
  if (!isPlainObject(manifest)) {
    pushCode(errors, 'plan_input_invalid')
    return
  }
  if (unknownKeys(manifest, MANIFEST_KEYS).length > 0) pushCode(errors, 'plan_input_invalid')
  if (missingKeys(manifest, MANIFEST_KEYS).length > 0) pushCode(errors, 'plan_input_invalid')
  if (!CAPABILITY_KINDS.includes(manifest.kind)) pushCode(errors, 'capability_kind')
  if (!isIdentifier(manifest.assetId)) pushCode(errors, 'capability_identity')
  if (!isDigest(manifest.contentDigest)) pushCode(errors, 'capability_identity')
  if (!isPlainText(manifest.assetVersion, 200)) pushCode(errors, 'capability_identity')
  if (!isPlainText(manifest.provider, 200)) pushCode(errors, 'capability_identity')
  if (!isPlainText(manifest.reference, 200)) pushCode(errors, 'capability_identity')

  const grants = manifest.requiredGrants
  if (!Array.isArray(grants)) {
    pushCode(errors, 'capability_identity')
  } else if (grants.some((grant) => !isIdentifier(grant)) ||
    new Set(grants).size !== grants.length) {
    pushCode(errors, 'capability_identity')
  }

  const targets = manifest.targets
  if (!Array.isArray(targets) || targets.length === 0) {
    pushCode(errors, 'capability_target')
  } else {
    const seen = new Set()
    for (const target of targets) {
      if (!isPlainObject(target) || unknownKeys(target, TARGET_KEYS).length > 0) {
        pushCode(errors, 'capability_target')
        continue
      }
      if (!isIdentifier(target.runtimeKind)) pushCode(errors, 'capability_target')
      if (!TARGET_PLATFORMS.includes(target.platform)) pushCode(errors, 'capability_target')
      if (!TARGET_SUPPORT.includes(target.support)) pushCode(errors, 'capability_target')
      if (target.materializerVersion !== undefined &&
        !isPlainText(target.materializerVersion, 200)) {
        pushCode(errors, 'capability_identity')
      }
      const key = `${target.runtimeKind}|${target.platform}`
      if (seen.has(key)) pushCode(errors, 'capability_duplicate')
      seen.add(key)
    }
  }

  const events = manifest.hookEvents
  if (!Array.isArray(events) || events.some((event) => !HOOK_EVENTS.includes(event))) {
    pushCode(errors, 'capability_hook_event')
  } else {
    if (new Set(events).size !== events.length) pushCode(errors, 'capability_hook_event')
    if (manifest.kind === 'hook' && events.length === 0) pushCode(errors, 'capability_hook_event')
    if (manifest.kind !== 'hook' && events.length > 0) pushCode(errors, 'capability_kind')
  }
}

export function validateManifest(manifest) {
  const errors = []
  collectManifest(manifest, errors)
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: manifest }
}

// Core calls this BEFORE freezing a snapshot. The planner itself consumes an
// already-frozen snapshot, so this is the pre-freeze guard, exported here so the
// owner/scope matrix has exactly one JS home.
export function validateBinding(binding) {
  const errors = []
  if (!isPlainObject(binding)) {
    return { ok: false, errors: ['plan_input_invalid'] }
  }
  if (unknownKeys(binding, BINDING_KEYS).length > 0) pushCode(errors, 'plan_input_invalid')
  if (missingKeys(binding, BINDING_KEYS).length > 0) pushCode(errors, 'plan_input_invalid')
  if (!isIdentifier(binding.bindingId)) pushCode(errors, 'capability_identity')
  if (!isIdentifier(binding.assetId)) pushCode(errors, 'capability_identity')
  if (!isIdentifier(binding.scopeId)) pushCode(errors, 'capability_identity')
  if (!isDigest(binding.assetDigest)) pushCode(errors, 'capability_identity')
  if (!Number.isInteger(binding.revision) || binding.revision < 1) {
    pushCode(errors, 'capability_identity')
  }
  const owner = binding.owner
  if (!isPlainObject(owner) || unknownKeys(owner, OWNER_KEYS).length > 0 ||
    missingKeys(owner, OWNER_KEYS).length > 0 ||
    !OWNER_KINDS.includes(owner.kind) || !isIdentifier(owner.id)) {
    pushCode(errors, 'capability_owner_scope')
  } else if (!CAPABILITY_SCOPES.includes(binding.scope) ||
    !SCOPE_ALLOWS[owner.kind].includes(binding.scope)) {
    pushCode(errors, 'capability_owner_scope')
  }
  if (binding.enabled !== true) pushCode(errors, 'capability_disabled')
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: binding }
}

// ---------------------------------------------------------------------------
// target support — never guessed (v2_capability.rs:222-236)
// ---------------------------------------------------------------------------

export function supportFor(manifest, runtimeKind, platform) {
  if (!isPlainObject(manifest) || !Array.isArray(manifest.targets)) return 'unsupported'
  const find = (wanted) => manifest.targets.find(
    (target) => target.runtimeKind === runtimeKind && target.platform === wanted
  )
  const exact = find(platform)
  if (exact) return TARGET_SUPPORT.includes(exact.support) ? exact.support : 'unsupported'
  const fallback = find('any')
  if (fallback) return TARGET_SUPPORT.includes(fallback.support) ? fallback.support : 'unsupported'
  return 'unsupported'
}

// ---------------------------------------------------------------------------
// the plan
// ---------------------------------------------------------------------------

function collectSnapshotIdentity(snapshot, errors) {
  if (unknownKeys(snapshot, SNAPSHOT_KEYS).length > 0) pushCode(errors, 'plan_input_invalid')
  if (missingKeys(snapshot, SNAPSHOT_KEYS).length > 0) pushCode(errors, 'plan_input_invalid')
  if (!isIdentifier(snapshot.snapshotId) || !isIdentifier(snapshot.workspaceId) ||
    !isIdentifier(snapshot.runtimeKind) || !isDigest(snapshot.snapshotDigest)) {
    pushCode(errors, 'capability_identity')
  }
  if (!isPlainText(snapshot.runtimeVersion, 200) || !isPlainText(snapshot.resolverVersion, 200) ||
    !isTimestamp(snapshot.createdAt)) {
    pushCode(errors, 'capability_identity')
  }
  if (!HOST_PLATFORMS.includes(snapshot.hostPlatform)) pushCode(errors, 'capability_identity')
  const owner = snapshot.owner
  if (!isPlainObject(owner) || unknownKeys(owner, OWNER_KEYS).length > 0 ||
    owner.kind !== 'bot' || !isIdentifier(owner.id)) {
    pushCode(errors, 'capability_owner_scope')
  }
  const grants = snapshot.grantRefs
  if (!Array.isArray(grants) || grants.some((grant) => !isIdentifier(grant))) {
    pushCode(errors, 'capability_identity')
  }
}

function collectEntry(entry, errors) {
  if (!isPlainObject(entry)) {
    pushCode(errors, 'plan_input_invalid')
    return
  }
  const allowed = [...ENTRY_KEYS, ...ENTRY_OPTIONAL_KEYS]
  if (unknownKeys(entry, allowed).length > 0) pushCode(errors, 'plan_input_invalid')
  if (missingKeys(entry, ENTRY_KEYS).length > 0) pushCode(errors, 'plan_input_invalid')
  if (!isIdentifier(entry.assetId) || !isIdentifier(entry.bindingId) ||
    !isIdentifier(entry.scopeId) || !isDigest(entry.assetDigest)) {
    pushCode(errors, 'capability_identity')
  }
  if (!CAPABILITY_KINDS.includes(entry.kind)) pushCode(errors, 'capability_kind')
  if (!CAPABILITY_SCOPES.includes(entry.scope)) pushCode(errors, 'capability_owner_scope')
  if (!TARGET_SUPPORT.includes(entry.support)) pushCode(errors, 'capability_target')
  if (!ALL_PHASES.includes(entry.phase)) pushCode(errors, 'capability_snapshot_phase')
  else if (!FROZEN_PHASES.includes(entry.phase)) pushCode(errors, 'capability_snapshot_phase')

  const events = entry.hookEvents
  if (!Array.isArray(events) || events.some((event) => !HOOK_EVENTS.includes(event))) {
    pushCode(errors, 'capability_hook_event')
  } else {
    if (new Set(events).size !== events.length) pushCode(errors, 'capability_hook_event')
    if (entry.kind === 'hook' && events.length === 0) pushCode(errors, 'capability_hook_event')
    if (entry.kind !== 'hook' && events.length > 0) pushCode(errors, 'capability_kind')
  }

  const isStop = STOP_PHASES.includes(entry.phase)
  if (isStop) {
    if (!isPlainText(entry.reasonCode, 200)) pushCode(errors, 'capability_reason')
  } else if (entry.reasonCode !== undefined) {
    pushCode(errors, 'capability_reason')
  }
  // An unsupported resolution may never sit on a live phase.
  if (entry.support === 'unsupported' && !isStop) pushCode(errors, 'capability_snapshot_phase')
}

function buildRow(entry, manifest, snapshot) {
  const blocked = (code) => ({
    assetId: entry.assetId,
    assetDigest: entry.assetDigest,
    kind: entry.kind,
    support: entry.support,
    phase: entry.phase,
    scope: entry.scope,
    scopeId: entry.scopeId,
    hookEvents: [...entry.hookEvents],
    status: 'blocked',
    code,
    reason: entry.reasonCode ?? null,
    action: null,
    loaded: false,
    invoked: false,
    evidenceRequired: ['loadReceipt', 'invokeEvidence'],
    grants: isPlainObject(manifest) && Array.isArray(manifest.requiredGrants)
      ? [...manifest.requiredGrants]
      : []
  })

  if (!isPlainObject(manifest)) return blocked('plan_asset_manifest_missing')
  if (manifest.contentDigest !== entry.assetDigest) return blocked('capability_asset')
  if (manifest.kind !== entry.kind) return blocked('capability_kind')
  const declared = [...manifest.hookEvents].sort()
  const claimed = [...entry.hookEvents].sort()
  if (declared.length !== claimed.length ||
    declared.some((event, index) => event !== claimed[index])) {
    return blocked('capability_hook_event')
  }

  // Only an explicit Core-delivered target may be planned. The recomputed value
  // must agree with the frozen entry; an unknown runtime resolves to unsupported.
  const recomputed = supportFor(manifest, snapshot.runtimeKind, snapshot.hostPlatform)
  if (recomputed !== entry.support) return blocked('plan_support_mismatch')
  if (STOP_PHASES.includes(entry.phase)) return blocked(STOP_REJECT[entry.phase])
  if (recomputed === 'unsupported') return blocked('capability_unsupported')

  const missingGrants = manifest.requiredGrants.filter(
    (grant) => !snapshot.grantRefs.includes(grant)
  )
  if (missingGrants.length > 0) return blocked('plan_grant_missing')

  return {
    assetId: entry.assetId,
    assetDigest: entry.assetDigest,
    kind: entry.kind,
    support: entry.support,
    phase: entry.phase,
    scope: entry.scope,
    scopeId: entry.scopeId,
    hookEvents: [...entry.hookEvents],
    status: 'planned',
    code: null,
    reason: null,
    action: {
      action: PLAN_ACTIONS[entry.kind],
      dryRun: true,
      authority: 'core+deviceport',
      assetId: entry.assetId,
      kind: entry.kind,
      contentDigest: entry.assetDigest,
      reference: manifest.reference,
      provider: manifest.provider,
      materializerVersion: (manifest.targets.find(
        (target) => target.runtimeKind === snapshot.runtimeKind &&
          target.platform === snapshot.hostPlatform
      ) ?? manifest.targets.find(
        (target) => target.runtimeKind === snapshot.runtimeKind && target.platform === 'any'
      ))?.materializerVersion ?? null,
      effects: []
    },
    loaded: false,
    invoked: false,
    evidenceRequired: ['loadReceipt', 'invokeEvidence'],
    grants: [...manifest.requiredGrants]
  }
}

export function materializationPlanDigest(plan) {
  const body = isPlainObject(plan) && isPlainObject(plan.plan) ? plan.plan : plan
  return sha256Digest(canonical({
    apiVersion: body?.apiVersion ?? null,
    dryRun: body?.dryRun ?? null,
    snapshotId: body?.snapshotId ?? null,
    snapshotDigest: body?.snapshotDigest ?? null,
    runtimeKind: body?.runtimeKind ?? null,
    hostPlatform: body?.hostPlatform ?? null,
    rows: body?.rows ?? null,
    rejected: body?.rejected ?? null
  }))
}

export function buildMaterializationPlan(input) {
  const errors = []
  if (!isPlainObject(input)) return { ok: false, errors: ['plan_input_invalid'] }
  if (unknownKeys(input, PLAN_INPUT_KEYS).length > 0) pushCode(errors, 'plan_input_invalid')
  if (hasEffectfulKeys(input)) pushCode(errors, 'plan_dry_run_violation')
  const { snapshot, assets } = input
  if (!isPlainObject(snapshot)) return { ok: false, errors: [...errors, 'plan_snapshot_missing'] }
  if (!Array.isArray(assets)) pushCode(errors, 'plan_input_invalid')

  collectSnapshotIdentity(snapshot, errors)
  if (Array.isArray(assets)) {
    for (const manifest of assets) collectManifest(manifest, errors)
  }

  const entries = Array.isArray(snapshot.entries) ? snapshot.entries : null
  if (entries === null) {
    pushCode(errors, 'plan_input_invalid')
  } else {
    let previous = null
    for (const entry of entries) {
      collectEntry(entry, errors)
      if (!isPlainObject(entry) || typeof entry.assetId !== 'string') continue
      if (previous !== null) {
        if (entry.assetId === previous) pushCode(errors, 'capability_duplicate')
        else if (entry.assetId < previous) pushCode(errors, 'capability_order')
      }
      previous = entry.assetId
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  // Index the delivered manifests. A duplicate asset id is not a silent merge.
  const index = new Map()
  for (const manifest of assets) {
    if (index.has(manifest.assetId)) {
      return { ok: false, errors: ['capability_duplicate'] }
    }
    index.set(manifest.assetId, manifest)
  }

  const rows = entries
    .slice()
    .sort((left, right) => (left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0))
    .map((entry) => buildRow(entry, index.get(entry.assetId), snapshot))

  const actions = rows.filter((row) => row.status === 'planned').map((row) => row.action)
  const rejected = rows
    .filter((row) => row.status === 'blocked')
    .map((row) => ({
      assetId: row.assetId,
      kind: row.kind,
      code: row.code,
      phase: row.phase,
      support: row.support,
      reason: row.reason
    }))

  const plan = {
    kind: 'capability.materializationPlan',
    apiVersion: CAPABILITY_PLAN_API_VERSION,
    dryRun: true,
    snapshotId: snapshot.snapshotId,
    snapshotDigest: snapshot.snapshotDigest,
    owner: { kind: snapshot.owner.kind, id: snapshot.owner.id },
    runtimeKind: snapshot.runtimeKind,
    hostPlatform: snapshot.hostPlatform,
    rows,
    actions,
    rejected,
    planDigest: null,
    notes: Object.freeze([
      'plan_only_no_materialization',
      'selected_is_not_loaded_and_loaded_is_not_invoked',
      'blocked_rows_never_admit_evidence'
    ])
  }
  plan.planDigest = materializationPlanDigest(plan)
  return { ok: true, errors: [], plan }
}

// ---------------------------------------------------------------------------
// evidence gate — the only way a caller may claim anything
// ---------------------------------------------------------------------------

function collectReceipt(receipt, errors) {
  if (unknownKeys(receipt, [...RECEIPT_KEYS, ...RECEIPT_OPTIONAL_KEYS]).length > 0) {
    pushCode(errors, 'plan_input_invalid')
  }
  if (missingKeys(receipt, RECEIPT_KEYS).length > 0) pushCode(errors, 'plan_input_invalid')
  if (!isIdentifier(receipt.snapshotId) || !isIdentifier(receipt.assetId) ||
    !isIdentifier(receipt.scopeId) || !isIdentifier(receipt.eventId) ||
    !isIdentifier(receipt.runtimeKind)) {
    pushCode(errors, 'capability_identity')
  }
  if (!isPlainObject(receipt.owner) || !isIdentifier(receipt.owner?.id)) {
    pushCode(errors, 'capability_owner_scope')
  }
  if (!isDigest(receipt.snapshotDigest) || !isDigest(receipt.assetDigest) ||
    !isDigest(receipt.proofDigest) || !isTimestamp(receipt.loadedAt)) {
    pushCode(errors, 'capability_identity')
  }
  if (!CAPABILITY_KINDS.includes(receipt.kind)) pushCode(errors, 'capability_kind')
  if (!CAPABILITY_SCOPES.includes(receipt.scope)) pushCode(errors, 'capability_owner_scope')
  if (receipt.materializerVersion !== undefined &&
    !isPlainText(receipt.materializerVersion, 200)) {
    pushCode(errors, 'capability_identity')
  }
}

function collectInvokeEvidence(evidence, errors) {
  if (unknownKeys(evidence, [...EVIDENCE_KEYS, ...EVIDENCE_OPTIONAL_KEYS]).length > 0) {
    pushCode(errors, 'plan_input_invalid')
  }
  if (missingKeys(evidence, EVIDENCE_KEYS).length > 0) pushCode(errors, 'plan_input_invalid')
  if (!isIdentifier(evidence.snapshotId) || !isIdentifier(evidence.assetId) ||
    !isIdentifier(evidence.scopeId) || !isIdentifier(evidence.eventId) ||
    !isIdentifier(evidence.loadEventId) || !isIdentifier(evidence.runtimeKind)) {
    pushCode(errors, 'capability_identity')
  }
  if (!isPlainObject(evidence.owner) || !isIdentifier(evidence.owner?.id)) {
    pushCode(errors, 'capability_owner_scope')
  }
  if (!isDigest(evidence.snapshotDigest) || !isDigest(evidence.assetDigest) ||
    !isDigest(evidence.proofDigest) || !isDigest(evidence.loadProofDigest) ||
    !isTimestamp(evidence.invokedAt)) {
    pushCode(errors, 'capability_identity')
  }
  if (!CAPABILITY_KINDS.includes(evidence.kind)) pushCode(errors, 'capability_kind')
  if (evidence.toolCallId !== undefined && !isIdentifier(evidence.toolCallId)) {
    pushCode(errors, 'capability_identity')
  }
  if (evidence.hookEvent !== undefined && !HOOK_EVENTS.includes(evidence.hookEvent)) {
    pushCode(errors, 'capability_hook_event')
  }
}

export function admitPlanEvidence(plan, options = {}) {
  const errors = []
  const body = plan?.ok === true ? plan.plan : plan
  if (!isPlainObject(body) || body.kind !== 'capability.materializationPlan' ||
    body.dryRun !== true || !Array.isArray(body.rows)) {
    return { ok: false, errors: ['plan_input_invalid'] }
  }

  const status = options.status ?? 'simulated'
  if (!EVIDENCE_STATUSES.includes(status) || DISHONEST_STATUSES.includes(status)) {
    pushCode(errors, 'plan_evidence_status_claimed')
  }

  const receipt = options.loadReceipt
  if (!isPlainObject(receipt)) {
    pushCode(errors, 'plan_input_invalid')
    return { ok: false, errors }
  }
  collectReceipt(receipt, errors)

  const row = body.rows.find((candidate) => candidate.assetId === receipt.assetId)
  if (!row) pushCode(errors, 'capability_asset')
  // A blocked row can never be admitted, however well-formed the receipt is.
  if (row && row.status === 'blocked') pushCode(errors, row.code)
  if (errors.length > 0) return { ok: false, errors }

  if (receipt.snapshotId !== body.snapshotId ||
    receipt.snapshotDigest !== body.snapshotDigest ||
    receipt.runtimeKind !== body.runtimeKind ||
    !sameOwner(receipt.owner, body.owner)) {
    pushCode(errors, 'capability_mismatch')
  }
  if (receipt.assetDigest !== row.assetDigest) pushCode(errors, 'capability_asset')
  if (receipt.kind !== row.kind) pushCode(errors, 'capability_kind')
  if (receipt.scope !== row.scope || receipt.scopeId !== row.scopeId) {
    pushCode(errors, 'capability_owner_scope')
  }
  if (errors.length > 0) return { ok: false, errors }

  const evidence = options.invokeEvidence
  let invokeAccepted = false
  if (evidence !== undefined) {
    if (!isPlainObject(evidence)) {
      pushCode(errors, 'plan_input_invalid')
    } else {
      collectInvokeEvidence(evidence, errors)
      if (errors.length > 0) return { ok: false, errors }
      if (evidence.snapshotId !== body.snapshotId ||
        evidence.snapshotDigest !== body.snapshotDigest ||
        evidence.runtimeKind !== body.runtimeKind ||
        !sameOwner(evidence.owner, body.owner)) {
        pushCode(errors, 'capability_mismatch')
      }
      if (evidence.assetId !== receipt.assetId ||
        evidence.assetDigest !== receipt.assetDigest ||
        evidence.kind !== receipt.kind ||
        evidence.scope !== receipt.scope ||
        evidence.scopeId !== receipt.scopeId ||
        evidence.loadEventId !== receipt.eventId ||
        evidence.loadProofDigest !== receipt.proofDigest) {
        pushCode(errors, 'capability_mismatch')
      }
      // Per-kind call shape (v2_capability.rs:600-640).
      if (evidence.kind === 'mcp' && !isIdentifier(evidence.toolCallId)) {
        pushCode(errors, 'capability_tool_call')
      }
      if (evidence.kind === 'rule' && evidence.toolCallId !== undefined) {
        pushCode(errors, 'capability_tool_call')
      }
      if (evidence.kind === 'hook') {
        if (!HOOK_EVENTS.includes(evidence.hookEvent) ||
          !row.hookEvents.includes(evidence.hookEvent)) {
          pushCode(errors, 'capability_hook_event')
        }
      } else if (evidence.hookEvent !== undefined) {
        pushCode(errors, 'capability_hook_event')
      }
      invokeAccepted = errors.length === 0
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    errors: [],
    assetId: row.assetId,
    // Never 'loaded' / 'invoked': this planner observed nothing.
    status,
    evidence: {
      loadAccepted: true,
      invokeAccepted,
      loadObserved: false,
      invokeObserved: false,
      materializationAttempted: false
    }
  }
}

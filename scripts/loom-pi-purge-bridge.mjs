// LOOM V2 Lane D — managed Pi Purge bridge: pure configuration validation,
// activation planning, prompt-composition simulation, and receipt building.
//
// Invariants (per docs/loom/LOOM-V2-P1-FOUR-LANE-SLICE-2026-11-15.md G1 Lane D
// and docs/loom/LOOM-V2-PI-PURGE-EXTENSION-PLAN.md):
// - Pure functions only. No filesystem, network, environment, or process I/O;
//   the only import is node:crypto. Safe to run under `node --test`.
// - Never imports or executes upstream pi-purge code. Behavior mirrored here is
//   transcribed from the read-only reference mirror
//   _artifacts/reference-repos/pi-purge-current/extensions/pi-purge.ts
//   (pinned at d0196ccfd773b0ed342bd2f25372aff65f1a4a53, package 0.3.0).
// - Session semantics: upstream resets `enabled = false` on every session_start
//   (pi-purge.ts:191-193) and PI_PURGE_SOURCE only seeds the persona source —
//   it never enables the extension. A binding therefore never survives into a
//   Pi session by itself; activation must happen after session_start and before
//   the first model request, and chat-typed "/purge" is never a trusted control
//   channel.
// - Evidence honesty: this bridge can only COMPOSE a prompt for a simulated
//   before_agent_start. It can never observe what the provider actually
//   received, so receipt status is restricted to 'prompt_composed' (assembled)
//   or 'simulated'. Statuses claiming real activation or provider observation
//   ('activated', 'prompt_seen', ...) are rejected here.
// - Off is the default posture; Strict is lab-only (scope must be 'lab', per
//   docs/loom/loom-v2-pi-purge-extension.contract.schema.json).
// - This bridge does not modify the Pi Agent Loop, package-embedded-pi.mjs, or
//   any user ~/.pi state. Deleting this file and its test fully reverts it.

import { createHash } from 'node:crypto'

export const PI_PURGE_API_VERSION = 'loom.v2alpha1'

// Pinned upstream reference (P0 Reference Lock). Validation refuses any other
// sourceCommit/packageVersion so a floating upstream can never be accepted.
export const PI_PURGE_REFERENCE = Object.freeze({
  extensionId: 'pi-purge',
  packageVersion: '0.3.0',
  sourceCommit: 'd0196ccfd773b0ed342bd2f25372aff65f1a4a53',
  sourceUrl: 'https://github.com/ZiChuanLan/pi-purge',
  license: 'MIT',
  peerRange: '>=0.80.0 <2'
})

// Five managed modes. 'off' is the LOOM-managed addition representing the
// default disabled posture; the upstream Mode union only has the other four.
export const PI_PURGE_MODES = Object.freeze(['off', 'append', 'replace', 'fallback', 'strict'])

// Scope enum aligned with the contract schema; Strict is only valid with 'lab'.
export const PI_PURGE_SCOPES = Object.freeze(['bot', 'project', 'run', 'lab'])

// The bridge composes prompts only. It must never report that the provider
// actually received ('prompt_seen') or really activated a session.
export const RECEIPT_EVIDENCE_STATUSES = Object.freeze(['prompt_composed', 'simulated'])

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const ISO_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

const BRIDGE_COMPOSE_ONLY_WARNING = 'simulated_before_agent_start_prompt_not_observed_at_provider'

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function sha256Digest(text) {
  return `sha256:${sha256Hex(text)}`
}

const BINDING_REQUIRED_KEYS = Object.freeze([
  'kind', 'apiVersion', 'bindingId', 'botId', 'extensionId', 'runtimeKind',
  'enabled', 'mode', 'sourceCommit', 'packageVersion', 'packageDigest',
  'personaDigest', 'scope', 'revision'
])
const BINDING_OPTIONAL_KEYS = Object.freeze(['personaRef', 'applyOnNextAttempt', 'riskReviewRef'])
const BINDING_KEYS = Object.freeze([...BINDING_REQUIRED_KEYS, ...BINDING_OPTIONAL_KEYS])

// Validate a PiPurgeBinding against the managed contract (schema-aligned:
// docs/loom/loom-v2-pi-purge-extension.contract.schema.json, PiPurgeBinding).
// Additional managed semantics enforced beyond the JSON schema:
// - mode 'strict' requires scope 'lab' (strict-isolated Security Lab only).
// - mode 'off' requires enabled === false (no contradictory bindings).
export function validatePiPurgeBinding(binding) {
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    return { ok: false, errors: ['binding_must_be_object'] }
  }
  const errors = []
  for (const key of Object.keys(binding)) {
    if (!BINDING_KEYS.includes(key)) errors.push(`unknown_key:${key}`)
  }
  for (const key of BINDING_REQUIRED_KEYS) {
    if (binding[key] === undefined) errors.push(`missing_key:${key}`)
  }
  if (errors.length > 0) return { ok: false, errors }

  if (binding.kind !== 'pi-purge.binding') errors.push('kind_must_be_pi-purge.binding')
  if (binding.apiVersion !== PI_PURGE_API_VERSION) errors.push('apiVersion_must_be_loom.v2alpha1')
  if (typeof binding.bindingId !== 'string' || !ID_PATTERN.test(binding.bindingId)) errors.push('bindingId_invalid')
  if (typeof binding.botId !== 'string' || !ID_PATTERN.test(binding.botId)) errors.push('botId_invalid')
  if (binding.extensionId !== PI_PURGE_REFERENCE.extensionId) errors.push('extensionId_must_be_pi-purge')
  if (binding.runtimeKind !== 'pi') errors.push('runtimeKind_must_be_pi')
  if (typeof binding.enabled !== 'boolean') errors.push('enabled_must_be_boolean')
  if (!PI_PURGE_MODES.includes(binding.mode)) errors.push('mode_invalid')
  if (binding.sourceCommit !== PI_PURGE_REFERENCE.sourceCommit) errors.push('sourceCommit_must_match_pinned_reference')
  if (binding.packageVersion !== PI_PURGE_REFERENCE.packageVersion) errors.push('packageVersion_must_match_pinned_reference')
  if (typeof binding.packageDigest !== 'string' || !DIGEST_PATTERN.test(binding.packageDigest)) errors.push('packageDigest_invalid')
  if (typeof binding.personaDigest !== 'string' || !DIGEST_PATTERN.test(binding.personaDigest)) errors.push('personaDigest_invalid')
  if (!PI_PURGE_SCOPES.includes(binding.scope)) errors.push('scope_invalid')
  if (binding.mode === 'strict' && binding.scope !== 'lab') errors.push('strict_requires_scope_lab')
  if (binding.mode === 'off' && binding.enabled !== false) errors.push('off_requires_enabled_false')
  if (!Number.isInteger(binding.revision) || binding.revision < 1) errors.push('revision_must_be_positive_integer')
  if (binding.personaRef !== undefined && (typeof binding.personaRef !== 'string' || !ID_PATTERN.test(binding.personaRef))) {
    errors.push('personaRef_invalid')
  }
  if (binding.applyOnNextAttempt !== undefined && binding.applyOnNextAttempt !== true) {
    errors.push('applyOnNextAttempt_must_be_true_when_present')
  }
  if (binding.riskReviewRef !== undefined && (typeof binding.riskReviewRef !== 'string' || !ID_PATTERN.test(binding.riskReviewRef))) {
    errors.push('riskReviewRef_invalid')
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: binding }
}

// Build the managed activation plan for the next RunAttempt.
//
// The plan encodes the two upstream facts every honest activation must respect:
// (1) the extension disables itself on every session_start, and (2) merely
// bundling the extension or setting an environment variable never enables it.
// Activation therefore means: after session_start, before the first model
// request, driven from the frozen binding — never from chat-typed commands.
export function buildActivationPlan(binding, { nowMs, piVersion } = {}) {
  const checked = validatePiPurgeBinding(binding)
  if (!checked.ok) return checked
  const errors = []
  if (!Number.isFinite(nowMs) || nowMs < 0) errors.push('nowMs_must_be_finite_non_negative_number')
  if (typeof piVersion !== 'string' || piVersion.length === 0) errors.push('piVersion_required_non_empty_string')
  if (errors.length > 0) return { ok: false, errors }

  const apply = binding.enabled && binding.mode !== 'off'
  const plan = {
    kind: 'pi-purge.activationPlan',
    bindingId: binding.bindingId,
    botId: binding.botId,
    mode: binding.mode,
    enabled: binding.enabled,
    scope: binding.scope,
    revision: binding.revision,
    piVersion,
    plannedAtMs: nowMs,
    strategy: apply ? 'managed_bridge_after_session_start_before_first_model_request' : 'none',
    // pi-purge.ts:191-193 — every session_start resets the extension to disabled.
    resetAtSessionStart: true,
    activationWindow: apply ? { after: 'session_start', before: 'first_model_request' } : null,
    requiresPromptReceipt: apply,
    expectNativePromptUnchanged: !apply,
    // Chat text containing "/purge" is user content, never a control channel.
    mustNotUseChatCommand: true,
    strictLabOnly: binding.mode === 'strict',
    evidenceCapability: 'prompt_composed_and_simulated_only'
  }
  return { ok: true, plan }
}

// Mirror of the upstream session_start handler (pi-purge.ts:191-193): the
// extension always re-enters the session disabled; the requested mode value is
// carried over but has no effect until an explicit managed re-activation.
export function applySessionStartReset(state = {}) {
  return {
    enabled: false,
    mode: typeof state?.mode === 'string' ? state.mode : null,
    lastCut: { identity: false, docs: false, at: 0 }
  }
}

// ---------------------------------------------------------------------------
// Pure transcription of the upstream before_agent_start prompt surgery
// (pi-purge.ts:196-224 and its helpers). Read-only reference behavior; this
// code never executes the upstream implementation.
// ---------------------------------------------------------------------------

const HOST_IDENTITY_LINES = Object.freeze([
  'You are a coding assistant running inside pi, a coding agent harness.',
  'You are an expert coding assistant operating inside pi, a coding agent harness.'
])
const HOST_IDENTITY_RE = /^You are an? \S[^\n]{0,160}?coding agent harness\./m
const HOST_DOCS_OPEN = '<docs>'
const HOST_DOCS_CLOSE = '</docs>'
const HOST_DOCS_START = 'Pi documentation (read only when the user asks about '
const HOST_DOCS_ENDS = Object.freeze([
  'following related cross-references.',
  '(e.g., tui.md for TUI API details)'
])

function dropThroughLine(text, startAt, endMarker, from) {
  const endAt = text.indexOf(endMarker, from)
  if (endAt === -1) return null
  let start = startAt
  while (start > 0 && text[start - 1] === '\n') start -= 1
  const lineEnd = text.indexOf('\n', endAt + endMarker.length)
  const end = lineEnd === -1 ? text.length : lineEnd + 1
  return text.slice(0, start) + text.slice(end)
}

function stripIdentityLine(text) {
  let at = -1
  for (const line of HOST_IDENTITY_LINES) {
    at = text.indexOf(line)
    if (at !== -1) break
  }
  if (at === -1) {
    const match = HOST_IDENTITY_RE.exec(text)
    at = match?.index ?? -1
  }
  if (at === -1) return { text, found: false }
  const lineEnd = text.indexOf('\n', at)
  const cutEnd = lineEnd === -1 ? text.length : lineEnd + 1
  return { text: text.slice(0, at) + text.slice(cutEnd), found: true }
}

function stripDocsBlock(text) {
  const tagAt = text.indexOf(HOST_DOCS_OPEN)
  if (tagAt !== -1) {
    const cut = dropThroughLine(text, tagAt, HOST_DOCS_CLOSE, tagAt + HOST_DOCS_OPEN.length)
    if (cut !== null) return { text: cut, found: true }
  }
  const docsAt = text.indexOf(HOST_DOCS_START)
  if (docsAt !== -1) {
    for (const endMarker of HOST_DOCS_ENDS) {
      const cut = dropThroughLine(text, docsAt, endMarker, docsAt + HOST_DOCS_START.length)
      if (cut !== null) return { text: cut, found: true }
    }
  }
  return { text, found: false }
}

function stripHostPersona(text) {
  const identity = stripIdentityLine(text)
  const docs = stripDocsBlock(identity.text)
  return { text: docs.text, identity: identity.found, docs: docs.found }
}

function interpolateCwd(text, cwd) {
  if (!text.includes('{{cwd}}')) return text
  if (!cwd) return text.replace(/[ \t]*\{\{cwd\}\}[ \t]*/g, ' ').replace(/[ \t]+\n/g, '\n')
  return text.split('{{cwd}}').join(cwd)
}

// Simulate the upstream before_agent_start decision for a single turn.
//
// The result is ALWAYS a simulation: `status: 'simulated'` on every path, and
// the caller must not present `systemPrompt` as anything the provider received.
// Anchor-miss honesty: if replace/fallback cannot find the host identity or
// docs anchors, the result reports the miss (modeActual degrades to 'append'
// semantics) instead of claiming a removal that did not happen.
export function simulateBeforeAgentStart({ mode, enabled, personaBody, hostPrompt, cwd = '', sourceIsEmbedded = false } = {}) {
  const errors = []
  if (!PI_PURGE_MODES.includes(mode)) errors.push('mode_invalid')
  if (typeof enabled !== 'boolean') errors.push('enabled_must_be_boolean')
  if (typeof personaBody !== 'string') errors.push('personaBody_must_be_string')
  if (typeof hostPrompt !== 'string') errors.push('hostPrompt_must_be_string')
  if (typeof cwd !== 'string') errors.push('cwd_must_be_string')
  if (typeof sourceIsEmbedded !== 'boolean') errors.push('sourceIsEmbedded_must_be_boolean')
  if (errors.length > 0) return { ok: false, errors }

  const unchanged = (modeActual, warnings) => ({
    ok: true,
    simulation: {
      status: 'simulated',
      modeRequested: mode,
      modeActual,
      applied: false,
      systemPrompt: hostPrompt,
      effectivePromptDigest: sha256Digest(hostPrompt),
      identitySegmentRemoved: false,
      docsSegmentRemoved: false,
      warnings
    }
  })

  if (!enabled || mode === 'off') {
    return unchanged(mode === 'off' ? 'off' : mode, ['purge_not_enabled_host_prompt_unchanged'])
  }
  if (personaBody.trim().length === 0) {
    return unchanged(mode, ['persona_body_empty_host_prompt_unchanged'])
  }
  if (mode === 'fallback' && sourceIsEmbedded) {
    // pi-purge.ts:203 — fallback with the bundled example never touches the host.
    return unchanged('fallback', ['fallback_embedded_source_noop'])
  }

  const warnings = []
  const persona = interpolateCwd(personaBody, cwd)
  let host = hostPrompt
  let modeActual = mode
  let identityRemoved = false
  let docsRemoved = false

  if (mode === 'strict') {
    // pi-purge.ts:207-211 — the whole host prompt is discarded; only the
    // working directory remains beside the persona. Skills/AGENTS.md/other
    // extension guidance is lost in this mode and must be surfaced honestly.
    host = cwd ? `Current working directory: ${cwd}` : ''
    const cut = stripHostPersona(hostPrompt)
    identityRemoved = cut.identity
    docsRemoved = cut.docs
    warnings.push('strict_discards_host_prompt_loses_skills_rules_and_agents_guidance')
    if (!cut.identity) warnings.push('host_identity_anchor_missing')
    if (!cut.docs) warnings.push('host_docs_anchor_missing')
  } else if (mode === 'replace' || mode === 'fallback') {
    const cut = stripHostPersona(host)
    host = cut.text
    identityRemoved = cut.identity
    docsRemoved = cut.docs
    if (!cut.identity && !cut.docs) {
      // pi-purge.ts:213-217 degrade path — no anchor matched, nothing was cut;
      // the effective behavior is append, and that is what gets reported.
      modeActual = 'append'
      warnings.push('host_anchors_missing_degraded_to_append_nothing_removed')
    } else {
      if (!cut.identity) warnings.push('host_identity_anchor_missing')
      if (!cut.docs) warnings.push('host_docs_anchor_missing')
    }
  }

  const systemPrompt = host.length > 0 ? `${persona}\n\n${host}` : persona
  return {
    ok: true,
    simulation: {
      status: 'simulated',
      modeRequested: mode,
      modeActual,
      applied: true,
      systemPrompt,
      effectivePromptDigest: sha256Digest(systemPrompt),
      identitySegmentRemoved: identityRemoved,
      docsSegmentRemoved: docsRemoved,
      warnings
    }
  }
}

const RECEIPT_REQUIRED_FIELDS = Object.freeze([
  'receiptId', 'runAttemptId', 'binding', 'simulation', 'piVersion', 'observedAt'
])

// Build a PiPurgeApplyReceipt from a validated binding and a simulation
// produced by simulateBeforeAgentStart.
//
// Honesty gate: `simulation.status` must be 'simulated' (this bridge has no way
// to observe the provider) and `evidenceStatus` must be 'prompt_composed' or
// 'simulated'. Any attempt to record 'activated', 'prompt_seen', or similar is
// rejected. approvalBypassed is always false and grantRefsUnchanged always
// true: changing the host prompt never widens tool, device, or grant powers.
export function buildPromptReceipt({ receiptId, runAttemptId, binding, simulation, piVersion, observedAt, evidenceStatus = 'simulated', evidenceRefs } = {}) {
  const missing = RECEIPT_REQUIRED_FIELDS.filter((key) => arguments[0]?.[key] === undefined)
  if (missing.length > 0) return { ok: false, errors: missing.map((key) => `missing_field:${key}`) }

  const checked = validatePiPurgeBinding(binding)
  if (!checked.ok) return { ok: false, errors: checked.errors.map((error) => `binding:${error}`) }

  const errors = []
  if (typeof receiptId !== 'string' || !ID_PATTERN.test(receiptId)) errors.push('receiptId_invalid')
  if (typeof runAttemptId !== 'string' || !ID_PATTERN.test(runAttemptId)) errors.push('runAttemptId_invalid')
  if (typeof piVersion !== 'string' || piVersion.length === 0) errors.push('piVersion_required_non_empty_string')
  if (typeof observedAt !== 'string' || !ISO_DATETIME_PATTERN.test(observedAt)) errors.push('observedAt_must_be_iso_datetime')
  if (!RECEIPT_EVIDENCE_STATUSES.includes(evidenceStatus)) {
    errors.push('evidenceStatus_must_be_prompt_composed_or_simulated')
  }
  if (
    simulation === null || typeof simulation !== 'object' ||
    simulation.status !== 'simulated' ||
    typeof simulation.systemPrompt !== 'string' ||
    typeof simulation.effectivePromptDigest !== 'string' ||
    !DIGEST_PATTERN.test(simulation.effectivePromptDigest) ||
    !PI_PURGE_MODES.includes(simulation.modeActual)
  ) {
    errors.push('simulation_must_come_from_simulateBeforeAgentStart_with_status_simulated')
  }
  let refs = ['simulated.before_agent_start']
  if (evidenceRefs !== undefined) {
    if (!Array.isArray(evidenceRefs) || !evidenceRefs.every((ref) => typeof ref === 'string' && ID_PATTERN.test(ref))) {
      errors.push('evidenceRefs_must_be_array_of_id_pattern_strings')
    } else {
      refs = [...refs, ...evidenceRefs]
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  const receipt = {
    kind: 'pi-purge.applyReceipt',
    apiVersion: PI_PURGE_API_VERSION,
    receiptId,
    runAttemptId,
    bindingId: binding.bindingId,
    runtimeKind: 'pi',
    extensionId: PI_PURGE_REFERENCE.extensionId,
    sourceCommit: PI_PURGE_REFERENCE.sourceCommit,
    packageVersion: PI_PURGE_REFERENCE.packageVersion,
    modeRequested: binding.mode,
    modeActual: simulation.modeActual,
    status: evidenceStatus,
    extensionDigest: binding.packageDigest,
    personaDigest: binding.personaDigest,
    // The simulation already carries the schema-shaped `sha256:<hex>` digest;
    // the receipt must not add a second prefix.
    promptDigest: simulation.effectivePromptDigest,
    identitySegmentRemoved: simulation.identitySegmentRemoved === true,
    docsSegmentRemoved: simulation.docsSegmentRemoved === true,
    warnings: [...simulation.warnings, BRIDGE_COMPOSE_ONLY_WARNING],
    observedAt,
    evidenceRefs: refs,
    approvalBypassed: false,
    grantRefsUnchanged: true
  }
  return { ok: true, receipt }
}

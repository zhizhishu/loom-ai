// Tests for scripts/loom-pi-purge-bridge.mjs (LOOM V2 Lane D).
//
// Boundaries: pure in-memory only. No filesystem, network, user ~/.pi, or
// upstream pi-purge / real Pi / provider execution. Run with:
//   node --test scripts/loom-pi-purge-bridge.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PI_PURGE_MODES,
  PI_PURGE_REFERENCE,
  sha256Digest,
  validatePiPurgeBinding,
  buildActivationPlan,
  applySessionStartReset,
  simulateBeforeAgentStart,
  buildPromptReceipt
} from './loom-pi-purge-bridge.mjs'

const PERSONA = '# Persona\n\nYou are the LOOM architect bot. Keep answers precise.'
const HOST_WITH_ANCHORS = [
  'You are a coding assistant running inside pi, a coding agent harness.',
  '',
  'Pi documentation (read only when the user asks about CLI usage and following related cross-references.',
  '',
  'Be careful with tools.'
].join('\n')
const HOST_WITHOUT_ANCHORS = 'Generic harness preamble with neither the identity line nor the docs block.'

const validBinding = (overrides = {}) => ({
  kind: 'pi-purge.binding',
  apiVersion: 'loom.v2alpha1',
  bindingId: 'binding_architect_01',
  botId: 'bot_architect',
  extensionId: 'pi-purge',
  runtimeKind: 'pi',
  enabled: true,
  mode: 'append',
  sourceCommit: PI_PURGE_REFERENCE.sourceCommit,
  packageVersion: '0.3.0',
  packageDigest: `sha256:${'a'.repeat(64)}`,
  personaDigest: sha256Digest(PERSONA),
  scope: 'bot',
  revision: 1,
  ...overrides
})

test('valid binding is accepted with all five modes available', () => {
  const checked = validatePiPurgeBinding(validBinding())
  assert.equal(checked.ok, true)
  assert.deepEqual(Object.keys(checked.value).sort(), Object.keys(validBinding()).sort())
  // Five managed states preserved: Off/Append/Replace/Fallback/Strict.
  assert.deepEqual([...PI_PURGE_MODES], ['off', 'append', 'replace', 'fallback', 'strict'])
})

test('invalid mode and foreign extensionId are rejected', () => {
  const badMode = validatePiPurgeBinding(validBinding({ mode: 'on' }))
  assert.equal(badMode.ok, false)
  assert.ok(badMode.errors.includes('mode_invalid'))

  // Pi Purge belongs to Pi only — never a DSH/Codex/Claude extension.
  const foreign = validatePiPurgeBinding(validBinding({ extensionId: 'pi-purge-dsh' }))
  assert.equal(foreign.ok, false)
  assert.ok(foreign.errors.includes('extensionId_must_be_pi-purge'))
})

test('strict is lab-only: scope production and bot are rejected, lab accepted', () => {
  for (const scope of ['production', 'bot', 'project', 'run']) {
    const rejected = validatePiPurgeBinding(validBinding({ mode: 'strict', scope: scope === 'production' ? 'bot' : scope }))
    assert.equal(rejected.ok, false, `scope ${scope} must be rejected for strict`)
    assert.ok(rejected.errors.includes('strict_requires_scope_lab'))
  }
  const lab = validatePiPurgeBinding(validBinding({ mode: 'strict', scope: 'lab' }))
  assert.equal(lab.ok, true)
})

test('contradictory or malformed bindings are rejected', () => {
  const offEnabled = validatePiPurgeBinding(validBinding({ mode: 'off', enabled: true }))
  assert.equal(offEnabled.ok, false)
  assert.ok(offEnabled.errors.includes('off_requires_enabled_false'))

  const badDigest = validatePiPurgeBinding(validBinding({ personaDigest: 'md5:deadbeef' }))
  assert.equal(badDigest.ok, false)
  assert.ok(badDigest.errors.includes('personaDigest_invalid'))

  const unknownKey = validatePiPurgeBinding(validBinding({ grantOverride: true }))
  assert.equal(unknownKey.ok, false)
  assert.ok(unknownKey.errors.includes('unknown_key:grantOverride'))

  const floatingSource = validatePiPurgeBinding(validBinding({ sourceCommit: 'f'.repeat(40) }))
  assert.equal(floatingSource.ok, false)
  assert.ok(floatingSource.errors.includes('sourceCommit_must_match_pinned_reference'))
})

test('activation plan for enabled append requires after-session_start activation and a receipt', () => {
  const { ok, plan } = buildActivationPlan(validBinding(), { nowMs: 1_000, piVersion: '0.85.1' })
  assert.equal(ok, true)
  assert.equal(plan.strategy, 'managed_bridge_after_session_start_before_first_model_request')
  assert.equal(plan.resetAtSessionStart, true)
  assert.deepEqual(plan.activationWindow, { after: 'session_start', before: 'first_model_request' })
  assert.equal(plan.requiresPromptReceipt, true)
  assert.equal(plan.mustNotUseChatCommand, true)
  // Bundling / env var alone must not count as enabled.
  assert.equal(plan.enabled, true)
  assert.equal(plan.expectNativePromptUnchanged, false)
})

test('activation plan for off is none and expects the native prompt unchanged (T29)', () => {
  const { ok, plan } = buildActivationPlan(validBinding({ mode: 'off', enabled: false }), { nowMs: 1_000, piVersion: '0.85.1' })
  assert.equal(ok, true)
  assert.equal(plan.strategy, 'none')
  assert.equal(plan.activationWindow, null)
  assert.equal(plan.requiresPromptReceipt, false)
  assert.equal(plan.expectNativePromptUnchanged, true)
})

test('activation plan refuses invalid bindings and bad clock inputs', () => {
  const invalid = buildActivationPlan(validBinding({ mode: 'strict', scope: 'bot' }), { nowMs: 0, piVersion: '0.85.1' })
  assert.equal(invalid.ok, false)

  const badClock = buildActivationPlan(validBinding(), { nowMs: Number.NaN, piVersion: '0.85.1' })
  assert.equal(badClock.ok, false)
  assert.ok(badClock.errors.includes('nowMs_must_be_finite_non_negative_number'))
})

test('session_start always resets the extension to disabled (upstream pi-purge.ts:191-193)', () => {
  const reset = applySessionStartReset({ enabled: true, mode: 'append' })
  assert.equal(reset.enabled, false)
  assert.deepEqual(reset.lastCut, { identity: false, docs: false, at: 0 })
  // mode value is carried over but has no effect until managed re-activation.
  assert.equal(reset.mode, 'append')
})

test('append keeps the whole host prompt and prepends the persona', () => {
  const { ok, simulation } = simulateBeforeAgentStart({
    mode: 'append', enabled: true, personaBody: PERSONA, hostPrompt: HOST_WITH_ANCHORS, cwd: 'C:/work/project'
  })
  assert.equal(ok, true)
  assert.equal(simulation.status, 'simulated')
  assert.equal(simulation.applied, true)
  assert.equal(simulation.modeActual, 'append')
  assert.ok(simulation.systemPrompt.startsWith(PERSONA))
  assert.ok(simulation.systemPrompt.includes(HOST_WITH_ANCHORS))
  assert.equal(simulation.effectivePromptDigest, sha256Digest(simulation.systemPrompt))
})

test('replace removes identity and docs segments when anchors match', () => {
  const { ok, simulation } = simulateBeforeAgentStart({
    mode: 'replace', enabled: true, personaBody: PERSONA, hostPrompt: HOST_WITH_ANCHORS, cwd: 'C:/work/project'
  })
  assert.equal(ok, true)
  assert.equal(simulation.applied, true)
  assert.equal(simulation.identitySegmentRemoved, true)
  assert.equal(simulation.docsSegmentRemoved, true)
  assert.ok(!simulation.systemPrompt.includes('coding agent harness'))
  assert.ok(!simulation.systemPrompt.includes('Pi documentation'))
  assert.ok(simulation.systemPrompt.includes('Be careful with tools.'))
})

test('replace degrades honestly to append when no host anchors match', () => {
  const { ok, simulation } = simulateBeforeAgentStart({
    mode: 'replace', enabled: true, personaBody: PERSONA, hostPrompt: HOST_WITHOUT_ANCHORS, cwd: 'C:/work/project'
  })
  assert.equal(ok, true)
  assert.equal(simulation.modeActual, 'append')
  assert.equal(simulation.identitySegmentRemoved, false)
  assert.equal(simulation.docsSegmentRemoved, false)
  assert.ok(simulation.warnings.some((warning) => warning.includes('degraded_to_append_nothing_removed')))
  // Original host text survives verbatim — no false removal claim.
  assert.ok(simulation.systemPrompt.includes(HOST_WITHOUT_ANCHORS))
})

test('fallback with the embedded example is a no-op, never reported as applied', () => {
  const { ok, simulation } = simulateBeforeAgentStart({
    mode: 'fallback', enabled: true, personaBody: PERSONA, hostPrompt: HOST_WITH_ANCHORS, cwd: 'C:/work/project', sourceIsEmbedded: true
  })
  assert.equal(ok, true)
  assert.equal(simulation.applied, false)
  assert.equal(simulation.systemPrompt, HOST_WITH_ANCHORS)
  assert.ok(simulation.warnings.includes('fallback_embedded_source_noop'))
})

test('strict sends only persona plus working directory and warns about lost guidance', () => {
  const { ok, simulation } = simulateBeforeAgentStart({
    mode: 'strict', enabled: true, personaBody: PERSONA, hostPrompt: HOST_WITH_ANCHORS, cwd: 'C:/lab/isolated'
  })
  assert.equal(ok, true)
  assert.equal(simulation.applied, true)
  assert.equal(simulation.systemPrompt, `${PERSONA}\n\nCurrent working directory: C:/lab/isolated`)
  assert.ok(simulation.warnings.includes('strict_discards_host_prompt_loses_skills_rules_and_agents_guidance'))
})

test('disabled or off simulation leaves the host prompt byte-identical', () => {
  const disabled = simulateBeforeAgentStart({
    mode: 'append', enabled: false, personaBody: PERSONA, hostPrompt: HOST_WITH_ANCHORS
  })
  assert.equal(disabled.simulation.applied, false)
  assert.equal(disabled.simulation.systemPrompt, HOST_WITH_ANCHORS)

  const off = simulateBeforeAgentStart({
    mode: 'off', enabled: false, personaBody: PERSONA, hostPrompt: HOST_WITH_ANCHORS
  })
  assert.equal(off.simulation.modeActual, 'off')
  assert.equal(off.simulation.systemPrompt, HOST_WITH_ANCHORS)
})

test('receipt reports simulated composition only, never provider-observed activation', () => {
  const { simulation } = simulateBeforeAgentStart({
    mode: 'append', enabled: true, personaBody: PERSONA, hostPrompt: HOST_WITH_ANCHORS, cwd: 'C:/work/project'
  })
  const { ok, receipt } = buildPromptReceipt({
    receiptId: 'receipt_0001',
    runAttemptId: 'run_attempt_0001',
    binding: validBinding(),
    simulation,
    piVersion: '0.85.1',
    observedAt: '2026-11-15T00:00:00Z'
  })
  assert.equal(ok, true)
  assert.equal(receipt.status, 'simulated')
  assert.equal(receipt.modeRequested, 'append')
  assert.equal(receipt.modeActual, 'append')
  assert.equal(receipt.promptDigest, sha256Digest(simulation.systemPrompt))
  assert.equal(receipt.approvalBypassed, false)
  assert.equal(receipt.grantRefsUnchanged, true)
  assert.ok(receipt.warnings.includes('simulated_before_agent_start_prompt_not_observed_at_provider'))
  const serialized = JSON.stringify(receipt)
  assert.ok(!serialized.includes('activated'))
  assert.ok(!serialized.includes('prompt_seen'))
})

test('receipt refuses provider-observed statuses and non-simulated inputs', () => {
  const { simulation } = simulateBeforeAgentStart({
    mode: 'append', enabled: true, personaBody: PERSONA, hostPrompt: HOST_WITH_ANCHORS
  })
  const fakeStatus = buildPromptReceipt({
    receiptId: 'receipt_0002',
    runAttemptId: 'run_attempt_0001',
    binding: validBinding(),
    simulation,
    piVersion: '0.85.1',
    observedAt: '2026-11-15T00:00:00Z',
    evidenceStatus: 'activated'
  })
  assert.equal(fakeStatus.ok, false)
  assert.ok(fakeStatus.errors.includes('evidenceStatus_must_be_prompt_composed_or_simulated'))

  const fakeObservation = buildPromptReceipt({
    receiptId: 'receipt_0003',
    runAttemptId: 'run_attempt_0001',
    binding: validBinding(),
    simulation: { ...simulation, status: 'prompt_seen' },
    piVersion: '0.85.1',
    observedAt: '2026-11-15T00:00:00Z'
  })
  assert.equal(fakeObservation.ok, false)
  assert.ok(fakeObservation.errors.includes('simulation_must_come_from_simulateBeforeAgentStart_with_status_simulated'))

  const offReceipt = buildPromptReceipt({
    receiptId: 'receipt_0004',
    runAttemptId: 'run_attempt_0001',
    binding: validBinding({ mode: 'off', enabled: false }),
    simulation: simulateBeforeAgentStart({
      mode: 'off', enabled: false, personaBody: PERSONA, hostPrompt: HOST_WITH_ANCHORS
    }).simulation,
    piVersion: '0.85.1',
    observedAt: '2026-11-15T00:00:00Z'
  })
  assert.equal(offReceipt.ok, true)
  // T29: with Off the composed prompt is exactly the native host prompt.
  assert.equal(offReceipt.receipt.promptDigest, sha256Digest(HOST_WITH_ANCHORS))
  assert.equal(offReceipt.receipt.modeActual, 'off')
})

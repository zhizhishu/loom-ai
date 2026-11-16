// LOOM V2 P1-B Lane C — tests for the dry-run capability materialization plan.
//
// Run: node --test scripts/loom-v2-capability-plan.test.mjs
//
// Everything here is pure data. No filesystem, network, process, model or real
// capability is touched: the fixtures are inlined fixed digests (sha256:111..,
// sha256:222..) standing in for assets that are never read. A passing test says
// the PLAN refuses to over-claim, not that anything was materialized.

import test from 'node:test'
import assert from 'node:assert/strict'

import * as mod from './loom-v2-capability-plan.mjs'

const {
  CAPABILITY_KINDS,
  PLAN_ACTIONS,
  FROZEN_PHASES,
  EVIDENCE_STATUSES,
  KNOWN_RUNTIMES,
  REJECT_CATALOG,
  admitPlanEvidence,
  buildMaterializationPlan,
  describeReject,
  materializationPlanDigest,
  supportFor,
  validateBinding,
  validateManifest
} = mod

const D1 = `sha256:${'1'.repeat(64)}`
const D2 = `sha256:${'2'.repeat(64)}`
const D3 = `sha256:${'3'.repeat(64)}`
const AT = '2026-11-15T00:00:00Z'

const FOUR = [
  ['skill', 'asset.review'],
  ['mcp', 'asset.github'],
  ['rule', 'asset.rules'],
  ['hook', 'asset.guard']
]

function manifest(kind, assetId, digest = D1, overrides = {}) {
  return {
    assetId,
    kind,
    assetVersion: '1.0.0',
    contentDigest: digest,
    provider: 'project',
    reference: `assets/${assetId}`,
    targets: [
      { runtimeKind: 'pi', platform: 'windows', support: 'native', materializerVersion: 'mat-1' }
    ],
    requiredGrants: ['grant.file.read'],
    hookEvents: kind === 'hook' ? ['tool.before'] : [],
    ...overrides
  }
}

function entry(kind, assetId, digest = D1, overrides = {}) {
  return {
    assetId,
    assetDigest: digest,
    kind,
    bindingId: `binding.${assetId}`,
    scope: 'bot',
    scopeId: 'bot_1',
    support: 'native',
    hookEvents: kind === 'hook' ? ['tool.before'] : [],
    phase: 'prepared',
    ...overrides
  }
}

function snapshot(entries, overrides = {}) {
  const sorted = entries
    .slice()
    .sort((left, right) => (left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0))
  return {
    snapshotId: 'snapshot_1',
    owner: { kind: 'bot', id: 'bot_1' },
    workspaceId: 'workspace_1',
    runtimeKind: 'pi',
    runtimeVersion: '0.85.1',
    hostPlatform: 'windows',
    resolverVersion: 'resolver-1',
    entries: sorted,
    grantRefs: ['grant.file.read'],
    snapshotDigest: D2,
    createdAt: AT,
    ...overrides
  }
}

function fourKindInput() {
  return {
    snapshot: snapshot(FOUR.map(([kind, assetId]) => entry(kind, assetId))),
    assets: FOUR.map(([kind, assetId]) => manifest(kind, assetId))
  }
}

function singleInput(kind, assetId, entryOverrides = {}, manifestOverrides = {}) {
  return {
    snapshot: snapshot([entry(kind, assetId, D1, entryOverrides)]),
    assets: [manifest(kind, assetId, D1, manifestOverrides)]
  }
}

function rowOf(planBody, assetId) {
  return planBody.rows.find((row) => row.assetId === assetId)
}

function receiptOf(planBody, assetId, overrides = {}) {
  const row = rowOf(planBody, assetId)
  return {
    snapshotId: planBody.snapshotId,
    snapshotDigest: planBody.snapshotDigest,
    assetId: row.assetId,
    assetDigest: row.assetDigest,
    kind: row.kind,
    owner: { ...planBody.owner },
    scope: row.scope,
    scopeId: row.scopeId,
    runtimeKind: planBody.runtimeKind,
    materializerVersion: 'mat-1',
    eventId: 'evt_load_1',
    proofDigest: D3,
    loadedAt: AT,
    ...overrides
  }
}

function evidenceOf(receipt, overrides = {}) {
  return {
    snapshotId: receipt.snapshotId,
    snapshotDigest: receipt.snapshotDigest,
    assetId: receipt.assetId,
    assetDigest: receipt.assetDigest,
    kind: receipt.kind,
    owner: { ...receipt.owner },
    scope: receipt.scope,
    scopeId: receipt.scopeId,
    runtimeKind: receipt.runtimeKind,
    loadEventId: receipt.eventId,
    loadProofDigest: receipt.proofDigest,
    eventId: 'evt_call_1',
    proofDigest: D1,
    invokedAt: AT,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// t01 — the four kinds plan, and a plan is never a materialization
// ---------------------------------------------------------------------------

test('t01 four kinds produce dry-run actions and never claim loaded/invoked', () => {
  const result = buildMaterializationPlan(fourKindInput())
  assert.deepEqual(result.errors, [])
  assert.equal(result.ok, true)
  const plan = result.plan
  assert.equal(plan.kind, 'capability.materializationPlan')
  assert.equal(plan.dryRun, true)
  assert.equal(plan.rows.length, 4)
  assert.equal(plan.rejected.length, 0)
  assert.equal(plan.actions.length, 4)

  for (const [kind, assetId] of FOUR) {
    const row = rowOf(plan, assetId)
    assert.equal(row.kind, kind)
    assert.equal(row.status, 'planned')
    assert.equal(row.code, null)
    // A plan row is never loaded and never invoked.
    assert.equal(row.loaded, false)
    assert.equal(row.invoked, false)
    assert.equal(row.action.dryRun, true)
    assert.equal(row.action.authority, 'core+deviceport')
    assert.equal(row.action.action, PLAN_ACTIONS[kind])
    assert.deepEqual(row.action.effects, [])
  }
  assert.deepEqual(plan.rows.map((row) => row.assetId), [
    'asset.github', 'asset.guard', 'asset.review', 'asset.rules'
  ])
  assert.equal(plan.planDigest, materializationPlanDigest(plan))
  assert.match(plan.planDigest, /^sha256:[0-9a-f]{64}$/)
})

// ---------------------------------------------------------------------------
// t02 — memory is not a fifth kind
// ---------------------------------------------------------------------------

test('t02 memory and other invented kinds are refused', () => {
  assert.deepEqual(CAPABILITY_KINDS, ['skill', 'mcp', 'rule', 'hook'])
  for (const kind of ['memory', 'extension', 'agent', 'Skill']) {
    const bad = manifest(kind, 'asset.review')
    assert.deepEqual(validateManifest(bad).errors, ['capability_kind'], kind)
    const result = buildMaterializationPlan({
      snapshot: snapshot([entry(kind, 'asset.review')]),
      assets: [manifest('skill', 'asset.review')]
    })
    assert.equal(result.ok, false)
    assert.ok(result.errors.includes('capability_kind'), kind)
  }
})

// ---------------------------------------------------------------------------
// t03 — selected is not loaded; a snapshot may not claim a live phase
// ---------------------------------------------------------------------------

test('t03 selected/loaded/invoked phases cannot be planned from a snapshot', () => {
  assert.deepEqual(FROZEN_PHASES, ['prepared', 'unsupported', 'failed', 'revoked'])
  for (const phase of ['discovered', 'inspected', 'selected', 'configured', 'loaded', 'invoked', 'evidenced']) {
    const result = buildMaterializationPlan(
      singleInput('skill', 'asset.review', { phase })
    )
    assert.equal(result.ok, false, phase)
    assert.ok(result.errors.includes('capability_snapshot_phase'), phase)
  }
  // A binding alone (no snapshot) is not a plan.
  assert.deepEqual(buildMaterializationPlan({ assets: [] }).errors, ['plan_snapshot_missing'])
})

// ---------------------------------------------------------------------------
// t04 — unsupported targets are blocked and never admit evidence
// ---------------------------------------------------------------------------

test('t04 unsupported target is blocked and refuses a well-formed receipt', () => {
  const macOnly = { targets: [{ runtimeKind: 'pi', platform: 'macos', support: 'native' }] }
  const input = singleInput(
    'skill',
    'asset.review',
    { support: 'unsupported', phase: 'unsupported', reasonCode: 'capability_unsupported_target' },
    macOnly
  )
  const result = buildMaterializationPlan(input)
  assert.equal(result.ok, true)
  const row = rowOf(result.plan, 'asset.review')
  assert.equal(row.status, 'blocked')
  assert.equal(row.code, 'capability_unsupported')
  assert.equal(row.action, null)
  assert.equal(result.plan.actions.length, 0)
  assert.deepEqual(result.plan.rejected, [{
    assetId: 'asset.review',
    kind: 'skill',
    code: 'capability_unsupported',
    phase: 'unsupported',
    support: 'unsupported',
    reason: 'capability_unsupported_target'
  }])

  // A receipt that is internally perfect still cannot make it usable.
  const receipt = receiptOf(result.plan, 'asset.review', {
    scope: 'bot', scopeId: 'bot_1', assetDigest: D1
  })
  assert.deepEqual(admitPlanEvidence(result, { loadReceipt: receipt }).errors, [
    'capability_unsupported'
  ])

  // Claiming native support for a macOS-only asset is drift, not optimism.
  const lying = buildMaterializationPlan(
    singleInput('skill', 'asset.review', { support: 'native', phase: 'prepared' }, macOnly)
  )
  assert.equal(rowOf(lying.plan, 'asset.review').code, 'plan_support_mismatch')
})

// ---------------------------------------------------------------------------
// t05 — revoked and failed are blocked, and the reason rule holds
// ---------------------------------------------------------------------------

test('t05 revoked and failed capabilities never become plannable', () => {
  const revoked = buildMaterializationPlan(singleInput(
    'skill', 'asset.review', { phase: 'revoked', reasonCode: 'revoked_by_user' }
  ))
  assert.equal(rowOf(revoked.plan, 'asset.review').code, 'capability_revoked')
  assert.deepEqual(
    admitPlanEvidence(revoked, { loadReceipt: receiptOf(revoked.plan, 'asset.review') }).errors,
    ['capability_revoked']
  )

  const failed = buildMaterializationPlan(singleInput(
    'skill', 'asset.review', { phase: 'failed', reasonCode: 'materialize_failed' }
  ))
  assert.equal(rowOf(failed.plan, 'asset.review').code, 'capability_failed')
  assert.deepEqual(
    admitPlanEvidence(failed, { loadReceipt: receiptOf(failed.plan, 'asset.review') }).errors,
    ['capability_failed']
  )

  // A stop without a reason, and a live phase carrying one, are both refused.
  const noReason = buildMaterializationPlan(singleInput('skill', 'asset.review', { phase: 'revoked' }))
  assert.ok(noReason.errors.includes('capability_reason'))
  const liveWithReason = buildMaterializationPlan(singleInput(
    'skill', 'asset.review', { phase: 'prepared', reasonCode: 'stale' }
  ))
  assert.ok(liveWithReason.errors.includes('capability_reason'))
})

// ---------------------------------------------------------------------------
// t06 — missing grant is refused, delivered grant is planned
// ---------------------------------------------------------------------------

test('t06 a required grant that Core did not deliver blocks the plan', () => {
  const needed = { requiredGrants: ['grant.file.read', 'grant.net.post'] }
  const missing = buildMaterializationPlan(
    singleInput('mcp', 'asset.github', {}, needed)
  )
  assert.equal(missing.ok, true)
  const row = rowOf(missing.plan, 'asset.github')
  assert.equal(row.status, 'blocked')
  assert.equal(row.code, 'plan_grant_missing')
  assert.equal(missing.plan.actions.length, 0)
  assert.deepEqual(
    admitPlanEvidence(missing, { loadReceipt: receiptOf(missing.plan, 'asset.github') }).errors,
    ['plan_grant_missing']
  )

  const delivered = {
    snapshot: snapshot([entry('mcp', 'asset.github')], {
      grantRefs: ['grant.file.read', 'grant.net.post']
    }),
    assets: [manifest('mcp', 'asset.github', D1, needed)]
  }
  const planned = buildMaterializationPlan(delivered)
  assert.equal(rowOf(planned.plan, 'asset.github').status, 'planned')
  assert.deepEqual(rowOf(planned.plan, 'asset.github').grants, ['grant.file.read', 'grant.net.post'])
})

// ---------------------------------------------------------------------------
// t07 — owner and scope
// ---------------------------------------------------------------------------

test('t07 owner/scope matrix, team-owned snapshot and cross-bot receipt are refused', () => {
  const binding = (overrides = {}) => ({
    bindingId: 'binding_1',
    assetId: 'asset.review',
    assetDigest: D1,
    owner: { kind: 'bot', id: 'bot_1' },
    scope: 'bot',
    scopeId: 'bot_1',
    enabled: true,
    revision: 1,
    ...overrides
  })
  assert.equal(validateBinding(binding()).ok, true)
  assert.deepEqual(
    validateBinding(binding({ owner: { kind: 'user', id: 'user_1' } })).errors,
    ['capability_owner_scope']
  )
  assert.equal(
    validateBinding(binding({ scope: 'project', owner: { kind: 'workspace', id: 'ws_1' } })).ok,
    true
  )
  assert.deepEqual(
    validateBinding(binding({ scope: 'project', owner: { kind: 'bot', id: 'bot_1' } })).errors,
    ['capability_owner_scope']
  )
  assert.deepEqual(validateBinding(binding({ enabled: false })).errors, ['capability_disabled'])
  assert.deepEqual(validateBinding(binding({ revision: 0 })).errors, ['capability_identity'])

  // A snapshot is owned by a Bot, never by a Team.
  const teamOwned = buildMaterializationPlan({
    snapshot: snapshot([entry('skill', 'asset.review')], { owner: { kind: 'team', id: 'team_1' } }),
    assets: [manifest('skill', 'asset.review')]
  })
  assert.ok(teamOwned.errors.includes('capability_owner_scope'))

  // A receipt issued to another Bot, or for another scope id, is not admitted.
  const plan = buildMaterializationPlan(singleInput('skill', 'asset.review'))
  assert.deepEqual(
    admitPlanEvidence(plan, {
      loadReceipt: receiptOf(plan.plan, 'asset.review', { owner: { kind: 'bot', id: 'bot_2' } })
    }).errors,
    ['capability_mismatch']
  )
  assert.deepEqual(
    admitPlanEvidence(plan, {
      loadReceipt: receiptOf(plan.plan, 'asset.review', { scopeId: 'bot_9' })
    }).errors,
    ['capability_owner_scope']
  )
})

// ---------------------------------------------------------------------------
// t08 — cross-snapshot and cross-runtime evidence
// ---------------------------------------------------------------------------

test('t08 evidence from another snapshot, runtime or load event is refused', () => {
  const plan = buildMaterializationPlan(fourKindInput())
  const receipt = receiptOf(plan.plan, 'asset.review')

  assert.deepEqual(
    admitPlanEvidence(plan, { loadReceipt: { ...receipt, snapshotDigest: D3 } }).errors,
    ['capability_mismatch']
  )
  assert.deepEqual(
    admitPlanEvidence(plan, { loadReceipt: { ...receipt, snapshotId: 'snapshot_2' } }).errors,
    ['capability_mismatch']
  )
  assert.deepEqual(
    admitPlanEvidence(plan, { loadReceipt: { ...receipt, runtimeKind: 'codex' } }).errors,
    ['capability_mismatch']
  )
  // The invoke chain must name the exact load event it belongs to.
  const evidence = evidenceOf(receipt)
  assert.deepEqual(
    admitPlanEvidence(plan, {
      loadReceipt: receipt,
      invokeEvidence: { ...evidence, loadEventId: 'evt_load_9' }
    }).errors,
    ['capability_mismatch']
  )
  assert.deepEqual(
    admitPlanEvidence(plan, {
      loadReceipt: receipt,
      invokeEvidence: { ...evidence, loadProofDigest: D1 }
    }).errors,
    ['capability_mismatch']
  )
  assert.deepEqual(
    admitPlanEvidence(plan, {
      loadReceipt: receipt,
      invokeEvidence: { ...evidence, assetDigest: D3 }
    }).errors,
    ['capability_mismatch']
  )
})

// ---------------------------------------------------------------------------
// t09 — hook events
// ---------------------------------------------------------------------------

test('t09 invalid or undeclared hook events are refused', () => {
  const invented = buildMaterializationPlan(singleInput('hook', 'asset.guard', { hookEvents: ['onSave'] }))
  assert.ok(invented.errors.includes('capability_hook_event'))

  const empty = buildMaterializationPlan(singleInput('hook', 'asset.guard', { hookEvents: [] }))
  assert.ok(empty.errors.includes('capability_hook_event'))

  const duplicated = buildMaterializationPlan(
    singleInput('hook', 'asset.guard', { hookEvents: ['tool.before', 'tool.before'] })
  )
  assert.ok(duplicated.errors.includes('capability_hook_event'))

  // Only a Hook may declare events.
  const skillWithEvents = buildMaterializationPlan(
    singleInput('skill', 'asset.review', { hookEvents: ['tool.before'] })
  )
  assert.ok(skillWithEvents.errors.includes('capability_kind'))

  // Declared tool.before, but evidence claims run.after.
  const plan = buildMaterializationPlan(singleInput('hook', 'asset.guard'))
  const receipt = receiptOf(plan.plan, 'asset.guard')
  assert.deepEqual(
    admitPlanEvidence(plan, {
      loadReceipt: receipt,
      invokeEvidence: evidenceOf(receipt, { hookEvent: 'run.after' })
    }).errors,
    ['capability_hook_event']
  )
  // A Hook invocation without naming its event is not evidence.
  assert.deepEqual(
    admitPlanEvidence(plan, { loadReceipt: receipt, invokeEvidence: evidenceOf(receipt) }).errors,
    ['capability_hook_event']
  )
  assert.equal(
    admitPlanEvidence(plan, {
      loadReceipt: receipt,
      invokeEvidence: evidenceOf(receipt, { hookEvent: 'tool.before' })
    }).ok,
    true
  )
})

// ---------------------------------------------------------------------------
// t10 — per-kind tool call shape
// ---------------------------------------------------------------------------

test('t10 MCP needs a tool call and a Rule must not claim one', () => {
  const plan = buildMaterializationPlan(fourKindInput())

  const mcpReceipt = receiptOf(plan.plan, 'asset.github')
  assert.deepEqual(
    admitPlanEvidence(plan, { loadReceipt: mcpReceipt, invokeEvidence: evidenceOf(mcpReceipt) }).errors,
    ['capability_tool_call']
  )
  const mcpOk = admitPlanEvidence(plan, {
    loadReceipt: mcpReceipt,
    invokeEvidence: evidenceOf(mcpReceipt, { toolCallId: 'tool_call_1' })
  })
  assert.equal(mcpOk.ok, true)
  assert.equal(mcpOk.evidence.invokeAccepted, true)

  const ruleReceipt = receiptOf(plan.plan, 'asset.rules')
  assert.deepEqual(
    admitPlanEvidence(plan, {
      loadReceipt: ruleReceipt,
      invokeEvidence: evidenceOf(ruleReceipt, { toolCallId: 'tool_call_1' })
    }).errors,
    ['capability_tool_call']
  )
  assert.equal(
    admitPlanEvidence(plan, { loadReceipt: ruleReceipt, invokeEvidence: evidenceOf(ruleReceipt) }).ok,
    true
  )
})

// ---------------------------------------------------------------------------
// t11 — determinism, order and duplicates
// ---------------------------------------------------------------------------

test('t11 the plan is deterministic and refuses unsorted or duplicate entries', () => {
  const input = fourKindInput()
  const first = buildMaterializationPlan(input)
  const second = buildMaterializationPlan(fourKindInput())
  assert.equal(first.plan.planDigest, second.plan.planDigest)

  const rows = first.plan.rows.map((row) => row.assetId)
  assert.deepEqual(rows, [...rows].sort())

  // Declared out of order: refused instead of silently sorted by the caller.
  const unsorted = buildMaterializationPlan({
    snapshot: snapshot([entry('skill', 'asset.review'), entry('rule', 'asset.audit')], {
      entries: [entry('skill', 'asset.review'), entry('rule', 'asset.audit')]
    }),
    assets: [manifest('skill', 'asset.review'), manifest('rule', 'asset.audit')]
  })
  assert.ok(unsorted.errors.includes('capability_order'))

  const duplicated = buildMaterializationPlan({
    snapshot: snapshot([entry('skill', 'asset.review'), entry('skill', 'asset.review')], {
      entries: [entry('skill', 'asset.review'), entry('skill', 'asset.review')]
    }),
    assets: [manifest('skill', 'asset.review')]
  })
  assert.ok(duplicated.errors.includes('capability_duplicate'))

  const duplicateAssets = buildMaterializationPlan({
    snapshot: snapshot([entry('skill', 'asset.review')]),
    assets: [manifest('skill', 'asset.review'), manifest('skill', 'asset.review')]
  })
  assert.deepEqual(duplicateAssets.errors, ['capability_duplicate'])
})

// ---------------------------------------------------------------------------
// t12 — dry-run only: no effectful or secret-bearing input
// ---------------------------------------------------------------------------

test('t12 effectful or secret-bearing keys are refused before any plan', () => {
  const base = fourKindInput()

  const withInstall = buildMaterializationPlan({
    ...base,
    snapshot: { ...base.snapshot, install: true }
  })
  assert.ok(withInstall.errors.includes('plan_dry_run_violation'))

  const withSecret = buildMaterializationPlan({
    snapshot: base.snapshot,
    assets: [{ ...base.assets[0], secretRef: 'vault://pi/token' }, ...base.assets.slice(1)]
  })
  assert.ok(withSecret.errors.includes('plan_dry_run_violation'))

  const nestedArgv = buildMaterializationPlan({
    snapshot: base.snapshot,
    assets: [{
      ...base.assets[0],
      targets: [{ runtimeKind: 'pi', platform: 'windows', support: 'native', argv: ['--yes'] }]
    }, ...base.assets.slice(1)]
  })
  assert.ok(nestedArgv.errors.includes('plan_dry_run_violation'))

  // And the refusal is a refusal: no plan body comes back.
  assert.equal(withInstall.ok, false)
  assert.equal(withInstall.plan, undefined)
})

// ---------------------------------------------------------------------------
// t13 — evidence status honesty
// ---------------------------------------------------------------------------

test('t13 a receipt may only report simulated or plan, never a real load', () => {
  const plan = buildMaterializationPlan(singleInput('skill', 'asset.review'))
  const receipt = receiptOf(plan.plan, 'asset.review')

  assert.deepEqual(EVIDENCE_STATUSES, ['simulated', 'plan'])
  for (const status of ['loaded', 'invoked', 'evidenced', 'prompt_seen', 'activated']) {
    const refused = admitPlanEvidence(plan, { loadReceipt: receipt, status })
    assert.deepEqual(refused.errors, ['plan_evidence_status_claimed'], status)
  }

  const admitted = admitPlanEvidence(plan, { loadReceipt: receipt })
  assert.equal(admitted.ok, true)
  assert.equal(admitted.status, 'simulated')
  assert.equal(admitted.evidence.loadObserved, false)
  assert.equal(admitted.evidence.invokeObserved, false)
  assert.equal(admitted.evidence.materializationAttempted, false)
  assert.equal(admitPlanEvidence(plan, { loadReceipt: receipt, status: 'plan' }).status, 'plan')
})

// ---------------------------------------------------------------------------
// t14 — support is never guessed
// ---------------------------------------------------------------------------

test('t14 an unknown runtime resolves to unsupported, never to native', () => {
  assert.deepEqual(KNOWN_RUNTIMES, ['pi', 'dsh', 'codex', 'claude-code'])
  const piOnly = manifest('skill', 'asset.review')
  assert.equal(supportFor(piOnly, 'pi', 'windows'), 'native')
  assert.equal(supportFor(piOnly, 'pi', 'linux'), 'unsupported')
  assert.equal(supportFor(piOnly, 'kimi', 'windows'), 'unsupported')
  assert.equal(supportFor(piOnly, 'dsh', 'windows'), 'unsupported')
  // `any` is honoured but never upgraded to native.
  const anyTarget = manifest('skill', 'asset.review', D1, {
    targets: [{ runtimeKind: 'pi', platform: 'any', support: 'adapted' }]
  })
  assert.equal(supportFor(anyTarget, 'pi', 'windows'), 'adapted')
  assert.equal(supportFor(anyTarget, 'codex', 'windows'), 'unsupported')

  const honest = buildMaterializationPlan({
    snapshot: snapshot([entry('skill', 'asset.review', D1, {
      support: 'unsupported', phase: 'unsupported', reasonCode: 'capability_unsupported_target'
    })], { runtimeKind: 'kimi' }),
    assets: [manifest('skill', 'asset.review')]
  })
  assert.equal(rowOf(honest.plan, 'asset.review').code, 'capability_unsupported')

  const optimistic = buildMaterializationPlan({
    snapshot: snapshot([entry('skill', 'asset.review')], { runtimeKind: 'kimi' }),
    assets: [manifest('skill', 'asset.review')]
  })
  assert.equal(rowOf(optimistic.plan, 'asset.review').code, 'plan_support_mismatch')
})

// ---------------------------------------------------------------------------
// t15 — identity shapes
// ---------------------------------------------------------------------------

test('t15 malformed digests, hosts and timestamps are refused', () => {
  const upper = buildMaterializationPlan({
    snapshot: snapshot([entry('skill', 'asset.review', D1.toUpperCase())]),
    assets: [manifest('skill', 'asset.review', D1.toUpperCase())]
  })
  assert.ok(upper.errors.includes('capability_identity'))

  const short = buildMaterializationPlan({
    snapshot: snapshot([entry('skill', 'asset.review', 'sha256:abc')]),
    assets: [manifest('skill', 'asset.review', 'sha256:abc')]
  })
  assert.ok(short.errors.includes('capability_identity'))

  for (const overrides of [
    { hostPlatform: 'any' },
    { runtimeKind: '' },
    { createdAt: 'yesterday' },
    { snapshotDigest: 'sha256:xyz' }
  ]) {
    const result = buildMaterializationPlan({
      snapshot: snapshot([entry('skill', 'asset.review')], overrides),
      assets: [manifest('skill', 'asset.review')]
    })
    assert.equal(result.ok, false, JSON.stringify(overrides))
    assert.ok(result.errors.includes('capability_identity'), JSON.stringify(overrides))
  }
})

// ---------------------------------------------------------------------------
// t16 — unknown wire fields are refused, not ignored
// ---------------------------------------------------------------------------

test('t16 unknown wire fields are refused at every level', () => {
  const base = fourKindInput()

  const snapshotExtra = buildMaterializationPlan({
    snapshot: { ...base.snapshot, unexpected: 1 },
    assets: base.assets
  })
  assert.ok(snapshotExtra.errors.includes('plan_input_invalid'))

  const entryExtra = buildMaterializationPlan({
    snapshot: snapshot([entry('skill', 'asset.review', D1, { enabled: true })]),
    assets: [manifest('skill', 'asset.review')]
  })
  assert.ok(entryExtra.errors.includes('plan_input_invalid'))

  const manifestExtra = buildMaterializationPlan({
    snapshot: base.snapshot,
    assets: [{ ...base.assets[0], trust: 'trusted' }, ...base.assets.slice(1)]
  })
  assert.ok(manifestExtra.errors.includes('plan_input_invalid'))

  const inputExtra = buildMaterializationPlan({ ...base, dryRun: true })
  assert.ok(inputExtra.errors.includes('plan_input_invalid'))

  const plan = buildMaterializationPlan(base)
  const receipt = receiptOf(plan.plan, 'asset.review')
  assert.deepEqual(
    admitPlanEvidence(plan, { loadReceipt: { ...receipt, extra: 1 } }).errors,
    ['plan_input_invalid']
  )
})

// ---------------------------------------------------------------------------
// t17 — the surface cannot install, execute or read anything
// ---------------------------------------------------------------------------

test('t17 the module exposes no install/execute surface and every action is dry', () => {
  const dangerous = Object.keys(mod).filter((key) =>
    /^(install|uninstall|execute|exec|spawn|write|copy|register|apply|read|fetch)/i.test(key)
  )
  assert.deepEqual(dangerous, [])
  assert.equal(Object.keys(PLAN_ACTIONS).length, 4)
  for (const action of Object.values(PLAN_ACTIONS)) {
    assert.equal(typeof action, 'string')
    assert.match(action, /^(skill|mcp|rule|hook)\./)
  }

  const plan = buildMaterializationPlan(fourKindInput()).plan
  for (const action of plan.actions) {
    assert.equal(action.dryRun, true)
    assert.deepEqual(action.effects, [])
    assert.equal(action.authority, 'core+deviceport')
  }

  // Plan-only codes are diagnosable and never masquerade as Rust codes.
  assert.equal(describeReject('plan_grant_missing').family, 'plan')
  assert.equal(describeReject('plan_grant_missing').rustEquivalent, null)
  assert.equal(describeReject('capability_revoked').rustEquivalent, 'capability_revoked')
  assert.equal(describeReject('nonsense').family, 'unknown')
  assert.ok(Object.keys(REJECT_CATALOG).includes('plan_support_mismatch'))
})

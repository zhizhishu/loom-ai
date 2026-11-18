import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { frozenRuleVerdict, selectedMaterialVerdict, readSelectedMaterial,
  nativeReadVerdict, readNativeSelectedSkill } from './dsh-frozen-evidence.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
function ruleFixture() {
  const bytes = Buffer.from('User-selected instruction: RULE_MARK_visible_only_in_frozen_charter\n')
  const digest = sha(bytes)
  const manifest = { id: 'manifest-a', agentRunId: 'run-a', bootstrap: {
    id: 'bootstrap-a', conversationId: 'thread-a', nativeBindingId: 'binding-a',
    nativeBindingGeneration: 2, sessionCharterDigest: `sha256:${digest}`
  } }
  const row = { manifestId: 'manifest-a', runId: 'run-a', bootstrapId: 'bootstrap-a',
    conversationId: 'thread-a', bindingId: 'binding-a', generation: 2, sessionId: 'session-a',
    state: 'present', deliveryMode: 'managed_system_prompt', sha256: digest,
    charterDigest: `sha256:${digest}`, byteSize: bytes.length }
  return { row, bytes, manifest, runId: 'run-a', sessionId: 'session-a', marker: 'RULE_MARK_visible_only_in_frozen_charter' }
}
function materialFixture() {
  const runId = '12345678-1234-1234-1234-123456789abc'
  const memberId = 'agent-a'
  const bytes = Buffer.from('---\nname: selected-skill\ndescription: A frozen fixture\n---\nSKILL_MARK_private\n')
  const material = { schemaVersion: 1, runId, memberId,
    imports: [{ id: 'skill-a', name: 'selected-skill', description: 'A frozen fixture', revisionId: 'revision-a', contentDigest: 'source-digest-a' }],
    files: [{ path: 'selected-skill/SKILL.md', bytes: bytes.length, sha256: `sha256:${sha(bytes)}` }],
    section: '[ROVAI_ADDITIONAL_SKILLS]\nfixture index\n[/ROVAI_ADDITIONAL_SKILLS]' }
  material.identityDigest = sha(JSON.stringify(canonical({ schemaVersion: material.schemaVersion,
    imports: material.imports, files: material.files, section: material.section })))
  return { material, files: new Map([['selected-skill/SKILL.md', bytes]]), runId, memberId,
    expected: { skillId: 'library:skill-a', revisionId: 'revision-a', contentDigest: 'source-digest-a' } }
}

test('a verified immutable Core charter proves only its exact Run, binding and native Session', () => {
  const result = frozenRuleVerdict(ruleFixture())
  assert.equal(result.status, 'PASS')
  assert.equal(result.source, 'immutable_core_bootstrap')
  assert.ok(result.bootstrapBytes > 0)
  assert.ok(!('bootstrap' in result), 'never return private prompt text')
})

test('Codex native append is explicit and cannot satisfy the DSH managed-prompt expectation', () => {
  const fixture = ruleFixture(); fixture.row.deliveryMode = 'native_append'
  assert.equal(frozenRuleVerdict(fixture).status, 'NOT_RUN')
  assert.equal(frozenRuleVerdict({ ...fixture, expectedDeliveryMode: 'native_append' }).status, 'PASS')
  assert.equal(frozenRuleVerdict({ ...fixture, expectedDeliveryMode: 'first_payload' }).status, 'NOT_RUN')
  fixture.row.sessionId = 'session-other'
  assert.equal(frozenRuleVerdict({ ...fixture, expectedDeliveryMode: 'native_append' }).status, 'NOT_RUN')
})

test('another Run, binding generation or native Session cannot supply Rule evidence', () => {
  for (const [key, value] of [['runId', 'run-b'], ['manifestId', 'manifest-b'], ['bootstrapId', 'bootstrap-b'],
    ['conversationId', 'thread-b'], ['bindingId', 'binding-b'], ['generation', 3], ['sessionId', 'session-b']]) {
    const fixture = ruleFixture(); fixture.row[key] = value
    assert.equal(frozenRuleVerdict(fixture).status, 'NOT_RUN', key)
  }
})

test('missing, corrupt or undelivered charter bytes never count as loading', () => {
  const missing = ruleFixture(); missing.row = null
  assert.equal(frozenRuleVerdict(missing).status, 'NOT_RUN')
  for (const key of ['sha256', 'charterDigest', 'byteSize', 'state', 'deliveryMode']) {
    const fixture = ruleFixture(); fixture.row[key] = key === 'byteSize' ? 1 : 'wrong'
    assert.equal(frozenRuleVerdict(fixture).status, 'NOT_RUN', key)
  }
  const corrupted = ruleFixture(); corrupted.bytes = Buffer.from('different bytes')
  assert.equal(frozenRuleVerdict(corrupted).status, 'NOT_RUN')
  const absent = ruleFixture(); absent.marker = 'RULE_MARK_absent'
  assert.equal(frozenRuleVerdict(absent).status, 'NOT_RUN')
})

test('selected Skill material verifies the imported revision, all file bytes and canonical identity', () => {
  const result = selectedMaterialVerdict(materialFixture())
  assert.equal(result.status, 'PASS')
  assert.equal(result.source, 'core_selected_skill_material')
  assert.ok(result.skillBodySha256)
  assert.ok(!('content' in result))
})

test('another Run/member, missing source and changed revision are refused', () => {
  for (const key of ['runId', 'memberId']) {
    const fixture = materialFixture(); fixture.material[key] += '-other'
    assert.equal(selectedMaterialVerdict(fixture).status, 'NOT_RUN', key)
  }
  const missing = materialFixture(); missing.material.imports = []
  assert.equal(selectedMaterialVerdict(missing).status, 'NOT_RUN')
  const drift = materialFixture(); drift.expected.revisionId = 'newer-unselected-revision'
  assert.equal(selectedMaterialVerdict(drift).status, 'NOT_RUN')
})

test('matching metadata alone cannot conceal missing, altered or shortened Skill bytes', () => {
  const missing = materialFixture(); missing.files.clear()
  assert.equal(selectedMaterialVerdict(missing).status, 'NOT_RUN')
  const corrupt = materialFixture(); corrupt.files.set('selected-skill/SKILL.md', Buffer.from('changed'))
  assert.equal(selectedMaterialVerdict(corrupt).status, 'NOT_RUN')
  const forged = materialFixture(); forged.material.identityDigest = '0'.repeat(64)
  assert.ok(selectedMaterialVerdict(forged).reasons.includes('selected_material_identity_mismatch'))
})

async function diskFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'loom-dsh-evidence-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = materialFixture()
  const dataDir = join(root, 'data')
  const runRoot = join(dataDir, 'runtime', 'skills', fixture.runId)
  await mkdir(join(runRoot, 'skills', 'selected-skill'), { recursive: true })
  await writeFile(join(runRoot, 'manifest.json'), JSON.stringify(fixture.material))
  await writeFile(join(runRoot, 'skills', 'selected-skill', 'SKILL.md'), fixture.files.get('selected-skill/SKILL.md'))
  return { ...fixture, root, dataDir, runRoot, args: { dataDir, fixtureRoot: root,
    runId: fixture.runId, memberId: fixture.memberId, expected: fixture.expected } }
}

test('the active Run reader verifies existing material and does not recreate it after cleanup', async t => {
  const fixture = await diskFixture(t)
  assert.equal((await readSelectedMaterial(fixture.args)).status, 'PASS')
  await rm(fixture.runRoot, { recursive: true })
  assert.deepEqual((await readSelectedMaterial(fixture.args)).reasons, ['selected_material_missing'])
})

test('duplicate manifest paths and path traversal are refused before reading file contents', async t => {
  const fixture = await diskFixture(t)
  fixture.material.files.push({ ...fixture.material.files[0] })
  await writeFile(join(fixture.runRoot, 'manifest.json'), JSON.stringify(fixture.material))
  assert.ok((await readSelectedMaterial(fixture.args)).reasons.includes('selected_material_duplicate_file'))
  fixture.material.files = [{ path: '../../outside', bytes: 1, sha256: '0'.repeat(64) }]
  await writeFile(join(fixture.runRoot, 'manifest.json'), JSON.stringify(fixture.material))
  assert.ok((await readSelectedMaterial(fixture.args)).reasons.includes('selected_material_path_invalid'))
})

test('a linked selected directory cannot supply Skill evidence', async t => {
  const fixture = await diskFixture(t)
  const selected = join(fixture.runRoot, 'skills', 'selected-skill')
  const outside = join(fixture.root, 'other-source')
  await mkdir(outside); await writeFile(join(outside, 'SKILL.md'), fixture.files.get('selected-skill/SKILL.md'))
  await rm(selected, { recursive: true })
  await symlink(outside, selected, process.platform === 'win32' ? 'junction' : 'dir')
  const result = await readSelectedMaterial(fixture.args)
  assert.equal(result.status, 'NOT_RUN')
  assert.ok(result.reasons.includes('selected_material_unreadable_or_unconfined'))
})

const NATIVE_RUN = '22345678-1234-1234-1234-123456789abc'
const NATIVE_OTHER_RUN = '32345678-1234-1234-1234-123456789abc'
const NATIVE_SKILL = 'dsh-accept-1a2b3c4d'
const NATIVE_MARKER = 'NATIVE_READ_marker_9f8e7d6c'
const SKILL_BODY_SHA256 = 'b'.repeat(64)

// Exactly the native DSH read envelope: line-numbered body inside the verbatim
// <path>/<type>/<content> transport wrappers.
function nativeEnvelope(path, marker = NATIVE_MARKER) {
  return `<path>${path}</path>\n<type>file</type>\n<content>\n1: ---\n2: name: selected-skill\n3: ${marker}\n\n(End of file - total 3 lines)\n</content>`
}

function nativeArgs(dataDir) {
  return join(dataDir, 'runtime', 'skills', NATIVE_RUN, 'skills', NATIVE_SKILL, 'SKILL.md')
}

function nativeFixture(overrides = {}) {
  const path = nativeArgs(join('D:', 'loom-data'))
  return {
    rows: [{
      agentRunId: NATIVE_RUN, executionEpoch: 1, kind: 'tool_result', phase: 'completed',
      eventType: 'runtime.action', operationId: 'operation-native-read-1',
      inputPreview: JSON.stringify({ toolCallId: 'tool-call-1', kind: 'read', title: `Read ${path}` }),
      resultPreview: JSON.stringify({ status: 'completed', _rovaiLifecycle: { resultObserved: true },
        output: nativeEnvelope(path) })
    }],
    runId: NATIVE_RUN, expectedPath: path, marker: NATIVE_MARKER,
    selectedMaterial: { status: 'PASS', runId: NATIVE_RUN, skillBodySha256: SKILL_BODY_SHA256 },
    ...overrides
  }
}

// Rewrites the single fixture row: the receipt keeps every other qualifying
// field so each negative isolates exactly one refusal reason.
function mutated(mutate) {
  const fixture = nativeFixture()
  mutate(fixture, fixture.rows[0])
  return fixture
}

test('the exact native read receipt of this Run proves the frozen Skill body was read', () => {
  const result = nativeReadVerdict(nativeFixture())
  assert.equal(result.status, 'PASS')
  assert.equal(result.source, 'dsh_native_read_of_core_frozen_skill')
  assert.equal(result.runId, NATIVE_RUN)
  assert.equal(result.operationId, 'operation-native-read-1')
  assert.equal(result.frozenBodySha256, SKILL_BODY_SHA256)
  assert.match(result.nativeOutputSha256, /^[0-9a-f]{64}$/u)
  assert.equal(result.nativeRegistryVerified, false)
  assert.equal(result.markerObserved, true)
  assert.ok(result.nativeOutputBytes > 0)
  // Read-only evidence: no file body, no marker and no transport text escape it.
  const serialized = JSON.stringify(result)
  assert.ok(!serialized.includes(NATIVE_MARKER))
  assert.ok(!serialized.includes('<content>'))
  assert.ok(!serialized.includes('name: selected-skill'))
  assert.ok(!('output' in result) && !('marker' in result))
})


test('current DSH receipts use the structured read path when the display title is only read', () => {
  const fixture = nativeFixture()
  const row = fixture.rows[0]
  const result = JSON.parse(row.resultPreview)
  const operation = {
    schemaVersion: 2, operationKind: 'read', path: fixture.expectedPath,
    source: 'runtime_reported', status: 'available',
    sourceMetadata: { adapterKind: 'deepseek-harness',
      sourceEventKind: 'session/update.tool_call_update.completed' }
  }
  row.inputPreview = JSON.stringify({ kind: 'read', title: 'read' })
  row.resultPreview = JSON.stringify({ ...result, runtimeFileOperation: operation })
  const passed = nativeReadVerdict(fixture)
  assert.equal(passed.status, 'PASS')
  assert.equal(passed.pathSource, 'runtime_file_operation')
  // A present but wrong structured operation must never fall back to a label.
  row.inputPreview = JSON.stringify({ kind: 'read', title: `Read ${fixture.expectedPath}` })
  for (const wrong of [
    null, {}, { ...operation, schemaVersion: 1 }, { ...operation, operationKind: 'write' },
    { ...operation, path: fixture.expectedPath.replace(NATIVE_RUN, NATIVE_OTHER_RUN) },
    { ...operation, status: 'unavailable' }, { ...operation, source: 'model_reported' },
    { ...operation, sourceMetadata: { ...operation.sourceMetadata, adapterKind: 'pi' } },
    { ...operation, sourceMetadata: { ...operation.sourceMetadata,
      sourceEventKind: 'session/update.tool_call_update.failed' } }
  ]) {
    row.resultPreview = JSON.stringify({ ...result, runtimeFileOperation: wrong })
    assert.deepEqual(nativeReadVerdict(fixture).reasons, ['native_read_evidence_wrong_path'])
  }
  row.resultPreview = JSON.stringify({ ...result, runtimeFileOperation: operation,
    output: nativeEnvelope(fixture.expectedPath.replace(NATIVE_RUN, NATIVE_OTHER_RUN)) })
  assert.deepEqual(nativeReadVerdict(fixture).reasons, ['native_read_evidence_wrong_path'])
})

test('the DOS verbatim prefix and separator form of the same path still match', () => {
  const fixture = nativeFixture()
  const path = fixture.rows[0]
  const verbatim = `\\\\?\\${fixture.expectedPath.replaceAll('/', '\\')}`
  path.inputPreview = JSON.stringify({ kind: 'read', title: `Read ${verbatim} (1 - 3)` })
  path.resultPreview = JSON.stringify({ status: 'completed', _rovaiLifecycle: { resultObserved: true },
    output: nativeEnvelope(verbatim.replace(/^\\\\\?\\/u, '').replaceAll('\\', '/')) })
  assert.equal(nativeReadVerdict(fixture).status, 'PASS')
})

test('another Run, another path, another tool or another marker cannot supply the read', () => {
  const cases = [
    ['agent run', fixture => { fixture.rows[0].agentRunId = NATIVE_OTHER_RUN }, 'native_read_evidence_wrong_run'],
    ['missing run', fixture => { delete fixture.rows[0].agentRunId }, 'native_read_evidence_wrong_run'],
    ['null run', fixture => { fixture.rows[0].agentRunId = null }, 'native_read_evidence_wrong_run'],
    ['sibling skill', (fixture, row) => {
      const other = join('D:', 'loom-data', 'runtime', 'skills', NATIVE_RUN, 'skills', 'dsh-accept-ffffffff', 'SKILL.md')
      row.inputPreview = JSON.stringify({ kind: 'read', title: `Read ${other}` })
      row.resultPreview = JSON.stringify({ status: 'completed', _rovaiLifecycle: { resultObserved: true },
        output: nativeEnvelope(other) })
    }, 'native_read_evidence_wrong_path'],
    ['case-similar skill directory', (fixture, row) => {
      const other = nativeArgs(join('D:', 'loom-data')).replace(NATIVE_SKILL, NATIVE_SKILL.toUpperCase())
      row.inputPreview = JSON.stringify({ kind: 'read', title: `Read ${other}` })
      row.resultPreview = JSON.stringify({ status: 'completed', _rovaiLifecycle: { resultObserved: true },
        output: nativeEnvelope(other) })
    }, 'native_read_evidence_wrong_path'],
    ['traversal path', (fixture, row) => {
      const other = `${join('D:', 'loom-data', 'runtime', 'skills', NATIVE_RUN, 'skills')}/../${NATIVE_SKILL}/SKILL.md`
      row.inputPreview = JSON.stringify({ kind: 'read', title: `Read ${other}` })
      row.resultPreview = JSON.stringify({ status: 'completed', _rovaiLifecycle: { resultObserved: true },
        output: nativeEnvelope(other) })
    }, 'native_read_evidence_wrong_path'],
    ['URI-shaped path', (fixture, row) => {
      const other = `file:///${fixture.expectedPath}`
      row.inputPreview = JSON.stringify({ kind: 'read', title: `Read ${other}` })
      row.resultPreview = JSON.stringify({ status: 'completed', _rovaiLifecycle: { resultObserved: true },
        output: nativeEnvelope(other) })
    }, 'native_read_evidence_wrong_path'],
    ['other tool', (fixture, row) => {
      row.inputPreview = JSON.stringify({ kind: 'shell', title: 'Bash' })
    }, 'native_read_evidence_not_read_tool'],
    ['unobserved result', (fixture, row) => {
      row.resultPreview = JSON.stringify({ status: 'completed', _rovaiLifecycle: { resultObserved: false },
        output: nativeEnvelope(fixture.expectedPath) })
    }, 'native_read_evidence_incomplete'],
    ['in-progress result', (fixture, row) => {
      row.resultPreview = JSON.stringify({ status: 'in_progress', _rovaiLifecycle: { resultObserved: true },
        output: nativeEnvelope(fixture.expectedPath) })
    }, 'native_read_evidence_incomplete'],
    ['truncated output', (fixture, row) => {
      const full = nativeEnvelope(fixture.expectedPath)
      row.resultPreview = JSON.stringify({ status: 'completed', _rovaiLifecycle: { resultObserved: true },
        output: full.slice(0, full.length - 20) })
    }, 'native_read_evidence_incomplete'],
    ['missing output', (fixture, row) => {
      row.resultPreview = JSON.stringify({ status: 'completed', _rovaiLifecycle: { resultObserved: true } })
    }, 'native_read_evidence_incomplete'],
    ['stale marker', (fixture, row) => {
      row.resultPreview = JSON.stringify({ status: 'completed', _rovaiLifecycle: { resultObserved: true },
        output: nativeEnvelope(fixture.expectedPath, 'NATIVE_READ_marker_00000000') })
    }, 'native_read_evidence_marker_missing']
  ]
  for (const [label, mutate, reason] of cases) {
    const result = nativeReadVerdict(mutated(mutate))
    assert.equal(result.status, 'NOT_RUN', label)
    assert.ok(result.reasons.includes(reason), `${label}: ${JSON.stringify(result.reasons)}`)
  }
})

test('two receipts of the same read are ambiguous and never averaged into one answer', () => {
  const fixture = nativeFixture()
  fixture.rows.push({ ...fixture.rows[0], operationId: 'operation-native-read-2' })
  const result = nativeReadVerdict(fixture)
  assert.equal(result.status, 'NOT_RUN')
  assert.deepEqual(result.reasons, ['native_read_evidence_duplicate'])
})

test('verified material metadata without a native read receipt stays NOT_RUN', () => {
  assert.deepEqual(nativeReadVerdict(nativeFixture({ rows: [] })).reasons, ['native_read_evidence_missing'])
  const otherTool = mutated((fixture, row) => {
    row.inputPreview = JSON.stringify({ kind: 'shell', title: 'Bash' })
  })
  assert.ok(nativeReadVerdict(otherTool).reasons.includes('native_read_evidence_not_read_tool'))
  for (const phase of ['started', 'failed']) {
    const stale = mutated((fixture, row) => { row.phase = phase })
    assert.equal(nativeReadVerdict(stale).status, 'NOT_RUN', phase)
  }
  const wrongKind = mutated((fixture, row) => { row.kind = 'tool_call' })
  assert.equal(nativeReadVerdict(wrongKind).status, 'NOT_RUN')
  const wrongEvent = mutated((fixture, row) => { row.eventType = 'agent.text.block' })
  assert.equal(nativeReadVerdict(wrongEvent).status, 'NOT_RUN')
  const noOperation = mutated((fixture, row) => { row.operationId = '' })
  assert.ok(nativeReadVerdict(noOperation).reasons.includes('native_read_evidence_malformed'))
})

test('material that never passed, another Run or a forged body digest cannot gate the read', () => {
  for (const selectedMaterial of [null, { status: 'NOT_RUN', runId: NATIVE_RUN, skillBodySha256: SKILL_BODY_SHA256 },
    { status: 'PASS', runId: NATIVE_OTHER_RUN, skillBodySha256: SKILL_BODY_SHA256 },
    { status: 'PASS', runId: NATIVE_RUN, skillBodySha256: null }]) {
    const result = nativeReadVerdict(nativeFixture({ selectedMaterial }))
    assert.equal(result.status, 'NOT_RUN')
    assert.deepEqual(result.reasons, ['native_read_selected_material_unverified'])
  }
})

test('malformed receipt JSON is refused without throwing through the caller', () => {
  for (const key of ['inputPreview', 'resultPreview']) {
    const fixture = mutated((_fixture, row) => { row[key] = '{"kind":' })
    const result = nativeReadVerdict(fixture)
    assert.equal(result.status, 'NOT_RUN', key)
    assert.ok(result.reasons.includes('native_read_evidence_malformed'), key)
  }
  const nonObject = mutated((_fixture, row) => { row.resultPreview = '[]' })
  assert.equal(nativeReadVerdict(nonObject).status, 'NOT_RUN')
  assert.equal(nativeReadVerdict(mutated((_fixture, row) => { row.resultPreview = null })).status, 'NOT_RUN')
  assert.equal(nativeReadVerdict(nativeFixture({ rows: 'not rows' })).status, 'NOT_RUN')
})

test('an over-budget or unconstrained request is refused instead of sampled', () => {
  const fixture = nativeFixture()
  fixture.rows = Array.from({ length: 257 }, () => ({ ...fixture.rows[0] }))
  assert.deepEqual(nativeReadVerdict(fixture).reasons, ['native_read_evidence_over_budget'])
  const traversalTarget = nativeFixture()
  traversalTarget.expectedPath += '/../../../outside/SKILL.md'
  assert.deepEqual(nativeReadVerdict(traversalTarget).reasons, ['native_read_path_invalid'])
  assert.deepEqual(nativeReadVerdict(nativeFixture({ runId: '../../etc' })).reasons, ['native_read_run_id_invalid'])
  assert.deepEqual(nativeReadVerdict(nativeFixture({ marker: 'short' })).reasons, ['native_read_marker_invalid'])
})

async function nativeDatabaseFixture(t, { epoch = 1, evidenceEpoch = epoch } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'loom-dsh-native-read-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  const expectedPath = nativeArgs(dataDir)
  const database = new DatabaseSync(join(dataDir, 'rovai.sqlite'))
  database.exec(`CREATE TABLE agent_run(id TEXT PRIMARY KEY, execution_epoch INTEGER NOT NULL);
    CREATE TABLE agent_run_execution_evidence(id TEXT PRIMARY KEY, agent_run_id TEXT NOT NULL,
      execution_epoch INTEGER NOT NULL, kind TEXT, phase TEXT, event_type TEXT, operation_id TEXT,
      input_preview_json TEXT, result_preview_json TEXT, result_digest TEXT,
      input_blob_id TEXT, result_blob_id TEXT);`)
  database.prepare('INSERT INTO agent_run VALUES(?,?)').run(NATIVE_RUN, epoch)
  database.prepare('INSERT INTO agent_run VALUES(?,?)').run(NATIVE_OTHER_RUN, 1)
  const insert = database.prepare(`INSERT INTO agent_run_execution_evidence(id, agent_run_id,
    execution_epoch, kind, phase, event_type, operation_id, input_preview_json, result_preview_json,
    result_digest, input_blob_id, result_blob_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
  const receipt = (id, runId, evidenceEpochValue, path) => insert.run(id, runId, evidenceEpochValue,
    'tool_result', 'completed', 'runtime.action', `operation-${id}`,
    JSON.stringify({ kind: 'read', title: 'read' }),
    JSON.stringify({ status: 'completed', _rovaiLifecycle: { resultObserved: true }, output: nativeEnvelope(path),
      runtimeFileOperation: { schemaVersion: 2, operationKind: 'read', path,
        source: 'runtime_reported', status: 'available', sourceMetadata: { adapterKind: 'deepseek-harness',
          sourceEventKind: 'session/update.tool_call_update.completed' } } }),
    null, null, null)
  receipt('evidence-current', NATIVE_RUN, evidenceEpoch, expectedPath)
  receipt('evidence-stale-epoch', NATIVE_RUN, evidenceEpoch + 5, expectedPath)
  receipt('evidence-other-run', NATIVE_OTHER_RUN, 1, expectedPath)
  database.close()
  return { root, dataDir, expectedPath, args: { dataDir, fixtureRoot: root, runId: NATIVE_RUN,
    skillName: NATIVE_SKILL, marker: NATIVE_MARKER,
    selectedMaterial: { status: 'PASS', runId: NATIVE_RUN, skillBodySha256: SKILL_BODY_SHA256 } } }
}

test('the native reader selects only this Run current-epoch receipts from the existing database', async t => {
  const fixture = await nativeDatabaseFixture(t)
  const result = await readNativeSelectedSkill(fixture.args)
  assert.equal(result.status, 'PASS')
  assert.equal(result.operationId, 'operation-evidence-current')
  assert.equal(result.nativeRegistryVerified, false)
  assert.ok(!JSON.stringify(result).includes(NATIVE_MARKER))
})

test('a receipt whose execution epoch is no longer the Run epoch is not read', async t => {
  const fixture = await nativeDatabaseFixture(t, { epoch: 2, evidenceEpoch: 1 })
  const result = await readNativeSelectedSkill(fixture.args)
  assert.equal(result.status, 'NOT_RUN')
  assert.deepEqual(result.reasons, ['native_read_evidence_missing'])
})

test('the reader refuses unsafe Skill names and never leaves its confined fixture', async t => {
  const fixture = await nativeDatabaseFixture(t)
  for (const skillName of ['../selected-skill', 'selected skill', '', '.hidden', 'a'.repeat(200),
    'selected-skill/../../x']) {
    const result = await readNativeSelectedSkill({ ...fixture.args, skillName })
    assert.deepEqual(result.reasons, ['native_read_skill_name_invalid'], skillName)
  }
  const outsideRoot = join(fixture.root, 'other-root')
  await mkdir(outsideRoot)
  const unconfined = await readNativeSelectedSkill({ ...fixture.args, fixtureRoot: outsideRoot })
  assert.deepEqual(unconfined.reasons, ['native_read_evidence_unreadable_or_unconfined'])
  const missing = await readNativeSelectedSkill({ ...fixture.args, dataDir: join(fixture.root, 'absent') })
  assert.deepEqual(missing.reasons, ['native_read_evidence_missing'])
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { frozenRuleVerdict, selectedMaterialVerdict, readSelectedMaterial } from './dsh-frozen-evidence.mjs'

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

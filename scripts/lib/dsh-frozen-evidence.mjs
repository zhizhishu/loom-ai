// Acceptance-only readers for the Core's existing immutable evidence. No model,
// credential, product write, or replacement business store is introduced here.
import { createHash } from 'node:crypto'
import { lstat, realpath, readFile } from 'node:fs/promises'
import { join, relative, isAbsolute, resolve, sep } from 'node:path'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const bareDigest = value => String(value ?? '').replace(/^sha256:/u, '')
const unavailable = reason => ({ status: 'NOT_RUN', reasons: [reason] })

async function confinedPath(root, path, limit) {
  const base = await realpath(root)
  const requested = resolve(path)
  const offset = relative(base, requested)
  if (!offset || offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new Error('evidence_path_outside_fixture')
  let cursor = base
  for (const part of offset.split(sep)) {
    cursor = join(cursor, part)
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('evidence_path_is_symlink')
  }
  const metadata = await lstat(requested)
  if (!metadata.isFile() || metadata.size > limit) throw new Error('evidence_file_invalid')
  const before = await realpath(requested)
  if (relative(base, before).startsWith('..')) throw new Error('evidence_path_outside_fixture')
  return before
}

async function confinedFile(root, path, limit) {
  const before = await confinedPath(root, path, limit)
  const bytes = await readFile(before)
  if (bytes.length > limit || before !== await realpath(path)) throw new Error('evidence_changed_while_reading')
  return bytes
}

export function frozenRuleVerdict({ row, bytes, manifest, runId, sessionId, marker }) {
  if (!row || !Buffer.isBuffer(bytes)) return unavailable('frozen_bootstrap_missing')
  const reasons = []
  const expected = manifest?.bootstrap
  if (!expected || manifest.agentRunId !== runId || row.runId !== runId || row.manifestId !== manifest.id) reasons.push('frozen_bootstrap_wrong_run')
  if (!expected || row.bootstrapId !== expected.id || row.conversationId !== expected.conversationId
      || row.bindingId !== expected.nativeBindingId || row.generation !== expected.nativeBindingGeneration) reasons.push('frozen_bootstrap_wrong_binding')
  if (!sessionId || row.sessionId !== sessionId) reasons.push('frozen_bootstrap_wrong_session')
  if (row.state !== 'present' || row.deliveryMode !== 'managed_system_prompt') reasons.push('frozen_bootstrap_not_delivered')
  const sha256 = digest(bytes)
  if (row.sha256 !== sha256 || bareDigest(row.charterDigest) !== sha256
      || bareDigest(expected?.sessionCharterDigest) !== sha256 || row.byteSize !== bytes.length) reasons.push('frozen_bootstrap_digest_mismatch')
  if (typeof marker !== 'string' || marker.length < 8 || !bytes.toString('utf8').includes(marker)) reasons.push('rule_marker_not_in_frozen_bootstrap')
  return { status: reasons.length ? 'NOT_RUN' : 'PASS', reasons, source: 'immutable_core_bootstrap', bootstrapSha256: sha256, bootstrapBytes: bytes.length }
}

export async function readFrozenRule({ dataDir, fixtureRoot, manifest, runId, sessionId, marker }) {
  if (!manifest?.bootstrap || manifest.agentRunId !== runId) return unavailable('frozen_bootstrap_wrong_run')
  const databasePath = join(dataDir, 'rovai.sqlite')
  await confinedPath(fixtureRoot, databasePath, 512 * 1024 * 1024)
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const row = database.prepare(`SELECT cm.id AS manifestId, cm.agent_run_id AS runId,
      b.id AS bootstrapId, b.conversation_id AS conversationId, b.native_binding_id AS bindingId,
      b.native_binding_generation AS generation, c.native_session_id AS sessionId,
      b.session_charter_digest AS charterDigest, b.delivery_mode AS deliveryMode,
      blob.sha256 AS sha256, blob.byte_size AS byteSize, blob.state AS state,
      blob.storage_relative_path AS relativePath
      FROM context_manifest cm JOIN native_session_bootstrap_evidence b ON b.id=cm.bootstrap_evidence_id
      JOIN agent_run r ON r.id=cm.agent_run_id
      JOIN conversation c ON c.id=r.conversation_id AND c.id=b.conversation_id
        AND c.native_binding_id=b.native_binding_id AND c.native_binding_generation=b.native_binding_generation
      JOIN managed_blob blob ON blob.id=b.session_charter_blob_id
      WHERE cm.id=? AND cm.agent_run_id=? AND b.id=?`)
      .get(manifest.id, runId, manifest.bootstrap.id)
    if (!row) return unavailable('frozen_bootstrap_missing')
    if (!/^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/u.test(row.relativePath)) return unavailable('frozen_bootstrap_path_invalid')
    const bytes = await confinedFile(fixtureRoot, join(dataDir, 'managed-blobs', row.relativePath), 2 * 1024 * 1024)
    return frozenRuleVerdict({ row, bytes, manifest, runId, sessionId, marker })
  } finally { database.close() }
}

export function selectedMaterialVerdict({ material, files, runId, memberId, expected }) {
  if (!material) return unavailable('selected_material_missing')
  const reasons = []
  if (material.schemaVersion !== 1 || material.runId !== runId || material.memberId !== memberId) reasons.push('selected_material_wrong_run')
  const id = String(expected.skillId).replace(/^library:/u, '')
  const imported = (material.imports ?? []).filter(item => String(item.id).replace(/^library:/u, '') === id)
  if (imported.length !== 1) reasons.push('selected_material_import_missing_or_ambiguous')
  const source = imported[0]
  if (source && (source.revisionId !== expected.revisionId || source.contentDigest !== expected.contentDigest)) reasons.push('selected_material_revision_drift')
  const records = material.files ?? []
  const skillPath = source ? `${source.name}/SKILL.md` : null
  if (!skillPath || !records.some(item => item.path === skillPath)) reasons.push('selected_material_skill_body_missing')
  for (const record of records) {
    const bytes = files?.get(record.path)
    if (!Buffer.isBuffer(bytes) || record.bytes !== bytes.length || bareDigest(record.sha256) !== digest(bytes)) reasons.push('selected_material_file_digest_mismatch')
  }
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  const identity = digest(JSON.stringify(canonical({ schemaVersion: material.schemaVersion,
    imports: material.imports, files: material.files, section: material.section })))
  if (bareDigest(material.identityDigest) !== identity) reasons.push('selected_material_identity_mismatch')
  if (!Array.isArray(material.files) || material.files.length === 0) reasons.push('selected_material_no_files')
  return { status: reasons.length ? 'NOT_RUN' : 'PASS', reasons: [...new Set(reasons)], source: 'core_selected_skill_material',
    runId, memberId, identityDigest: material.identityDigest ?? null, revisionId: source?.revisionId ?? null,
    contentDigest: source?.contentDigest ?? null, fileCount: records.length, skillBodySha256: skillPath && files?.has(skillPath) ? digest(files.get(skillPath)) : null }
}

// Called while a real Run is active. Finalization is allowed to remove its
// ephemeral material, so evidence is captured before cleanup, never rebuilt.
export async function readSelectedMaterial({ dataDir, fixtureRoot, runId, memberId, expected }) {
  if (!/^[0-9a-f-]{36}$/iu.test(runId)) return unavailable('selected_material_run_id_invalid')
  const root = join(dataDir, 'runtime', 'skills', runId)
  try {
    const raw = await confinedFile(fixtureRoot, join(root, 'manifest.json'), 8 * 1024 * 1024)
    const material = JSON.parse(raw.toString('utf8'))
    if (!Array.isArray(material.files) || material.files.length > 2048) return unavailable('selected_material_file_list_invalid')
    const files = new Map()
    let total = 0
    for (const record of material.files) {
      if (typeof record.path !== 'string' || record.path.includes('\\') || record.path.includes(':')
          || record.path.split('/').some(part => !part || part === '.' || part === '..')) return unavailable('selected_material_path_invalid')
      if (files.has(record.path)) return unavailable('selected_material_duplicate_file')
      const bytes = await confinedFile(fixtureRoot, join(root, 'skills', record.path), 8 * 1024 * 1024)
      total += bytes.length
      if (total > 32 * 1024 * 1024) return unavailable('selected_material_over_budget')
      files.set(record.path, bytes)
    }
    const readback = await confinedFile(fixtureRoot, join(root, 'manifest.json'), 8 * 1024 * 1024)
    if (!raw.equals(readback)) return unavailable('selected_material_changed_during_read')
    return { ...selectedMaterialVerdict({ material, files, runId, memberId, expected }), manifestSha256: digest(raw) }
  } catch (error) {
    return unavailable(error?.code === 'ENOENT' ? 'selected_material_missing' : 'selected_material_unreadable_or_unconfined')
  }
}

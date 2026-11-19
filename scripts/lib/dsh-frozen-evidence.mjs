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

export function frozenRuleVerdict({ row, bytes, manifest, runId, sessionId, marker, expectedDeliveryMode = 'managed_system_prompt' }) {
  if (!row || !Buffer.isBuffer(bytes)) return unavailable('frozen_bootstrap_missing')
  const reasons = []
  const expected = manifest?.bootstrap
  if (!expected || manifest.agentRunId !== runId || row.runId !== runId || row.manifestId !== manifest.id) reasons.push('frozen_bootstrap_wrong_run')
  if (!expected || row.bootstrapId !== expected.id || row.conversationId !== expected.conversationId
      || row.bindingId !== expected.nativeBindingId || row.generation !== expected.nativeBindingGeneration) reasons.push('frozen_bootstrap_wrong_binding')
  if (!sessionId || row.sessionId !== sessionId) reasons.push('frozen_bootstrap_wrong_session')
  if (!['managed_system_prompt', 'native_append'].includes(expectedDeliveryMode)
      || row.state !== 'present' || row.deliveryMode !== expectedDeliveryMode) reasons.push('frozen_bootstrap_not_delivered')
  const sha256 = digest(bytes)
  if (row.sha256 !== sha256 || bareDigest(row.charterDigest) !== sha256
      || bareDigest(expected?.sessionCharterDigest) !== sha256 || row.byteSize !== bytes.length) reasons.push('frozen_bootstrap_digest_mismatch')
  if (typeof marker !== 'string' || marker.length < 8 || !bytes.toString('utf8').includes(marker)) reasons.push('rule_marker_not_in_frozen_bootstrap')
  return { status: reasons.length ? 'NOT_RUN' : 'PASS', reasons, source: 'immutable_core_bootstrap', bootstrapSha256: sha256, bootstrapBytes: bytes.length }
}

export async function readFrozenRule({ dataDir, fixtureRoot, manifest, runId, sessionId, marker, expectedDeliveryMode = 'managed_system_prompt' }) {
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
    return frozenRuleVerdict({ row, bytes, manifest, runId, sessionId, marker, expectedDeliveryMode })
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

// Acceptance-only proof that the native DSH `read` tool itself observed the
// Core's frozen SKILL.md. Only the existing Core evidence is re-read: the Run's
// current-epoch `tool_result` receipts, joined to the frozen material digest. The
// line-numbered native envelope is hashed as the native transport output and is
// never un-numbered into a claimed whole-file hash.
const NATIVE_READ_SOURCE = 'dsh_native_read_of_core_frozen_skill'
const NATIVE_READ_LIMIT = 256
// Verbatim envelope of the native read renderer (packages/fs/tool-fs read.ts).
const NATIVE_READ_ENVELOPE = /^<path>([^\n]*)<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u
const NATIVE_READ_QUERY = `SELECT e.agent_run_id AS agentRunId, e.execution_epoch AS executionEpoch,
  e.kind AS kind, e.phase AS phase, e.event_type AS eventType, e.operation_id AS operationId,
  e.input_preview_json AS inputPreview, e.result_preview_json AS resultPreview
  FROM agent_run_execution_evidence e
  JOIN agent_run r ON r.id=e.agent_run_id AND r.execution_epoch=e.execution_epoch
  WHERE e.agent_run_id=?
  LIMIT 257`

const nativeUnavailable = reason => ({ status: 'NOT_RUN', reasons: [reason],
  source: NATIVE_READ_SOURCE, nativeRegistryVerified: false })

// Strips only the DOS verbatim prefix and separator differences. Traversal
// segments, URI forms and every other alias stay unmatched on purpose.
function normalizeNativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) return null
  const text = value.replace(/^\\\\\?\\/u, '')
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) return null
  const segments = text.replaceAll('\\', '/').split('/')
  if (segments.some(part => part === '..' || part === '.')) return null
  return segments.some(part => part !== '') ? segments.join('/') : null
}

function parseEvidenceObject(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || value.length === 0 || value.length > 4 * 1024 * 1024) return null
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

// Older native receipts used `Read <path>` with a display window. Current
// DSH receipts can keep the call title as just `read`; their path is carried by
// Core's structured RuntimeFileOperation, not by the presentation label.
function nativeReadTitlePath(value) {
  if (typeof value !== 'string' || !value.startsWith('Read ')) return null
  const rest = value.slice(5)
  const window = / \((?:\d+ - \d+|from line \d+)\)$/u.exec(rest)
  return window ? rest.slice(0, window.index) : rest
}

export function nativeReadVerdict({ rows, runId, expectedPath, marker, selectedMaterial }) {
  if (!/^[0-9a-f-]{36}$/iu.test(String(runId ?? ''))) return nativeUnavailable('native_read_run_id_invalid')
  if (typeof marker !== 'string' || marker.length < 8 || marker.length > 256 || /[\s<>]/u.test(marker)) {
    return nativeUnavailable('native_read_marker_invalid')
  }
  const expected = normalizeNativePath(expectedPath)
  if (!expected) return nativeUnavailable('native_read_path_invalid')
  if (selectedMaterial?.status !== 'PASS' || selectedMaterial.runId !== runId
      || !/^[0-9a-f]{64}$/u.test(String(selectedMaterial.skillBodySha256 ?? ''))) {
    return nativeUnavailable('native_read_selected_material_unverified')
  }
  if (!Array.isArray(rows)) return nativeUnavailable('native_read_evidence_missing')
  if (rows.length > NATIVE_READ_LIMIT) return nativeUnavailable('native_read_evidence_over_budget')
  const reasons = new Set()
  const matches = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') { reasons.add('native_read_evidence_malformed'); continue }
    if (row.agentRunId !== runId) {
      reasons.add('native_read_evidence_wrong_run'); continue
    }
    if (row.kind !== 'tool_result' || row.phase !== 'completed' || row.eventType !== 'runtime.action') continue
    if (typeof row.operationId !== 'string' || row.operationId.length === 0) {
      reasons.add('native_read_evidence_malformed'); continue
    }
    const input = parseEvidenceObject(row.inputPreview)
    const result = parseEvidenceObject(row.resultPreview)
    if (!input || !result) { reasons.add('native_read_evidence_malformed'); continue }
    if (input.kind !== 'read') { reasons.add('native_read_evidence_not_read_tool'); continue }
    let pathSource = 'native_read_title'
    let declared = normalizeNativePath(nativeReadTitlePath(input.title))
    if (Object.hasOwn(result, 'runtimeFileOperation')) {
      const operation = parseEvidenceObject(result.runtimeFileOperation)
      const valid = operation?.schemaVersion === 2 && operation?.operationKind === 'read'
        && operation?.status === 'available' && operation?.source === 'runtime_reported'
        && operation?.sourceMetadata?.adapterKind === 'deepseek-harness'
        && operation?.sourceMetadata?.sourceEventKind === 'session/update.tool_call_update.completed'
      declared = valid ? normalizeNativePath(operation.path) : null
      pathSource = 'runtime_file_operation'
    }
    if (!declared || declared !== expected) { reasons.add('native_read_evidence_wrong_path'); continue }
    if (result.status !== 'completed' || result._rovaiLifecycle?.resultObserved !== true) {
      reasons.add('native_read_evidence_incomplete'); continue
    }
    const output = result.output
    if (typeof output !== 'string' || output.length === 0) { reasons.add('native_read_evidence_incomplete'); continue }
    const envelope = NATIVE_READ_ENVELOPE.exec(output)
    if (!envelope) { reasons.add('native_read_evidence_incomplete'); continue }
    const observed = normalizeNativePath(envelope[1])
    if (!observed || observed !== expected) { reasons.add('native_read_evidence_wrong_path'); continue }
    if (!output.includes(marker)) { reasons.add('native_read_evidence_marker_missing'); continue }
    matches.push({ operationId: row.operationId, output, pathSource })
  }
  if (matches.length === 0) {
    return { status: 'NOT_RUN', reasons: [...(reasons.size ? reasons : ['native_read_evidence_missing'])].sort(),
      source: NATIVE_READ_SOURCE, nativeRegistryVerified: false }
  }
  if (matches.length > 1) return nativeUnavailable('native_read_evidence_duplicate')
  const [match] = matches
  return { status: 'PASS', reasons: [], source: NATIVE_READ_SOURCE, runId,
    operationId: match.operationId,
    frozenBodySha256: selectedMaterial.skillBodySha256,
    nativeOutputSha256: digest(match.output),
    nativeOutputBytes: Buffer.byteLength(match.output, 'utf8'),
    pathMatched: true, pathSource: match.pathSource, markerObserved: true, nativeRegistryVerified: false }
}

export async function readNativeSelectedSkill({ dataDir, fixtureRoot, runId, skillName, marker, selectedMaterial }) {
  if (!/^[0-9a-f-]{36}$/iu.test(String(runId ?? ''))) return nativeUnavailable('native_read_run_id_invalid')
  if (typeof skillName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(skillName)
      || skillName.includes('..')) return nativeUnavailable('native_read_skill_name_invalid')
  // The only path a receipt may name: the frozen body of this Run and Skill.
  const expectedPath = join(dataDir, 'runtime', 'skills', runId, 'skills', skillName, 'SKILL.md')
  const databasePath = join(dataDir, 'rovai.sqlite')
  let database
  try {
    await confinedPath(fixtureRoot, databasePath, 512 * 1024 * 1024)
    const { DatabaseSync } = await import('node:sqlite')
    database = new DatabaseSync(databasePath, { readOnly: true })
    const rows = database.prepare(NATIVE_READ_QUERY).all(runId)
    if (rows.length > NATIVE_READ_LIMIT) return nativeUnavailable('native_read_evidence_over_budget')
    return nativeReadVerdict({ rows, runId, expectedPath, marker, selectedMaterial })
  } catch (error) {
    return nativeUnavailable(error?.code === 'ENOENT'
      ? 'native_read_evidence_missing' : 'native_read_evidence_unreadable_or_unconfined')
  } finally { database?.close() }
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

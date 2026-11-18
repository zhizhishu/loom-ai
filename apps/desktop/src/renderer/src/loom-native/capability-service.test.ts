import { describe, expect, it, vi } from 'vitest'
import type { SkillImportInspection, StoredCommandResult } from '@contracts'
import {
  hookReviewSnapshot,
  type CapabilityCatalog,
  type CapabilityItem,
  type CapabilityKind
} from '../member-catalog-model'
import {
  CapabilityRequestError,
  commitSkill,
  createCapabilityPort,
  inspectSkill,
  listLibrary,
  putHook,
  putRule,
  readCapabilityCatalog,
  readRunProjection,
  registerSkill,
  saveCapabilitySelections,
  type CapabilityRpc,
  type HookDraft,
  type RuleDraft,
  type SkillImportPick
} from './capability-service'

function rpc(request: ReturnType<typeof vi.fn>): CapabilityRpc {
  return { request } as unknown as CapabilityRpc
}

const scope = {
  memberId: 'member',
  missionId: 'mission',
  campId: 'camp',
  workspaceId: 'workspace',
  nodeId: 'node',
  workspaceRoot: '/srv/work',
  workspaceGeneration: 3,
  workspaceTokenDigest: 'sha256:' + 'a'.repeat(64),
  adapterKind: 'claude-code'
}

function item(kind: CapabilityKind, id: string, selected: boolean, over: Partial<CapabilityItem> = {}): CapabilityItem {
  return {
    id,
    kind,
    name: id,
    note: '',
    source: '工具箱',
    scope: 'cloud',
    selected,
    origin: null,
    toolNames: [],
    risk: null,
    ...over
  }
}

function hookItem(id: string, selected: boolean, reviewed: boolean): CapabilityItem {
  return item('hook', id, selected, {
    risk: 'high',
    hookDefinition: {
      body: 'rm -rf build',
      definitionDigest: 'sha256:' + 'b'.repeat(64),
      reviewed,
      reviewScope: scope,
      scopeDigest: 'sha256:' + 'c'.repeat(64)
    }
  })
}

function catalogOf(items: CapabilityItem[], over: Partial<CapabilityCatalog> = {}): CapabilityCatalog {
  return {
    agentId: 'member',
    displayName: 'Member',
    teamRole: 'Build',
    runtime: 'claude-code',
    revision: 'rev-1',
    identity: {
      displayName: 'Member',
      teamRole: 'Build',
      professionalResponsibilities: '',
      personalityTraits: [],
      workingPrinciples: '',
      growthTopic: ''
    },
    items,
    ...over
  }
}

const inspection = {
  stagingToken: 'staging-token',
  sourcePath: '/srv/skills/one',
  expiresAt: '2026-11-13T00:00:00Z',
  candidates: [{
    name: 'one',
    description: 'skill',
    contentDigest: 'sha256:' + 'd'.repeat(64),
    riskSummary: { riskLevel: 'low', findings: [] },
    sourcePath: '/srv/skills/one',
    existingSkillId: null,
    existingSkillVersion: null,
    existingOrigin: null,
    importAction: 'create'
  }],
  rejectedCandidates: []
} as unknown as SkillImportInspection

const applied = {
  commandId: 'cmd-1',
  commandType: 'skills.import.commit',
  status: 'applied',
  code: 'ok',
  payload: { skillId: 'skill-1' },
  resultEntity: null,
  recordedAt: '2026-11-13T00:00:00Z'
} as unknown as StoredCommandResult

const pick: SkillImportPick = {
  candidateName: 'one',
  expectedSkillVersion: null,
  confirmUpdate: false,
  commandId: 'cmd-1'
}

describe('目录读取与运行投影', () => {
  it('reads the whole catalog for one member and changes nothing', async () => {
    const request = vi.fn().mockResolvedValue(catalogOf([item('skill', 'search', true)]))
    const catalog = await readCapabilityCatalog(rpc(request), 'member')
    expect(request).toHaveBeenCalledWith('members.capabilityCatalog.get', { agentId: 'member' })
    expect(catalog.revision).toBe('rev-1')
  })

  it('asks Core for a preview of any configured runtime instead of filtering by brand', async () => {
    const request = vi.fn().mockResolvedValue({ agentId: 'member' })
    // 没选运行端是唯一一个本地短路：没有 runtime 可问。
    expect(await readRunProjection(rpc(request), 'member', null)).toEqual({ status: 'unsupported', runtime: null })
    expect(await readRunProjection(rpc(request), 'member', '   ')).toEqual({ status: 'unsupported', runtime: '   ' })
    expect(request).not.toHaveBeenCalled()
    // Pi 和未知名字都真的发 RPC，能不能预览由 Core 说。
    for (const runtime of ['pi', 'codex-cli', 'other']) {
      await readRunProjection(rpc(request), 'member', runtime)
      expect(request).toHaveBeenLastCalledWith('members.runProjection.preview', { member: 'member', runtime })
    }
    // 旧别名说的还是同一个运行端，请求用规范 id。
    await readRunProjection(rpc(request), 'member', 'claude-code-cli')
    expect(request).toHaveBeenLastCalledWith('members.runProjection.preview', { member: 'member', runtime: 'claude-code' })
  })

  it('reports whatever Core answers for pi instead of pretending it is unsupported', async () => {
    const piPreview = { agentId: 'member', runtime: 'pi', bootstrap: 'pi', mcp: {}, skills: [], rules: [], hooks: [] }
    const ready = vi.fn().mockResolvedValue(piPreview)
    expect(await readRunProjection(rpc(ready), 'member', 'pi')).toEqual({ status: 'ready', preview: piPreview })
    // Core 真的拒绝时才算 unsupported，两个号都保留 Core 的说法。
    for (const code of ['runtime_required', 'runtime_unsupported']) {
      const refused = vi.fn().mockRejectedValue({ code })
      expect(await readRunProjection(rpc(refused), 'member', 'pi')).toEqual({ status: 'unsupported', runtime: 'pi' })
      expect(refused).toHaveBeenCalledWith('members.runProjection.preview', { member: 'member', runtime: 'pi' })
    }
  })

  it('a preview says only that it was read, never that the run applied it', async () => {
    const request = vi.fn().mockResolvedValue({ agentId: 'member', skills: [], rules: [], hooks: [], mcp: {} })
    const read = await readRunProjection(rpc(request), 'member', 'claude-code')
    expect(read.status).toBe('ready')
    // 没有 applied / active / selected 这类结论字段。
    expect(Object.keys(read).sort()).toEqual(['preview', 'status'])
  })

  it('keeps unsupported and unknown distinct instead of calling them not applied', async () => {
    const missing = vi.fn().mockRejectedValue({ code: 'runtime_required' })
    expect(await readRunProjection(rpc(missing), 'member', 'codex-cli')).toEqual({ status: 'unsupported', runtime: 'codex-cli' })
    const broken = vi.fn().mockRejectedValue({ code: 'internal', message: 'boom' })
    expect(await readRunProjection(rpc(broken), 'member', 'codex-cli')).toEqual({ status: 'error', code: 'internal', message: 'boom' })
    const foreign = vi.fn().mockResolvedValue({ agentId: 'other' })
    expect(await readRunProjection(rpc(foreign), 'member', 'codex-cli')).toMatchObject({ status: 'error', code: 'local.projection_mismatch' })
  })
})

describe('保存勾选', () => {
  const saved = catalogOf([item('skill', 'search', false), item('mcp', 'github', true)])
  const draft = [item('skill', 'search', true), item('mcp', 'github', true)]

  it('sends exactly the existing set contract with the current revision', async () => {
    const request = vi.fn().mockResolvedValue(catalogOf(draft))
    await saveCapabilitySelections(rpc(request), saved, draft)
    const [method, payload] = request.mock.calls[0] as [string, Record<string, unknown>]
    expect(method).toBe('members.capabilityCatalog.set')
    expect(Object.keys(payload).sort()).toEqual(['acknowledgeHighRisk', 'agentId', 'expectedRevision', 'reviewedHooks', 'selections'])
    expect(payload).toMatchObject({ agentId: 'member', expectedRevision: 'rev-1', acknowledgeHighRisk: false, reviewedHooks: [] })
    expect(payload.selections).toEqual([
      { kind: 'skill', id: 'search', selected: true },
      { kind: 'mcp', id: 'github', selected: true }
    ])
  })

  it('refuses a draft entry the catalog never listed', async () => {
    const request = vi.fn()
    await expect(saveCapabilitySelections(rpc(request), saved, [item('skill', 'ghost', true)]))
      .rejects.toThrow(CapabilityRequestError)
    await expect(saveCapabilitySelections(rpc(request), saved, [item('skill', 'ghost', true)]))
      .rejects.toMatchObject({ code: 'local.selection_not_in_catalog' })
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses a review snapshot from another member, revision or selection set', async () => {
    const request = vi.fn()
    const snapshot = hookReviewSnapshot({
      agentId: 'member', revision: 'rev-1', token: 99, acknowledgeHighRisk: true,
      selections: draft.map((entry) => ({ kind: entry.kind, id: entry.id, selected: entry.selected })), pending: []
    })
    expect(snapshot).not.toBeNull()
    for (const stale of [
      { ...snapshot!, agentId: 'other' },
      { ...snapshot!, revision: 'rev-2' },
      { ...snapshot!, selections: [{ kind: 'skill' as const, id: 'search', selected: false }] }
    ]) {
      await expect(saveCapabilitySelections(rpc(request), saved, draft, stale))
        .rejects.toMatchObject({ code: 'local.snapshot_mismatch' })
    }
    expect(request).not.toHaveBeenCalled()
  })

  it('does not compare the snapshot token: generation stays with the UI', async () => {
    const request = vi.fn().mockResolvedValue(catalogOf(draft))
    const snapshot = hookReviewSnapshot({
      agentId: 'member', revision: 'rev-1', token: 424242, acknowledgeHighRisk: false,
      selections: draft.map((entry) => ({ kind: entry.kind, id: entry.id, selected: entry.selected })), pending: []
    })
    await expect(saveCapabilitySelections(rpc(request), saved, draft, snapshot)).resolves.toBeTruthy()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('refuses an unreviewed hook and a high-risk item locally instead of asking Core', async () => {
    const hookSaved = catalogOf([hookItem('review_hook', false, false)])
    const request = vi.fn()
    await expect(saveCapabilitySelections(rpc(request), hookSaved, [hookItem('review_hook', true, false)]))
      .rejects.toMatchObject({ code: 'local.hook_review_required' })
    const risky = catalogOf([item('mcp', 'risky', false, { risk: 'high' })])
    await expect(saveCapabilitySelections(rpc(request), risky, [item('mcp', 'risky', true, { risk: 'high' })]))
      .rejects.toMatchObject({ code: 'local.high_risk_acknowledgement_required' })
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses to newly enable a hook that has no Core definition, before any RPC', async () => {
    const request = vi.fn()
    const savedHook = catalogOf([item('hook', 'no_scope', false, { risk: 'high' })])
    await expect(saveCapabilitySelections(rpc(request), savedHook, [item('hook', 'no_scope', true, { risk: 'high' })]))
      .rejects.toMatchObject({ code: 'local.hook_definition_missing' })
    expect(request).not.toHaveBeenCalled()
  })

  it('does not let a draft definition authorize what Core never gave', async () => {
    // 草稿里塞了一份 reviewed 的假定义：Core 的目录才是唯一来源，不能拿它过闸。
    const request = vi.fn()
    const savedHook = catalogOf([item('hook', 'no_scope', false, { risk: 'high' })])
    const forged = hookItem('no_scope', true, true)
    await expect(saveCapabilitySelections(rpc(request), savedHook, [forged]))
      .rejects.toMatchObject({ code: 'local.hook_definition_missing' })
    expect(request).not.toHaveBeenCalled()
    // 目录里是未审阅定义，草稿自己写 reviewed:true 也不能跳过审阅。
    const unreviewed = catalogOf([hookItem('review_hook', false, false)])
    await expect(saveCapabilitySelections(rpc(request), unreviewed, [hookItem('review_hook', true, true)]))
      .rejects.toMatchObject({ code: 'local.hook_review_required' })
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps a saved selection without a definition instead of revoking it while other items change', async () => {
    const request = vi.fn().mockResolvedValue(catalogOf([]))
    const savedCatalog = catalogOf([
      item('hook', 'no_scope', true, { risk: 'high' }),
      item('skill', 'search', false)
    ])
    const draft = [
      item('hook', 'no_scope', true, { risk: 'high' }),
      item('skill', 'search', true)
    ]
    await saveCapabilitySelections(rpc(request), savedCatalog, draft)
    const payload = request.mock.calls[0][1] as Record<string, unknown>
    expect(payload.selections).toEqual([
      { kind: 'hook', id: 'no_scope', selected: true },
      { kind: 'skill', id: 'search', selected: true }
    ])
  })

  it('allows removing a saved hook that has no definition', async () => {
    const request = vi.fn().mockResolvedValue(catalogOf([]))
    const savedCatalog = catalogOf([item('hook', 'no_scope', true, { risk: 'high' })])
    await saveCapabilitySelections(rpc(request), savedCatalog, [item('hook', 'no_scope', false, { risk: 'high' })])
    const payload = request.mock.calls[0][1] as Record<string, unknown>
    expect(payload.selections).toEqual([{ kind: 'hook', id: 'no_scope', selected: false }])
  })

  it('sends the frozen approvals once the user reviewed the hook body and scope', async () => {
    const hookSaved = catalogOf([hookItem('review_hook', false, false)])
    const hookDraft = [hookItem('review_hook', true, false)]
    const snapshot = hookReviewSnapshot({
      agentId: 'member', revision: 'rev-1', token: 1, acknowledgeHighRisk: true,
      selections: [{ kind: 'hook', id: 'review_hook', selected: true }],
      pending: hookDraft
    })
    const request = vi.fn().mockResolvedValue(catalogOf(hookDraft))
    await saveCapabilitySelections(rpc(request), hookSaved, hookDraft, snapshot)
    const payload = request.mock.calls[0][1] as Record<string, unknown>
    expect(payload.acknowledgeHighRisk).toBe(true)
    expect(payload.reviewedHooks).toEqual([{
      id: 'review_hook',
      definitionDigest: 'sha256:' + 'b'.repeat(64),
      scopeDigest: 'sha256:' + 'c'.repeat(64)
    }])
  })

  it('a snapshot that acknowledges nothing still cannot smuggle a high-risk item', async () => {
    const risky = catalogOf([item('mcp', 'risky', false, { risk: 'high' })])
    const riskyDraft = [item('mcp', 'risky', true, { risk: 'high' })]
    const snapshot = hookReviewSnapshot({
      agentId: 'member', revision: 'rev-1', token: 1, acknowledgeHighRisk: false,
      selections: [{ kind: 'mcp', id: 'risky', selected: true }], pending: []
    })
    const request = vi.fn()
    await expect(saveCapabilitySelections(rpc(request), risky, riskyDraft, snapshot))
      .rejects.toMatchObject({ code: 'local.high_risk_acknowledgement_required' })
    expect(request).not.toHaveBeenCalled()
  })

  it('surfaces Core refusals by their own code instead of restating them', async () => {
    for (const code of ['capability.revision_conflict', 'capability.conflict', 'capability.hook_review_conflict',
      'capability.hook_review_scope_changed', 'capability.skill_source_unavailable']) {
      const request = vi.fn().mockRejectedValue({ code, message: 'refused' })
      await expect(saveCapabilitySelections(rpc(request), saved, draft)).rejects.toMatchObject({ code })
    }
  })
})

describe('导入与登记', () => {
  it('inspects one explicit user path and nothing else', async () => {
    const request = vi.fn().mockResolvedValue(inspection)
    await inspectSkill(rpc(request), '  /srv/skills/one  ')
    expect(request).toHaveBeenCalledWith('skills.import.inspect', { path: '/srv/skills/one' })
    await expect(inspectSkill(rpc(vi.fn()), '   ')).rejects.toMatchObject({ code: 'local.inspection_mismatch' })
  })

  it('commits the immutable inspection result for the clicked candidate only', async () => {
    const request = vi.fn().mockResolvedValue(applied)
    const outcome = await commitSkill(rpc(request), inspection, pick)
    expect(outcome).toEqual({ status: 'applied', candidateName: 'one', skillId: 'skill-1' })
    expect(request).toHaveBeenCalledWith('skills.import.commit', {
      commandId: 'cmd-1',
      command: {
        stagingToken: 'staging-token',
        candidateName: 'one',
        expectedDigest: 'sha256:' + 'd'.repeat(64),
        expectedSkillVersion: null,
        confirmUpdate: false
      }
    })
  })

  it('never re-inspects behind the user consent and refuses a drifted candidate', async () => {
    const request = vi.fn()
    await expect(commitSkill(rpc(request), inspection, { ...pick, candidateName: 'two' }))
      .rejects.toMatchObject({ code: 'local.inspection_mismatch' })
    await expect(commitSkill(rpc(request), inspection, { ...pick, expectedSkillVersion: 7 }))
      .rejects.toMatchObject({ code: 'local.inspection_mismatch' })
    const official = { ...inspection, candidates: [{ ...inspection.candidates[0], importAction: 'official_conflict' }] } as SkillImportInspection
    await expect(commitSkill(rpc(request), official, pick)).rejects.toMatchObject({ code: 'local.official_conflict' })
    expect(request).not.toHaveBeenCalled()
  })

  it('reports a rejected commit instead of pretending the import happened', async () => {
    const request = vi.fn().mockResolvedValue({ ...applied, status: 'rejected', code: 'skill_update_confirmation_required', payload: null })
    expect(await commitSkill(rpc(request), inspection, pick)).toMatchObject({
      status: 'rejected', code: 'skill_update_confirmation_required'
    })
  })

  it('reads the skill id from the stored receipt entity when the payload omits it', async () => {
    const request = vi.fn().mockResolvedValue({ ...applied, payload: {}, resultEntity: { entityType: 'skill', entityId: 'skill-9' } })
    expect(await commitSkill(rpc(request), inspection, pick)).toMatchObject({ status: 'applied', skillId: 'skill-9' })
  })

  it('registers the imported skill under the Core-owned library id, repeatably and unselected', async () => {
    const request = vi.fn().mockResolvedValue({ id: 'library:skill-1', kind: 'skill', name: 'one', toolNames: [] })
    await registerSkill(rpc(request), ' skill-1 ')
    await registerSkill(rpc(request), 'skill-1')
    expect(request).toHaveBeenNthCalledWith(1, 'members.capabilityCatalog.putItem', { kind: 'skill', itemId: 'library:skill-1', toolNames: [] })
    expect(request).toHaveBeenNthCalledWith(2, 'members.capabilityCatalog.putItem', { kind: 'skill', itemId: 'library:skill-1', toolNames: [] })
    expect(request.mock.calls[0][1]).not.toHaveProperty('selected')
    await expect(registerSkill(rpc(vi.fn()), '  ')).rejects.toMatchObject({ code: 'local.skill_id_missing' })
  })

  it('lists the library read without registering anything', async () => {
    const request = vi.fn().mockResolvedValue([{ id: 'skill-1', name: 'one', origin: 'imported' }])
    expect(await listLibrary(rpc(request))).toHaveLength(1)
    expect(request).toHaveBeenCalledWith('skills.list')
  })
})

describe('用户点出来的规则与 hook', () => {
  it('creates a plain rule with the existing putItem contract', async () => {
    const request = vi.fn().mockResolvedValue({ id: 'rule_checklist', kind: 'rule', name: '清单', toolNames: [] })
    const draft: RuleDraft = { id: 'rule_checklist', name: '清单', body: '先看测试。' }
    await putRule(rpc(request), draft)
    expect(request).toHaveBeenCalledWith('members.capabilityCatalog.putItem', {
      kind: 'rule', itemId: 'rule_checklist', name: '清单', note: '', scope: 'cloud', body: '先看测试。', toolNames: []
    })
    expect(request.mock.calls[0][1]).not.toHaveProperty('selected')
  })

  it('creates a hook snippet that stays unreviewed and unselected', async () => {
    const request = vi.fn().mockResolvedValue({ id: 'hook_lint', kind: 'hook', name: 'lint', toolNames: [] })
    const draft: HookDraft = { id: null, name: 'lint', body: 'npm run lint', scope: 'project' }
    await putHook(rpc(request), draft)
    const payload = request.mock.calls[0][1] as Record<string, unknown>
    expect(payload).toEqual({ kind: 'hook', name: 'lint', note: '', scope: 'project', body: 'npm run lint', toolNames: [] })
    expect(payload).not.toHaveProperty('selected')
    expect(payload).not.toHaveProperty('reviewed')
  })

  it('mirrors the Core limits before sending', async () => {
    const request = vi.fn()
    await expect(putRule(rpc(request), { id: null, name: '  ', body: 'x' })).rejects.toMatchObject({ code: 'local.invalid_item' })
    await expect(putRule(rpc(request), { id: 'bad id', name: 'n', body: 'x' })).rejects.toMatchObject({ code: 'local.invalid_item' })
    await expect(putRule(rpc(request), { id: null, name: 'n'.repeat(121), body: 'x' })).rejects.toMatchObject({ code: 'local.invalid_item' })
    await expect(putHook(rpc(request), { id: null, name: 'n', body: 'x'.repeat(8001) })).rejects.toMatchObject({ code: 'local.invalid_item' })
    expect(request).not.toHaveBeenCalled()
  })
})

describe('端口绑定', () => {
  it('routes every call through the real Core methods', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(catalogOf([]))
      .mockResolvedValueOnce({ agentId: 'member' })
      .mockResolvedValueOnce(catalogOf([]))
    const port = createCapabilityPort(rpc(request))
    await port.read('member')
    await port.preview('member', 'codex-cli')
    await port.save(catalogOf([]), [])
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      'members.capabilityCatalog.get',
      'members.runProjection.preview',
      'members.capabilityCatalog.set'
    ])
  })
})

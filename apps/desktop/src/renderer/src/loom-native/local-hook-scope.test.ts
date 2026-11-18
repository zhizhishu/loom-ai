import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { HookScopeSummary } from './HookScopeSummary'
import { hookDefinitionMissing, hookReviewSnapshot, pendingHookReview, selectRefusal, selectionsOf,
  type CapabilityCatalog, type CapabilityItem, type LocalHookReviewScope } from '../member-catalog-model'
import { createCapabilityPort, type CapabilityRpc } from './capability-service'

const scope: LocalHookReviewScope = {
  scopeKind: 'local', memberId: 'member', campId: 'camp', executionHostId: 'owned-host',
  workspaceRoot: 'C:/owned/work', workspaceAuthority: { kind: 'camp', campId: 'camp' },
  adapterKind: 'deepseek-harness', permissionsDigest: 'sha256:core-permissions',
  permissions: { adapterKind: 'deepseek-harness', schemaVersion: 1, values: { sandbox_mode: 'workspace-write', approval_policy: 'ask' } }
}
function hook(over: Partial<LocalHookReviewScope> = {}): CapabilityItem {
  return { id: 'hook', kind: 'hook', name: 'Owned hook', note: '', source: 'project', scope: 'project',
    selected: false, origin: null, toolNames: [], risk: 'high',
    hookDefinition: { body: 'owned command', definitionDigest: 'sha256:core-definition', reviewed: false,
      reviewScope: { ...scope, ...over }, scopeDigest: 'sha256:core-scope' } }
}
function catalog(item = hook()): CapabilityCatalog {
  return { agentId: 'member', displayName: 'Assistant', teamRole: '', runtime: 'deepseek-harness', revision: 'core-revision',
    identity: { displayName: 'Assistant', teamRole: '', professionalResponsibilities: '', personalityTraits: [], workingPrinciples: '', growthTopic: '' }, items: [item] }
}
function reviewed(saved: CapabilityCatalog, draft: CapabilityItem[]) {
  return hookReviewSnapshot({ agentId: saved.agentId, revision: saved.revision, token: 1, acknowledgeHighRisk: true,
    selections: selectionsOf(draft), pending: pendingHookReview(draft) })!
}

describe('Core-owned local Hook scope', () => {
  it('shows the actual DSH permission values and bound device before approval', () => {
    const html = renderToStaticMarkup(createElement(HookScopeSummary, { scope }))
    expect(html).toContain('允许修改工作目录')
    expect(html).toContain('需要时向你确认')
    expect(html).toContain(scope.executionHostId)
    expect(html).toContain(scope.workspaceRoot)
    expect(html).toContain(scope.campId)
    expect(html).not.toContain('未提供')
  })

  it('accepts a complete local authority without inventing a remote node', () => {
    expect(hookDefinitionMissing(hook())).toBe(false)
    expect(selectRefusal(hook())).toBe('')
    const saved = catalog(), draft = [{ ...saved.items[0]!, selected: true }]
    const snapshot = reviewed(saved, draft)
    expect(snapshot.entries[0]!.scope).toEqual(scope)
    expect(snapshot.approvals).toEqual([{ id: 'hook', definitionDigest: 'sha256:core-definition', scopeDigest: 'sha256:core-scope' }])
    expect(snapshot.entries[0]!.scope).not.toHaveProperty('nodeId')
  })

  it('refuses incomplete or mismatched local authority while allowing removal', () => {
    for (const patch of [
      { memberId: '' }, { campId: '' }, { executionHostId: '' }, { workspaceRoot: ' ' }, { permissionsDigest: '' },
      { workspaceAuthority: { kind: 'camp' as const, campId: 'other-camp' } },
      { permissions: undefined as unknown as LocalHookReviewScope['permissions'] }
    ]) {
      const item = hook(patch)
      expect(selectRefusal(item)).toBe('hook-scope')
      expect(selectRefusal({ ...item, selected: true })).toBe('')
    }
  })

  it('requires the exact mission workspace authority when Core selects one', () => {
    const authority = { kind: 'mission' as const, missionId: 'mission', workspaceId: 'workspace', workspaceGeneration: 3, workspaceTokenDigest: 'sha256:token' }
    expect(selectRefusal(hook({ workspaceAuthority: authority }))).toBe('')
    for (const patch of [{ workspaceGeneration: NaN }, { workspaceGeneration: -1 }, { workspaceTokenDigest: '' }, { workspaceId: '' }, { missionId: '' }]) {
      expect(selectRefusal(hook({ workspaceAuthority: { ...authority, ...patch } }))).toBe('hook-scope')
    }
  })

  it('sends only the real conversation id on read and explicit reviewed digests on save', async () => {
    const saved = catalog(), draft = [{ ...saved.items[0]!, selected: true }]
    const request = vi.fn(async () => saved)
    const port = createCapabilityPort({ request } as unknown as CapabilityRpc, 'camp')
    await port.read('member')
    expect(request).toHaveBeenLastCalledWith('members.capabilityCatalog.get', { agentId: 'member', localCampId: 'camp' })
    await port.save(saved, draft, reviewed(saved, draft))
    expect(request).toHaveBeenLastCalledWith('members.capabilityCatalog.set', {
      agentId: 'member', localCampId: 'camp', expectedRevision: 'core-revision', acknowledgeHighRisk: true,
      selections: [{ kind: 'hook', id: 'hook', selected: true }],
      reviewedHooks: [{ id: 'hook', definitionDigest: 'sha256:core-definition', scopeDigest: 'sha256:core-scope' }]
    })
  })

  it('never approves a local hook implicitly or carries approval into another conversation', async () => {
    const saved = catalog(), draft = [{ ...saved.items[0]!, selected: true }]
    const request = vi.fn(async () => saved), rpc = { request } as unknown as CapabilityRpc
    await expect(createCapabilityPort(rpc, 'camp').save(saved, draft)).rejects.toMatchObject({ code: 'local.hook_review_required' })
    for (const camp of [undefined, 'other-camp']) {
      await expect(createCapabilityPort(rpc, camp).save(saved, draft, reviewed(saved, draft))).rejects.toMatchObject({ code: 'local.snapshot_mismatch' })
    }
    expect(request).not.toHaveBeenCalled()
  })

  it('can still turn a selected local hook off after losing its context', async () => {
    const saved = catalog({ ...hook(), selected: true }), draft = [{ ...saved.items[0]!, selected: false }]
    const request = vi.fn(async () => catalog())
    await createCapabilityPort({ request } as unknown as CapabilityRpc).save(saved, draft)
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]).toEqual(['members.capabilityCatalog.set', {
      agentId: 'member', expectedRevision: 'core-revision', acknowledgeHighRisk: false,
      selections: [{ kind: 'hook', id: 'hook', selected: false }], reviewedHooks: []
    }])
  })
})

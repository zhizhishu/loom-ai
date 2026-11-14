import { describe, expect, it } from 'vitest'
import {
  hookReviewSnapshot,
  pendingHookReview,
  revertPending,
  selectRefusal,
  snapshotApplies,
  type CapabilityItem,
  type HookReviewScope
} from './member-catalog-model'

const scope: HookReviewScope = {
  memberId: 'agent_1',
  missionId: 'mission_1',
  campId: 'camp_1',
  workspaceId: 'ws_1',
  nodeId: 'node_1',
  workspaceRoot: '/srv/repo',
  workspaceGeneration: 3,
  workspaceTokenDigest: 'sha256:token',
  adapterKind: 'codex-cli'
}

function hook(body: string, reviewed: boolean, overrides: Partial<CapabilityItem> = {}): CapabilityItem {
  return {
    id: 'guard',
    kind: 'hook',
    name: 'guard',
    note: '',
    source: 'hook 目录',
    scope: 'project',
    selected: true,
    origin: 'explicit',
    toolNames: [],
    risk: 'high',
    hookDefinition: {
      body,
      definitionDigest: `sha256:def-${body}`,
      reviewed,
      reviewScope: scope,
      scopeDigest: 'sha256:scope-1'
    },
    ...overrides
  }
}

describe('hook review snapshot', () => {
  it('needs approval only for a selected, unreviewed definition and carries Core digests verbatim', () => {
    const pending = pendingHookReview([hook('stop: format', false)])
    expect(pending.map((item) => item.id)).toEqual(['guard'])
    const snapshot = hookReviewSnapshot({
      agentId: 'agent_1',
      revision: 'rev-1',
      token: 7,
      acknowledgeHighRisk: true,
      selections: [{ kind: 'hook', id: 'guard', selected: true }],
      pending
    })
    expect(snapshot).not.toBeNull()
    expect(snapshot?.approvals).toEqual([{
      id: 'guard',
      definitionDigest: 'sha256:def-stop: format',
      scopeDigest: 'sha256:scope-1'
    }])
    expect(snapshot?.acknowledgeHighRisk).toBe(true)
    expect(snapshot?.selections).toEqual([{ kind: 'hook', id: 'guard', selected: true }])
    expect(snapshot?.entries[0]).toMatchObject({
      id: 'guard',
      body: 'stop: format',
      scope: { memberId: 'agent_1', nodeId: 'node_1', workspaceRoot: '/srv/repo', adapterKind: 'codex-cli' }
    })
  })

  it('never sends a second approval for a hook Core already reviewed in this scope', () => {
    expect(pendingHookReview([hook('stop: format', true)])).toEqual([])
    const snapshot = hookReviewSnapshot({
      agentId: 'agent_1',
      revision: 'rev-1',
      token: 7,
      acknowledgeHighRisk: false,
      selections: [{ kind: 'hook', id: 'guard', selected: true }],
      pending: []
    })
    expect(snapshot?.approvals).toEqual([])
    expect(snapshot?.entries).toEqual([])
  })

  it('refuses to build an empty approval snapshot when a pending hook has no definition', () => {
    const unread = hook('stop: format', false, { hookDefinition: null })
    expect(hookReviewSnapshot({
      agentId: 'agent_1',
      revision: 'rev-1',
      token: 7,
      acknowledgeHighRisk: false,
      selections: [{ kind: 'hook', id: 'guard', selected: true }],
      pending: [unread]
    })).toBeNull()
  })

  it('leaves an unscoped local hook alone: Core already fails closed there', () => {
    const local = hook('stop: format', false, { hookDefinition: null, selected: false })
    expect(selectRefusal(local)).toBe('')
  })

  it('blocks a new check on a broken source but still allows removing an existing one', () => {
    const broken = hook('stop: format', false, { sourceError: '来源已删除' })
    expect(selectRefusal({ ...broken, selected: false })).toBe('source')
    expect(selectRefusal(broken)).toBe('')
  })

  it('dies on member or generation change instead of comparing revisions only', () => {
    const snapshot = hookReviewSnapshot({
      agentId: 'agent_1',
      revision: 'rev-1',
      token: 7,
      acknowledgeHighRisk: false,
      selections: [],
      pending: []
    })!
    expect(snapshotApplies(snapshot, 'agent_1', 7)).toBe(true)
    expect(snapshotApplies(snapshot, 'agent_2', 7)).toBe(false)
    expect(snapshotApplies(snapshot, 'agent_1', 8)).toBe(false)
  })

  it('cancel reverts the pending checks and leaves no request payload behind', () => {
    const saved = hook('stop: format', true, { selected: false, origin: 'inherited' })
    const draft = hook('stop: format', true, { selected: true })
    const cancelled = revertPending([draft], new Set(['hook:guard']))
    expect(cancelled[0].selected).toBe(false)
    expect(pendingHookReview(cancelled)).toEqual([])
    expect(cancelled[0].hookDefinition).toEqual(saved.hookDefinition)
  })

})

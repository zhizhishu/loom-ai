import { describe, expect, it } from 'vitest'
import {
  hookDefinitionMissing,
  hookReviewSnapshot,
  pendingHookReview,
  previewRuntime,
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

  it('refuses a new check on a hook without a Core-owned readable definition', () => {
    // 未勾选的 hook 没有 Core 给的定义：不能新启用，也不说永远不支持。
    const unread = hook('stop: format', false, { hookDefinition: null, selected: false })
    expect(hookDefinitionMissing(unread)).toBe(true)
    expect(selectRefusal(unread)).toBe('hook-scope')
    // 已勾上的仍可取消，不被同一条门禁拦住。
    expect(selectRefusal({ ...unread, selected: true })).toBe('')
  })

  it('treats an incomplete Core scope as no definition rather than guessing', () => {
    const complete = { ...hook('stop: format', false), selected: false }
    expect(selectRefusal(complete)).toBe('')
    for (const patch of [{ definitionDigest: '' }, { scopeDigest: '' }, { body: '   ' }]) {
      expect(selectRefusal({ ...complete, hookDefinition: { ...complete.hookDefinition!, ...patch } })).toBe('hook-scope')
    }
    for (const patch of [
      { memberId: '' }, { workspaceId: '' }, { nodeId: '' }, { workspaceRoot: ' ' },
      { workspaceTokenDigest: '' }, { adapterKind: '' }, { workspaceGeneration: Number.NaN }
    ]) {
      expect(selectRefusal({
        ...complete,
        hookDefinition: { ...complete.hookDefinition!, reviewScope: { ...scope, ...patch } }
      })).toBe('hook-scope')
    }
  })

  it('asks Core about every non-empty runtime instead of refusing a brand locally', () => {
    // Pi 的 preview 由 Core 决定，不在界面里伪 unsupported。
    expect(previewRuntime('pi')).toBe('pi')
    expect(previewRuntime('codex-cli')).toBe('codex-cli')
    expect(previewRuntime('claude-code')).toBe('claude-code')
    // 旧持久化别名归一成规范 id，说的还是同一个运行端。
    expect(previewRuntime('claude-code-cli')).toBe('claude-code')
    // 没选运行端才在本地短路；未知名字交给 Core 裁决。
    expect(previewRuntime(null)).toBeNull()
    expect(previewRuntime('  ')).toBeNull()
    expect(previewRuntime('some-new-runtime')).toBe('some-new-runtime')
  })

  it('leaves a fully defined hook selectable and a non-hook untouched', () => {
    expect(selectRefusal({ ...hook('stop: format', false), selected: false })).toBe('')
    const skill: CapabilityItem = { ...hook('stop: format', false), kind: 'skill', selected: false, hookDefinition: null }
    expect(hookDefinitionMissing(skill)).toBe(false)
    expect(selectRefusal(skill)).toBe('')
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

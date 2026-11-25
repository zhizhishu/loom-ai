import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentProfile, ConversationItem, ThreadSnapshot } from './types'
import type { DomainEventView } from '@contracts'
import { ConversationView } from './ConversationView'

vi.mock('../MemberAvatar', async () => {
  const { createElement: h } = await import('react')
  return {
    MemberAvatar: vi.fn((props: { agentId: string }) =>
      h('span', { className: 'member-avatar', 'data-agent': props.agentId }))
  }
})

const agent = (agentId: string, displayName: string): AgentProfile =>
  ({ agentId, displayName, avatarRef: null, teamRole: '助手' } as unknown as AgentProfile)
const member = (agentId: string, displayName: string) =>
  ({ agentId, displayName, avatarRef: null, teamRole: '助手', profilePresence: 'present', membershipStatus: 'active' })
const hanzi = agent('a1', 'Hanzi')
const muwa = agent('a2', 'Muwa')

const snapshot = (title: string, members: ReturnType<typeof member>[]): ThreadSnapshot => ({
  schemaVersion: 9,
  throughGlobalSequence: 1,
  thread: {
    id: 'th-1', title, defaultLeadAgentId: members[0]?.agentId ?? null,
    projectPath: '/repo/app', projectBindingKind: 'directory', version: 1
  },
  members,
  membershipReconciliations: [], tasksEnabled: false, tasks: [], memberCreations: [],
  messages: [], messageDeliveries: [], turns: [], agentRuns: [], executionEvidence: [],
  agentRunFileChanges: [], agentRunImages: [], approvals: [], contextManifests: [], actions: [], timeline: []
} as unknown as ThreadSnapshot)

const item = (over: Partial<ConversationItem> = {}): ConversationItem => ({
  id: 'th-1', title: '发版群', subtitle: '', agentId: 'a1', threadId: 'th-1',
  missionId: null, unread: false, updatedAt: null, ...over
})

const view = (thread: ThreadSnapshot, row: ConversationItem = item()): string =>
  renderToStaticMarkup(createElement(ConversationView, {
    item: row, snapshot: thread, agents: [hanzi, muwa], bundles: [], loading: false, sending: false,
    draft: '', files: [], error: null, onDraft: () => {}, onFiles: () => {}, onSend: () => {}, onProfile: () => {},
    onArtifact: () => {}, onShowSidebar: () => {}, sidebarHidden: false, onShowWork: () => {}, inspectorHidden: false,
    onAttachment: () => {}, onResolveApproval: () => {}, approvalBusy: false, onMembers: () => {}, onWorkspaceManager: () => {}
  }))

// 占位文案照抄 Mikka：群里写群名（`group-chat-view.tsx:271` 传 group.title，
// `messages/zh-CN.json:5715`「给 {name} 发消息」），只有单聊才写助手名。
describe('composer address names the group, not the lead assistant', () => {
  it('addresses the group by its own title', () => {
    const html = view(snapshot('发版群', [member('a1', 'Hanzi'), member('a2', 'Muwa')]))
    expect(html).toContain('给 发版群 发消息')
    expect(html).toContain('aria-label="给发版群发消息"')
    expect(html).not.toContain('给 Hanzi 发消息')
  })

  it('keeps the assistant name for a one-to-one conversation', () => {
    const html = view(snapshot('与 Hanzi 的对话', [member('a1', 'Hanzi')]), item({ title: '与 Hanzi 的对话' }))
    expect(html).toContain('给 Hanzi 发消息')
  })

  it('mentions replace the recipient dropdown: @ names who answers, no @ leaves it to the server', () => {
    const group = view(snapshot('发版群', [member('a1', 'Hanzi'), member('a2', 'Muwa')]))
    expect(group).toContain('ln-composer-hint')
    expect(group).toContain('@名字')
    expect(group).toContain('Hanzi、Muwa')
    // 收件人 chip（"{name} 默认" 下拉）已移除。
    expect(group).not.toContain('ln-recipient-control')
    expect(group).not.toContain('默认')
    const direct = view(snapshot('与 Hanzi 的对话', [member('a1', 'Hanzi')]), item({ title: '与 Hanzi 的对话' }))
    expect(direct).not.toContain('ln-composer-hint')
    expect(direct).not.toContain('ln-recipient-control')
  })

  it('shows the group as stacked member portraits, not one assistant avatar', () => {
    const group = view(snapshot('发版群', [member('a1', 'Hanzi'), member('a2', 'Muwa')]))
    expect(group).toContain('ln-group-avatar')
    expect(group).toContain('data-agent="a1"')
    expect(group).toContain('data-agent="a2"')
  })
})

// 验收 C2：timeline 的群成员事件投影成聊天流系统行（不写库、不进「会话记录」），
// 按 eventId 去重、eventId 空用 globalSequence 兜底，与消息按 createdAt 并入同一条流。
const memberEvent = (eventId: string, agentId: string, eventType: 'camp.member_added' | 'camp.member_removed'): DomainEventView =>
  ({
    globalSequence: 1, eventId, eventType, threadId: 'th-1', entityType: null, entityId: null,
    actorType: null, actorId: null, sourceAgentRunId: null, executionEpoch: null,
    payload: { agentId }, createdAt: '2026-02-03T10:00:00.000Z'
  } as DomainEventView)

describe('member timeline system lines', () => {
  const occurrences = (html: string, marker: string): number => html.split(marker).length - 1

  it('timeline shows a system line when an existing agent is added', () => {
    const thread = {
      ...snapshot('发版群', [member('a1', 'Hanzi'), member('a2', 'Muwa')]),
      timeline: [memberEvent('evt-add-1', 'a2', 'camp.member_added')]
    }
    for (const html of [view(thread), view(thread)]) {
      expect(occurrences(html, 'data-member-event-kind="added"')).toBe(1)
      expect(occurrences(html, 'Muwa已加入群聊')).toBe(1)
      expect(html).toContain('data-event-id="evt-add-1"')
    }
  })

  it('timeline shows a system line when an existing agent is removed', () => {
    const thread = {
      ...snapshot('发版群', [member('a1', 'Hanzi'), member('a2', 'Muwa')]),
      timeline: [memberEvent('evt-add-1', 'a2', 'camp.member_added'), memberEvent('evt-remove-1', 'a2', 'camp.member_removed')]
    }
    const html = view(thread)
    expect(html.split('data-member-event-kind="added"').length - 1).toBe(1)
    expect(html.split('Muwa已加入群聊').length - 1).toBe(1)
    expect(html.split('data-member-event-kind="removed"').length - 1).toBe(1)
    expect(html.split('Muwa已移出群聊').length - 1).toBe(1)
  })
})

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentProfile, ConversationItem, ThreadSnapshot } from './types'
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

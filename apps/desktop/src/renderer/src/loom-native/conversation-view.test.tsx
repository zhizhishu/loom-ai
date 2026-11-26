import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentProfile, ConversationItem, ThreadSnapshot } from './types'
import type { ActionApprovalView, DomainEventView, LoomArtifact, LoomCandidate, MissionRecord } from '@contracts'
import { ConversationView } from './ConversationView'
import type { WorkBundle } from './types'

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

const view = (thread: ThreadSnapshot, row: ConversationItem = item(), quote: import('./artifact-quote').ArtifactQuote | null = null): string =>
  renderToStaticMarkup(createElement(ConversationView, {
    item: row, snapshot: thread, agents: [hanzi, muwa], bundles: [], loading: false, sending: false,
    draft: '', files: [], error: null, quote, onRemoveQuote: quote ? () => {} : undefined, onDraft: () => {}, onFiles: () => {}, onSend: () => {}, onProfile: () => {},
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
const memberEvent = (eventId: string, agentId: string, eventType: 'camp.member_added' | 'camp.member_removed' | 'thread.member_added' | 'thread.member_removed'): DomainEventView =>
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

// 聊天 | 成果（Mikka ThreadSegments）：线程产出过成果才出现切换；默认停在聊天段，
// 成果分组与打开入口在 ThreadResults/thread-artifacts 的测试里覆盖。
const artifact = (over: Partial<LoomArtifact>): LoomArtifact => ({
  artifactId: 'a1', planId: 'p1', taskId: 't1', agentRunId: 'r1',
  relativePath: 'out/report.md', sha256: 's', sizeBytes: 2048, contentType: null,
  creatorId: 'host', createdAt: '2026-11-26T10:00:00.000Z', ...over
})

const bundleWith = (threadId: string | null, artifacts: LoomArtifact[]): WorkBundle => ({
  mission: { missionId: 'm1', title: '发版', threadId } as unknown as MissionRecord,
  plan: null, tasks: [], candidates: [] as LoomCandidate[], artifacts, reviews: [], verifications: []
})

const viewWithBundles = (thread: ThreadSnapshot, bundles: WorkBundle[]): string =>
  renderToStaticMarkup(createElement(ConversationView, {
    item: item(), snapshot: thread, agents: [hanzi, muwa], bundles, loading: false, sending: false,
    draft: '', files: [], error: null, onDraft: () => {}, onFiles: () => {}, onSend: () => {}, onProfile: () => {},
    onArtifact: () => {}, onShowSidebar: () => {}, sidebarHidden: false, onShowWork: () => {}, inspectorHidden: false,
    onAttachment: () => {}, onResolveApproval: () => {}, approvalBusy: false, onMembers: () => {}, onWorkspaceManager: () => {}
  }))

describe('聊天 | 成果 segmented toggle', () => {
  const thread = snapshot('发版群', [member('a1', 'Hanzi'), member('a2', 'Muwa')])

  it('shows the 聊天/成果 toggle only when this thread produced artifacts', () => {
    const withResults = viewWithBundles(thread, [bundleWith('th-1', [artifact({})])])
    expect(withResults).toContain('ln-thread-tabs')
    expect(withResults).toContain('>聊天</button>')
    expect(withResults).toContain('>成果</button>')
    expect(withResults).toContain('aria-selected="true"') // 默认停在聊天段
    const withoutResults = viewWithBundles(thread, [bundleWith('th-2', [artifact({})])])
    expect(withoutResults).not.toContain('ln-thread-tabs')
  })

  it('keeps the chat transcript as the default segment', () => {
    const html = viewWithBundles(thread, [bundleWith('th-1', [artifact({})])])
    expect(html).toContain('ln-transcript')
    expect(html).toContain('ln-composer')
    // 成果段本体此刻未展开（默认聊天段），切换后的分组渲染在 ThreadResults 测试覆盖。
    expect(html).not.toContain('ln-result-group')
  })
})


describe('collapsible long messages', () => {
  it('wraps normal messages for measured folding without showing a button before measurement', () => {
    const message = (id: string, authorType: 'user' | 'agent', body: string) => ({
      id, sequence: 1, authorType, authorId: authorType === 'user' ? 'local_user' : 'a1', authorDisplayName: null,
      body, withdrawn: false, attachments: [], agentRunId: null, createdAt: '2026-02-03T10:00:00.000Z'
    })
    const thread = {
      ...snapshot('发版群', [member('a1', 'Hanzi')]),
      messages: [
        message('m-long', 'user', '很长的普通消息'),
        message('m-record', 'agent', '[LOOM_HANDOFF] {"dispatchId":"d1"}')
      ]
    }
    const html = view(thread as unknown as ThreadSnapshot)
    expect(html).toContain('class="ln-collapsible-message"')
    expect(html).toContain('ln-collapsible-frame')
    expect(html).not.toContain('显示更多')
    expect(html).toContain('ln-execution-record')
    expect(html.indexOf('m-long')).toBeGreaterThan(-1)
  })
})


describe('artifact quotes in chat', () => {
  const message = (id: string, authorType: 'user' | 'agent', body: string) => ({
    id, sequence: 1, authorType, authorId: authorType === 'user' ? 'local_user' : 'a1', authorDisplayName: null,
    body, withdrawn: false, attachments: [], agentRunId: null, createdAt: '2026-02-03T10:00:00.000Z'
  })

  it('draws a stored artifact quote above the message instead of raw quote markup', () => {
    const thread = {
      ...snapshot('发版群', [member('a1', 'Hanzi')]),
      messages: [message('m-quote', 'user', '<quote artifact="art-1" version="2" kind="text">核对首页截图</quote>\n请继续改这一处')]
    }
    const html = view(thread as unknown as ThreadSnapshot)
    expect(html).toContain('data-slot="artifact-quote"')
    expect(html).toContain('核对首页截图')
    expect(html).toContain('请继续改这一处')
    expect(html).not.toContain('&lt;quote')
    expect(html).not.toContain('artifact=&quot;art-1')
  })

  it('shows the pending artifact quote as a removable composer chip', () => {
    const html = view(snapshot('发版群', [member('a1', 'Hanzi')]) as unknown as ThreadSnapshot, item(), { artifactId: 'art-1', version: 2, kind: 'text', text: '核对首页截图' })
    expect(html).toContain('data-slot="artifact-quote-chip"')
    expect(html).toContain('成果 v2')
    expect(html).toContain('移除成果引用')
  })
})

describe('approval cards above composer', () => {
  it('shows per-card waiting age without inventing an expired state', () => {
    const approval = {
      id: 'ap1', actionId: 'ac1', actionKind: 'shell.command', actionSummary: '运行 npm test', canonicalInput: {},
      reason: '这条命令会写入工作目录', agentRunId: 'r1', agentId: 'a1', adapterKind: 'pi',
      nativeMethod: null, requestDigest: null, permissionSemantics: 'core_enforced_v1',
      options: [{ optionId: 'o1', kind: 'allow_once', label: '允许一次', consequence: '只运行这一条命令', nativeResponseDigest: 'd1' }],
      status: 'pending', requestedForUserId: 'local_user', resolvedByType: null, resolvedById: null,
      resolutionCode: null, version: 1, requestedAt: '2026-11-22T00:00:00.000Z', resolvedAt: null
    } as ActionApprovalView
    const thread = { ...snapshot('发版群', [member('a1', 'Hanzi')]), approvals: [approval] }
    const html = view(thread)
    expect(html).toContain('ln-approval-age')
    expect(html).toContain('已等待')
    expect(html).toContain('等待较久')
    expect(html).not.toContain('已过期')
    expect(html.indexOf('ln-approval-request')).toBeLessThan(html.indexOf('class="ln-composer"'))
  })
})

import { describe, expect, it } from 'vitest'
import type { ThreadCreationPreflight } from '@contracts'
import { isNewConversationMemberAvailable, newConversationMemberStatus } from './new-conversation-availability'
import { planInitialThreadSelection } from './NewConversationDialog'

describe('new conversation member availability', () => {
  it('uses explicit remote eligibility and never rescues an offline target with local readiness', () => {
    const member: ThreadCreationPreflight['presentMembers'][number] = {
      agentId: 'remote', displayName: 'Remote', memberOrder: 0,
      runtimeConfigured: false, runtimeReadiness: 'runtime_not_configured',
      executionAvailability: {
        location: 'remote', configured: true, canLaunch: true,
        adapterKind: 'claude-code-cli', targetRevision: 2,
        nodeId: 'node-b', workspaceId: 'workspace-b',
        readiness: { status: 'installed_unverified', blockers: [] }
      }
    }
    expect(isNewConversationMemberAvailable(member)).toBe(true)
    expect(newConversationMemberStatus(member)).toBe('远端可用')
    member.runtimeConfigured = true
    member.runtimeReadiness = 'ready'
    member.executionAvailability!.canLaunch = false
    member.executionAvailability!.readiness = {
      status: 'needs_attention', blockers: [{ code: 'remote_node_offline', detail: null }]
    }
    expect(isNewConversationMemberAvailable(member)).toBe(false)
    expect(newConversationMemberStatus(member)).toBe('远端节点离线')
  })

  it.each([
    [true, 'ready', true, '可用'],
    [true, 'light_ready', true, '可用'],
    [false, 'ready', false, '未配置智能体'],
    [false, 'light_ready', false, '未配置智能体'],
    [false, 'runtime_not_configured', false, '未配置智能体'],
    [true, 'runtime_not_configured', false, '未配置智能体'],
    [true, 'installed_unverified', true, '可用'],
    [true, 'needs_attention', false, '智能体不可用']
  ] as const)('configured=%s readiness=%s', (runtimeConfigured, runtimeReadiness, available, label) => {
    const member = { runtimeConfigured, runtimeReadiness }
    expect(isNewConversationMemberAvailable(member)).toBe(available)
    expect(newConversationMemberStatus(member)).toBe(label)
  })

  it('filters saved unavailable members and Lead, and leaves an empty draft when no one is available', () => {
    const preflight: ThreadCreationPreflight = {
      admissible: true, blockers: [], initialLeadAgentId: 'unsaved',
      presentMembers: [
        { agentId: 'unsaved', displayName: '未配置', memberOrder: 0, runtimeConfigured: false, runtimeReadiness: 'ready' },
        { agentId: 'usable', displayName: '可用', memberOrder: 1, runtimeConfigured: true, runtimeReadiness: 'light_ready' }
      ]
    }
    const preferred = { memberAgentIds: ['unsaved', 'usable'], defaultLeadAgentId: 'unsaved' }
    expect(planInitialThreadSelection(preflight, preferred)).toEqual({ memberIds: ['usable'], leadId: 'usable' })
    preflight.presentMembers[1].runtimeReadiness = 'needs_attention'
    expect(planInitialThreadSelection(preflight, preferred)).toEqual({ memberIds: [], leadId: '' })
    expect(preferred.memberAgentIds).toEqual(['unsaved', 'usable'])
  })
})

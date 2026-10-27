import { describe, expect, it } from 'vitest'
import type { AgentProfile } from '@contracts'
import { composerInvitationTargets, isThreadMemberInvitable } from './composer-invitations'

const runtimeConfiguration: NonNullable<AgentProfile['runtimeConfiguration']> = {
  adapterKind: 'codex-cli',
  model: { mode: 'explicit', modelId: 'test-model', options: {} },
  permissions: { adapterKind: 'codex-cli', schemaVersion: 1, values: {} }
}

const profiles = [
  { agentId: 'active', presence: 'present' as const },
  { agentId: 'outside', presence: 'present' as const },
  { agentId: 'left', presence: 'present' as const },
  { agentId: 'away', presence: 'away' as const }
].map(profile => ({ ...profile, runtimeConfiguration, runtimeReadiness: { status: 'ready' as const, blockers: [] } }))

const members = [
  { agentId: 'active', membershipStatus: 'active' as const, profilePresence: 'present' as const },
  { agentId: 'left', membershipStatus: 'left' as const, profilePresence: 'present' as const },
  { agentId: 'away', membershipStatus: 'active' as const, profilePresence: 'away' as const }
]

describe('composerInvitationTargets', () => {
  it('deduplicates repeated mentions and includes former members for one send-time invite', () => {
    expect(composerInvitationTargets(
      ['outside', 'active', 'outside', 'left', 'left'], members, profiles, true
    )).toEqual({ inviteAgentIds: ['outside', 'left'], unavailableAgentIds: [] })
  })

  it('drops a pending invitation when its last mention is deleted', () => {
    expect(composerInvitationTargets(['outside', 'outside'], members, profiles, true).inviteAgentIds)
      .toEqual(['outside'])
    expect(composerInvitationTargets(['outside'], members, profiles, true).inviteAgentIds)
      .toEqual(['outside'])
    expect(composerInvitationTargets([], members, profiles, true).inviteAgentIds)
      .toEqual([])
  })

  it('blocks unavailable identities and outsiders when invitations are disabled', () => {
    expect(composerInvitationTargets(
      ['away', 'unknown', 'outside'], members, profiles, true
    )).toEqual({ inviteAgentIds: ['outside'], unavailableAgentIds: ['away', 'unknown'] })
    expect(composerInvitationTargets(['outside'], members, profiles, false))
      .toEqual({ inviteAgentIds: [], unavailableAgentIds: ['outside'] })
  })

  it('away 队外资料仍不能因展示保留姓名而获得邀请资格', () => {
    expect(composerInvitationTargets(['outside'], members, profiles.map(profile =>
      profile.agentId === 'outside' ? { ...profile, presence: 'away' as const } : profile
    ), true)).toEqual({ inviteAgentIds: [], unavailableAgentIds: ['outside'] })
  })

  it.each(['ready', 'light_ready', 'installed_unverified'] as const)(
    'allows configured %s outsiders through the same candidate and send-time rule', (status) => {
      const profile = { ...profiles[1], runtimeReadiness: { status, blockers: [] } }
      expect(isThreadMemberInvitable(profile)).toBe(true)
      expect(composerInvitationTargets(['outside'], members, [profile], true))
        .toEqual({ inviteAgentIds: ['outside'], unavailableAgentIds: [] })
    }
  )

  it('blocks a stored outsider mention when its runtime is removed or becomes unavailable', () => {
    const unavailableProfiles = [
      { ...profiles[1], runtimeConfiguration: null },
      { ...profiles[1], runtimeReadiness: { status: 'runtime_not_configured' as const, blockers: [] } },
      { ...profiles[1], runtimeReadiness: { status: 'needs_attention' as const, blockers: [] } }
    ]
    for (const profile of unavailableProfiles) {
      expect(isThreadMemberInvitable(profile)).toBe(false)
      expect(composerInvitationTargets(['outside', 'outside'], members, [profile], true))
        .toEqual({ inviteAgentIds: [], unavailableAgentIds: ['outside'] })
    }
  })

  it('keeps existing present members addressable independently of runtime readiness', () => {
    const profile = { ...profiles[0], runtimeConfiguration: null,
      runtimeReadiness: { status: 'runtime_not_configured' as const, blockers: [] } }
    expect(composerInvitationTargets(['active'], members, [profile], true))
      .toEqual({ inviteAgentIds: [], unavailableAgentIds: [] })
  })

  it('recognizes a successful invitation on retry without inviting twice', () => {
    const afterInvite = [...members, {
      agentId: 'outside', membershipStatus: 'active' as const, profilePresence: 'present' as const
    }]
    expect(composerInvitationTargets(['outside'], afterInvite, profiles, true))
      .toEqual({ inviteAgentIds: [], unavailableAgentIds: [] })
  })
})

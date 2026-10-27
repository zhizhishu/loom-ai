import type { AgentProfile, ThreadMemberView } from '@contracts'
import { isNewConversationMemberAvailable } from './new-conversation-availability'

type Member = Pick<ThreadMemberView, 'agentId' | 'membershipStatus' | 'profilePresence'>
type Profile = Pick<AgentProfile, 'agentId' | 'presence' | 'runtimeConfiguration' | 'runtimeReadiness'>

/** Desktop invitation eligibility; existing membership keeps its own addressing rules. */
export function isThreadMemberInvitable(profile: Profile | undefined): boolean {
  return Boolean(profile && profile.presence === 'present' && isNewConversationMemberAvailable({
    runtimeConfigured: profile.runtimeConfiguration !== null,
    runtimeReadiness: profile.runtimeReadiness.status
  }))
}

export interface ComposerInvitationTargets {
  inviteAgentIds: string[]
  unavailableAgentIds: string[]
}

/** Member atoms stay in the draft; this projection only decides send-time work. */
export function composerInvitationTargets(
  mentionedAgentIds: readonly string[],
  members: readonly Member[],
  profiles: readonly Profile[],
  canInvite: boolean
): ComposerInvitationTargets {
  const memberById = new Map(members.map((member) => [member.agentId, member]))
  const profileById = new Map(profiles.map((profile) => [profile.agentId, profile]))
  const inviteAgentIds: string[] = []
  const unavailableAgentIds: string[] = []
  for (const agentId of new Set(mentionedAgentIds)) {
    const member = memberById.get(agentId)
    if (member?.membershipStatus === 'active') {
      if (member.profilePresence !== 'present') unavailableAgentIds.push(agentId)
    } else if (canInvite && isThreadMemberInvitable(profileById.get(agentId))) {
      inviteAgentIds.push(agentId)
    } else {
      unavailableAgentIds.push(agentId)
    }
  }
  return { inviteAgentIds, unavailableAgentIds }
}

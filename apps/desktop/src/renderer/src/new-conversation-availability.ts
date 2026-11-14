import type { ThreadCreationPreflight } from '@contracts'
import { uiAttribute } from './interface-language'
import { remoteExecutionPresentation } from './member-execution-availability'

type ConversationCandidate = Pick<
  ThreadCreationPreflight['presentMembers'][number],
  'runtimeConfigured' | 'runtimeReadiness' | 'executionAvailability'
>

export function isNewConversationMemberAvailable(member: ConversationCandidate): boolean {
  const execution = member.executionAvailability
  if (execution) {
    return execution.configured && execution.canLaunch
      && ['ready', 'light_ready', 'installed_unverified'].includes(execution.readiness.status)
  }
  return member.runtimeConfigured
    && (member.runtimeReadiness === 'ready' || member.runtimeReadiness === 'light_ready' || member.runtimeReadiness === 'installed_unverified')
}

export function newConversationMemberStatus(member: ConversationCandidate): string {
  const execution = member.executionAvailability
  if (execution?.location === 'remote') return remoteExecutionPresentation(execution)!.label
  if (!member.runtimeConfigured || member.runtimeReadiness === 'runtime_not_configured') {
    return uiAttribute('未配置智能体')
  }
  return isNewConversationMemberAvailable(member) ? uiAttribute('可用') : uiAttribute('智能体不可用')
}

import type { AgentProfile, HearthReviewItem, MemoryKind, MemoryRecord, MemoryScopeKind } from '@contracts'
import { MemberAvatar } from './MemberAvatar'
import { uiAttribute } from './interface-language'

export function MemoryAvatar({ memory, agents }: { memory: MemoryRecord; agents: AgentProfile[] }): React.JSX.Element {
  const people = memoryPeople(memory, agents)
  if (memory.scope === 'hearth' || people.length === 0) return <span className="memory-shared-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3" /><path d="M3 19v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v1" /></svg></span>
  return <span className={`memory-avatar-group${people.length > 1 ? ' is-pair' : ''}`} aria-hidden="true">{people.slice(0, 2).map(agent => <MemberAvatar key={agent.agentId} agentId={agent.agentId} avatarRef={agent.avatarRef} displayName={agent.displayName} size="mention" decorative />)}</span>
}

export function scopeLabel(scope: MemoryScopeKind | null): string {
  return scope === 'hearth' ?uiAttribute("共同记忆") : scope === 'companion' ?uiAttribute("队员记忆") : scope === 'relationship' ?uiAttribute("队员间记忆") :uiAttribute("已遗忘")
}

export function kindLabel(kind: MemoryKind | null): string {
  return kind === 'preference' ?uiAttribute("偏好") : kind === 'agreement' ?uiAttribute("约定") : kind === 'lesson' ?uiAttribute("经验") : '—'
}

export function originLabel(origin: MemoryRecord['creationOrigin']): string {
  return origin === 'agent' ?uiAttribute("队员形成") : origin === 'accepted_hearth_review' ?uiAttribute("队员提交 · 用户采纳") : origin === 'user' ?uiAttribute("用户创建") : '—'
}

export function reviewStatusLabel(status: HearthReviewItem['status']): string {
  return status === 'accepted' ?uiAttribute("已接受") : status === 'rejected' ?uiAttribute("已拒绝") : status === 'invalidated' ?uiAttribute("已失效") :uiAttribute("待审核")
}

export function reviewResolutionLabel(reviewItem: HearthReviewItem): string {
  if (reviewItem.status === 'accepted') return uiAttribute("已由用户接受")
  if (reviewItem.status === 'rejected') return uiAttribute("已由用户拒绝")
  if (reviewItem.invalidationReason === 'target_forgotten') return uiAttribute("目标记忆已永久遗忘，审核项自动失效")
  if (reviewItem.invalidationReason === 'exact_candidate_published') return uiAttribute("同一候选已经成为正式记忆，审核项自动失效")
  return uiAttribute("审核项已失效")
}

export function memoryPeople(memory: MemoryRecord, agents: AgentProfile[]): AgentProfile[] {
  const ids = memory.scope === 'companion'
    ? [memory.companionAgentId]
    : memory.scope === 'relationship' ? memory.relationshipAgentIds : []
  return ids.flatMap((id) => {
    const agent = agents.find((candidate) => candidate.agentId === id)
    return agent ? [agent] : []
  })
}

export function memoryPeopleLabel(memory: MemoryRecord, agents: AgentProfile[]): string {
  const people = memoryPeople(memory, agents)
  if (memory.scope === 'hearth') return uiAttribute('所有队员')
  if (memory.direction === 'directed') return directionLabel(memory, agents)
  return people.length > 0 ? people.map((agent) => agent.displayName).join(' × ') : scopeLabel(memory.scope)
}

export function directionLabel(memory: MemoryRecord, agents: AgentProfile[]): string {
  if (memory.direction === 'mutual') return uiAttribute("双方共同")
  if (memory.direction === 'directed') {
    const actor = agentName(memory.directedActorAgentId, agents)
    const counterparty = agentName(memory.relationshipAgentIds.find((id) => id !== memory.directedActorAgentId), agents)
    return `${actor} → ${counterparty}`
  }
  return ''
}

export function agentName(id: string | null | undefined, agents: AgentProfile[]): string {
  if (!id) return uiAttribute("未知队员")
  return agents.find((agent) => agent.agentId === id)?.displayName ?? shortId(id)
}

export function shortId(value: string | null | undefined): string {
  if (!value) return '—'
  return value.length > 10 ? `${value.slice(0, 8)}…` : value
}

export function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
}

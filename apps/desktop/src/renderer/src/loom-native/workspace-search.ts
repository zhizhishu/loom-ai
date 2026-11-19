import { loomLatestCandidate } from '@contracts'
import type { AgentProfile, ArtifactSelection, ConversationItem, WorkBundle, WorkItem } from './types'

export type WorkspaceSearchResults = {
  conversations: ConversationItem[]
  assistants: AgentProfile[]
  work: WorkItem[]
  artifacts: ArtifactSelection[]
  total: number
}
const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().trim()
function unique<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter(item => { const id = key(item); if (seen.has(id)) return false; seen.add(id); return true })
}

/** Search only the current Host's read projections; opening a result never starts work. */
export function searchWorkspace(
  query: string, conversations: readonly ConversationItem[], agents: readonly AgentProfile[],
  bundles: readonly WorkBundle[], limit = 8
): WorkspaceSearchResults {
  const terms = normalize(query).split(/\s+/).filter(Boolean)
  const matches = (...values: (string | null | undefined)[]): boolean => {
    const text = normalize(values.filter(Boolean).join(' '))
    return terms.every(term => text.includes(term))
  }
  const foundConversations = unique(conversations.filter(item =>
    item.threadId !== null && matches(item.title, item.subtitle)), item => item.id)
  const assistants = unique(agents.filter(agent =>
    !agent.removedAt && agent.presence !== 'removed' && matches(agent.displayName)), agent => agent.agentId)
  const work = unique(bundles.flatMap(bundle => bundle.tasks.filter(task =>
    matches(task.title, task.description, bundle.mission.title)).map(task => ({
      task, mission: bundle.mission, candidate: loomLatestCandidate(task.taskId, bundle.candidates)
    }))), item => item.task.taskId)
  const artifacts = unique(bundles.flatMap(bundle => bundle.artifacts.filter(artifact =>
    matches(artifact.relativePath, bundle.mission.title)).map(artifact => ({
      artifact, bundle,
      candidate: bundle.candidates.find(candidate => candidate.evidenceIds.includes(artifact.artifactId)) ?? null
    }))), item => item.artifact.artifactId)
  const count = Math.max(1, Math.floor(limit))
  return {
    conversations: foundConversations.slice(0, count), assistants: assistants.slice(0, count),
    work: work.slice(0, count), artifacts: artifacts.slice(0, count),
    total: foundConversations.length + assistants.length + work.length + artifacts.length
  }
}

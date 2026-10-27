import type { AgentRunView, AgentRunExecutionEvidenceView } from '@contracts'
import { liveRuntimeEventFromExecutionEvidence, type LiveRuntimeEvent } from './ui-model'

export function groupExecutionEventsByRunId(
  runs: readonly Pick<AgentRunView, 'id'>[],
  executionEvidence: readonly AgentRunExecutionEvidenceView[],
  liveRuntimeEvents: readonly LiveRuntimeEvent[]
): Map<string, LiveRuntimeEvent[]> {
  const currentRunIds = new Set(runs.map((run) => run.id))
  const grouped = new Map<string, Map<string, LiveRuntimeEvent>>()
  const blockState = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}

  const append = (event: LiveRuntimeEvent, authoritative: boolean): void => {
    if (!currentRunIds.has(event.agentRunId)) return

    let eventsById = grouped.get(event.agentRunId)
    if (!eventsById) {
      eventsById = new Map<string, LiveRuntimeEvent>()
      grouped.set(event.agentRunId, eventsById)
    }

    const previous = eventsById.get(event.id)
    const previousRevision = previous?.revision ?? 0
    const incomingRevision = event.revision ?? 0
    const previousChange = previous?.changeSequence ?? 0
    const incomingChange = event.changeSequence ?? 0
    const newer = Boolean(previous) && (incomingRevision > previousRevision
      || (incomingRevision === previousRevision && incomingChange > previousChange))
    const older = Boolean(previous) && (incomingRevision < previousRevision
      || (incomingRevision === previousRevision && incomingChange < previousChange))
    const blockUpdate = event.eventType === 'agent.text.block' && previous
      && (blockState(previous.payload).status === 'streaming')
      && (blockState(event.payload).status !== 'streaming'
        || Number(blockState(event.payload).textLength) >= Number(blockState(previous.payload).textLength))
    if (!previous || newer || (!older && blockUpdate) || (authoritative && !older)) {
      eventsById.set(event.id, event)
    }
  }

  for (const evidence of executionEvidence) {
    append(liveRuntimeEventFromExecutionEvidence(evidence), true)
  }
  for (const event of liveRuntimeEvents) {
    append(event, false)
  }

  return new Map([...grouped.entries()].map(([runId, eventsById]) => {
    const events = [...eventsById.values()]
    events.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    return [runId, events]
  }))
}

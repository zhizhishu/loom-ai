import type { AgentProfile } from '@contracts'
import type { SettingsSectionId } from './settings-sections'

export const SETUP_CHECKLIST_ITEMS = ['assistant', 'runtime', 'workspace'] as const
export type SetupChecklistItem = (typeof SETUP_CHECKLIST_ITEMS)[number]
export type SetupChecklistItemState = 'done' | 'todo'

export interface SetupChecklistInput {
  agents: ReadonlyArray<Pick<AgentProfile, 'removedAt' | 'presence' | 'runtimeConfiguration' | 'runtimeReadiness'>>
  hasWorkspaceDefault: boolean
}

export const SETUP_ITEM_ACTIONS: Partial<Record<SetupChecklistItem, SettingsSectionId>> = {
  runtime: 'runtime',
  workspace: 'workspace'
}

export const SETUP_CHECKLIST_DISMISSED_KEY = 'loom.setup.checklist.dismissed.v1'

function agentPresent(agent: SetupChecklistInput['agents'][number]): boolean {
  return agent.removedAt === null && agent.presence !== 'removed'
}

function agentCanLaunch(agent: SetupChecklistInput['agents'][number]): boolean {
  return agentPresent(agent) && agent.runtimeConfiguration !== null && agent.runtimeReadiness.status === 'ready'
}

export function setupChecklistItemState(item: SetupChecklistItem, input: SetupChecklistInput): SetupChecklistItemState {
  const present = input.agents.filter(agentPresent)
  switch (item) {
    case 'assistant': return present.length > 0 ? 'done' : 'todo'
    case 'runtime': return input.agents.some(agentCanLaunch) ? 'done' : 'todo'
    case 'workspace': return input.hasWorkspaceDefault ? 'done' : 'todo'
  }
}

export function setupChecklistStates(input: SetupChecklistInput): Record<SetupChecklistItem, SetupChecklistItemState> {
  return Object.fromEntries(SETUP_CHECKLIST_ITEMS.map(item => [item, setupChecklistItemState(item, input)])) as Record<SetupChecklistItem, SetupChecklistItemState>
}

export function setupChecklistRemaining(input: SetupChecklistInput): number {
  return SETUP_CHECKLIST_ITEMS.filter(item => setupChecklistItemState(item, input) === 'todo').length
}

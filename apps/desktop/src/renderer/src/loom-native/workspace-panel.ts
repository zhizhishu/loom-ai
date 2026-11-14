import type { InspectorMode, InspectorTab, WorkBundle } from './types'

export const WORKSPACE_PANELS = ['work', 'assets', 'flow', 'computer'] as const
export type WorkspacePanel = typeof WORKSPACE_PANELS[number]
export type WorkspaceScope = 'conversation' | 'all'

/** A UI route, never a second task store. Computer grants are deliberately absent. */
export type PanelRoute = {
  panel: WorkspacePanel
  threadId: string | null
  scope: WorkspaceScope
  selectedTaskId: string | null
  selectedArtifactId: string | null
}
export function panelFor(mode: InspectorMode, tab?: InspectorTab): WorkspacePanel {
  if (mode === 'map') return 'flow'
  if (mode === 'assets') return 'assets'
  if (mode === 'computer' || mode === 'profile' && tab === 'computer') return 'computer'
  if (mode === 'profile' && tab === 'assets') return 'assets'
  return 'work'
}
export function modeFor(panel: WorkspacePanel): InspectorMode {
  return panel === 'flow' ? 'map' : panel
}
export function scopedBundles(bundles: readonly WorkBundle[], threadId: string | null | undefined, scope: WorkspaceScope): WorkBundle[] {
  return scope === 'conversation' && threadId ? bundles.filter(item => item.mission.threadId === threadId) : [...bundles]
}
export function readPanelPreference(value: string | null): WorkspacePanel {
  return WORKSPACE_PANELS.includes(value as WorkspacePanel) ? value as WorkspacePanel : 'work'
}
export function movePanel(route: PanelRoute, panel: WorkspacePanel): PanelRoute {
  return { ...route, panel }
}
export function moveConversation(route: PanelRoute, threadId: string | null): PanelRoute {
  return threadId === route.threadId ? route : { ...route, threadId, selectedTaskId: null, selectedArtifactId: null }
}

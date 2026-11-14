/** User-owned split sizes. Never reduce the conversation below a readable width. */
export const MIN_CONVERSATION_WIDTH = 320
export const MIN_SIDEBAR_WIDTH = 190
export const MAX_SIDEBAR_WIDTH = 510
export const MIN_INSPECTOR_WIDTH = 245
export const MAX_INSPECTOR_WIDTH = 720
export type PanelSide = 'sidebar' | 'inspector'
export type PanelWidths = { sidebar: number; inspector: number }
export function clampPanelWidth(side: PanelSide, wanted: number, frameWidth: number,
  widths: PanelWidths, sidebarOpen: boolean, inspectorOpen: boolean): number {
  const other = side === 'sidebar' ? (inspectorOpen ? widths.inspector + 8 : 0)
    : (sidebarOpen ? widths.sidebar + 8 : 0)
  const min = side === 'sidebar' ? MIN_SIDEBAR_WIDTH : MIN_INSPECTOR_WIDTH
  const max = side === 'sidebar' ? MAX_SIDEBAR_WIDTH : MAX_INSPECTOR_WIDTH
  // When two panels and the conversation cannot all fit, keep the current
  // live widths rather than crossing over and making a zero-width composer.
  return Math.min(max, Math.max(min, Math.min(wanted, frameWidth - MIN_CONVERSATION_WIDTH - other - 8)))
}
export function storedPanelWidth(value: string | null, fallback: number, side: PanelSide): number {
  const numeric = value === null ? NaN : Number(value)
  const min = side === 'sidebar' ? MIN_SIDEBAR_WIDTH : MIN_INSPECTOR_WIDTH
  const max = side === 'sidebar' ? MAX_SIDEBAR_WIDTH : MAX_INSPECTOR_WIDTH
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback
}

/** Reflow at virtual-monitor/RDP/window size changes without overwriting the
 * user's larger saved preference. Two dividers consume 8px each. */
export function fittedPanelWidths(
  frameWidth: number, preferred: PanelWidths, sidebarOpen: boolean, inspectorOpen: boolean
): PanelWidths {
  let sidebar = sidebarOpen ? Math.min(MAX_SIDEBAR_WIDTH,Math.max(MIN_SIDEBAR_WIDTH,preferred.sidebar)) : 0
  let inspector = inspectorOpen ? Math.min(MAX_INSPECTOR_WIDTH,Math.max(MIN_INSPECTOR_WIDTH,preferred.inspector)) : 0
  let spare = Math.max(0,frameWidth - MIN_CONVERSATION_WIDTH - (sidebarOpen?8:0) - (inspectorOpen?8:0))
  if (sidebarOpen && inspectorOpen) {
    // Keep the conversation readable and let the wide work pane surrender first.
    const takeInspector = Math.min(Math.max(0,inspector-MIN_INSPECTOR_WIDTH),Math.max(0,sidebar+inspector-spare))
    inspector -= takeInspector
    spare -= inspector
    sidebar = Math.max(MIN_SIDEBAR_WIDTH,Math.min(sidebar,spare))
  } else if (sidebarOpen) {
    sidebar = Math.max(MIN_SIDEBAR_WIDTH,Math.min(sidebar,spare))
  } else if (inspectorOpen) {
    inspector = Math.max(MIN_INSPECTOR_WIDTH,Math.min(inspector,spare))
  }
  return {sidebar,inspector}
}

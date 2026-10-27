import { shouldHandlePrimaryShortcut } from './renderer-platform'

export function navigationShortcut(platform: NodeJS.Platform, event: KeyboardEvent): 'back' | 'forward' | null {
  if (event.defaultPrevented || event.shiftKey || event.isComposing) return null
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .cm-editor, .xterm')) return null
  if (shouldHandlePrimaryShortcut(platform, event, '[')) return 'back'
  if (shouldHandlePrimaryShortcut(platform, event, ']')) return 'forward'
  return null
}

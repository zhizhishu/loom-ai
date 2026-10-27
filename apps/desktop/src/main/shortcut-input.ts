import { shortcutAvailable } from '../shared/shortcuts'
import type { BrowserWindow } from 'electron'
import type { ShortcutPreferences } from '@contracts'

/** No OS registrations. Unbound side buttons are neither consumed nor forwarded. */
export function installShortcutInput(window: BrowserWindow, platform: NodeJS.Platform, preferences: () => ShortcutPreferences) {
  let recording = false
  let tasksEnabled = false
  const setRecording = (next: boolean): void => {
    recording = next
    if (!window.webContents.isDestroyed()) window.webContents.setIgnoreMenuShortcuts(next)
  }
  const stop = (): void => setRecording(false)
  window.on('blur', stop)
  window.webContents.on('did-start-navigation', () => { tasksEnabled = false; stop() })
  window.webContents.on('render-process-gone', () => { tasksEnabled = false; stop() })
  if (platform === 'win32') window.on('app-command', (event, command) => {
    const side = command === 'browser-backward' ? 'side1' : command === 'browser-forward' ? 'side2' : null
    if (!side || (!recording && !shortcutAvailable(preferences().mouse[side], tasksEnabled))) return
    event.preventDefault()
    window.webContents.send('rovai:shortcut-mouse', side)
  })
  return { setTasksEnabled: (enabled: boolean): void => { tasksEnabled = enabled }, setRecording, isRecording: () => recording }
}

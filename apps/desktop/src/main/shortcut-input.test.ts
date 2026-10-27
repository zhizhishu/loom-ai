import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { expect, it, vi } from 'vitest'
import { installShortcutInput } from './shortcut-input'
import { shortcutDefaults } from '../shared/shortcuts'
function fixture(platform: NodeJS.Platform = 'win32') {
  const webContents = Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false, setIgnoreMenuShortcuts: vi.fn() })
  const window = Object.assign(new EventEmitter(), { webContents })
  const preferences = shortcutDefaults()
  const input = installShortcutInput(window as unknown as BrowserWindow, platform, () => preferences)
  const event = { preventDefault: vi.fn() }
  return { window, webContents, preferences, input, event }
}
it('leaves both Windows side buttons unbound until explicitly assigned and forwards each app-command once', () => {
  const { window, webContents, preferences, event } = fixture()
  window.emit('app-command', event, 'browser-backward'); window.emit('app-command', event, 'browser-forward')
  expect(webContents.send).not.toHaveBeenCalled(); expect(event.preventDefault).not.toHaveBeenCalled()
  preferences.mouse.side1 = 'preview'
  window.emit('app-command', event, 'browser-backward'); window.emit('app-command', event, 'browser-forward'); window.emit('app-command', event, 'volume-up')
  expect(webContents.send.mock.calls).toEqual([['rovai:shortcut-mouse', 'side1']])
  expect(event.preventDefault).toHaveBeenCalledTimes(1)
})
it('captures unbound side buttons only while recording and releases native menu suppression on blur / navigation / renderer loss', () => {
  const { window, webContents, input, event } = fixture()
  input.setRecording(true); window.emit('app-command', event, 'browser-forward')
  expect(webContents.send).toHaveBeenCalledWith('rovai:shortcut-mouse', 'side2')
  for (const [emitter, name] of [[window, 'blur'], [webContents, 'did-start-navigation'], [webContents, 'render-process-gone']] as const) {
    input.setRecording(true); emitter.emit(name); expect(input.isRecording()).toBe(false)
    expect(webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
  }
})
it('does not create a duplicate macOS app-command path', () => {
  expect(fixture('darwin').window.listenerCount('app-command')).toBe(0)
})

it('does not consume Task side buttons while unavailable and clears Host capability on navigation or renderer loss', () => {
  const { window, webContents, preferences, input, event } = fixture()
  preferences.mouse.side1 = 'tasks'
  window.emit('app-command', event, 'browser-backward')
  expect(event.preventDefault).not.toHaveBeenCalled()
  input.setTasksEnabled(true); window.emit('app-command', event, 'browser-backward')
  expect(event.preventDefault).toHaveBeenCalledTimes(1)
  input.setTasksEnabled(false); window.emit('app-command', event, 'browser-backward')
  expect(event.preventDefault).toHaveBeenCalledTimes(1)
  for (const name of ['did-start-navigation', 'render-process-gone']) {
    input.setTasksEnabled(true); webContents.emit(name)
    window.emit('app-command', event, 'browser-backward')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  }
  expect(preferences.mouse.side1).toBe('tasks')
})

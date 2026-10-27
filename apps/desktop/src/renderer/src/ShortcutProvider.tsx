import { useTaskCapability } from './TaskCapabilityProvider'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ShortcutActionId, ShortcutMouseSide, ShortcutPreferences, ShortcutPreferencesApi, ShortcutPreferencesSnapshot } from '@contracts'
import { normalizeShortcut, shortcutAvailable, SHORTCUTS, shortcutDefaults, shortcutKeyParts, shortcutMouseSide } from '../../shared/shortcuts'
import { uiAttribute } from './interface-language'

type Handler = { priority: number; run(target: EventTarget | null): boolean | void }
interface ShortcutContextValue {
  platform: NodeJS.Platform
  snapshot: ShortcutPreferencesSnapshot | null
  error: string | null
  reload(): Promise<void>
  save(preferences: ShortcutPreferences): Promise<void>
  record(listener: ((side: ShortcutMouseSide) => void) | null): Promise<void>
  register(id: ShortcutActionId, handler: Handler): () => void
  dispatch(id: ShortcutActionId, target: EventTarget | null): boolean
}
const Context = createContext<ShortcutContextValue | null>(null)
export function useShortcuts(): ShortcutContextValue | null { return useContext(Context) }
export function useComposerSendShortcut(): { label: string; aria: string } | null {
  const context = useShortcuts()
  if (!context) return null
  if (context.snapshot?.preferences.sendMode !== 'primary-enter') return { label: 'Enter', aria: 'Enter' }
  return context.platform === 'darwin' ? { label: '⌘ + Enter', aria: 'Meta+Enter' } : { label: 'Ctrl + Enter', aria: 'Control+Enter' }
}
const defaults = shortcutDefaults()
export function useShortcutLabel(id: ShortcutActionId, fallbackPlatform: NodeJS.Platform = 'darwin'): string {
  const context = useShortcuts()
  return shortcutKeyParts((context?.snapshot?.preferences ?? defaults).bindings[id], context?.platform ?? fallbackPlatform).join((context?.platform ?? fallbackPlatform) === 'darwin' ? '' : '+')
}
export function useShortcutAction(id: ShortcutActionId, run: Handler['run'], enabled = true, priority = 0): void {
  const context = useShortcuts()
  const latest = useRef({ run, enabled })
  latest.current = { run, enabled }
  const register = context?.register
  useEffect(() => register?.(id, { priority, run: target => latest.current.enabled ? latest.current.run(target) : false }), [register, id, priority])
}
export function ShortcutProvider({ api, platform, children }: { api?: ShortcutPreferencesApi; platform: NodeJS.Platform; children: ReactNode }): React.JSX.Element {
  const { enabled: tasksEnabled } = useTaskCapability()
  const tasks = useRef(tasksEnabled)
  tasks.current = tasksEnabled
  useEffect(() => { void api?.setTasksEnabled?.(tasksEnabled).catch(() => undefined); return () => { void api?.setTasksEnabled?.(false).catch(() => undefined) } }, [api, tasksEnabled])
  const [snapshot, setSnapshot] = useState<ShortcutPreferencesSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = useRef(snapshot)
  current.current = snapshot
  const handlers = useRef(new Map<ShortcutActionId, Set<Handler>>())
  const recording = useRef<((side: ShortcutMouseSide) => void) | null>(null)
  const lastTarget = useRef<EventTarget | null>(null)
  const accept = useCallback((next: ShortcutPreferencesSnapshot) => {
    setSnapshot(old => old && old.revision > next.revision ? old : next)
    setError(next.migrationPending ? uiAttribute('快捷键更新未保存，请重试。') : null)
  }, [])
  const reload = useCallback(async () => {
    if (!api) return
    try { const pending = current.current; accept(pending?.migrationPending ? await api.save({ expectedRevision: pending.revision, preferences: pending.preferences }) : await api.get()) } catch { setError(uiAttribute('无法读取快捷键设置，请重试。')) }
  }, [api, accept])
  useEffect(() => {
    if (!api) return
    let mounted = true
    const unsubscribe = api.onChanged(next => { if (mounted) accept(next) })
    void api.get().then(next => { if (mounted) accept(next) }).catch(() => { if (mounted) setError(uiAttribute('无法读取快捷键设置，请重试。')) })
    return () => { mounted = false; unsubscribe() }
  }, [api, accept])
  const save = useCallback(async (preferences: ShortcutPreferences) => {
    if (!api || !current.current) throw new Error(uiAttribute('快捷键设置尚未加载。'))
    try { accept(await api.save({ expectedRevision: current.current.revision, preferences })) }
    catch (error) {
      try { accept(await api.get()) } catch { /* Keep the current working bindings. */ }
      throw new Error(uiAttribute(error instanceof Error && error.message.includes('快捷键设置已在其他窗口更新')
        ? '快捷键设置已在其他窗口更新，请确认后重试保存。' : '无法保存快捷键设置，请重试。'))
    }
  }, [api, accept, reload])
  const record = useCallback(async (listener: ((side: ShortcutMouseSide) => void) | null) => {
    recording.current = listener
    try { await api?.setRecording(listener !== null) }
    catch (error) { if (recording.current === listener) recording.current = null; throw error }
  }, [api])
  const register = useCallback((id: ShortcutActionId, handler: Handler) => {
    const entries = handlers.current.get(id) ?? new Set<Handler>()
    handlers.current.set(id, entries); entries.add(handler)
    return () => { entries.delete(handler) }
  }, [])
  const dispatch = useCallback((id: ShortcutActionId, target: EventTarget | null): boolean => {
    if (!shortcutAvailable(id, tasks.current) || recording.current || !current.current || document.querySelector('.app-dialog, [role="dialog"][aria-modal="true"], [role="menu"]:not([hidden]), .startup-loading-canvas, .shutdown-scrim')) return false
    const element = target instanceof Element ? target : null
    if (element?.closest('.xterm, [inert]')) return false
    if (!SHORTCUTS.find(row => row.id === id)?.editable && element?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .cm-editor')) return false
    for (const handler of [...(handlers.current.get(id) ?? [])].sort((a, b) => b.priority - a.priority)) if (handler.run(target) !== false) return true
    return false
  }, [])
  useEffect(() => {
    if (!api) return
    const readingTarget = (target: EventTarget | null): EventTarget | null => {
      if (target !== document.body) return target
      const cached = lastTarget.current
      if (cached instanceof Element && cached.isConnected && !cached.closest('[hidden], [inert]')
        && cached.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return cached
      lastTarget.current = null
      return target
    }
    const keyboard = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || recording.current || event.isComposing || event.keyCode === 229 || event.repeat || !current.current) return
      const binding = normalizeShortcut(event, platform)
      if (!binding) return
      const action = SHORTCUTS.find(row => current.current?.preferences.bindings[row.id] === binding)
      if (action && dispatch(action.id, readingTarget(event.target))) { event.preventDefault(); event.stopPropagation() }
    }
    const nativeSide = (side: ShortcutMouseSide): void => {
      if (recording.current) { recording.current(side); return }
      const action = current.current?.preferences.mouse[side]
      if (action) dispatch(action, readingTarget(document.activeElement))
    }
    const pointer = (event: MouseEvent): void => {
      const side = shortcutMouseSide(event.button)
      if (!side) { lastTarget.current = event.target; return }
      // Windows uses the native app-command path once; the DOM is not a second trigger.
      if (platform === 'win32') return
      if (recording.current) { event.preventDefault(); event.stopImmediatePropagation(); recording.current(side); return }
      const action = current.current?.preferences.mouse[side]
      if (action && dispatch(action, event.target)) { event.preventDefault(); event.stopImmediatePropagation() }
    }
    const finishMouse = (event: MouseEvent): void => {
      const side = shortcutMouseSide(event.button)
      if (side && (recording.current || shortcutAvailable(current.current?.preferences.mouse[side], tasks.current))) event.preventDefault()
    }
    const blur = (): void => { recording.current = null; void api.setRecording(false).catch(() => undefined) }
    const unsubscribe = api.onMouseSide(nativeSide)
    window.addEventListener('keydown', keyboard, true)
    window.addEventListener('mousedown', pointer, true)
    window.addEventListener('mouseup', finishMouse, true)
    window.addEventListener('auxclick', finishMouse, true)
    window.addEventListener('blur', blur)
    return () => {
      unsubscribe(); blur()
      window.removeEventListener('keydown', keyboard, true)
      window.removeEventListener('mousedown', pointer, true)
      window.removeEventListener('mouseup', finishMouse, true)
      window.removeEventListener('auxclick', finishMouse, true)
      window.removeEventListener('blur', blur)
    }
  }, [api, platform, dispatch])
  const value = useMemo(() => ({ platform, snapshot, error, reload, save, record, register, dispatch }), [platform, snapshot, error, reload, save, record, register, dispatch])
  return <Context.Provider value={api ? value : null}>{children}</Context.Provider>
}

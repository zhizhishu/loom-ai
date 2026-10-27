import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { TaskCapabilitySnapshot } from '@contracts'
import type { ThreadClient } from './camp-client'

interface TaskCapability extends TaskCapabilitySnapshot {
  ready: boolean
  saving: boolean
  error: 'read' | 'save' | null
  setEnabled(enabled: boolean): Promise<void>
  retry(): Promise<void>
  acceptSnapshot(snapshot: TaskCapabilitySnapshot): TaskCapabilitySnapshot | null
}
const initialSnapshot: TaskCapabilitySnapshot = { enabled: false, headsUpAfterSequence: 0, observedThroughChangeSequence: 0 }
const unavailable: TaskCapability = { ...initialSnapshot, ready: false, saving: false, error: null, setEnabled: async () => {}, retry: async () => {}, acceptSnapshot: () => null }
const Context = createContext<TaskCapability>(unavailable)
export const useTaskCapability = (): TaskCapability => useContext(Context)

export function validTaskCapability(next: TaskCapabilitySnapshot): boolean {
  return typeof next?.enabled === 'boolean'
    && Number.isSafeInteger(next.headsUpAfterSequence) && next.headsUpAfterSequence >= 0
    && Number.isSafeInteger(next.observedThroughChangeSequence)
    && next.observedThroughChangeSequence >= next.headsUpAfterSequence
}

/** One Host projection shared by settings and notification responses. The Core
 * clock orders snapshots; a failed read is not a confirmed disable. */
export function TaskCapabilityProvider({ client, children }: { client: ThreadClient; children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState({ client, ...initialSnapshot, ready: false, saving: false, error: null as TaskCapability['error'] })
  const current = useRef(client)
  // A return to a cached client is still a new Host visit.
  const clientGeneration = useRef(0)
  const version = useRef(0)
  const latest = useRef<TaskCapabilitySnapshot | null>(null)
  const pendingSave = useRef<boolean | null>(null)
  const saving = useRef(false)
  if (current.current !== client) {
    current.current = client
    clientGeneration.current++
    version.current++
    latest.current = null
    pendingSave.current = null
    saving.current = false
  }
  const generation = clientGeneration.current
  const acceptSnapshot = useCallback((next: TaskCapabilitySnapshot): TaskCapabilitySnapshot | null => {
    if (!validTaskCapability(next)) throw new Error('Invalid Task capability')
    if (current.current !== client || generation !== clientGeneration.current) return null
    if (latest.current && next.observedThroughChangeSequence < latest.current.observedThroughChangeSequence) return latest.current
    latest.current = next
    version.current++ // A later failure cannot erase this authoritative snapshot.
    setState(old => old.client === client && old.ready
      && old.enabled === next.enabled && old.headsUpAfterSequence === next.headsUpAfterSequence
      && old.observedThroughChangeSequence === next.observedThroughChangeSequence && old.error !== 'read'
      ? old : { ...old, client, ...next, ready: true, error: old.error === 'save' ? 'save' : null })
    return next
  }, [client, generation])
  const reload = useCallback(async () => {
    const request = ++version.current
    try {
      acceptSnapshot(await client.request<TaskCapabilitySnapshot>('preferences.tasks.get', {}))
    } catch {
      if (current.current === client && generation === clientGeneration.current && request === version.current) {
        setState(old => ({ ...old, error: old.error === 'save' ? 'save' : 'read' }))
      }
    }
  }, [client, generation, acceptSnapshot])
  useEffect(() => {
    setState({ client, ...initialSnapshot, ready: false, saving: false, error: null })
    void reload()
    const event = client.onEvent?.(value => { if (value.method === 'preferences.tasks_changed') void reload() })
    const invalidation = client.onInvalidated?.(change => {
      if (!change || change.resync || change.tasksChanged) void reload()
    })
    const focus = (): void => { void reload() }
    window.addEventListener('focus', focus)
    return () => { version.current++; event?.(); invalidation?.(); window.removeEventListener('focus', focus) }
  }, [client, reload])
  const setEnabled = useCallback(async (enabled: boolean) => {
    if (saving.current) return
    saving.current = true
    pendingSave.current = enabled
    version.current++
    setState(old => ({ ...old, client, saving: true, error: null }))
    try {
      const next = await client.request<TaskCapabilitySnapshot>('preferences.tasks.set', { enabled })
      if (!acceptSnapshot(next)) return
      pendingSave.current = null
      setState(old => ({ ...old, error: null }))
      void reload()
    } catch {
      if (current.current === client && generation === clientGeneration.current) setState(old => ({ ...old, error: 'save' }))
    } finally {
      if (current.current === client && generation === clientGeneration.current) { saving.current = false; setState(old => ({ ...old, saving: false })) }
    }
  }, [client, generation, reload, acceptSnapshot])
  const value = state.client === client ? state : { ...unavailable, client }
  return <Context.Provider value={{ ...value, setEnabled, acceptSnapshot, retry: () => pendingSave.current === null ? reload() : setEnabled(pendingSave.current) }}>{children}</Context.Provider>
}

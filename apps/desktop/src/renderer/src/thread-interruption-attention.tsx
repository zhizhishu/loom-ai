import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { NotificationEpisodeChange, NotificationThreadInterruptions, StoredCommandResult } from '@contracts'
import { useThreadClient } from './camp-client'
import { newCommandId } from '../../shared/command-id'
import { uiAttribute } from './interface-language'

const THREAD_BATCH_SIZE = 200
type Snapshot = { unread: boolean; sequence: number; generation: number }
export type InterruptionReadIntent = { commandId: string; command: { threadId: string; observedThroughChangeSequence: number } }
type Surface = { threadId: string | null; visible: boolean }
const attentive = (): boolean => document.visibilityState === 'visible' && document.hasFocus()

/** Execution interruption reminders share the existing notification Disposition. Ordinary
 * execution updates and local stop controls have no input into this module. */
export function useThreadInterruptionAttention(enabled: boolean, threadIds: string[], surface: Surface) {
  const client = useThreadClient()
  const idsKey = JSON.stringify([...new Set(threadIds)].sort())
  const scope = useRef({ enabled, ids: threadIds, generation: 0 })
  const mounted = useRef(true)
  const floor = useRef(new Map<string, number>())
  const snapshotsRef = useRef<Record<string, Snapshot>>({})
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({})
  const [focused, setFocused] = useState(attentive)
  const viewed = useRef<string | null>(null)
  const pendingReads = useRef(new Map<string, InterruptionReadIntent>())
  const inFlightReads = useRef(new Set<string>())

  const refresh = useCallback(async (ids = scope.current.ids): Promise<void> => {
    if (!scope.current.enabled) return
    const generation = scope.current.generation
    const requested = [...new Set(ids)].filter(id => scope.current.ids.includes(id))
    const batches: Promise<void>[] = []
    for (let at = 0; at < requested.length; at += THREAD_BATCH_SIZE) {
      const threadIds = requested.slice(at, at + THREAD_BATCH_SIZE)
      batches.push(client.request<NotificationThreadInterruptions>('notifications.threadInterruptions', { threadIds })
        .then(result => {
          if (!mounted.current || generation !== scope.current.generation) return
          const next = { ...snapshotsRef.current }
          for (const thread of result.threads) {
            if (!threadIds.includes(thread.threadId)) continue
            if (result.throughChangeSequence < Math.max(floor.current.get(thread.threadId) ?? 0, next[thread.threadId]?.sequence ?? 0)) continue
            next[thread.threadId] = { unread: thread.hasUnreadInterruption, sequence: result.throughChangeSequence, generation }
          }
          if (Object.entries(next).some(([id, value]) => value.unread !== snapshotsRef.current[id]?.unread
            || value.sequence !== snapshotsRef.current[id]?.sequence || value.generation !== snapshotsRef.current[id]?.generation)) {
            snapshotsRef.current = next
            setSnapshots(next)
          }
        }).catch(() => {
          // Failed batches retain their last proven state; successful batches
          // apply immediately. Existing notification recovery retries reads.
        }))
    }
    await Promise.all(batches)
  }, [client])

  const acknowledge = useCallback(async (intent: InterruptionReadIntent): Promise<void> => {
    if (inFlightReads.current.has(intent.commandId)) return
    pendingReads.current.set(intent.commandId, intent)
    inFlightReads.current.add(intent.commandId)
    try {
      const result = await client.request<StoredCommandResult>('notifications.acknowledgeThreadInterruptions', intent)
      if (result.status !== 'applied') {
        pendingReads.current.delete(intent.commandId)
        throw new Error(uiAttribute('执行中断提醒未能标记已读，请重试。'))
      }
      pendingReads.current.delete(intent.commandId)
      const sequence = (result.payload as { resultingChangeSequence?: number })?.resultingChangeSequence
      if (typeof sequence === 'number') floor.current.set(intent.command.threadId, Math.max(floor.current.get(intent.command.threadId) ?? 0, sequence))
      await refresh([intent.command.threadId])
    } catch (error) {
      if (pendingReads.current.has(intent.commandId)) throw new Error(uiAttribute('执行中断提醒的已读结果尚未确认，将继续核对。'))
      throw error
    } finally { inFlightReads.current.delete(intent.commandId) }
  }, [client, refresh])

  const recover = useCallback((): void => {
    void refresh()
    // Retry only the frozen Core acknowledgement, never local reminder writes.
    for (const intent of pendingReads.current.values()) void acknowledge(intent).catch(() => undefined)
  }, [acknowledge, refresh])
  const changes = useCallback((batch: NotificationEpisodeChange[]): void => {
    if (!batch.length) return
    const affected = new Set<string>()
    for (const change of batch) {
      const threadId = change.episode?.thread.id
      if (threadId && scope.current.ids.includes(threadId)) {
        floor.current.set(threadId, Math.max(floor.current.get(threadId) ?? 0, change.changeSequence))
        affected.add(threadId)
      } else if (change.operation === 'remove') {
        // Removed episodes no longer carry a Thread identity.
        for (const id of scope.current.ids) affected.add(id)
      }
    }
    if (affected.size) void refresh([...affected])
  }, [refresh])
  const reset = useCallback((): void => {
    floor.current.clear()
    scope.current = { ...scope.current, generation: scope.current.generation + 1 }
    viewed.current = null
    // Keep the last proven dots while the replacement baseline is loading.
    recover()
  }, [recover])
  const captureRead = useCallback((threadId: string): InterruptionReadIntent | null => {
    const snapshot = snapshotsRef.current[threadId]
    if (!snapshot) {
      void refresh([threadId])
      throw new Error(uiAttribute('提醒状态尚未加载，请稍后重试。'))
    }
    return snapshot.unread ? { commandId: newCommandId(), command: { threadId, observedThroughChangeSequence: snapshot.sequence } } : null
  }, [refresh])

  useEffect(() => {
    const ids: string[] = JSON.parse(idsKey)
    scope.current = { enabled, ids, generation: scope.current.generation + 1 }
    snapshotsRef.current = Object.fromEntries(Object.entries(snapshotsRef.current).filter(([id]) => ids.includes(id)))
    setSnapshots(snapshotsRef.current)
    floor.current = new Map([...floor.current].filter(([id]) => ids.includes(id)))
    if (enabled) void refresh()
  }, [enabled, idsKey, refresh])
  useEffect(() => {
    mounted.current = true
    const visibility = (): void => { setFocused(attentive()) }
    window.addEventListener('focus', visibility)
    window.addEventListener('blur', visibility)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      mounted.current = false
      window.removeEventListener('focus', visibility)
      window.removeEventListener('blur', visibility)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])
  useEffect(() => { viewed.current = null }, [surface.threadId, surface.visible, focused])
  useEffect(() => {
    const threadId = surface.threadId
    if (!enabled || !threadId || !surface.visible || !focused || viewed.current === threadId || snapshots[threadId]?.generation !== scope.current.generation) return
    const generation = scope.current.generation
    const frame = window.requestAnimationFrame(() => {
      // A reset can invalidate the retained snapshot without causing a render
      // before this frame. It must not consume this visit's acknowledgement.
      if (!mounted.current || !attentive() || generation !== scope.current.generation
        || snapshotsRef.current[threadId]?.generation !== generation) return
      viewed.current = threadId
      const intent = captureRead(threadId)
      if (intent) void acknowledge(intent).catch(() => undefined)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [enabled, surface.threadId, surface.visible, focused, snapshots, captureRead, acknowledge])

  return useMemo(() => ({ snapshots, captureRead, acknowledge, changes, reset, recover }),
    [snapshots, captureRead, acknowledge, changes, reset, recover])
}

export const ThreadInterruptionAttentionContext = createContext<ReturnType<typeof useThreadInterruptionAttention> | null>(null)
export const useInterruptionAttention = () => useContext(ThreadInterruptionAttentionContext)

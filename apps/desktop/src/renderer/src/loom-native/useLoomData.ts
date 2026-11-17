import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentProfile, CoreEvent, MissionRecord, ThreadSnapshot } from '@contracts'
import type { BusinessEnvironment } from '../business-environment'
import { readErrorMessage } from '../error-message'
import { uiAttribute } from '../interface-language'
import { shouldRefreshMissionsForEvent } from '../useMissions'
import { createNavigationRefreshCoordinator, type NavigationRefreshCoordinator } from '../navigation-refresh-coordinator'
import { WorkBundleCache } from './work-bundle-cache'
import {
  bootstrapSelection,
  conversationItems,
  createThreadForAgent,
  readAgents,
  readMissions,
  readNavigation,
  readThreadSnapshot,
  readWorkBundle,
  sendThreadMessage
} from './service'
import type { ConversationItem, WorkBundle } from './types'

/** Thread-scoped Core events: the open conversation re-reads itself, nothing else moves. */
const THREAD_SCOPE_EVENTS = new Set([
  'thread.messages.changed',
  'thread.memberCreated',
  'thread.member.fast.updated',
  'camp.member_added',
  'camp.member_removed',
  'camp.membership_reconciliation_started',
  'camp.membership_reconciliation_completed',
  'camp.default_lead_reconciled',
  'agent_run.cancelled',
  'agent_run.continuation_requested',
  'agent_run.recovery_blocker_resolved',
  'agent_run.runtime_model_observed',
  'agent_run.terminal',
  'agent_run.images.updated',
  'agent_run.file_changes_completed'
])

const EVENT_REOPEN_DEBOUNCE_MS = 200

interface LiveState {
  agents: AgentProfile[]
  conversations: ConversationItem[]
  missions: MissionRecord[]
  snapshot: ThreadSnapshot | null
  selectedId: string | null
  selectedThreadId: string | null
}

export interface LoomData {
  agents: AgentProfile[]
  conversations: ConversationItem[]
  missions: MissionRecord[]
  bundles: WorkBundle[]
  snapshot: ThreadSnapshot | null
  loading: boolean
  error: string | null
  selectedId: string | null
  select(item: ConversationItem): Promise<void>
  refresh(): Promise<void>
  send(text: string, files: File[], recipientAgentId?: string): Promise<void>
  createConversation(agentId?: string): Promise<void>
  openConversation(threadId: string): Promise<void>
}

/** Sole adapter between the authenticated ThreadClient and the native UI. Every read is
 * read-only: nothing is created, started or accepted without an explicit user action. */
export function useLoomData(environment: BusinessEnvironment): LoomData {
  const client = environment.client
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [conversations, setConversations] = useState<ConversationItem[]>([])
  const [missions, setMissions] = useState<MissionRecord[]>([])
  const [bundles, setBundles] = useState<WorkBundle[]>([])
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const listGeneration = useRef(0)
  const workCache = useRef(new WorkBundleCache())
  const snapshotGeneration = useRef(0)
  // An explicit open/select survives background navigation refreshes.
  const requestedThread = useRef<string | null>(null)
  const bootstrapDone = useRef(false)
  const reopenTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const live = useRef<LiveState>({
    agents: [], conversations: [], missions: [], snapshot: null, selectedId: null, selectedThreadId: null
  })
  // Latest committed objects, readable synchronously by async work started in this render.
  live.current = {
    agents,
    conversations,
    missions,
    snapshot,
    selectedId,
    selectedThreadId: conversations.find(item => item.id === selectedId)?.threadId ?? null
  }

  const commit = useCallback((next: Partial<LiveState>): void => {
    live.current = { ...live.current, ...next }
    if (next.agents !== undefined) setAgents(next.agents)
    if (next.conversations !== undefined) setConversations(next.conversations)
    if (next.missions !== undefined) setMissions(next.missions)
    if (next.snapshot !== undefined) setSnapshot(next.snapshot)
    if (next.selectedId !== undefined) setSelectedId(next.selectedId)
  }, [])

  /** One Thread read. A superseded ticket or a switched selection never writes. */
  const openThread = useCallback(async (threadId: string, list: number): Promise<void> => {
    const ticket = ++snapshotGeneration.current
    const next = await readThreadSnapshot(client, threadId)
    if (ticket !== snapshotGeneration.current || list !== listGeneration.current) return
    if (live.current.selectedThreadId !== threadId) return
    commit({ snapshot: next })
  }, [client, commit])

  const reloadSnapshot = useCallback(async (threadId: string): Promise<void> => {
    const ticket = ++snapshotGeneration.current
    const next = await readThreadSnapshot(client, threadId)
    if (ticket !== snapshotGeneration.current || live.current.selectedThreadId !== threadId) return
    commit({ snapshot: next })
  }, [client, commit])

  const loadAll = useCallback(async (trigger: 'initial' | 'explicit' | 'invalidation'): Promise<void> => {
    const generation = ++listGeneration.current
    if (trigger !== 'invalidation') setLoading(true)
    setError(null)
    try {
      const [nextAgents, navigation, nextMissions] = await Promise.all([
        readAgents(client),
        readNavigation(client),
        readMissions(client)
      ])
      if (generation !== listGeneration.current) return
      const nextConversations = conversationItems(nextAgents, navigation, nextMissions)
      // The right pane is all work, so every actual Mission is read; selection plays no part.
      // A thrown read becomes a surfaced error, never an empty-but-successful workspace.
      const bundlesTask = workCache.current.read(client, nextMissions, trigger === 'explicit').then(
        result => result,
        (nextError: unknown) => ({ bundles: [] as WorkBundle[], errors: [readErrorMessage(nextError)], fetched: 0 })
      )
      const kept = nextConversations.find(item => item.id === live.current.selectedId) ?? null
      const requested = requestedThread.current
        ? nextConversations.find(item => item.threadId === requestedThread.current) ?? null
        : null
      // Bootstrap only ever selects an existing conversation; it never creates one.
      const nextSelection = requested ?? kept ?? (bootstrapDone.current ? null : bootstrapSelection(nextConversations, nextMissions))
      if (nextSelection) bootstrapDone.current = true
      commit({
        agents: nextAgents,
        conversations: nextConversations,
        missions: nextMissions,
        selectedId: nextSelection?.id ?? null,
        selectedThreadId: nextSelection?.threadId ?? null
      })
      if (nextSelection?.threadId !== live.current.snapshot?.thread.id) commit({ snapshot: null })
      let threadError: string | null = null
      if (nextSelection?.threadId) await openThread(nextSelection.threadId, generation).catch(nextError => { threadError = readErrorMessage(nextError) })
      const work = await bundlesTask
      if (generation !== listGeneration.current) return
      setBundles(previous => previous.length === work.bundles.length && previous.every((bundle,index) => bundle === work.bundles[index]) ? previous : work.bundles)
      const failures = [...work.errors, ...(threadError ? [threadError] : [])]
      if (failures.length > 0) setError(failures.join(' '))
    } catch (nextError) {
      if (generation === listGeneration.current) setError(readErrorMessage(nextError))
      throw nextError
    } finally {
      if (generation === listGeneration.current) setLoading(false)
    }
  }, [client, commit, openThread])

  /** After an accepted send/create: new row, coherent selection, refreshed thread. */
  const reloadThread = useCallback(async (threadId: string): Promise<void> => {
    requestedThread.current = threadId
    bootstrapDone.current = true
    const generation = ++listGeneration.current
    const ticket = ++snapshotGeneration.current
    const nextSnapshot = await readThreadSnapshot(client, threadId)
    const [nextAgents, navigation, nextMissions] = await Promise.all([
      readAgents(client),
      readNavigation(client),
      readMissions(client)
    ])
    if (generation !== listGeneration.current || requestedThread.current !== threadId) return
    const nextConversations = conversationItems(nextAgents, navigation, nextMissions)
    const selected = nextConversations.find(item => item.threadId === threadId) ?? null
    commit({
      agents: nextAgents,
      conversations: nextConversations,
      missions: nextMissions,
      selectedId: selected?.id ?? live.current.selectedId,
      selectedThreadId: selected?.threadId ?? threadId,
      ...(ticket === snapshotGeneration.current ? { snapshot: nextSnapshot } : {})
    })
    const mission = selected?.missionId
      ? nextMissions.find(candidate => candidate.missionId === selected.missionId) ?? null
      : null
    if (!mission) return
    try {
      const bundle = await readWorkBundle(client, mission)
      if (generation !== listGeneration.current) return
      workCache.current.prime(bundle)
      setBundles(current => [...current.filter(item => item.mission.missionId !== mission.missionId), bundle])
    } catch (nextError) {
      if (generation === listGeneration.current) setError(readErrorMessage(nextError))
    }
  }, [client, commit])

  const select = useCallback(async (item: ConversationItem): Promise<void> => {
    requestedThread.current = item.threadId
    bootstrapDone.current = true
    setError(null)
    // Switching always drops the previous Thread surface first; a member row has none.
    commit({ selectedId: item.id, selectedThreadId: item.threadId, snapshot: null })
    if (!item.threadId) return
    const ticket = ++snapshotGeneration.current
    try {
      const next = await readThreadSnapshot(client, item.threadId)
      if (ticket !== snapshotGeneration.current || live.current.selectedThreadId !== item.threadId) return
      commit({ snapshot: next })
    } catch (nextError) {
      if (ticket !== snapshotGeneration.current) return
      setError(readErrorMessage(nextError))
      throw nextError
    }
  }, [client, commit])

  const refresh = useCallback((): Promise<void> => loadAll('explicit'), [loadAll])

  const send = useCallback(async (text: string, files: File[], recipientAgentId?: string): Promise<void> => {
    const current = live.current
    const item = current.conversations.find(entry => entry.id === current.selectedId) ?? null
    const agentId = recipientAgentId ?? item?.agentId ?? current.snapshot?.thread.defaultLeadAgentId ?? null
    let threadId = item?.threadId ?? null
    setError(null)
    try {
      if (!threadId) {
        // A member row stays read-only until this explicit send gives it a Thread.
        if (!agentId) throw new Error(uiAttribute('请选择一位助手后再发送。'))
        threadId = await createThreadForAgent(client, agentId)
        bootstrapDone.current = true
        const created: ConversationItem = { id: threadId, threadId, missionId: null,
          agentId, title: current.agents.find(agent => agent.agentId === agentId)?.displayName || '新对话',
          subtitle: '尚未发送', unread: false, updatedAt: null }
        commit({ selectedId: created.id, selectedThreadId: threadId,
          conversations: [...live.current.conversations.filter(entry => entry.id !== created.id), created], snapshot: null })
      }
      await sendThreadMessage(client, {
        threadId,
        text,
        files,
        ...(recipientAgentId ? { recipientAgentId } : {})
      })
    } catch (nextError) {
      // Fail closed: caller keeps text and files, nothing was cleared.
      setError(readErrorMessage(nextError))
      throw nextError
    }
    if (live.current.selectedThreadId === threadId) {
      await reloadThread(threadId).catch(nextError => setError(readErrorMessage(nextError)))
    } else {
      await loadAll('invalidation').catch(nextError => setError(readErrorMessage(nextError)))
    }
  }, [client, commit, loadAll, reloadThread])

  const createConversation = useCallback(async (agentId?: string): Promise<void> => {
    const current = live.current
    const resolved = agentId
      ?? current.conversations.find(entry => entry.id === current.selectedId)?.agentId
      ?? null
    setError(null)
    let threadId: string
    try {
      if (!resolved) throw new Error(uiAttribute('请选择一位助手。'))
      threadId = await createThreadForAgent(client, resolved)
    } catch (nextError) {
      setError(readErrorMessage(nextError))
      throw nextError
    }
    bootstrapDone.current = true
    await reloadThread(threadId).catch(nextError => setError(readErrorMessage(nextError)))
  }, [client, reloadThread])

  const loadAllRef = useRef(loadAll)
  loadAllRef.current = loadAll
  const reloadSnapshotRef = useRef(reloadSnapshot)
  reloadSnapshotRef.current = reloadSnapshot

  const coordinatorRef = useRef<NavigationRefreshCoordinator | null>(null)

  useEffect(() => {
    const coordinator = createNavigationRefreshCoordinator(() => loadAllRef.current('invalidation'), { debounceMs: 120 })
    coordinatorRef.current = coordinator
    void loadAllRef.current('initial').catch(() => undefined)
    return () => {
      ++listGeneration.current
      ++snapshotGeneration.current
      coordinator.dispose()
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null
      if (reopenTimer.current !== null) {
        clearTimeout(reopenTimer.current)
        reopenTimer.current = null
      }
    }
  }, [client])

  useEffect(() => {
    const refreshFromEvent = (dirtyWork = false, missionId?: string | null): void => {
      if (dirtyWork) workCache.current.invalidate(missionId)
      void coordinatorRef.current?.refresh('invalidation').catch(() => undefined)
    }
    // Debounced: one burst of runtime events re-reads the open Thread once.
    const reopen = (threadId: string): void => {
      if (reopenTimer.current !== null) clearTimeout(reopenTimer.current)
      reopenTimer.current = setTimeout(() => {
        reopenTimer.current = null
        void reloadSnapshotRef.current(threadId).catch(nextError => setError(readErrorMessage(nextError)))
      }, EVENT_REOPEN_DEBOUNCE_MS)
    }
    const onEvent = (event: CoreEvent): void => {
      const params = event.params && typeof event.params === 'object'
        ? event.params as Record<string, unknown>
        : {}
      const threadId = typeof params.threadId === 'string' ? params.threadId : null
      if (threadId !== null && threadId === live.current.selectedThreadId && THREAD_SCOPE_EVENTS.has(event.method)) {
        reopen(threadId)
        return
      }
      if (shouldRefreshMissionsForEvent(event, new Set(live.current.missions.map(mission => mission.threadId)))) {
        refreshFromEvent(true,typeof params.missionId === 'string' ? params.missionId : null)
        return
      }
      if (event.method.startsWith('loom.') && event.method.endsWith('.invalidated')) {
        refreshFromEvent(true,typeof params.missionId === 'string' ? params.missionId : null)
        return
      }
      if (event.method === 'navigation.invalidated' || event.method === 'members.invalidated') refreshFromEvent()
    }
    const offEvent = client.onEvent?.(onEvent)
    // Browser transport emits read-invalidations instead of raw Core events.
    // A plan/candidate write can leave Mission.updatedAt unchanged, so keeping
    // the bundle cache here would redraw a stale empty plan indefinitely.
    const offInvalidated = client.onInvalidated?.(() => refreshFromEvent(true))
    const onFocus = (): void => { if (document.visibilityState === 'visible') refreshFromEvent(true) }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      offEvent?.()
      offInvalidated?.()
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      if (reopenTimer.current !== null) {
        clearTimeout(reopenTimer.current)
        reopenTimer.current = null
      }
    }
  }, [client])

  return {
    agents,
    conversations,
    missions,
    bundles,
    snapshot,
    loading,
    error,
    selectedId,
    select,
    refresh,
    send,
    createConversation,
    openConversation: reloadThread
  }
}

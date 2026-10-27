import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { NavigationThreadItem, NotificationEpisodeChange, NotificationThreadInterruptions, StoredCommandResult } from '@contracts'
import { ThreadClientProvider } from '../../../apps/desktop/src/renderer/src/camp-client'
import { desktopThreadClient } from '../../../apps/desktop/src/renderer/src/desktop-camp-client'
import { ThreadNavigation } from '../../../apps/desktop/src/renderer/src/ThreadNavigation'
import { NotificationAttentionController } from '../../../apps/desktop/src/renderer/src/NotificationAttentionController'
import { ThreadInterruptionAttentionContext, useThreadInterruptionAttention } from '../../../apps/desktop/src/renderer/src/thread-interruption-attention'
import '../../../apps/desktop/src/renderer/src/styles.css'

const id = 'rvcamp_01h47kvsy5fk1shh6w1g60eec0'
const batchIds = [id, ...Array.from({ length: 200 }, (_, index) => `rvcamp_extra_${String(index).padStart(3, '0')}`)]
const secondaryId = batchIds[200]
const thread: NavigationThreadItem = { id, title: '退出提醒验收', activationState: 'active', projectPath: '/fixture',
  projectBindingKind: 'quick_chat', defaultLead: null, marker: 'loading', lastActivityAt: '2026-10-21',
  lastActivityGlobalSequence: 0, latestCompletionGlobalSequence: 0, lastSeenGlobalSequence: 0, version: 1 }
const noop = () => undefined
const refreshVisible = async () => false
let attentive = true
Object.defineProperty(document, 'hasFocus', { value: () => attentive })
let sequence = 1
const journal: NotificationEpisodeChange[] = []
const facts = new Map<string, { sequence: number; read: boolean; threadId: string }>([['restart', { sequence, read: false, threadId: id }]])
const events = new Set<(event: { method: string }) => void>()
const invalidations = new Set<(change: { messages?: never[]; resync?: boolean; notificationsChanged?: boolean }) => void>()
const requests: { method: string; request: any }[] = []
const emit = (method = 'notification_episode.changed') => events.forEach(listener => listener({ method }))
let holdProjection = false
let holdChanges = false
let failChanges = false
let servedChangeSequence = 0
const heldChanges: (() => void)[] = []
const realNow = Date.now
let clockOffset = 0
Date.now = () => realNow() + clockOffset
const requestFrame = window.requestAnimationFrame.bind(window)
const cancelFrame = window.cancelAnimationFrame.bind(window)
let holdFrames = false
let frameId = 0
const heldFrames = new Map<number, FrameRequestCallback>()
window.requestAnimationFrame = callback => {
  if (!holdFrames) return requestFrame(callback)
  const id = --frameId
  heldFrames.set(id, callback)
  return id
}
window.cancelAnimationFrame = id => { if (id < 0) heldFrames.delete(id); else cancelFrame(id) }
let failAck = false
const held: (() => void)[] = []
let secondaryUnread = false
let secondaryMode: 'success' | 'fail' | 'hold' = 'success'
let batchFailures = 0
const heldBatches: (() => void)[] = []
const receipts = new Map<string, StoredCommandResult>()
const task = () => ({ enabled: false, headsUpAfterSequence: 0, observedThroughChangeSequence: sequence })
let attention: ReturnType<typeof useThreadInterruptionAttention>
let ready: (value: boolean) => void
let advance: () => void
let manual: (value: boolean) => void
let showSidebar: (value: boolean) => void
let changeThreadIds: (value: string[]) => void
let localWrites = 0
const unread = (threadId: string) => [...facts.values()].some(f => f.threadId === threadId && !f.read)
const client = { platform: 'darwin', onEvent: (listener: (event: { method: string }) => void) => {
  events.add(listener); return () => events.delete(listener)
}, onInvalidated: (listener: (change: { messages?: never[]; resync?: boolean; notificationsChanged?: boolean }) => void) => {
  invalidations.add(listener); return () => invalidations.delete(listener)
}, request: async (method: string, request: any) => {
  requests.push({ method, request })
  if (method === 'preferences.tasks.get') return task()
  if (method === 'notifications.preference.get') return { headsUpEnabled: false }
  if (method === 'notifications.inbox') return { schemaVersion: 11, throughChangeSequence: sequence,
    unreadCount: [...facts.values()].filter(fact => !fact.read).length, items: [], nextCursor: null }
  if (method === 'notifications.changesSince') {
    const snapshot = { schemaVersion: 11, requestedAfterChangeSequence: request.afterChangeSequence,
      throughChangeSequence: sequence, nextChangeSequence: sequence, retainedFloorChangeSequence: 0,
      resetRequired: false, hasMore: false, taskCapability: task(), changes: journal.filter(change => change.changeSequence > request.afterChangeSequence) }
    if (holdChanges) await new Promise<void>(resolve => heldChanges.push(resolve))
    if (failChanges) { failChanges = false; throw new Error('change read failed') }
    servedChangeSequence = snapshot.nextChangeSequence
    return snapshot
  }
  if (method === 'notifications.threadInterruptions') {
    const snapshot: NotificationThreadInterruptions = { throughChangeSequence: sequence, threads: request.threadIds.map((threadId: string) => ({
      threadId, hasUnreadInterruption: threadId === secondaryId ? secondaryUnread : unread(threadId)
    })) }
    if (request.threadIds.includes(secondaryId)) {
      if (secondaryMode === 'fail') { batchFailures++; throw new Error('second batch unavailable') }
      if (secondaryMode === 'hold') await new Promise<void>(resolve => heldBatches.push(resolve))
    }
    if (holdProjection) await new Promise<void>(resolve => held.push(resolve))
    return snapshot
  }
  if (method === 'notifications.acknowledgeVisibleSources') {
    return { commandId: request.commandId, status: 'applied', code: 'ok', payload: { changed: 0, resultingChangeSequence: sequence } }
  }
  if (method === 'notifications.acknowledgeThreadInterruptions') {
    if (failAck) { failAck = false; throw new Error('lost response') }
    const receipt = receipts.get(request.commandId)
    if (receipt) return receipt
    for (const [runId, fact] of facts) {
      if (fact.threadId === request.command.threadId && fact.sequence <= request.command.observedThroughChangeSequence && !fact.read) {
        fact.read = true
        journal.push(change(runId, ++sequence, 'acknowledged'))
      }
    }
    if (request.command.threadId === secondaryId && secondaryUnread) { secondaryUnread = false; sequence++ }
    const result = { commandId: request.commandId, status: 'applied', code: 'ok', payload: { resultingChangeSequence: sequence } } as StoredCommandResult
    receipts.set(request.commandId, result)
    emit()
    return result
  }
  throw new Error(method)
} } as unknown as typeof desktopThreadClient

function change(runId: string, n: number, cause: NotificationEpisodeChange['changeCause'] = 'occurrence_admitted'): NotificationEpisodeChange {
  const fact = facts.get(runId)!
  const action = { actionId: runId, kind: 'open_agent_run' as const, available: true, threadId: fact.threadId,
    threadTurnId: null, agentRunId: runId, messageId: null, approvalId: null, acknowledgementId: runId, observedEpisodeVersion: 1 }
  return { changeSequence: n, episodeId: runId, episodeVersion: 1, attentionRevision: 1, operation: 'upsert',
    changeCause: cause, changedAt: '2026-10-21', headsUpSignal: null, headsUpInvalidation: null,
    episode: { id: runId, kind: 'collaboration', episodeVersion: 1, attentionRevision: 1, changeSequence: n,
      thread: { id: fact.threadId, title: thread.title }, threadTurnId: null, agentRunId: runId, primarySemantic: 'run_stopped', unread: !fact.read,
      resolved: false, satisfied: false, pendingApprovalCount: 0, mentionCount: 0, unacknowledgedMentionCount: 0,
      mention: null, reasons: [], primaryAction: action, secondaryActions: [], createdAt: '2026-10-21', updatedAt: '2026-10-21' } }
}
function admit(runId: string, threadId = id, web = false, signal = true) {
  facts.set(runId, { sequence: ++sequence, read: false, threadId })
  journal.push(change(runId, sequence))
  if (signal) {
    if (web) invalidations.forEach(fn => fn({ notificationsChanged: true }))
    else emit()
  }
}
function Fixture() {
  const [contentReady, setReady] = useState(false)
  const [tick, setTick] = useState(0)
  const [manualUnread, setManual] = useState(false)
  const [sidebar, setSidebar] = useState(true)
  const [threadIds, setThreadIds] = useState([id])
  attention = useThreadInterruptionAttention(true, threadIds, { threadId: id, visible: contentReady })
  ready = setReady; manual = setManual; showSidebar = setSidebar; changeThreadIds = setThreadIds
  advance = () => { setTick(n => n + 1); emit('runtime.activity.changed'); invalidations.forEach(fn => fn({ messages: [] })) }
  return <ThreadInterruptionAttentionContext.Provider value={attention}>
    <div className="app-shell" style={{ display: 'grid', gridTemplateColumns: '260px 1fr', height: '100vh' }}>
      <div id="sidebar" style={{ visibility: sidebar ? 'visible' : 'hidden' }}>
        <ThreadNavigation view="camp" state="ready" navigation={{ schemaVersion: 3, throughGlobalSequence: tick,
          quickChat: { totalCount: 1, recentThreads: [thread] }, projects: [] }}
          activeThreadId={id} pendingMemoryCount={0}
          threadReadStates={{ [id]: { manualUnread, readThroughGlobalSequence: 0 } }}
          onNewConversation={noop} onMembers={noop} onMemory={noop} onSettings={noop} onOpenProject={noop}
          onThread={noop} onRemoveProject={async () => {}} onRename={async () => {}} onDelete={async () => {}}
          onError={error => { throw error }} />
      </div>
      <main><input id="focus" defaultValue="保留的草稿" /><p>{contentReady ? '正式会话内容' : '缓存预览 / 加载中'}</p></main>
      <NotificationAttentionController enabled activeThreadId={id} activeThreadVisible={contentReady} navigationActive={false}
        visibleSources={{ threadId: id, snapshotSequence: tick, surfaceVisible: contentReady, agentRunIds: [], campTurnIds: [], messageIds: ['existing-message'], approvalIds: [] }}
        onNavigate={async () => ({ status: 'navigated' })} onPresentNavigation={async () => true}
        onCancelNavigation={noop} onRefreshVisibleThread={refreshVisible} onError={noop} />
    </div>
  </ThreadInterruptionAttentionContext.Provider>
}
Object.assign(window, { interruptionTest: {
  silentAdmit: (runId: string) => admit(runId, id, false, false),
  holdFrames: () => { holdFrames = true },
  releaseFrames: () => {
    holdFrames = false
    const callbacks = [...heldFrames.values()]
    heldFrames.clear()
    callbacks.forEach(callback => callback(performance.now()))
  },
  holdChanges: () => { holdChanges = true },
  releaseChanges: (fail = false) => {
    holdChanges = false
    failChanges = fail
    heldChanges.splice(0).forEach(resolve => resolve())
  },
  passBackoff: () => { clockOffset += 5_001 },
  admit, admitWeb: (runId: string) => admit(runId, id, true), ready: (value: boolean) => ready(value), advance: () => advance(), sidebar: (value: boolean) => showSidebar(value),
  manual: (value: boolean) => manual(value), manualStop: () => emit('agent_run.cancelled'),
  attentive: (value: boolean) => { attentive = value; window.dispatchEvent(new Event(value ? 'focus' : 'blur')) },
  reset: () => attention.reset(), poll: emit, recover: () => attention.recover(),
  hold: () => { holdProjection = true; attention.recover() },
  release: () => { holdProjection = false; held.splice(0).forEach(resolve => resolve()) },
  capture: () => attention.captureRead(id),
  markRead: async (intent: Parameters<typeof attention.acknowledge>[0]) => { localWrites++; manual(false); try { await attention.acknowledge(intent) } catch {} },
  failAck: () => { failAck = true },
  batches: () => { secondaryUnread = true; sequence++; changeThreadIds(batchIds) },
  batchMode: (mode: typeof secondaryMode) => { secondaryMode = mode },
  batchUnread: (value: boolean) => { secondaryUnread = value; sequence++ },
  confirmBatch: async () => {
    await attention.acknowledge({ commandId: 'secondary-read', command: { threadId: secondaryId, observedThroughChangeSequence: sequence } })
    return sequence
  },
  releaseBatch: () => { secondaryMode = 'fail'; heldBatches.splice(0).forEach(resolve => resolve()) },
  state: () => ({ ready: !!attention.snapshots[id], unread: attention.snapshots[id]?.unread,
    heldFrames: heldFrames.size, heldChanges: heldChanges.length, servedChangeSequence, sequence,
    dot: !!document.querySelector('.camp-unread-dot'),
    label: document.querySelector('.camp-nav-row button')?.getAttribute('aria-label'),
    headsUp: document.querySelectorAll('.notification-heads-up').length,
    projectionCount: Object.keys(attention.snapshots).length, secondary: attention.snapshots[secondaryId],
    batchFailures, heldBatches: heldBatches.length, localWrites, requests, held: held.length,
    facts: [...facts].map(([runId, fact]) => ({ runId, ...fact })) })
} })
createRoot(document.getElementById('root')!).render(<ThreadClientProvider client={client}><Fixture /></ThreadClientProvider>)

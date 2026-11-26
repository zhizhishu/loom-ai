import { readOutbox } from './pending-outbox-store'
import { BotBoard } from './BotBoard'
import { PendingInbox } from './PendingInbox'
import type { AgentRunView, LocalAttachmentOwnerLocator, StoredCommandResult,WorkspaceSelection } from '@contracts'
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { BusinessEnvironment } from '../business-environment'
import type { ArtifactSelection, ConversationItem, InspectorTab, InspectorMode, WorkItem } from './types'
import { useLoomData } from './useLoomData'
import { usePiQuestions } from './pi-questions'
import { Sidebar } from './Sidebar'
import { ConversationView } from './ConversationView'
import { Inspector, flattenWork, workStatus } from './Inspector'
import { ArtifactView } from './ArtifactView'
import { refreshArtifactSelection } from './artifact-service'
import { Avatar } from './Avatar'
import { Icon, IconButton } from './icons'
import './native.css'
import './product.css'
import { SurfaceDialog, UnsavedNotice } from './Controls'
import { panelFor, modeFor, readPanelPreference } from './workspace-panel'
import { searchWorkspace } from './workspace-search'
import { WorkspaceSearch } from './WorkspaceSearch'
import { PanelResizeHandle } from './PanelResizeHandle'
import { SettingsPage, type SettingsLeaveGuard } from './SettingsPage'
import { ProfileMenu } from './ProfileMenu'
import { readStoredSettingsSection, type SettingsSectionId } from './settings-sections'
import { RunStatusDialog } from './RunStatusDialog'
import { RunActivityHistory } from './RunningActivity'
import { storedPanelWidth, fittedPanelWidths, type PanelSide, type PanelWidths } from './panel-resize'

// Load optional editors only when opened; keep them mounted after first use so
// transport-unknown drafts cannot be discarded by closing a modal.
const AssistantStudio = lazy(() => import('./AssistantStudio').then(v => ({default:v.AssistantStudio})))
const CapabilityLibrary = lazy(() => import('./CapabilityLibrary').then(v => ({default:v.CapabilityLibrary})))
const RoomDialog = lazy(() => import('./RoomDialog').then(v => ({default:v.RoomDialog})))
const RoomMembersDialog = lazy(() => import('./RoomDialog').then(v => ({default:v.RoomMembersDialog})))

type Props = { environment: BusinessEnvironment; remoteConnection?: ReactNode; onLogout?(): void; initialStartupSnapshot?: unknown; startupStartedAtMs?: number;
  /** Web only: the linked section and the hook that keeps `?section=` in step; Desktop passes neither. */
  initialSettingsSection?: SettingsSectionId | null; onSettingsSectionChange?(section: SettingsSectionId | null): void }
type Draft = { text: string; files: File[] }

/** PiBot-style React/Vite application frame with a new Mikka-reference component
 * tree. Only the authenticated adapter, domain types and animated avatar are shared. */
export function RailBottom({ children }: { children: React.ReactNode }) {
  return <div className="ln-rail-bottom">{children}</div>
}

export function LoomApp({ environment, onLogout, initialSettingsSection = null, onSettingsSectionChange }: Props) {
  const data = useLoomData(environment)
  const piQuestions = usePiQuestions(environment.client)
  const [boardOpen,setBoardOpen] = useState(false)
  const [pendingOpen,setPendingOpen] = useState(false)
  const [pendingCount,setPendingCount] = useState(0)
  useEffect(()=>{
    const count=()=>{
      try{setPendingCount(Array.from(new Set(data.conversations.flatMap(c=>c.threadId?[c.threadId]:[]))).reduce((n,id)=>n+readOutbox(id).filter(r=>r.state!=='accepted').length,0))}
      catch{setPendingCount(0)}
    }
    count();window.addEventListener('loom-outbox-changed',count)
    return()=>window.removeEventListener('loom-outbox-changed',count)
  },[data.conversations])

  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 800)
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth > 800)
  const frameRef = useRef<HTMLElement>(null)
  const [panelWidths, setPanelWidths] = useState<PanelWidths>(() => {
    try { return { sidebar: storedPanelWidth(localStorage.getItem('loom.panel.sidebar'),264,'sidebar'), inspector: storedPanelWidth(localStorage.getItem('loom.panel.inspector'),470,'inspector') } }
    catch { return { sidebar:264, inspector:470 } }
  })
  const resizePanel = (side: PanelSide, value: number) => {
    setPanelWidths(current => ({ ...current, [side]: value }))
    try { localStorage.setItem('loom.panel.' + side, String(value)) } catch { /* Ephemeral if storage is blocked. */ }
  }
  // RDP/UU virtual monitors can change dimensions during a session. Observe
  // the actual browser frame, never assume the Windows monitor identity or DPI.
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const fit = () => {
      if (frame.classList.contains('ln-is-resizing')) return
      const sizes = fittedPanelWidths(frame.clientWidth,panelWidths,sidebarOpen,inspectorOpen)
      frame.style.setProperty('--ln-sidebar-width',String(sizes.sidebar)+'px')
      frame.style.setProperty('--ln-inspector-width',String(sizes.inspector)+'px')
    }
    fit()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null
    observer?.observe(frame)
    window.addEventListener('resize',fit)
    return () => { observer?.disconnect();window.removeEventListener('resize',fit) }
  },[panelWidths,sidebarOpen,inspectorOpen])
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>(() => { try { return modeFor(readPanelPreference(sessionStorage.getItem('loom.workspace.panel'))) } catch { return 'work' } })
  const [tab, setTab] = useState<InspectorTab>('details')
  const [expanded, setExpanded] = useState(false)
  const [theme, setTheme] = useState<'day' | 'night'>(() => sessionStorage.getItem('loom.native.theme') === 'night' ? 'night' : 'day')
  const [modal, setModal] = useState<'search' | 'history' | null>(null)
  const [newRoom, setNewRoom] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | null>(initialSettingsSection)
  // Same guard as the inspector (`safeInspectorAction`): unsaved capability edits ask before the settings page covers them.
  const openSettings = (id?: SettingsSectionId) => safeInspectorAction(() => { setCapabilityDirty(false); setSettingsSection(id ?? readStoredSettingsSection(typeof localStorage === 'undefined' ? null : localStorage)) })
  // The page owns the section; the Web entry mirrors it into `?section=` and clears it again.
  useEffect(() => { onSettingsSectionChange?.(settingsSection) }, [settingsSection, onSettingsSectionChange])
  const [runSurfaceOpen, setRunSurfaceOpen] = useState(false)
  const runSurfaceOpener = useRef<HTMLElement | null>(null)
  const [roomInitialWorkspace,setRoomInitialWorkspace] = useState<WorkspaceSelection|null>(null)
  const [roomMode, setRoomMode] = useState<'direct' | 'group' | 'work'>('group')
  // 两个 ＋ 分工（Mikka `rail-items.ts:29` / `rail-items.ts:37`）：左侧 rail 那个开新单聊，
  // 会话列表头那个开新群聊；共用一个弹窗，只换 mode。没有第三个入口。
  const beginDirectConversation = () => { setRoomInitialWorkspace(null);setRoomMode('direct'); setNewRoom(true) }
  const beginConversation = () => { setRoomInitialWorkspace(null);setRoomMode('group'); setNewRoom(true) }
  const beginWork = () => { setRoomInitialWorkspace(null);setRoomMode('work'); setNewRoom(true) }
  const beginWorkIn = (root:WorkspaceSelection) => {setRoomInitialWorkspace(root);setRoomMode('work');setNewRoom(true)}
  const [membersOpen, setMembersOpen] = useState(false)
  const [studioOpen, setStudioOpen] = useState(false)
  const [studioAgent, setStudioAgent] = useState<string | undefined>()
  const [studioCreate, setStudioCreate] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [visitedPanels,setVisitedPanels]=useState({studio:false,room:false,members:false,library:false})
  useEffect(()=>{
    setVisitedPanels(value=>{
      const next={studio:value.studio||studioOpen,room:value.room||newRoom,
        members:value.members||membersOpen,library:value.library||libraryOpen}
      return Object.keys(next).every(key=>next[key as keyof typeof next]===value[key as keyof typeof next]) ? value : next
    })
  },[studioOpen,newRoom,membersOpen,libraryOpen])

  const [dockSelection, setDockSelection] = useState<{ threadId: string | null; taskId: string | null } | null>(null)
  const [capabilityEpoch, setCapabilityEpoch] = useState(0)
  const [capabilityDirty, setCapabilityDirty] = useState(false)
  const [pendingInspectorAction, setPendingInspectorAction] = useState<(() => void) | null>(null)
  const safeInspectorAction = (action: () => void) => { if (capabilityDirty) setPendingInspectorAction(() => action); else action() }
  const openCreatedConversation: typeof data.openConversation = (...args) => { setSettingsSection(null); return data.openConversation(...args) }
  const manageAssistant = (agentId?: string, create = false) => { setStudioAgent(agentId); setStudioCreate(create); setStudioOpen(true) }
  const [query, setQuery] = useState('')
  const [artifact, setArtifact] = useState<ArtifactSelection | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [approvalBusy, setApprovalBusy] = useState(false)
  const [stoppingRunIds, setStoppingRunIds] = useState<readonly string[]>([])
  const [sendError, setSendError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const selectionHistory = useRef<ConversationItem[]>([])
  const historyIndex = useRef(-1)
  const [, updateHistory] = useState(0)
  const active = data.conversations.find(item => item.id === data.selectedId) ?? null
  const selectedRunBundle = data.bundles.find(bundle => bundle.mission.missionId === active?.missionId) ?? null
  const currentArtifact = useMemo(() => artifact === null ? null : refreshArtifactSelection(artifact, data.bundles), [artifact, data.bundles])
  const activeAgent = data.agents.find(agent => agent.agentId === (active?.agentId || data.snapshot?.thread.defaultLeadAgentId)) ?? null
  // 群里叠成员头像用的是「已经读过的」成员名单：挂一行不发请求（Mikka CachedGroupAvatar，
  // `components/nav/group-avatar.tsx:44-47`）。没读过的群仍退回标题首字母。
  const [groupRosters, setGroupRosters] = useState<Record<string, readonly string[]>>({})
  useEffect(() => {
    const snapshot = data.snapshot
    if (!snapshot) return
    const ids = snapshot.members.filter(member => member.membershipStatus === 'active').map(member => member.agentId)
    if (ids.length < 2) return
    setGroupRosters(current => {
      const previous = current[snapshot.thread.id]
      if (previous && previous.length === ids.length && previous.every((id, index) => id === ids[index])) return current
      return { ...current, [snapshot.thread.id]: ids }
    })
  }, [data.snapshot])
  const draftKey = data.selectedId || 'new'
  const latestDraftKey = useRef(draftKey)
  latestDraftKey.current = draftKey
  const draft = drafts[draftKey] ?? { text: '', files: [] }
  const work = useMemo(() => flattenWork(data.bundles, piQuestions.questions), [data.bundles, piQuestions.questions])
  const attentionCount = work.filter(item => workStatus(item).group === '等待你').length
  const report = (error: unknown) => setNotice(error instanceof Error ? error.message : String(error))
  // Leaving the settings page goes through its unsaved-changes guard (SettingsPage `guardSettingsLeave`).
  const settingsLeaveGuard = useRef<SettingsLeaveGuard | null>(null)
  const registerSettingsLeave = useRef((guard: SettingsLeaveGuard | null) => { settingsLeaveGuard.current = guard }).current
  const leaveSettings = (action: () => void) => { const guard = settingsSection ? settingsLeaveGuard.current : null; if (guard) guard(action); else action() }
  const select = (item: ConversationItem, remember = true, taskId: string | null = null) => leaveSettings(() => { void selectNow(item, remember, taskId) })
  const selectNow = async (item: ConversationItem, remember: boolean, taskId: string | null) => {
    setSettingsSection(null)
    setSendError(null)
    setDockSelection({ threadId: item.threadId, taskId })
    if (remember && selectionHistory.current[historyIndex.current]?.id !== item.id) {
      selectionHistory.current = [...selectionHistory.current.slice(0, historyIndex.current + 1), item]
      historyIndex.current = selectionHistory.current.length - 1; updateHistory(value => value + 1)
    }
    if (window.innerWidth <= 800) setSidebarOpen(false)
    try { await data.select(item) } catch (error) { report(error) }
  }
  const navigate = (direction: number) => {
    const next = historyIndex.current + direction
    const item = selectionHistory.current[next]
    if (item) { historyIndex.current = next; updateHistory(value => value + 1); void select(item, false) }
  }
  const saveEditorText = (key: string, text: string) => {
    try {
      environment.client.editingRecovery?.set(`loom-native-compose:${key}`, text)
      sessionStorage.setItem(`loom.native.compose:${key}`, text)
    } catch { /* Text remains in the controlled composer when storage is unavailable. */ }
  }
  useEffect(() => {
    if (Object.hasOwn(drafts, draftKey)) return
    try {
      const recovered = environment.client.editingRecovery?.get(`loom-native-compose:${draftKey}`)
        ?? sessionStorage.getItem(`loom.native.compose:${draftKey}`)
      if (typeof recovered === 'string') setDrafts(current => ({ ...current, [draftKey]: { text: recovered, files: [] } }))
    } catch { /* Refused browser storage must not block editing. */ }
  }, [draftKey, environment.client])
  const patchDraft = (patch: Partial<Draft>) => {
    if (patch.text !== undefined) saveEditorText(draftKey, patch.text)
    setDrafts(current => ({ ...current, [draftKey]: { ...(current[draftKey] ?? { text: '', files: [] }), ...patch } }))
  }
  const submit = async (key: string, submitted: Draft, agentId?: string) => {
    if (sending) return
    setSending(true); setSendError(null)
    try {
      await data.send(submitted.text, submitted.files, agentId)
      setDrafts(current => {
        const same = current[key]?.text === submitted.text && current[key]?.files === submitted.files
        if (!same) return current
        saveEditorText(key, '')
        return { ...current, [key]: { text: '', files: [] } }
      })
    } catch (error) {
      if (key.startsWith('agent:') && latestDraftKey.current !== key) {
        const createdKey = latestDraftKey.current
        saveEditorText(createdKey, submitted.text)
        setDrafts(current => ({ ...current, [createdKey]: submitted }))
      }
      setSendError(error instanceof Error ? error.message : '发送未完成，消息已保留。')
    }
    finally { setSending(false) }
  }
  const send = (agentId?: string) => { void submit(draftKey, { ...draft }, agentId) }
  /** 失败块里的「重试」：把上一条用户消息再发一次（Mikka 失败块同样是重新发起这一轮，不是只换个按钮）。
   *  输入框里的草稿不属于这次重试，因此不清空。 */
  const retryLastRun = () => {
    if (sending) return
    const last = data.snapshot?.messages.filter(message => (message.authorType === 'user' || message.authorType === 'external_principal') && !message.withdrawn).at(-1)
    if (!last?.body.trim()) return
    const notice = '【重试】先检查已有成果，不重复外部操作。'
    const text = last.body.startsWith(notice) ? last.body : `${notice}\n\n${last.body}`
    void submit(draftKey, { text, files: [] })
  }
  // An OpenUI card's button continues the conversation with its own words instead of the composer's draft.
  const sendPrompt = async (text: string) => {
    if (sending || !text.trim()) return false
    setSending(true); setSendError(null)
    let sent = false
    try { await data.send(text, [], undefined); sent = true }
    catch (error) { setSendError(error instanceof Error ? error.message : '发送未完成，消息已保留。') }
    finally { setSending(false) }
    return sent
  }
  const openWork = (mode: InspectorMode = 'work') => leaveSettings(() => safeInspectorAction(() => { setSettingsSection(null); setCapabilityDirty(false); setInspectorMode(mode); setInspectorOpen(true); setExpanded(false) }))

  useEffect(() => {
    document.title = 'LOOM'
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setQuery(''); setModal('search') }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); setSidebarOpen(value => !value) }
      if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); openSettings() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])
  useEffect(() => { sessionStorage.setItem('loom.native.theme', theme) }, [theme])
  useEffect(() => { try { sessionStorage.setItem('loom.workspace.panel', panelFor(inspectorMode, tab)) } catch { /* View remains usable without storage. */ } }, [inspectorMode, tab])
  const openAttachment = async (messageId: string, attachmentId: string) => {
    if (!data.snapshot) return
    const locator = { owner: 'message' as const, threadId: data.snapshot.thread.id, messageId, attachmentRefId: attachmentId }
    try {
      if (environment.client.attachments.kind === 'download') await environment.client.attachments.download(locator)
      else await environment.client.attachments.open(locator)
    } catch (error) { report(error) }
  }
  /** A sent attachment's picture, read back through the same Core composer-attachment preview the composer uses. */
  const previewAttachment = async (locator: LocalAttachmentOwnerLocator) => {
    const result = await environment.client.composerAttachments.preview(locator)
    return result.preview
  }
  const resolveApproval = async (approvalId: string, optionId: string) => {
    const snapshot = data.snapshot
    const approval = snapshot?.approvals.find(item => item.id === approvalId && item.status === 'pending')
    if (!snapshot || !approval || approvalBusy || !approval.options.some(option => option.optionId === optionId)) return
    setApprovalBusy(true)
    try {
      const result = await environment.client.request<StoredCommandResult>('action.approvals.resolve', { commandId: crypto.randomUUID(), threadId: snapshot.thread.id, approvalId, expectedVersion: approval.version, optionId, reason: `用户选择原生选项：${optionId}。` })
      if (result.status === 'rejected') throw new Error(result.code || '授权未被接受，请刷新后重试。')
      await data.refresh()
    } catch (error) { report(error) } finally { setApprovalBusy(false) }
  }
  const stopRun = async (run: AgentRunView) => {
    const snapshot = data.snapshot
    if (!snapshot || stoppingRunIds.includes(run.id) || run.cancelRequestedAt !== null) return
    setStoppingRunIds(current => [...current, run.id])
    try {
      const result = await environment.client.request<StoredCommandResult>('agentRuns.cancel', {
        commandId: crypto.randomUUID(),
        command: { threadId: snapshot.thread.id, agentRunId: run.id, expectedVersion: run.version }
      })
      if (result.status === 'rejected') throw new Error(result.code || '停止未被接受，请刷新后重试。')
      await data.refresh()
    } catch (error) {
      report(error)
    } finally {
      setStoppingRunIds(current => current.filter(id => id !== run.id))
    }
  }
  const searchResults = useMemo(() => searchWorkspace(query, data.conversations, data.agents, data.bundles), [query, data.conversations, data.agents, data.bundles])
  const searchWork = (item: WorkItem) => safeInspectorAction(() => {
    setModal(null); setInspectorMode('work'); setInspectorOpen(true); setExpanded(false)
    const conversation = data.conversations.find(row => row.threadId === item.mission.threadId)
    if (conversation) void select(conversation, true, item.task.taskId)
    else {
      setDockSelection({ threadId: item.mission.threadId, taskId: item.task.taskId })
      void data.openConversation(item.mission.threadId).catch(report)
    }
  })
  const searchArtifact = (selection: ArtifactSelection) => safeInspectorAction(() => {
    setModal(null); setArtifact(selection)
  })
  const shortcutKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
  return <div className={`ln-app ${expanded && inspectorOpen ? 'ln-inspector-expanded' : ''}`} data-theme={theme} data-loom-frontend="native-v2">
    <BotBoard open={boardOpen} agents={data.agents} conversations={data.conversations} missions={data.missions} bundles={data.bundles} error={data.error} refresh={data.refresh} theme={theme} onClose={()=>setBoardOpen(false)} onCreate={()=>{setBoardOpen(false);manageAssistant(undefined,true)}} onDetails={row=>manageAssistant(row.key,false)} onOpen={row=>{
      setBoardOpen(false)
      if(row.threadId){setDockSelection({threadId:row.threadId,taskId:row.taskId});void data.openConversation(row.threadId).catch(report)}
    }}/>
    <PendingInbox open={pendingOpen} client={environment.client} threadIds={Array.from(new Set(data.conversations.flatMap(c=>c.threadId?[c.threadId]:[])))} theme={theme} onClose={()=>setPendingOpen(false)}/>
    <header className="ln-topbar" aria-label="LOOM 窗口栏">
      <div className="ln-window-left"><div className="ln-traffic-lights" aria-hidden="true"><i/><i/><i/></div><IconButton icon="left" label="后退" disabled={historyIndex.current <= 0} onClick={() => navigate(-1)}/><IconButton icon="right" label="前进" disabled={historyIndex.current >= selectionHistory.current.length - 1} onClick={() => navigate(1)}/></div>
      <button type="button" className="ln-search-trigger" onClick={() => { setQuery(''); setModal('search') }}><Icon name="search" size={14}/><span>搜索对话、助手、工作和成果</span><kbd>{shortcutKey} K</kbd></button>
      <div className="ln-window-actions"><button className="ln-top-work" type="button" title="等待你处理的工作" aria-label="等待你处理的工作" onClick={() => openWork()}><Icon name="chat" size={15}/>{attentionCount > 0 && <span>{attentionCount}</span>}</button></div>
    </header>
    <div className="ln-window-body"><nav className="ln-rail" aria-label="主要页面">
      <IconButton icon="home" label="对话" active={!studioOpen && !settingsSection} onClick={() => leaveSettings(() => { setSettingsSection(null); setExpanded(false); setSidebarOpen(true); if (!active) beginConversation() })}/>
      {/* rail 的 ＋ 只开新单聊；label 保持「开始新对话」（scripts/lib/loom-browser-live-mode.mjs 的 newConversation 选择器）。 */}
      <IconButton icon="plus" label="开始新对话" onClick={beginDirectConversation}/>
      <IconButton icon="board" label="工作空间" onClick={() => openWork()}/>
      <IconButton icon="dashboard" label="助手看板" active={boardOpen} onClick={() => setBoardOpen(true)}/>
      <IconButton icon="branch" label="运行与成果" active={runSurfaceOpen} onClick={() => {
        runSurfaceOpener.current=document.activeElement instanceof HTMLElement?document.activeElement:null
        setRunSurfaceOpen(true)
        // The Mission shell can be unchanged while the Lead has just written a
        // plan. An explicit open must re-read the work bundle, not only the
        // run-facts projection cached before the plan existed.
        void data.refresh().catch(report)
      }}/>
      <IconButton icon="files" label="工作目录" active={settingsSection === 'workspace'} onClick={() => openSettings('workspace')}/>
      <IconButton icon="people" label="管理助手" active={studioOpen} onClick={() => manageAssistant(activeAgent?.agentId)}/>
      <RailBottom><IconButton icon="inbox" label="待发送" active={pendingOpen} onClick={() => setPendingOpen(true)}/>{pendingCount>0&&<small aria-label={`待发送 ${pendingCount} 条`}>{pendingCount}</small>}<IconButton icon="clock" label="会话活动" onClick={() => setModal('history')}/><ProfileMenu theme={theme} shortcutKey={shortcutKey} onSettings={() => openSettings()} onHistory={() => setModal('history')} onLogout={onLogout}/></RailBottom>
    </nav>
      <section ref={frameRef} className="ln-frame" aria-label="LOOM 工作空间" style={{ '--ln-sidebar-width': `${panelWidths.sidebar}px`, '--ln-inspector-width': `${panelWidths.inspector}px` } as React.CSSProperties}>
        {settingsSection ? <SettingsPage section={settingsSection} onLeaveGuard={registerSettingsLeave} onSection={setSettingsSection} environment={environment} agents={data.agents} theme={theme} onTheme={setTheme} threadId={active?.threadId ?? undefined} onLogout={onLogout} onRefreshWorkspace={() => { void data.refresh().catch(report) }} onManageAssistants={() => manageAssistant(activeAgent?.agentId)} onStartWorkspace={root => { setSettingsSection(null); beginWorkIn(root) }} onChanged={() => { setCapabilityEpoch(value => value + 1); void data.refresh().catch(report) }}/>
        : <>{sidebarOpen && <Sidebar agents={data.agents} items={data.conversations} selectedId={data.selectedId} loading={data.loading} groupRosters={groupRosters} hidden={data.hidden} onRestoreHidden={threadId => { void data.setHidden(threadId, false) }} onSelect={item => safeInspectorAction(() => { setCapabilityDirty(false); void select(item) })} onCreate={beginConversation} onCollapse={() => setSidebarOpen(false)} onEditAssistant={agentId => manageAssistant(agentId)}/>}{sidebarOpen && <PanelResizeHandle side="sidebar" frame={frameRef} widths={panelWidths} sidebarOpen={sidebarOpen} inspectorOpen={inspectorOpen} onResize={resizePanel}/> }
        <ConversationView item={active} agents={data.agents} snapshot={data.snapshot} bundles={data.bundles} loading={data.loading} sending={sending} draft={draft.text} files={draft.files} error={sendError ?? piQuestions.error} questions={piQuestions.questions} onAnswerQuestion={piQuestions.answer} onDraft={text => patchDraft({ text })} onFiles={files => patchDraft({ files })} onSend={agentId => { void send(agentId) }} onPrompt={sendPrompt} onRetryRun={retryLastRun} onStopRun={run => { void stopRun(run) }} stoppingRunIds={stoppingRunIds} onConfigureRuntime={() => manageAssistant(activeAgent?.agentId)} onOpenRuntimeSetup={() => openSettings('runtime')} onProfile={() => manageAssistant(activeAgent?.agentId)} onWorkspaceManager={() => openSettings('workspace')} onMembers={() => setMembersOpen(true)} onArtifact={setArtifact} onShowSidebar={() => setSidebarOpen(true)} sidebarHidden={!sidebarOpen} onShowWork={() => openWork()} inspectorHidden={!inspectorOpen} onAttachment={(messageId,attachmentId) => { void openAttachment(messageId,attachmentId) }} onPreviewAttachment={previewAttachment} approvalBusy={approvalBusy} onResolveApproval={(approvalId,optionId) => { void resolveApproval(approvalId,optionId) }}/>
        {inspectorOpen && <PanelResizeHandle side="inspector" frame={frameRef} widths={panelWidths} sidebarOpen={sidebarOpen} inspectorOpen={inspectorOpen} onResize={resizePanel}/>}
        {inspectorOpen && <Inspector key={capabilityEpoch} questions={piQuestions.questions} selectedTaskId={dockSelection?.threadId === (active?.threadId ?? null) ? dockSelection?.taskId ?? null : null} onTaskSelect={taskId => setDockSelection({ threadId: active?.threadId ?? null, taskId })} threadId={active?.threadId} conversationTitle={active?.title} onCreateWork={beginWork} onConnectDevice={() => openSettings('devices')} workbench={environment.workbench} client={environment.client} theme={theme} onManageAssistant={manageAssistant} onCapabilityDirty={setCapabilityDirty} onLibrary={() => safeInspectorAction(() => { setCapabilityDirty(false); setLibraryOpen(true) })} agents={data.agents} bundles={data.bundles} agent={activeAgent} mode={inspectorMode} tab={tab} onTab={value => safeInspectorAction(() => { setTab(value); setCapabilityDirty(false) })} onMode={value => safeInspectorAction(() => { setInspectorMode(value); setCapabilityDirty(false) })} onClose={() => safeInspectorAction(() => { setInspectorOpen(false); setExpanded(false); setCapabilityDirty(false) })} onExpand={() => setExpanded(value => !value)} expanded={expanded} onArtifact={setArtifact} loading={data.loading} onOpenConversation={threadId => { const item = data.conversations.find(item => item.threadId === threadId); if (item) void select(item) }}/>}</>}</section>
    </div>
    {(notice || data.error) && <div className="ln-notice" role="alert"><span>{notice || data.error}</span><IconButton icon="refresh" label="重试读取" onClick={() => { setNotice(null); void data.refresh().catch(report) }}/><IconButton icon="close" label="关闭提示" onClick={() => setNotice(null)}/></div>}
    {visitedPanels.studio&&<Suspense fallback={<span role="status" className="ln-loading">正在打开助手编辑…</span>}><AssistantStudio threadId={active?.threadId ?? undefined} onCreatedConversation={openCreatedConversation} onOpenConnections={() => openSettings('runtime')} catalogEpoch={capabilityEpoch} open={studioOpen} environment={environment} agents={data.agents} initialAgentId={studioAgent} initialCreate={studioCreate} theme={theme} onClose={() => setStudioOpen(false)} onRefresh={data.refresh} onLibrary={() => setLibraryOpen(true)}/></Suspense>}
    {visitedPanels.room&&<Suspense fallback={<span role="status" className="ln-loading">正在打开新工作…</span>}><RoomDialog open={newRoom} initialMode={roomMode} initialWorkspace={roomInitialWorkspace} environment={environment} agents={data.agents} initialAgentId={activeAgent?.agentId} theme={theme} onClose={() => setNewRoom(false)} onCreated={openCreatedConversation} onNewAssistant={() => manageAssistant()}/></Suspense>}
    {visitedPanels.members&&<Suspense fallback={null}><RoomMembersDialog open={membersOpen} environment={environment} agents={data.agents} snapshot={data.snapshot} theme={theme} onClose={() => setMembersOpen(false)} onRefresh={data.refresh}/></Suspense>}
    {visitedPanels.library&&<Suspense fallback={<span role="status" className="ln-loading">正在打开能力库…</span>}><CapabilityLibrary open={libraryOpen} environment={environment} theme={theme} onClose={() => setLibraryOpen(false)} onChanged={() => { setCapabilityEpoch(value => value + 1); void data.refresh() }}/></Suspense>}
    <SurfaceDialog open={pendingInspectorAction !== null} title="保留能力修改？" theme={theme} onClose={() => setPendingInspectorAction(null)} className="ln-room-dialog"><UnsavedNotice onKeep={() => setPendingInspectorAction(null)} onDiscard={() => { const action = pendingInspectorAction; setPendingInspectorAction(null); setCapabilityDirty(false); action?.() }}/></SurfaceDialog>
    <RunStatusDialog open={runSurfaceOpen} port={environment.client} bundle={selectedRunBundle} thread={data.snapshot} agents={data.agents} theme={theme}
      onRefreshWork={data.refresh}
      onClose={() => setRunSurfaceOpen(false)} onCreateWork={() => { setRunSurfaceOpen(false); beginWork() }}
      onArtifact={selection => { setRunSurfaceOpen(false); setArtifact(selection) }}/>
    {artifact && <ArtifactView key={`${artifact.bundle.mission.missionId}:${artifact.artifact.artifactId}:${artifact.candidate?.candidateId ?? "none"}`} theme={theme} fallbackFocus={runSurfaceOpener.current} selection={currentArtifact?.selection ?? artifact} contextAvailable={currentArtifact?.contextAvailable ?? false} onClose={() => setArtifact(null)} onRefresh={data.refresh}/>}
    <Dialog.Root open={modal !== null} onOpenChange={open => { if (!open) setModal(null) }}><Dialog.Portal><div className="ln-portal" data-theme={theme}><Dialog.Overlay className="ln-modal-backdrop"/><Dialog.Content className={`ln-dialog${modal === 'search' ? ' ln-search-dialog' : ''}`} aria-describedby={undefined}><header><Dialog.Title>{modal === 'search' ? '搜索' : '会话活动'}</Dialog.Title><Dialog.Close asChild><button type="button" className="ln-icon-button" aria-label="关闭"><Icon name="close"/></button></Dialog.Close></header>
      {modal === 'search' && <><div className="ln-search-field"><Icon name="search"/><input placeholder="搜索对话、助手、工作或文件名…" aria-label="全局搜索" value={query} onChange={event => setQuery(event.target.value)} autoFocus/></div><WorkspaceSearch results={searchResults} query={query} onConversation={item => safeInspectorAction(() => { void select(item); setModal(null) })} onAssistant={agentId => { setModal(null); manageAssistant(agentId) }} onWork={searchWork} onArtifact={searchArtifact}/></>}
      {modal === 'history' && <div className="ln-dialog-results"><RunActivityHistory runs={data.snapshot?.agentRuns ?? []} agents={data.agents} sending={sending} onRetry={retryLastRun}/></div>}
    </Dialog.Content></div></Dialog.Portal></Dialog.Root>
  </div>
}

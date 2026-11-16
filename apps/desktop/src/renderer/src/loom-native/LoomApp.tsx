import type { StoredCommandResult,WorkspaceSelection } from '@contracts'
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { BusinessEnvironment } from '../business-environment'
import type { ArtifactSelection, ConversationItem, InspectorTab, InspectorMode, WorkItem } from './types'
import { useLoomData } from './useLoomData'
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
import { WorkspaceManager } from './WorkspaceManager'
import { RunStatusDialog } from './RunStatusDialog'
import { storedPanelWidth, fittedPanelWidths, type PanelSide, type PanelWidths } from './panel-resize'

// Load optional editors only when opened; keep them mounted after first use so
// transport-unknown drafts cannot be discarded by closing a modal.
const NativeSetup = lazy(() => import('./NativeSetup').then(v => ({default:v.NativeSetup})))
const AssistantStudio = lazy(() => import('./AssistantStudio').then(v => ({default:v.AssistantStudio})))
const CapabilityLibrary = lazy(() => import('./CapabilityLibrary').then(v => ({default:v.CapabilityLibrary})))
const RoomDialog = lazy(() => import('./RoomDialog').then(v => ({default:v.RoomDialog})))
const RoomMembersDialog = lazy(() => import('./RoomDialog').then(v => ({default:v.RoomMembersDialog})))

type Props = { environment: BusinessEnvironment; remoteConnection?: ReactNode; onLogout?(): void; initialStartupSnapshot?: unknown; startupStartedAtMs?: number }
type Draft = { text: string; files: File[] }

/** PiBot-style React/Vite application frame with a new Mikka-reference component
 * tree. Only the authenticated adapter, domain types and animated avatar are shared. */
export function LoomApp({ environment, onLogout }: Props) {
  const data = useLoomData(environment)
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
  const [modal, setModal] = useState<'search' | 'settings' | 'history' | null>(null)
  const [newRoom, setNewRoom] = useState(false)
  const [workspaceManagerOpen,setWorkspaceManagerOpen] = useState(false)
  const [runSurfaceOpen, setRunSurfaceOpen] = useState(false)
  const runSurfaceOpener = useRef<HTMLElement | null>(null)
  const [roomInitialWorkspace,setRoomInitialWorkspace] = useState<WorkspaceSelection|null>(null)
  const [roomMode, setRoomMode] = useState<'group' | 'work'>('group')
  const beginConversation = () => { setRoomInitialWorkspace(null);setRoomMode('group'); setNewRoom(true) }
  const beginWork = () => { setRoomInitialWorkspace(null);setRoomMode('work'); setNewRoom(true) }
  const beginWorkIn = (root:WorkspaceSelection) => {setRoomInitialWorkspace(root);setRoomMode('work');setNewRoom(true)}
  const [membersOpen, setMembersOpen] = useState(false)
  const [studioOpen, setStudioOpen] = useState(false)
  const [studioAgent, setStudioAgent] = useState<string | undefined>()
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [visitedPanels,setVisitedPanels]=useState({setup:false,studio:false,room:false,members:false,library:false})
  useEffect(()=>{
    setVisitedPanels(value=>{
      const next={setup:value.setup||setupOpen,studio:value.studio||studioOpen,room:value.room||newRoom,
        members:value.members||membersOpen,library:value.library||libraryOpen}
      return Object.keys(next).every(key=>next[key as keyof typeof next]===value[key as keyof typeof next]) ? value : next
    })
  },[setupOpen,studioOpen,newRoom,membersOpen,libraryOpen])

  const [dockSelection, setDockSelection] = useState<{ threadId: string | null; taskId: string | null } | null>(null)
  const [capabilityEpoch, setCapabilityEpoch] = useState(0)
  const [capabilityDirty, setCapabilityDirty] = useState(false)
  const [pendingInspectorAction, setPendingInspectorAction] = useState<(() => void) | null>(null)
  const safeInspectorAction = (action: () => void) => { if (capabilityDirty) setPendingInspectorAction(() => action); else action() }
  const manageAssistant = (agentId?: string) => { setStudioAgent(agentId); setStudioOpen(true) }
  const [query, setQuery] = useState('')
  const [artifact, setArtifact] = useState<ArtifactSelection | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [approvalBusy, setApprovalBusy] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const selectionHistory = useRef<ConversationItem[]>([])
  const historyIndex = useRef(-1)
  const [, updateHistory] = useState(0)
  const active = data.conversations.find(item => item.id === data.selectedId) ?? null
  const selectedRunBundle = data.bundles.find(bundle => bundle.mission.missionId === active?.missionId) ?? null
  const currentArtifact = useMemo(() => artifact === null ? null : refreshArtifactSelection(artifact, data.bundles), [artifact, data.bundles])
  const activeAgent = data.agents.find(agent => agent.agentId === (active?.agentId || data.snapshot?.thread.defaultLeadAgentId)) ?? null
  const draftKey = data.selectedId || 'new'
  const latestDraftKey = useRef(draftKey)
  latestDraftKey.current = draftKey
  const draft = drafts[draftKey] ?? { text: '', files: [] }
  const work = useMemo(() => flattenWork(data.bundles), [data.bundles])
  const attentionCount = work.filter(item => workStatus(item).group === '等待你').length
  const report = (error: unknown) => setNotice(error instanceof Error ? error.message : String(error))
  const select = async (item: ConversationItem, remember = true, taskId: string | null = null) => {
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
  const send = async (agentId?: string) => {
    if (sending) return
    const key = draftKey; const submitted = { ...draft }
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
  const openWork = (mode: InspectorMode = 'work') => safeInspectorAction(() => { setCapabilityDirty(false); setInspectorMode(mode); setInspectorOpen(true); setExpanded(false) })

  useEffect(() => {
    document.title = 'LOOM'
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setQuery(''); setModal('search') }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); setSidebarOpen(value => !value) }
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
    <header className="ln-topbar" aria-label="LOOM 窗口栏">
      <div className="ln-window-left"><div className="ln-traffic-lights" aria-hidden="true"><i/><i/><i/></div><IconButton icon="left" label="后退" disabled={historyIndex.current <= 0} onClick={() => navigate(-1)}/><IconButton icon="right" label="前进" disabled={historyIndex.current >= selectionHistory.current.length - 1} onClick={() => navigate(1)}/></div>
      <button type="button" className="ln-search-trigger" onClick={() => { setQuery(''); setModal('search') }}><Icon name="search" size={14}/><span>搜索对话、助手、工作和成果</span><kbd>{shortcutKey} K</kbd></button>
      <div className="ln-window-actions"><button className="ln-top-work" type="button" title="等待你处理的工作" aria-label="等待你处理的工作" onClick={() => openWork()}><Icon name="chat" size={15}/>{attentionCount > 0 && <span>{attentionCount}</span>}</button><IconButton icon="globe" label="连接与设置" onClick={() => setSetupOpen(true)}/></div>
    </header>
    <div className="ln-window-body"><nav className="ln-rail" aria-label="主要页面">
      <IconButton icon="home" label="对话" active={!studioOpen && !setupOpen} onClick={() => { setExpanded(false); setSidebarOpen(true); if (!active) beginConversation() }}/>
      <IconButton icon="plus" label="开始新对话" onClick={beginConversation}/>
      <IconButton icon="board" label="工作空间" onClick={() => openWork()}/>
      <IconButton icon="branch" label="运行与成果" active={runSurfaceOpen} onClick={() => { runSurfaceOpener.current=document.activeElement instanceof HTMLElement?document.activeElement:null; setRunSurfaceOpen(true) }}/>
      <IconButton icon="files" label="工作目录" onClick={() => setWorkspaceManagerOpen(true)}/>
      <IconButton icon="people" label="管理助手" active={studioOpen} onClick={() => manageAssistant(activeAgent?.agentId)}/>
      <IconButton icon="globe" label="连接与设备" active={setupOpen} onClick={() => setSetupOpen(true)}/>
      <div className="ln-rail-bottom"><IconButton icon="clock" label="会话活动" onClick={() => setModal('history')}/><IconButton icon="settings" label="设置" onClick={() => setModal('settings')}/><button type="button" className="ln-user-button" aria-label="个人与连接设置" onClick={() => setModal('settings')}>L</button></div>
    </nav>
      <section ref={frameRef} className="ln-frame" aria-label="LOOM 工作空间" style={{ '--ln-sidebar-width': `${panelWidths.sidebar}px`, '--ln-inspector-width': `${panelWidths.inspector}px` } as React.CSSProperties}>
        {sidebarOpen && <Sidebar agents={data.agents} items={data.conversations} selectedId={data.selectedId} loading={data.loading} onSelect={item => safeInspectorAction(() => { setCapabilityDirty(false); void select(item) })} onCreate={beginConversation} onCollapse={() => setSidebarOpen(false)} onEditAssistant={agentId => manageAssistant(agentId)}/>}{sidebarOpen && <PanelResizeHandle side="sidebar" frame={frameRef} widths={panelWidths} sidebarOpen={sidebarOpen} inspectorOpen={inspectorOpen} onResize={resizePanel}/> }
        <ConversationView item={active} agents={data.agents} snapshot={data.snapshot} bundles={data.bundles} loading={data.loading} sending={sending} draft={draft.text} files={draft.files} error={sendError} onDraft={text => patchDraft({ text })} onFiles={files => patchDraft({ files })} onSend={agentId => { void send(agentId) }} onProfile={() => manageAssistant(activeAgent?.agentId)} onWorkspaceManager={() => setWorkspaceManagerOpen(true)} onMembers={() => setMembersOpen(true)} onArtifact={setArtifact} onShowSidebar={() => setSidebarOpen(true)} sidebarHidden={!sidebarOpen} onShowWork={() => openWork()} inspectorHidden={!inspectorOpen} onAttachment={(messageId,attachmentId) => { void openAttachment(messageId,attachmentId) }} approvalBusy={approvalBusy} onResolveApproval={(approvalId,optionId) => { void resolveApproval(approvalId,optionId) }}/>
        {inspectorOpen && <PanelResizeHandle side="inspector" frame={frameRef} widths={panelWidths} sidebarOpen={sidebarOpen} inspectorOpen={inspectorOpen} onResize={resizePanel}/>}
        {inspectorOpen && <Inspector key={capabilityEpoch} selectedTaskId={dockSelection?.threadId === (active?.threadId ?? null) ? dockSelection?.taskId ?? null : null} onTaskSelect={taskId => setDockSelection({ threadId: active?.threadId ?? null, taskId })} threadId={active?.threadId} conversationTitle={active?.title} onCreateWork={beginWork} workbench={environment.workbench} client={environment.client} theme={theme} onManageAssistant={manageAssistant} onCapabilityDirty={setCapabilityDirty} onLibrary={() => safeInspectorAction(() => { setCapabilityDirty(false); setLibraryOpen(true) })} agents={data.agents} bundles={data.bundles} agent={activeAgent} mode={inspectorMode} tab={tab} onTab={value => safeInspectorAction(() => { setTab(value); setCapabilityDirty(false) })} onMode={value => safeInspectorAction(() => { setInspectorMode(value); setCapabilityDirty(false) })} onClose={() => safeInspectorAction(() => { setInspectorOpen(false); setExpanded(false); setCapabilityDirty(false) })} onExpand={() => setExpanded(value => !value)} expanded={expanded} onArtifact={setArtifact} loading={data.loading} onOpenConversation={threadId => { const item = data.conversations.find(item => item.threadId === threadId); if (item) void select(item) }}/>}</section>
    </div>
    {(notice || data.error) && <div className="ln-notice" role="alert"><span>{notice || data.error}</span><IconButton icon="refresh" label="重试读取" onClick={() => { setNotice(null); void data.refresh().catch(report) }}/><IconButton icon="close" label="关闭提示" onClick={() => setNotice(null)}/></div>}
    {visitedPanels.setup&&<Suspense fallback={<span role="status" className="ln-loading">正在打开连接与设备…</span>}><NativeSetup open={setupOpen} environment={environment} theme={theme} threadId={active?.threadId ?? undefined} onClose={() => setSetupOpen(false)} onChanged={() => { setCapabilityEpoch(value => value + 1); void data.refresh().catch(report) }} onManageAssistants={() => manageAssistant(activeAgent?.agentId)}/></Suspense>}
    {visitedPanels.studio&&<Suspense fallback={<span role="status" className="ln-loading">正在打开助手编辑…</span>}><AssistantStudio onCreatedConversation={data.openConversation} onOpenConnections={() => setSetupOpen(true)} catalogEpoch={capabilityEpoch} open={studioOpen} environment={environment} agents={data.agents} initialAgentId={studioAgent} theme={theme} onClose={() => setStudioOpen(false)} onRefresh={data.refresh} onLibrary={() => setLibraryOpen(true)}/></Suspense>}
    <WorkspaceManager open={workspaceManagerOpen} environment={environment} theme={theme}
      onClose={()=>setWorkspaceManagerOpen(false)} onStart={beginWorkIn}/>
    {visitedPanels.room&&<Suspense fallback={<span role="status" className="ln-loading">正在打开新工作…</span>}><RoomDialog open={newRoom} initialMode={roomMode} initialWorkspace={roomInitialWorkspace} environment={environment} agents={data.agents} initialAgentId={activeAgent?.agentId} theme={theme} onClose={() => setNewRoom(false)} onCreated={data.openConversation}/></Suspense>}
    {visitedPanels.members&&<Suspense fallback={null}><RoomMembersDialog open={membersOpen} environment={environment} agents={data.agents} snapshot={data.snapshot} theme={theme} onClose={() => setMembersOpen(false)} onRefresh={data.refresh}/></Suspense>}
    {visitedPanels.library&&<Suspense fallback={<span role="status" className="ln-loading">正在打开能力库…</span>}><CapabilityLibrary open={libraryOpen} environment={environment} theme={theme} onClose={() => setLibraryOpen(false)} onChanged={() => { setCapabilityEpoch(value => value + 1); void data.refresh() }}/></Suspense>}
    <SurfaceDialog open={pendingInspectorAction !== null} title="保留能力修改？" theme={theme} onClose={() => setPendingInspectorAction(null)} className="ln-room-dialog"><UnsavedNotice onKeep={() => setPendingInspectorAction(null)} onDiscard={() => { const action = pendingInspectorAction; setPendingInspectorAction(null); setCapabilityDirty(false); action?.() }}/></SurfaceDialog>
    <RunStatusDialog open={runSurfaceOpen} port={environment.client} bundle={selectedRunBundle} thread={data.snapshot} agents={data.agents} theme={theme}
      onClose={() => setRunSurfaceOpen(false)} onCreateWork={() => { setRunSurfaceOpen(false); beginWork() }}
      onArtifact={selection => { setRunSurfaceOpen(false); setArtifact(selection) }}/>
    {artifact && <ArtifactView key={`${artifact.bundle.mission.missionId}:${artifact.artifact.artifactId}:${artifact.candidate?.candidateId ?? "none"}`} theme={theme} fallbackFocus={runSurfaceOpener.current} selection={currentArtifact?.selection ?? artifact} contextAvailable={currentArtifact?.contextAvailable ?? false} onClose={() => setArtifact(null)} onRefresh={data.refresh}/>}
    <Dialog.Root open={modal !== null} onOpenChange={open => { if (!open) setModal(null) }}><Dialog.Portal><div className="ln-portal" data-theme={theme}><Dialog.Overlay className="ln-modal-backdrop"/><Dialog.Content className={`ln-dialog${modal === 'search' ? ' ln-search-dialog' : ''}`} aria-describedby={undefined}><header><Dialog.Title>{modal === 'search' ? '搜索' : modal === 'history' ? '会话活动' : '设置'}</Dialog.Title><Dialog.Close asChild><button type="button" className="ln-icon-button" aria-label="关闭"><Icon name="close"/></button></Dialog.Close></header>
      {modal === 'search' && <><div className="ln-search-field"><Icon name="search"/><input placeholder="搜索对话、助手、工作或文件名…" aria-label="全局搜索" value={query} onChange={event => setQuery(event.target.value)} autoFocus/></div><WorkspaceSearch results={searchResults} query={query} onConversation={item => safeInspectorAction(() => { void select(item); setModal(null) })} onAssistant={agentId => { setModal(null); manageAssistant(agentId) }} onWork={searchWork} onArtifact={searchArtifact}/></>}
      {modal === 'history' && <div className="ln-dialog-results">{data.snapshot?.agentRuns.slice().reverse().map(run => <div className="ln-settings-row" key={run.id}><span>{data.agents.find(agent => agent.agentId === run.agentId)?.displayName || '助手'}</span><span>{({ queued:'排队中', running:'执行中', waiting:'等待中', succeeded:'已完成', failed:'失败', cancelled:'已取消' })[run.status]}</span></div>)}{!data.snapshot?.agentRuns.length && <p className="ln-inspector-empty">当前对话暂无执行活动</p>}</div>}
      {modal === 'settings' && <><div className="ln-settings-row"><span>外观</span><select value={theme} aria-label="外观主题" onChange={event => setTheme(event.target.value as 'day' | 'night')}><option value="day">浅色</option><option value="night">深色</option></select></div><div className="ln-settings-row"><span>工作空间</span><button className="ln-action" type="button" onClick={()=>{setModal(null);setWorkspaceManagerOpen(true)}}>管理工作目录</button></div><div className="ln-settings-row"><span>刷新工作空间</span><IconButton icon="refresh" label="刷新工作空间" onClick={() => { void data.refresh().catch(report) }}/></div><p className="ln-settings-copy">助手和任务由当前连接的主机提供。电脑屏幕仅在接入真实屏幕服务后显示。</p>{onLogout && <button className="ln-text-action" type="button" onClick={onLogout}>退出当前连接</button>}</>}
    </Dialog.Content></div></Dialog.Portal></Dialog.Root>
  </div>
}

import { useEffect, useMemo, useState } from 'react'
import { loomLatestCandidate } from '@contracts'
import type { ThreadClient } from '../camp-client'
import type { HostWorkbench } from './host-services'
import type { AgentProfile, ArtifactSelection, InspectorTab, InspectorMode, WorkBundle, WorkItem } from './types'
import { Avatar } from './Avatar'
import { Icon, IconButton, type IconName } from './icons'
import { Markdown } from './ConversationView'
import { ChoiceMenu } from './Controls'
import { WorkMap } from './WorkMap'
import { ComputerWorkspace } from './ComputerWorkspace'
import { modeFor, panelFor, scopedBundles, type WorkspacePanel, type WorkspaceScope } from './workspace-panel'

export function relativeDate(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const days = Math.floor((Date.now() - date.getTime()) / 86400000)
  if (days < 1) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days}天前`
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
export function workStatus(item: WorkItem): { label: string; group: string; icon: IconName } {
  if (item.task.status === 'blocked') return { label: '受阻', group: '受阻', icon: 'blocked' }
  if (item.candidate?.acceptanceStatus === 'pending') return { label: '等待审阅', group: '等待你', icon: 'hand' }
  if (item.task.status === 'in_review') return { label: '审查中', group: '进行中', icon: 'progress' }
  if (item.task.status === 'done') return { label: item.candidate?.acceptanceStatus === 'accepted' ? '已接受' : '执行已结束', group: '已完成', icon: 'check' }
  if (item.task.status === 'canceled') return { label: '已取消', group: '已完成', icon: 'check' }
  if (item.task.assigneeAgentId && item.mission.runningAgentIds.includes(item.task.assigneeAgentId)) return { label: '进行中', group: '进行中', icon: 'progress' }
  return { label: item.task.status === 'draft' ? '计划中' : '待开始', group: '待开始', icon: 'clock' }
}
export function flattenWork(bundles: WorkBundle[]): WorkItem[] {
  return bundles.flatMap(bundle => bundle.tasks.map(task => ({ task, mission: bundle.mission,
    candidate: loomLatestCandidate(task.taskId, bundle.candidates) })))
}

const PANELS: { id: WorkspacePanel; label: string; icon: IconName }[] = [
  { id: 'work', label: '工作', icon: 'board' }, { id: 'assets', label: '资产', icon: 'files' },
  { id: 'flow', label: '流程', icon: 'branch' }, { id: 'computer', label: '电脑', icon: 'computer' }
]
type Props = {
  agents: AgentProfile[]; bundles: WorkBundle[]; agent: AgentProfile | null; mode: InspectorMode; tab: InspectorTab
  onTab(tab: InspectorTab): void; onMode(mode: InspectorMode): void; onClose(): void; onExpand(): void; expanded: boolean
  onArtifact(selection: ArtifactSelection): void; onOpenConversation(threadId: string): void; loading: boolean
  workbench?: HostWorkbench; client?: ThreadClient; theme?: 'day' | 'night'
  onManageAssistant?(agentId?: string): void; onCapabilityDirty?(dirty: boolean): void; onLibrary?(): void
  threadId?: string | null; conversationTitle?: string; onCreateWork?(): void
  selectedTaskId?: string | null; onTaskSelect?(taskId: string | null): void
}

/** One contextual workspace: tabs change the view, never the selected conversation. */
export function Inspector({ agents, bundles, agent, mode, tab, onMode, onClose, onExpand, expanded,
  onArtifact, onOpenConversation, loading, client, theme = 'day', onManageAssistant, workbench,
  threadId = null, conversationTitle, onCreateWork, selectedTaskId: controlledTaskId, onTaskSelect }: Props) {
  const panel = panelFor(mode, tab)
  const [scope, setScope] = useState<WorkspaceScope>('conversation')
  const [query, setQuery] = useState('')
  const [owner, setOwner] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [localTaskId, setLocalTaskId] = useState<string | null>(null)
  const selectedTaskId = controlledTaskId === undefined ? localTaskId : controlledTaskId
  const setSelectedTaskId = (value: string | null) => { setLocalTaskId(value); onTaskSelect?.(value) }
  const [assetView, setAssetView] = useState<'files' | 'lineage'>('files')
  useEffect(() => { setLocalTaskId(null); setQuery(''); setOwner('') }, [threadId])
  const currentBundles = useMemo(() => scopedBundles(bundles, threadId, scope), [bundles, threadId, scope])
  const all = useMemo(() => flattenWork(currentBundles), [currentBundles])
  const shown = all.filter(item => (!query || `${item.task.title} ${item.task.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && (!owner || item.task.assigneeAgentId === owner))
  const selectedTask = all.find(item => item.task.taskId === selectedTaskId) ?? null
  const assets = currentBundles.flatMap(bundle => bundle.artifacts.map(artifact => ({ artifact, bundle,
    candidate: bundle.candidates.find(candidate => candidate.evidenceIds.includes(artifact.artifactId)) ?? null })))
  const attentionCount = all.filter(item => workStatus(item).group === '等待你').length
  const changePanel = (value: WorkspacePanel) => { onMode(modeFor(value)); setSearchOpen(false) }
  const renderAssets = (onlyTask?: string) => {
    const rows = assets.filter(selection => (!onlyTask || selection.artifact.taskId === onlyTask)
      && (!query || selection.artifact.relativePath.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
    return <div className="ln-assets-list">{rows.map(selection => <button key={selection.artifact.artifactId} type="button" className="ln-asset-row" onClick={() => onArtifact(selection)}>
      <span className="ln-document-icon"><Icon name="file" size={23}/></span><span><strong>{selection.artifact.relativePath.split(/[\\/]/).pop()}</strong><small>{selection.bundle.mission.title} · {relativeDate(selection.artifact.createdAt)}</small></span><Icon name="right" size={14}/>
    </button>)}{!rows.length && <div className="ln-dock-empty"><Icon name="files" size={30}/><strong>{query ? '没有匹配的成果' : '成果会留在这里'}</strong><p>文档、代码和版本记录会随工作自动归档。打开文件不会自动接受成果。</p>{scope === 'conversation' && threadId && <button type="button" className="ln-text-action" onClick={() => setScope('all')}>查看所有工作中的资产</button>}</div>}</div>
  }
  const renderWork = () => <div className="ln-work-groups">{['等待你', '进行中', '受阻', '待开始', '已完成'].map(group => {
    const rows = shown.filter(item => workStatus(item).group === group)
    if (!rows.length) return null
    const list = <div className="ln-task-list">{rows.map(item => {
      const status = workStatus(item); const member = agents.find(person => person.agentId === item.task.assigneeAgentId)
      return <button className="ln-task-card" type="button" key={item.task.taskId} onClick={() => setSelectedTaskId(item.task.taskId)}><Icon name={status.icon} size={21}/><span className="ln-task-content"><span className="ln-task-firstline"><strong>{item.task.title}</strong><time>{relativeDate(item.task.updatedAt)}</time></span><span className="ln-task-subtitle">{member && <Avatar agent={member} size={12}/>}<span>{member?.displayName || '未指派'} · {item.task.blockedReason || item.task.description || status.label}</span></span></span><Icon name="right" size={14}/></button>
    })}</div>
    return group === '已完成' ? <details key={group} className="ln-completed-group"><summary><span>{group}（{rows.length}）</span><i/><Icon name="right" size={13}/></summary>{list}</details>
      : <section key={group} className="ln-work-group"><h3>{group}（{rows.length}）<i/></h3>{list}</section>
  })}{!shown.length && <div className="ln-dock-empty"><Icon name="board" size={30}/><strong>{loading ? '正在读取工作' : query || owner ? '没有匹配的工作' : '从一个目标开始'}</strong><p>{scope === 'conversation' && threadId ? '这段对话还没有关联的任务。创建工作后，就能在这里跟进分工和成果。' : '把目标交给主助手，分工、待你处理的决定和成果都会出现在这里。'}</p>{onCreateWork && !loading && <button type="button" className="ln-action" onClick={onCreateWork}>创建一项工作</button>}{scope === 'conversation' && threadId && <button type="button" className="ln-text-action" onClick={() => setScope('all')}>查看所有工作</button>}</div>}</div>
  return <aside className={`ln-inspector ln-workspace-dock${expanded ? ' is-expanded' : ''}`} aria-label="工作空间面板">
    <header className="ln-inspector-header"><div className="ln-dock-heading"><strong>工作空间</strong><small title={conversationTitle}>{conversationTitle || '与你的助手一起完成工作'}</small></div>
      <div className="ln-inspector-header-actions">{panel === 'work' && onCreateWork && <IconButton icon="plus" label="创建工作" onClick={onCreateWork}/>}<IconButton icon="search" label="搜索工作空间" disabled={panel === 'computer'} onClick={() => setSearchOpen(value => !value)}/><IconButton icon="expand" label={expanded ? '还原面板' : '展开面板'} onClick={onExpand}/><IconButton icon="close" label="关闭右侧面板" onClick={onClose}/></div>
    </header>
    <nav className="ln-dock-tabs" aria-label="工作空间分区" role="tablist">{PANELS.map((entry, index) => <button type="button" role="tab" id={`workspace-tab-${entry.id}`} aria-controls={`workspace-panel-${entry.id}`} aria-selected={panel === entry.id} tabIndex={panel === entry.id ? 0 : -1} key={entry.id} className={panel === entry.id ? 'is-selected' : ''}
      onClick={() => changePanel(entry.id)} onKeyDown={event => { let next = index; if (event.key === 'ArrowRight') next = (index + 1) % PANELS.length; else if (event.key === 'ArrowLeft') next = (index + PANELS.length - 1) % PANELS.length; else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = PANELS.length - 1; else return; event.preventDefault(); changePanel(PANELS[next].id); document.getElementById(`workspace-tab-${PANELS[next].id}`)?.focus() }}>
      <Icon name={entry.icon} size={16}/><span>{entry.label}</span>{entry.id === 'work' && attentionCount > 0 && <i>{attentionCount}</i>}</button>)}</nav>
    {panel !== 'computer' && <div className="ln-dock-context"><ChoiceMenu label="工作空间范围" value={threadId ? scope : 'all'} onChange={value => { setScope(value as WorkspaceScope); setSelectedTaskId(null) }} theme={theme} choices={[{ value: 'conversation', label: '本次对话', disabled: !threadId }, { value: 'all', label: '所有工作' }]}/>
      {panel === 'work' && <ChoiceMenu label="筛选负责人" value={owner} onChange={setOwner} theme={theme} choices={[{ value: '', label: '全部负责人' }, ...agents.filter(person => !person.removedAt).map(person => ({ value: person.agentId, label: person.displayName, icon: <Avatar agent={person} size={18}/> }))]}/>}
      {panel === 'assets' && <div className="ln-dock-view-switch"><button type="button" aria-pressed={assetView === 'files'} onClick={() => setAssetView('files')}>文件</button><button type="button" aria-pressed={assetView === 'lineage'} onClick={() => setAssetView('lineage')}>版本关系</button></div>}
    </div>}
    {selectedTask && panel !== 'computer' && <div className="ln-dock-task-context"><Icon name="board" size={13}/><span title={selectedTask.task.title}>{selectedTask.task.title}</span><IconButton icon="close" label="清除关联任务" onClick={() => setSelectedTaskId(null)}/></div>}
    {searchOpen && <div className="ln-inspector-search"><Icon name="search" size={15}/><input aria-label="搜索当前工作空间" placeholder={panel === 'assets' ? '查找文件…' : '查找工作…'} value={query} onChange={event => setQuery(event.target.value)} autoFocus/><IconButton icon="close" label="关闭搜索" onClick={() => { setSearchOpen(false); setQuery('') }}/></div>}
    <div className="ln-inspector-scroll" role="tabpanel" id={`workspace-panel-${panel}`} aria-labelledby={`workspace-tab-${panel}`}>
      {panel === 'computer' ? <><div className="ln-dock-agent">{agent ? <><Avatar agent={agent} size={30}/><span><strong>{agent.displayName}</strong><small>查看、手动控制和助手控制分别授权</small></span><button type="button" className="ln-text-action" onClick={() => onManageAssistant?.(agent.agentId)}>配置</button></> : <p>选择助手后可查看对应的执行位置和授权。</p>}</div><ComputerWorkspace workbench={workbench} client={client} agent={agent} theme={theme}/></>
        : panel === 'flow' || panel === 'assets' && assetView === 'lineage' ? client ? <WorkMap bundles={currentBundles} agents={agents} client={client} onArtifact={onArtifact} onConversation={onOpenConversation} focusedTaskId={selectedTaskId} onTaskSelect={setSelectedTaskId} initialView={panel === 'assets' ? 'assets' : 'flow'} hideViewTabs/> : <p className="ln-inspector-empty">当前连接未提供工作关系。</p>
        : panel === 'assets' ? renderAssets(selectedTaskId ?? undefined)
        : selectedTask ? <section className="ln-task-detail"><button type="button" className="ln-text-action ln-dock-back" onClick={() => setSelectedTaskId(null)}><Icon name="left" size={14}/>所有工作</button><h1>{selectedTask.task.title}</h1><span className="ln-detail-status"><Icon name={workStatus(selectedTask).icon} size={16}/>{workStatus(selectedTask).label}</span><Markdown text={selectedTask.task.description || '此任务没有补充说明。'}/>{selectedTask.task.blockedReason && <p className="ln-inline-error">{selectedTask.task.blockedReason}</p>}<h3>交付成果</h3>{renderAssets(selectedTask.task.taskId)}<button type="button" className="ln-text-action" onClick={() => onOpenConversation(selectedTask.mission.threadId)}><Icon name="chat" size={15}/>打开相关对话</button></section> : renderWork()}
    </div>
  </aside>
}

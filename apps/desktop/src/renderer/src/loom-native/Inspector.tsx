import { useEffect, useMemo, useState } from 'react'
import { loomLatestCandidate } from '@contracts'
import type { ThreadClient } from '../camp-client'
import type { HostWorkbench } from './host-services'
import type { AgentProfile, ArtifactSelection, InspectorTab, InspectorMode, LoomReview, WorkBundle, WorkControlFacts, WorkItem } from './types'
import type { PiQuestion } from './pi-questions'
import { Avatar } from './Avatar'
import { Icon, IconButton, type IconName } from './icons'
import { AgentMarkdown } from './AgentMarkdown'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './EmptyState'
import { ChoiceMenu } from './Controls'
import { WorkMap } from './WorkMap'
import { ComputerWorkspace } from './ComputerWorkspace'
import { modeFor, panelFor, scopedBundles, type WorkspacePanel, type WorkspaceScope } from './workspace-panel'
import { artifactCandidateFacts, artifactReviewKind, artifactReviewLabel, type ArtifactReviewKind } from './artifact-service'
import { summarizeAttention, type AttentionFact } from './attention'

export function relativeDate(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const days = Math.floor((Date.now() - date.getTime()) / 86400000)
  if (days < 1) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days}天前`
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

/**
 * 一张任务卡片上的事实：任务 + 链头候选 + 归档证据是否存在 + 验收/控制投影。
 * 全部取自同一个 Bundle，不在界面里另存一份状态。
 */
export type WorkItemFacts = WorkItem & {
  waitingForAnswer?: boolean
  /** 链头候选的证据确实在归档里（false＝候选已登记但归档还没见到） */
  hasArtifact: boolean
  reviews: readonly LoomReview[]
  control?: WorkControlFacts
}

/** `flattenWork` 之外调用时可缺省：缺省不当作「没有评审」，只是界面还没拿到那几份事实。 */
export type WorkStatusInput = WorkItem & {
  waitingForAnswer?: boolean
  hasArtifact?: boolean
  reviews?: readonly LoomReview[]
  control?: WorkControlFacts
}

const REVIEW_GROUP: Record<ArtifactReviewKind, string | null> = {
  // none / ready：成果侧没有结论，卡片沿用任务状态本身（待开始、进行中、已取消…）。
  none: null,
  preparing: '进行中',
  ready: null,
  reviewing: '进行中',
  fixing: '进行中',
  review: '等待你',
  accepted: '已完成',
  blocked: '受阻'
}
const REVIEW_ICON: Record<ArtifactReviewKind, IconName | null> = {
  none: null,
  preparing: 'progress',
  ready: null,
  reviewing: 'progress',
  fixing: 'progress',
  review: 'hand',
  accepted: 'check',
  blocked: 'blocked'
}

/**
 * 卡片状态：先看成果侧的真实结论（M7-C），只有它不下结论时才沿用任务状态本身。
 * 关键约束：助手审查还在办、或控制事实还没读到，候选的 `pending` 都不是「等你」。
 */
export function workStatus(item: WorkStatusInput): { label: string; group: string; icon: IconName } {
  if (item.waitingForAnswer) return { label: '等你回答', group: '等待你', icon: 'chat' }
  const kind = artifactReviewKind({
    // 卡片只跟链头候选：链头没有归档证据时才是「准备中」。
    hasArtifact: item.hasArtifact ?? item.candidate !== null,
    taskId: item.task.taskId,
    taskStatus: item.task.status,
    blockedReason: item.task.blockedReason,
    candidate: item.candidate,
    latest: true,
    reviews: item.reviews ?? [],
    control: item.control
  })
  const group = REVIEW_GROUP[kind]
  const icon = REVIEW_ICON[kind]
  if (group !== null && icon !== null) return { label: artifactReviewLabel(kind), group, icon }
  if (item.task.status === 'blocked') return { label: '受阻', group: '受阻', icon: 'blocked' }
  if (item.task.status === 'canceled') return { label: '已取消', group: '已完成', icon: 'check' }
  if (item.task.status === 'done') return { label: '执行已结束', group: '已完成', icon: 'check' }
  if (item.task.status === 'in_review') return { label: '审查中', group: '进行中', icon: 'progress' }
  if (item.task.assigneeAgentId && item.mission.runningAgentIds.includes(item.task.assigneeAgentId)) return { label: '进行中', group: '进行中', icon: 'progress' }
  return { label: item.task.status === 'draft' ? '计划中' : '待开始', group: '待开始', icon: 'clock' }
}

export function flattenWork(bundles: WorkBundle[], questions: readonly PiQuestion[] = []): WorkItemFacts[] {
  return bundles.flatMap(bundle => {
    const archived = new Set(bundle.artifacts.map(artifact => artifact.artifactId))
    return bundle.tasks.map(task => {
      const candidate = loomLatestCandidate(task.taskId, bundle.candidates)
      return {
        task,
        waitingForAnswer: questions.some(question => question.taskId === task.taskId && question.threadId === bundle.mission.threadId),
        mission: bundle.mission,
        candidate,
        hasArtifact: candidate !== null && candidate.evidenceIds.some(id => archived.has(id)),
        reviews: bundle.reviews,
        control: bundle.control
      }
    })
  })
}

/** 「等待你」分组的一行 → 一条注意力事实（`attention.ts` 的输入）。
 * waitingForAnswer 的行是提问（运行正等这句回答，高分）；其余是结论已交回、
 * 验收在你手里的工作。时间读链头候选的登记时间，没有候选退回任务更新时间——
 * 都是 Core 真实字段，不编时间。只挑「等待你」组：其它组不进入打扰计数。 */
export function attentionFactsFromWork(items: readonly WorkItemFacts[]): AttentionFact[] {
  return items
    .filter(item => workStatus(item).group === '等待你')
    .map(item => ({
      id: item.task.taskId,
      kind: item.waitingForAnswer ? 'question' : 'review',
      title: item.task.title,
      threadId: item.mission.threadId,
      missionId: item.mission.missionId,
      taskId: item.task.taskId,
      createdAt: item.candidate?.createdAt ?? item.task.updatedAt
    }))
}

const PANELS: { id: WorkspacePanel; label: string; icon: IconName }[] = [
  { id: 'work', label: '工作', icon: 'board' }, { id: 'assets', label: '资产', icon: 'files' },
  { id: 'flow', label: '流程', icon: 'branch' }, { id: 'computer', label: '电脑', icon: 'computer' }
]
type Props = {
  questions?: PiQuestion[]
  agents: AgentProfile[]; bundles: WorkBundle[]; agent: AgentProfile | null; mode: InspectorMode; tab: InspectorTab
  onTab(tab: InspectorTab): void; onMode(mode: InspectorMode): void; onClose(): void; onExpand(): void; expanded: boolean
  onArtifact(selection: ArtifactSelection): void; onOpenConversation(threadId: string): void; loading: boolean
  workbench?: HostWorkbench; client?: ThreadClient; theme?: 'day' | 'night'
  onManageAssistant?(agentId?: string): void; onCapabilityDirty?(dirty: boolean): void; onLibrary?(): void
  threadId?: string | null; conversationTitle?: string; onCreateWork?(): void; onConnectDevice?(): void
  selectedTaskId?: string | null; onTaskSelect?(taskId: string | null): void
}

/** One contextual workspace: tabs change the view, never the selected conversation. */
export function Inspector({ agents, bundles, questions = [], agent, mode, tab, onMode, onClose, onExpand, expanded,
  onArtifact, onOpenConversation, loading, client, theme = 'day', onManageAssistant, workbench,
  threadId = null, conversationTitle, onCreateWork, onConnectDevice, selectedTaskId: controlledTaskId, onTaskSelect }: Props) {
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
  const all = useMemo(() => flattenWork(currentBundles, questions), [currentBundles, questions])
  const shown = all.filter(item => (!query || `${item.task.title} ${item.task.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && (!owner || item.task.assigneeAgentId === owner))
  const selectedTask = all.find(item => item.task.taskId === selectedTaskId) ?? null
  const assets = currentBundles.flatMap(bundle => bundle.artifacts.map(artifact => {
    // 成果行只跟「拥有这份归档」的那个候选：历史成果仍打开它自己的归档，不跳到链头。
    const facts = artifactCandidateFacts(bundle, artifact, null)
    return { artifact, bundle, candidate: facts.candidate, reviewKind: facts.reviewKind }
  }))
  const attentionCount = summarizeAttention(attentionFactsFromWork(all)).count
  const changePanel = (value: WorkspacePanel) => { onMode(modeFor(value)); setSearchOpen(false) }
  const renderAssets = (onlyTask?: string) => {
    const rows = assets.filter(selection => (!onlyTask || selection.artifact.taskId === onlyTask)
      && (!query || selection.artifact.relativePath.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
    return <div className="ln-assets-list">{rows.map(selection => {
      // 成果行也读同一条规则：历史成果显示「已归档」，审查还在办时不会写成「等你」。
      const status = artifactReviewLabel(selection.reviewKind)
      return <button key={selection.artifact.artifactId} type="button" className="ln-asset-row" onClick={() => onArtifact(selection)}>
      <span className="ln-document-icon"><Icon name="file" size={23}/></span><span><strong>{selection.artifact.relativePath.split(/[\\/]/).pop()}</strong><small>{selection.bundle.mission.title} · {relativeDate(selection.artifact.createdAt)}{status !== '' && <> · <span data-state={selection.reviewKind}>{status}</span></>}</small></span><Icon name="right" size={14}/>
    </button>
    })}{!rows.length && <Empty className="ln-empty--dock"><EmptyHeader><EmptyMedia variant="icon"><Icon name="files" size={18}/></EmptyMedia><EmptyTitle>{query ? '没有匹配的成果' : '成果会留在这里'}</EmptyTitle><EmptyDescription>文档、代码和版本记录会随工作自动归档。打开文件不会自动接受成果。</EmptyDescription></EmptyHeader>{scope === 'conversation' && threadId && <EmptyContent><button type="button" className="ln-text-action" onClick={() => setScope('all')}>查看所有工作中的资产</button></EmptyContent>}</Empty>}</div>
  }
  const renderWork = () => <div className="ln-work-groups">{['等待你', '进行中', '受阻', '待开始', '已完成'].map(group => {
    const rows = shown.filter(item => workStatus(item).group === group)
    if (!rows.length) return null
    // 「等待你」过注意力评分/预算（Mikka score/budget/interrupt 思想）：分数高的
    // 在前，最多露出 ATTENTION_BUDGET 条；预算外的聚合成一行「还有 N 项」，不逐
    // 条刷屏。分组标题仍写真实总数，不把收纳掉的项说成不存在。
    const attention = group === '等待你' ? summarizeAttention(attentionFactsFromWork(rows)) : null
    const visible = attention
      ? attention.surfaced.map(item => rows.find(row => row.task.taskId === item.taskId)).filter((item): item is WorkItemFacts => item !== undefined)
      : rows
    const list = <div className="ln-task-list">{visible.map(item => {
      const status = workStatus(item); const member = agents.find(person => person.agentId === item.task.assigneeAgentId)
      // 状态总是写出来：描述/阻塞原因只做补充，不能把「审查中」「返工中」「受阻」藏掉。
      const detail = item.task.blockedReason || item.task.description
      return <button className="ln-task-card" type="button" key={item.task.taskId} onClick={() => setSelectedTaskId(item.task.taskId)}><Icon name={status.icon} size={21}/><span className="ln-task-content"><span className="ln-task-firstline"><strong>{item.task.title}</strong><time>{relativeDate(item.task.updatedAt)}</time></span><span className="ln-task-subtitle">{member && <Avatar agent={member} size={12}/>}<span>{member?.displayName || '未指派'} · <span data-state={status.group}>{status.label}</span>{detail ? ` · ${detail}` : ''}</span></span></span><Icon name="right" size={14}/></button>
    })}</div>
    return group === '已完成' ? <details key={group} className="ln-completed-group"><summary><span>{group}（{rows.length}）</span><i/><Icon name="right" size={13}/></summary>{list}</details>
      : <section key={group} className="ln-work-group"><h3>{group}（{rows.length}）<i/></h3>{list}{attention !== null && attention.remainder > 0 && <p className="ln-attention-rest" title="按优先级收纳，处理完上面的会逐条放出">还有 {attention.remainder} 项</p>}</section>
  })}{!shown.length && <Empty className="ln-empty--dock"><EmptyHeader><EmptyMedia variant="icon"><Icon name="board" size={18}/></EmptyMedia><EmptyTitle>{loading ? '正在读取工作' : query || owner ? '没有匹配的工作' : '从一个目标开始'}</EmptyTitle><EmptyDescription>{scope === 'conversation' && threadId ? '这段对话还没有关联的任务。创建工作后，就能在这里跟进分工和成果。' : '把目标交给协调助手，分工、待你处理的决定和成果都会出现在这里。'}</EmptyDescription></EmptyHeader>{((!loading && onCreateWork) || (scope === 'conversation' && !!threadId)) && <EmptyContent>{onCreateWork && !loading && <button type="button" className="ln-action" onClick={onCreateWork}>创建一项工作</button>}{scope === 'conversation' && threadId && <button type="button" className="ln-text-action" onClick={() => setScope('all')}>查看所有工作</button>}</EmptyContent>}</Empty>}</div>
  return <aside className={`ln-inspector ln-workspace-dock${expanded ? ' is-expanded' : ''}`} aria-label="工作空间面板">
    {/* Current-conversation identity: the real member avatar, never a stand-in
        illustration. Header and tabs keep their own fixed rows below it. */}
    <div className="ln-dock-hero">
      <div className="ln-dock-hero-avatar"><Avatar agent={agent} name={conversationTitle} size={104}/></div>
      <div className="ln-dock-hero-copy"><strong title={agent?.displayName || conversationTitle}>{agent?.displayName || conversationTitle || '工作空间'}</strong><small>{conversationTitle && conversationTitle !== agent?.displayName ? conversationTitle : agent ? '当前对话' : '这段对话还没有指定助手'}</small></div>
    </div>
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
      {panel === 'computer' ? (agent
        ? <><div className="ln-dock-agent"><Avatar agent={agent} size={30}/><span><strong>{agent.displayName}</strong><small>查看、手动控制和助手控制分别授权</small></span><button type="button" className="ln-text-action" onClick={() => onManageAssistant?.(agent.agentId)}>配置</button></div><ComputerWorkspace workbench={workbench} client={client} agent={agent} theme={theme} onConnectDevice={onConnectDevice}/></>
        : <Empty className="ln-empty--dock"><EmptyHeader><EmptyMedia variant="icon"><Icon name="computer" size={18}/></EmptyMedia><EmptyTitle>还没有可以查看的电脑</EmptyTitle><EmptyDescription>选择助手后可查看对应的执行位置和授权；这台电脑要先在「设置 › 设备」里连接并单独授权，配对不会自动开放屏控。</EmptyDescription></EmptyHeader>{onConnectDevice && <EmptyContent><button type="button" className="ln-action" onClick={onConnectDevice}>去连接设备</button></EmptyContent>}</Empty>)
        : panel === 'flow' || panel === 'assets' && assetView === 'lineage' ? client ? <WorkMap bundles={currentBundles} agents={agents} client={client} onArtifact={onArtifact} onConversation={onOpenConversation} focusedTaskId={selectedTaskId} onTaskSelect={setSelectedTaskId} initialView={panel === 'assets' ? 'assets' : 'flow'} hideViewTabs onCreateWork={onCreateWork}/> : <Empty className="ln-empty--dock"><EmptyHeader><EmptyMedia variant="icon"><Icon name="branch" size={18}/></EmptyMedia><EmptyTitle>流程和成果关系会连在这里</EmptyTitle><EmptyDescription>当前连接未提供工作关系。建立第一项工作后，任务、依赖和成果会按真实记录连起来。</EmptyDescription></EmptyHeader>{onCreateWork && <EmptyContent><button type="button" className="ln-action" onClick={onCreateWork}>创建一项工作</button></EmptyContent>}</Empty>
        : panel === 'assets' ? renderAssets(selectedTaskId ?? undefined)
        : selectedTask ? <section className="ln-task-detail"><button type="button" className="ln-text-action ln-dock-back" onClick={() => setSelectedTaskId(null)}><Icon name="left" size={14}/>所有工作</button><h1>{selectedTask.task.title}</h1><span className="ln-detail-status"><Icon name={workStatus(selectedTask).icon} size={16}/>{workStatus(selectedTask).label}</span><AgentMarkdown text={selectedTask.task.description || '此任务没有补充说明。'}/>{selectedTask.task.blockedReason && <p className="ln-inline-error">{selectedTask.task.blockedReason}</p>}<h3>交付成果</h3>{renderAssets(selectedTask.task.taskId)}<button type="button" className="ln-text-action" onClick={() => onOpenConversation(selectedTask.mission.threadId)}><Icon name="chat" size={15}/>打开相关对话</button></section> : renderWork()}
    </div>
  </aside>
}

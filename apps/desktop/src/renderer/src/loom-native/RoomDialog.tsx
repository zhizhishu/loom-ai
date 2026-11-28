import { createTrackedWork, newWorkAttempt, WorkCommandUnknown, WorkCommandRejected, WorkStartFailed, type ResumableWorkAttempt, type TrackedWorkDraft } from './work-service'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BusinessEnvironment, CloudUser } from '../business-environment'
import type { AgentProfile, ThreadSnapshot } from './types'
import type { NavigationSnapshot, ThreadCreationPreflight, WorkspaceSelection } from '@contracts'
import { Avatar } from './Avatar'
import { Icon } from './icons'
import { readWorkspaceDefault,validateWorkspaceDefault } from './workspace-defaults'
import { FormMessage, SurfaceDialog, UnsavedNotice } from './Controls'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './EmptyState'
import {
  roomPort, emptyRoomDraft, roomSubmitProblem, createRoom, chooseRoomWorkspace,
  readRoomCreationPreflight, addRoomMembers, changeRoomLead, removeRoomMembers, setRoomHidden,
  roomWorkspaceChoices, applyKnownWorkspace, type RoomWorkspaceChoice, type RoomDraft
} from './room-service'

export const GROUP_NAME_MAX_LENGTH = 80
/** B5：群名到达 80 字上限时，在 aria-live 区域里给出这句准确提示。 */
export const GROUP_NAME_LIMIT_NOTICE = '已达 80 字上限，多出的字不会保存'
/** 计数使用已保存的输入长度（draft.name）；原生 80 字上限保持不变。 */
export function groupNameCounter(name: string | null): { shown: string; atLimit: boolean } {
  const length = (name ?? '').length
  return { shown: `${length}/${GROUP_NAME_MAX_LENGTH}`, atLimit: length >= GROUP_NAME_MAX_LENGTH }
}

export function GroupNameField({ name, disabled, onChange }: {
  name: string | null; disabled?: boolean; onChange(value: string): void
}) {
  const counter = groupNameCounter(name)
  return <>
    <input aria-label="群聊名称" placeholder="例如：网站改版小队" maxLength={GROUP_NAME_MAX_LENGTH}
      disabled={disabled} value={name ?? ''} onChange={event => onChange(event.target.value)}/>
    <small className="ln-name-count" style={{ display: 'block' }}>{counter.shown}</small>
    <small className="ln-name-limit" style={{ display: 'block' }} aria-live="polite">{counter.atLimit ? GROUP_NAME_LIMIT_NOTICE : ''}</small>
  </>
}

export function RoomDialog({ open, environment, agents, initialAgentId, initialMode = 'group', initialWorkspace, theme = 'day', onClose, onCreated, onNewAssistant }: {
  open: boolean; environment: BusinessEnvironment; agents: AgentProfile[]; initialAgentId?: string
  initialMode?: 'direct' | 'group' | 'work'; initialWorkspace?: WorkspaceSelection | null
  theme?: 'day' | 'night'; onClose(): void; onCreated(threadId: string): Promise<void>
  /** 一个可选助手都没有时就地引导新建助手，不把人赶出弹窗。 */
  onNewAssistant?(): void
}) {
  const port = useMemo(() => roomPort(environment), [environment])
  const [draft, setDraft] = useState<RoomDraft>(() => emptyRoomDraft())
  const [mode, setMode] = useState<'direct' | 'group' | 'work'>(initialMode)
  const [goal, setGoal] = useState('')
  const [startNow, setStartNow] = useState(false)
  const workAttempt = useRef<ResumableWorkAttempt | undefined>(undefined)
  const workStartId = useRef<string | undefined>(undefined)
  const [createdWorkThread, setCreatedWorkThread] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState('')
  const [preflight, setPreflight] = useState<ThreadCreationPreflight | null>(null)
  const [knownWorkspaces, setKnownWorkspaces] = useState<RoomWorkspaceChoice[]>([])
  const [workspaceReadError, setWorkspaceReadError] = useState(false)
  const [defaultRootError, setDefaultRootError] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [changed, setChanged] = useState(false)
  const [creationUnknown, setCreationUnknown] = useState(false)
  const ticket = useRef(0)
  const command = useRef<{ id: string; signature: string } | null>(null)
  useEffect(() => {
    if (!open) return
    const generation = ++ticket.current
    // Closing a transport-unknown dialog never discards the retained command.
    // Reopening resumes the same draft/attempt, rather than silently duplicating it.
    if (creationUnknown) return () => { ticket.current++ }
    setMode(initialMode)
    const first = agents.find(agent => agent.agentId === initialAgentId && !agent.removedAt) ?? agents.find(agent => !agent.removedAt)
    setDraft({ ...emptyRoomDraft(), name: initialMode === 'direct' ? first?.displayName ?? null : null, memberAgentIds: first ? [first.agentId] : [], leadAgentId: first?.agentId ?? '' })
    setDefaultRootError(false)
    const preferred=initialWorkspace??readWorkspaceDefault(localStorage)
    setError(''); setCreationUnknown(false); setChanged(false); setDiscard(false); command.current = null
    setGoal(''); setStartNow(false); workAttempt.current = undefined; workStartId.current = undefined; setCreatedWorkThread(null)
    void readRoomCreationPreflight(port).then(value => { if (generation === ticket.current) setPreflight(value) })
      .catch(cause => { if (generation === ticket.current) setError(cause instanceof Error ? cause.message : '暂时无法读取助手状态。') })
    setKnownWorkspaces([]);setWorkspaceReadError(false)
    void port.request<NavigationSnapshot>('navigation.snapshot',{}).then(value => {
      if (generation !== ticket.current) return
      setKnownWorkspaces(roomWorkspaceChoices(value))
      if (!preferred) return
      // Local storage is a preference, not an authorization. The root must
      // still be registered with this Host, then pass a fresh Core validation.
      if (!value.projects?.some(project => project.projectPath === preferred.projectPath)) {
        setDefaultRootError(true)
        return
      }
      void validateWorkspaceDefault(<T,>(method:'workspaces.validate',params:{path:string})=>port.request<T>(method,params),preferred)
        .then(checked=>{ if(generation===ticket.current) setDraft(current=>current.workspace ? current : {...current,workspace:checked}) })
        .catch(()=>{if(generation===ticket.current)setDefaultRootError(true)})
    }).catch(() => { if(generation === ticket.current){setWorkspaceReadError(true);if(preferred)setDefaultRootError(true)} })
    return () => { ticket.current++ }
  }, [open, initialAgentId, initialMode, initialWorkspace?.projectPath, port])
  const people = agents.filter(agent => !agent.removedAt && agent.presence !== 'removed')
  const groupBlocker = mode === 'group' ? roomSubmitProblem(draft, agents, preflight, 'group') : null
  const blockerHint = groupBlocker !== null && !creationUnknown && (preflight === null || preflight.admissible)
    ? groupBlocker
    : null
  const patch = (next: Partial<RoomDraft>) => { if (creationUnknown) return; if (!workAttempt.current?.missionId) workAttempt.current = undefined; setChanged(true); setError(''); setDraft(value => ({ ...value, ...next })) }
  const toggle = (id: string) => {
    const members = mode === 'direct' ? [id] : draft.memberAgentIds.includes(id) ? draft.memberAgentIds.filter(value => value !== id) : [...draft.memberAgentIds, id]
    patch({ name: mode === 'direct' ? agents.find(agent => agent.agentId === id)?.displayName ?? null : draft.name, memberAgentIds: members, leadAgentId: members.includes(draft.leadAgentId) ? draft.leadAgentId : members[0] ?? '' })
  }
  const selectWorkspace = async () => {
    setPicking(true); setError('')
    const generation = ticket.current
    try { const value = await chooseRoomWorkspace(port, draft); if (generation === ticket.current) { setDraft(value); setChanged(true) } }
    catch (cause) { if (generation === ticket.current) setError(cause instanceof Error ? cause.message : '未能选择工作区。') }
    finally { if (generation === ticket.current) setPicking(false) }
  }
  const submit = async () => {
    if (busy) return
    if (mode === 'work') {
      const work: TrackedWorkDraft = {
        name: draft.name ?? '', goal, memberAgentIds: draft.memberAgentIds,
        defaultLeadAgentId: draft.leadAgentId, workspace: draft.workspace
      }
      const generation = ticket.current
      setBusy(true); setError('')
      try {
        workAttempt.current ??= newWorkAttempt(work)
        if (startNow) workStartId.current ??= crypto.randomUUID()
        const result = await createTrackedWork(environment.client, work, {
          attempt: workAttempt.current, ...(startNow ? { start: { commandId: workStartId.current! } } : {})
        })
        workAttempt.current = result.attempt
        if (generation !== ticket.current) return
        setCreatedWorkThread(result.result.threadId)
        await onCreated(result.result.threadId)
        setChanged(false); onClose()
      } catch (cause) {
        if (generation !== ticket.current) return
        if (cause instanceof WorkCommandUnknown || cause instanceof WorkStartFailed) {
          workAttempt.current = cause.attempt
          setCreatedWorkThread(cause.attempt.threadId)
          if (cause instanceof WorkStartFailed) workStartId.current = cause.startCommandId
          setCreationUnknown(true)
        } else if (cause instanceof WorkCommandRejected) {
          workAttempt.current = undefined; workStartId.current = undefined; setCreationUnknown(false)
        } else if (!workAttempt.current?.missionId) {
          // Validation did not submit a command. The user can correct the draft.
          workAttempt.current = undefined; setCreationUnknown(false)
        } else {
          setCreatedWorkThread(workAttempt.current.threadId); setCreationUnknown(true)
        }
        setError(cause instanceof Error ? cause.message : '工作尚未确认，内容已保留。')
      } finally { if (generation === ticket.current) setBusy(false) }
      return
    }
    const blocker = mode === 'group' ? groupBlocker : roomSubmitProblem(draft, agents, preflight)
    if (blocker !== null && !creationUnknown) { setError(blocker); return }
    const signature = JSON.stringify(draft)
    if (command.current && command.current.signature !== signature) command.current = null
    command.current ??= { id: crypto.randomUUID(), signature }
    const generation = ticket.current
    setBusy(true); setError('')
    try {
      const result = await createRoom(port, draft, agents, command.current.id, mode)
      if (generation !== ticket.current) return
      await onCreated(result.threadId)
      setChanged(false); onClose()
    } catch (cause) { if (generation === ticket.current) { const rejected = cause instanceof Error && cause.name === 'LoomCommandRejected'; setCreationUnknown(!rejected); setError(cause instanceof Error ? cause.message : '创建未完成，选择已保留。') } }
    finally { if (generation === ticket.current) setBusy(false) }
  }
  const close = () => { if (busy || picking) return; if (changed) setDiscard(true); else onClose() }
  return <SurfaceDialog open={open} title="开始一段新协作" description="告诉助手要做什么，把合适的队友拉进来。" theme={theme} onClose={close} className="ln-room-dialog">
    <div className="ln-room-content">
      <nav className="ln-segment-tabs" aria-label="对话类型" style={{ marginBottom: 20 }}><button type="button" disabled={creationUnknown || busy} className={mode === 'direct' ? 'is-selected' : ''} onClick={() => { setMode('direct'); const id = draft.leadAgentId || draft.memberAgentIds[0]; patch({ name: agents.find(agent => agent.agentId === id)?.displayName ?? null, memberAgentIds: id ? [id] : [], leadAgentId: id || '' }) }}>单聊</button><button type="button" disabled={creationUnknown || busy} className={mode === 'group' ? 'is-selected' : ''} onClick={() => setMode('group')}>群聊协作</button><button type="button" disabled={creationUnknown || busy} className={mode === 'work' ? 'is-selected' : ''} onClick={() => setMode('work')}>共同完成工作</button></nav>
      {mode !== 'direct' && <label className="ln-field"><span>{mode === 'work' ? '工作名称' : '群聊名称'}</span>{mode === 'group'
        ? <GroupNameField name={draft.name} disabled={busy || creationUnknown} onChange={value => patch({ name: value || null })}/>
        : <input aria-label="工作名称" placeholder="例如：做一个可以使用的网站" maxLength={200} disabled={busy || creationUnknown} value={draft.name ?? ''} onChange={event => patch({ name: event.target.value || null })}/>}</label>}
      {mode === 'work' && <label className="ln-field"><span>想要什么结果？</span><textarea aria-label="工作目标" rows={4} maxLength={12000} placeholder="描述目标、约束和你希望交付的成果。协调助手会组织队友，进度与成果显示在右侧。" disabled={busy || creationUnknown} value={goal} onChange={event => { setGoal(event.target.value); setChanged(true); setError(''); if (!creationUnknown) workAttempt.current = undefined }}/><small>工作会保留目标、任务进展和成果；不是只建一个空群。</small></label>}
      <div className="ln-panel-title"><h3>{mode === 'direct' ? '选择助手' : '邀请助手'}</h3><small>{draft.memberAgentIds.length} 位已选</small></div>
      {people.length > 0 ? <div className="ln-room-people">{people.map(agent => <label className="ln-room-person" key={agent.agentId}><input type={mode === 'direct' ? 'radio' : 'checkbox'} name="room-members" checked={draft.memberAgentIds.includes(agent.agentId)} onChange={() => toggle(agent.agentId)} disabled={busy || creationUnknown}/><Avatar agent={agent} size={32}/><span><strong>{agent.displayName}</strong><small>{agent.teamRole || '助手'}{!agent.runtimeConfiguration ? ' · 待配置运行端' : ''}</small></span>{mode !== 'direct' && draft.leadAgentId === agent.agentId && <span className="ln-room-lead-badge">负责回复</span>}</label>)}</div>
        : <Empty className="ln-empty--inline"><EmptyHeader><EmptyMedia variant="icon"><Icon name="chat" size={18}/></EmptyMedia><EmptyTitle>还没有可选的助手</EmptyTitle><EmptyDescription>先建立一位助手，再开始单聊、群聊或共同工作。</EmptyDescription></EmptyHeader>{onNewAssistant && <EmptyContent><button type="button" className="ln-action" onClick={onNewAssistant}>新建助手</button></EmptyContent>}</Empty>}
      {mode !== 'direct' && draft.memberAgentIds.length > 0 && <p className="ln-native-help">第一个勾选的助手负责回复；群里写 @名字 时由被点名的助手先答。</p>}
      <div className="ln-panel-title"><h3>工作区 · 默认运行目录</h3></div>
      <p className="ln-native-help">助手开始执行文件任务时的项目根目录，不是聊天附件位置。</p>
      <div className="ln-workspace-choice"><Icon name="files" size={23}/><span><strong>{draft.workspace?.name || '快速对话 · 主机默认目录'}</strong><small>{draft.workspace?.projectPath || '未指定项目根；由已连接主机按原有规则安排'}</small></span><button type="button" className="ln-action" disabled={picking || busy || creationUnknown} onClick={() => { void selectWorkspace() }}>{picking ? '选择中…' : '浏览目录'}</button></div>
      {knownWorkspaces.length > 1 && <div className="ln-workspace-presets" aria-label="选择已有工作区">
        <small>已登记的项目</small>
        {knownWorkspaces.filter(choice => choice.kind === 'project').map(choice => <button type="button" key={choice.projectKey}
          aria-pressed={draft.workspace?.projectPath === choice.projectPath}
          className={draft.workspace?.projectPath === choice.projectPath ? 'is-selected' : ''}
          disabled={busy || creationUnknown || picking}
          onClick={() => patch({ workspace: applyKnownWorkspace(draft,choice).workspace })}>
          <Icon name="files" size={14}/><span><strong>{choice.name}</strong><small>{choice.projectPath}</small></span>
        </button>)}
      </div>}
      {workspaceReadError && <p className="ln-native-help">已有项目暂时读取失败，仍可用“浏览目录”从当前 Host 显式选择。</p>}
      {defaultRootError&&<p className="ln-native-help" role="status">已保存的默认项目目录未通过主机重新验证，未自动授权。请重新从主机选择目录。</p>}
      {draft.workspace && <button type="button" className="ln-text-action" disabled={busy || creationUnknown} onClick={() => patch({ workspace: null })}>改用快速对话目录</button>}
      <details className="ln-room-help"><summary>目录权限说明</summary><p>选择已有项目或通过主机挑选新目录；不会自动开放磁盘上的其他目录。</p><p>跨目录任务需要目标工具与主机另外授权，不会因为设定默认工作区就获得跨目录写入权限。</p></details>
      {error && <FormMessage error>{error}</FormMessage>}
      {mode === 'work' && <label className="ln-work-start-choice"><input type="checkbox" checked={startNow} disabled={busy || creationUnknown} onChange={event => { setStartNow(event.target.checked); setChanged(true) }}/><span><strong>创建后开始执行</strong><small>协调助手会接收工作目标。运行可能使用所选模型，工具仍按权限请求授权。</small></span></label>}
      {creationUnknown && <FormMessage>{createdWorkThread ? '工作已创建；开始或打开结果未确认。重试不会重复创建。' : '创建结果尚未确认。当前选择已锁定；重试沿用原请求编号，不会创建第二份。'}</FormMessage>}
      {createdWorkThread && error && <button type="button" className="ln-action" disabled={busy} onClick={() => { void onCreated(createdWorkThread).then(() => { setChanged(false); onClose() }).catch(cause => setError(cause instanceof Error ? cause.message : '未能打开已创建工作。')) }}>打开已创建的工作</button>}
      {preflight && !preflight.admissible && <FormMessage>当前主机的创建检查尚未通过。请先配置或启用至少一位助手。</FormMessage>}
      {blockerHint !== null && <p className="ln-native-help" id="ln-room-blocker">{blockerHint}</p>}
      <footer className="ln-form-actions"><small>{mode === 'work' ? (startNow ? '将创建可追踪工作并向协调助手提交目标。' : '仅创建工作，不启动模型；可随后开始。') : '创建群聊不会自动派工，未配置的助手可稍后配置。'}</small><button type="button" className="ln-action is-primary" disabled={busy || picking || (groupBlocker !== null && !creationUnknown)} aria-describedby={blockerHint !== null ? 'ln-room-blocker' : undefined} onClick={() => { void submit() }}>{busy ? '创建中…' : creationUnknown ? '核对上次创建' : mode === 'work' ? (startNow ? '创建并开始' : '创建工作') : mode === 'group' ? '创建群聊' : '开始对话'}</button></footer>
    </div>
    {discard && <UnsavedNotice onKeep={() => setDiscard(false)} onDiscard={() => { setChanged(false); onClose() }}/>}
  </SurfaceDialog>
}

export type CloudPeopleRow = { user: CloudUser; inCamp: boolean }

/** Web 边界模拟多租户：把 Host 声明的云用户按群成员关系分「已在群 / 可拉入」两区，纯函数便于测试。 */
export function cloudPeopleRows(users: readonly CloudUser[], memberUserIds: readonly string[]): CloudPeopleRow[] {
  const members = new Set(memberUserIds)
  return users.map(user => ({ user, inCamp: members.has(user.id) }))
}

/** 人类成员区：与「添加协作助手」分区分文案；成员关系只按服务端返回显示，拉入也由服务端裁决。 */
export function CloudPeopleSection({ users, memberUserIds, busyUserId, disabled, error, onPullIn }: {
  users: readonly CloudUser[]; memberUserIds: readonly string[]; busyUserId: string | null
  disabled?: boolean; error?: string; onPullIn(userId: string): void
}) {
  const rows = cloudPeopleRows(users, memberUserIds)
  return <section className="ln-cloud-people" aria-label="人员">
    <div className="ln-panel-title"><h3>人员</h3><small>来自服务端，不参与助手分工</small></div>
    <div className="ln-room-people">
      {rows.map(({ user, inCamp }) => <div className="ln-room-person" key={user.id}>
        <Avatar name={user.displayName} size={28}/>
        <span><strong>{user.displayName}</strong><small>{inCamp ? '已在群聊' : user.role === 'owner' ? '所有者' : '成员'}</small></span>
        {!inCamp && <button type="button" className="ln-action" disabled={disabled || busyUserId !== null} onClick={() => onPullIn(user.id)}>{busyUserId === user.id ? '拉入中…' : '拉入群聊'}</button>}
      </div>)}
    </div>
    {error && <FormMessage error>{error}</FormMessage>}
  </section>
}

export function RoomMembersDialog({ open, environment, agents, snapshot, theme = 'day', onClose, onRefresh }: {
  open: boolean; environment: BusinessEnvironment; agents: AgentProfile[]; snapshot: ThreadSnapshot | null
  theme?: 'day' | 'night'; onClose(): void; onRefresh(): Promise<void>
}) {
  const port = useMemo(() => roomPort(environment), [environment])
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  /** 移出先问一句：它结束的是一条成员关系，不是一次开关。 */
  const [removing, setRemoving] = useState<string | null>(null)
  const [hiding, setHiding] = useState(false)
  useEffect(() => { setSelected([]); setError(''); setNotice(''); setRemoving(null); setHiding(false) }, [open, snapshot?.thread.id])
  /** 人员区只在 Host 声明当前用户是 owner 且接口可用时出现；拉取失败就静默不显示。 */
  const cloud = environment.cloudPeople ?? null
  const cloudOwner = cloud?.current?.role === 'owner'
  const [cloudPeople, setCloudPeople] = useState<CloudUser[] | null>(null)
  const [cloudMemberIds, setCloudMemberIds] = useState<string[] | null>(null)
  const [cloudBusy, setCloudBusy] = useState<string | null>(null)
  const [cloudError, setCloudError] = useState('')
  const cloudTicket = useRef(0)
  useEffect(() => {
    if (!open || !cloudOwner || !cloud) return
    const generation = ++cloudTicket.current
    setCloudPeople(null); setCloudMemberIds(null); setCloudBusy(null); setCloudError('')
    const campId = snapshot?.thread.id
    if (!campId) return
    void Promise.all([cloud.users(), cloud.campMembers(campId)]).then(([users, memberIds]) => {
      if (generation !== cloudTicket.current) return
      setCloudPeople(users); setCloudMemberIds(memberIds)
    }).catch(() => { if (generation === cloudTicket.current) { setCloudPeople(null); setCloudMemberIds(null) } })
    return () => { cloudTicket.current++ }
  }, [open, cloudOwner, cloud, snapshot?.thread.id])
  if (!snapshot) return null
  const active = snapshot.members.filter(member => member.membershipStatus === 'active')
  const available = agents.filter(agent => !agent.removedAt && agent.presence !== 'removed' && !active.some(member => member.agentId === agent.agentId))
  const lead = async (agentId: string) => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await changeRoomLead(port, { threadId: snapshot.thread.id, successorAgentId: agentId, expectedVersion: snapshot.thread.version }); await onRefresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '变更未完成，请刷新后重试。') } finally { setBusy(false) }
  }
  const add = async () => {
    if (busy || !selected.length) return
    setBusy(true); setError(''); setNotice('')
    try {
      const outcome = await addRoomMembers(port, { threadId: snapshot.thread.id, agentIds: selected, membershipGeneration: snapshot.thread.membershipGeneration })
      await onRefresh(); setSelected([])
      if (outcome.failures.length) setError(outcome.failures.map(item => `${agents.find(agent => agent.agentId === item.agentId)?.displayName || item.agentId}：${item.message}`).join('；'))
      else if (outcome.addedAgentIds.length) setNotice('已加入群聊；不会自动派工。')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '添加未完成，成员状态需刷新确认。') } finally { setBusy(false) }
  }
  const remove = async (agentId: string) => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const outcome = await removeRoomMembers(port, { threadId: snapshot.thread.id, agentIds: [agentId] })
      await onRefresh(); setRemoving(null)
      if (outcome.removedAgentIds.length) setNotice('已移出群聊；需要时可以重新邀请。')
      if (outcome.failures.length) setError(outcome.failures.map(item => item.message).join('；'))
    } catch (cause) { setError(cause instanceof Error ? cause.message : '移出未完成，成员状态需刷新确认。') } finally { setBusy(false) }
  }
  /** 退出群聊 = 把这个群从我的列表隐藏；群、成员和历史都保留，可在「已隐藏」里恢复。 */
  const hide = async () => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      await setRoomHidden(port, { threadId: snapshot.thread.id, hidden: true })
      setHiding(false)
      await onRefresh()
      onClose()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '隐藏未完成，会话列表尚未更新。') } finally { setBusy(false) }
  }
  /** Owner 直接拉人：不加邀请、不做移除；结果只按服务端返回的成员列表刷新。 */
  const pullInCloudUser = async (userId: string) => {
    if (!cloud || !snapshot || busy || cloudBusy !== null) return
    setCloudBusy(userId); setCloudError('')
    try { setCloudMemberIds(await cloud.addCampMember(snapshot.thread.id, userId)) }
    catch (cause) { setCloudError(cause instanceof Error ? cause.message : '拉入未完成，请重试。') }
    finally { setCloudBusy(null) }
  }
  const removingName = removing === null ? '' : active.find(member => member.agentId === removing)?.displayName || removing
  return <SurfaceDialog open={open} title="群聊成员" description="协调助手协调当前群聊，其他助手是独立参与者。" theme={theme} onClose={() => { if (!busy) onClose() }} className="ln-room-dialog"><div className="ln-room-content">
    <div className="ln-room-summary">{active.map(member => { const agent = agents.find(row => row.agentId === member.agentId); return <div key={member.agentId}><Avatar agent={agent} name={member.displayName} size={28}/><strong>{member.displayName}</strong><small>{member.agentId === snapshot.thread.defaultLeadAgentId ? '协调助手' : '协作助手'}</small>{member.agentId !== snapshot.thread.defaultLeadAgentId && <button type="button" className="ln-action" disabled={busy} onClick={() => { void lead(member.agentId) }}>设为协调助手</button>}<button type="button" className="ln-text-action" disabled={busy} onClick={() => { setRemoving(member.agentId); setError(''); setNotice('') }}>移出</button></div> })}</div>
    <div className="ln-workspace-choice"><Icon name="files" size={22}/><span><strong>当前工作区域</strong><small>{snapshot.thread.projectPath || '主机快速对话目录'}</small></span></div>
    {available.length > 0 && <><div className="ln-panel-title"><h3>添加协作助手</h3><small>不会自动发送消息</small></div><div className="ln-room-people">{available.map(agent => <label className="ln-room-person" key={agent.agentId}><input type="checkbox" checked={selected.includes(agent.agentId)} disabled={busy} onChange={() => setSelected(current => current.includes(agent.agentId) ? current.filter(id => id !== agent.agentId) : [...current, agent.agentId])}/><Avatar agent={agent} size={28}/><span><strong>{agent.displayName}</strong><small>{agent.teamRole}</small></span></label>)}</div></>}
    {cloudOwner && cloudPeople !== null && cloudMemberIds !== null && <CloudPeopleSection users={cloudPeople} memberUserIds={cloudMemberIds} busyUserId={cloudBusy} disabled={busy} error={cloudError} onPullIn={userId => { void pullInCloudUser(userId) }}/>}
    {removing !== null && <div className="ln-unsaved-notice" role="alertdialog" aria-label="移出成员"><span>把「{removingName}」移出群聊？移出后 Ta 不再收到群里的消息，需要时可以重新邀请。</span><button type="button" disabled={busy} onClick={() => setRemoving(null)}>取消</button><button type="button" disabled={busy} onClick={() => { void remove(removing) }}>确认移出</button></div>}
    {hiding && <div className="ln-unsaved-notice" role="alertdialog" aria-label="隐藏群聊"><span>把「{snapshot.thread.title}」从会话列表隐藏？群里的助手、消息和历史全部保留，可以在「已隐藏」里恢复。</span><button type="button" disabled={busy} onClick={() => setHiding(false)}>取消</button><button type="button" disabled={busy} onClick={() => { void hide() }}>确认隐藏</button></div>}
    {notice && <FormMessage>{notice}</FormMessage>}
    {error && <FormMessage error>{error}</FormMessage>}
    <footer className="ln-form-actions"><small>{active.length} 位助手</small><button type="button" className="ln-text-action" disabled={busy} onClick={() => { setHiding(true); setRemoving(null); setError(''); setNotice('') }}>退出群聊</button><button type="button" className="ln-action is-primary" disabled={busy || !selected.length} onClick={() => { void add() }}>{busy ? '更新中…' : '添加到群聊'}</button></footer>
  </div></SurfaceDialog>
}

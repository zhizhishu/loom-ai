import { useEffect, useRef, useState } from 'react'
import type { AgentProfile, LoomDispatch, LoomStageReview, LoomTask, ThreadSnapshot } from '@contracts'
import { ChoiceMenu, FormMessage } from './Controls'
import {
  EMPTY_LOOM_CONTROL_DRAFT,
  loomControlDraftFromPolicy,
  loomDispatchKindLabel,
  loomDispatchStatusLabel,
  loomDispatchTally,
  loomPolicyAuthorizationRevision,
  loomStageReviewFreshness,
  loomStageVerdictLabel,
  type LoomControlDraft,
  type LoomControlPolicy,
  type LoomControlState
} from '../loom-control-model'
import {
  beginConfigure,
  beginPause,
  controlPanelProblems,
  controlPauseAllowed,
  controlState,
  controlWritable,
  readControl,
  reviewerChoices,
  reviewerScope,
  submitControl,
  type ControlAttempt,
  type ControlPanelProblem,
  type ControlPort,
  type ControlRead,
  type ControlWrite
} from './control-service'
import './control-panel.css'

/**
 * 自动接力范围：用户在这里显式批准「哪些任务可以自动派发、谁做独立审查、用多少预算」，
 * 以及暂停/继续后续派发。
 *
 * 边界（与 Core 的 control plane 一致，界面不得放宽）：
 * - 这里不停止正在运行的任务，只挡住**后续**派发；也不接受任何候选成果，用户验收在成果页。
 * - 读不到策略就是读不到，不画成「尚未批准」；加载中与切工作期间一个写请求都不发。
 * - 提交结果未确认时保留原请求编号与原文 payload，只做同样的重发核对，不换新 ID。
 */

const STATE_LABEL: Record<LoomControlState, string> = {
  reading: '正在读取接力范围…',
  unreadable: '接力范围读取失败',
  unapproved: '尚未批准自动接力',
  disabled: '自动接力已停用',
  expired: '授权已过期',
  paused: '接力已暂停',
  approved: '接力已批准'
}

const PROBLEM_LABEL: Record<ControlPanelProblem, string> = {
  no_tasks: '请选择要纳入自动接力的任务',
  missing_reviewer: '每个任务都需要一名独立审查者',
  max_dispatches: '请填写派发总上限（正整数）',
  max_reworks: '请填写每任务返工上限（非负整数）',
  expires_at: '到期时间无法解析',
  reviewer_self: '独立审查者不能是该任务的执行者本人',
  reviewer_not_member: '所选独立审查者已不是当前成员，请重新选择',
  reviewer_membership_unknown: '当前对话的成员尚未读到，不能选择独立审查者',
  task_unknown: '所选任务不在当前工作的计划里'
}

function agentName(agents: readonly AgentProfile[], agentId: string): string {
  return agents.find(agent => agent.agentId === agentId)?.displayName ?? agentId
}

function taskTitle(tasks: readonly LoomTask[], taskId: string): string {
  return tasks.find(task => task.taskId === taskId)?.title ?? taskId
}

/** 某任务最新一条助手阶段审查（按 reviewedAt，取最后一条）。读不到就说没有。 */
export function latestStageReviewOf(stageReviews: readonly LoomStageReview[], taskId: string): LoomStageReview | null {
  let latest: LoomStageReview | null = null
  for (const review of stageReviews) {
    if (review.taskId !== taskId) continue
    if (latest === null || review.reviewedAt >= latest.reviewedAt) latest = review
  }
  return latest
}

/**
 * 只读摘要：事实、预算与派发记录。导出成纯组件，
 * 这样「读不到不是未批准」「过期不能继续」「不出现用户验收」都能在静态渲染里被验证。
 */
export function ControlSummary({ state, policy, dispatches, stageReviews, tasks, agents }: {
  state: LoomControlState
  policy: LoomControlPolicy | null
  dispatches: readonly LoomDispatch[]
  stageReviews: readonly LoomStageReview[]
  tasks: readonly LoomTask[]
  agents: readonly AgentProfile[]
}) {
  if (state === 'reading') return <p className="ln-control-note">正在读取接力范围…</p>
  if (state === 'unreadable') {
    return <p className="ln-control-note is-warning" role="alert">接力范围暂时读不到，请重新读取；这不代表尚未批准。</p>
  }
  if (policy === null) {
    return <p className="ln-control-note">这项工作的任务不会自动派发。批准前，主助手仍需逐条安排。</p>
  }
  const tally = loomDispatchTally(dispatches)
  return <>
    <div className="ln-control-facts">
      <div className="ln-control-fact"><span>纳入任务</span><strong>{policy.taskIds.length}</strong></div>
      <div className="ln-control-fact"><span>独立审查者</span><strong>{policy.reviewers.length}</strong></div>
      <div className="ln-control-fact"><span>派发已用</span><strong>{`${tally.used} / ${policy.maxDispatches}`}</strong></div>
      <div className="ln-control-fact"><span>每任务返工上限</span><strong>{policy.maxReworksPerTask}</strong></div>
      <div className="ln-control-fact"><span>授权版本</span><strong>{loomPolicyAuthorizationRevision(policy) ?? '—'}</strong></div>
      <div className="ln-control-fact"><span>到期</span><strong>{policy.expiresAt === null ? '不设到期' : policy.expiresAt}</strong></div>
      <div className="ln-control-fact"><span>批准人</span><strong>{agentName(agents, policy.approvedBy)}</strong></div>
    </div>
    {policy.taskIds.length > 0 && <details className="ln-control-details">
      <summary>范围与独立审查</summary>
      <div className="ln-control-dispatches">
        {policy.taskIds.map(taskId => {
          const reviewer = policy.reviewers.find(entry => entry.taskId === taskId)?.reviewerAgentId ?? ''
          const latest = latestStageReviewOf(stageReviews, taskId)
          const freshness = latest === null ? null : loomStageReviewFreshness(latest, policy)
          return <div key={taskId} className="ln-control-dispatch" data-kind="review"
            data-freshness={freshness ?? 'none'}>
            <span>{taskTitle(tasks, taskId)}</span>
            <span>{reviewer === '' ? '未指定审查者' : agentName(agents, reviewer)}</span>
            <span>{latest === null
              ? '尚无助手审查'
              : `${loomStageVerdictLabel(latest.verdict)}${freshness === 'current' ? '' : ' · 非当前授权'}`}</span>
          </div>
        })}
      </div>
    </details>}
    {dispatches.length > 0 && <details className="ln-control-details">
      <summary>最近派发记录</summary>
      <div className="ln-control-dispatches">
        {dispatches.slice(-4).reverse().map(dispatch => <div key={dispatch.dispatchId} className="ln-control-dispatch"
          data-kind={dispatch.kind} data-status={dispatch.status}>
          <span>{loomDispatchKindLabel(dispatch.kind)}</span>
          <span>{loomDispatchStatusLabel(dispatch.status)}</span>
          <span>{taskTitle(tasks, dispatch.taskId)}</span>
          <span>{agentName(agents, dispatch.recipientAgentId)}</span>
        </div>)}
      </div>
    </details>}
  </>
}

export function ControlPanel({ missionId, threadId, thread, tasks, agents = [], port, attempt, onAttempt, theme = 'day', refreshToken = 0, onChanged }: {
  missionId: string
  /** 这项工作对应 Thread 的标识；与 `thread.thread.id` 不一致就不推举任何审查者。 */
  threadId: string | null
  /** 当前 Thread 的真实投影：独立审查者只从它的活跃成员里选。 */
  thread: ThreadSnapshot | null
  tasks: readonly LoomTask[]
  /** 助手档案：与 Thread 活跃成员取交集，不自动补人。 */
  agents?: readonly AgentProfile[]
  port: ControlPort
  /** 未确认的写入意图：由父层按 Mission 保存，关闭再开、切走再切回都不换 commandId。 */
  attempt: ControlAttempt | null
  onAttempt(next: ControlAttempt | null): void
  theme?: 'day' | 'night'
  /** 父层刷新计数：变了就重读一次真实快照 */
  refreshToken?: number
  /** 写入被真实接受后通知父层刷新其他投影 */
  onChanged?(): void
}) {
  const [read, setRead] = useState<ControlRead | null>(null)
  const [draft, setDraft] = useState<LoomControlDraft>(EMPTY_LOOM_CONTROL_DRAFT)
  const [editing, setEditing] = useState(false)
  const [pending, setPending] = useState<'' | 'configure' | 'pause'>('')
  const [failure, setFailure] = useState('')
  const [conflict, setConflict] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const generation = useRef(0)
  const missionRef = useRef(missionId)
  missionRef.current = missionId
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current += 1 }
  }, [])

  // 切工作：清掉一切属于上一项工作的编辑态；未确认意图由父层按 Mission 保管，不在本组件重建。
  useEffect(() => {
    setEditing(false)
    setDraft(EMPTY_LOOM_CONTROL_DRAFT)
    setPending('')
    setFailure('')
    setConflict(false)
  }, [missionId])

  // 读真实快照。切工作或重读时先回到「正在读取」，绝不把上一项工作的策略当答案。
  useEffect(() => {
    const ticket = ++generation.current
    setRead(null)
    void readControl(port, missionId).then(value => {
      if (!mounted.current || generation.current !== ticket || missionRef.current !== missionId) return
      setRead(value)
    })
    return () => { generation.current += 1 }
  }, [port, missionId, refreshToken, reloadToken])

  const policy = read !== null && read.status === 'observed' ? read.snapshot.policy : null
  const dispatches = read !== null && read.status === 'observed' ? read.snapshot.dispatches : []
  const stageReviews = read !== null && read.status === 'observed' ? read.snapshot.stageReviews : []
  const state = controlState(read)
  const writable = controlWritable(state)
  // 审查者范围只来自当前 Thread 的活跃成员；Thread 不匹配或读不到就是 unknown。
  const scope = reviewerScope(thread, threadId === null ? '' : threadId)
  const problems = controlPanelProblems(draft, tasks, agents, scope)
  const locked = attempt !== null
  const canApprove = editing && writable && !locked && !conflict && pending === '' && problems.length === 0
  // 暂停按钮在提交过程中仍保留，才能显示自己的进行中状态；是否能再点是两件事。
  const pauseVisible = !locked && !conflict && policy !== null && controlPauseAllowed(state, policy)
  const pausePressable = pauseVisible && pending === ''
  const factsVisible = state !== 'reading' && state !== 'unreadable'

  const reload = (): void => setReloadToken(value => value + 1)

  const openSettings = (): void => {
    if (!writable || locked) return
    setEditing(true)
    // 有策略才回填真实范围；没有就是空草稿，不预先勾任务、不预先填预算。
    setDraft(policy === null ? EMPTY_LOOM_CONTROL_DRAFT : loomControlDraftFromPolicy(policy))
    setFailure('')
    setConflict(false)
  }

  const closeSettings = (): void => {
    if (pending !== '') return
    setEditing(false)
    setDraft(EMPTY_LOOM_CONTROL_DRAFT)
    setFailure('')
  }

  // 所有回执只回填到发起它的那一次渲染：切 A→B→A 后旧 A 的回执不能覆盖新 A。
  const submit = async (issued: ControlAttempt): Promise<void> => {
    const token = generation.current
    setPending(issued.kind)
    setFailure('')
    setConflict(false)
    const outcome = await submitControl(port, issued)
    if (!mounted.current || token !== generation.current) return
    if (missionRef.current !== issued.missionId) return
    applyOutcome(issued, outcome)
  }

  const applyOutcome = (issued: ControlAttempt, outcome: ControlWrite): void => {
    if (!mounted.current || missionRef.current !== issued.missionId) return
    setPending('')
    if (outcome.status === 'applied') {
      onAttempt(null)
      setEditing(false)
      setDraft(EMPTY_LOOM_CONTROL_DRAFT)
      setFailure('')
      setConflict(false)
      setRead({ status: 'observed', snapshot: outcome.snapshot })
      reload()
      onChanged?.()
      return
    }
    if (outcome.status === 'rejected') {
      // Core 在写入前拒绝（源码已证实的有限码）：确定没有写入，可以按当前修订重新操作。
      onAttempt(null)
      setConflict(outcome.code === 'LOOM_CONTROL_REVISION_CONFLICT')
      setFailure(outcome.message)
      return
    }
    // 结果未知：保留同一个 commandId 与同一份 payload，只允许原样重发核对。
    setFailure(outcome.message === '' ? '提交结果未确认；请用同一请求核对。' : outcome.message)
  }

  const approve = async (): Promise<void> => {
    if (!canApprove) return
    const built = beginConfigure({
      missionId,
      commandId: crypto.randomUUID(),
      expectedRevision: policy?.revision ?? 0,
      draft,
      tasks,
      agents,
      scope
    })
    if (!('attempt' in built)) {
      if ('invalid' in built) setFailure(built.invalid)
      else setFailure(built.problems.map(problem => PROBLEM_LABEL[problem]).join('；'))
      return
    }
    onAttempt(built.attempt)
    await submit(built.attempt)
  }

  const flipPause = async (): Promise<void> => {
    if (!pausePressable || policy === null) return
    const built = beginPause({ missionId, commandId: crypto.randomUUID(), policy, paused: !policy.paused })
    if (!('attempt' in built)) {
      setFailure(built.problems.join('；'))
      return
    }
    onAttempt(built.attempt)
    await submit(built.attempt)
  }

  // 核对：同一个 attempt 原样重发，绝不生成新的请求编号。
  const verify = async (): Promise<void> => {
    if (attempt === null || pending !== '') return
    await submit(attempt)
  }

  const toggleTask = (taskId: string): void => {
    if (locked) return
    setDraft(current => current.taskIds.includes(taskId)
      ? { ...current, taskIds: current.taskIds.filter(entry => entry !== taskId) }
      : { ...current, taskIds: [...current.taskIds, taskId] })
  }

  const setReviewer = (taskId: string, reviewerAgentId: string): void => {
    if (locked) return
    setDraft(current => ({ ...current, reviewers: { ...current.reviewers, [taskId]: reviewerAgentId } }))
  }

  const patchDraft = (patch: Partial<LoomControlDraft>): void => {
    if (locked) return
    setDraft(current => ({ ...current, ...patch }))
  }

  return <section className="ln-control" data-control-state={state} aria-label="自动接力范围">
    <div className="ln-control-head">
      <div>
        <h3>自动接力</h3>
        <small>批准后 Core 只把列出的任务派给对应助手；暂停只挡住后续派发，不会停止正在运行的任务。成果仍需你自己验收。</small>
      </div>
      <span className="ln-control-state" data-state={state}>{STATE_LABEL[state]}</span>
      <div className="ln-control-actions">
        {state === 'unreadable' && <button type="button" className="ln-action" disabled={pending !== ''} onClick={reload}>重新读取</button>}
        {!editing && pauseVisible && <button type="button" className="ln-action"
          disabled={!pausePressable} onClick={() => { void flipPause() }}>
          {pending === 'pause' ? '正在提交…' : policy!.paused ? '继续接力' : '暂停接力'}
        </button>}
        {!editing && !locked && factsVisible && <button type="button" className="ln-action is-primary"
          disabled={!writable || pending !== ''} onClick={openSettings}>
          {policy === null ? '批准接力范围' : state === 'expired' ? '重新批准范围' : '修改接力范围'}
        </button>}
      </div>
    </div>

    <ControlSummary state={state} policy={policy} dispatches={dispatches} stageReviews={stageReviews}
      tasks={tasks} agents={agents}/>

    {state === 'expired' && <p className="ln-control-note is-warning" role="status">
      授权已过期（按主机判定的时间），不会继续派发；请重新确认范围。
    </p>}

    {pending !== '' && <p className="ln-control-note" role="status">
      {pending === 'configure' ? '正在提交接力范围…' : '正在提交暂停状态…'}
    </p>}

    {locked && attempt !== null && pending === '' && <div className="ln-control-note is-warning" role="alert">
      上次提交结果尚未确认。为免重复写入，范围与预算已锁定，只会用同一个请求编号原样核对。
      <div className="ln-control-actions">
        <button type="button" className="ln-action" disabled={pending !== ''} onClick={() => { void verify() }}>
          核对上次提交
        </button>
      </div>
    </div>}

    {editing && !locked && <div>
      {scope.status !== 'known' && <p className="ln-control-note is-warning" role="status">
        当前对话的成员尚未读到，暂时不能选择独立审查者；已选的审查者也不能提交。
      </p>}
      <div className="ln-control-tasks">
        {tasks.length === 0 && <p className="ln-control-empty">这项工作的计划里还没有可接力的任务。</p>}
        {tasks.map(task => {
          const selected = draft.taskIds.includes(task.taskId)
          const reviewer = draft.reviewers[task.taskId] ?? ''
          const choices = [
            { value: '', label: '选择独立审查者' },
            ...reviewerChoices(agents, scope, task.assigneeAgentId).map(agent => ({
              value: agent.agentId,
              label: agent.displayName,
              description: agent.teamRole
            }))
          ]
          return <div key={task.taskId} className={`ln-control-task${selected ? ' is-selected' : ''}`}>
            <input type="checkbox" checked={selected} disabled={pending !== '' || locked}
              aria-label={`纳入自动接力：${task.title}`} onChange={() => toggleTask(task.taskId)}/>
            <span className="ln-control-task-title">{task.title}</span>
            <span className="ln-control-task-meta">
              {task.assigneeAgentId === null ? '未指定执行者' : `执行者 ${agentName(agents, task.assigneeAgentId)}`}
            </span>
            <div className="ln-control-task-reviewer">
              <ChoiceMenu theme={theme} label={`独立审查者：${task.title}`} value={reviewer}
                disabled={!selected || pending !== '' || locked} choices={choices}
                onChange={value => setReviewer(task.taskId, value)}/>
            </div>
          </div>
        })}
      </div>
      <div className="ln-control-budgets">
        <label className="ln-field"><span>派发总上限</span>
          <input inputMode="numeric" value={draft.maxDispatches} placeholder="必填" disabled={pending !== '' || locked}
            onChange={event => patchDraft({ maxDispatches: event.target.value })}/>
        </label>
        <label className="ln-field"><span>每任务返工上限</span>
          <input inputMode="numeric" value={draft.maxReworksPerTask} placeholder="必填" disabled={pending !== '' || locked}
            onChange={event => patchDraft({ maxReworksPerTask: event.target.value })}/>
        </label>
        <label className="ln-field"><span>到期时间</span>
          <input type="datetime-local" value={draft.expiresAt} disabled={pending !== '' || locked}
            onChange={event => patchDraft({ expiresAt: event.target.value })}/>
        </label>
      </div>
      {problems.length > 0 && <ul className="ln-control-problems">
        {problems.map(problem => <li key={problem}>{PROBLEM_LABEL[problem]}</li>)}
      </ul>}
      <div className="ln-form-actions">
        <small>批准的是一次范围与预算，不是替你验收成果。</small>
        <button type="button" className="ln-action" disabled={pending !== ''} onClick={closeSettings}>取消</button>
        <button type="button" className="ln-action is-primary" disabled={!canApprove}
          onClick={() => { void approve() }}>{pending === 'configure' ? '正在批准…' : '批准此范围'}</button>
      </div>
    </div>}

    {conflict && <div className="ln-control-note is-warning" role="alert">
      接力范围已被改写，请重新读取后再按当前修订操作。
      <div className="ln-control-actions">
        <button type="button" className="ln-action" onClick={() => { setConflict(false); setFailure(''); reload() }}>重新读取</button>
      </div>
    </div>}
    {failure !== '' && !conflict && <FormMessage error>{failure}</FormMessage>}
  </section>
}

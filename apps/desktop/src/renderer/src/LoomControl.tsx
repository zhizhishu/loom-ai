import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentProfile, LoomCandidate, LoomTask } from '@contracts'
import { useThreadClient } from './camp-client'
import { uiAttribute, useUiText } from './interface-language'
import {
  EMPTY_LOOM_CONTROL_DRAFT,
  loomCandidateVersions,
  loomControlDraftFromPolicy,
  loomControlInput,
  loomControlProblems,
  loomControlRevisionConflict,
  loomControlSnapshotProblem,
  loomControlState,
  loomDispatchKindLabel,
  loomDispatchStatusLabel,
  loomDispatchTally,
  loomPolicyAuthorizationRevision,
  loomPolicyExpired,
  loomStageReviewFreshness,
  loomStageVerdictLabel,
  type LoomAssetRelation,
  type LoomControlDraft,
  type LoomControlPauseInput,
  type LoomControlPolicy,
  type LoomControlProblem,
  type LoomControlSnapshot,
  type LoomControlState,
  type LoomStageReview
} from './loom-control-model'

/**
 * 是否允许写入控制策略。
 * reading/unreadable 一律不可写：读不到就没有可比的 revision，写下去只能是猜。
 * 已批准要有真实 policy；未批准只在确实 unapproved（读成功且没策略）时可写。
 */
export function loomControlWritable(state: LoomControlState, policy: LoomControlPolicy | null): boolean {
  if (state === 'reading' || state === 'unreadable') return false
  return policy !== null || state === 'unapproved'
}

/**
 * 接力控制区：只决定「后面还派不派、返工几轮、谁审」。
 * 它不终止正在跑的运行，也不代替用户验收候选或批准发布——按钮只写控制策略，验收仍在交付页。
 * header 只留状态、预算用量与动作；范围与派发记录整块收进一个 details。
 */
export function LoomControl({ missionId, tasks, agents, snapshot, readError, onReload }: {
  missionId: string
  tasks: LoomTask[]
  agents: AgentProfile[]
  snapshot: LoomControlSnapshot | null
  readError: string
  onReload(): void
}) {
  const t = useUiText()
  const client = useThreadClient()
  const [draft, setDraft] = useState<LoomControlDraft>(EMPTY_LOOM_CONTROL_DRAFT)
  // 修改已批准范围必须由用户显式点开：不因为「读到了策略」就替他把表单填上。
  const [editing, setEditing] = useState(false)
  const [pending, setPending] = useState('')
  const [failure, setFailure] = useState('')
  // 修订冲突后本地不再假装成功：等用户刷新拿到真实 revision 才继续。
  const [conflict, setConflict] = useState(false)

  // 作用域栅栏：异步结果只回填到发起它的那一次任务渲染上，切任务后的旧响应一律丢弃。
  const identity = useRef({ missionId, generation: 0 })
  if (identity.current.missionId !== missionId) {
    identity.current = { missionId, generation: identity.current.generation + 1 }
  }
  const isStale = (mission: string, generation: number): boolean =>
    identity.current.missionId !== mission || identity.current.generation !== generation

  // 卸载即作废：还在飞的请求回来后不能回填已经消失的界面。
  useEffect(() => () => {
    identity.current = { missionId: identity.current.missionId, generation: identity.current.generation + 1 }
  }, [])

  // 切任务时用 layout effect 清掉编辑态与草稿：旧的 policy 草稿不能套到新任务上，也不允许中间帧带出去。
  useLayoutEffect(() => {
    setEditing(false)
    setDraft(EMPTY_LOOM_CONTROL_DRAFT)
    setPending('')
    setFailure('')
    setConflict(false)
  }, [missionId])

  const policy = snapshot?.policy ?? null
  const state = loomControlState(snapshot, readError)
  // 快照缺字段时不当「未批准」：先把缺的是哪个字段说出来。
  const snapshotProblem = snapshot === null ? null : loomControlSnapshotProblem(snapshot)
  // 过期只看服务端 evaluatedAt，不看本机时钟。
  const expired = policy !== null && snapshot !== null && loomPolicyExpired(policy, snapshot.evaluatedAt)
  const problems = loomControlProblems(draft)
  // 表单展开只由用户点击决定：未批准也不再自动铺开，读到状态不等于开始修改。
  const formOpen = editing
  // 可写性同时是 UI 与 handler 的门槛：读不到策略时不假装能改，也不丢用户已经填的草稿。
  const writable = loomControlWritable(state, policy)
  const canApprove = formOpen && writable && !conflict && pending === '' && problems.length === 0
  const dispatchRows = Array.isArray(snapshot?.dispatches) ? snapshot.dispatches : []
  const tally = loomDispatchTally(dispatchRows)
  // 范围与记录只在快照完整时展示：缺字段时连「已使用」也不能编。
  const factsVisible = policy !== null && state !== 'unreadable' && state !== 'reading'
  // 主动作只在「有策略」或「确实未批准」时给：读不到时不给任何结论性按钮。
  const actionsVisible = !formOpen && ((policy !== null && state !== 'unreadable') || (policy === null && state === 'unapproved'))
  // 暂停/继续只在真的能写、且不是已到期/已停用时才给：到期不能靠「继续」复活。
  const pauseAllowed = writable && policy !== null && !expired && state !== 'disabled'

  const stateLabel = state === 'reading' ? t('正在读取控制策略…')
    : state === 'unreadable' ? t('控制策略读取失败')
      : state === 'unapproved' ? t('尚未批准接力范围')
        : state === 'disabled' ? t('接力已停用')
          : state === 'expired' ? t('授权已过期')
            : state === 'paused' ? t('接力已暂停')
              : t('接力已批准')

  const problemText: Record<LoomControlProblem, string> = {
    no_tasks: t('请选择要纳入接力的任务'),
    missing_reviewer: t('每个任务都需要一名独立审查者'),
    max_dispatches: t('请填写派发总上限（正整数）'),
    max_reworks: t('请填写每任务返工上限（非负整数）'),
    expires_at: t('到期时间无法解析')
  }

  const agentName = (agentId: string): string => agents.find(agent => agent.agentId === agentId)?.displayName ?? agentId

  const toggleTask = (taskId: string): void => setDraft(current => current.taskIds.includes(taskId)
    ? { ...current, taskIds: current.taskIds.filter(entry => entry !== taskId) }
    : { ...current, taskIds: [...current.taskIds, taskId] })

  const setReviewer = (taskId: string, reviewerAgentId: string): void => setDraft(current => ({
    ...current,
    reviewers: { ...current.reviewers, [taskId]: reviewerAgentId }
  }))

  const openSettings = (): void => {
    setEditing(true)
    // 有策略才回填当前范围；没有策略就是空草稿，不预先勾任务、不预先填权限。
    setDraft(policy === null ? EMPTY_LOOM_CONTROL_DRAFT : loomControlDraftFromPolicy(policy))
    setFailure('')
    setConflict(false)
  }

  const closeSettings = (): void => {
    setEditing(false)
    setDraft(EMPTY_LOOM_CONTROL_DRAFT)
    setFailure('')
  }

  const failureText = (error: unknown, fallback: string): string =>
    loomControlRevisionConflict(error) ? t('控制策略已被改写，请刷新后按当前修订重新操作') : error instanceof Error ? error.message : fallback

  const approve = async (): Promise<void> => {
    if (!canApprove) return
    const input = loomControlInput(missionId, crypto.randomUUID(), policy?.revision ?? 0, draft)
    if (input === null) return
    const mission = missionId
    const generation = identity.current.generation
    setPending('configure')
    setFailure('')
    setConflict(false)
    try {
      await client.request<LoomControlSnapshot>('loom.control.configure', input)
      // 任务已切换：旧任务的批准结果不回填到新任务界面。
      if (isStale(mission, generation)) return
      setEditing(false)
      setDraft(EMPTY_LOOM_CONTROL_DRAFT)
      setPending('')
      onReload()
    } catch (error) {
      if (isStale(mission, generation)) return
      setConflict(loomControlRevisionConflict(error))
      setFailure(failureText(error, t('批准接力范围失败')))
      setPending('')
    }
  }

  const flipPause = async (): Promise<void> => {
    if (!pauseAllowed || policy === null || pending !== '' || conflict) return
    const input: LoomControlPauseInput = {
      missionId,
      commandId: crypto.randomUUID(),
      expectedRevision: policy.revision,
      paused: !policy.paused
    }
    const mission = missionId
    const generation = identity.current.generation
    setPending('pause')
    setFailure('')
    setConflict(false)
    try {
      await client.request<LoomControlSnapshot>('loom.control.pause', input)
      if (isStale(mission, generation)) return
      setPending('')
      onReload()
    } catch (error) {
      if (isStale(mission, generation)) return
      setConflict(loomControlRevisionConflict(error))
      setFailure(failureText(error, t('暂停接力失败')))
      setPending('')
    }
  }

  return <section className="loom-control" data-control-state={state} aria-label={uiAttribute('接力控制')}>
    <header className="loom-control-header">
      <h3>{t('自动接力')}</h3>
      <span className="loom-control-state">{stateLabel}</span>
      {factsVisible && policy !== null
        && <span className="loom-control-summary">{t('已使用 {0} / 上限 {1}', tally.used, policy.maxDispatches)}</span>}
      {actionsVisible && policy !== null && <div className="loom-control-actions">
        {/* pauseAllowed 已含 writable 与「到期/停用不提供继续」：handler 里同样复检。 */}
        {pauseAllowed
          && <button type="button" className="loom-control-pause" title={uiAttribute('仅暂停后续任务')}
            disabled={pending !== '' || conflict} onClick={() => void flipPause()}>
            {pending === 'pause' ? t('正在提交…') : policy.paused ? t('继续接力') : t('暂停接力')}
          </button>}
        <button type="button" className="loom-control-edit" disabled={pending !== '' || conflict} onClick={openSettings}>
          {expired ? t('重新批准') : t('设置接力')}
        </button>
      </div>}
      {actionsVisible && policy === null && <div className="loom-control-actions">
        <button type="button" className="loom-control-edit" disabled={pending !== '' || conflict} onClick={openSettings}>
          {t('设置接力')}
        </button>
      </div>}
    </header>

    {state === 'unreadable' && <>
      <p className="loom-control-note" role="alert">{t('接力状态暂时读不到，请重试。')}</p>
      {(readError !== '' || snapshotProblem !== null) && <details className="loom-control-details">
        <summary>{t('技术细节')}</summary>
        {readError !== '' && <p className="loom-control-failure">{readError}</p>}
        {readError === '' && snapshotProblem !== null
          && <p className="loom-control-failure">{t('控制快照缺少必需字段：{0}', snapshotProblem)}</p>}
      </details>}
      <div className="loom-control-actions">
        <button type="button" className="loom-btn-cancel" disabled={pending !== ''} onClick={onReload}>{t('重新读取')}</button>
      </div>
    </>}

    {factsVisible && policy !== null && <details className="loom-control-details">
      <summary>{t('范围与记录')}</summary>
      <div className="loom-control-facts">
        <div className="loom-control-fact"><span>{t('纳入任务')}</span><strong>{policy.taskIds.length}</strong></div>
        <div className="loom-control-fact"><span>{t('独立审查者')}</span><strong>{policy.reviewers.length}</strong></div>
        <div className="loom-control-fact"><span>{t('每任务返工上限')}</span><strong>{policy.maxReworksPerTask}</strong></div>
        <div className="loom-control-fact"><span>{t('修订')}</span><strong>{policy.revision}</strong></div>
        <div className="loom-control-fact"><span>{t('授权版本')}</span><strong>{loomPolicyAuthorizationRevision(policy) ?? '—'}</strong></div>
        <div className="loom-control-fact"><span>{t('到期')}</span><strong>{policy.expiresAt === null ? t('不设到期') : policy.expiresAt}</strong></div>
        <div className="loom-control-fact"><span>{t('批准人')}</span><strong>{agentName(policy.approvedBy)}</strong></div>
      </div>
      {dispatchRows.length > 0 && <div className="loom-control-dispatches">
        <span className="loom-eyebrow">{t('派发记录')}</span>
        {dispatchRows.slice(-4).reverse().map(dispatch => <div key={dispatch.dispatchId} className="loom-dispatch"
          data-kind={dispatch.kind} data-status={dispatch.status}>
          <span>{loomDispatchKindLabel(dispatch.kind)}</span>
          <span>{loomDispatchStatusLabel(dispatch.status)}</span>
          <span>{agentName(dispatch.recipientAgentId)}</span>
          {dispatch.reason !== null && <span>{dispatch.reason}</span>}
        </div>)}
      </div>}
    </details>}

    {state === 'expired' && <p className="loom-control-note" role="status">{t('已到期，请重新确认接力范围。')}</p>}

    {formOpen && <div className="loom-control-form">
      <div className="loom-control-tasks">
        {tasks.map(task => {
          const selected = draft.taskIds.includes(task.taskId)
          const reviewer = draft.reviewers[task.taskId] ?? ''
          return <div key={task.taskId} className="loom-control-task" data-task-id={task.taskId}>
            <input
              type="checkbox" className="loom-control-task-input" checked={selected}
              aria-label={uiAttribute('纳入接力：{0}', task.title)}
              onChange={() => toggleTask(task.taskId)}/>
            <span className="loom-control-task-title">{task.title}</span>
            {task.assigneeAgentId !== null && <span className="loom-control-assignee">
              {t('执行者 {0}', agentName(task.assigneeAgentId))}
            </span>}
            <select
              className="loom-control-reviewer" value={reviewer} disabled={!selected}
              aria-label={uiAttribute('独立审查者：{0}', task.title)}
              onChange={event => setReviewer(task.taskId, event.target.value)}>
              <option value="">{t('选择独立审查者')}</option>
              {/* 独立审查者排除执行者本人：责任与复核不应该是同一个人的自证。 */}
              {agents.filter(agent => agent.agentId !== task.assigneeAgentId)
                .map(agent => <option key={agent.agentId} value={agent.agentId}>{agent.displayName}</option>)}
            </select>
            {task.assigneeAgentId !== null
              && <span className="loom-control-excluded">{t('执行者不在审查者可选项内')}</span>}
          </div>
        })}
      </div>
      <div className="loom-control-budgets">
        <label className="loom-control-field">
          <span>{t('派发总上限')}</span>
          <input
            className="loom-control-max-dispatches" inputMode="numeric" value={draft.maxDispatches}
            placeholder={t('必填')} onChange={event => {
              const value = event.target.value
              setDraft(current => ({ ...current, maxDispatches: value }))
            }}/>
        </label>
        <label className="loom-control-field">
          <span>{t('每任务返工上限')}</span>
          <input
            className="loom-control-max-reworks" inputMode="numeric" value={draft.maxReworksPerTask}
            placeholder={t('必填')} onChange={event => {
              const value = event.target.value
              setDraft(current => ({ ...current, maxReworksPerTask: value }))
            }}/>
        </label>
        <label className="loom-control-field">
          <span>{t('到期时间')}</span>
          <input
            className="loom-control-expires" type="datetime-local" value={draft.expiresAt}
            onChange={event => {
              const value = event.target.value
              setDraft(current => ({ ...current, expiresAt: value }))
            }}/>
        </label>
      </div>
      {problems.length > 0 && <ul className="loom-control-problems">
        {problems.map(problem => <li key={problem}>{problemText[problem]}</li>)}
      </ul>}
      <div className="loom-control-actions">
        <button type="button" className="loom-control-approve loom-btn-approve" disabled={!canApprove}
          onClick={() => void approve()}>
          {pending === 'configure' ? t('正在批准…') : t('批准此范围')}
        </button>
        <button type="button" className="loom-btn-cancel" disabled={pending !== ''} onClick={closeSettings}>
          {t('取消')}
        </button>
      </div>
    </div>}

    {failure !== '' && <p className="loom-control-failure" role="alert">
      {failure}
      {conflict && <button type="button" className="loom-btn-cancel" onClick={() => {
        setConflict(false)
        setFailure('')
        onReload()
      }}>{t('刷新')}</button>}
    </p>}
  </section>
}

/** 路径取文件名：主文案只给 basename，完整路径留在 details 里。 */
function loomBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

/**
 * 资产关系区：生成者 → 文件 → 审查 → 你的确认（→ 下游任务）。
 * 全部就地派生自真实投影：接受状态只来自传入的 candidates，读不到就说「未知」。
 * 审查状态与 StageReviewFact 同一套 freshness：旧授权的 pass 不许显示成当前通过。
 */
export function LoomAssetGraph({ relations, tasks, agents, candidates = [], policy = null, onFocusCandidate }: {
  relations: readonly LoomAssetRelation[]
  tasks: readonly LoomTask[]
  agents: readonly AgentProfile[]
  /** 候选投影：只用来读版本号与接受状态；没传就不显示，不猜成「待确认」。 */
  candidates?: readonly LoomCandidate[]
  /** 当前授权：缺省即「授权未知」，不把旧审查当成通过。 */
  policy?: LoomControlPolicy | null
  onFocusCandidate(candidateId: string): void
}) {
  const t = useUiText()
  if (relations.length === 0) return null
  const agentName = (agentId: string): string => agents.find(agent => agent.agentId === agentId)?.displayName ?? agentId
  const taskTitle = (taskId: string): string => tasks.find(task => task.taskId === taskId)?.title ?? taskId
  const versions = loomCandidateVersions(candidates)
  const versionOf = (candidateId: string): number | null =>
    versions.find(entry => entry.candidateId === candidateId)?.version ?? null
  const acceptanceOf = (candidateId: string): LoomCandidate['acceptanceStatus'] | null =>
    candidates.find(candidate => candidate.candidateId === candidateId)?.acceptanceStatus ?? null
  const acceptanceLabel = (status: LoomCandidate['acceptanceStatus'] | null): string =>
    status === 'accepted' ? t('已接受')
      : status === 'rejected' ? t('已退回')
        : status === 'pending' ? t('等待你确认')
          // 读不到候选就不假装「待确认」：那是把缺失当成结论。
          : t('接受状态未知')
  // 生产者只认登记事实：creatorId 显示真实名字；只有 runId 时才说「执行记录」，不拿 assignee 猜。
  const producerLabel = (relation: LoomAssetRelation): string =>
    relation.producerCreatorId !== null ? agentName(relation.producerCreatorId)
      : relation.producerAgentRunId !== null ? t('执行记录')
        : t('生产者未知')
  const artifactLabel = (relation: LoomAssetRelation): string => {
    const version = versionOf(relation.candidateId)
    const suffix = version === null ? '' : ` v${version}`
    if (relation.relativePath === null || relation.relativePath === '') {
      return relation.registration === 'unknown' ? t('产物登记读不到') : t('未登记的产物')
    }
    return `${loomBaseName(relation.relativePath)}${suffix}`
  }
  // 和图外的 StageReviewFact 用同一套判定：stale 一律标失效，unknown 一律说授权未知。
  const reviewFreshness = (relation: LoomAssetRelation): string => relation.stageReview === null
    ? 'none'
    : loomStageReviewFreshness(relation.stageReview, policy)
  const reviewLabel = (relation: LoomAssetRelation): string => {
    const review = relation.stageReview
    if (review === null) return t('尚未审查')
    const freshness = reviewFreshness(relation)
    const verdict = freshness === 'current' ? loomStageVerdictLabel(review.verdict)
      : freshness === 'stale' ? t('{0} · 旧授权已失效', loomStageVerdictLabel(review.verdict))
        : t('{0} · 授权未知', loomStageVerdictLabel(review.verdict))
    return `${agentName(review.reviewerAgentId)} · ${verdict}`
  }
  return <section className="loom-asset-graph" aria-label={uiAttribute('资产关系')}>
    <div className="loom-asset-header">
      <span className="loom-eyebrow">{t('成果流转')}</span>
    </div>
    {relations.map(relation => <div
      key={relation.key} className="loom-asset-row"
      data-registration={relation.registration}
      data-has-consumer={relation.consumers.length > 0 ? 'true' : 'false'}
      data-acceptance={acceptanceOf(relation.candidateId) ?? 'unknown'}>
      <span className="loom-asset-step loom-asset-producer" data-step="producer">{producerLabel(relation)}</span>
      <span className="loom-asset-arrow" aria-hidden="true">→</span>
      <span className="loom-asset-step loom-asset-artifact" data-step="artifact">{artifactLabel(relation)}</span>
      <span className="loom-asset-arrow" aria-hidden="true">→</span>
      <span className="loom-asset-step loom-asset-review" data-step="review"
        // 旧授权或未知授权的审查不带 pass 语义：绿标只能属于「当前授权下的通过」。
        data-verdict={relation.stageReview === null ? 'none'
          : reviewFreshness(relation) === 'current' ? relation.stageReview.verdict : 'not-current'}
        data-freshness={reviewFreshness(relation)}>
        {reviewLabel(relation)}
      </span>
      <span className="loom-asset-arrow" aria-hidden="true">→</span>
      <span className="loom-asset-step loom-asset-acceptance" data-step="acceptance">
        {acceptanceLabel(acceptanceOf(relation.candidateId))}
      </span>
      {relation.consumers.length > 0 && <>
        <span className="loom-asset-arrow" aria-hidden="true">→</span>
        <span className="loom-asset-step loom-asset-consumer" data-step="consumer" data-known="true">
          {relation.consumers.map(consumer => taskTitle(consumer.downstreamTaskId)).join('、')}
        </span>
      </>}
      <button type="button" className="loom-asset-focus" onClick={() => onFocusCandidate(relation.candidateId)}>
        {t('查看成果')}
      </button>
      <details className="loom-asset-details">
        <summary>{t('技术细节')}</summary>
        <div className="loom-asset-candidate">{t('候选 {0}', relation.candidateId)}</div>
        <div>{t('产物 {0}', relation.relativePath ?? relation.evidenceId)}</div>
        {relation.producerAgentRunId !== null && <div>{t('生产 Run {0}', relation.producerAgentRunId)}</div>}
        {relation.producerCreatorId !== null && <div>{t('登记人 {0}', relation.producerCreatorId)}</div>}
        <div>{t('任务 {0}', relation.taskId)}</div>
      </details>
    </div>)}
  </section>
}

/** 交付卡片上的助手审查块：与技术核验、用户接受分开渲染，不合并成一个状态。 */
export function LoomStageReviewFact({ stageReview, failed, agents, policy }: {
  stageReview: LoomStageReview | null
  /** 整个 stageReview 投影读不到（null 数组），不是「没有审查」 */
  failed: boolean
  agents: readonly AgentProfile[]
  /** 当前授权：用来判定这条审查是否仍代表当前授权（policyRevision vs authorizationRevision） */
  policy: LoomControlPolicy | null
}) {
  const t = useUiText()
  const reviewerLabel = (agentId: string): string => agents.find(agent => agent.agentId === agentId)?.displayName ?? agentId
  const freshness = stageReview === null ? null : loomStageReviewFreshness(stageReview, policy)
  // 旧授权的 pass 绝不渲染成「当前通过」；request_changes/blocked 也不是人工驳回。
  const verdict = stageReview === null
    ? (failed ? t('审查读取失败') : t('尚无审查'))
    : freshness === 'current' ? loomStageVerdictLabel(stageReview.verdict)
      : freshness === 'stale' ? t('{0} · 旧授权已失效', loomStageVerdictLabel(stageReview.verdict))
        : t('{0} · 授权未知', loomStageVerdictLabel(stageReview.verdict))
  return <>
    {/* 主行只给「谁审的 + 结论」；理由与逐条标准是长文本，展开再看。 */}
    {stageReview !== null && <span className="loom-stage-reviewer">{reviewerLabel(stageReview.reviewerAgentId)}</span>}
    <span className="loom-stage-badge" data-verdict={stageReview?.verdict ?? (failed ? 'unknown' : 'none')}
      data-freshness={freshness ?? (failed ? 'unknown' : 'none')}>{verdict}</span>
    {stageReview !== null && <details className="loom-candidate-stage-review">
      <summary>{t('审查理由与逐条标准')}</summary>
      <div className="loom-stage-reason">{stageReview.reason}</div>
      {stageReview.criteriaResults.map(result => <div key={result.criterionId} className="loom-stage-criterion">
        {result.satisfied ? t('满足') : t('未满足')} · {result.criterionId}
      </div>)}
    </details>}
  </>
}

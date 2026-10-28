import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentProfile, MissionRecord, LoomPlan, LoomTask, LoomDependency, LoomTaskStatus, LoomCandidate, LoomReview, LoomVerification } from '@contracts'
import { loomTaskReady } from '@contracts'
import { Icon } from './MissionControls'
import { MissionDeliveryPanel, MissionActivityPanel } from './MissionDelivery'
import { UiText, uiAttribute, useUiText } from './interface-language'
import { useThreadClient } from './camp-client'

export type LoomSection = 'activity' | 'plan' | 'delivery'

function LoomEmpty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="loom-empty">
    <span className="loom-empty-mark" aria-hidden="true"><i/><i/><i/></span>
    <h3>{title}</h3>
    <div>{children}</div>
  </div>
}

type FlowPoint = { x: number; y: number }
/** 单个节点的四向锚点：泳道图只连 right→left，上下锚点留给同列兜底。 */
type FlowNodeAnchors = { top: FlowPoint; right: FlowPoint; bottom: FlowPoint; left: FlowPoint }
type FlowLayout = { width: number; height: number; nodes: ReadonlyMap<string, FlowNodeAnchors> }

const EMPTY_FLOW_LAYOUT: FlowLayout = { width: 0, height: 0, nodes: new Map<string, FlowNodeAnchors>() }
const FLOW_ARROW_MARKER = 'loom-flow-arrow'

function sameFlowPoint(a: FlowPoint, b: FlowPoint): boolean {
  return a.x === b.x && a.y === b.y
}

function sameFlowLayout(a: FlowLayout, b: FlowLayout): boolean {
  if (a.width !== b.width || a.height !== b.height || a.nodes.size !== b.nodes.size) return false
  for (const [taskId, anchors] of b.nodes) {
    const current = a.nodes.get(taskId)
    if (current === undefined) return false
    if (!sameFlowPoint(current.top, anchors.top) || !sameFlowPoint(current.right, anchors.right)
      || !sameFlowPoint(current.bottom, anchors.bottom) || !sameFlowPoint(current.left, anchors.left)) return false
  }
  return true
}

/**
 * 按依赖深度分泳道：无上游 = 0，其余 = 1 + max(所有上游)。
 * 防环：迭代轮次上限 tasks.length，环上算不出来的任务不会死循环也不会抛错，
 * 收尾时统一归到已经算出的最大深度。悬空边（上游不在本次任务集里）直接忽略。
 */
function flowDepths(tasks: LoomTask[], dependencies: LoomDependency[]): Map<string, number> {
  const depths = new Map<string, number>()
  const known = new Set(tasks.map(task => task.taskId))
  for (let round = 0; round <= tasks.length; round += 1) {
    let settled = false
    for (const task of tasks) {
      if (depths.has(task.taskId)) continue
      let depth = 0
      let pending = false
      for (const dependency of dependencies) {
        if (dependency.downstreamTaskId !== task.taskId) continue
        if (!known.has(dependency.upstreamTaskId)) continue
        const upstreamDepth = depths.get(dependency.upstreamTaskId)
        if (upstreamDepth === undefined) { pending = true; break }
        if (upstreamDepth + 1 > depth) depth = upstreamDepth + 1
      }
      if (pending) continue
      depths.set(task.taskId, depth)
      settled = true
    }
    if (!settled) break
  }
  let deepest = 0
  for (const depth of depths.values()) if (depth > deepest) deepest = depth
  for (const task of tasks) if (!depths.has(task.taskId)) depths.set(task.taskId, deepest)
  return depths
}

/** 上游右侧中点到下游左侧中点的三次贝塞尔：控制点横向居中，箭头落在下游左侧。 */
function flowEdgePath(upstream: FlowPoint, downstream: FlowPoint): string {
  const middle = (upstream.x + downstream.x) / 2
  return `M ${upstream.x} ${upstream.y} C ${middle} ${upstream.y}, ${middle} ${downstream.y}, ${downstream.x} ${downstream.y}`
}

/** 依赖图渲染：archify 流程视图。就绪判定走控制层契约，不在 UI 里另立规则。 */
function LoomFlow({ tasks, dependencies, candidates, reviews, agents }: {
  tasks: LoomTask[]
  dependencies: LoomDependency[]
  candidates: LoomCandidate[]
  reviews: LoomReview[]
  agents: AgentProfile[]
}) {
  const t = useUiText()
  // 界面文案：契约里的枚举值是英文标识，不直接展示给用户。
  const statusLabels: Record<LoomTaskStatus, string> = {
    draft: '草稿', ready: '就绪', blocked: '阻塞', in_review: '评审中', done: '已完成', canceled: '已取消'
  }
  // 候选与人工验收记录一律喂真实读取结果：artifact_accepted 边只认 verified + accepted + 同版本 Review，
  // 不会被"上游 done"误判为已验收。evaluatedAt 固定为纪元，求值是纯规则，不给渲染引入会漂移的输入。
  const graph = { tasks, dependencies, candidates, reviews, evaluatedAt: new Date(0).toISOString() }
  // 「可执行」= 依赖已释放 且 任务本身处于可领取状态；done/canceled/draft 不算可执行。
  const claimable = (task: LoomTask): boolean =>
    (task.status === 'ready' || task.status === 'in_review') && loomTaskReady(task.taskId, graph).ready
  const readyTasks = tasks.filter(claimable)
  const blockedTasks = tasks.filter(task => task.status === 'blocked')
  
  // 泳道：depth 0 在最左，往右递增。列内保持 tasks 原顺序，不另排序。
  const depths = flowDepths(tasks, dependencies)
  const tasksByDepth = new Map<number, LoomTask[]>()
  for (const task of tasks) {
    const depth = depths.get(task.taskId) ?? 0
    const lane = tasksByDepth.get(depth)
    if (lane === undefined) tasksByDepth.set(depth, [task])
    else lane.push(task)
  }
  const lanes = [...tasksByDepth.keys()].sort((a, b) => a - b)
    .map(depth => ({ depth, tasks: tasksByDepth.get(depth) ?? [] }))
  
  // 连线坐标靠实测：布局后量一次，容器尺寸变化（缩放、tab 切换、主题）再量。
  const graphRef = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef(new Map<string, HTMLDivElement>())
  const [layout, setLayout] = useState<FlowLayout>(EMPTY_FLOW_LAYOUT)
  
  const measure = useCallback((): void => {
    const container = graphRef.current
    if (container === null) return
    const bounds = container.getBoundingClientRect()
    const nodes = new Map<string, FlowNodeAnchors>()
    for (const [taskId, element] of nodeRefs.current) {
      const rect = element.getBoundingClientRect()
      // 相对图容器的 padding 原点，加回滚动量，跟着内容一起滚。
      const left = rect.left - bounds.left + container.scrollLeft
      const top = rect.top - bounds.top + container.scrollTop
      nodes.set(taskId, {
        top: { x: left + rect.width / 2, y: top },
        right: { x: left + rect.width, y: top + rect.height / 2 },
        bottom: { x: left + rect.width / 2, y: top + rect.height },
        left: { x: left, y: top + rect.height / 2 }
      })
    }
    const next: FlowLayout = { width: container.scrollWidth, height: container.scrollHeight, nodes }
    setLayout(current => sameFlowLayout(current, next) ? current : next)
  }, [])
  
  useLayoutEffect(() => {
    measure()
    const container = graphRef.current
    if (container === null) return
    const observer = new ResizeObserver(() => measure())
    observer.observe(container)
    return () => observer.disconnect()
  }, [measure, tasks, dependencies])
  
  return <div className="loom-flow">
    <div className="loom-flow-header">
      <span className="loom-eyebrow">{t('任务依赖')}</span>
      <div className="loom-flow-stats">
        <span>{t('可执行')}: {readyTasks.length}</span>
        <span>{t('阻塞')}: {blockedTasks.length}</span>
        <span>{t('总任务')}: {tasks.length}</span>
      </div>
    </div>
    
    <div className="loom-flow-graph" ref={graphRef}>
      {layout.width > 0 && layout.height > 0 && <svg
        className="loom-flow-edges" width={layout.width} height={layout.height}
        aria-hidden="true" focusable="false">
        <defs>
          {[FLOW_ARROW_MARKER, `${FLOW_ARROW_MARKER}-artifact-accepted`, `${FLOW_ARROW_MARKER}-blocked`].map(id => <marker
            key={id} id={id} className={id} viewBox="0 0 8 8" refX="7.4" refY="4"
            markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0.6 1 L7.4 4 L0.6 7 Z"/>
          </marker>)}
        </defs>
        {dependencies.map(dependency => {
          const upstream = layout.nodes.get(dependency.upstreamTaskId)
          const downstream = layout.nodes.get(dependency.downstreamTaskId)
          if (!upstream || !downstream) return null
          // artifact_accepted 边没有冻结溯源 = 尚未释放（人工验收缺席）。
          const unreleased = dependency.resolution === null && dependency.condition === 'artifact_accepted'
          const downstreamTask = tasks.find(task => task.taskId === dependency.downstreamTaskId)
          const blocked = unreleased || downstreamTask?.status === 'blocked'
          const conditionClass = dependency.condition === 'task_done'
            ? 'loom-flow-edge-task-done'
            : 'loom-flow-edge-artifact-accepted'
          const marker = blocked
            ? `${FLOW_ARROW_MARKER}-blocked`
            : dependency.condition === 'task_done' ? FLOW_ARROW_MARKER : `${FLOW_ARROW_MARKER}-artifact-accepted`
          return <path
            key={dependency.dependencyId}
            className={`loom-flow-edge ${conditionClass}${blocked ? ' loom-flow-edge-blocked' : ''}`}
            data-edge-id={dependency.dependencyId}
            markerEnd={`url(#${marker})`}
            d={flowEdgePath(upstream.right, downstream.left)}/>
        })}
      </svg>}
      {lanes.map(lane => <div key={lane.depth} className="loom-flow-lane" data-depth={lane.depth}>
        <span className="loom-flow-lane-label">{t('阶段')} {lane.depth + 1}</span>
        {lane.tasks.map(task => {
          const upstreams = dependencies.filter(d => d.downstreamTaskId === task.taskId)
          const ready = claimable(task)
          const assignee = agents.find(a => a.agentId === task.assigneeAgentId)
          
          return <div
            key={task.taskId}
            ref={element => {
              if (element === null) nodeRefs.current.delete(task.taskId)
              else nodeRefs.current.set(task.taskId, element)
            }}
            className={`loom-flow-node ${ready ? 'ready' : ''} ${task.status}`}>
            <div className="loom-flow-node-header">
              <span className="loom-flow-node-dot" data-status={task.status}/>
              <span className="loom-flow-node-title">{task.title}</span>
            </div>
            <div className="loom-flow-node-meta">
              <span className="loom-flow-node-status">{statusLabels[task.status]}</span>
            </div>
            {assignee && <div className="loom-flow-node-assignee">{assignee.displayName}</div>}
            {upstreams.length > 0 && (
              <div className="loom-flow-node-deps">
                {t('依赖')}: {upstreams.map(d => {
                  const upstream = tasks.find(entry => entry.taskId === d.upstreamTaskId)
                  return upstream?.title ?? d.upstreamTaskId
                }).join(', ')}
              </div>
            )}
            {task.blockedReason && (
              <div className="loom-flow-node-blocked">{task.blockedReason}</div>
            )}
          </div>
        })}
      </div>)}
    </div>
    
    <div className="loom-flow-legend">
      <span className="loom-flow-legend-item loom-flow-legend-task-done">{t('任务完成即可放行')}</span>
      <span className="loom-flow-legend-item loom-flow-legend-artifact-accepted">{t('需人工验收后放行')}</span>
      <span className="loom-flow-legend-item loom-flow-legend-blocked">{t('当前阻塞')}</span>
    </div>
  </div>
}

function PlanWorkspace({ mission, agents, plan, tasks, dependencies, candidates, reviews, loading, error }: {
  mission: MissionRecord
  agents: AgentProfile[]
  plan: LoomPlan | null
  tasks: LoomTask[]
  dependencies: LoomDependency[]
  candidates: LoomCandidate[]
  reviews: LoomReview[]
  loading?: boolean
  error?: string
}) {
  const t = useUiText()
  
  if (loading) {
    return <div className="loom-plan">
      <header className="loom-section-heading">
        <div><span className="loom-eyebrow">LOOM · {t('编排')}</span><h2>{t('工作关系')}</h2></div>
        <span className="loom-number">M-{String(mission.number).padStart(3, '0')}</span>
      </header>
      <LoomEmpty title={t('正在读取编排…')}>
        <p>{t('从控制面读取计划、任务与依赖关系。')}</p>
      </LoomEmpty>
    </div>
  }
  
  if (error) {
    return <div className="loom-plan">
      <header className="loom-section-heading">
        <div><span className="loom-eyebrow">LOOM · {t('编排')}</span><h2>{t('工作关系')}</h2></div>
        <span className="loom-number">M-{String(mission.number).padStart(3, '0')}</span>
      </header>
      <LoomEmpty title={t('读取编排失败')}>
        <p>{error}</p>
        <p>{t('请检查控制面连接后重试。')}</p>
      </LoomEmpty>
    </div>
  }
  
  if (!plan || tasks.length === 0) {
    return <div className="loom-plan">
      <header className="loom-section-heading">
        <div><span className="loom-eyebrow">LOOM · {t('编排')}</span><h2>{t('工作关系')}</h2></div>
        <span className="loom-number">M-{String(mission.number).padStart(3, '0')}</span>
      </header>
      <p className="loom-intro">{t('把目标、责任与交付放在同一张工作图上。执行状态和人工验收各自保留。')}</p>
      <LoomEmpty title={t('尚未配置编排')}>
        <p>{t('这个使命还没有任务依赖或执行计划。')}</p>
        <p>{t('由主助手建立计划后，这里会显示任务关系、负责队员和真实阻塞。')}</p>
      </LoomEmpty>
      <section className="loom-foundation" aria-label={uiAttribute('当前使命基础')}>
        <div><span>{t('当前使命')}</span><strong>{mission.title}</strong></div>
        <div><span>{t('队员')}</span><strong>{mission.memberAgentIds.length}</strong></div>
        <div><span>{t('执行中')}</span><strong>{mission.runningAgentIds.length}</strong></div>
      </section>
    </div>
  }
  
  return <div className="loom-plan">
    <header className="loom-section-heading">
      <div><span className="loom-eyebrow">LOOM · {t('编排')}</span><h2>{plan.goal}</h2></div>
      <span className="loom-number">M-{String(mission.number).padStart(3, '0')}</span>
    </header>
    <p className="loom-intro">{t('把目标、责任与交付放在同一张工作图上。执行状态和人工验收各自保留。')}</p>
    <LoomFlow tasks={tasks} dependencies={dependencies} candidates={candidates} reviews={reviews} agents={agents} />
  </div>
}

/** 一次人工验收的在途表单：勾选集合按 criterionId 记，不依赖数组下标。 */
type DeliveryDraft = {
  candidateId: string
  verdict: 'accepted' | 'rejected'
  reason: string
  satisfied: readonly string[]
}

function DeliveryReview({ candidates, reviews, verifications, plan, missionId, onRefresh }: {
  candidates: LoomCandidate[]
  reviews: LoomReview[]
  verifications: LoomVerification[]
  plan: LoomPlan | null
  missionId: string
  onRefresh: () => void
}) {
  const t = useUiText()
  const client = useThreadClient()
  const [draft, setDraft] = useState<DeliveryDraft | null>(null)
  // 写入是串行的人工动作：在途时禁用全部操作，避免重复 commandId 之外的并发提交。
  const [pending, setPending] = useState('')
  // 错误只挂在出事的候选上：别的卡片不该替它报错。
  const [failure, setFailure] = useState<{ candidateId: string; message: string } | null>(null)
  // 枚举值是英文标识，不直接展示；data-state 仍保留原值，两个徽章各看各的状态，不合并。
  const verificationLabel = (state: LoomCandidate['verificationStatus']): string =>
    state === 'verified' ? t('已核验') : state === 'failed' ? t('核验失败') : t('未核验')
  const acceptanceLabel = (state: LoomCandidate['acceptanceStatus']): string =>
    state === 'accepted' ? t('已验收') : state === 'rejected' ? t('已驳回') : t('待验收')
  // 候选 ID 先去掉冗余的 candidate- 前缀再截尾：直接 slice(-6) 会把 "candidate-1"
  // 切成 "date-1"，看起来像个日期。
  const candidateLabel = (candidateId: string): string => {
    const bare = candidateId.replace(/^candidate-/, '')
    return bare.length > 8 ? `…${bare.slice(-8)}` : bare
  }
  // 核验方法目前只有人工与自动两种；已知取值翻译，未知值原样显示，不丢信息。
  const methodLabel = (method: string): string =>
    method === 'manual' ? t('人工核验') : method === 'automated' ? t('自动核验') : method
  // 新的返工版本在最前；createdAt 相同就保持后端顺序。
  const ordered = [...candidates].sort((a, b) =>
    a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1)
  // 验收标准版本与逐条标准一律读计划快照：候选快照只照抄，不在这里另立规则。
  const criteria = plan?.acceptanceCriteria.criteria ?? []
  const criteriaVersion = plan?.acceptanceCriteria.version ?? ''

  const closeDraft = (): void => { setDraft(null); setPending(''); setFailure(null) }

  const openDraft = (candidate: LoomCandidate, verdict: 'accepted' | 'rejected'): void => {
    setFailure(null)
    setPending('')
    setDraft({ candidateId: candidate.candidateId, verdict, reason: '', satisfied: [] })
  }

  const toggleCriterion = (criterionId: string): void => setDraft(current => current === null ? current : {
    ...current,
    satisfied: current.satisfied.includes(criterionId)
      ? current.satisfied.filter(id => id !== criterionId)
      : [...current.satisfied, criterionId]
  })

  // 接受必须逐条全勾；驳回只要求写明理由。reviewerId 由 Core 从可信身份注入，客户端不发。
  const canSubmit = draft !== null && draft.reason.trim() !== ''
    && (draft.verdict === 'rejected' || criteria.every(criterion => draft.satisfied.includes(criterion.criterionId)))

  const recordReview = async (candidate: LoomCandidate): Promise<void> => {
    if (draft === null || draft.candidateId !== candidate.candidateId || !canSubmit || pending !== '') return
    setPending(`${candidate.candidateId}:${draft.verdict}`)
    setFailure(null)
    try {
      await client.request<unknown>('loom.review.record', {
        missionId,
        taskId: candidate.taskId,
        candidateId: candidate.candidateId,
        commandId: crypto.randomUUID(),
        acceptanceCriteriaVersion: criteriaVersion,
        verdict: draft.verdict,
        reason: draft.reason.trim(),
        criteriaResults: criteria.map(criterion => ({
          criterionId: criterion.criterionId,
          satisfied: draft.satisfied.includes(criterion.criterionId),
          evidenceIds: [],
          note: null
        }))
      })
      closeDraft()
      onRefresh()
    } catch (e) {
      setFailure({ candidateId: candidate.candidateId, message: e instanceof Error ? e.message : '验收写入失败' })
      setPending('')
    }
  }

  // executorId 同样由 Core 注入；客户端只报方法（人工核验）与结论。
  const recordVerification = async (candidate: LoomCandidate, result: 'passed' | 'failed'): Promise<void> => {
    if (pending !== '') return
    setPending(`${candidate.candidateId}:${result}`)
    setFailure(null)
    try {
      await client.request<unknown>('loom.verification.record', {
        missionId,
        taskId: candidate.taskId,
        candidateId: candidate.candidateId,
        commandId: crypto.randomUUID(),
        method: 'manual',
        result
      })
      setPending('')
      onRefresh()
    } catch (e) {
      setFailure({ candidateId: candidate.candidateId, message: e instanceof Error ? e.message : '核验写入失败' })
      setPending('')
    }
  }

  return <div className="loom-delivery-context">
    <header className="loom-section-heading">
      <div><span className="loom-eyebrow">LOOM · {t('交付')}</span><h2>{t('成果与验收')}</h2></div>
    </header>
    {ordered.length === 0
      ? <LoomEmpty title={t('尚无交付')}>
          <p>{t('任务提交候选成果后，这里会出现待验收的产物。')}</p>
        </LoomEmpty>
      : ordered.map(candidate => {
        const review = reviews.find(entry => entry.candidateId === candidate.candidateId)
        const verification = verifications.find(entry => entry.candidateId === candidate.candidateId)
        // 一个候选只有一份评审、一份核验：已有记录就不再给同类写入口。
        const reviewable = review === undefined
        const verifiable = candidate.verificationStatus === 'unverified'
        const open = draft?.candidateId === candidate.candidateId ? draft : null
        return <div key={candidate.candidateId} className="loom-candidate">
          <div className="loom-candidate-header">
            <span className="loom-candidate-title">{t('候选')} {candidateLabel(candidate.candidateId)}</span>
            <span className="loom-badge loom-badge-verification" data-state={candidate.verificationStatus}>
              {verificationLabel(candidate.verificationStatus)}
            </span>
            <span className="loom-badge loom-badge-acceptance" data-state={candidate.acceptanceStatus}>
              {acceptanceLabel(candidate.acceptanceStatus)}
            </span>
          </div>
          <div className="loom-candidate-meta">{candidate.contentHash} · {t('证据')} {candidate.evidenceIds.length} {t('条')}</div>
          {review !== undefined && <div className="loom-candidate-review">
            <div>{t('验收结论')}：{review.verdict === 'accepted' ? t('通过') : t('驳回')} · {review.reason}</div>
            {review.criteriaResults.map(result => <div key={result.criterionId}>
              {result.criterionId} · {result.satisfied ? t('满足') : t('未满足')}
            </div>)}
          </div>}
          {verification !== undefined && <div className="loom-candidate-verification">
            <div>{t('核验结论')}：{verification.result === 'passed' ? t('通过') : t('失败')} · {methodLabel(verification.method)}</div>
          </div>}
          {(reviewable || verifiable) && <div className="loom-delivery-actions">
            {reviewable && <button
              type="button" className="loom-btn-accept" disabled={pending !== ''}
              onClick={() => openDraft(candidate, 'accepted')}>{t('接受')}</button>}
            {reviewable && <button
              type="button" className="loom-btn-reject" disabled={pending !== ''}
              onClick={() => openDraft(candidate, 'rejected')}>{t('驳回')}</button>}
            {verifiable && <button
              type="button" className="loom-btn-verify" disabled={pending !== ''}
              onClick={() => void recordVerification(candidate, 'passed')}>{t('通过核验')}</button>}
            {verifiable && <button
              type="button" className="loom-btn-verify" data-result="failed" disabled={pending !== ''}
              onClick={() => void recordVerification(candidate, 'failed')}>{t('核验失败')}</button>}
          </div>}
          {failure !== null && failure.candidateId === candidate.candidateId
            && <p className="loom-review-failure">{failure.message}</p>}
          {open !== null && <form className="loom-review-form" onSubmit={event => {
            event.preventDefault()
            void recordReview(candidate)
          }}>
            <div className="loom-review-criteria">
              {criteria.map(criterion => <label key={criterion.criterionId} className="loom-review-criterion">
                <input
                  type="checkbox" checked={open.satisfied.includes(criterion.criterionId)}
                  onChange={() => toggleCriterion(criterion.criterionId)}/>
                <span className="loom-review-criterion-id">{criterion.criterionId}</span>
                <span className="loom-review-criterion-text">{criterion.text}</span>
              </label>)}
            </div>
            <textarea
              className="loom-review-reason" rows={3} value={open.reason}
              aria-label={t('验收理由')} placeholder={t('验收理由（必填）')}
              onChange={event => {
                const reason = event.target.value
                setDraft(current => current === null ? current : { ...current, reason })
              }}/>
            <div className="loom-delivery-actions">
              <button
                type="submit" className={open.verdict === 'accepted' ? 'loom-btn-accept' : 'loom-btn-reject'}
                disabled={!canSubmit || pending !== ''}>
                {open.verdict === 'accepted' ? t('确认接受') : t('确认驳回')}
              </button>
              <button type="button" className="loom-btn-cancel" disabled={pending !== ''} onClick={closeDraft}>
                {t('取消')}
              </button>
            </div>
          </form>}
        </div>
      })}
  </div>
}

export function LoomWorkspace({ mission, agents, onSource, onNotify, onWorkspaceCleanupRequested }: {
  mission: MissionRecord; agents: AgentProfile[]; onSource(id: string): void
  onNotify(message: string): void; onWorkspaceCleanupRequested(threadId: string): Promise<void>
}) {
  const [section, setSection] = useState<LoomSection>('activity')
  const [visited, setVisited] = useState<ReadonlySet<LoomSection>>(() => new Set(['activity']))
  const shared = useRef<HTMLDivElement>(null)
  const scrollPositions = useRef<Partial<Record<LoomSection, { top: number; left: number }>>>({})
  
  const client = useThreadClient()
  const [plan, setPlan] = useState<LoomPlan | null>(null)
  const [tasks, setTasks] = useState<LoomTask[]>([])
  const [dependencies, setDependencies] = useState<LoomDependency[]>([])
  const [candidates, setCandidates] = useState<LoomCandidate[]>([])
  const [reviews, setReviews] = useState<LoomReview[]>([])
  const [verifications, setVerifications] = useState<LoomVerification[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 写入口（验收 / 核验）成功后重新读一遍六个投影：状态只认控制面回读，不在本地猜。
  const reload = useCallback((): void => {
    void Promise.all([
      client.request<LoomPlan | null>('loom.plan.get', { missionId: mission.missionId }),
      client.request<LoomTask[]>('loom.tasks.list', { missionId: mission.missionId }),
      client.request<LoomDependency[]>('loom.dependencies.list', { missionId: mission.missionId }),
      client.request<LoomCandidate[]>('loom.candidates.list', { missionId: mission.missionId }),
      client.request<LoomReview[]>('loom.reviews.list', { missionId: mission.missionId }),
      client.request<LoomVerification[]>('loom.verifications.list', { missionId: mission.missionId })
    ]).then(([p, t, d, c, r, v]) => {
      setPlan(p); setTasks(t); setDependencies(d); setCandidates(c); setReviews(r); setVerifications(v); setError('')
    }).catch(e => setError(e.message ?? '刷新失败'))
  }, [client, mission.missionId])
  
  useLayoutEffect(() => {
    if (section === 'plan') return
    const saved = scrollPositions.current[section]
    const node = shared.current
    if (node && saved) { node.scrollTop = saved.top; node.scrollLeft = saved.left }
  }, [section])
  
  useLayoutEffect(() => {
    let alive = true
    setLoading(true)
    void Promise.all([
      client.request<LoomPlan | null>('loom.plan.get', { missionId: mission.missionId }),
      client.request<LoomTask[]>('loom.tasks.list', { missionId: mission.missionId }),
      client.request<LoomDependency[]>('loom.dependencies.list', { missionId: mission.missionId }),
      client.request<LoomCandidate[]>('loom.candidates.list', { missionId: mission.missionId }),
      client.request<LoomReview[]>('loom.reviews.list', { missionId: mission.missionId }),
      client.request<LoomVerification[]>('loom.verifications.list', { missionId: mission.missionId })
    ]).then(([p, t, d, c, r, v]) => {
      if (alive) { setPlan(p); setTasks(t); setDependencies(d); setCandidates(c); setReviews(r); setVerifications(v); setError('') }
    }).catch(e => {
      if (alive) setError(e.message ?? '读取编排数据失败')
    }).finally(() => {
      if (alive) setLoading(false)
    })
    return () => { alive = false }
  }, [client, mission.missionId])
  
  const select = (next: LoomSection): void => {
    const node = shared.current
    if (node && section !== 'plan') scrollPositions.current[section] = { top: node.scrollTop, left: node.scrollLeft }
    setSection(next)
    setVisited(current => current.has(next) ? current : new Set(current).add(next))
  }
  return <div className="loom-workspace">
    <nav className="loom-section-tabs" aria-label={uiAttribute('使命工作区')}>
      {(['activity', 'plan', 'delivery'] as const).map(id => <button key={id} type="button" aria-pressed={section === id} onClick={() => select(id)}>
        {id === 'plan' && <Icon name="branch"/>}{id === 'delivery' && <Icon name="check"/>}
        <UiText zh={id === 'activity' ? '活动' : id === 'plan' ? '编排' : '交付'}/>
      </button>)}
    </nav>
    <div className="loom-section-body">
      {visited.has('plan') && <div hidden={section !== 'plan'}><PlanWorkspace mission={mission} agents={agents} plan={plan} tasks={tasks} dependencies={dependencies} candidates={candidates} reviews={reviews} loading={loading} error={error}/></div>}
      <div ref={shared} className={section === 'delivery' ? 'loom-delivery' : 'mission-activity-document'} hidden={section === 'plan'}>
        {visited.has('delivery') && <div hidden={section !== 'delivery'}><DeliveryReview candidates={candidates} reviews={reviews} verifications={verifications} plan={plan} missionId={mission.missionId} onRefresh={reload}/></div>}
        <MissionDeliveryPanel mission={mission} agents={agents} onSource={onSource} onNotify={onNotify} onWorkspaceCleanupRequested={onWorkspaceCleanupRequested}/>
        <div hidden={section !== 'activity'}><MissionActivityPanel mission={mission} agents={agents} onSource={onSource}/></div>
      </div>
    </div>
  </div>
}

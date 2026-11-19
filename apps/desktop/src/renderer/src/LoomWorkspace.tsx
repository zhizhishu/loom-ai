import { createPortal } from 'react-dom'
import { useOptionalFilePreview } from './FilePreviewContext'
import { useOptionalFilePreviewLayout } from './FilePreviewLayout'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentProfile, ExecutionNodeRecord, MissionRecord, LoomPlan, LoomTask, LoomDependency, LoomTaskStatus, LoomCandidate, LoomReview, LoomVerification, LoomClaim, LoomClaimsListResult, LoomArtifact, LoomArtifactsListResult } from '@contracts'
import { loomTaskReady } from '@contracts'
import { LoomControl } from './LoomControl'
import {
  loomCandidateAcceptable,
  loomCandidateVersions,
  loomDependencyReasonLabel,
  loomUnreleasedInbound,
  loomVersionLabel,
  type LoomControlSnapshot
} from './loom-control-model'
import { Icon } from './MissionControls'
import { MissionDeliveryPanel, MissionActivityPanel } from './MissionDelivery'
import { LoomDelivery } from './LoomDelivery'
import { MemberAvatar } from './MemberAvatar'
import { UiText, uiAttribute, useUiText, getInterfaceLanguage } from './interface-language'
import { useThreadClient } from './camp-client'
import { LoomLiveProcess, LoomLiveRow, LoomLiveStrip } from './LoomLive'
import { livePhaseText, livePlacements } from './loom-live-model'
import type { NodeApi } from './nodes-api'

/** 内部值保持稳定（滚动位、测试与持久化都按它记）；界面上的名字见 TABS。 */
export type LoomSection = 'activity' | 'plan' | 'delivery' | 'computer'

/** 工作／流程／资产／电脑：右栏四块，工作在最前。 */
const LOOM_TABS: ReadonlyArray<{ id: LoomSection; label: string }> = [
  { id: 'activity', label: '工作' },
  { id: 'plan', label: '流程' },
  { id: 'delivery', label: '资产' },
  { id: 'computer', label: '电脑' }
]

/** 控制投影的读结果：null 快照 + 非空 error 才是「读不到」，与「读到了但没批准」分开。 */
type LoomControlRead = { snapshot: LoomControlSnapshot | null; error: string }

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

/** 认领展示态：只有这四种落在 data-claim-state 上；读不到认领时不算任何一种（不许冒充未认领）。 */
type FlowClaimState = 'held' | 'expired' | 'released' | 'none'

/** 一个任务可能有多代认领：取 fence 代次最大的那条当当前认领，同代次保留先出现的。 */
function flowClaim(claims: LoomClaim[], taskId: string): LoomClaim | null {
  let latest: LoomClaim | null = null
  for (const claim of claims) {
    if (claim.taskId !== taskId) continue
    if (latest === null || claim.fenceGeneration > latest.fenceGeneration) latest = claim
  }
  return latest
}

/** 已释放优先于过期：释放是结论，过期只是没续上。
 *  expired 由 Host 用服务端时钟判定，这里不拿本地时间重算。 */
function flowClaimState(claim: LoomClaim | null): FlowClaimState {
  if (claim === null) return 'none'
  if (claim.releasedAt !== null) return 'released'
  return claim.expired ? 'expired' : 'held'
}

/** Run 身份只用来定位：短值原样显示，长值取尾部 8 位（UUID 前缀几乎不含信息）。 */
function flowRunShortId(agentRunId: string): string {
  return agentRunId.length <= 12 ? agentRunId : `…${agentRunId.slice(-8)}`
}

/** 本地化日期时间；解析不出来就回退原始字符串，不显示 Invalid Date。 */
function flowDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(getInterfaceLanguage() === 'en' ? 'en-US' : 'zh-CN', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(date)
}

/** 节点认领区：谁占着、租约何时到期、fence 第几代。
 *  claims 为 null = 认领投影没读到，只显示「认领状态未知」，不影响节点其他内容。 */
function FlowClaimBadge({ claims, taskId, agents }: { claims: LoomClaim[] | null; taskId: string; agents: AgentProfile[] }) {
  const t = useUiText()
  if (claims === null) {
    return <div className="loom-flow-claim">
      <span className="loom-flow-claim-status">{t('认领状态未知')}</span>
    </div>
  }
  const claim = flowClaim(claims, taskId)
  const state = flowClaimState(claim)
  const stateLabel = state === 'held' ? t('已认领')
    : state === 'expired' ? t('租约已过期')
      : state === 'released' ? t('已释放') : t('未认领')
  if (claim === null) {
    return <div className="loom-flow-claim" data-claim-state={state}>
      <span className="loom-flow-claim-status">{stateLabel}</span>
    </div>
  }
  // 认领者三级回退：已知 Agent 显示其显示名 → 未知 Agent 回退原 ID → 都没绑定才回退 agentRunId，不编造用户名。
  const claimantAgentId = (claim.claimantAgentId ?? '').trim()
  const claimant = claimantAgentId === '' ? undefined : agents.find(agent => agent.agentId === claimantAgentId)
  const owner = claimant !== undefined ? claimant.displayName
    : claimantAgentId !== '' ? claimantAgentId : claim.agentRunId
  return <div className="loom-flow-claim" data-claim-state={state}>
    <span className="loom-flow-claim-status">{stateLabel}</span>
    <span className="loom-flow-claim-owner">{t('认领者：{0} · {1}', owner, flowRunShortId(claim.agentRunId))}</span>
    <time className="loom-flow-claim-lease" dateTime={claim.leaseExpiresAt}>{t('到期：{0}', flowDateTime(claim.leaseExpiresAt))}</time>
    <span className="loom-flow-claim-fence">{t('fence 第{0}代', claim.fenceGeneration)}</span>
  </div>
}

/** 依赖图渲染：archify 流程视图。就绪判定走控制层契约，不在 UI 里另立规则。 */
function LoomFlow({ tasks, dependencies, candidates, reviews, agents, claims, placements, now, openRunId, onOpen }: {
  tasks: LoomTask[]
  dependencies: LoomDependency[]
  candidates: LoomCandidate[]
  reviews: LoomReview[]
  agents: AgentProfile[]
  claims: LoomClaim[] | null
  placements: ReturnType<typeof livePlacements>
  now: number
  openRunId: string | null
  onOpen(taskId: string): void
}) {
  const t = useUiText()
  // 界面文案：契约里的枚举值是英文标识，不直接展示给用户。
  const statusLabels: Record<LoomTaskStatus, string> = {
    draft: '草稿', ready: '就绪', blocked: '阻塞', in_review: '评审中', done: '已完成', canceled: '已取消'
  }
  // 候选与人工验收记录一律喂真实读取结果：artifact_accepted 边只认 verified + accepted + 同版本 Review，
  // 不会被"上游 done"误判为已验收。evaluatedAt 固定为纪元，求值是纯规则，不给渲染引入会漂移的输入。
  const graph = { tasks, dependencies, candidates, reviews, evaluatedAt: new Date(0).toISOString() }
  // 「依赖就绪」= 依赖已放行 且 任务本身处于 ready；只说明没人拦着，不代表没人占着（占用与否看节点认领区）。
  // done/canceled/draft 不算依赖就绪。
  const claimable = (task: LoomTask): boolean =>
    (task.status === 'ready' || task.status === 'in_review') && loomTaskReady(task.taskId, graph).ready
  const readyTasks = tasks.filter(claimable)
  const blockedTasks = tasks.filter(task => task.status === 'blocked')
  // 返工版本标签：同一任务的候选链有几版就标几版，不把返工画成 DAG 环。
  const versions = loomCandidateVersions(candidates)
  const latestVersionOf = (taskId: string): number => versions
    .reduce((max, entry) => entry.taskId === taskId && entry.version > max ? entry.version : max, 0)
  const taskTitleOf = (taskId: string): string => tasks.find(entry => entry.taskId === taskId)?.title ?? taskId
  // 当前 review 提示：只有链头候选且待验收才算「等你决定」，历史版本不算。
  const pendingReview = (taskId: string): boolean => candidates.some(candidate =>
    candidate.taskId === taskId
    && candidate.acceptanceStatus === 'pending'
    && loomCandidateAcceptable(versions, candidate.candidateId))
  
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
        <span>{t('依赖就绪')}: {readyTasks.length}</span>
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
            {/* 主图只留四件事：标题、成员头像、当前工作状态、卡点。租约/fence/依赖原文进详情。 */}
            <div className="loom-flow-node-header">
              <span className="loom-flow-node-dot" data-status={task.status} data-live={placements.find(entry => entry.taskId === task.taskId)?.phase ?? ''}/>
              {assignee !== undefined && <MemberAvatar
                agentId={assignee.agentId} avatarRef={assignee.avatarRef ?? null}
                displayName={assignee.displayName} size="execution" decorative/>}
              <span className="loom-flow-node-title">{task.title}</span>
            </div>
            <div className="loom-flow-node-meta">
              <span className="loom-flow-node-status">{(() => {
                const placement = placements.find(entry => entry.taskId === task.taskId)
                if (placement?.runId && placement.phase !== 'queued' && placement.phase !== 'done') return t(livePhaseText(placement.phase))
                return statusLabels[task.status]
              })()}</span>
              {assignee !== undefined
                && <span className="loom-flow-node-assignee">{assignee.displayName}</span>}
              {pendingReview(task.taskId)
                && <span className="loom-summary-tag" data-review="pending">{t('待验收')}</span>}
              {(() => {
                const pinned = placements.find(entry => entry.taskId === task.taskId)?.pinnedName
                return pinned ? <span className="loom-flow-node-pin">{t('钉在 {0}', pinned)}</span> : null
              })()}
            </div>
            {task.blockedReason && (
              <div className="loom-flow-node-blocked">{task.blockedReason}</div>
            )}
            <details className="loom-summary-details" data-details="flow-node">
              <summary>{t('详情')}</summary>
              {upstreams.length > 0 && (
                <div className="loom-flow-node-deps">
                  {t('依赖')}: {upstreams.map(d => {
                    const upstream = tasks.find(entry => entry.taskId === d.upstreamTaskId)
                    return upstream?.title ?? d.upstreamTaskId
                  }).join(', ')}
                </div>
              )}
              {latestVersionOf(task.taskId) > 1
                && <div className="loom-flow-node-rework">{t('返工 {0}', loomVersionLabel(latestVersionOf(task.taskId)))}</div>}
              {/* 未释放入边的真实原因：直接读控制层求值，不另存一份阻塞表。 */}
              {loomUnreleasedInbound(loomTaskReady(task.taskId, graph).blockedBy).map(entry => (
                <div key={entry.dependencyId} className="loom-flow-node-blocked-by">
                  {t('{0}：{1}', taskTitleOf(entry.upstreamTaskId), loomDependencyReasonLabel(entry.reason))}
                </div>
              ))}
              <FlowClaimBadge claims={claims} taskId={task.taskId} agents={agents}/>
              {(() => {
                const placement = placements.find(entry => entry.taskId === task.taskId)
                if (!placement) return null
                return <LoomLiveRow
                  placement={placement}
                  now={now}
                  open={placement.runId !== null && placement.runId === openRunId}
                  onOpen={() => onOpen(task.taskId)}
                />
              })()}
            </details>
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

function PlanWorkspace({ mission, agents, plan, tasks, dependencies, candidates, reviews, claims, loading, error, nodeRecords, nodeError, nodes, control, controlError, onReload }: {
  mission: MissionRecord
  agents: AgentProfile[]
  plan: LoomPlan | null
  tasks: LoomTask[]
  dependencies: LoomDependency[]
  candidates: LoomCandidate[]
  reviews: LoomReview[]
  claims: LoomClaim[] | null
  loading?: boolean
  error?: string
  nodeRecords: ExecutionNodeRecord[] | null
  nodeError: boolean
  nodes: NodeApi | null
  control: LoomControlSnapshot | null
  controlError: string
  onReload(): void
}) {
  const t = useUiText()
  const [now, setNow] = useState(() => Date.now())
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const placements = livePlacements(tasks, claims, nodeError ? null : nodeRecords)
  const openPlacement = placements.find(entry => entry.taskId === openTaskId && entry.runId) ?? null
  
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
      <div><span className="loom-eyebrow">LOOM · {t('编排')}</span><h2>{t('工作关系')}</h2></div>
      <span className="loom-number">M-{String(mission.number).padStart(3, '0')}</span>
    </header>
    {/* 目标常常很长：收进折叠，图放在最前面。 */}
    <details className="loom-summary-details" data-details="plan-goal">
      <summary>{t('计划目标')}</summary>
      <p className="loom-intro">{plan.goal}</p>
    </details>
    {nodeError && <p className="loom-live-note" role="status">{t('节点列表没有读到。编排仍在。')}</p>}
    <LoomFlow
      tasks={tasks}
      dependencies={dependencies}
      candidates={candidates}
      reviews={reviews}
      agents={agents}
      claims={claims}
      placements={placements}
      now={now}
      openRunId={openPlacement?.runId ?? null}
      onOpen={taskId => setOpenTaskId(current => current === taskId ? null : taskId)}
    />
    <LoomLiveStrip placements={placements} now={now} />
    {/* 接力/暂停这类控制策略在图之后：先看关系，再改策略。 */}
    <LoomControl missionId={mission.missionId} tasks={tasks} agents={agents} snapshot={control} readError={controlError} onReload={onReload}/>
    {openPlacement && nodes && <LoomLiveProcess placement={openPlacement} api={nodes} onClose={() => setOpenTaskId(null)} />}
  </div>
}

/**
 * 进展：任务优先。一句总状态 + 待你处理 + 真实任务行（头像/负责人/状态），
 * 不做装饰性大数字、不写长导语；跳转按钮直接切 tab，不在这里做接受。
 */
/** 「电脑」：任务在哪台机器上跑。读不到节点就说读不到，不编造屏幕。 */
function LoomComputer({ nodeRecords, nodeError, lead }: {
  nodeRecords: ExecutionNodeRecord[] | null
  nodeError: boolean
  /** 使命默认队长：只显示真实成员档案；读不到或没配就是没有，不摆占位假人。 */
  lead: AgentProfile | null
}): React.JSX.Element {
  const t = useUiText()
  const nodes = nodeError ? null : nodeRecords
  return <div className="loom-computer">
    {lead !== null && <header className="loom-computer-profile">
      <MemberAvatar agentId={lead.agentId} avatarRef={lead.avatarRef ?? null} displayName={lead.displayName} size="profile" decorative/>
      <span className="loom-computer-name">{lead.displayName}</span>
      <span className="loom-computer-role">{t('使命队长')}</span>
    </header>}
    {/* 照 PiBot BotScreenPanel 的舞台构图，但没有屏幕流就明说，不摆假画面。 */}
    <div className="loom-screen">
      <div className="loom-screen-bar"><span>{t('远程屏幕')}</span></div>
      <div className="loom-screen-stage"><span>{t('未连接屏幕服务')}</span></div>
    </div>
    <p className="loom-board-note">{t('接管控制需要宿主提供屏幕流；当前未接入，这里只列执行节点与运行位置。')}</p>
    <h3 className="loom-board-heading">{t('执行节点')}</h3>
    {nodes === null && <p className="loom-board-empty">{t('读取执行节点失败')}</p>}
    {nodes !== null && nodes.length === 0 && <p className="loom-board-empty">{t('尚未连接执行节点')}</p>}
    {nodes?.map(node => <div key={node.nodeId} className="loom-node" data-online={node.status === 'online' || undefined}>
      <span className="loom-node-main">
        <span className="loom-node-name">{node.displayName}</span>
        <span className="loom-node-meta">{[node.os, node.arch].filter(Boolean).join(' · ') || node.role}</span>
      </span>
      <span className="loom-node-state">
        {node.status === 'online' ? t('在线') : node.status === 'revoked' ? t('已撤销') : t('离线')}
      </span>
    </div>)}
    <p className="loom-board-note">{t('工具在该节点所在机器上执行，工作区与凭据留在那台机器。')}</p>
  </div>
}

/** 六档归位：一项工作只出现一次。判据见 docs/loom-ui-redesign-brief.md，不新增字段。 */
const LOOM_BUCKETS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'wait', label: '待你处理' },
  { id: 'running', label: '进行中' },
  { id: 'delivered', label: '已交付' },
  { id: 'blocked', label: '受阻' },
  { id: 'idle', label: '空闲' },
  { id: 'unknown', label: '状态未确认' }
]

/** 送审不等于你的待办；done 不等于已交付；ready 有认领才算在跑。 */
function loomBucket(status: string, needsYou: boolean, isRunning: boolean, hasArtifact: boolean): string {
  if (needsYou) return 'wait'
  if (status === 'blocked') return 'blocked'
  if (status === 'done') return hasArtifact ? 'delivered' : 'unknown'
  if (status === 'in_review') return hasArtifact ? 'delivered' : 'running'
  if (status === 'ready') return isRunning ? 'running' : 'idle'
  if (status === 'draft' || status === 'canceled') return 'idle'
  return 'unknown'
}

function LoomProgress({ mission, agents, tasks, candidates, loading, error, onRetry, onOpenPlan }: {
  mission: MissionRecord
  agents: AgentProfile[]
  tasks: LoomTask[]
  candidates: LoomCandidate[]
  /** 当前 scope 还没读到数据：只给读取态，不显示 0 任务/无待办这种假信息 */
  loading: boolean
  error: string
  onRetry(): void
  onOpenPlan(): void
}) {
  const t = useUiText()
  // 枚举值是英文标识，不直接展示给用户。
  const statusText: Record<LoomTaskStatus, string> = {
    draft: t('草稿'), ready: t('就绪'), blocked: t('阻塞'), in_review: t('评审中'), done: t('已完成'), canceled: t('已取消')
  }
  // 待你处理只认「链头 + 待验收」的真实候选，历史版本不算。
  const versions = useMemo(() => loomCandidateVersions(candidates), [candidates])
  const pending = useMemo(() => candidates.filter(candidate => candidate.acceptanceStatus === 'pending'
    && loomCandidateAcceptable(versions, candidate.candidateId)), [candidates, versions])
  const pendingTasks = useMemo(() => new Set(pending.map(candidate => candidate.taskId)), [pending])
  const titleOf = (taskId: string): string => {
    const title = tasks.find(task => task.taskId === taskId)?.title ?? ''
    return title.trim() === '' ? t('未命名任务') : title
  }
  const versionOf = (candidateId: string): number | undefined =>
    versions.find(entry => entry.candidateId === candidateId)?.version
  // 待你处理最前，然后按执行先后；同档保持后端顺序（sort 是稳定的）。
  const rank = (task: LoomTask): number => pendingTasks.has(task.taskId) ? 0
    : task.status === 'in_review' ? 1
      : task.status === 'blocked' ? 2
        : task.status === 'ready' ? 3
          : task.status === 'draft' ? 4 : task.status === 'done' ? 5 : 6
  const orderedTasks = [...tasks].sort((left, right) => rank(left) - rank(right))
  // 照 BotBoard：搜索 + 状态筛选（_references/pibot/web/src/BotBoard.tsx:116-123）
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const bucketOf = (task: LoomTask): string => loomBucket(
    String(task.status),
    pendingTasks.has(task.taskId),
    mission.runningAgentIds.includes(task.assigneeAgentId ?? ''),
    candidates.some(candidate => candidate.taskId === task.taskId)
  )
  const visibleTasks = orderedTasks.filter(task => {
    if (filter !== 'all' && bucketOf(task) !== filter) return false
    const needle = query.trim().toLowerCase()
    return needle === '' || task.title.toLowerCase().includes(needle)
  })
  if (loading) {
    return <div className="loom-overview">
      <LoomEmpty title={t('正在读取进展…')}><p>{t('从控制面读取任务、成果与验收状态。')}</p></LoomEmpty>
    </div>
  }
  // 一句总状态：只有真有待确认的成果才说成果，否则说任务本身的真实状态。
  const summary = pending.length > 0
    ? t('有 {0} 份成果等你确认', pending.length)
    : error !== '' && tasks.length === 0
      ? t('还没读到任务')
      : mission.runningAgentIds.length > 0
      ? t('任务进行中')
      : tasks.length === 0 ? t('等待计划') : t('暂无进行中的任务')
  // 折叠只收紧真正空闲的一档：unknown、待你处理、进行中、受阻与已交付都留在明面上。
  // 「已交付」里还可能是等着接受的在审版本，收进折叠就等于谎称已解决。
  const stillOpenBuckets = LOOM_BUCKETS.filter(bucket => bucket.id !== 'idle')
  const settledBuckets = LOOM_BUCKETS.filter(bucket => bucket.id === 'idle')
  const countOf = (bucketId: string): number => bucketId === 'all'
    ? orderedTasks.length
    : orderedTasks.filter(task => bucketOf(task) === bucketId).length
  const bucketGroup = (bucket: { id: string; label: string }): ReactNode => {
    const rows = visibleTasks.filter(task => bucketOf(task) === bucket.id)
    if (rows.length === 0) return null
    return <section key={bucket.id} className="loom-summary-group" data-bucket={bucket.id} aria-label={uiAttribute(bucket.label)}>
      <span className="loom-summary-label">{t(bucket.label)} <span className="loom-summary-count">({rows.length})</span></span>
      <ul className="loom-summary-tasks">
        {rows.map(task => {
          const member = agents.find(agent => agent.agentId === task.assigneeAgentId)
          return <li key={task.taskId} className="loom-summary-task" data-status={task.status}>
            <button type="button" className="loom-summary-row" onClick={onOpenPlan}>
              <span className="loom-summary-state" data-status={task.status} aria-hidden="true"/>
              <span className="loom-summary-text">
                <span className="loom-summary-title">{task.title.trim() === '' ? t('未命名任务') : task.title}</span>
                <span className="loom-summary-sub">
                  {member !== undefined
                    ? <>
                        <MemberAvatar
                          agentId={member.agentId} avatarRef={member.avatarRef ?? null}
                          displayName={member.displayName} size="execution" decorative/>
                        <span>{member.displayName}</span>
                      </>
                    : <span>{t('未指派')}</span>}
                  <span className="loom-summary-status" data-status={task.status}>{statusText[task.status]}</span>
                </span>
              </span>
              <span className="loom-summary-chev" aria-hidden="true">›</span>
            </button>
          </li>
        })}
      </ul>
    </section>
  }
  const settledRows = visibleTasks.filter(task => bucketOf(task) === 'idle').length
  return <div className="loom-overview">
    <header className="loom-section-heading">
      <div><h2>{t('全部工作')}</h2></div>
      <div className="loom-work-controls">
          <label className="loom-board-search">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
            <input value={query} onChange={event => setQuery(event.target.value)}
              placeholder={t('搜索任务')} aria-label={t('搜索任务')}/>
          </label>
          <label className="loom-work-filter">
            <select value={filter} onChange={event => setFilter(event.target.value)} aria-label={uiAttribute('状态筛选')}>
              <option value="all">{t('全部')} {orderedTasks.length}</option>
              {LOOM_BUCKETS.map(bucket => <option key={bucket.id} value={bucket.id}>{t(bucket.label)} {countOf(bucket.id)}</option>)}
            </select>
          </label>

        </div>
    </header>
    {error !== '' && <p className="loom-live-note" role="status">
      {t('刷新失败：{0}', error)}
      <button type="button" className="loom-summary-secondary" onClick={onRetry}>{t('重试')}</button>
    </p>}
    <p className="loom-summary-line sr-only">
      {summary}
      {' · '}{t('{0} 个任务', tasks.length)}
      {' · '}{t('{0} 人在执行', mission.runningAgentIds.length)}
    </p>
    {orderedTasks.length === 0
      ? <p className="loom-summary-line">{t('还没有任务。主助手建立计划后，这里会列出任务与负责人。')}</p>
      : <>
        {visibleTasks.length === 0 && <p className="loom-summary-line">{t('没有符合筛选条件的任务。')}</p>}
        {stillOpenBuckets.map(bucketGroup)}
        {settledRows > 0 && <details className="loom-summary-details" data-bucket-group="idle">
          <summary>{t('空闲')} · {settledRows}</summary>
          {settledBuckets.map(bucketGroup)}
        </details>}
      </>}
  </div>
}

export function LoomWorkspace({ mission, agents, onSource, onNotify, onWorkspaceCleanupRequested, nodes = null }: {
  mission: MissionRecord; agents: AgentProfile[]; onSource(id: string): void
  onNotify(message: string): void; onWorkspaceCleanupRequested(threadId: string): Promise<void>
  nodes?: NodeApi | null
}) {
  // 内部值仍是 activity（契约与滚动位不变），用户看到的名字是「进展」。
  const [section, setSection] = useState<LoomSection>('activity')
  const [visited, setVisited] = useState<ReadonlySet<LoomSection>>(() => new Set(['activity']))
  const shared = useRef<HTMLDivElement>(null)
  const scrollPositions = useRef<Partial<Record<LoomSection, { top: number; left: number }>>>({})
  const t = useUiText()

  const client = useThreadClient()
  const [plan, setPlan] = useState<LoomPlan | null>(null)
  const [tasks, setTasks] = useState<LoomTask[]>([])
  const [dependencies, setDependencies] = useState<LoomDependency[]>([])
  const [candidates, setCandidates] = useState<LoomCandidate[]>([])
  const [reviews, setReviews] = useState<LoomReview[]>([])
  const [verifications, setVerifications] = useState<LoomVerification[]>([])
  // 认领投影：null = 读不到（不是「没有认领」）。数组为空才算真的没人认领。
  const [claims, setClaims] = useState<LoomClaim[] | null>(null)
  // 产物投影：语义同 claims——null = 读不到（不是「没有产物」）。数组为空才算真的没有登记过。
  const [artifacts, setArtifacts] = useState<LoomArtifact[] | null>(null)
  // 控制策略投影：读失败保留 null + 错误文案，从不当成 enabled=false 的假成功。
  const [control, setControl] = useState<LoomControlSnapshot | null>(null)
  const [controlError, setControlError] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [nodeRecords, setNodeRecords] = useState<ExecutionNodeRecord[] | null>(null)
  const [nodeError, setNodeError] = useState(false)

  // 只有一条 load：代次隔离，重复触发（切 tab / 事件 / 重新可见）时只让最后一份落地。
  // 代次跟着 mission scope 走：换使命立刻退役旧代次，旧响应不能换使命覆盖。
  const generation = useRef(0)
  // 已落地的数据属于哪个 mission；不等于当前 mission 就还在读新 scope。
  const loadedMission = useRef<string | null>(null)
  const renderScope = useRef<string | null>(null)
  // 渲染期同步检测换使命：只递增代次与标记 scope，不在这里 setState。
  if (renderScope.current !== mission.missionId) {
    renderScope.current = mission.missionId
    generation.current += 1
    loadedMission.current = null
  }
  const load = useCallback((): void => {
    const ticket = generation.current + 1
    generation.current = ticket
    const missionId = mission.missionId
    // 只有「这个 scope 还没读到过东西」才亮读取态：后台回读不在界面上闪空。
    if (loadedMission.current !== missionId) setLoading(true)
    void Promise.all([
      client.request<LoomPlan | null>('loom.plan.get', { missionId }),
      client.request<LoomTask[]>('loom.tasks.list', { missionId }),
      client.request<LoomDependency[]>('loom.dependencies.list', { missionId }),
      client.request<LoomCandidate[]>('loom.candidates.list', { missionId }),
      client.request<LoomReview[]>('loom.reviews.list', { missionId }),
      client.request<LoomVerification[]>('loom.verifications.list', { missionId }),
      // 认领读失败不拖垮其他投影：只把认领区降级成「认领状态未知」。
      client.request<LoomClaimsListResult>('loom.claims.list', { missionId })
        .then((result): LoomClaimsListResult | null => result, () => null),
      // 产物读失败同理：只把候选卡的产物区降级成「产物信息读取失败」，其他七个投影照常。
      client.request<LoomArtifactsListResult>('loom.artifacts.list', { missionId })
        .then((result): LoomArtifactsListResult | null => result, () => null),
      // 控制策略：读失败只降级成「读不到」，不影响其他投影，也不编一个未启用状态。
      client.request<LoomControlSnapshot>('loom.control.get', { missionId })
        .then((result): LoomControlRead => ({ snapshot: result, error: '' }), (e: unknown): LoomControlRead => ({
          snapshot: null,
          error: e instanceof Error && e.message !== '' ? e.message : '控制策略读取失败'
        }))
    ]).then(([p, t, d, c, r, v, k, a, controlRead]) => {
      if (generation.current !== ticket) return
      loadedMission.current = missionId
      setPlan(p); setTasks(t); setDependencies(d); setCandidates(c); setReviews(r); setVerifications(v)
      setClaims(k === null ? null : k.claims); setArtifacts(a === null ? null : a.artifacts)
      setControl(controlRead.snapshot); setControlError(controlRead.error); setError('')
      setLoading(false)
    }, (e: unknown) => {
      if (generation.current !== ticket) return
      setError(e instanceof Error && e.message !== '' ? e.message : '读取编排数据失败')
      setLoading(false)
    })
  }, [client, mission.missionId])

  // 换使命或换 client：paint 前清掉上一 scope 的投影，再拉新 scope。
  // cleanup 递增代次：卸载或换 scope 后，旧请求的响应一律不再 setState。
  useLayoutEffect(() => {
    loadedMission.current = null
    setPlan(null); setTasks([]); setDependencies([]); setCandidates([]); setReviews([]); setVerifications([])
    setClaims(null); setArtifacts(null); setControl(null); setControlError(''); setError(''); setLoading(true)
    load()
    return () => { generation.current += 1 }
  }, [mission.missionId, load])

  // 助手经 `rovai loom` 写入后 Core 发 missions.invalidated：本使命相关（含 loomUpdated）就回读。
  useEffect(() => {
    const stop = client.onEvent?.(event => {
      if (event.method !== 'missions.invalidated') return
      const params = event.params && typeof event.params === 'object' ? event.params as Record<string, unknown> : {}
      const reason = typeof params.reason === 'string' ? params.reason : ''
      const threadId = typeof params.threadId === 'string' ? params.threadId : null
      const eventMissionId = typeof params.missionId === 'string' ? params.missionId : null
      // 明确属于别的使命/会话的事件不处理。
      if (threadId !== null && threadId !== mission.threadId) return
      if (eventMissionId !== null && eventMissionId !== mission.missionId) return
      const sameMission = threadId === mission.threadId || eventMissionId === mission.missionId
      if (reason !== 'missions.loomUpdated' && !sameMission) return
      load()
    })
    return () => { stop?.() }
  }, [client, mission.missionId, mission.threadId, load])

  // 页面重新可见时回读；不新增定时轮询。
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [load])

  useLayoutEffect(() => {
    if (section === 'plan') return
    const saved = scrollPositions.current[section]
    const node = shared.current
    if (node && saved) { node.scrollTop = saved.top; node.scrollLeft = saved.left }
  }, [section])

  // 节点进程列表独立轮询：这是执行侧观测，不属于上面那条投影 load。
  useEffect(() => {
    if (!nodes) {
      setNodeRecords(null)
      setNodeError(false)
      return
    }
    let alive = true
    const readNodes = (): void => {
      void nodes.list().then(result => {
        if (!alive) return
        setNodeRecords(result.nodes)
        setNodeError(false)
      }).catch(() => {
        if (alive) setNodeError(true)
      })
    }
    readNodes()
    const timer = window.setInterval(readNodes, 5000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [nodes])

  // 这个 scope 的数据是否已经落地：没落地就只给读取态，绝不把 0 任务当成空结果。
  const scopeLoaded = loadedMission.current === mission.missionId
  const scopedLoading = !scopeLoaded && error === ''
  const hasData = plan !== null || tasks.length > 0 || candidates.length > 0

  const select = (next: LoomSection): void => {
    const node = shared.current
    if (node && section !== 'plan') scrollPositions.current[section] = { top: node.scrollTop, left: node.scrollLeft }
    setSection(next)
    setVisited(current => current.has(next) ? current : new Set(current).add(next))
    // 用户切 tab（首次或再次）都回读一次；并发触发由代次只取最后一份。
    load()
  }
  // 电脑页顶部的真实队长档案：使命里配了默认队长且该成员仍在 agents 里才渲染。
  const missionLead = mission.defaultLeadAgentId === null
    ? null
    : agents.find(agent => agent.agentId === mission.defaultLeadAgentId) ?? null
  const preview = useOptionalFilePreview()
  const previewLayout = useOptionalFilePreviewLayout()
  const [sectionHeaderHost, setSectionHeaderHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setSectionHeaderHost(document.getElementById('loom-inspector-header-slot'))
  }, [preview?.activeTabId, preview?.paneVisible, preview?.tabs.length, previewLayout?.compact, mission.missionId])
  const sectionTabs = <nav className="loom-section-tabs" aria-label={uiAttribute('使命工作区')}>
      {LOOM_TABS.map(tab => <button key={tab.id} type="button" aria-pressed={section === tab.id} onClick={() => select(tab.id)}>
        {tab.id === 'plan' && <Icon name="branch"/>}
        <UiText zh={tab.label}/>
      </button>)}
    </nav>
  return <div className="loom-workspace">
    {sectionHeaderHost ? createPortal(sectionTabs, sectionHeaderHost) : sectionTabs}
    <div className="loom-section-body">
      {visited.has('computer') && <div hidden={section !== 'computer'}><LoomComputer nodeRecords={nodeRecords} nodeError={nodeError} lead={missionLead}/></div>}
      {visited.has('plan') && <div className="loom-plan-host" hidden={section !== 'plan'}><PlanWorkspace mission={mission} agents={agents} plan={plan} tasks={tasks} dependencies={dependencies} candidates={candidates} reviews={reviews} claims={claims} loading={loading} error={error} nodeRecords={nodeRecords} nodeError={nodeError} nodes={nodes} control={control} controlError={controlError} onReload={load}/></div>}
      <div ref={shared} className={section === 'delivery' ? 'loom-delivery' : 'mission-activity-document'} hidden={section === 'plan' || section === 'computer'}>
        {visited.has('delivery') && <div hidden={section !== 'delivery'}>
          {scopedLoading && <LoomEmpty title={t('正在读取交付…')}><p>{t('从控制面读取成果、审查与验收记录。')}</p></LoomEmpty>}
          {!scopeLoaded && !scopedLoading && !hasData && <LoomEmpty title={t('读取交付失败')}>
            <p>{error}</p>
            <p>{t('请检查控制面连接后重试。')}</p>
            <button type="button" className="loom-summary-secondary" onClick={load}>{t('重试')}</button>
          </LoomEmpty>}
          {scopeLoaded && error !== ''
            && <p className="loom-live-note" role="status">{t('刷新失败：{0}', error)}</p>}
          {/* 读到过就挂载：空候选也要显示真实的「尚无成果」，不能整块空白。 */}
          {!scopedLoading && scopeLoaded && <LoomDelivery candidates={candidates} reviews={reviews} verifications={verifications} artifacts={artifacts} plan={plan} missionId={mission.missionId} onRefresh={load} tasks={tasks} dependencies={dependencies} stageReviews={control === null ? null : control.stageReviews} agents={agents} policy={control === null ? null : control.policy}/>}
        </div>}
        <div hidden={section !== 'activity'}>
          <LoomProgress
            mission={mission} agents={agents} tasks={tasks} candidates={candidates}
            loading={scopedLoading} error={error} onRetry={load}
            onOpenPlan={() => select('plan')}/>
          {/* 原来的交付动作与活动流水保留，但收进进展页的折叠区，不再跨 tab 常显。 */}
          <details className="loom-summary-details" data-details="activity">
            <summary>{t('活动与交付记录')}</summary>
            <MissionDeliveryPanel mission={mission} agents={agents} onSource={onSource} onNotify={onNotify} onWorkspaceCleanupRequested={onWorkspaceCleanupRequested}/>
            <MissionActivityPanel mission={mission} agents={agents} onSource={onSource}/>
          </details>
        </div>
      </div>
    </div>
  </div>
}

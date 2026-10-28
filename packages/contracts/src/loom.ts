// LOOM 控制层类型：从 ACCP 抄的核心概念，适配 Rovai 的 Mission/AgentRun 模型。
// 证据：docs/loom/control-plane.md、Pi 工兵 ACCP 盘点、Astra UI 审查。

/**
 * Task 状态机：严格照 ACCP 的六个状态。
 * 刻意没有 in_progress ——「正在执行」属于 Run/Attempt，不属于 Task；
 * Task 只是可领取（ready）、被阻塞（blocked）或待审（in_review）。
 */
export type LoomTaskStatus = 'draft' | 'ready' | 'blocked' | 'in_review' | 'done' | 'canceled'

/** DAG 依赖边：从 ACCP 抄 task_dependencies。 */
export type LoomDependencyCondition = 'task_done' | 'artifact_accepted'

/** 单条验收标准：criterionId 在 Task 内唯一、发布后不可修改且不得复用。 */
export interface LoomAcceptanceCriterion {
  /** 稳定 ID：逐条结论一律按它绑定，不依赖数组下标 */
  criterionId: string
  /** 标准文本 */
  text: string
}

/** 验收标准版本快照：Plan 定义、Task 承接、Candidate 生产都钉在同一份快照上。 */
export interface LoomAcceptanceCriteriaSnapshot {
  /** 标准版本：内容一生效就递增，旧版本只读保留 */
  version: string
  /** 逐条标准（顺序敏感，但结论按 criterionId 绑定） */
  criteria: LoomAcceptanceCriterion[]
}

/** 单条标准的验收结论：只记结论与证据引用，不重复保存标准文本。 */
export interface LoomAcceptanceCriterionResult {
  criterionId: string
  satisfied: boolean
  /** 支撑该结论的证据引用 */
  evidenceIds: string[]
  /** 人工备注 */
  note: string | null
}

/** 依赖释放的冻结溯源：首次满足即冻结，之后不随上游修订自动升级。 */
export interface LoomDependencyResolution {
  /** 释放时间 */
  resolvedAt: string
  /** 释放时上游 Task 的修订号 */
  upstreamTaskRevision: number
  /** 释放时认定的上游 Candidate（artifact_accepted 必有，task_done 为 null） */
  candidateId: string | null
  /** 支撑该候选 acceptanceStatus 的人工验收记录（artifact_accepted 必有） */
  reviewId: string | null
}

export interface LoomDependency {
  /** 依赖 ID */
  dependencyId: string
  /** 所属计划 ID（边不得跨计划） */
  planId: string
  /** 上游 Task ID */
  upstreamTaskId: string
  /** 下游 Task ID */
  downstreamTaskId: string
  /** 释放条件 */
  condition: LoomDependencyCondition
  /** 冻结的已解决产物 ID（首次满足即冻结，不自动升级） */
  resolvedArtifactId: string | null
  /** 冻结溯源：释放时间、上游修订、候选/审核引用；null 表示从未释放 */
  resolution: LoomDependencyResolution | null
  /** 创建时间 */
  createdAt: string
}

/** 计划定义：挂在 Mission 上。 */
export interface LoomPlan {
  /** 计划 ID */
  planId: string
  /** 所属 Mission ID */
  missionId: string
  /** 目标描述 */
  goal: string
  /** 验收标准版本快照（计划级定义，Task 承接同一版本） */
  acceptanceCriteria: LoomAcceptanceCriteriaSnapshot
  /** 创建时间 */
  createdAt: string
  /** 修订版本（每次修改递增） */
  revision: number
}

/** 计划任务：扩展 Rovai TaskView。 */
export interface LoomTask {
  /** Task ID */
  taskId: string
  /** 所属计划 ID */
  planId: string
  /** 任务标题 */
  title: string
  /** 任务描述 */
  description: string
  /** 负责人 Agent ID（责任≠执行授权；可为空表示未指派） */
  assigneeAgentId: string | null
  /** 状态 */
  status: LoomTaskStatus
  /** 验收标准版本快照（逐条稳定 ID + 版本） */
  acceptanceCriteria: LoomAcceptanceCriteriaSnapshot
  /** 真实阻塞原因（从 Run 失败或人工标记来） */
  blockedReason: string | null
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
  /** 修订版本 */
  revision: number
}

/** 版本化交付候选：从 ACCP 抄，返工产生新版本不覆盖旧结论。 */
export interface LoomCandidate {
  /** Candidate ID */
  candidateId: string
  /** 所属 Task ID */
  taskId: string
  /** 关联的 AgentRun ID（Attempt） */
  agentRunId: string
  /** 内容 hash（证明内容一致） */
  contentHash: string
  /** 证据集合（引用） */
  evidenceIds: string[]
  /** 生产时钉住的验收标准版本快照（Review 必须对同一版本给结论） */
  acceptanceCriteria: LoomAcceptanceCriteriaSnapshot
  /** 上一个 Candidate ID（返工链） */
  previousCandidateId: string | null
  /** 核验状态 */
  verificationStatus: 'unverified' | 'verified' | 'failed'
  /** 业务验收状态（跨 Run 引用要求 verified + accepted） */
  acceptanceStatus: 'pending' | 'accepted' | 'rejected'
  /** 创建时间 */
  createdAt: string
}

/** 人工验收记录：独立于 Run 终态，不可变。 */
export interface LoomReview {
  /** Review ID */
  reviewId: string
  /** 针对的 Candidate ID */
  candidateId: string
  /** 判定所依据的验收标准版本（必须与候选快照版本一致） */
  acceptanceCriteriaVersion: string
  /** 验收结论 */
  verdict: 'accepted' | 'rejected'
  /** 验收理由 */
  reason: string
  /** 逐项结论：accepted 必须覆盖该版本每条 criterionId 且全为 true */
  criteriaResults: LoomAcceptanceCriterionResult[]
  /** 验收人（用户） */
  reviewerId: string
  /** 验收时间 */
  reviewedAt: string
}

/** 执行认领：绑定实际 Run、授权主体、租约。 */
export interface LoomClaim {
  /** Claim ID */
  claimId: string
  /** 认领的 Task ID */
  taskId: string
  /** 实际执行的 AgentRun ID */
  agentRunId: string
  /** 认领者 Agent ID */
  claimantAgentId: string
  /** 租约过期时间 */
  leaseExpiresAt: string
  /** 栅栏代次（防止旧执行者提交） */
  fenceGeneration: number
  /** 认领时间 */
  claimedAt: string
}

/** 依赖未释放原因。 */
export type LoomDependencyBlockReason =
  | 'upstream_task_missing'
  | 'upstream_task_not_done'
  | 'candidate_missing'
  | 'candidate_not_verified'
  | 'candidate_not_accepted'
  | 'accepted_review_missing'
  | 'review_criteria_mismatch'
  | 'review_criteria_incomplete'

/** 单条依赖边的求值结果。 */
export interface LoomDependencyEvaluation {
  dependencyId: string
  upstreamTaskId: string
  condition: LoomDependencyCondition
  satisfied: boolean
  /** 未释放原因（已释放为 null） */
  reason: LoomDependencyBlockReason | null
  /** 冻结溯源：已释放（含此前已冻结）时非空 */
  resolution: LoomDependencyResolution | null
}

/** 依赖就绪判定：一条 SQL 求值，不是事件。 */
export interface LoomTaskReadyResult {
  taskId: string
  ready: boolean
  /** 未就绪原因（只包含未满足的依赖边） */
  blockedBy: Array<{
    dependencyId: string
    upstreamTaskId: string
    condition: LoomDependencyCondition
    satisfied: boolean
    reason: LoomDependencyBlockReason | null
  }>
  /** 求值错误（如 TASK_NOT_FOUND）；非空时 ready 恒为 false */
  error: string | null
}

/** 验收提交：Owner 专属、IN_REVIEW 才可审、必须最新 attempt。 */
export interface LoomReviewSubmission {
  /** Task ID */
  taskId: string
  /** Candidate ID（必须是最新的） */
  candidateId: string
  /** 判定所依据的验收标准版本（必须与候选快照一致） */
  acceptanceCriteriaVersion: string
  /** 验收结论 */
  verdict: 'accepted' | 'rejected'
  /** 验收理由 */
  reason: string
  /** 逐条结论（accepted 必须覆盖每条 criterionId 且全 true） */
  criteriaResults: LoomAcceptanceCriterionResult[]
  /** 验收人 */
  reviewerId: string
}

/** 验收提交结果：逐条验收标准全 true 才通过。 */
/** 核验结论：交付能否被独立复现，与人工验收是两条轴。 */
export type LoomVerificationResult = 'passed' | 'failed'

/** 证据核验记录：不可变，一个候选只能有一份。 */
export interface LoomVerification {
  verificationId: string
  candidateId: string
  /** 核验方法（跑了什么、怎么跑的） */
  method: string
  /** 执行核验的主体 */
  executorId: string
  result: LoomVerificationResult
  /** 支撑结论的证据引用 */
  evidenceIds: string[]
  verifiedAt: string
}

/** 核验提交入参。 */
export interface LoomVerificationRecordInput {
  missionId: string
  taskId: string
  candidateId: string
  /** 幂等键：同一 commandId 重放返回既有核验 */
  commandId: string
  method: string
  // executorId is injected by Core from the trusted Host identity.
  // Clients must not send this field; any value is overwritten.
  result: LoomVerificationResult
  evidenceIds?: string[]
}

/** 核验回执：写入的核验 + 它推进了什么。 */
export interface LoomVerificationRecordReceipt {
  verification: LoomVerification
  missionId: string
  planId: string
  taskId: string
  candidateVerificationStatus: 'unverified' | 'verified' | 'failed'
  /** 本次核验冻结放行的依赖边 ID */
  releasedDependencyIds: string[]
  replayed: boolean
}

/** 验收提交入参：Owner 对一个 Candidate 的终判。 */
export interface LoomReviewRecordInput {
  missionId: string
  taskId: string
  candidateId: string
  /** 幂等键：同一 commandId 重放返回既有评审，不再写第二条 */
  commandId: string
  /** 必须与该候选钉住的验收标准版本一致 */
  acceptanceCriteriaVersion: string
  verdict: 'accepted' | 'rejected'
  reason: string
  /** accepted 必须恰好覆盖该版本每条 criterionId 且全为 true */
  criteriaResults: LoomAcceptanceCriterionResult[]
  // reviewerId is injected by Core from the trusted Host identity.
  // Clients must not send this field; any value is overwritten.
}

/** 验收回执：写入的评审 + 它推进了什么。 */
export interface LoomReviewRecordReceipt {
  review: LoomReview
  missionId: string
  planId: string
  taskId: string
  /** 接受 → done；驳回 → ready */
  taskStatus: LoomTaskStatus
  candidateAcceptanceStatus: 'pending' | 'accepted' | 'rejected'
  /** 本次判定冻结放行的依赖边 ID，按依赖顺序 */
  releasedDependencyIds: string[]
  /** 同一 commandId 重放且未写新行时为 true */
  replayed: boolean
}

// (second LoomReviewRecordInput declaration removed — merged with the canonical one above;
//  reviewerId is injected by Core, not sent by clients.)

/** 验收回执：写入的评审 + 它推进了什么。 */
export interface LoomReviewRecordReceipt {
  /** 写入（或重放）的那份评审 */
  review: LoomReview
  /** Mission 作用域回显 */
  missionId: string
  /** 所属计划 ID */
  planId: string
  /** 被判定的 Task ID */
  taskId: string
  /** 接受 → done；驳回 → ready */
  taskStatus: LoomTaskStatus
  /** 候选的验收轴结论 */
  candidateAcceptanceStatus: 'pending' | 'accepted' | 'rejected'
  /** 本次判定冻结放行的依赖边 ID，按依赖顺序 */
  releasedDependencyIds: string[]
  /** 同一 commandId 重放且未写新行时为 true */
  replayed: boolean
}

export interface LoomReviewResult {
  /** 是否通过 */
  passed: boolean
  /** 被判定所依据的验收标准版本 */
  acceptanceCriteriaVersion: string
  /** 逐条验收结果（按 criterionId 绑定，不依赖数组顺序） */
  criteriaResults: LoomAcceptanceCriterionResult[]
  /** 错误信息（如 STALE_REVIEW、候选非最新等） */
  error: string | null
}

/** 依赖求值输入：任务、依赖边、候选、人工验收记录与求值时刻。 */
export interface LoomDependencyGraph {
  tasks: readonly LoomTask[]
  dependencies: readonly LoomDependency[]
  candidates: readonly LoomCandidate[]
  reviews: readonly LoomReview[]
  /** 求值时刻：首次满足时写入冻结溯源的 resolvedAt；求值本身是纯规则，不是事件 */
  evaluatedAt: string
}

/**
 * 返工链的链头候选：没有被同 Task 其他候选引为 previousCandidateId 的那一条。
 * 链分叉时取最新创建的一支。
 */
export function loomLatestCandidate(taskId: string, candidates: readonly LoomCandidate[]): LoomCandidate | null {
  const chain = candidates.filter(candidate => candidate.taskId === taskId)
  if (chain.length === 0) return null
  const superseded = new Set<string>()
  for (const candidate of chain) {
    if (candidate.previousCandidateId !== null) superseded.add(candidate.previousCandidateId)
  }
  const tips = chain.filter(candidate => !superseded.has(candidate.candidateId))
  const pool = tips.length > 0 ? tips : chain
  return pool.reduce((latest, candidate) => candidate.createdAt >= latest.createdAt ? candidate : latest)
}

/** 某候选上的最新人工验收通过记录。 */
function loomAcceptedReview(candidateId: string, reviews: readonly LoomReview[]): LoomReview | null {
  const accepted = reviews.filter(review => review.candidateId === candidateId && review.verdict === 'accepted')
  if (accepted.length === 0) return null
  return accepted.reduce((latest, review) => review.reviewedAt >= latest.reviewedAt ? review : latest)
}

/**
 * 逐条验收结论必须覆盖该版本的每一条 criterionId 且全部为 satisfied。
 * 缺条、重复条、或任一条不满足，都不能释放依赖。
 */
export function loomReviewSatisfiesCriteria(
  review: LoomReview,
  criteria: readonly LoomAcceptanceCriterion[]
): boolean {
  if (criteria.length === 0) return false
  const seen = new Set<string>()
  for (const result of review.criteriaResults) {
    if (!result.satisfied) return false
    if (seen.has(result.criterionId)) return false
    seen.add(result.criterionId)
  }
  return criteria.every(criterion => seen.has(criterion.criterionId))
}

/**
 * 依赖边求值：已冻结的边直接返回冻结溯源，不自动升级。
 * artifact_accepted 不能只看 task_done —— 必须由上游链头候选
 * verificationStatus === 'verified' 且 acceptanceStatus === 'accepted'，
 * 并有同版本验收标准的人工 Review 支撑。
 */
export function loomEvaluateDependency(dependency: LoomDependency, graph: LoomDependencyGraph): LoomDependencyEvaluation {
  const base = {
    dependencyId: dependency.dependencyId,
    upstreamTaskId: dependency.upstreamTaskId,
    condition: dependency.condition
  }
  if (dependency.resolution !== null) return { ...base, satisfied: true, reason: null, resolution: dependency.resolution }
  const upstream = graph.tasks.find(task => task.taskId === dependency.upstreamTaskId)
  if (upstream === undefined) return { ...base, satisfied: false, reason: 'upstream_task_missing', resolution: null }
  if (upstream.status !== 'done') return { ...base, satisfied: false, reason: 'upstream_task_not_done', resolution: null }
  if (dependency.condition === 'task_done') {
    return {
      ...base,
      satisfied: true,
      reason: null,
      resolution: {
        resolvedAt: graph.evaluatedAt,
        upstreamTaskRevision: upstream.revision,
        candidateId: null,
        reviewId: null
      }
    }
  }
  const candidate = loomLatestCandidate(upstream.taskId, graph.candidates)
  if (candidate === null) return { ...base, satisfied: false, reason: 'candidate_missing', resolution: null }
  if (candidate.verificationStatus !== 'verified') return { ...base, satisfied: false, reason: 'candidate_not_verified', resolution: null }
  if (candidate.acceptanceStatus !== 'accepted') return { ...base, satisfied: false, reason: 'candidate_not_accepted', resolution: null }
  const review = loomAcceptedReview(candidate.candidateId, graph.reviews)
  if (review === null) return { ...base, satisfied: false, reason: 'accepted_review_missing', resolution: null }
  if (review.acceptanceCriteriaVersion !== candidate.acceptanceCriteria.version) {
    return { ...base, satisfied: false, reason: 'review_criteria_mismatch', resolution: null }
  }
  if (!loomReviewSatisfiesCriteria(review, candidate.acceptanceCriteria.criteria)) {
    return { ...base, satisfied: false, reason: 'review_criteria_incomplete', resolution: null }
  }
  return {
    ...base,
    satisfied: true,
    reason: null,
    resolution: {
      resolvedAt: graph.evaluatedAt,
      upstreamTaskRevision: upstream.revision,
      candidateId: candidate.candidateId,
      reviewId: review.reviewId
    }
  }
}

/** Task 就绪判定：所有入边都释放才 ready；只反映依赖，不代替状态机。 */
export function loomTaskReady(taskId: string, graph: LoomDependencyGraph): LoomTaskReadyResult {
  const task = graph.tasks.find(entry => entry.taskId === taskId)
  if (task === undefined) return { taskId, ready: false, blockedBy: [], error: 'TASK_NOT_FOUND' }
  const blockedBy = graph.dependencies
    .filter(dependency => dependency.downstreamTaskId === taskId)
    .map(dependency => loomEvaluateDependency(dependency, graph))
    .filter(evaluation => !evaluation.satisfied)
    .map(evaluation => ({
      dependencyId: evaluation.dependencyId,
      upstreamTaskId: evaluation.upstreamTaskId,
      condition: evaluation.condition,
      satisfied: evaluation.satisfied,
      reason: evaluation.reason
    }))
  return { taskId, ready: blockedBy.length === 0, blockedBy, error: null }
}

/** DAG 校验输入。 */
export interface LoomDagInput {
  tasks: readonly LoomTask[]
  dependencies: readonly LoomDependency[]
}

/** DAG 缺陷类别。 */
export type LoomDagIssueCode = 'self_dependency' | 'dangling_edge' | 'cross_plan_edge' | 'cycle'

/** 单条 DAG 缺陷。 */
export interface LoomDagIssue {
  code: LoomDagIssueCode
  /** 涉及依赖边（环为环上全部边） */
  dependencyIds: string[]
  /** 涉及 Task（环为环上全部节点；悬空边为缺失的 ID） */
  taskIds: string[]
  /** 人读说明 */
  detail: string
}

/** DAG 校验结果。 */
export interface LoomDagValidationResult {
  valid: boolean
  issues: LoomDagIssue[]
}

/** 在合法边（两端存在且同计划）上找环；每个环只报一次。 */
function findLoomCycles(
  tasks: readonly LoomTask[],
  adjacency: ReadonlyMap<string, ReadonlyArray<{ taskId: string; dependencyId: string }>>
): LoomDagIssue[] {
  const issues: LoomDagIssue[] = []
  const seen = new Set<string>()
  const state = new Map<string, 'visiting' | 'done'>()
  const pathTasks: string[] = []
  const pathEdges: string[] = []

  const visit = (taskId: string): void => {
    state.set(taskId, 'visiting')
    pathTasks.push(taskId)
    for (const edge of adjacency.get(taskId) ?? []) {
      const next = state.get(edge.taskId)
      if (next === 'visiting') {
        const start = pathTasks.indexOf(edge.taskId)
        const cycleTasks = pathTasks.slice(start)
        const cycleEdges = [...pathEdges.slice(start), edge.dependencyId]
        const key = [...cycleTasks].sort().join('|')
        if (!seen.has(key)) {
          seen.add(key)
          issues.push({
            code: 'cycle',
            dependencyIds: cycleEdges,
            taskIds: cycleTasks,
            detail: `依赖成环：${[...cycleTasks, edge.taskId].join(' → ')}`
          })
        }
        continue
      }
      if (next === 'done') continue
      pathEdges.push(edge.dependencyId)
      visit(edge.taskId)
      pathEdges.pop()
    }
    pathTasks.pop()
    state.set(taskId, 'done')
  }

  for (const task of tasks) if (!state.has(task.taskId)) visit(task.taskId)
  return issues
}

/**
 * DAG 校验：自依赖、悬空边（引用不存在的 Task）、跨计划边、环。
 * 只有两端都存在且同计划内的边参与成环判定，其余缺陷各报一条。
 */
export function validateLoomDag(input: LoomDagInput): LoomDagValidationResult {
  const tasksById = new Map(input.tasks.map(task => [task.taskId, task]))
  const issues: LoomDagIssue[] = []
  const adjacency = new Map<string, Array<{ taskId: string; dependencyId: string }>>()

  for (const dependency of input.dependencies) {
    if (dependency.upstreamTaskId === dependency.downstreamTaskId) {
      issues.push({
        code: 'self_dependency',
        dependencyIds: [dependency.dependencyId],
        taskIds: [dependency.upstreamTaskId],
        detail: `依赖边 ${dependency.dependencyId} 自依赖 Task ${dependency.upstreamTaskId}`
      })
      continue
    }
    const missing = [dependency.upstreamTaskId, dependency.downstreamTaskId].filter(id => !tasksById.has(id))
    if (missing.length > 0) {
      issues.push({
        code: 'dangling_edge',
        dependencyIds: [dependency.dependencyId],
        taskIds: missing,
        detail: `依赖边 ${dependency.dependencyId} 引用了不存在的 Task：${missing.join('、')}`
      })
      continue
    }
    const upstream = tasksById.get(dependency.upstreamTaskId)
    const downstream = tasksById.get(dependency.downstreamTaskId)
    if (upstream === undefined || downstream === undefined) continue
    if (upstream.planId !== downstream.planId) {
      issues.push({
        code: 'cross_plan_edge',
        dependencyIds: [dependency.dependencyId],
        taskIds: [upstream.taskId, downstream.taskId],
        detail: `依赖边 ${dependency.dependencyId} 跨越计划：${upstream.planId} → ${downstream.planId}`
      })
      continue
    }
    const siblings = adjacency.get(upstream.taskId) ?? []
    siblings.push({ taskId: downstream.taskId, dependencyId: dependency.dependencyId })
    adjacency.set(upstream.taskId, siblings)
  }

  for (const issue of findLoomCycles(input.tasks, adjacency)) issues.push(issue)
  return { valid: issues.length === 0, issues }
}

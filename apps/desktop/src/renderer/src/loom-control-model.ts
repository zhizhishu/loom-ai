// LOOM 控制层的纯派生：只在真实投影上算，不存第二份状态。
//
// 权威类型只在契约层（packages/contracts/src/loom.ts，经 '@contracts' 再导出）。
// 这里只做 re-export，不另立一套 types；调用方统一从 './loom-control-model' 取，
// 契约变动时本文件是 UI 侧唯一切换点。
import type {
  LoomArtifact,
  LoomCandidate,
  LoomControlPauseInput,
  LoomControlPolicy,
  LoomControlPolicyInput,
  LoomControlSnapshot,
  LoomDependency,
  LoomDependencyBlockReason,
  LoomDispatch,
  LoomStageReview
} from '@contracts'
import { loomLatestCandidate } from '@contracts'
import { readErrorMessage } from './error-message'

export type {
  LoomControlPauseInput,
  LoomControlPolicy,
  LoomControlPolicyInput,
  LoomControlSnapshot,
  LoomDispatch,
  LoomStageReview
}

/**
 * 控制区状态。
 * reading/unreadable 都不等于「未启用」或「未批准」：读不到完整投影就说读不到，
 * 不许用空数组或默认值假装知道答案。
 */
export type LoomControlState = 'reading' | 'unreadable' | 'unapproved' | 'disabled' | 'expired' | 'paused' | 'approved'

/**
 * 授权版本：只由 configure 推进（pause/resume 不动它，只推 revision）。
 * 直接读契约字段；运行时仍然校验取值，非法（非整数/负数/缺失）一律返 null，
 * 由完整性检查落到 unreadable，不用 0 兜底。
 */
export function loomPolicyAuthorizationRevision(policy: LoomControlPolicy): number | null {
  const value: number = policy.authorizationRevision
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * 快照完整性检查：缺少必需字段时返回字段名，调用方必须落到 unreadable。
 * 这样「字段没送到」与「真的没批准」不会再被同一个空态吞掉。
 */
export function loomControlSnapshotProblem(snapshot: LoomControlSnapshot): string | null {
  if (typeof snapshot.evaluatedAt !== 'string' || Number.isNaN(Date.parse(snapshot.evaluatedAt))) return 'evaluatedAt'
  if (!Array.isArray(snapshot.stageReviews)) return 'stageReviews'
  if (!Array.isArray(snapshot.dispatches)) return 'dispatches'
  const policy = snapshot.policy as LoomControlPolicy | null
  if (policy === null) return null
  if (typeof policy.revision !== 'number') return 'revision'
  if (loomPolicyAuthorizationRevision(policy) === null) return 'authorizationRevision'
  if (typeof policy.enabled !== 'boolean') return 'enabled'
  if (typeof policy.paused !== 'boolean') return 'paused'
  if (!Array.isArray(policy.taskIds)) return 'taskIds'
  if (!Array.isArray(policy.reviewers)) return 'reviewers'
  if (typeof policy.maxDispatches !== 'number') return 'maxDispatches'
  if (typeof policy.maxReworksPerTask !== 'number') return 'maxReworksPerTask'
  if (typeof policy.approvedBy !== 'string') return 'approvedBy'
  return null
}

/**
 * 策略是否已过期：只认 snapshot.evaluatedAt（服务端时钟），
 * 客户端不许拿本机 now 推算——那会随运行时刻翻面。
 */
export function loomPolicyExpired(policy: LoomControlPolicy, evaluatedAt: string): boolean {
  if (policy.expiresAt === null) return false
  const expires = Date.parse(policy.expiresAt)
  const moment = Date.parse(evaluatedAt)
  if (Number.isNaN(expires) || Number.isNaN(moment)) return false
  return expires <= moment
}

export function loomControlState(snapshot: LoomControlSnapshot | null, readError: string): LoomControlState {
  if (readError !== '') return 'unreadable'
  if (snapshot === null) return 'reading'
  // 缺字段的投影不是「没批准」：宁可说读不到，也不能用默认值假装知道答案。
  if (loomControlSnapshotProblem(snapshot) !== null) return 'unreadable'
  const policy = snapshot.policy
  if (policy === null) return 'unapproved'
  if (!policy.enabled) return 'disabled'
  // 过期盖过暂停：授权已失效，不能靠「继续」把它复活。
  if (loomPolicyExpired(policy, snapshot.evaluatedAt)) return 'expired'
  return policy.paused ? 'paused' : 'approved'
}

/**
 * 修订冲突识别：只认 Core 的稳定码 LOOM_CONTROL_REVISION_CONFLICT，
 * 再退回通用错误对象 message 正文的自述措辞；都不认就是 false，不猜别的码名。
 */
export function loomControlRevisionConflict(error: unknown): boolean {
  const text = String(readErrorMessage(error, '') ?? '').trim()
  if (text === '') return false
  if (text.includes('LOOM_CONTROL_REVISION_CONFLICT')) return true
  return /\brevision conflict\b/iu.test(text)
}

export type LoomCandidateVersion = {
  candidateId: string
  taskId: string
  /** 版本号：链根为 1，沿 previousCandidateId 每上一版 +1 */
  version: number
  latest: boolean
  previousCandidateId: string | null
}

/**
 * 版本链：逐条按 previousCandidateId 回推版本号，链头（最新）沿用控制层
 * loomLatestCandidate 的判定，不在这里另立一套「谁最新」的规则。
 * 父版本不在投影里就当链根，成环则停在原地——不抛错、不死循环。
 */
export function loomCandidateVersions(candidates: readonly LoomCandidate[]): LoomCandidateVersion[] {
  const byId = new Map(candidates.map(candidate => [candidate.candidateId, candidate] as const))
  const versions = new Map<string, number>()
  const versionOf = (candidateId: string): number => {
    const known = versions.get(candidateId)
    if (known !== undefined) return known
    let depth = 0
    let cursor = candidateId
    const seen = new Set<string>([candidateId])
    for (;;) {
      const previous = byId.get(cursor)?.previousCandidateId ?? null
      // 父版本不在投影里就当链根：「读不到」不能被折算成一个更高的版本号；
      // 成环同理停在原地，不抛错也不死循环。
      if (previous === null || !byId.has(previous) || seen.has(previous)) break
      seen.add(previous)
      depth += 1
      cursor = previous
    }
    versions.set(candidateId, depth + 1)
    return depth + 1
  }
  const tips = new Map<string, string | null>()
  for (const taskId of new Set(candidates.map(candidate => candidate.taskId))) {
    tips.set(taskId, loomLatestCandidate(taskId, candidates)?.candidateId ?? null)
  }
  return candidates
    .map(candidate => ({
      candidateId: candidate.candidateId,
      taskId: candidate.taskId,
      version: versionOf(candidate.candidateId),
      latest: tips.get(candidate.taskId) === candidate.candidateId,
      previousCandidateId: candidate.previousCandidateId
    }))
    .sort((left, right) => left.taskId === right.taskId
      ? left.version - right.version
      : left.taskId < right.taskId ? -1 : 1)
}

/** 某候选上的最新一次助手审查；同一时刻以数组中靠后者为准。 */
export function loomStageReviewLatest(stageReviews: readonly LoomStageReview[], candidateId: string): LoomStageReview | null {
  // 投影可能整块缺失（残缺快照）：当「没有可用的审查」，不让渲染层抛错。
  if (!Array.isArray(stageReviews)) return null
  let latest: LoomStageReview | null = null
  for (const review of stageReviews) {
    if (review.candidateId !== candidateId) continue
    if (latest === null || review.reviewedAt >= latest.reviewedAt) latest = review
  }
  return latest
}

/** 阶段审查相对「当前授权」的时效。 */
export type LoomStageReviewFreshness = 'current' | 'stale' | 'unknown'

/**
 * policyRevision 必须等于 authorizationRevision 才算当前授权下的审查。
 * pause/resume 只推进 revision，所以暂停不会让审查突然有效或失效；
 * 没有策略（或策略缺授权修订）时无法判定 → unknown，不冒充当前有效。
 */
export function loomStageReviewFreshness(
  review: LoomStageReview,
  policy: LoomControlPolicy | null
): LoomStageReviewFreshness {
  if (policy === null) return 'unknown'
  const authorization = loomPolicyAuthorizationRevision(policy)
  if (authorization === null) return 'unknown'
  return review.policyRevision === authorization ? 'current' : 'stale'
}

/**
 * 只有「当前授权 + pass」才能当通过展示。
 * 旧授权审查留作历史并明确失效；request_changes/blocked 也永远不是人工驳回。
 */
export function loomStageReviewPassesCurrently(review: LoomStageReview, policy: LoomControlPolicy | null): boolean {
  return review.verdict === 'pass' && loomStageReviewFreshness(review, policy) === 'current'
}

export function loomStageVerdictLabel(verdict: LoomStageReview['verdict']): string {
  return verdict === 'pass' ? '通过' : verdict === 'request_changes' ? '要求返工' : '阻塞'
}

export function loomDispatchKindLabel(kind: LoomDispatch['kind']): string {
  return kind === 'execute' ? '执行' : kind === 'review' ? '审查' : kind === 'rework' ? '返工' : '交接'
}

export function loomDispatchStatusLabel(status: LoomDispatch['status']): string {
  return status === 'waiting' ? '等待派发'
    : status === 'dispatched' ? '已派发'
      : status === 'settled' ? '已结算'
        : status === 'blocked' ? '阻塞' : '已取消'
}

/** 依赖未释放原因：控制层枚举值不直接展示给用户。 */
export function loomDependencyReasonLabel(reason: LoomDependencyBlockReason | null): string {
  switch (reason) {
    case 'upstream_task_missing': return '上游任务不存在'
    case 'upstream_task_not_done': return '上游任务未完成'
    case 'candidate_missing': return '上游还没有候选'
    case 'candidate_not_verified': return '上游候选未通过技术核验'
    case 'candidate_not_accepted': return '上游候选未通过用户验收'
    case 'accepted_review_missing': return '缺少同版本的人工验收记录'
    case 'review_criteria_mismatch': return '验收标准版本不一致'
    case 'review_criteria_incomplete': return '逐条验收结论不全'
    default: return ''
  }
}

/**
 * 已消费预算 = 全部历史 dispatch（含 cancelled）。
 * 取消不返还额度：界面与 Core 记账一致，不按 status 过滤。
 * `cancelled` 只作展示用的附加事实，不参与减法。
 */
export function loomDispatchTally(dispatches: readonly LoomDispatch[]): { used: number; cancelled: number } {
  let cancelled = 0
  for (const dispatch of dispatches) if (dispatch.status === 'cancelled') cancelled += 1
  return { used: dispatches.length, cancelled }
}

export type LoomAssetRegistration = 'registered' | 'unregistered' | 'unknown'

export type LoomAssetConsumer = {
  dependencyId: string
  downstreamTaskId: string
}

export type LoomAssetRelation = {
  key: string
  /** 候选引用的产物 ID（读不到登记行时仍是候选自己的 evidenceId 原文，不另编一个） */
  evidenceId: string
  relativePath: string | null
  producerAgentRunId: string | null
  producerCreatorId: string | null
  registration: LoomAssetRegistration
  candidateId: string
  taskId: string
  stageReview: LoomStageReview | null
  /** 使用者只来自三条同时成立且已冻结的依赖事实；不靠同路径/同 evidenceId 猜 */
  consumers: LoomAssetConsumer[]
}

/**
 * 资产关系：生产者 → 候选 → 助手审查 → 使用者。
 * 使用者必须同时满足：边已冻结（resolution 非空）、`resolution.candidateId === 该候选`、
 * `upstreamTaskId === 该候选的 taskId`，以及 edge 顶层的 `resolvedArtifactId === evidenceId`。
 * 少一条就不标使用者——宁可留空，也不把「同名字的产物」当成同一个消费者。
 */
export function loomAssetRelations(input: {
  candidates: readonly LoomCandidate[]
  dependencies: readonly LoomDependency[]
  artifacts: readonly LoomArtifact[] | null
  stageReviews: readonly LoomStageReview[] | null
}): LoomAssetRelation[] {
  const artifactById = new Map((input.artifacts ?? []).map(artifact => [artifact.artifactId, artifact] as const))
  const frozen = input.dependencies.filter(dependency =>
    dependency.condition === 'artifact_accepted' && dependency.resolution !== null)
  // 三条同时成立才算使用者：边已冻结（resolution 非空）、resolve 时认定了这个候选、
  // 并且 edge 顶层的 resolvedArtifactId 就是这条 evidenceId（契约 loom.ts:70-74）。
  const consumersOf = (evidenceId: string, candidate: LoomCandidate): LoomAssetConsumer[] => frozen
    .filter(dependency => dependency.upstreamTaskId === candidate.taskId
      && dependency.resolution?.candidateId === candidate.candidateId
      && dependency.resolvedArtifactId === evidenceId)
    .map(dependency => ({ dependencyId: dependency.dependencyId, downstreamTaskId: dependency.downstreamTaskId }))
  const rows: LoomAssetRelation[] = []
  const stageReviewRows = Array.isArray(input.stageReviews) ? input.stageReviews : null
  for (const candidate of input.candidates) {
    const stageReview = stageReviewRows === null
      ? null
      : loomStageReviewLatest(stageReviewRows, candidate.candidateId)
    const evidenceIds = candidate.evidenceIds.length > 0 ? candidate.evidenceIds : ['']
    for (const evidenceId of evidenceIds) {
      const artifact = evidenceId === '' ? undefined : artifactById.get(evidenceId)
      rows.push({
        key: `${candidate.candidateId}:${evidenceId}`,
        evidenceId,
        relativePath: artifact?.relativePath ?? null,
        producerAgentRunId: artifact?.agentRunId ?? null,
        producerCreatorId: artifact?.creatorId ?? null,
        registration: input.artifacts === null
          ? 'unknown'
          : artifact === undefined ? 'unregistered' : 'registered',
        candidateId: candidate.candidateId,
        taskId: candidate.taskId,
        stageReview,
        consumers: consumersOf(evidenceId, candidate)
      })
    }
  }
  return rows
}

export type LoomControlDraft = {
  taskIds: string[]
  reviewers: Record<string, string>
  /** 原始输入值：空字符串就是「用户还没填」，不替用户补默认预算 */
  maxDispatches: string
  maxReworksPerTask: string
  /** datetime-local 的原始值，空字符串表示不设到期 */
  expiresAt: string
}

export const EMPTY_LOOM_CONTROL_DRAFT: LoomControlDraft = {
  taskIds: [],
  reviewers: {},
  maxDispatches: '',
  maxReworksPerTask: '',
  expiresAt: ''
}

export type LoomControlProblem = 'no_tasks' | 'missing_reviewer' | 'max_dispatches' | 'max_reworks' | 'expires_at'

/** 批准前的显式缺口清单；空数组才允许提交。 */
export function loomControlProblems(draft: LoomControlDraft): LoomControlProblem[] {
  const problems: LoomControlProblem[] = []
  if (draft.taskIds.length === 0) problems.push('no_tasks')
  else if (draft.taskIds.some(taskId => (draft.reviewers[taskId] ?? '').trim() === '')) problems.push('missing_reviewer')
  if (!/^[1-9][0-9]*$/u.test(draft.maxDispatches.trim())) problems.push('max_dispatches')
  if (!/^(?:0|[1-9][0-9]*)$/u.test(draft.maxReworksPerTask.trim())) problems.push('max_reworks')
  if (draft.expiresAt.trim() !== '' && Number.isNaN(new Date(draft.expiresAt).getTime())) problems.push('expires_at')
  return problems
}

/** 合法草稿 → configure 入参；不合法返回 null，调用方据此禁用按钮而不是塞一个默认值。 */
export function loomControlInput(
  missionId: string,
  commandId: string,
  expectedRevision: number,
  draft: LoomControlDraft
): LoomControlPolicyInput | null {
  if (loomControlProblems(draft).length > 0) return null
  const expiresAt = draft.expiresAt.trim()
  return {
    missionId,
    commandId,
    expectedRevision,
    enabled: true,
    taskIds: [...draft.taskIds],
    reviewers: draft.taskIds.map(taskId => ({ taskId, reviewerAgentId: draft.reviewers[taskId].trim() })),
    maxDispatches: Number(draft.maxDispatches.trim()),
    maxReworksPerTask: Number(draft.maxReworksPerTask.trim()),
    expiresAt: expiresAt === '' ? null : new Date(expiresAt).toISOString()
  }
}

function localDateTimeValue(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 修改已批准范围时只回填真实策略值，仍然是用户显式点「修改范围」才发生。 */
export function loomControlDraftFromPolicy(policy: LoomControlPolicy): LoomControlDraft {
  return {
    taskIds: [...policy.taskIds],
    reviewers: Object.fromEntries(policy.reviewers.map(reviewer => [reviewer.taskId, reviewer.reviewerAgentId])),
    maxDispatches: String(policy.maxDispatches),
    maxReworksPerTask: String(policy.maxReworksPerTask),
    expiresAt: policy.expiresAt === null ? '' : localDateTimeValue(policy.expiresAt)
  }
}

/** 任务是否还有未释放的入边——编排节点用它补「为什么还没到」，不另存一份阻塞表。 */
export function loomUnreleasedInbound(
  blockedBy: ReadonlyArray<{ dependencyId: string; upstreamTaskId: string; reason: LoomDependencyBlockReason | null }>
): Array<{ dependencyId: string; upstreamTaskId: string; reason: LoomDependencyBlockReason }> {
  const rows: Array<{ dependencyId: string; upstreamTaskId: string; reason: LoomDependencyBlockReason }> = []
  for (const entry of blockedBy) {
    if (entry.reason === null) continue
    rows.push({ dependencyId: entry.dependencyId, upstreamTaskId: entry.upstreamTaskId, reason: entry.reason })
  }
  return rows
}

/** 用户接受只对最新候选生效；旧版一律锁住（并会被 Core 拒绝，这里只做界面这把锁）。 */
export function loomCandidateAcceptable(versions: readonly LoomCandidateVersion[], candidateId: string): boolean {
  return versions.some(version => version.candidateId === candidateId && version.latest)
}

/** 版本号 → 「v3」，缺版本信息时回落到 v1（链根语义），不显示空标签。 */
export function loomVersionLabel(version: number | undefined): string {
  return `v${typeof version === 'number' && version > 0 ? version : 1}`
}

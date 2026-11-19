import type {
  LoomAcceptanceCriterion,
  LoomAcceptanceCriterionResult,
  LoomArtifactPreviewResult,
  LoomDispatch,
  LoomReviewRecordInput,
  LoomReviewRecordReceipt,
  LoomTaskStatus
} from '@contracts'
// 只借类型：ThreadClient 是已认证的 Core 通道，这里不发任何自制 RPC。
import type { ThreadClient } from '../camp-client'
import { readErrorMessage } from '../error-message'
import {
  loomCandidateAcceptable,
  loomCandidateVersions,
  loomStageReviewFreshness,
  loomStageReviewLatest,
  loomVersionLabel
} from '../loom-control-model'
import type {
  ArtifactSelection,
  LoomArtifact,
  LoomCandidate,
  LoomReview,
  LoomTask,
  LoomVerification,
  WorkBundle,
  WorkControlFacts
} from './types'

/**
 * 成果浮层的数据层：纯函数 + 两个真实 Core 调用，不含 React、不含样式、不 import 任何旧界面组件。
 * 这里唯一的「事实来源」是预览回执与已记录的候选/评审/核验投影，不编正文、不编验收结论。
 */

/** RPC 端口：只要求 request，方便把 useThreadClient() 的返回直接传进来。 */
export type LoomRpc = Pick<ThreadClient, 'request'>

/** 一次预览的在途/结果状态；错误独立保留，可单条重试，不折算成「没有归档」。 */
export type ArtifactPreviewState =
  | { status: 'reading' }
  | { status: 'ready'; text: string }
  | { status: 'unavailable'; reason: 'too_large' | 'binary' | 'not_archived' }
  | { status: 'error'; message: string }

/** 文件名主标题：只取路径最后一段，不显示整条相对路径。 */
export function artifactFileName(relativePath: string): string {
  const name = relativePath.split(/[\\/]/u).filter(part => part !== '').pop() ?? relativePath
  return name === '' ? relativePath : name
}

/** 正文渲染方式：Markdown 走 ReactMarkdown，其余一律按纯文本进 pre。 */
export function artifactPreviewKind(relativePath: string): 'markdown' | 'text' {
  return /\.(md|markdown|mdx)$/iu.test(relativePath) ? 'markdown' : 'text'
}

/** 字节数只换单位，不回写、不取整成「看起来更整」的值。 */
export function artifactSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * 预览回执 → 界面状态。只认契约里的取值：形状不认识就是读失败，
 * 绝不把「读不到」伪装成 not_archived。
 */
export function previewStateFromResult(result: LoomArtifactPreviewResult): ArtifactPreviewState {
  const reason = result.unavailableReason
  if (reason === 'too_large' || reason === 'binary' || reason === 'not_archived') {
    return { status: 'unavailable', reason }
  }
  if (typeof result.text === 'string') return { status: 'ready', text: result.text }
  return { status: 'error', message: '预览没有返回正文' }
}

/** 真实预览调用：loom.artifact.preview。只读已归档文本，不写任何核验/验收状态。 */
export async function readArtifactPreview(
  rpc: LoomRpc,
  missionId: string,
  artifactId: string
): Promise<ArtifactPreviewState> {
  try {
    const result = await rpc.request<LoomArtifactPreviewResult>('loom.artifact.preview', {
      missionId,
      artifactId
    })
    return previewStateFromResult(result)
  } catch (error) {
    return { status: 'error', message: readErrorMessage(error, '读取正文失败') }
  }
}

/** 展示用：去掉正文开头的第一个 H1，浮层已经有自己的文档标题，不重复渲染两级标题。 */
export function stripLeadingHeading(text: string): string {
  const match = /^\s*#\s+.*(?:\r?\n|$)[ \t]*(?:\r?\n)?/u.exec(text)
  if (match === null) return text
  return text.slice(match[0].length)
}

/** 任务状态：枚举是英文标识，界面只显示翻译后的说法，data-state 保留原值。 */
export function taskStatusLabel(status: LoomTaskStatus): string {
  switch (status) {
    case 'draft': return '草稿'
    case 'ready': return '就绪'
    case 'blocked': return '阻塞'
    case 'in_review': return '待审'
    case 'done': return '已完成'
    case 'canceled': return '已取消'
    default: return status
  }
}

/** 核验/验收徽章文案；未知取值原样显示，不丢信息。 */
export function verificationLabel(state: LoomCandidate['verificationStatus']): string {
  return state === 'verified' ? '已核验' : state === 'failed' ? '核验失败' : '未核验'
}

export function acceptanceLabel(state: LoomCandidate['acceptanceStatus']): string {
  return state === 'accepted' ? '已验收' : state === 'rejected' ? '已驳回' : '待验收'
}

// ------------------------------------------------------ artifact review status (M7-C)

/**
 * 成果状态。判定顺序移植上游 `lib/factory/artifact-review.ts`
 * （终局 → 受阻 → 返工 → 等你的审查 → 还没交付），事实源换成 LOOM 契约：
 * 任务状态、候选不可变的验收状态、人工验收记录、控制投影里的阶段审查与派发。
 *
 * - `none`：还没有成果侧结论（卡片沿用任务状态本身）。
 * - `preparing`：准备中——候选已登记，归档成果还没出现。
 * - `ready`：已归档——有这份成果，但不是当前可验收的那一版（没有候选持有它，或它是历史版本）。
 * - `reviewing`：审查中——助手阶段审查还没交回结论，或控制事实还没读到。
 * - `fixing`：返工中——链头候选被要求返工/被人工退回，助手正在改。
 * - `review`：等你——审查结论已交回，等你的验收。
 * - `accepted`：已接受。
 * - `blocked`：受阻——任务阻塞（含 Core 只写在任务上的阻塞原因），
 *   或当前授权下的阶段审查结论就是阻塞。
 */
export type ArtifactReviewKind =
  | 'none'
  | 'preparing'
  | 'ready'
  | 'reviewing'
  | 'fixing'
  | 'review'
  | 'accepted'
  | 'blocked'

const ARTIFACT_REVIEW_LABEL: Record<ArtifactReviewKind, string> = {
  none: '',
  preparing: '准备中',
  ready: '已归档',
  reviewing: '审查中',
  fixing: '返工中',
  review: '等你',
  accepted: '已接受',
  blocked: '受阻'
}

/** 界面文案；`none` 没有话可说，调用方据此不渲染状态位。 */
export function artifactReviewLabel(kind: ArtifactReviewKind): string {
  return ARTIFACT_REVIEW_LABEL[kind]
}

/** 状态色调（上游 artifactReviewDot）：amber 等你、grey 在办、purple 已接受、red 受阻。 */
export function artifactReviewTone(kind: ArtifactReviewKind): 'warning' | 'neutral' | 'merged' | 'destructive' | null {
  if (kind === 'review') return 'warning'
  if (kind === 'reviewing' || kind === 'fixing') return 'neutral'
  if (kind === 'accepted') return 'merged'
  if (kind === 'blocked') return 'destructive'
  return null
}

/** 某候选上最新一条人工验收记录；按 reviewedAt，平手取数组靠后的一条（与阶段审查同规则）。 */
export function latestCandidateReview(reviews: readonly LoomReview[], candidateId: string): LoomReview | null {
  if (!Array.isArray(reviews)) return null
  const time = (review: LoomReview): number => {
    const value = Date.parse(review.reviewedAt)
    return Number.isNaN(value) ? -Infinity : value
  }
  return reviews
    .filter(review => review.candidateId === candidateId)
    .reduce<LoomReview | null>((latest, review) =>
      latest === null || time(review) >= time(latest) ? review : latest, null)
}

/** 只有 `waiting`/`dispatched` 才算还在办；settled/blocked/cancelled 都已有结局。 */
function dispatchInFlight(
  dispatches: readonly LoomDispatch[] | undefined,
  taskId: string | null,
  kind: LoomDispatch['kind'],
  candidateId: string | null
): boolean {
  if (taskId === null || !Array.isArray(dispatches)) return false
  return dispatches.some(dispatch => dispatch.taskId === taskId
    && dispatch.kind === kind
    && (dispatch.status === 'waiting' || dispatch.status === 'dispatched')
    && (dispatch.candidateId === null || candidateId === null || dispatch.candidateId === candidateId))
}

/** 控制事实只有 `observed` 才能用来下结论；未知一律不外推。 */
function observedControl(control: WorkControlFacts | undefined): (WorkControlFacts & { status: 'observed' })['snapshot'] | null {
  return control?.status === 'observed' ? control.snapshot : null
}

export type ArtifactReviewInput = {
  /** 这个任务已经有归档成果（候选的证据确实在归档里） */
  hasArtifact: boolean
  taskId: string | null
  taskStatus: LoomTaskStatus | null
  /**
   * 任务上的阻塞原因。Core 的派发预算耗尽、前置结果未知、审查者不可用只写这里，
   * 并不改任务状态——不读它就会把真的受阻说成在办。
   */
  blockedReason?: string | null
  /** 成果归属候选；没有候选引用这份证据时为 null */
  candidate: LoomCandidate | null
  /** 候选是否返工链链头；历史版本恒为 false */
  latest: boolean
  /** 这个任务的人工验收记录（按候选筛选最新一条） */
  reviews?: readonly LoomReview[]
  /** 控制／阶段审查事实；缺省＝尚未读取，不得外推 */
  control?: WorkControlFacts
}

/**
 * 成果状态：纯函数，只读真实投影。
 *
 * 关键约束（与 types.ts 的控制事实约定一致）：读不到控制事实时，候选的 `pending`
 * 绝不外推成「等你」——那时只能说「审查中」，因为助手审查的结论还没读到。
 */
export function artifactReviewKind(input: ArtifactReviewInput): ArtifactReviewKind {
  const { taskStatus, candidate, latest } = input
  const snapshot = observedControl(input.control)
  const candidateId = candidate?.candidateId ?? null
  const review = candidateId === null ? null : latestCandidateReview(input.reviews ?? [], candidateId)
  const stageReview = candidateId === null || snapshot === null
    ? null
    : loomStageReviewLatest(snapshot.stageReviews, candidateId)
  // 旧授权下的阶段审查结论已被新授权取代：只作历史，不当现在的判定。
  const stale = stageReview !== null && loomStageReviewFreshness(stageReview, snapshot?.policy ?? null) === 'stale'

  // 1. 任务阻塞是当下的真事实：卡片不因候选还在等验收就藏起来。任务状态是阻塞，或 Core
  //    只写了阻塞原因（派发/返工预算耗尽、前置结果未知、审查者不可用）都算受阻。
  if (taskStatus === 'blocked' || (input.blockedReason ?? '').trim() !== '') return 'blocked'
  // 2. 人工终判已经成立（接受是永久的，历史版本同样算已接受）。
  if (candidate !== null && (candidate.acceptanceStatus === 'accepted' || review?.verdict === 'accepted')) return 'accepted'
  // 3. 已取消的工作不再向人要验收。
  if (taskStatus === 'canceled') return 'none'
  // 4. 当前授权下的阶段审查判了阻塞：这也是受阻。
  if (stageReview !== null && !stale && stageReview.verdict === 'blocked') return 'blocked'
  // 5. 还没有归档成果：候选已登记就是「准备中」，否则沿用任务状态本身。
  if (!input.hasArtifact) return candidate !== null ? 'preparing' : 'none'
  // 6. 有成果但没有可验收的候选，或它是历史版本：已归档，不归当前工作。
  //    返工与审查只属于链头；旧版本不能被接受，也不该冒充正在返工。
  if (candidate === null || !latest) return 'ready'
  // 7. 返工中：人工退回、当前授权要求返工，或返工派发还在办。
  if (candidate !== null && (candidate.acceptanceStatus === 'rejected' || review?.verdict === 'rejected')) return 'fixing'
  if (stageReview !== null && !stale && stageReview.verdict === 'request_changes') return 'fixing'
  if (dispatchInFlight(snapshot?.dispatches, input.taskId, 'rework', candidateId)) return 'fixing'
  // 8. 助手审查还在办：不归你处理，也绝不说「等你」。
  if (dispatchInFlight(snapshot?.dispatches, input.taskId, 'review', candidateId)) return 'reviewing'
  // 9. 控制事实还没读到：pending 不外推成「等你」。
  if (snapshot === null) return 'reviewing'
  // 10. 当前授权指定了独立审查者，却还没交回当前授权下的结论：审查中。
  if (snapshot.policy !== null
    && snapshot.policy.taskIds.includes(input.taskId ?? '')
    && (stageReview === null || stale)) return 'reviewing'
  // 11. 审查结论已交回（通过），或这份工作没有机器审查：等你。
  return 'review'
}

/**
 * 浮层上下文里唯一的一份事实：绑定「拥有这份证据的那个候选」，不换成链头。
 * 看历史版本的正文时，候选仍是当初产出它的那一版，latest=false 因此关掉接受入口。
 */
export type ArtifactCandidateFacts = {
  /** 证据归属候选；没有候选引用这份产物时为 null */
  candidate: LoomCandidate | null
  task: LoomTask | null
  review: LoomReview | null
  verification: LoomVerification | null
  /** 该候选在返工链上的版本号；无候选为 null */
  version: number | null
  /** 是否链头。历史版本恒为 false */
  latest: boolean
  /** 可写入验收的唯一条件：链头 + 尚未有评审 */
  reviewable: boolean
  /** 逐条验收标准：一律取候选自己钉住的快照，不读计划现值 */
  criteria: readonly LoomAcceptanceCriterion[]
  criteriaVersion: string
  /** 成果状态（M7-C）：只描述位置，不接管可写入口 */
  reviewKind: ArtifactReviewKind
}

export function artifactCandidateFacts(
  bundle: WorkBundle,
  artifact: LoomArtifact,
  preferred: LoomCandidate | null
): ArtifactCandidateFacts {
  const owners = bundle.candidates.filter(candidate => candidate.evidenceIds.includes(artifact.artifactId))
  // 优先沿用调用方选中的候选（必须它自己也拥有这份证据），否则取最新的拥有者。
  // 两个分支都在「拥有该证据」的集合内，不跨证据换候选。
  const preferredOwner = preferred === null ? undefined : owners.find(entry => entry.candidateId === preferred.candidateId)
  const owner: LoomCandidate | null = preferredOwner !== undefined ? preferredOwner
    : owners.reduce<LoomCandidate | null>((newest, entry) => newest === null || newest.createdAt < entry.createdAt ? entry : newest, null)
  const versions = loomCandidateVersions(bundle.candidates)
  const latest = owner !== null && loomCandidateAcceptable(versions, owner.candidateId)
  const ownedTaskId = owner?.taskId ?? artifact.taskId
  const task = ownedTaskId === null
    ? null
    : bundle.tasks.find(entry => entry.taskId === ownedTaskId) ?? null
  const review = owner === null
    ? null
    : bundle.reviews.find(entry => entry.candidateId === owner.candidateId) ?? null
  const verification = owner === null
    ? null
    : bundle.verifications.find(entry => entry.candidateId === owner.candidateId) ?? null
  // 这份归档成果确实在这里：状态从真实投影推导，不另存一份。
  const reviewKind = artifactReviewKind({
    hasArtifact: true,
    taskId: ownedTaskId,
    taskStatus: task?.status ?? null,
    blockedReason: task?.blockedReason ?? null,
    candidate: owner,
    latest,
    reviews: bundle.reviews,
    control: bundle.control
  })
  return {
    candidate: owner,
    task,
    review,
    verification,
    version: owner === null
      ? null
      : versions.find(entry => entry.candidateId === owner.candidateId)?.version ?? 1,
    latest,
    reviewable: owner !== null && latest && review === null,
    criteria: owner?.acceptanceCriteria.criteria ?? [],
    criteriaVersion: owner?.acceptanceCriteria.version ?? '',
    reviewKind
  }
}

/** 版本标签：「v2 · 最新」；没有候选时为 null，界面不显示空标签。 */
export function artifactVersionLabel(facts: ArtifactCandidateFacts): string | null {
  if (facts.candidate === null) return null
  return `${loomVersionLabel(facts.version ?? 1)} · ${facts.latest ? '最新' : '历史版本'}`
}

/** 一次人工验收的在途表单：勾选集合按 criterionId 记，不依赖数组下标。 */
export type ArtifactReviewDraft = {
  candidateId: string
  verdict: 'accepted' | 'rejected'
  reason: string
  satisfied: readonly string[]
}

export function newReviewDraft(candidateId: string, verdict: 'accepted' | 'rejected'): ArtifactReviewDraft {
  return { candidateId, verdict, reason: '', satisfied: [] }
}

/**
 * 提交门槛：必须写明理由；接受还必须逐条勾满该候选快照里的每条标准。
 * 退回只要求理由，不勾标准也必须能提交——门槛不放宽也不加码。
 */
export function reviewDraftComplete(draft: ArtifactReviewDraft, facts: ArtifactCandidateFacts): boolean {
  if (draft.reason.trim() === '') return false
  if (draft.verdict === 'rejected') return true
  // 空快照时「覆盖每条标准」是空真：这与 Core 的判据一致，不在这里加更严的门槛。
  return facts.criteria.every(criterion => draft.satisfied.includes(criterion.criterionId))
}

/**
 * 提交门槛（prepare 与 submit 共用）：必须写明理由；接受还必须逐条勾满该候选快照里的每条标准。
 * 退回只要求理由。门槛不放宽也不加码。
 */
function reviewSubmissionGuard(facts: ArtifactCandidateFacts, draft: ArtifactReviewDraft): LoomCandidate {
  const candidate = facts.candidate
  if (candidate === null) throw new Error('没有可验收的候选')
  if (draft.candidateId !== candidate.candidateId) throw new Error('验收表单与候选不一致')
  if (!facts.reviewable || !facts.latest) throw new Error('这份成果现在不可验收，请刷新后重试')
  if (!reviewDraftComplete(draft, facts)) throw new Error('请填写理由并逐条确认验收标准')
  return candidate
}

/**
 * 真实写入：loom.review.record。reviewerId 由 Core 从可信身份注入，客户端不发；
 * 这里只发真实候选、该候选钉住的标准版本与逐条结论。
 *
 * @deprecated 无 attempt 的历史用法仅为兼容保留：它每次调用都生成新 commandId，
 * 回执丢失后无法幂等重试。生产写入只能走 prepareArtifactReviewAttempt + 显式
 * attempt 的 send 路径（冻结 payload + 同一 commandId 重试）；未确认 attempt
 * 未清理时不得重新组装提交。
 */
export async function submitArtifactReview(
  rpc: LoomRpc,
  missionId: string,
  facts: ArtifactCandidateFacts,
  draft: ArtifactReviewDraft,
  attempt?: ArtifactReviewAttempt
): Promise<LoomReviewRecordReceipt> {
  const candidate = reviewSubmissionGuard(facts, draft)
  if (attempt !== undefined) {
    if (attempt.missionId !== missionId) throw new Error('冻结的验收attempt属于另一个 Mission')
    if (attempt.candidateId !== candidate.candidateId) throw new Error('冻结的验收attempt指向另一个候选')
    if (draft.candidateId !== attempt.candidateId) throw new Error('验收表单与冻结attempt不一致')
    // 表单内容也必须与冻结 payload 逐字段一致：不一致时拒绝发送，
    // 不静默重发旧内容让用户误以为新理由已保存。
    if (draft.verdict !== attempt.payload.verdict
      || draft.reason.trim() !== attempt.payload.reason
      || attempt.payload.criteriaResults.some(row => row.satisfied !== draft.satisfied.includes(row.criterionId))) {
      throw new Error('验收表单与冻结attempt内容不一致；请取回原attempt，不能静默替换已冻结的理由')
    }
    const outcome = await sendArtifactReviewAttempt(rpc, attempt)
    if (outcome.state === 'completed') {
      discardUnconfirmedReviewAttempt(rpc, attempt, 'confirmed_receipt')
      return outcome.receipt
    }
    if (outcome.state === 'rejected') {
      discardUnconfirmedReviewAttempt(rpc, attempt, 'confirmed_rejection')
      throw new Error(`验收提交被拒绝（${outcome.code}）：${outcome.message}`)
    }
    // 通信未知：attempt 必须留在内存仓里，二次打开取回后重发同一 commandId，不换包。
    throw new Error(outcome.message)
  }
  return rpc.request<LoomReviewRecordReceipt>('loom.review.record', {
    missionId,
    taskId: candidate.taskId,
    candidateId: candidate.candidateId,
    commandId: crypto.randomUUID(),
    acceptanceCriteriaVersion: facts.criteriaVersion,
    verdict: draft.verdict,
    reason: draft.reason.trim(),
    criteriaResults: facts.criteria.map(criterion => ({
      criterionId: criterion.criterionId,
      satisfied: draft.satisfied.includes(criterion.criterionId),
      evidenceIds: [],
      note: null
    }))
  })
}

// ------------------------------------------------------- idempotent review attempt

/** 一次冻结的验收提交：commandId 与完整 payload 组装后不可变，重试只重发同一份。 */
export type ArtifactReviewAttempt = {
  readonly commandId: string
  readonly missionId: string
  readonly candidateId: string
  readonly taskId: string
  /** 冻结自 facts.task?.planId；无 task 时为 null（回执只能按非空形状弱验）。 */
  readonly planId: string | null
  /** 冻结的完整 loom.review.record 载荷；reviewerId 由 Core 注入，客户端从不发送。 */
  readonly payload: LoomReviewRecordInput
}

/** 递归冻结：包括嵌套数组（criteriaResults 行、evidenceIds）在内不留任何可变入口。 */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(entry => deepFreeze(entry))
    return Object.freeze(value) as T
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry)
    return Object.freeze(value as T)
  }
  return value
}

/**
 * 组装并冻结一次验收提交：门槛与旧 submit 完全一致，commandId 只在这里生成一次。
 * 返回的 attempt 深度冻结——重试路径没有任何改 payload 或换 commandId 的入口。
 * 不写任何 registry、不发请求；发送交给 sendArtifactReviewAttempt。
 */
export function prepareArtifactReviewAttempt(
  missionId: string,
  facts: ArtifactCandidateFacts,
  draft: ArtifactReviewDraft
): ArtifactReviewAttempt {
  const candidate = reviewSubmissionGuard(facts, draft)
  const payload: LoomReviewRecordInput = {
    missionId,
    taskId: candidate.taskId,
    candidateId: candidate.candidateId,
    commandId: crypto.randomUUID(),
    acceptanceCriteriaVersion: facts.criteriaVersion,
    verdict: draft.verdict,
    reason: draft.reason.trim(),
    criteriaResults: facts.criteria.map(criterion => ({
      criterionId: criterion.criterionId,
      satisfied: draft.satisfied.includes(criterion.criterionId),
      evidenceIds: [],
      note: null
    }))
  }
  return Object.freeze({
    commandId: payload.commandId,
    missionId,
    candidateId: payload.candidateId,
    taskId: payload.taskId,
    planId: facts.task?.planId ?? null,
    payload: deepFreeze({ ...payload }) as LoomReviewRecordInput
  })
}

export type ArtifactReviewSendOutcome =
  | { state: 'completed'; receipt: LoomReviewRecordReceipt }
  | { state: 'rejected'; code: string; message: string }
  | { state: 'unknown'; message: string }

const LOOM_TASK_STATUSES = ['draft', 'ready', 'blocked', 'in_review', 'done', 'canceled'] as const

/** 真合同枚举守卫：全部字面量命中才算合法 taskStatus，不靠 as 强转未知值。 */
function isLoomTaskStatus(value: unknown): value is (typeof LOOM_TASK_STATUSES)[number] {
  return (LOOM_TASK_STATUSES as readonly unknown[]).includes(value)
}

/**
 * 与冻结 payload 的 criteriaResults 精确匹配：同长度、同序，每行 criterionId/satisfied/note/
 * evidenceIds 逐一相等（evidenceIds 也同序同内容且每个元素都验过是字符串）。
 */
function criteriaResultsMatchPayload(
  value: unknown,
  attempt: ArtifactReviewAttempt
): boolean {
  if (!Array.isArray(value) || value.length !== attempt.payload.criteriaResults.length) return false
  return attempt.payload.criteriaResults.every((row, index) => {
    const other = value[index] as Record<string, unknown> | undefined
    if (!other || typeof other !== 'object') return false
    if (other.criterionId !== row.criterionId) return false
    if (other.satisfied !== row.satisfied) return false
    if (other.note !== row.note) return false
    const otherEvidence: unknown = other.evidenceIds
    if (!Array.isArray(otherEvidence) || otherEvidence.length !== row.evidenceIds.length) return false
    return row.evidenceIds.every((id, i) => {
      const evidence: unknown = otherEvidence[i]
      return typeof evidence === 'string' && evidence === id
    })
  })
}

/**
 * 完整回执校验：形状 + 身份 + 与冻结 payload 的一致性 + Core 实际回执语义。
 * 真合同（packages/contracts/src/loom.ts:148-165, 341-369）：review 携带
 * acceptanceCriteriaVersion/criteriaResults/reviewerId/reviewedAt；非 replay 的回执里
 * accepted 应 task done/candidate accepted，rejected 应 task ready/candidate rejected，
 * pending 永远不能算 completed；replayed 回执的 taskStatus 是 Core 读到的当前状态
 * （loom.rs 重放分支），允许合法枚举内任意值；reviewerId 只验非空字符串，不硬编码身份。
 * 身份不符/形状不认识/与冻结 payload 不一致一律 unknown。
 */
function validatedReviewReceipt(value: unknown, attempt: ArtifactReviewAttempt): LoomReviewRecordReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const review = row.review
  if (!review || typeof review !== 'object' || Array.isArray(review)) return null
  const reviewRow = review as Record<string, unknown>
  if (row.missionId !== attempt.missionId) return null
  // planId：attempt 冻结了 facts.task?.planId 时强证；无 task 时只验非空形状。
  const planId = typeof row.planId === 'string' && row.planId !== '' ? row.planId : null
  if (planId === null) return null
  if (attempt.planId !== null && planId !== attempt.planId) return null
  if (row.taskId !== attempt.taskId) return null
  const reviewId = reviewRow.reviewId
  if (typeof reviewId !== 'string' || reviewId === '') return null
  if (reviewRow.candidateId !== attempt.candidateId) return null
  if (reviewRow.verdict !== attempt.payload.verdict) return null
  if (reviewRow.reason !== attempt.payload.reason) return null
  if (reviewRow.acceptanceCriteriaVersion !== attempt.payload.acceptanceCriteriaVersion) return null
  if (!criteriaResultsMatchPayload(reviewRow.criteriaResults, attempt)) return null
  const reviewerId = reviewRow.reviewerId
  if (typeof reviewerId !== 'string' || reviewerId === '') return null
  const reviewedAt = reviewRow.reviewedAt
  if (typeof reviewedAt !== 'string' || reviewedAt === '') return null
  const taskStatus = row.taskStatus
  if (!isLoomTaskStatus(taskStatus)) return null
  const verdict = attempt.payload.verdict
  const expectedAcceptance = verdict === 'accepted' ? 'accepted' : 'rejected'
  const acceptanceStatus = row.candidateAcceptanceStatus
  // pending 不能算 completed：候选验收状态必须与 verdict 一致（重放也成立：候选
  // 不可变，其 acceptance_status 永远等于它那份评审的 verdict）。
  if (acceptanceStatus !== 'accepted' && acceptanceStatus !== 'rejected') return null
  if (acceptanceStatus !== expectedAcceptance) return null
  const releasedDependencyIds = row.releasedDependencyIds
  if (!Array.isArray(releasedDependencyIds)) return null
  const releasedIds: string[] = []
  for (const entry of releasedDependencyIds) {
    // 每一项都必须是非空字符串；任何形状未知条目让整份回执不可信。
    if (typeof entry !== 'string' || entry === '') return null
    releasedIds.push(entry)
  }
  const replayed = row.replayed
  if (typeof replayed !== 'boolean') return null
  // 非 replay：task 状态必须被 verdict 推进到位；replay：taskStatus 是 Core 读到的
  // 当前状态快照（loom.rs 重放分支），允许合法枚举内任意值。
  if (replayed !== true && taskStatus !== (verdict === 'accepted' ? 'done' : 'ready')) return null
  // 每个字段都验过之后才组装回执，不靠 as 强转掩盖漏验字段。
  return {
    review: {
      reviewId,
      candidateId: attempt.candidateId,
      acceptanceCriteriaVersion: attempt.payload.acceptanceCriteriaVersion,
      verdict: attempt.payload.verdict,
      reason: attempt.payload.reason,
      criteriaResults: attempt.payload.criteriaResults,
      reviewerId,
      reviewedAt
    },
    missionId: attempt.missionId,
    planId,
    taskId: attempt.taskId,
    taskStatus,
    candidateAcceptanceStatus: acceptanceStatus,
    releasedDependencyIds: releasedIds,
    replayed
  }
}

/** 只有错误对象自带精确 kind==='domain_rejection' 与非空 code 才算已证实的拒绝。 */
function structuredRejectionCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null
  const kind = (error as { kind?: unknown }).kind
  const code = (error as { code?: unknown }).code
  return kind === 'domain_rejection' && typeof code === 'string' && code !== '' ? code : null
}

/**
 * 严格以 attempt 的冻结 payload 发送：同一 commandId、同一份字段，不生成新 ID、
 * 不改 reviewerId、不发任何自制 API（没有 commands.getResult 这类东西，本模块也不造）。
 * 发送前原子登记 attempt 并标记 sending（UI 侧 remember 是幂等 no-op）；同 attempt
 * 的并发 send 共用同一个在途 Promise（返回的就是同一条 record.inFlight）。
 * rpc.request 同步 throw 也安全：执行体在 microtask 中执行，inFlight 先登记、
 * 落定清理必挂上，同步 throw 走统一 catch 记 unknown，显式 retry 可真再发。
 * completed 仅当 Core 回了形状、身份与冻结 payload 都一致的真实回执；已证实的结构化拒绝是 rejected；其余（网络、超时、回执形状不认识、
 * 身份不符）一律 unknown——未知不是成功，落定后状态留在 unknown，调用方不得据此改
 * payload 或另起 command，只能取回原 attempt 同包重试或等待明确结局。
 */
export function sendArtifactReviewAttempt(
  rpc: LoomRpc,
  attempt: ArtifactReviewAttempt
): Promise<ArtifactReviewSendOutcome> {
  const store = attemptStore(rpc)
  const key = attemptStoreKey(attempt.missionId, attempt.candidateId)
  const existing = store.get(key)
  // 同 scope 已有另一个 attempt：不能覆盖，也不能并行发送（旧attempt不能换成新包）。
  if (existing !== undefined && existing.attempt !== attempt) {
    return Promise.reject(new Error('该候选已有另一个未确认的验收attempt，不能覆盖或并行发送'))
  }
  // 同 attempt 的并发 send 共用同一个在途 Promise；发送前原子登记并标记发送。
  if (existing !== undefined && existing.inFlight !== null) return existing.inFlight
  const record: AttemptRecord = existing ?? { attempt, state: 'not_sent', inFlight: null }
  if (existing === undefined) store.set(key, record)
  record.state = 'sending'
  // 执行体放进 microtask：rpc.request 同步 throw 时 inFlight 已先登记、落定清理必挂上。
  const flight = Promise.resolve().then(async (): Promise<ArtifactReviewSendOutcome> => {
    let raw: unknown
    try {
      raw = await rpc.request('loom.review.record', { ...attempt.payload })
    } catch (error) {
      const code = structuredRejectionCode(error)
      if (code !== null) {
        record.state = 'rejected'
        return { state: 'rejected', code, message: readErrorMessage(error, '验收提交被拒绝') }
      }
      record.state = 'unknown'
      return { state: 'unknown', message: readErrorMessage(error, '验收提交结果未知') }
    }
    const receipt = validatedReviewReceipt(raw, attempt)
    if (receipt === null) {
      record.state = 'unknown'
      return { state: 'unknown', message: '验收回执形状、身份或与冻结 payload 不一致，结果未知' }
    }
    record.state = 'completed'
    return { state: 'completed', receipt }
  })
  record.inFlight = flight
  // 落定后清出在途句柄，之后的 unknown 同包重试才能重新发送。
  void flight.then(() => { if (record.inFlight === flight) record.inFlight = null },
    () => { if (record.inFlight === flight) record.inFlight = null })
  return flight
}

// ------------------------------------------------- unconfirmed attempt memory store

/** attempt 的真实生命周期：由 send 内部推进，调用方不可伪造。 */
export type AttemptLifecycle = 'not_sent' | 'sending' | 'unknown' | 'completed' | 'rejected'

type AttemptRecord = {
  attempt: ArtifactReviewAttempt
  state: AttemptLifecycle
  /** 非空表示有一个在途 send，所有并发调用共用同一个 Promise。 */
  inFlight: Promise<ArtifactReviewSendOutcome> | null
}

/**
 * 未确认 attempt 的内存仓：按 rpc 对象分桶（WeakMap，通道被回收时桶随之消失），
 * 桶内按 missionId+candidateId 各保留一条（含生命周期）。不落盘、不跨会话、
 * 没有全局 registry，也没有超时放弃——只有拿到真实回执、收到精确结构化拒绝、
 * 或该 attempt 确实从未发送时才允许显式清理。
 */
const unconfirmedReviewAttempts = new WeakMap<object, Map<string, AttemptRecord>>()

function attemptStoreKey(missionId: string, candidateId: string): string {
  return `${missionId}\u0000${candidateId}`
}

function attemptStore(rpc: LoomRpc): Map<string, AttemptRecord> {
  let store = unconfirmedReviewAttempts.get(rpc)
  if (store === undefined) {
    store = new Map()
    unconfirmedReviewAttempts.set(rpc, store)
  }
  return store
}

/** 登记一条未确认 attempt；重复登记同一对象是幂等 no-op，不同对象拒绝覆盖。 */
export function rememberUnconfirmedReviewAttempt(rpc: LoomRpc, attempt: ArtifactReviewAttempt): void {
  const store = attemptStore(rpc)
  const key = attemptStoreKey(attempt.missionId, attempt.candidateId)
  const existing = store.get(key)
  if (existing !== undefined) {
    if (existing.attempt !== attempt) {
      throw new Error('该候选已有未确认的验收提交，不能覆盖；请先取回原 attempt 或明确清理')
    }
    return
  }
  store.set(key, { attempt, state: 'not_sent', inFlight: null })
}

/** 二次打开同一候选时取回原 attempt（冻结 payload 原样）；没有未确认记录则 null。 */
export function recallUnconfirmedReviewAttempt(
  rpc: LoomRpc,
  missionId: string,
  candidateId: string
): ArtifactReviewAttempt | null {
  return attemptStore(rpc).get(attemptStoreKey(missionId, candidateId))?.attempt ?? null
}

/** 只读查询内部生命周期；调用方不能写。没有记录/对象不符则 null。 */
export function unconfirmedAttemptLifecycle(
  rpc: LoomRpc,
  attempt: ArtifactReviewAttempt
): AttemptLifecycle | null {
  const record = attemptStore(rpc).get(attemptStoreKey(attempt.missionId, attempt.candidateId))
  return record !== undefined && record.attempt === attempt ? record.state : null
}

/** 明确的清理理由；不存在超时/放弃式入口。 */
export type UnconfirmedAttemptDiscardReason = 'confirmed_receipt' | 'confirmed_rejection' | 'never_sent'

const DISCARD_ALLOWED_STATES: Record<UnconfirmedAttemptDiscardReason, AttemptLifecycle> = {
  confirmed_receipt: 'completed',
  confirmed_rejection: 'rejected',
  never_sent: 'not_sent'
}

/**
 * 只对已确定结局的 attempt 清理：真实回执（completed）、精确结构化拒绝（rejected）、
 * 或确实从未发送（not_sent）。理由必须与 send 内部维护的真实状态相符，且必须是同一个
 * attempt 对象——旧 attempt 删不掉同 scope 的新 attempt，通信未知（unknown/sending）
 * 时无论传什么理由都不会被清理。
 */
export function discardUnconfirmedReviewAttempt(
  rpc: LoomRpc,
  attempt: ArtifactReviewAttempt,
  reason: UnconfirmedAttemptDiscardReason
): boolean {
  const store = attemptStore(rpc)
  const record = store.get(attemptStoreKey(attempt.missionId, attempt.candidateId))
  if (record === undefined || record.attempt !== attempt) return false
  if (record.state !== DISCARD_ALLOWED_STATES[reason]) return false
  return store.delete(attemptStoreKey(attempt.missionId, attempt.candidateId))
}

// ------------------------------------------------------------ selection refresh

/** 一次选择刷新的结果：contextAvailable=false 表示旧上下文不可再信（缺失/身份变化）。 */
export type ArtifactSelectionRefresh = {
  selection: ArtifactSelection
  contextAvailable: boolean
}

/**
 * 用最新 bundles 刷新打开着的成果 selection：严格同 missionId + artifactId + sha256，
 * 候选按原 candidateId 取回并验证它仍拥有这份证据。任何缺失或身份变化都不自动跳到
 * 另一个候选：保留原只读 selection 并把 contextAvailable 置 false，禁写与状态提示由 UI 负责。
 */
export function refreshArtifactSelection(
  selection: ArtifactSelection,
  bundles: readonly WorkBundle[]
): ArtifactSelectionRefresh {
  const { artifact, candidate, bundle } = selection
  const freshBundle = bundles.find(
    entry => entry.mission.missionId === bundle.mission.missionId
  )
  if (freshBundle === undefined) return { selection, contextAvailable: false }
  // 产物严格同 artifactId + sha256，且 task/run 归属都不变：归属变了就是另一份事实。
  const freshArtifact = freshBundle.artifacts.find(entry =>
    entry.artifactId === artifact.artifactId
    && entry.sha256 === artifact.sha256
    && entry.taskId === artifact.taskId
    && entry.agentRunId === artifact.agentRunId
  )
  if (freshArtifact === undefined) return { selection, contextAvailable: false }
  if (candidate === null) {
    return {
      selection: { artifact: freshArtifact, candidate: null, bundle: freshBundle },
      contextAvailable: true
    }
  }
  // 候选是 immutable 行：同 candidateId 但 contentHash/taskId/钉住的验收标准快照变化
  // 视为身份变化，拒绝静默更新；证据归属也必须仍然成立。
  const freshCandidate = freshBundle.candidates.find(entry =>
    entry.candidateId === candidate.candidateId
    && entry.contentHash === candidate.contentHash
    && entry.taskId === candidate.taskId
    && sameAcceptanceCriteria(entry.acceptanceCriteria, candidate.acceptanceCriteria)
    && entry.evidenceIds.includes(freshArtifact.artifactId)
  )
  if (freshCandidate === undefined) return { selection, contextAvailable: false }
  return {
    selection: { artifact: freshArtifact, candidate: freshCandidate, bundle: freshBundle },
    contextAvailable: true
  }
}

/** 验收标准快照的精确相等：同 version、同序、每条 criterionId/text 相同。 */
function sameAcceptanceCriteria(
  a: LoomCandidate['acceptanceCriteria'],
  b: LoomCandidate['acceptanceCriteria']
): boolean {
  if (a.version !== b.version || a.criteria.length !== b.criteria.length) return false
  return a.criteria.every((criterion, index) =>
    criterion.criterionId === b.criteria[index].criterionId
    && criterion.text === b.criteria[index].text
  )
}

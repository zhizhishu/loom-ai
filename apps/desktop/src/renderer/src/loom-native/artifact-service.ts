import type {
  LoomAcceptanceCriterion,
  LoomArtifactPreviewResult,
  LoomReviewRecordReceipt,
  LoomTaskStatus
} from '@contracts'
// 只借类型：ThreadClient 是已认证的 Core 通道，这里不发任何自制 RPC。
import type { ThreadClient } from '../camp-client'
import { readErrorMessage } from '../error-message'
import { loomCandidateAcceptable, loomCandidateVersions, loomVersionLabel } from '../loom-control-model'
import type { LoomArtifact, LoomCandidate, LoomReview, LoomTask, LoomVerification, WorkBundle } from './types'

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
    criteriaVersion: owner?.acceptanceCriteria.version ?? ''
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
 * 真实写入：loom.review.record。reviewerId 由 Core 从可信身份注入，客户端不发；
 * 这里只发真实候选、该候选钉住的标准版本与逐条结论。
 */
export async function submitArtifactReview(
  rpc: LoomRpc,
  missionId: string,
  facts: ArtifactCandidateFacts,
  draft: ArtifactReviewDraft
): Promise<LoomReviewRecordReceipt> {
  const candidate = facts.candidate
  if (candidate === null) throw new Error('没有可验收的候选')
  if (draft.candidateId !== candidate.candidateId) throw new Error('验收表单与候选不一致')
  if (!facts.reviewable || !facts.latest) throw new Error('这份成果现在不可验收，请刷新后重试')
  if (!reviewDraftComplete(draft, facts)) throw new Error('请填写理由并逐条确认验收标准')
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

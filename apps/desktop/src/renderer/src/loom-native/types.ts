import type {
  AgentProfile,
  LoomArtifact,
  LoomCandidate,
  LoomControlSnapshot,
  LoomPlan,
  LoomReview,
  LoomStageReview,
  LoomTask,
  LoomVerification,
  MissionRecord,
  ThreadSnapshot
} from '@contracts'
export type {
  AgentProfile,
  LoomArtifact,
  LoomCandidate,
  LoomControlSnapshot,
  LoomPlan,
  LoomReview,
  LoomStageReview,
  LoomTask,
  LoomVerification,
  MissionRecord,
  ThreadSnapshot
}
/** 侧栏一行。`pinned` / `pinOrder` 是 Mikka 侧栏已有的两级（`bot-list.tsx:46-52`）；
 * LOOM 的 Core 导航投影还没下发这两个事实，缺省即「没置顶」，排序退化成
 * 时间 → 名字。等 Core 带上这两列时，前端排序不用再改。 */
export type ConversationItem = { id: string; title: string; subtitle: string; agentId: string | null; threadId: string | null; missionId: string | null; unread: boolean; updatedAt: string | null; pinned?: boolean; pinOrder?: number | null }
export type WorkItem = { task: LoomTask; mission: MissionRecord; candidate: LoomCandidate | null }

/**
 * 控制投影为什么还是未知的。每一种都只表示「还没读到事实」：
 * 不是「没有批准」，不是「没有审查回执」，更不是「在等你」。
 *
 * - `not_read`：这份 Bundle 没读过控制投影（缺省字段，不是空结论）。
 * - `read_failed`：请求本身失败（传输层或 Host 错误）。
 * - `invalid`：回执不是本 Mission 的完整快照（错 Mission、缺阶段审查回执等）。
 */
export type WorkControlUnknownReason = 'not_read' | 'read_failed' | 'invalid'

/** 「还没读到」的唯一形状；控制与阶段审查两种事实共用它。 */
export type WorkControlUnknown = { status: 'unknown'; reason: WorkControlUnknownReason; message: string }

/**
 * 一次控制／阶段审查事实（对应 Core 的 `loom.control.get` 投影，即
 * `LoomControlSnapshot`：策略 + 阶段审查 + 投递）。
 *
 * 只有 `observed` 才能下任何结论。`unknown` 一律不外推——尤其不得把
 * 候选的 `pending` 验收状态读成「等你」。
 */
export type WorkControlFacts =
  | { status: 'observed'; snapshot: LoomControlSnapshot }
  | WorkControlUnknown

/** 阶段审查回执集合：与控制事实同一判定，读不到就是 unknown，不是空列表。 */
export type WorkStageReviewFacts =
  | { status: 'observed'; stageReviews: readonly LoomStageReview[] }
  | WorkControlUnknown

export type WorkBundle = {
  mission: MissionRecord
  plan: LoomPlan | null
  tasks: LoomTask[]
  candidates: LoomCandidate[]
  artifacts: LoomArtifact[]
  reviews: LoomReview[]
  verifications: LoomVerification[]
  /**
   * 缺省表示「尚未读取」，不是「没有策略」。右栏取它时走 `workControl(bundle)`
   * 归一成不带歧义的 unknown。
   */
  control?: WorkControlFacts
}
export type ArtifactSelection = { artifact: LoomArtifact; candidate: LoomCandidate | null; bundle: WorkBundle }
export type InspectorTab = 'work' | 'details' | 'capabilities' | 'assets' | 'computer'

export type InspectorMode = 'work' | 'profile' | 'assets' | 'map' | 'computer'

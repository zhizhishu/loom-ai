import type {
  AgentProfile,
  CoreMethod,
  LoomControlPauseInput,
  LoomControlPolicy,
  LoomControlPolicyInput,
  LoomControlSnapshot,
  LoomTask,
  ThreadSnapshot
} from '@contracts'
import { readErrorMessage } from '../error-message'
import {
  loomControlInput,
  loomControlProblems,
  loomControlSnapshotProblem,
  loomControlState,
  type LoomControlDraft,
  type LoomControlProblem,
  type LoomControlState
} from '../loom-control-model'

/**
 * LOOM 自动接力的写入口（UI 侧唯一一处）。
 *
 * 复用 production 契约（`@contracts` 的 `LoomControl*`）与 `loom-control-model` 的纯派生，
 * 这里不另造 wire schema、不缓存第二份策略状态、不新写调度器：派发、预算与阶段审查的判定
 * 全在 Core 的 control plane。
 *
 * 五条纪律：
 * 1. 读不到不等于未批准：`loom.control.get` 失败或回执不完整只报「读不到」，绝不落成
 *    「尚未批准」——那会把缺失当成结论。
 * 2. 查询必须命中当前 Mission：回执的 `missionId` 与请求不一致按失败处理，不映射别家快照。
 * 3. 结果未知保留原身份：同一次意图只用同一个 `commandId` + 同一份 payload 重发核对，
 *    绝不自动换 ID；只有 Core 源码已证实的「写入前拒绝」码才算确定没有写入。
 * 4. 独立审查者必须取自**当前 Thread 的活跃成员**，并排除该任务执行者本人；
 *    读不到成员就空着并禁止提交，Core 仍然终裁。
 * 5. 暂停只挡住后续派发：这里不停止正在运行的任务，也不接受任何候选成果。
 */

/** 唯一依赖的 Host 面：已认证的 Core 请求通道。 */
export interface ControlPort {
  request<T>(method: CoreMethod, params?: unknown): Promise<T>
}

export const LOOM_CONTROL_GET = 'loom.control.get' as const
export const LOOM_CONTROL_CONFIGURE = 'loom.control.configure' as const
export const LOOM_CONTROL_PAUSE = 'loom.control.pause' as const

/**
 * Core 源码已证实的「拒绝发生在写入之前」的码（`crates/rovai-core/src/loom/control.rs`）：
 * configure 的 Owner/任务/审查者/预算/到期/CAS/命令复用校验，以及 pause 的 Owner/策略/CAS 校验。
 * 只有这些码能证明这次命令没有被写入；其它（包括传输层或 Host 合成的 outcome-unknown 之类）
 * 一律按 unknown 处理并保留同一个 attempt。
 */
export const CONTROL_NO_WRITE_CODES: readonly string[] = [
  // configure + pause 共用
  'LOOM_CONTROL_NOT_AUTHORIZED',
  'LOOM_CONTROL_REVISION_CONFLICT',
  'LOOM_CONTROL_COMMAND_REUSED',
  'LOOM_MISSION_NOT_FOUND',
  'LOOM_PLAN_NOT_FOUND',
  'LOOM_INVALID_INPUT',
  // 仅 configure
  'LOOM_CONTROL_TASK_INVALID',
  'LOOM_CONTROL_REVIEWER_INVALID',
  'LOOM_CONTROL_REVIEWER_SELF',
  'LOOM_CONTROL_EXPIRES_INVALID',
  // 仅 pause
  'LOOM_CONTROL_POLICY_NOT_FOUND'
]

export function isNoWriteRejection(code: string | null): code is string {
  return code !== null && CONTROL_NO_WRITE_CODES.includes(code)
}

const message = (text: string): string => text

/** 一次控制投影读取：observed 才代表真的读到了完整快照。 */
export type ControlRead =
  | { status: 'observed'; snapshot: LoomControlSnapshot }
  | { status: 'failed'; message: string }

/**
 * 一次写入意图。`input` 就是发出去的 payload 原文：重试时原样复用，
 * 因此「核对」既不会换 `commandId`，也不会悄悄改预算或范围。
 */
export type ControlAttempt =
  | { kind: 'configure'; missionId: string; commandId: string; input: LoomControlPolicyInput }
  | { kind: 'pause'; missionId: string; commandId: string; input: LoomControlPauseInput }

/** 一次写入的结局；`unknown` 必须保留 attempt，`rejected` 才允许开始新的意图。 */
export type ControlWrite =
  | { status: 'applied'; snapshot: LoomControlSnapshot }
  | { status: 'rejected'; code: string; message: string }
  | { status: 'unknown'; message: string }

// ------------------------------------------------------------------ reading

export function classifyControlSnapshot(raw: unknown, missionId: string): ControlRead {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'failed', message: message('控制策略回执无法识别，接力状态尚未确认。') }
  }
  const snapshot = raw as LoomControlSnapshot
  // 别家 Mission 的快照不是这个 Mission 的答案：宁可说读不到。
  if (snapshot.missionId !== missionId) {
    return { status: 'failed', message: message('读到的控制策略属于另一项工作，未按当前工作展示。') }
  }
  const problem = loomControlSnapshotProblem(snapshot)
  if (problem !== null) {
    return { status: 'failed', message: message(`控制快照缺少必需字段：${problem}，接力状态尚未确认。`) }
  }
  return { status: 'observed', snapshot }
}

/** 读当前 Mission 的控制投影。`missionId` 为空时一个请求都不发。 */
export async function readControl(port: ControlPort, missionId: string): Promise<ControlRead> {
  const mission = missionId.trim()
  if (mission === '') {
    return { status: 'failed', message: message('缺少工作标识，无法读取接力状态。') }
  }
  let raw: unknown
  try {
    raw = await port.request<unknown>(LOOM_CONTROL_GET, { missionId: mission })
  } catch (error) {
    return {
      status: 'failed',
      message: readErrorMessage(error, message('接力状态读取失败，尚未确认是否已批准。'))
    }
  }
  return classifyControlSnapshot(raw, mission)
}

/** 读取态 → 控制态：null 是「还在读」，失败是「读不到」，都不是「未批准」。 */
export function controlState(read: ControlRead | null): LoomControlState {
  if (read === null) return 'reading'
  if (read.status === 'failed') return 'unreadable'
  return loomControlState(read.snapshot, '')
}

/** 只有真的读到完整快照才可写：reading / unreadable 一律不可写。 */
export function controlWritable(state: LoomControlState): boolean {
  return state !== 'reading' && state !== 'unreadable'
}

/** 暂停/继续的门槛：可写、已有策略、且没有被停用或已过期（过期不能靠「继续」复活）。 */
export function controlPauseAllowed(state: LoomControlState, policy: LoomControlPolicy | null): boolean {
  if (!controlWritable(state) || policy === null) return false
  return state !== 'expired' && state !== 'disabled'
}

// -------------------------------------------------- thread membership scope

/**
 * 独立审查者的可选范围：只认**当前 Thread 的真实活跃成员**。
 * Thread 缺失、Thread 与 Mission 不匹配、成员投影不可读，一律 unknown —— 这时不推举任何人。
 */
export type ReviewerScope =
  | { status: 'known'; threadId: string; memberAgentIds: ReadonlySet<string> }
  | { status: 'unknown'; reason: 'thread_missing' | 'thread_mismatch' | 'members_unreadable' }

export function reviewerScope(thread: ThreadSnapshot | null, missionThreadId: string): ReviewerScope {
  if (thread === null || typeof thread.thread?.id !== 'string' || thread.thread.id === '') {
    return { status: 'unknown', reason: 'thread_missing' }
  }
  if (thread.thread.id !== missionThreadId) return { status: 'unknown', reason: 'thread_mismatch' }
  const members = thread.members
  if (!Array.isArray(members)) return { status: 'unknown', reason: 'members_unreadable' }
  const memberAgentIds = new Set<string>()
  for (const member of members) {
    if (!member || typeof member.agentId !== 'string' || member.agentId === '') continue
    // 已离队或已移除的成员不是候选审查者。
    if (member.membershipStatus !== 'active') continue
    if (member.profilePresence === 'removed') continue
    memberAgentIds.add(member.agentId)
  }
  return { status: 'known', threadId: thread.thread.id, memberAgentIds }
}

export type ControlPanelProblem =
  | LoomControlProblem
  | 'reviewer_self'
  | 'reviewer_not_member'
  | 'reviewer_membership_unknown'
  | 'task_unknown'

/** 仍然是成员：已移除或 presence=removed 的助手不能被指派为独立审查者。 */
export function activeAgents(agents: readonly AgentProfile[]): AgentProfile[] {
  return agents.filter(agent => agent.removedAt === null && agent.presence !== 'removed')
}

/**
 * 独立审查者的候选：当前 Thread 活跃成员 ∩ 仍存在的助手档案，再排除该任务的执行者本人
 * （自证不是独立复核）。成员范围未知时返回空列表。
 */
export function reviewerChoices(
  agents: readonly AgentProfile[],
  scope: ReviewerScope,
  assigneeAgentId: string | null
): AgentProfile[] {
  if (scope.status !== 'known') return []
  return activeAgents(agents).filter(agent =>
    scope.memberAgentIds.has(agent.agentId) && agent.agentId !== assigneeAgentId)
}

/**
 * 批准前的完整缺口清单：先用 `loomControlModel` 的纯判定（真实预算/范围/到期），
 * 再补本界面必须自己守的规则——成员范围必须可读，审查者不能是执行者本人，
 * 且必须仍是当前 Thread 的活跃成员。
 */
export function controlPanelProblems(
  draft: LoomControlDraft,
  tasks: readonly LoomTask[],
  agents: readonly AgentProfile[],
  scope: ReviewerScope
): ControlPanelProblem[] {
  const problems: ControlPanelProblem[] = [...loomControlProblems(draft)]
  const taskById = new Map(tasks.map(task => [task.taskId, task] as const))
  const existingAgents = new Set(activeAgents(agents).map(agent => agent.agentId))
  if (scope.status !== 'known' && draft.taskIds.length > 0) problems.push('reviewer_membership_unknown')
  for (const taskId of draft.taskIds) {
    const task = taskById.get(taskId)
    if (task === undefined) {
      problems.push('task_unknown')
      continue
    }
    const reviewer = (draft.reviewers[taskId] ?? '').trim()
    // 空的审查者已经由 missing_reviewer 表达，不再重复报。
    if (reviewer === '') continue
    if (reviewer === task.assigneeAgentId) problems.push('reviewer_self')
    else if (!existingAgents.has(reviewer)) problems.push('reviewer_not_member')
    else if (scope.status === 'known' && !scope.memberAgentIds.has(reviewer)) problems.push('reviewer_not_member')
  }
  return problems
}

export interface ConfigureIntent {
  missionId: string
  commandId: string
  /** CAS：0 表示首次保存，其它值必须与当前 revision 相等 */
  expectedRevision: number
  draft: LoomControlDraft
  tasks: readonly LoomTask[]
  agents: readonly AgentProfile[]
  scope: ReviewerScope
}

/**
 * 用户显式点「批准此范围」时构造一次意图。缺口存在时返回 problems 且**不构造 commandId**，
 * 调用方据此禁用按钮，而不是塞一个默认预算。
 */
export function beginConfigure(intent: ConfigureIntent):
  | { attempt: ControlAttempt }
  | { problems: ControlPanelProblem[] }
  | { invalid: string } {
  const missionId = intent.missionId.trim()
  const commandId = intent.commandId.trim()
  const problems = controlPanelProblems(intent.draft, intent.tasks, intent.agents, intent.scope)
  if (problems.length > 0) return { problems }
  // 缺身份或修订号时连“可提交”的可能都不开：这不是用户的缺口，界面也不能编一个。
  if (missionId === '') return { invalid: message('缺少工作标识，未发出批准请求。') }
  if (commandId === '') return { invalid: message('缺少请求标识，未发出批准请求。') }
  if (!Number.isInteger(intent.expectedRevision) || intent.expectedRevision < 0) {
    return { invalid: message('没有可用的策略修订号，未发出批准请求。') }
  }
  const input = loomControlInput(missionId, commandId, intent.expectedRevision, intent.draft)
  if (input === null) return { problems: ['no_tasks'] }
  return { attempt: { kind: 'configure', missionId, commandId, input } }
}

export interface PauseIntent {
  missionId: string
  commandId: string
  policy: LoomControlPolicy
  /** true = 暂停后续派发；false = 继续 */
  paused: boolean
}

/** 暂停/继续：只写闸门，不动批准范围与预算，也不动正在运行的任务。 */
export function beginPause(intent: PauseIntent): { attempt: ControlAttempt } | { problems: string[] } {
  const missionId = intent.missionId.trim()
  const commandId = intent.commandId.trim()
  if (missionId === '' || commandId === '') return { problems: [message('缺少工作或请求标识，未发出暂停请求。')] }
  if (!Number.isInteger(intent.policy.revision) || intent.policy.revision < 0) {
    return { problems: [message('没有可用的策略修订号，未发出暂停请求。')] }
  }
  return {
    attempt: {
      kind: 'pause',
      missionId,
      commandId,
      input: {
        missionId,
        commandId,
        expectedRevision: intent.policy.revision,
        paused: intent.paused
      }
    }
  }
}

// ------------------------------------------------------------------ writing

/** 从错误里取稳定码：先读 `code` 字段，再读消息里唯一一个 `LOOM_*`；都没有就是 null。 */
export function controlRejectionCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && /^LOOM_[A-Z0-9_]+$/u.test(code)) return code
  }
  const text = readErrorMessage(error, '')
  const match = /\b(LOOM_[A-Z0-9_]+)\b/u.exec(text)
  return match === null ? null : match[1]
}

/**
 * 写回执必须自己证明这次保存真的成立：configure 与 pause 成功时策略一定存在，
 * 所以「policy 为 null」「missionId 不符」「revision 不是正整数」都不是保存成功。
 */
function appliedSnapshot(raw: unknown, missionId: string): LoomControlSnapshot | null {
  const read = classifyControlSnapshot(raw, missionId)
  if (read.status !== 'observed') return null
  const policy = read.snapshot.policy
  if (policy === null) return null
  if (!Number.isInteger(policy.revision) || policy.revision < 1) return null
  if (!Number.isInteger(policy.authorizationRevision) || policy.authorizationRevision < 1) return null
  return read.snapshot
}

/** 发出（或原样重发）一次写入。重试必须传入同一个 attempt。 */
export async function submitControl(port: ControlPort, attempt: ControlAttempt): Promise<ControlWrite> {
  const method = attempt.kind === 'configure' ? LOOM_CONTROL_CONFIGURE : LOOM_CONTROL_PAUSE
  let raw: unknown
  try {
    raw = await port.request<unknown>(method, attempt.input)
  } catch (error) {
    const code = controlRejectionCode(error)
    if (isNoWriteRejection(code)) {
      return { status: 'rejected', code, message: readErrorMessage(error, message('主机拒绝了这次接力设置。')) }
    }
    // 未知码（含 outcome unknown）不代表没写入：保留 attempt 原样核对。
    return {
      status: 'unknown',
      message: readErrorMessage(error, message('提交结果未确认；请用同一请求核对，不会换新的请求编号。'))
    }
  }
  const snapshot = appliedSnapshot(raw, attempt.missionId)
  if (snapshot !== null) return { status: 'applied', snapshot }
  return { status: 'unknown', message: message('保存回执不足以证明这次修改已生效；请用同一请求核对。') }
}

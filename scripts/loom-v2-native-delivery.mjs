// LOOM V2 · 原生派发 / Run 身份观察门面（唯一新增文件之一；不修改 Rust、迁移、application）。
//
// 目的：把「已有明确任务计划」变成**可追踪的真实派发**，再从同一个 Core 的权威读回里确认
// 这次派发对应的真实 `agent_run`，而不是用 randomUUID 假装一个 Run。
//
// 只使用既有 Core RPC（全部为已上线方法，未新增任何方法）：
// - 写（仅一个）：`loom.control.configure` —— 已批准 policy 落库后，Core 自己的
//   `loom::control::dispatch::admit_due_dispatches`（application.rs:13822）会在普通 Delivery
//   批量调度器里把它变成一个真实的 Camp 系统消息 + Delivery（collaboration.rs:3857）。
// - 读：`loom.control.get`（policy + dispatches，含 deliveryId）、`camps.open`
//   （Core 的 `threads.open` 方法名，rovai-web/src/operations.rs:712 → application.rs:11665）、
//   `loom.tasks.list` / `loom.candidates.list` / `loom.artifacts.list` / `loom.reviews.list`。
//
// 本文件**从不**：
// - 写 `loom.claim.*` / `loom.candidate.record` / `loom.review.record` / `loom.verification.record`；
// - 替用户 Review、替 Run 声称成功、声称任何 OS 权限或授权；
// - 手插 `agent_run`、SQL 直写、或把客户端构造的 run id 当作真实 Run；
// - 新建调度数据库、私有调度循环或第二套执行状态机（派发完全交给 Core 的既有调度器）。
//
// 唯一被接受的 Run 身份来源：`loom.control.get` 的 `dispatch.deliveryId`
// → 同一份 `camps.open` 快照里的 `messageDeliveries[].targetAgentRunId`
// → 同一份快照里的 `agentRuns[]`。三者不同源即视为未确认。
//
// Core 当前协议**无法**声明、因此本文件也不声明的事项（诚实边界）：
// 1. 没有 RPC 可以强制 Delivery 批量 claim（`claim_waiting_delivery_batches*` 只在 Core 内部
//    调度循环里调用），所以 Run 的**物化时刻**只能有界轮询观察，不能同步触发；
// 2. `loom.control.configure` 的批准人由 Host 注入 `CURRENT_USER_ID`，所以隔离测试里的
//    "已批准"是 local_user 注入，**不是**用户在 UI 里点过批准（`userUiApproval=false`）；
// 3. Core 不暴露 OS 级进程权限/沙箱授权，本文件不推断、不宣称（`osPermissionClaimed=false`）；
// 4. `LoomDispatch` 投影不含 `dedupeKey`，所以去重身份只能由"每个 (task,kind,revision) 一条
//    dispatch 行 + deliveryId 已附加"间接证明，不能从读回直接核 dedupe key；
// 5. 读回完整性由 `camps.open` 的 `coverage` 声明；`coverage.agentRuns.complete !== true` 时
//    本文件**绝不**把"没找到 Run"当作"没有 Run"。
// 6. **已实测的缓存二进制—源码漂移**：本机缓存的 `rovai-core` 在 `loom.control.configure` 上
//    要求"每个 Task 恰好一个 reviewer"（`LOOM_CONTROL_REVIEWER_INVALID: every Task needs
//    exactly one reviewer; missing <task>`），而当前源码 `loom/control.rs:1302-1387` 只校验
//    **已提供**的 reviewer，不做完整性检查。本文件不放宽 Core 检查、不伪造接受，只如实声明：
//    集成 fixture 必须为 scope 内每个 Task 提供**一个不同于 assignee 的独立 reviewer**。
// 7. **`AgentRun.conversationId` 不是群聊 Thread id**：`agent_run.conversation_id` 指向的是
//    `conversation` 行（每 Agent 一个，带 `conversation.agent_id`），而 Thread/群聊 id 是
//    `camp.id`（`rvcamp_…`）。因此**不能**要求 `run.conversationId === thread.id`，
//    也不能按字符串前缀猜归属。
//    归属直接取**同一次事务内的真快照**（Root 实测核对）：
//    - `read_model.rs:1238-1273` `camp_snapshot` 在**同一个** `transaction()` 里依次调
//      `load_camp` / `load_message_deliveries` / `load_agent_runs`，然后 `commit`；
//    - `read_model.rs:3049-3051` `load_agent_runs` 选的是 `agent_run.conversation_id` 与
//      `conversation.agent_id`；
//    - `read_model.rs:3186-3198` 用 `JOIN camp ON camp.id = COALESCE(agent_run.camp_id,
//      camp_turn.camp_id)` + `JOIN conversation ON conversation.id = agent_run.conversation_id`
//      且 `WHERE camp.id = ?1 AND agent_run.invocation_kind <> 'single_chat'`。
//    所以 `camps.open` 返回的 `agentRuns[]` **本身就是 Core 同库的 camp 绑定**：能出现在这份
//    快照里，就已经被 Core 证明属于该 camp。本文件因此只用本次已认证的 Core 读回构造归属
//    （`source: 'core_thread_snapshot_transaction'`），**不**再发额外诊断请求：
//    `agentRuns.diagnostic.get` 需要已冻结的 Runtime adapter，未配置 Runtime 时直接失败
//    （`CORE_REQUEST_FAILED 'AgentRun has no frozen Runtime adapter'`），不属于归属证明的必要依赖。

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

import {
  coreDataDirectoryArguments,
  removeEphemeralRuntimeCampFilesRoot,
  runtimeCampFilesRootForDataDirectory
} from './lib/runtime-camp-files-root.mjs'
import { defaultCoreBinaryPath, verifyCachedCoreBinary } from './loom-v2-core-pi-integration.mjs'

/** 本文件唯一允许对外声称的证据信封。每个字段都是长期声明，不是本次运行的形容词。 */
export const NATIVE_DELIVERY_EVIDENCE_ENVELOPE = Object.freeze({
  schema: 'loom.v2.native-delivery.v1',
  scope: 'loom-v2-native-delivery',
  // 派发与 Run 身份来自同一个 Core 权威读回，不是 fixture 拼装。
  coreIntegrated: true,
  // 本门面永不代替用户验收，也永不代替 Run 自称完成。
  ownerReviewRecorded: false,
  candidateAutoApproved: false,
  technicalVerificationRecorded: false,
  // 派发由 Core 自己的 control-plane 调度器产生，不是本文件的私有循环。
  privateSchedulerUsed: false,
  // 客户端构造的 run id 永远不被接受。
  fabricatedRunAccepted: false,
  // Core 不声明 OS 权限/授权，本文件也不声明。
  osPermissionClaimed: false,
  userUiApproval: false,
  // 本门面只会让 Core 产生 EXECUTE 派发：它从不提交候选，所以 REVIEW/REWORK/HANDOFF 不可能
  // 由它触发。开启 EXECUTE 不等于任何验收。
  startsExecuteDispatchesOnly: true,
  // assignee 永远不能当自己 Task 的 reviewer（buildDispatchPolicy 强制拒绝）。
  assigneeNeverReviewsOwnTask: true,
  // 独立 review 不是 Owner Accepted：本门面从不调用 `loom.review.record`。
  reviewerVerdictIsNotOwnerAcceptance: true,
  // 本轮不做任何真实外部模型请求；没有 Runtime 时就是 QUEUED/BLOCKED。
  realModelExecution: false
})

/** 稳定错误码：调用方按码分支，不按文案分支。 */
export const NATIVE_DELIVERY_ERROR_CODES = Object.freeze([
  'invalid_input',
  'task_not_found',
  'task_not_dispatchable',
  'assignee_not_approved',
  'reviewer_invalid',
  'policy_not_configured',
  'dispatch_not_observed',
  'dispatch_without_delivery',
  'delivery_not_in_snapshot',
  'delivery_coverage_incomplete',
  'run_coverage_incomplete',
  'run_missing_from_snapshot',
  'run_absent',
  'run_cancelled',
  'run_terminal',
  'run_ownership_missing',
  'run_conversation_mismatch',
  'run_agent_mismatch',
  'run_agent_not_approved',
  'run_thread_mismatch',
  'unknown_result_unresolved'
])

/**
 * 只有这些明确的传输层标记才算"没收到答复"，可以同 ID 重发一次。
 * 其余一切（含无法归类的错误形状）都按**确定结果**处理：不重发。
 */
const TRANSPORT_UNKNOWN_CODES = Object.freeze([
  'request_timeout',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'ECONNREFUSED',
  'ENOTCONN',
  'EAI_AGAIN',
  'ERR_STREAM_DESTROYED'
])

export class NativeDeliveryError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'NativeDeliveryError'
    this.code = code
    this.details = details
  }
}

function fail(code, message, details) {
  throw new NativeDeliveryError(code, message, details)
}

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex')

// ---------------------------------------------------------------------------
// 1. 稳定身份
// ---------------------------------------------------------------------------

/**
 * 一个写命令的稳定 commandId。同一业务意图必须永远得到同一个值，这样 Core 的
 * `command_id + command_type + request_digest` 重放判定（domain-command-result-v1 §1，
 * control.rs:365 `replay_command`）才能在超时/未知结果时返回第一次已提交的结果，
 * 而不是执行第二次。
 *
 * @param {string} kind 命令种类，例如 'control-configure'
 * @param {readonly (string|number|boolean|null)[]} parts 业务意图的稳定组成部分
 * @returns {string}
 */
export function stableCommandId(kind, parts) {
  if (typeof kind !== 'string' || kind.trim().length === 0) {
    fail('invalid_input', 'stableCommandId requires a non-empty kind')
  }
  if (!Array.isArray(parts) || parts.length === 0) {
    fail('invalid_input', 'stableCommandId requires at least one identity part', { kind })
  }
  for (const part of parts) {
    if (part !== null && !['string', 'number', 'boolean'].includes(typeof part)) {
      fail('invalid_input', 'stableCommandId parts must be scalar identity values', { kind, part })
    }
  }
  return `loom-v2-${kind}-${sha256Hex(JSON.stringify([kind, ...parts])).slice(0, 32)}`
}

/**
 * 读操作的 traceId。`camps.open` 要求 UUID（application.rs:1548），这是**读取追踪**，
 * 不是写命令身份，所以可以每次新生成；写命令一律走 [`stableCommandId`]。
 */
export function newTraceId() {
  return randomUUID()
}

// ---------------------------------------------------------------------------
// 2. 纯函数：把「已批准的计划」翻译成 control policy
// ---------------------------------------------------------------------------

const DISPATCHABLE_TASK_STATUSES = Object.freeze(['draft', 'ready'])

/**
 * 校验并构造 `loom.control.configure` 的 params（`LoomControlPolicyInput`，control.rs:84）。
 *
 * 调用方必须显式给出已批准的 mission / task / worker 集合；本函数只做"这些事实彼此自洽"的
 * 判定，不替调用方批准任何东西：
 * - 每个 task 必须存在且处于 draft/ready（Core 的 `due_events` 只对这两种状态产生 EXECUTE，
 *   dispatch.rs:398-406）；
 * - 每个 task 必须已经有**显式** assignee，且该 assignee 属于 `approvedWorkerAgentIds`
 *   （Core 明确拒绝"Lead 兜底"：dispatch.rs:400-404）；
 * - 每个 reviewer 必须属于已批准 worker 集合、不是该 task 的 assignee（control.rs:1365-1373）、
 *   且 task 在本次 scope 内（control.rs:1322-1327）；
 * - `enabled` 必须有未来 RFC3339 `expiresAt`（control.rs:1396-1402）；没有 expiresAt 的
 *   policy 在 Core 里**永远不会派发**（dispatch.rs:218-220），所以这里不允许省略。
 *
 * @param {object} input
 * @param {string} input.missionId
 * @param {readonly string[]} input.taskIds
 * @param {readonly string[]} input.approvedWorkerAgentIds
 * @param {readonly {taskId: string, reviewerAgentId: string}[]} [input.reviewers]
 * @param {readonly {taskId: string, assigneeAgentId: string|null, status: string}[]} input.tasks
 *   `loom.tasks.list` 的真实读回，不接受调用方口述
 * @param {number} [input.expectedRevision]
 * @param {number} [input.maxDispatches]
 * @param {number} [input.maxReworksPerTask]
 * @param {string} [input.expiresAt] RFC3339；缺省为 now+15min
 * @param {string} [input.commandId] 缺省由 mission+taskIds 派生（稳定）
 * @returns {object} `loom.control.configure` params
 */
export function buildDispatchPolicy(input) {
  const {
    missionId,
    taskIds,
    approvedWorkerAgentIds,
    tasks,
    reviewers = [],
    expectedRevision = 0,
    maxDispatches = 4,
    maxReworksPerTask = 1,
    expiresAt,
    commandId
  } = input ?? {}

  if (typeof missionId !== 'string' || missionId.trim().length === 0) {
    fail('invalid_input', 'buildDispatchPolicy requires missionId')
  }
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    fail('invalid_input', 'buildDispatchPolicy requires at least one taskId', { missionId })
  }
  if (!Array.isArray(approvedWorkerAgentIds) || approvedWorkerAgentIds.length === 0) {
    fail('invalid_input', 'buildDispatchPolicy requires the approved worker agent ids', { missionId })
  }
  if (!Array.isArray(tasks)) {
    fail('invalid_input', 'buildDispatchPolicy requires the real loom.tasks.list rows', { missionId })
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    fail('invalid_input', 'expectedRevision must be a non-negative integer', { expectedRevision })
  }
  if (!Number.isInteger(maxDispatches) || maxDispatches < 1 || maxDispatches > 1000) {
    fail('invalid_input', 'maxDispatches must be 1..=1000', { maxDispatches })
  }
  if (!Number.isInteger(maxReworksPerTask) || maxReworksPerTask < 0 || maxReworksPerTask > 20) {
    fail('invalid_input', 'maxReworksPerTask must be 0..=20', { maxReworksPerTask })
  }

  const approved = new Set(approvedWorkerAgentIds)
  const byTaskId = new Map(tasks.map((task) => [task?.taskId, task]))
  const seen = new Set()
  for (const taskId of taskIds) {
    if (typeof taskId !== 'string' || taskId.trim().length === 0) {
      fail('invalid_input', 'every taskId must be a non-empty string', { missionId })
    }
    if (seen.has(taskId)) {
      fail('invalid_input', 'a task may be listed only once in the approved scope', { taskId })
    }
    seen.add(taskId)
    const task = byTaskId.get(taskId)
    if (!task) {
      fail('task_not_found', `task ${taskId} is not in the Mission's plan`, { missionId, taskId })
    }
    if (!DISPATCHABLE_TASK_STATUSES.includes(task.status)) {
      fail('task_not_dispatchable', `task ${taskId} is ${task.status}; only draft/ready can be dispatched`, {
        missionId,
        taskId,
        status: task.status
      })
    }
    const assignee = typeof task.assigneeAgentId === 'string' ? task.assigneeAgentId.trim() : ''
    if (assignee.length === 0) {
      // Core never falls back to the Lead (dispatch.rs:400-404): an unassigned Task is simply
      // never dispatched, so an approved policy over it would silently do nothing.
      fail('assignee_not_approved', `task ${taskId} has no explicit assignee to dispatch to`, {
        missionId,
        taskId
      })
    }
    if (!approved.has(assignee)) {
      fail('assignee_not_approved', `task ${taskId} is assigned to ${assignee}, which is not an approved worker`, {
        missionId,
        taskId,
        assignee,
        approvedWorkerAgentIds: [...approved]
      })
    }
  }

  const normalizedReviewers = []
  for (const reviewer of reviewers) {
    const taskId = reviewer?.taskId
    const reviewerAgentId = reviewer?.reviewerAgentId
    if (!seen.has(taskId)) {
      fail('reviewer_invalid', `reviewer names task ${String(taskId)}, which is not in the approved scope`, {
        missionId,
        taskId
      })
    }
    if (normalizedReviewers.some((held) => held.taskId === taskId)) {
      fail('reviewer_invalid', `task ${taskId} carries more than one reviewer`, { taskId })
    }
    if (!approved.has(reviewerAgentId)) {
      fail('reviewer_invalid', `reviewer ${String(reviewerAgentId)} is not an approved worker`, {
        taskId,
        reviewerAgentId
      })
    }
    const assignee = byTaskId.get(taskId)?.assigneeAgentId
    if (assignee === reviewerAgentId) {
      fail('reviewer_invalid', `agent ${reviewerAgentId} is the assignee of task ${taskId} and cannot review it`, {
        taskId,
        reviewerAgentId
      })
    }
    normalizedReviewers.push({ taskId, reviewerAgentId })
  }

  const resolvedExpiry = expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString()
  if (Number.isNaN(Date.parse(resolvedExpiry))) {
    fail('invalid_input', 'expiresAt must be an RFC 3339 instant', { expiresAt: resolvedExpiry })
  }
  if (Date.parse(resolvedExpiry) <= Date.now()) {
    fail('invalid_input', 'expiresAt must be in the future', { expiresAt: resolvedExpiry })
  }

  return {
    missionId,
    commandId: commandId ?? stableCommandId('control-configure', [
      missionId,
      [...taskIds].sort().join(','),
      [...approved].sort().join(',')
    ]),
    expectedRevision,
    enabled: true,
    taskIds: [...taskIds],
    reviewers: normalizedReviewers,
    maxDispatches,
    maxReworksPerTask,
    expiresAt: resolvedExpiry
  }
}

// ---------------------------------------------------------------------------
// 3. 纯函数：Run 身份门（防假 UUID 的唯一入口）
// ---------------------------------------------------------------------------

const TERMINAL_RUN_STATUSES = Object.freeze(['succeeded', 'failed', 'cancelled'])

/**
 * 判定一个 `agent_run` 是否真的是本次派发的、被批准的那个 Run。
 *
 * 拒绝（默认抛错）：缺席、已 cancel、终态、Agent 不符、Agent 不在批准集合、Thread 不符。
 * `allowTerminal: true` 只用于**观察**（把终态作为事实报告，`fenceUsable=false`），
 * 不允许把它当作"可以提交的活 Run"。
 *
 * @returns {{runId: string, agentId: string, status: string, terminal: boolean,
 *            fenceUsable: boolean, cancelRequestedAt: string|null,
 *            terminalReasonCode: string|null, hasUnsettledExternalEffects: boolean}}
 */
export function assertRunIdentity({
  run,
  delivery,
  threadId,
  ownership,
  approvedWorkerAgentIds,
  allowTerminal = false
}) {
  if (!run || typeof run.id !== 'string' || run.id.length === 0) {
    fail('run_absent', 'no agent_run was materialised for this delivery')
  }
  if (!delivery || typeof delivery.id !== 'string') {
    fail('invalid_input', 'assertRunIdentity requires the delivery that carried the Run')
  }
  if (typeof threadId !== 'string' || threadId.length === 0) {
    fail('invalid_input', 'assertRunIdentity requires the Mission threadId')
  }
  if (!Array.isArray(approvedWorkerAgentIds) || approvedWorkerAgentIds.length === 0) {
    fail('invalid_input', 'assertRunIdentity requires the approved worker agent ids')
  }
  // 显式受信归属：必须由 Core 自己的投影给出 thread/conversation/agent 三元组，
  // 否则不推断、不按前缀猜、不跳过（`AgentRun.conversationId` 是 AgentConversation，
  // 不是群聊 Thread id）。
  if (!ownership || typeof ownership !== 'object') {
    fail('run_ownership_missing', `run ${run.id} has no Core-declared thread/conversation/agent ownership`, {
      runId: run.id
    })
  }
  for (const field of ['threadId', 'conversationId', 'agentId', 'source']) {
    if (typeof ownership[field] !== 'string' || ownership[field].length === 0) {
      fail('run_ownership_missing', `run ${run.id} ownership is missing ${field}`, { runId: run.id, field })
    }
  }
  if (delivery.targetAgentRunId !== run.id) {
    fail('run_agent_mismatch', `run ${run.id} is not the Run this delivery materialised`, {
      runId: run.id,
      deliveryId: delivery.id,
      targetAgentRunId: delivery.targetAgentRunId ?? null
    })
  }
  // 归属必须指向本 Mission 的 Thread（camp id），而不是拿 conversationId 去比。
  if (ownership.threadId !== threadId) {
    fail('run_thread_mismatch', `run ${run.id} is owned by thread ${ownership.threadId}, not ${threadId}`, {
      runId: run.id,
      ownedThreadId: ownership.threadId,
      threadId,
      source: ownership.source
    })
  }
  // 归属里的 conversation 必须就是该 Run 自己的 conversation。
  if (ownership.conversationId !== run.conversationId) {
    fail('run_conversation_mismatch', `run ${run.id} runs in conversation ${run.conversationId}, but its ownership names ${ownership.conversationId}`, {
      runId: run.id,
      runConversationId: run.conversationId,
      ownedConversationId: ownership.conversationId,
      source: ownership.source
    })
  }
  // 归属里的 agent、Run 的 agent、Delivery 的 recipient 必须同一个。
  if (ownership.agentId !== run.agentId) {
    fail('run_agent_mismatch', `run ${run.id} belongs to ${run.agentId}, but its ownership names ${ownership.agentId}`, {
      runId: run.id,
      runAgentId: run.agentId,
      ownedAgentId: ownership.agentId,
      source: ownership.source
    })
  }
  if (run.agentId !== delivery.recipientAgentId) {
    fail('run_agent_mismatch', `run ${run.id} belongs to ${run.agentId}, not the delivery recipient ${delivery.recipientAgentId}`, {
      runId: run.id,
      runAgentId: run.agentId,
      recipientAgentId: delivery.recipientAgentId
    })
  }
  if (!approvedWorkerAgentIds.includes(run.agentId)) {
    fail('run_agent_not_approved', `run ${run.id} belongs to ${run.agentId}, which is not an approved worker`, {
      runId: run.id,
      agentId: run.agentId,
      approvedWorkerAgentIds
    })
  }
  const cancelRequestedAt = run.cancelRequestedAt ?? null
  if (cancelRequestedAt !== null || run.status === 'cancelled') {
    fail('run_cancelled', `run ${run.id} is cancelled or has a cancel request`, {
      runId: run.id,
      status: run.status,
      cancelRequestedAt
    })
  }
  const terminal = TERMINAL_RUN_STATUSES.includes(run.status)
  if (terminal && !allowTerminal) {
    fail('run_terminal', `run ${run.id} is already ${run.status}`, { runId: run.id, status: run.status })
  }
  return {
    runId: run.id,
    agentId: run.agentId,
    status: run.status,
    terminal,
    fenceUsable: !terminal && run.status !== 'cancelled' && cancelRequestedAt === null,
    cancelRequestedAt,
    terminalReasonCode: run.terminalReasonCode ?? null,
    hasUnsettledExternalEffects: run.hasUnsettledExternalEffects === true
  }
}

// ---------------------------------------------------------------------------
// 4. 纯函数：dispatch → delivery → run 的解析
// ---------------------------------------------------------------------------

/**
 * Delivery 的等待/失败事实，全部取自 Core 的持久列（db.rs:14554-14563），不推断。
 * @returns {{state: string, blocked: boolean, waitCondition: string|null, detail: string|null}}
 */
export function classifyDeliveryWait(delivery) {
  if (!delivery) {
    fail('invalid_input', 'classifyDeliveryWait requires a delivery')
  }
  const waitCondition = delivery.waitCondition ?? null
  if (delivery.status === 'failed') {
    return {
      state: 'delivery_failed',
      blocked: true,
      waitCondition,
      detail: delivery.failureCode ?? null
    }
  }
  if (delivery.status === 'cancelled' || delivery.status === 'interrupted_before_dispatch') {
    return {
      state: `delivery_${delivery.status}`,
      blocked: true,
      waitCondition,
      detail: delivery.failureCode ?? null
    }
  }
  if (delivery.status === 'settled') {
    return { state: 'delivery_settled', blocked: false, waitCondition, detail: null }
  }
  if (delivery.dispatchPhase === 'never_attempted') {
    return { state: 'queued_never_attempted', blocked: true, waitCondition, detail: null }
  }
  if (waitCondition === 'runtime_unavailable') {
    // Core 的 `RuntimeReady` 等待条件（message_delivery.rs:91）：没有可用 Runtime，
    // 于是**没有** Run 被物化。这是诚实的 BLOCKED/queued，不是失败，也不是完成。
    return { state: 'waiting_for_runtime', blocked: true, waitCondition, detail: null }
  }
  if (waitCondition === 'target_busy') {
    return { state: 'waiting_for_target_run', blocked: true, waitCondition, detail: null }
  }
  if (waitCondition === 'capacity_unavailable') {
    return { state: 'waiting_for_capacity', blocked: true, waitCondition, detail: null }
  }
  return { state: 'dispatching', blocked: true, waitCondition, detail: null }
}

/**
 * 把一个 Mission 的 control 读回 + 同一时刻的 thread 快照，解析成"这一 Task 的派发走到了哪一步"。
 *
 * 顺序固定，任何一步不同源都返回明确状态而不是猜：
 * policy → dispatch(含 deliveryId) → snapshot.messageDeliveries[id] →
 * targetAgentRunId → snapshot.agentRuns[id] → **Core 声明的归属三元组** → 身份门。
 *
 * `runOwnership(runId)` 必须返回 Core 自己算的
 * `{threadId, conversationId, agentId, source}`（由 `ownershipFromThreadSnapshot` 从本次
 * 已认证的 Core 快照构造）；
 * 返回 `null` 就是“归属未知”，直接拒绝，不按字符串前缀猜、也不拿 `conversationId` 当 thread id。
 *
 * @param {object} input
 * @param {object} input.control `loom.control.get` 的读回
 * @param {object} input.snapshot `camps.open` 的读回
 * @param {string} input.taskId
 * @param {readonly string[]} input.approvedWorkerAgentIds
 * @param {(runId: string) => ({threadId: string, conversationId: string, agentId: string, source: string}|null)} [input.runOwnership]
 * @returns {object} 稳定的解析结果（`state` 是唯一权威判定）
 */
export function resolveDispatchRun({ control, snapshot, taskId, approvedWorkerAgentIds, runOwnership }) {
  if (!control || typeof control.missionId !== 'string') {
    fail('invalid_input', 'resolveDispatchRun requires the loom.control.get read-back')
  }
  if (!snapshot || typeof snapshot.thread !== 'object' || snapshot.thread === null) {
    fail('invalid_input', 'resolveDispatchRun requires the camps.open read-back')
  }
  if (typeof taskId !== 'string' || taskId.length === 0) {
    fail('invalid_input', 'resolveDispatchRun requires a taskId')
  }

  const base = {
    schema: NATIVE_DELIVERY_EVIDENCE_ENVELOPE.schema,
    taskId,
    policyRevision: control.policy?.revision ?? null,
    policyAuthorizationRevision: control.policy?.authorizationRevision ?? null,
    dispatchId: null,
    deliveryId: null,
    agentRunId: null,
    ownership: null,
    run: null,
    state: 'unknown',
    blocked: true,
    waitCondition: null,
    detail: null
  }

  if (!control.policy || control.policy.enabled !== true) {
    return { ...base, state: 'policy_not_configured' }
  }

  const dispatches = Array.isArray(control.dispatches) ? control.dispatches : []
  const forTask = dispatches
    .filter((entry) => entry?.taskId === taskId)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
  if (forTask.length === 0) {
    return { ...base, state: 'dispatch_not_observed' }
  }
  const dispatch = forTask[forTask.length - 1]
  base.dispatchId = dispatch.dispatchId ?? null
  base.policyAuthorizationRevision = dispatch.policyRevision ?? base.policyAuthorizationRevision
  if (typeof dispatch.deliveryId !== 'string' || dispatch.deliveryId.length === 0) {
    // The ledger row and its Delivery commit together (collaboration.rs:3851-3856), so a
    // dispatch without a delivery is a real anomaly worth reporting, never a "pending".
    return { ...base, state: 'dispatch_without_delivery' }
  }
  base.deliveryId = dispatch.deliveryId

  const deliveries = Array.isArray(snapshot.messageDeliveries) ? snapshot.messageDeliveries : []
  const delivery = deliveries.find((entry) => entry?.id === dispatch.deliveryId)
  if (!delivery) {
    const coverage = snapshot.coverage?.messageDeliveries
    if (coverage && coverage.complete !== true) {
      return { ...base, state: 'delivery_coverage_incomplete', detail: 'messageDeliveries coverage incomplete' }
    }
    return { ...base, state: 'delivery_not_in_snapshot' }
  }
  const wait = classifyDeliveryWait(delivery)
  base.waitCondition = wait.waitCondition
  base.detail = wait.detail

  if (typeof delivery.targetAgentRunId !== 'string' || delivery.targetAgentRunId.length === 0) {
    // 没有 Run 就是没有 Run。`runtime_unavailable` 之类是 Core 的持久事实，照抄。
    return { ...base, state: wait.state, blocked: wait.blocked }
  }

  const runCoverage = snapshot.coverage?.agentRuns
  if (!runCoverage || runCoverage.complete !== true) {
    // 读回不完整时绝不能把"列表里没有"说成"不存在"。
    return {
      ...base,
      state: 'run_coverage_incomplete',
      agentRunId: delivery.targetAgentRunId,
      detail: 'agentRuns coverage incomplete'
    }
  }
  const runs = Array.isArray(snapshot.agentRuns) ? snapshot.agentRuns : []
  const run = runs.find((entry) => entry?.id === delivery.targetAgentRunId)
  if (!run) {
    return {
      ...base,
      state: 'run_missing_from_snapshot',
      agentRunId: delivery.targetAgentRunId
    }
  }

  // 显式受信归属：由调用方从**本次已认证的 Core 快照**取得（`ownershipFromThreadSnapshot`）。
  // 拿不到就不接受（不按前缀猜、不跳过、不拿 conversationId 当 thread id）。
  const ownership = typeof runOwnership === 'function' ? runOwnership(run.id) : null
  if (!ownership) {
    return {
      ...base,
      state: 'run_ownership_unknown',
      agentRunId: run.id,
      detail: 'no Core-declared thread/conversation/agent ownership for this Run'
    }
  }

  const identity = assertRunIdentity({
    run,
    delivery,
    threadId: snapshot.thread.id,
    ownership,
    approvedWorkerAgentIds,
    // 观察模式：终态作为事实报告，但 `fenceUsable=false`，绝不当作可提交的活 Run。
    allowTerminal: true
  })
  return {
    ...base,
    state: identity.fenceUsable ? 'run_bound' : 'run_bound_terminal',
    blocked: false,
    agentRunId: identity.runId,
    // 归属三元组随结果返回，供 evidence/上层核对“Run 属于本 Thread 与本 worker”这件事。
    ownership: {
      threadId: ownership.threadId,
      conversationId: ownership.conversationId,
      agentId: ownership.agentId,
      source: ownership.source
    },
    run: {
      runId: identity.runId,
      agentId: identity.agentId,
      conversationId: run.conversationId,
      status: identity.status,
      terminal: identity.terminal,
      fenceUsable: identity.fenceUsable,
      cancelRequestedAt: identity.cancelRequestedAt,
      terminalReasonCode: identity.terminalReasonCode,
      hasUnsettledExternalEffects: identity.hasUnsettledExternalEffects
    },
    detail: identity.terminalReasonCode
  }
}

// ---------------------------------------------------------------------------
// 5. 读：一次快照 + 四个 LOOM 读
// ---------------------------------------------------------------------------

/**
 * 从**本次已认证的 Core 快照**构造 Run 归属三元组。
 *
 * 为什么快照就够（Root 实测核对）：
 * - `read_model.rs:1238-1273` `camp_snapshot` 在**同一个** `transaction()` 里依次
 *   `load_camp` / `load_message_deliveries` / `load_agent_runs`，然后 `commit`；
 * - `read_model.rs:3049-3051` `load_agent_runs` 选 `agent_run.conversation_id` 与
 *   `conversation.agent_id`；
 * - `read_model.rs:3186-3198` 用 `JOIN camp ON camp.id = COALESCE(agent_run.camp_id,
 *   camp_turn.camp_id)` + `JOIN conversation ON conversation.id = agent_run.conversation_id`，
 *   且 `WHERE camp.id = ?1 AND agent_run.invocation_kind <> 'single_chat'`。
 *
 * 所以 `agentRuns[]` 里出现一个 Run，就是 Core 在同一事务里证明过它属于该 camp。
 * 本函数只做一件事：在**已验证**的快照上按**精确 run.id** 取字段，并把它封成显式归属；
 * 快照 Thread 不对、Mission 不对、Run 不在快照里、字段缺失 → 一律返回 `null`（拒绝）。
 * 不接受调用方自带数组、不猜前缀、不把 `conversationId` 当 thread id。
 *
 * @param {object} input
 * @param {object} input.snapshot `camps.open` 的**本次**读回
 * @param {string} input.threadId 已核过的 Mission Thread id
 * @param {string} [input.missionId] 给出时校验 `thread.missionId`（若快照声明了）
 * @param {string} input.runId 精确的 `agent_run.id`
 * @returns {{threadId: string, conversationId: string, agentId: string, source: string}|null}
 */
export function ownershipFromThreadSnapshot({ snapshot, threadId, missionId, runId }) {
  if (!snapshot || snapshot.schemaVersion !== 9) return null
  if (!snapshot.thread || typeof snapshot.thread.id !== 'string') return null
  if (typeof threadId !== 'string' || threadId.length === 0) return null
  // 快照必须是本 Thread 的：错误快照一律不参与归属。
  if (snapshot.thread.id !== threadId) return null
  if (typeof missionId === 'string' && missionId.length > 0
    && snapshot.thread.missionId != null && snapshot.thread.missionId !== missionId) {
    return null
  }
  if (typeof runId !== 'string' || runId.length === 0) return null
  const runs = Array.isArray(snapshot.agentRuns) ? snapshot.agentRuns : []
  const matched = runs.find((entry) => entry && entry.id === runId)
  if (!matched) return null
  if (typeof matched.conversationId !== 'string' || matched.conversationId.length === 0) return null
  if (typeof matched.agentId !== 'string' || matched.agentId.length === 0) return null
  return {
    threadId: snapshot.thread.id,
    conversationId: matched.conversationId,
    agentId: matched.agentId,
    source: 'core_thread_snapshot_transaction'
  }
}

/**
 * 读回一个 Mission 的真实派发事实。**只读**，不写任何东西。
 *
 * @param {object} input
 * @param {{request: (method: string, params?: object) => Promise<any>}} input.request
 *   显式调用者提供的 Core 请求函数（Root 的 harness / Desktop CoreClient 均可）
 * @param {string} input.missionId
 * @param {string} input.threadId Mission 的 Thread（`missions.create` 的 payload.threadId）
 * @param {readonly string[]} input.approvedWorkerAgentIds
 * @param {string} [input.taskId] 给出时额外解析该 Task 的派发链
 * @returns {Promise<object>}
 */
export async function readNativeRunFacts({
  request,
  missionId,
  threadId,
  approvedWorkerAgentIds,
  taskId
}) {
  if (typeof request !== 'function') {
    fail('invalid_input', 'readNativeRunFacts requires the caller-provided core request function')
  }
  if (typeof missionId !== 'string' || missionId.length === 0) {
    fail('invalid_input', 'readNativeRunFacts requires missionId')
  }
  if (typeof threadId !== 'string' || threadId.length === 0) {
    fail('invalid_input', 'readNativeRunFacts requires the Mission threadId')
  }

  const [control, snapshot, tasks, candidates, artifacts, reviews] = await Promise.all([
    request('loom.control.get', { missionId }),
    // Core 的方法名是 `camps.open`（rovai-web/src/operations.rs:712 的 threads.open → camps.open）。
    request('camps.open', { threadId, traceId: newTraceId() }),
    request('loom.tasks.list', { missionId }),
    request('loom.candidates.list', { missionId }),
    request('loom.artifacts.list', { missionId }),
    request('loom.reviews.list', { missionId })
  ])

  if (!snapshot || snapshot.schemaVersion !== 9 || snapshot.thread?.id !== threadId) {
    fail('invalid_input', 'camps.open did not answer with the schema-9 projection of this thread', {
      threadId,
      schemaVersion: snapshot?.schemaVersion ?? null
    })
  }
  if (snapshot.thread.missionId != null && snapshot.thread.missionId !== missionId) {
    fail('run_thread_mismatch', `thread ${threadId} belongs to mission ${snapshot.thread.missionId}, not ${missionId}`, {
      threadId,
      missionId,
      threadMissionId: snapshot.thread.missionId
    })
  }

  // 归属直接来自**本次已认证的 Core 读回**：先按本 Task 的 dispatch → Delivery →
  // `targetAgentRunId` 定位唯一 Run，再从**同一份**已验证快照的 `agentRuns[]` 里按精确 id 取
  // `conversationId`/`agentId`。不向 Core 发额外诊断请求（那需要已冻结 Runtime），
  // 也不从任意 caller 数组/错误快照构造映射。
  const runOwnership = {}
  if (typeof taskId === 'string' && taskId.length > 0) {
    const dispatches = Array.isArray(control?.dispatches) ? control.dispatches : []
    const forTask = dispatches
      .filter((entry) => entry?.taskId === taskId)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    const dispatch = forTask.length > 0 ? forTask[forTask.length - 1] : null
    const deliveries = Array.isArray(snapshot.messageDeliveries) ? snapshot.messageDeliveries : []
    const delivery = dispatch && typeof dispatch.deliveryId === 'string'
      ? deliveries.find((entry) => entry?.id === dispatch.deliveryId)
      : null
    const runId = delivery?.targetAgentRunId
    if (typeof runId === 'string' && runId.length > 0) {
      const ownership = ownershipFromThreadSnapshot({ snapshot, threadId, missionId, runId })
      if (ownership) runOwnership[runId] = ownership
    }
  }

  const link = typeof taskId === 'string' && taskId.length > 0
    ? resolveDispatchRun({
      control,
      snapshot,
      taskId,
      approvedWorkerAgentIds,
      runOwnership: (runId) => runOwnership[runId] ?? null
    })
    : null

  return {
    schema: NATIVE_DELIVERY_EVIDENCE_ENVELOPE.schema,
    missionId,
    threadId,
    control,
    // 只保留重新解析派发链所需的三个集合（Delivery / Run / coverage）与 Thread 身份；
    // 消息、证据、审批等大集合不复制进读回对象。
    snapshot: {
      schemaVersion: snapshot.schemaVersion,
      throughGlobalSequence: snapshot.throughGlobalSequence,
      thread: snapshot.thread,
      messageDeliveries: Array.isArray(snapshot.messageDeliveries) ? snapshot.messageDeliveries : [],
      agentRuns: Array.isArray(snapshot.agentRuns) ? snapshot.agentRuns : [],
      coverage: snapshot.coverage ?? null
    },
    tasks,
    // 只读事实：候选仍是 pending/unverified 就照原样报告，本门面不替用户 Review。
    candidates,
    artifacts,
    reviews,
    // Core 声明的 Run 归属（可能为空对象：没有 Run 时本来就没有归属）。
    runOwnership,
    link,
    evaluatedAt: new Date().toISOString()
  }
}

// ---------------------------------------------------------------------------
// 6. 写：稳定 commandId + 未知结果查询（绝不新 ID 重发）
// ---------------------------------------------------------------------------

/**
 * 发一个写命令，并按 domain-command-result-v1 的未知结果纪律收尾。
 *
 * - 明确业务拒绝（`kind === 'domain_rejection'`）是**已提交的结果**，原样抛出，绝不重试；
 * - 传输层超时/断连属于"未知"，此时：先 `readBack()` 查这次意图是否已经落地；查不到才用
 *   **同一个 commandId** 重发一次（Core 按 commandId 重放第一次结果）；仍然未知就抛
 *   `unknown_result_unresolved`，**绝不**生成新 commandId 重发。
 *
 * @param {object} input
 * @param {(method: string, params?: object) => Promise<any>} input.request
 * @param {string} input.method
 * @param {object} input.params 必须已经含稳定 commandId
 * @param {string} input.commandId
 * @param {() => Promise<boolean>} input.readBack 证明"意图已落地"的读回
 * @param {(error: unknown) => boolean} [input.isUnknownTransportError]
 * @returns {Promise<{result: any, outcome: 'applied'|'recovered_after_unknown', resent: boolean}>}
 */
export async function writeOnce({
  request,
  method,
  params,
  commandId,
  readBack,
  isUnknownTransportError = defaultIsUnknownTransportError
}) {
  if (typeof request !== 'function') {
    fail('invalid_input', 'writeOnce requires the caller-provided core request function')
  }
  if (typeof commandId !== 'string' || commandId.length === 0) {
    fail('invalid_input', 'writeOnce requires a stable commandId')
  }
  if (typeof readBack !== 'function') {
    fail('invalid_input', 'writeOnce requires a readBack that proves the intent landed')
  }

  let resent = false
  for (;;) {
    try {
      const result = await request(method, params)
      return { result, outcome: 'applied', resent }
    } catch (error) {
      if (!isUnknownTransportError(error)) {
        // 业务拒绝是已提交结果：不重试、不改写。
        throw error
      }
      if (await readBack().catch(() => false)) {
        return { result: null, outcome: 'recovered_after_unknown', resent }
      }
      if (resent) {
        fail(
          'unknown_result_unresolved',
          `${method} commandId ${commandId} is still unknown after a same-id resend and a read-back; refusing to mint a new commandId`,
          { method, commandId }
        )
      }
      resent = true
    }
  }
}

/**
 * Core 的传输层"未知"与业务拒绝的区别。
 *
 * **失败关闭**：只有明确带传输标记的错误才被当作"未知"（可以同 ID 重发）。领域拒绝
 * （`kind === 'domain_rejection'`）、基础设施失败（`kind === 'infrastructure_failure'`）、
 * 以及任何无法归类为传输错误的形状，都算**确定结果**：原样上抛，绝不重发。
 *
 * 这一条是对称于 Core 自己的契约：`applied | accepted | rejected` 都是已提交结果
 * （domain-command-result-v1 §1），只有"没收到答复"才是未知。
 */
export function defaultIsUnknownTransportError(error) {
  if (!error || typeof error !== 'object') return false
  if (error.kind === 'domain_rejection' || error.kind === 'infrastructure_failure') return false
  if (error.kind === 'transport_unknown') return true
  return typeof error.code === 'string' && TRANSPORT_UNKNOWN_CODES.includes(error.code)
}

/**
 * 从既有明确任务计划生成可追踪的真实派发。
 *
 * 只发一个写命令（`loom.control.configure`）。派发本身由 Core 的 control-plane 调度器
 * 在普通 Delivery 批量调度里完成（application.rs:13818-13824），本函数**不**创建 Delivery、
 * **不**物化 Run、**不**开私有循环。
 *
 * 之后只做有界读回：等到 dispatch 出现（或超时），并把当时的真实状态原样返回。超时不是失败
 * 也不是成功：`outcome` 会明确写出 `dispatch_not_observed`，`link.state` 照抄 Core 事实。
 *
 * @param {object} input
 * @param {(method: string, params?: object) => Promise<any>} input.request
 * @param {object} input.policy [`buildDispatchPolicy`] 的返回值
 * @param {(policy: object) => Promise<object>} input.readFacts 返回 `readNativeRunFacts` 形状的读回
 * @param {string} input.taskId 观察哪一个 Task
 * @param {readonly string[]} input.approvedWorkerAgentIds
 * @param {number} [input.dispatchBudgetMs] 有界等待预算（默认 20s）
 * @param {number} [input.pollIntervalMs] 轮询间隔（默认 250ms）
 * @returns {Promise<object>}
 */
export async function startNativeDispatch({
  request,
  policy,
  readFacts,
  taskId,
  approvedWorkerAgentIds,
  dispatchBudgetMs = 20_000,
  pollIntervalMs = 250
}) {
  if (typeof readFacts !== 'function') {
    fail('invalid_input', 'startNativeDispatch requires a readFacts function')
  }
  if (!policy || typeof policy.commandId !== 'string') {
    fail('invalid_input', 'startNativeDispatch requires the built policy (with its stable commandId)')
  }
  const factsBefore = await readFacts(policy)
  const write = await writeOnce({
    request,
    method: 'loom.control.configure',
    params: policy,
    commandId: policy.commandId,
    // 读回证明：policy 已经在 Core 里以我们这条 commandId 的意图落地（revision 前进或已存在）。
    readBack: async () => {
      const facts = await readFacts(policy)
      const standing = facts?.control?.policy
      if (!standing || standing.enabled !== true) return false
      return Array.isArray(standing.taskIds)
        && policy.taskIds.every((id) => standing.taskIds.includes(id))
    }
  })

  const startedAt = Date.now()
  let facts = await readFacts(policy)
  let link = typeof taskId === 'string' && taskId.length > 0
    ? resolveDispatchRun({
      control: facts.control,
      snapshot: facts.snapshot,
      taskId,
      approvedWorkerAgentIds,
      runOwnership: (runId) => facts.runOwnership?.[runId] ?? null
    })
    : null
  while (Date.now() - startedAt < dispatchBudgetMs) {
    if (link && link.state !== 'dispatch_not_observed') break
    await new Promise((resolveTimer) => setTimeout(resolveTimer, pollIntervalMs))
    facts = await readFacts(policy)
    link = typeof taskId === 'string' && taskId.length > 0
      ? resolveDispatchRun({
        control: facts.control,
        snapshot: facts.snapshot,
        taskId,
        approvedWorkerAgentIds,
        runOwnership: (runId) => facts.runOwnership?.[runId] ?? null
      })
      : null
  }

  return {
    schema: NATIVE_DELIVERY_EVIDENCE_ENVELOPE.schema,
    missionId: policy.missionId,
    taskId: taskId ?? null,
    commandId: policy.commandId,
    configureOutcome: write.outcome,
    configureResent: write.resent,
    configureResult: write.result,
    policyRevisionBefore: factsBefore?.control?.policy?.revision ?? null,
    policyRevisionAfter: facts.control?.policy?.revision ?? null,
    dispatchObserved: Boolean(link && link.state !== 'dispatch_not_observed'),
    waitedMs: Date.now() - startedAt,
    dispatchBudgetMs,
    link,
    // 明确的最终口径：只有 Core 读回能证明的东西才在这里出现。
    outcome: link
      ? link.state
      : 'no_task_observed',
    completed: false,
    ownerReviewRecorded: false
  }
}

// ---------------------------------------------------------------------------
// 7. 真实隔离 Core 集成入口
// ---------------------------------------------------------------------------

/**
 * 在一个独占隔离 Core 里跑一次"计划 → 已批准 policy → Core 自己派发 → 读回 Run 身份"的闭环。
 *
 * 诚实边界（每次运行都随 evidence 返回）：
 * - 二进制是仓库既有 `target/debug/rovai-core(.exe)`，本文件从不编译（`cargoBuildInvoked=false`）；
 * - 没有配置任何 Runtime，所以真实结果是 `waiting_for_runtime` 之类，**不会**有 Run 被物化；
 *   这就是诚实的 BLOCKED/queued，不是完成；
 * - `loom.control.configure` 的批准人是 Host 注入的 local_user，不是用户 UI 批准；
 * - 不调用 `loom.review.record` / `loom.verification.record` / `loom.candidate.record`。
 *
 * @param {object} [options]
 * @param {string} [options.coreBinaryPath] 覆盖缓存二进制路径
 * @param {number} [options.readyBudgetMs]
 * @param {number} [options.dispatchBudgetMs]
 */
export async function runNativeDeliveryEvidence({
  coreBinaryPath,
  readyBudgetMs = 120_000,
  dispatchBudgetMs = 20_000
} = {}) {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-loom-native-delivery-')))
  let preserveFixture = false
  let core = null
  let dataDir = null
  let runtimeFilesRoot = null
  let evidence = null
  let mainError = null

  const isolatedHome = join(fixture, 'home')
  const isolatedTemporary = join(fixture, 'tmp')
  // 其他 Agent 的宿主配置目录也全部指向 fixture 子目录，避免意外跑用户的 Claude/Codex/DSH/Pi。
  const agentHomes = {
    appData: join(fixture, 'appdata'),
    localAppData: join(fixture, 'localappdata'),
    codexHome: join(fixture, 'codex-home'),
    claudeConfigDir: join(fixture, 'claude-config'),
    piCodingAgentDir: join(fixture, 'pi-coding-agent'),
    dshHome: join(fixture, 'dsh-home')
  }
  await mkdir(isolatedHome)
  await mkdir(isolatedTemporary)
  for (const directory of Object.values(agentHomes)) {
    await mkdir(directory, { recursive: true })
  }
  const isolatedEnvironment = buildIsolatedCoreEnvironment({
    isolatedHome,
    isolatedTemporary,
    agentHomes
  })
  const contained = (path) => {
    const offset = relative(fixture, path)
    return offset !== '' && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
  }

  try {
    const binaryMeta = await verifyCachedCoreBinary(coreBinaryPath ?? defaultCoreBinaryPath())
    if (process.platform === 'win32') {
      dataDir = JSON.parse(
        execFileSync(binaryMeta.path, ['--prepare-windows-data-root', join(fixture, 'formal')], { encoding: 'utf8' })
      ).core
    } else {
      dataDir = join(fixture, 'core-data')
      await mkdir(dataDir)
    }
    assert.ok(typeof dataDir === 'string' && dataDir.length > 0, 'Core must answer with a data directory')
    const skillRoot = join(dataDir, 'managed-skill-library')
    const mcpPath = join(dataDir, 'mcp.json')
    runtimeFilesRoot = runtimeCampFilesRootForDataDirectory(dataDir, { homeDirectory: isolatedHome })
    assert.ok(contained(dataDir) && contained(skillRoot) && contained(mcpPath) && contained(runtimeFilesRoot),
      'the data root, skill root, MCP config and Runtime Files Root must stay inside the fixture')

    core = startIsolatedCore({
      dataDir,
      skillRoot,
      mcpPath,
      binaryPath: binaryMeta.path,
      environment: isolatedEnvironment,
      readyBudgetMs
    })
    await core.ready
    await core.settled()

    // 真实选出**两个不同的 present 成员**：生产者（assignee）与独立审查者。
    // 缓存 Core 要求 scope 内每个 Task 恰好一个 reviewer（见文件头第 6 条漂移声明），
    // 而 assignee 不能审自己，所以两个成员是硬需求。不手插行、不猜 id。
    const members = await ensureTwoPresentMembers({
      request: (method, params) => core.request(method, params),
      tag: fixture.replace(/[^A-Za-z0-9]/g, '').slice(-8)
    })
    const workerAgentId = members.worker.agentId
    const reviewerAgentId = members.reviewer.agentId
    assert.notEqual(workerAgentId, reviewerAgentId,
      `the producer and the reviewer must be two different members: ${JSON.stringify(members)}`)

    const mission = await core.request('missions.create', {
      commandId: stableCommandId('mission-create', ['native-delivery', fixture]),
      command: {
        title: 'LOOM native delivery seam',
        description: 'Proves Core-native dispatch produces a traceable Delivery without a fabricated Run.',
        projectPath: '',
        projectBindingKind: 'quick_chat',
        // Both members belong to the Mission's Camp, so Core's membership and reviewer
        // admission can both be re-proved against the real roster.
        memberAgentIds: [workerAgentId, reviewerAgentId],
        defaultLeadAgentId: workerAgentId,
        tags: ['loom-native-delivery']
      }
    })
    const missionId = mission?.payload?.missionId
    const threadId = mission?.payload?.threadId
    assert.equal(typeof missionId, 'string', `missions.create must answer with a missionId: ${JSON.stringify(mission)}`)
    assert.equal(typeof threadId, 'string', `missions.create must answer with a threadId: ${JSON.stringify(mission)}`)

    const taskId = 'native-delivery-task'
    const acceptanceCriteriaVersion = 'ac-native-delivery'
    await core.request('loom.plan.import', {
      missionId,
      goal: 'One Task is dispatched by Core itself, and its Run identity is read back, never invented',
      acceptanceCriteriaVersion,
      criteria: [{ criterionId: 'criterion-native-delivery', text: 'the dispatch carries a real Delivery' }],
      tasks: [{
        taskId,
        title: 'Native delivery task',
        description: 'Assigned to the producer; the independent reviewer is not the assignee',
        assigneeAgentId: workerAgentId
      }],
      dependencies: []
    })

    const factsFor = async (policy) => readNativeRunFacts({
      request: (method, params) => core.request(method, params),
      missionId: policy.missionId,
      threadId,
      approvedWorkerAgentIds: [workerAgentId, reviewerAgentId],
      taskId
    })

    const tasksBefore = await core.request('loom.tasks.list', { missionId })
    const policy = buildDispatchPolicy({
      missionId,
      taskIds: [taskId],
      approvedWorkerAgentIds: [workerAgentId, reviewerAgentId],
      tasks: tasksBefore,
      // 受限范围：只开 EXECUTE 派发。独立 reviewer 只满足 Core 的 scope 完整性要求，
      // 不是 Owner Accepted，也不产生任何 review 行。
      reviewers: [{ taskId, reviewerAgentId }],
      maxDispatches: 2,
      maxReworksPerTask: 0
    })
    const dispatch = await startNativeDispatch({
      request: (method, params) => core.request(method, params),
      policy,
      readFacts: factsFor,
      taskId,
      approvedWorkerAgentIds: [workerAgentId, reviewerAgentId],
      dispatchBudgetMs
    })
    const facts = await factsFor(policy)

    // 事实断言：dispatch 行存在且已经附加了 Delivery；没有 Run 时必须是 Core 的等待事实。
    const dispatches = Array.isArray(facts.control.dispatches) ? facts.control.dispatches : []
    const ourDispatch = dispatches.find((entry) => entry.taskId === taskId)
    assert.ok(ourDispatch, `Core must record the dispatch row for the Task: ${JSON.stringify(dispatches)}`)
    assert.equal(typeof ourDispatch.deliveryId, 'string',
      `the dispatch ledger row must carry its Delivery: ${JSON.stringify(ourDispatch)}`)
    assert.ok(dispatch.link, 'the facade must resolve a link for the dispatched Task')
    assert.notEqual(dispatch.link.state, 'dispatch_not_observed',
      `Core must observe the dispatch within the budget: ${JSON.stringify(dispatch.link)}`)
    if (dispatch.link.agentRunId === null) {
      // 没有 Runtime / 调度还没尝试，就没有 Run：必须是 Core 的持久等待事实，不能是任何"完成"。
      assert.ok(
        ['waiting_for_runtime', 'waiting_for_target_run', 'waiting_for_capacity',
          'queued_never_attempted', 'dispatching', 'delivery_settled'].includes(dispatch.link.state),
        `a missing Run must be an explicit Core wait/queue fact: ${JSON.stringify(dispatch.link)}`
      )
      if (dispatch.link.state.startsWith('waiting_for_')) {
        assert.ok(dispatch.link.waitCondition !== null,
          `a waiting delivery must carry Core's wait condition: ${JSON.stringify(dispatch.link)}`)
      }
      assert.notEqual(dispatch.link.state, 'run_bound')
    } else {
      assert.ok(dispatch.link.run, 'a bound Run must carry its validated identity')
      assert.equal(dispatch.link.run.agentId, workerAgentId,
        `the bound Run must belong to the approved worker: ${JSON.stringify(dispatch.link.run)}`)
      assert.equal(dispatch.link.run.fenceUsable, true,
        `a bound Run must be a live Run, not a terminal one: ${JSON.stringify(dispatch.link.run)}`)
      // Run 属于本 Thread 这件事必须由 Core 自己的诊断投影证明；
      // `agent_run.conversation_id` 是 AgentConversation，不是群聊 Thread id，不能直接相等。
      assert.equal(dispatch.link.ownership.source, 'core_thread_snapshot_transaction',
        `the Run ownership must come from Core's own projection: ${JSON.stringify(dispatch.link.ownership)}`)
      assert.equal(dispatch.link.ownership.threadId, threadId,
        `the Run must be owned by this Mission's thread: ${JSON.stringify(dispatch.link.ownership)}`)
      assert.equal(dispatch.link.ownership.conversationId, dispatch.link.run.conversationId,
        `the ownership conversation must be the Run's own conversation: ${JSON.stringify(dispatch.link)}`)
      assert.equal(dispatch.link.ownership.agentId, workerAgentId,
        `the ownership agent must be the approved worker: ${JSON.stringify(dispatch.link.ownership)}`)
    }
    // 本门面永不替用户验收：候选与 review 只能是它们本来的样子。
    assert.deepEqual(facts.reviews, [], 'the facade must never create an Owner review')
    assert.ok(facts.candidates.every((candidate) => candidate.acceptanceStatus === 'pending'),
      `no candidate may be accepted by this facade: ${JSON.stringify(facts.candidates)}`)

    evidence = {
      ok: true,
      ...NATIVE_DELIVERY_EVIDENCE_ENVELOPE,
      // 二进制诚实：缓存预构建，本文件从不编译。
      binarySource: binaryMeta.binarySource,
      coldBuilt: binaryMeta.coldBuilt,
      cargoBuildInvoked: binaryMeta.cargoBuildInvoked,
      coreBinary: binaryMeta,
      fixturePath: fixture,
      isolation: {
        dataRootInsideFixture: contained(dataDir),
        skillRootInsideDataRoot: contained(skillRoot),
        mcpConfigInsideDataRoot: contained(mcpPath),
        runtimeFilesRootInsideFixture: contained(runtimeFilesRoot),
        agentHomesInsideFixture: Object.values(agentHomes).every(contained),
        hostCredentialEnvStripped: true,
        pathSystemOnly: true,
        userDatabaseTouched: false,
        port64851Touched: false,
        globalMcpConfigTouched: false,
        realPiProfileTouched: false
      },
      mission: { missionId, threadId, planAcceptanceCriteriaVersion: acceptanceCriteriaVersion, taskId },
      // 两个成员都是 Core 名册里的真实 present 成员，且互不相同。
      members: {
        workerAgentId,
        reviewerAgentId,
        distinct: workerAgentId !== reviewerAgentId,
        workerPresence: members.worker.presence,
        reviewerPresence: members.reviewer.presence,
        createdReviewerProfile: members.createdReviewerProfile,
        reviewerIsAssignee: false
      },
      // 缓存二进制声明：本文件从不编译，所以运行版可能与源码有差异（见文件头第 6 条）。
      binaryIsCachedPrebuild: binaryMeta.binarySource === 'cached-prebuild',
      coreBinarySha256: binaryMeta.sha256,
      cachedBinaryMayDifferFromSource: true,
      // 受限范围：本门面只开 EXECUTE 派发，独立 reviewer 不是 Owner Accepted。
      executeDispatchOnly: true,
      policy: {
        commandId: policy.commandId,
        taskIds: policy.taskIds,
        reviewers: policy.reviewers,
        reviewersCoverEveryTask: policy.taskIds.every((id) =>
          policy.reviewers.some((reviewer) => reviewer.taskId === id)),
        expiresAt: policy.expiresAt,
        maxDispatches: policy.maxDispatches,
        maxReworksPerTask: policy.maxReworksPerTask,
        approvedBy: facts.control.policy?.approvedBy ?? null,
        revision: facts.control.policy?.revision ?? null,
        authorizationRevision: facts.control.policy?.authorizationRevision ?? null
      },
      dispatch: {
        configureOutcome: dispatch.configureOutcome,
        configureResent: dispatch.configureResent,
        waitedMs: dispatch.waitedMs,
        dispatchBudgetMs: dispatch.dispatchBudgetMs,
        dispatchId: ourDispatch.dispatchId,
        kind: ourDispatch.kind,
        status: ourDispatch.status,
        deliveryId: ourDispatch.deliveryId
      },
      link: dispatch.link,
      // 明确的最终口径：Run 是否真的被 Core 物化，以及它是活的还是终态的。
      runMaterialized: dispatch.link.agentRunId !== null,
      runFenceUsable: dispatch.link.run?.fenceUsable ?? false,
      blockedOrQueued: dispatch.link.agentRunId === null,
      // 本门面不读也不推断 Runtime 冻结态；未配置 Runtime 时就是 false。
      hasFrozenRuntime: false,
      // 归属事实（只是记录，不作为判定依据）：AgentConversation 与 Thread 是两个 id 空间。
      runOwnership: dispatch.link.ownership,
      conversationEqualsThread: dispatch.link.run
        ? dispatch.link.run.conversationId === threadId
        : null,
      ownerReviewRecorded: false,
      reviewsCount: facts.reviews.length,
      candidatesCount: facts.candidates.length,
      artifactsCount: Array.isArray(facts.artifacts?.artifacts) ? facts.artifacts.artifacts.length : 0,
      tasks: facts.tasks.map((task) => ({ taskId: task.taskId, status: task.status, assigneeAgentId: task.assigneeAgentId ?? null }))
    }

    await stopCoreOrFail(core, 'before the fixture is inspected')
    core = null
  } catch (error) {
    mainError = error
  } finally {
    const cleanupErrors = []
    if (core) {
      try {
        await stopCoreOrFail(core, 'in teardown')
      } catch (error) {
        preserveFixture = true
        cleanupErrors.push(error)
      }
      core = null
    }
    if (!preserveFixture) {
      if (dataDir) {
        try {
          await removeEphemeralRuntimeCampFilesRoot(dataDir, {
            temporaryDirectory: fixture,
            homeDirectory: isolatedHome
          })
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      if (process.env.ROVAI_KEEP_LOOM_NATIVE_DELIVERY_FIXTURE !== '1') {
        try {
          await rm(fixture, { recursive: true, force: true })
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
    }
    if (cleanupErrors.length > 0) {
      const errors = mainError ? [mainError, ...cleanupErrors] : cleanupErrors
      throw new AggregateError(errors, 'LOOM native delivery teardown failed; refusing to report a green run')
    }
  }
  if (mainError) throw mainError
  return evidence
}

// ---------------------------------------------------------------------------
// 隔离 Core 进程（JSON-RPC over stdio；框架与 E3 harness 同源，E3 模块未导出其 class）
// ---------------------------------------------------------------------------

/**
 * 从隔离 Core 的真实成员名册里选出**两个不同的 present 成员**：生产者与独立审查者。
 *
 * 只走 Core 命令：`members.list` 读名册；不足两个时用 `members.create` 真建一个；
 * 仍不是 present 时用 `members.presence.set`（带真实 `expectedVersion`）设为 present。
 * 不手插行、不猜 id、不把 assignee 当 reviewer。
 *
 * 需要两个成员的原因：缓存 Core 要求 scope 内每个 Task 恰好一个 reviewer，
 * 而 assignee 不能审自己（`LOOM_CONTROL_REVIEWER_SELF`）。
 */
async function ensureTwoPresentMembers({ request, tag }) {
  const readProfiles = async () => {
    const profiles = await request('members.list')
    if (!Array.isArray(profiles)) {
      throw new Error('members.list must answer with an array of member profiles')
    }
    return profiles.filter((profile) => profile && profile.removedAt == null)
  }
  const presentOf = (profiles) => profiles.filter((profile) => profile.presence === 'present')

  let profiles = await readProfiles()
  let createdReviewerProfile = false
  if (presentOf(profiles).length < 2) {
    await request('members.create', {
      commandId: stableCommandId('member-create', ['native-delivery-reviewer', tag]),
      command: {
        displayName: `LOOM Native Reviewer ${tag}`,
        teamRole: 'Independent reviewer',
        professionalResponsibilities: 'Reviews LOOM deliveries it does not own',
        personalityTraits: ['careful', 'literal'],
        workingPrinciples: 'Never accepts work on behalf of the Owner',
        growthTopic: 'review rigour'
      }
    })
    createdReviewerProfile = true
    profiles = await readProfiles()
  }
  // 新 profile 可能还不是 present：用 Core 的 presence 命令逐个补到两个 present。
  for (const candidate of profiles) {
    if (presentOf(profiles).length >= 2) break
    if (candidate.presence === 'present') continue
    await request('members.presence.set', {
      commandId: stableCommandId('member-presence', [candidate.agentId, 'present', tag]),
      command: {
        agentId: candidate.agentId,
        expectedVersion: candidate.version,
        presence: 'present'
      }
    })
    profiles = await readProfiles()
  }

  const present = presentOf(profiles)
    .sort((left, right) => String(left.agentId).localeCompare(String(right.agentId)))
  if (present.length < 2) {
    throw new Error(
      `the isolated Core must expose two distinct present members, got ${JSON.stringify(
        profiles.map((profile) => ({ agentId: profile.agentId, presence: profile.presence }))
      )}`
    )
  }
  return { worker: present[0], reviewer: present[1], createdReviewerProfile }
}

/**
 * 宿主认证类变量一律不继承：Core 子进程只拿到 fixture 内的路径与最小 PATH。
 * 这是防止意外使用用户凭据/外部 Provider 的硬边界，不是可选项。
 */
const HOST_CREDENTIAL_ENV_PATTERN = /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|_AUTH$|PROVIDER[_-]?URL|BASE[_-]?URL|ENDPOINT|ACCOUNT[_-]?ID)/i

/** 只留系统目录，避免 PATH 里解析到用户安装的 Claude/Codex/DSH/Pi。 */
function systemPathOnly() {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    return [join(systemRoot, 'system32'), systemRoot, join(systemRoot, 'system32', 'Wbem')].join(';')
  }
  return '/usr/bin:/bin:/usr/sbin:/sbin'
}

/**
 * 构造隔离 Core 子进程的环境：
 * - 宿主认证/Provider 变量全部剔除（不继承 API key/token/provider URL）；
 * - HOME/USERPROFILE/TMP/XDG 指向 fixture；
 * - APPDATA/LOCALAPPDATA/CODEX_HOME/CLAUDE_CONFIG_DIR/PI_CODING_AGENT_DIR/DSH_HOME 指向 fixture 子目录；
 * - PATH 仅系统目录。
 */
function buildIsolatedCoreEnvironment({ isolatedHome, isolatedTemporary, agentHomes }) {
  const inherited = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue
    if (HOST_CREDENTIAL_ENV_PATTERN.test(key)) continue
    inherited[key] = value
  }
  return {
    ...inherited,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    TMPDIR: isolatedTemporary,
    TMP: isolatedTemporary,
    TEMP: isolatedTemporary,
    XDG_CACHE_HOME: join(isolatedHome, '.cache'),
    XDG_CONFIG_HOME: join(isolatedHome, '.config'),
    XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
    XDG_STATE_HOME: join(isolatedHome, '.local', 'state'),
    XDG_RUNTIME_DIR: join(isolatedHome, 'run'),
    APPDATA: agentHomes.appData,
    LOCALAPPDATA: agentHomes.localAppData,
    CODEX_HOME: agentHomes.codexHome,
    CLAUDE_CONFIG_DIR: agentHomes.claudeConfigDir,
    PI_CODING_AGENT_DIR: agentHomes.piCodingAgentDir,
    DSH_HOME: agentHomes.dshHome,
    PATH: systemPathOnly()
  }
}

function startIsolatedCore({ dataDir, skillRoot, mcpPath, binaryPath, environment, readyBudgetMs }) {
  const args = [
    ...coreDataDirectoryArguments(dataDir, { homeDirectory: environment.HOME }),
    '--skill-library-root', skillRoot,
    '--mcp-config-path', mcpPath
  ]
  const child = spawn(binaryPath, args, {
    // 只给隔离环境：不合并宿主 process.env，因此认证变量与用户 PATH 都不会泄漏。
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  })
  const pending = new Map()
  const startupFrames = []
  let nextId = 0
  let stderr = ''
  let resolveReady
  let rejectReady
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise
    rejectReady = rejectPromise
  })
  const readyStartedAt = Date.now()
  const startupTimeout = setTimeout(() => {
    rejectReady(Object.assign(
      new Error(`Core ready timeout after ${Date.now() - readyStartedAt}ms (budget ${readyBudgetMs}ms); stderrTail=${stderr}`),
      { stage: 'ready', readyBudgetMs }
    ))
  }, readyBudgetMs)
  const exitEvent = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })))
  const pidAlive = (pid) => {
    if (!pid) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (error?.code === 'ESRCH') return false
      if (error?.code === 'EPERM') return true
      throw error
    }
  }
  async function waitForExit(milliseconds) {
    if (child.exitCode !== null || child.signalCode !== null || !pidAlive(child.pid)) return true
    let timer
    try {
      return await Promise.race([
        exitEvent.then(() => true),
        new Promise((resolveWait) => { timer = setTimeout(() => resolveWait(false), milliseconds) })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  child.stdin.on('error', () => {})
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000) })
  child.on('error', rejectReady)
  child.once('exit', (code) => {
    clearTimeout(startupTimeout)
    const error = new Error(`Core exited before usable ready/RPC (code=${code}): ${stderr}`)
    rejectReady(error)
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const message = JSON.parse(line)
    if (message.kind === 'core_startup') startupFrames.push(message)
    if (message.kind === 'core_startup' && message.status === 'ready') {
      clearTimeout(startupTimeout)
      resolveReady(message)
    }
    if (message.kind === 'core_startup' && ['failed', 'blocked'].includes(message.status)) {
      clearTimeout(startupTimeout)
      rejectReady(Object.assign(new Error(message.error?.message ?? 'Startup refused'), message.error, {
        phase: message.phase,
        startupStatus: message.status
      }))
    }
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) request.reject(message.error)
      else request.resolve(message.result)
    }
  })
  async function request(method, params = {}) {
    await ready
    const id = String(++nextId)
    let timeout
    try {
      return await Promise.race([
        new Promise((resolveRequest, rejectRequest) => {
          pending.set(id, { resolve: resolveRequest, reject: rejectRequest })
          child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
        }),
        new Promise((_, rejectTimeout) => {
          timeout = setTimeout(() => rejectTimeout(Object.assign(
            new Error(`${method} timed out`),
            { code: 'request_timeout', kind: 'transport_unknown' }
          )), 30_000)
        })
      ])
    } finally {
      clearTimeout(timeout)
      pending.delete(id)
    }
  }
  return {
    process: child,
    args,
    startupFrames,
    ready,
    request,
    stderrTail: () => stderr,
    async settled() {
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        const states = await request('runtime.subsystems.get')
        if (states.every((entry) => entry.state !== 'initializing')) return states
        await new Promise((resolveWait) => setTimeout(resolveWait, 20))
      }
      throw Object.assign(new Error('optional initialization did not settle within 60000ms'), { stage: 'settled' })
    },
    async close() {
      const pid = child.pid
      const totalBudget = 20_000
      const startedAt = Date.now()
      const remaining = () => Math.max(startedAt + totalBudget - Date.now(), 0)
      let stage = 'stdin-end'
      const timedOut = (detail = '') => Object.assign(
        new Error(`Core pid=${pid} did not exit in the ${stage} stage${detail}: ${stderr}`),
        { stage, pid }
      )
      try {
        if (!child.stdin.destroyed) child.stdin.end()
        if (await waitForExit(Math.min(remaining(), 5_000))) return
        stage = 'sigterm'
        child.kill('SIGTERM')
        if (await waitForExit(Math.min(remaining(), 5_000))) return
        stage = 'sigkill'
        killProcessTree(child, remaining())
        if (await waitForExit(remaining())) return
        throw timedOut()
      } catch (error) {
        if (error?.stage === stage && error?.pid === pid) throw error
        throw Object.assign(timedOut(` - ${error?.message ?? error}`), { cause: error })
      } finally {
        clearTimeout(startupTimeout)
        lines.close()
      }
    },
    async exited(timeout = 5_000) {
      const gone = await waitForExit(timeout)
      return { pid: child.pid, gone, exitCode: child.exitCode, signalCode: child.signalCode }
    }
  }
}

async function stopCoreOrFail(core, when) {
  try {
    await core.close()
  } catch (error) {
    assert.fail(`Core did not stop ${when}: stage=${error?.stage} pid=${error?.pid} - ${error?.message}`)
  }
  const gone = await core.exited()
  assert.equal(gone.gone, true, `Core must have exited ${when}: ${JSON.stringify(gone)}`)
  return gone
}

function killProcessTree(child, budgetMs = 15_000) {
  const pid = child.pid
  if (!pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    const outcome = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: budgetMs,
      killSignal: 'SIGKILL'
    })
    if (outcome.error || outcome.status !== 0) {
      throw Object.assign(
        new Error(`taskkill.exe /PID ${pid} /T /F failed (status=${outcome.status}): ${outcome.stderr ?? ''}`),
        { stage: 'taskkill', pid }
      )
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw Object.assign(new Error(`process.kill(-${pid}, 'SIGKILL') failed: ${error?.message ?? error}`), {
        stage: 'sigkill-group',
        pid
      })
    }
  }
}

// ---------------------------------------------------------------------------
// CLI（直接运行时打印 evidence；不启动任何真实 Runtime、不写用户数据）
// ---------------------------------------------------------------------------

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  runNativeDeliveryEvidence()
    .then((evidence) => {
      console.log(JSON.stringify(evidence, null, 2))
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error))
      process.exitCode = 1
    })
}

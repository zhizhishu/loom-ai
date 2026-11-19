import type { CoreMethod, MissionCreate, MissionRecord, StoredCommandResult, TeamSelection, WorkspaceSelection } from '@contracts'
import { newCommandId } from '../../../shared/command-id'
import { readErrorMessage } from '../error-message'
import { uiAttribute } from '../interface-language'

/** Tracked-work creation: a user goal becomes a real Mission + Thread in Core,
 * not a plain group. This module reuses the exact existing commands the Mission
 * board already issues (`missions.create`, `missions.start`, `missions.get`).
 * It never sends a thread message itself: Core's `missions.start` queues the
 * one "Start the current Mission." message, so a duplicate initial message is
 * impossible by construction. There is deliberately no cancel/close operation:
 * the user leaving this surface never cancels remote work.
 *
 * Reconcile contract (mirrors BusinessApp's own creation guard): an ambiguous
 * create outcome retains the original commandId + command signature. A retry
 * with a different draft is refused, so a second Mission can never be created
 * while the first result is unresolved. Start is a separate explicit user
 * action with its own stable commandId; a failed start never recreates the
 * Mission and is retried only with the same start commandId. */

export const WORK_TITLE_MAX_CHARS = 200
export const WORK_GOAL_MAX_CHARS = 12_000

export interface TrackedWorkDraft {
  name: string
  goal: string
  memberAgentIds: string[]
  defaultLeadAgentId: string
  /** null = Core's quick-chat binding (no prepared workspace needed);
   * a selection = the 'directory' binding on an already-chosen directory. */
  workspace: WorkspaceSelection | null
  team?: TeamSelection
  tags?: string[]
}

export type TrackedWorkProblem =
  | 'name_required'
  | 'name_too_long'
  | 'goal_required'
  | 'goal_too_long'
  | 'no_members'
  | 'lead_not_member'
  | 'workspace_path_required'

/** Pure validation. Zero RPC: an invalid draft never reaches Core. */
export function trackedWorkProblems(draft: TrackedWorkDraft): TrackedWorkProblem[] {
  const problems: TrackedWorkProblem[] = []
  const name = draft.name.trim()
  if (name === '') problems.push('name_required')
  else if (Array.from(name).length > WORK_TITLE_MAX_CHARS) problems.push('name_too_long')
  const goal = draft.goal.trim()
  if (goal === '') problems.push('goal_required')
  else if (Array.from(goal).length > WORK_GOAL_MAX_CHARS) problems.push('goal_too_long')
  if (draft.memberAgentIds.length === 0) problems.push('no_members')
  else if (!draft.memberAgentIds.includes(draft.defaultLeadAgentId)) problems.push('lead_not_member')
  if (draft.workspace !== null && draft.workspace.projectPath.trim() === '') problems.push('workspace_path_required')
  return problems
}

function trackedWorkProblemMessage(problems: readonly TrackedWorkProblem[]): string {
  const messages = problems.map(problem => {
    switch (problem) {
      case 'name_required': return uiAttribute('请填写这项工作的名称。')
      case 'name_too_long': return uiAttribute('工作名称最多 200 个字符。')
      case 'goal_required': return uiAttribute('请填写这项工作要达成的目标。')
      case 'goal_too_long': return uiAttribute('工作目标最多 12000 个字符。')
      case 'no_members': return uiAttribute('请至少选择一位队员。')
      case 'lead_not_member': return uiAttribute('主负责人必须是已选队员之一。')
      case 'workspace_path_required': return uiAttribute('所选工作目录不可用，请重新选择。')
    }
  })
  return messages.join(' ')
}

// ------------------------------------------------------------- resumable attempt

/** Everything needed to resume an unresolved creation. `commandId` + `command`
 * are the exact stored-command identity Core dedupes on; `missionId`/`threadId`
 * are null until Core confirmed the create was applied. The UI owns and mutates
 * these IDs; this service only reads and returns them. */
export interface ResumableWorkAttempt {
  commandId: string
  command: MissionCreate
  missionId: string | null
  threadId: string | null
}

/** The create signature: two attempts are the same work only if this matches. */
export function workAttemptSignature(attempt: ResumableWorkAttempt): string {
  return JSON.stringify(attempt.command)
}

export function newWorkAttempt(draft: TrackedWorkDraft, commandId = newCommandId()): ResumableWorkAttempt {
  return { commandId, command: trackedWorkCommand(draft), missionId: null, threadId: null }
}

/** Exact `MissionCreate` shape Core's `deny_unknown_fields` parser accepts.
 * `descriptionContent` is never set (description carries the goal), so Core's
 * `mission.ambiguous_description` cannot trigger. */
function trackedWorkCommand(draft: TrackedWorkDraft): MissionCreate {
  return {
    ...(draft.team ? { team: draft.team } : {}),
    title: draft.name.trim(),
    description: draft.goal.trim(),
    projectPath: draft.workspace === null ? '' : draft.workspace.projectPath,
    projectBindingKind: draft.workspace === null ? 'quick_chat' : 'directory',
    memberAgentIds: [...new Set(draft.memberAgentIds)],
    defaultLeadAgentId: draft.defaultLeadAgentId,
    tags: draft.tags ?? []
  }
}

// --------------------------------------------------------------- errors

export class WorkCommandRejected extends Error {
  constructor(public readonly result: StoredCommandResult) {
    super(uiAttribute('主机拒绝了这项操作：{0}', result.code))
    this.name = 'WorkCommandRejected'
  }
}

/** Transport failure, unreadable receipt, or an applied create whose payload
 * did not carry usable IDs. The caller keeps the attempt and retries the exact
 * same commandId; Core replays the stored command instead of duplicating it. */
export class WorkCommandUnknown extends Error {
  constructor(
    message: string,
    public readonly attempt: ResumableWorkAttempt
  ) {
    super(message)
    this.name = 'WorkCommandUnknown'
  }
}

/** Creation was applied (IDs confirmed) but the explicit start did not. The
 * Mission must remain; only the same start commandId may be retried. */
export class WorkStartFailed extends Error {
  constructor(
    message: string,
    public readonly attempt: ResumableWorkAttempt,
    public readonly startCommandId: string,
    public readonly cause?: unknown
  ) {
    super(message)
    this.name = 'WorkStartFailed'
  }
}

// --------------------------------------------------------------- port

export interface WorkPort {
  request<T>(method: CoreMethod, params?: unknown): Promise<T>
}

// --------------------------------------------------------------- classification

type WorkOutcome =
  | { kind: 'ok'; result: StoredCommandResult }
  | { kind: 'rejected'; result: StoredCommandResult }
  | { kind: 'unknown'; message: string }

const UNKNOWN_RECEIPT = uiAttribute('命令回执缺失或无法识别，结果尚未确认。请用相同的命令重试。')

/** A missing or unexpected status is never success. */
function classifyWorkCommand(value: unknown): WorkOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'unknown', message: UNKNOWN_RECEIPT }
  const status = (value as { status?: unknown }).status
  if (status !== 'applied' && status !== 'accepted' && status !== 'rejected') {
    return { kind: 'unknown', message: UNKNOWN_RECEIPT }
  }
  const result = value as StoredCommandResult
  if (result.status === 'rejected') return { kind: 'rejected', result }
  const payload = result.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { kind: 'unknown', message: UNKNOWN_RECEIPT }
  }
  return { kind: 'ok', result }
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value !== '' ? value : null
}

// --------------------------------------------------------------- readback

/** `missions.get` after a confirmed create: identity and binding are read back,
 * never invented. Failure here keeps the applied attempt resumable. */
async function readBackMission(port: WorkPort, missionId: string): Promise<MissionRecord | null> {
  const record = await port.request<MissionRecord | null>('missions.get', { missionId })
  if (!record || typeof record !== 'object' || record.missionId !== missionId) return null
  return record
}

// --------------------------------------------------------------- create

export type TrackedWorkStartStatus = 'not_started' | 'queued' | 'already_running'

export interface TrackedWorkResult {
  missionId: string
  threadId: string
  /** Observed from the readback record; never a fabricated "workspace ready". */
  projectBindingKind: MissionRecord['projectBindingKind']
  /** The start is Core's own queued message; 'queued' is the strongest claim
   * this module ever makes. A ModelRun is never assumed to have begun. */
  start: TrackedWorkStartStatus
}

export interface CreateTrackedWorkOptions {
  /** A previously returned attempt to resume; its create signature must match
   * the current draft exactly or the call is refused. */
  attempt?: ResumableWorkAttempt
  /** Explicit user action only. Absent/false creates without starting. */
  start?: { commandId: string }
}

/**
 * Create a tracked Mission (+Thread) from a user goal. Creation and start are
 * separate commands; `options.start` is the only path to a start, so a
 * create-only call issues one mutation plus a readback and never dispatches work.
 */
export async function createTrackedWork(
  port: WorkPort,
  draft: TrackedWorkDraft,
  options: CreateTrackedWorkOptions = {}
): Promise<{ result: TrackedWorkResult; attempt: ResumableWorkAttempt }> {
  const problems = trackedWorkProblems(draft)
  if (problems.length > 0) throw new Error(trackedWorkProblemMessage(problems))
  const command = trackedWorkCommand(draft)

  let attempt: ResumableWorkAttempt
  let missionId: string
  let threadId: string
  if (options.attempt && options.attempt.missionId !== null && options.attempt.threadId !== null) {
    // Creation is already applied; resume without re-sending it.
    if (workAttemptSignature(options.attempt) !== JSON.stringify(command)) {
      throw new Error(uiAttribute('上次创建结果尚未确认，请恢复原内容并重试。'))
    }
    attempt = options.attempt
    missionId = options.attempt.missionId
    threadId = options.attempt.threadId
  } else {
    if (options.attempt && workAttemptSignature(options.attempt) !== JSON.stringify(command)) {
      throw new Error(uiAttribute('上次创建结果尚未确认，请恢复原内容并重试。'))
    }
    const pending: ResumableWorkAttempt = options.attempt ?? { commandId: newCommandId(), command, missionId: null, threadId: null }
    let outcome: WorkOutcome
    try {
      outcome = classifyWorkCommand(await port.request<StoredCommandResult | null>(
        'missions.create',
        { commandId: pending.commandId, command: pending.command }
      ))
    } catch (error) {
      throw new WorkCommandUnknown(readErrorMessage(error, UNKNOWN_RECEIPT) ?? UNKNOWN_RECEIPT, pending)
    }
    if (outcome.kind === 'unknown') throw new WorkCommandUnknown(outcome.message, pending)
    if (outcome.kind === 'rejected') throw new WorkCommandRejected(outcome.result)
    const payload = outcome.result.payload as Record<string, unknown>
    missionId = payloadString(payload, 'missionId') ?? ''
    threadId = payloadString(payload, 'threadId') ?? ''
    if (missionId === '' || threadId === '') {
      // Applied, but the receipt is unusable. The stored command replays on
      // retry with the same commandId, so nothing is duplicated.
      throw new WorkCommandUnknown(uiAttribute('工作已保存，但返回的标识不完整。请用相同内容重试。'), pending)
    }
    attempt = { ...pending, missionId, threadId }
  }

  const record = await readBackMission(port, missionId).catch(error => {
    throw new WorkCommandUnknown(readErrorMessage(error, uiAttribute('工作读取结果不可用，请重试。')), attempt)
  })
  if (record === null) {
    throw new WorkCommandUnknown(uiAttribute('工作读取结果不可用，请重试。'), attempt)
  }
  if (typeof record.threadId === 'string' && record.threadId !== '') threadId = record.threadId

  let start: TrackedWorkStartStatus = 'not_started'
  if (options.start) {
    start = await startTrackedWork(port, attempt, options.start.commandId)
  }
  return {
    result: {
      missionId,
      threadId,
      projectBindingKind: record.projectBindingKind,
      start
    },
    attempt
  }
}

// --------------------------------------------------------------- start

/**
 * Start an already-created Mission. Core queues exactly one "Start the current
 * Mission." message addressed to the Default Lead; this module sends no message
 * of its own. Retries must reuse the same `startCommandId` so Core's stored
 * command dedupe applies; a failure never recreates the Mission.
 */
export async function startTrackedWork(
  port: WorkPort,
  attempt: ResumableWorkAttempt,
  startCommandId: string
): Promise<TrackedWorkStartStatus> {
  if (attempt.missionId === null || attempt.threadId === null) {
    throw new WorkStartFailed(uiAttribute('这项工作尚未创建成功，不能开始。'), attempt, startCommandId)
  }
  if (startCommandId.trim() === '') {
    throw new WorkStartFailed(uiAttribute('开始命令缺少稳定标识，请重新操作。'), attempt, startCommandId)
  }
  let outcome: WorkOutcome
  try {
    outcome = classifyWorkCommand(await port.request<StoredCommandResult | null>(
      'missions.start',
      { commandId: startCommandId, command: { missionId: attempt.missionId } }
    ))
  } catch (error) {
    throw new WorkStartFailed(readErrorMessage(error, UNKNOWN_RECEIPT) ?? UNKNOWN_RECEIPT, attempt, startCommandId, error)
  }
  if (outcome.kind === 'unknown') {
    throw new WorkStartFailed(outcome.message, attempt, startCommandId)
  }
  if (outcome.kind === 'rejected') {
    throw new WorkStartFailed(uiAttribute('工作已创建，暂时未能开始：{0}', outcome.result.code), attempt, startCommandId)
  }
  // `mission.started` comes back as `accepted` (queued), `mission.already_running`
  // as `applied`. Anything else applied is still only ever "queued" at best.
  if (outcome.result.code === 'mission.already_running') return 'already_running'
  return 'queued'
}

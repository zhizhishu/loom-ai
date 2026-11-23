import type {
  ActionApprovalView,
  AgentProfile,
  HiddenThreadItem,
  CoreMethod,
  CreateThreadRequest,
  MemberPresence,
  NavigationSnapshot,
  NewConversationDefaults,
  StoredCommandResult,
  ThreadCreationPreflight,
  ThreadMemberRemovalPreview,
  ThreadSnapshot,
  WorkspaceInspection,
  WorkspaceSelection
} from '@contracts'
import { newCommandId } from '../../../shared/command-id'
import { readErrorMessage } from '../error-message'
import { uiAttribute } from '../interface-language'
import { isNewConversationMemberAvailable } from '../new-conversation-availability'
import type { BusinessEnvironment } from '../business-environment'
import { LoomCommandRejected, loomCommandMessage } from './service'

export const ROOM_NAME_MAX_LENGTH = 80
export const ROOM_COLLABORATION_MODE = 'peer' as const

// ------------------------------------------------------------------- port

/** The only host surface this module needs. Desktop and Web both supply it. */
export interface RoomPort {
  request<T>(method: CoreMethod, params?: unknown): Promise<T>
  selectWorkspaceDirectory(): Promise<WorkspaceSelection | null>
  registerProject(projectPath: string): Promise<void>
  /** True when the host owns a native directory dialog; Web browses the Host instead. */
  readonly nativeDirectoryPicker: boolean
}

export function roomPort(environment: BusinessEnvironment): RoomPort {
  return {
    request: <T,>(method: CoreMethod, params?: unknown): Promise<T> => environment.client.request<T>(method, params),
    selectWorkspaceDirectory: () => environment.selectWorkspaceDirectory(),
    registerProject: async (projectPath: string) => {
      await environment.preferences.navigationPreferences.registerProjects([projectPath])
    },
    nativeDirectoryPicker: environment.desktop !== undefined
  }
}

// ------------------------------------------------------------------ draft

/** Provider-neutral room draft. A group is one primary Lead plus an explicit participant roster. */
export interface RoomDraft {
  name: string | null
  memberAgentIds: string[]
  leadAgentId: string
  workspace: WorkspaceSelection | null
  collaborationMode: typeof ROOM_COLLABORATION_MODE
}

export type RoomDraftProblem =
  | 'no_members'
  | 'lead_not_member'
  | 'member_unavailable'
  | 'name_too_long'
  | 'name_required'
  | 'group_members_required'
  | 'direct_single_member'

export type RoomCreationMode = 'direct' | 'group'

export function emptyRoomDraft(): RoomDraft {
  return {
    name: null,
    memberAgentIds: [],
    leadAgentId: '',
    workspace: null,
    collaborationMode: ROOM_COLLABORATION_MODE
  }
}

export function normalizeRoomName(value: string | null): string | null {
  if (value === null) return null
  const normalized = value.trim().replace(/\s+/gu, ' ')
  return normalized === '' ? null : normalized
}

/** Conversation membership requires a present identity, not a running model.
 * Core create_camp_in_tx checks profile_status == present; execution admission
 * is a separate gate on sending. Users can assemble a team before configuring it. */
function roomMemberAvailable(agent: AgentProfile): boolean {
  return agent.presence === 'present' && agent.removedAt === null
}

export function roomDraftProblems(draft: RoomDraft, agents: readonly AgentProfile[]): RoomDraftProblem[] {
  const problems: RoomDraftProblem[] = []
  const name = normalizeRoomName(draft.name)
  if (name !== null && Array.from(name).length > ROOM_NAME_MAX_LENGTH) problems.push('name_too_long')
  if (draft.memberAgentIds.length === 0) {
    problems.push('no_members')
  } else if (!draft.memberAgentIds.includes(draft.leadAgentId)) {
    problems.push('lead_not_member')
  }
  const byId = new Map(agents.map(agent => [agent.agentId, agent] as const))
  const unavailable = draft.memberAgentIds.some(agentId => {
    const agent = byId.get(agentId)
    return !agent || !roomMemberAvailable(agent)
  })
  if (unavailable) problems.push('member_unavailable')
  return problems
}

export function roomDraftProblemMessage(problems: readonly RoomDraftProblem[]): string {
  const messages = problems.map(problem => {
    switch (problem) {
      case 'no_members': return uiAttribute('请至少选择一位队员。')
      case 'lead_not_member': return uiAttribute('队长必须是已选队员之一。')
      case 'member_unavailable': return uiAttribute('所选队员已不可用，请重新选择。')
      case 'name_required': return uiAttribute('请填写群聊名称。')
      case 'group_members_required': return uiAttribute('群聊至少需要 2 位不同的助手。')
      case 'direct_single_member': return uiAttribute('单聊只能选择一位助手，多位助手请使用群聊。')
      case 'name_too_long': return uiAttribute('对话名称最多 80 个字符。')
    }
  })
  return messages.join(' ')
}

/** 省略 `mode` 时按名单推断：一位助手是单聊（新建助手后直开对话），多位才是群聊。 */
function inferredRoomMode(draft: RoomDraft): RoomCreationMode {
  return new Set(draft.memberAgentIds).size > 1 ? 'group' : 'direct'
}

/** 群聊多一层：至少两位不同助手、名称不能为空。显式单聊只能是 1:1，多位不同助手必须走群聊，不能借单聊绕过群聊校验。 */
export function roomDraftProblemsForMode(
  mode: RoomCreationMode,
  draft: RoomDraft,
  agents: readonly AgentProfile[]
): RoomDraftProblem[] {
  const problems = roomDraftProblems(draft, agents)
  const distinctMembers = new Set(draft.memberAgentIds).size
  if (mode === 'group') {
    const groupProblems = problems.filter(problem => problem !== 'no_members')
    if (distinctMembers < 2) groupProblems.push('group_members_required')
    if (normalizeRoomName(draft.name) === null) groupProblems.push('name_required')
    return groupProblems
  }
  if (distinctMembers > 1) problems.push('direct_single_member')
  return problems
}

/** 群聊缺东西时主按钮置灰，这句原因同时写在按钮旁边；`mode` 为 null 只跑通用规则。 */
export function roomSubmitProblem(
  draft: RoomDraft,
  agents: readonly AgentProfile[],
  preflight: ThreadCreationPreflight | null,
  mode: RoomCreationMode | null = null
): string | null {
  if (preflight !== null && !preflight.admissible) {
    return uiAttribute('当前主机还没有可用助手。请先新建或启用一位助手。')
  }
  const problems = mode === null ? roomDraftProblems(draft, agents) : roomDraftProblemsForMode(mode, draft, agents)
  return problems.length === 0 ? null : roomDraftProblemMessage(problems)
}

/**
 * Default is one Lead only. A saved team may pre-fill several members, but a group is never
 * assembled by selecting every assistant: the user checks each participant explicitly.
 */
export function initialRoomDraft(
  preflight: ThreadCreationPreflight,
  preferred: NewConversationDefaults | null = null
): RoomDraft {
  const availableIds = preflight.presentMembers
    .filter(isNewConversationMemberAvailable)
    .map(member => member.agentId)
  const preferredIds = preferred === null
    ? []
    : [...new Set(preferred.memberAgentIds.filter(agentId => availableIds.includes(agentId)))]
  if (preferred !== null && preferredIds.length > 0) {
    const preferredLead = preferredIds.includes(preferred.defaultLeadAgentId)
      ? preferred.defaultLeadAgentId
      : preferredIds[0]
    return { ...emptyRoomDraft(), memberAgentIds: preferredIds, leadAgentId: preferredLead }
  }
  const leadId = preflight.initialLeadAgentId !== null && availableIds.includes(preflight.initialLeadAgentId)
    ? preflight.initialLeadAgentId
    : availableIds[0] ?? ''
  return { ...emptyRoomDraft(), memberAgentIds: leadId === '' ? [] : [leadId], leadAgentId: leadId }
}

// -------------------------------------------------------------- assistants

export interface RoomAssistantChoice {
  agentId: string
  displayName: string
  teamRole: string
  avatarRef: string | null
  available: boolean
  isLead: boolean
}

export function roomAssistantChoices(
  preflight: ThreadCreationPreflight,
  draft: RoomDraft,
  agents: readonly AgentProfile[]
): RoomAssistantChoice[] {
  const byId = new Map(agents.map(agent => [agent.agentId, agent] as const))
  return preflight.presentMembers.map(member => {
    const profile = byId.get(member.agentId)
    const available = isNewConversationMemberAvailable(member)
      && profile !== undefined
      && roomMemberAvailable(profile)
    return {
      agentId: member.agentId,
      displayName: profile?.displayName ?? member.displayName,
      teamRole: profile?.teamRole ?? '',
      avatarRef: profile?.avatarRef ?? null,
      available,
      isLead: draft.leadAgentId === member.agentId
    }
  })
}

// --------------------------------------------------------------- workspace

export type RoomWorkspaceChoice =
  | { kind: 'quick_chat' }
  | { kind: 'project'; projectKey: string; name: string; projectPath: string }

export const QUICK_CHAT_CHOICE: RoomWorkspaceChoice = { kind: 'quick_chat' }

export function roomWorkspaceChoices(navigation: NavigationSnapshot): RoomWorkspaceChoice[] {
  const projects = Array.isArray(navigation.projects) ? navigation.projects : []
  return [QUICK_CHAT_CHOICE, ...projects.map(project => ({
    kind: 'project' as const,
    projectKey: project.projectKey,
    name: project.name,
    projectPath: project.projectPath
  }))]
}

/** Only a directory the Host already reported may become a draft workspace. */
export function applyKnownWorkspace(draft: RoomDraft, choice: RoomWorkspaceChoice): RoomDraft {
  if (choice.kind === 'quick_chat') return { ...draft, workspace: null }
  if (typeof choice.projectPath !== 'string' || choice.projectPath.trim() === '') {
    throw new Error(uiAttribute('项目目录不可用，请重新选择。'))
  }
  return { ...draft, workspace: { name: choice.name, projectPath: choice.projectPath } }
}

/**
 * The native Desktop dialog and the Web Host picker both resolve through this one call, so a
 * typed path can never enter a draft. A cancelled picker leaves the draft untouched.
 */
export async function chooseRoomWorkspace(port: RoomPort, draft: RoomDraft): Promise<RoomDraft> {
  const selection = await port.selectWorkspaceDirectory()
  if (selection === null) return draft
  if (!selection || typeof selection.projectPath !== 'string' || selection.projectPath.trim() === '') {
    throw new Error(uiAttribute('所选目录不可用，请重新选择。'))
  }
  return { ...draft, workspace: { name: selection.name, projectPath: selection.projectPath } }
}

/** Read-only Git observation. Never invented: a failed or mismatched read yields null. */
export async function inspectRoomWorkspace(port: RoomPort, projectPath: string): Promise<WorkspaceInspection | null> {
  const path = projectPath.trim()
  if (path === '') return null
  try {
    const inspection = await port.request<WorkspaceInspection | null>('workspaces.inspect', { path })
    if (!inspection || typeof inspection !== 'object' || inspection.projectPath !== path) return null
    return inspection
  } catch {
    return null
  }
}

// --------------------------------------------------------------- commands

export type RoomCommandOutcome =
  | { kind: 'ok'; result: StoredCommandResult }
  | { kind: 'rejected'; result: StoredCommandResult }
  | { kind: 'unknown'; message: string }

const UNKNOWN_COMMAND_RESULT = uiAttribute('命令回执缺失或无法识别，结果尚未确认。请用相同的命令重试。')

/** A missing or unexpected status is never success. */
export function classifyRoomCommand(value: unknown): RoomCommandOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'unknown', message: UNKNOWN_COMMAND_RESULT }
  }
  const result = value as { status?: unknown; payload?: unknown }
  if (result.status !== 'applied' && result.status !== 'accepted' && result.status !== 'rejected') {
    return { kind: 'unknown', message: UNKNOWN_COMMAND_RESULT }
  }
  const command = value as StoredCommandResult
  if (result.status === 'rejected') return { kind: 'rejected', result: command }
  if (!result.payload || typeof result.payload !== 'object' || Array.isArray(result.payload)) {
    return { kind: 'unknown', message: UNKNOWN_COMMAND_RESULT }
  }
  return { kind: 'ok', result: command }
}

function stringField(payload: Record<string, unknown> | undefined, key: string): string | null {
  if (!payload) return null
  const value = payload[key]
  return typeof value === 'string' && value !== '' ? value : null
}

export function roomCreateParams(draft: RoomDraft, commandId: string): CreateThreadRequest {
  return {
    commandId,
    name: normalizeRoomName(draft.name),
    workspace: draft.workspace === null ? null : { projectPath: draft.workspace.projectPath },
    memberAgentIds: [...new Set(draft.memberAgentIds)],
    defaultLeadAgentId: draft.leadAgentId,
    collaborationMode: ROOM_COLLABORATION_MODE,
    activationState: 'active'
  }
}

export interface RoomCreateResult {
  threadId: string
  /** Present when the Thread was created but the optional project registration failed. */
  registrationWarning: string | null
}

/**
 * `commandId` is reusable: after an ambiguous outcome the UI resubmits the same identity instead
 * of creating a second Thread. Validation runs against the actual member profiles first, so an
 * invalid draft never reaches Core. Omitting `mode` infers it from the roster, so the mode-less
 * one-assistant onboarding call stays 1:1 while several assistants get the group rules. An explicit
 * `direct` mode with more than one distinct assistant is rejected here, before `threads.create`, so
 * it can never smuggle a multi-assistant Thread past the group validation.
 */
export async function createRoom(
  port: RoomPort,
  draft: RoomDraft,
  agents: readonly AgentProfile[],
  commandId?: string,
  mode?: RoomCreationMode
): Promise<RoomCreateResult> {
  const problems = roomDraftProblemsForMode(mode ?? inferredRoomMode(draft), draft, agents)
  if (problems.length > 0) throw new Error(roomDraftProblemMessage(problems))
  const params = roomCreateParams(draft, commandId ?? newCommandId())
  const outcome = classifyRoomCommand(await port.request<StoredCommandResult | null>('threads.create', params))
  if (outcome.kind === 'unknown') throw new Error(outcome.message)
  if (outcome.kind === 'rejected') throw new LoomCommandRejected(outcome.result)
  const threadId = stringField(outcome.result.payload, 'threadId')
  if (!threadId) throw new Error(uiAttribute('会话已创建，但暂时无法打开。请刷新会话列表后重试。'))
  let registrationWarning: string | null = null
  if (params.workspace) {
    try {
      await port.registerProject(params.workspace.projectPath)
    } catch {
      // The Thread exists in Core; only the optional project list entry failed.
      registrationWarning = uiAttribute('对话已创建，但项目目录未登记，可能不会出现在项目列表中。')
    }
  }
  return { threadId, registrationWarning }
}

export function readRoomCreationPreflight(port: RoomPort): Promise<ThreadCreationPreflight> {
  return port.request<ThreadCreationPreflight | null>('threads.creationPreflight').then(preflight => {
    if (!preflight || typeof preflight !== 'object' || !Array.isArray(preflight.presentMembers)) {
      throw new Error(uiAttribute('队员名单读取结果不可用，请重试。'))
    }
    return preflight
  })
}

// ---------------------------------------------------------------- members

export interface RoomMemberAddFailure {
  agentId: string
  message: string
}

export interface RoomMemberAddOutcome {
  addedAgentIds: string[]
  unchangedAgentIds: string[]
  failures: RoomMemberAddFailure[]
}

export interface RoomMemberAddInput {
  threadId: string
  agentIds: readonly string[]
  membershipGeneration: number
}

export function roomMemberAddParams(
  commandId: string,
  threadId: string,
  agentId: string,
  expectedMembershipGeneration: number
): unknown {
  return { commandId, command: { threadId, agentId, expectedMembershipGeneration } }
}

function roomMembershipConflict(code: string): boolean {
  return code === 'camp.membership_generation_conflict'
    || code === 'camp.membership_version_conflict'
    || code === 'camp.member_not_found'
    || code === 'camp.member_not_active'
}

/**
 * Inviting is not dispatch. This issues one CAS command per member, carries the generation Core
 * actually returned, and stops instead of guessing when that generation is unknown or conflicts.
 * It never sends a message and never force-adds.
 */
export async function addRoomMembers(
  port: RoomPort,
  input: RoomMemberAddInput
): Promise<RoomMemberAddOutcome> {
  const threadId = input.threadId.trim()
  if (threadId === '') throw new Error(uiAttribute('当前会话尚未准备好。'))
  if (!Number.isInteger(input.membershipGeneration) || input.membershipGeneration < 1) {
    throw new Error(uiAttribute('名册版本未知，请重新读取会话后再试。'))
  }
  const agentIds = [...new Set(input.agentIds.filter(agentId => typeof agentId === 'string' && agentId !== ''))]
  const outcome: RoomMemberAddOutcome = { addedAgentIds: [], unchangedAgentIds: [], failures: [] }
  let generation = input.membershipGeneration
  for (let index = 0; index < agentIds.length; index += 1) {
    const agentId = agentIds[index]
    let step: RoomCommandOutcome
    try {
      step = classifyRoomCommand(await port.request<StoredCommandResult | null>(
        'threads.members.add',
        roomMemberAddParams(newCommandId(), threadId, agentId, generation)
      ))
    } catch (error) {
      step = { kind: 'unknown', message: readErrorMessage(error) }
    }
    const stop = (message: string): void => {
      outcome.failures.push({ agentId, message })
      for (const remaining of agentIds.slice(index + 1)) outcome.failures.push({ agentId: remaining, message })
    }
    if (step.kind === 'unknown') {
      stop(step.message)
      break
    }
    if (step.kind === 'rejected') {
      if (roomMembershipConflict(step.result.code)) {
        stop(uiAttribute('名册已发生变化，请在刷新后重试。'))
        break
      }
      outcome.failures.push({ agentId, message: loomCommandMessage(step.result) })
      continue
    }
    const nextGeneration = step.result.payload.membershipGeneration
    if (typeof nextGeneration !== 'number' || !Number.isInteger(nextGeneration) || nextGeneration < generation) {
      stop(uiAttribute('名册版本未确认，已停止继续邀请。请重新读取会话后再试。'))
      break
    }
    generation = nextGeneration
    if (step.result.payload.changed === false) outcome.unchangedAgentIds.push(agentId)
    else outcome.addedAgentIds.push(agentId)
  }
  return outcome
}

// ------------------------------------------------------------------- lead

export interface RoomLeadChangeInput {
  threadId: string
  successorAgentId: string
  expectedVersion: number
}

export function roomLeadChangeParams(commandId: string, input: RoomLeadChangeInput): unknown {
  return {
    commandId,
    command: {
      threadId: input.threadId,
      successorAgentId: input.successorAgentId,
      expectedVersion: input.expectedVersion
    }
  }
}

/** Changing the primary Lead is Core's existing command; it never grants a new role or permission. */
export async function changeRoomLead(port: RoomPort, input: RoomLeadChangeInput): Promise<void> {
  const threadId = input.threadId.trim()
  const successorAgentId = input.successorAgentId.trim()
  if (threadId === '') throw new Error(uiAttribute('当前会话尚未准备好。'))
  if (successorAgentId === '') throw new Error(uiAttribute('请选择一位队长。'))
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error(uiAttribute('会话版本未知，请重新读取会话后再试。'))
  }
  const outcome = classifyRoomCommand(await port.request<StoredCommandResult | null>(
    'threads.changeDefaultLead',
    roomLeadChangeParams(newCommandId(), { ...input, threadId, successorAgentId })
  ))
  if (outcome.kind === 'unknown') throw new Error(outcome.message)
  if (outcome.kind === 'rejected') throw new LoomCommandRejected(outcome.result)
}

// --------------------------------------------------------------- removal

/**
 * Core's read-only impact statement (`camp-membership-v1` §2). It is not an authorization:
 * the command re-validates inside its transaction, and the CAS values it must carry come from
 * this exact preview, never from a number the renderer added up itself.
 */
export type RoomMemberRemovalPreview = ThreadMemberRemovalPreview

export function roomMemberRemovalPreviewParams(threadId: string, agentId: string): unknown {
  return { threadId, agentId }
}

const REMOVAL_PREVIEW_UNREADABLE = uiAttribute('成员影响预览读取结果不可用，请重新读取会话后再试。')

/** A preview that is not provably this member of this Thread is never a usable one. */
export async function readRoomMemberRemovalPreview(
  port: RoomPort,
  threadId: string,
  agentId: string
): Promise<RoomMemberRemovalPreview> {
  const value = await port.request<ThreadMemberRemovalPreview | null>(
    'threads.members.removalPreview',
    roomMemberRemovalPreviewParams(threadId, agentId)
  )
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(REMOVAL_PREVIEW_UNREADABLE)
  if (value.threadId !== threadId || value.agentId !== agentId) throw new Error(REMOVAL_PREVIEW_UNREADABLE)
  if (!Number.isInteger(value.membershipGeneration) || value.membershipGeneration < 1) throw new Error(REMOVAL_PREVIEW_UNREADABLE)
  if (!Number.isInteger(value.membershipVersion) || value.membershipVersion < 1) throw new Error(REMOVAL_PREVIEW_UNREADABLE)
  if (typeof value.removable !== 'boolean') throw new Error(REMOVAL_PREVIEW_UNREADABLE)
  return value
}

/** The primary Lead may not be removed on its own: the group needs another Lead first. */
export const ROOM_LEAD_REMOVAL_BLOCKED = uiAttribute('当前主助手不能直接移出，请先把另一位助手设为主助手。')

export interface RoomMemberRemoveInput {
  threadId: string
  agentIds: readonly string[]
  /** 批内允许主助手在没有继任者时也移出。M9-1c 后「退出群聊」不再走这里：它只隐藏，
   * 移出助手始终是逐个人的显式动作，所以这条路径默认关闭，也只有显式调用者才打开。 */
  allowLeadWithoutSuccessor?: boolean
}

/** No replacement is ever invented here: `changeRoomLead` hands the group over first. */
export function roomMemberRemoveParams(commandId: string, preview: RoomMemberRemovalPreview): unknown {
  return {
    commandId,
    command: {
      threadId: preview.threadId,
      agentId: preview.agentId,
      expectedMembershipGeneration: preview.membershipGeneration,
      expectedMembershipVersion: preview.membershipVersion
    }
  }
}

export interface RoomMemberRemoveFailure {
  agentId: string
  message: string
}

export interface RoomMemberRemoveOutcome {
  removedAgentIds: string[]
  failures: RoomMemberRemoveFailure[]
  /** The assistant Core handed the group to, when the removed member was the Lead. */
  nextDefaultLeadAgentId: string | null
}

function roomMemberRemovalConflict(code: string): boolean {
  return roomMembershipConflict(code)
    || code === 'camp.default_lead_unavailable'
    || code === 'camp.default_lead_replacement_not_applicable'
}

function removalAdvanced(step: StoredCommandResult, preview: RoomMemberRemovalPreview): boolean {
  const next = step.payload.membershipGeneration
  return typeof next === 'number' && Number.isInteger(next) && next > preview.membershipGeneration
}

/**
 * Removing is not dispatch. Every removal advances the Camp generation, so each step reads a fresh
 * preview and submits exactly its generation and the member's own version. A conflict or an
 * unreadable receipt stops the batch instead of guessing what the roster now is.
 */
export async function removeRoomMembers(
  port: RoomPort,
  input: RoomMemberRemoveInput
): Promise<RoomMemberRemoveOutcome> {
  const threadId = input.threadId.trim()
  if (threadId === '') throw new Error(uiAttribute('当前会话尚未准备好。'))
  const agentIds = [...new Set(input.agentIds.filter(agentId => typeof agentId === 'string' && agentId !== ''))]
  const outcome: RoomMemberRemoveOutcome = { removedAgentIds: [], failures: [], nextDefaultLeadAgentId: null }
  for (let index = 0; index < agentIds.length; index += 1) {
    const agentId = agentIds[index]
    const stop = (message: string): void => {
      outcome.failures.push({ agentId, message })
      for (const remaining of agentIds.slice(index + 1)) outcome.failures.push({ agentId: remaining, message })
    }
    // Every removal advances the Camp generation, so the CAS values come from a fresh preview;
    // an unreadable preview stops the batch instead of guessing the roster.
    const read: { preview: RoomMemberRemovalPreview } | { failure: string } =
      await readRoomMemberRemovalPreview(port, threadId, agentId).then(
        value => ({ preview: value }),
        error => ({ failure: readErrorMessage(error) })
      )
    if ('failure' in read) {
      stop(read.failure)
      break
    }
    const preview = read.preview
    if (!preview.removable) {
      outcome.failures.push({ agentId, message: uiAttribute('该助手已不在群里，请刷新后重试。') })
      continue
    }
    if (preview.isDefaultLead && input.allowLeadWithoutSuccessor !== true) {
      stop(ROOM_LEAD_REMOVAL_BLOCKED)
      break
    }
    let step: RoomCommandOutcome
    try {
      step = classifyRoomCommand(await port.request<StoredCommandResult | null>(
        'threads.members.remove',
        roomMemberRemoveParams(newCommandId(), preview)
      ))
    } catch (error) {
      step = { kind: 'unknown', message: readErrorMessage(error) }
    }
    if (step.kind === 'unknown') {
      stop(step.message)
      break
    }
    if (step.kind === 'rejected') {
      if (roomMemberRemovalConflict(step.result.code)) {
        stop(uiAttribute('名册已发生变化，请在刷新后重试。'))
        break
      }
      outcome.failures.push({ agentId, message: loomCommandMessage(step.result) })
      continue
    }
    if (!removalAdvanced(step.result, preview)) {
      stop(uiAttribute('名册版本未确认，已停止继续移出。请重新读取会话后再试。'))
      break
    }
    outcome.removedAgentIds.push(agentId)
    const nextLead = step.result.payload.nextDefaultLeadAgentId
    if (typeof nextLead === 'string' && nextLead !== '') outcome.nextDefaultLeadAgentId = nextLead
  }
  return outcome
}

// ----------------------------------------------------------------- hidden

/**
 * 退出群聊 = 把这个群从**我的列表**隐藏（M9-1c，Hark 拍板；即 Mikka 群行的 `hidden`）。
 *
 * 群、成员、消息、附件与历史全部保留；助手不会因此离队 —— 把一个助手移出群聊仍然走
 * `threads.members.remove`（`camp_member.status = 'left'`），不经过这里。
 * 恢复就是同一个开关的 `hidden:false`，`已隐藏`列表由 `threads.hiddenList` 只读给出。
 */
export interface RoomHideInput {
  threadId: string
  hidden: boolean
}

export function roomHideParams(commandId: string, input: RoomHideInput): unknown {
  return { commandId, command: { threadId: input.threadId, hidden: input.hidden } }
}

/**
 * Core's answer is the only proof the list changed: a receipt that does not carry back the exact
 * flag that was asked for is unknown, never success.
 */
export async function setRoomHidden(port: RoomPort, input: RoomHideInput): Promise<void> {
  const threadId = input.threadId.trim()
  if (threadId === '') throw new Error(uiAttribute('当前会话尚未准备好。'))
  const outcome = classifyRoomCommand(await port.request<StoredCommandResult | null>(
    'threads.setHidden',
    roomHideParams(newCommandId(), { ...input, threadId })
  ))
  if (outcome.kind === 'unknown') throw new Error(outcome.message)
  if (outcome.kind === 'rejected') throw new LoomCommandRejected(outcome.result)
  const hidden = outcome.result.payload.hidden
  if (typeof hidden !== 'boolean' || hidden !== input.hidden) {
    throw new Error(uiAttribute('隐藏结果未确认，请刷新会话列表后重试。'))
  }
}

const HIDDEN_LIST_UNREADABLE = uiAttribute('已隐藏列表读取结果不可用，请重试。')

/** `已隐藏` 列表：只读。回执不是数组时是读取失败，不是一个空列表。 */
export async function readHiddenRooms(port: RoomPort): Promise<HiddenThreadItem[]> {
  const rows = await port.request<HiddenThreadItem[] | null>('threads.hiddenList')
  if (!Array.isArray(rows)) throw new Error(HIDDEN_LIST_UNREADABLE)
  return rows.filter(row => Boolean(row)
    && typeof row.id === 'string' && row.id !== ''
    && typeof row.title === 'string'
    && typeof row.hiddenAt === 'string')
}

// ----------------------------------------------------------------- roster

export interface RoomRosterEntry {
  agentId: string
  displayName: string
  avatarRef: string | null
  teamRole: string
  presence: MemberPresence
  membershipStatus: 'active' | 'left'
  isPrimaryLead: boolean
}

/** Primary Lead plus participants. Presentation only: no permission role is introduced. */
export interface RoomRoster {
  primaryLeadAgentId: string | null
  participants: RoomRosterEntry[]
}

export function roomRoster(snapshot: ThreadSnapshot): RoomRoster {
  const primaryLeadAgentId = snapshot.thread.defaultLeadAgentId
  const participants = snapshot.members
    .filter(member => member.membershipStatus === 'active')
    .map(member => ({
      agentId: member.agentId,
      displayName: member.displayName,
      avatarRef: member.avatarRef,
      teamRole: member.teamRole,
      presence: member.profilePresence,
      membershipStatus: member.membershipStatus,
      isPrimaryLead: primaryLeadAgentId !== null && member.agentId === primaryLeadAgentId
    }))
  return {
    primaryLeadAgentId: participants.some(entry => entry.isPrimaryLead) ? primaryLeadAgentId : null,
    participants
  }
}

// ------------------------------------------------------------ permissions

export type RoomPermissionKind = 'allow_once' | 'allow_session' | 'deny' | 'cancel' | 'other'

export interface RoomPermissionChoice {
  optionId: string
  kind: RoomPermissionKind
  label: string
  consequence: string
  /** Only Core's own scope: `allow_session` stays session-scoped and is never permanent. */
  scope: 'once' | 'session' | null
}

const ROOM_PERMISSION_KINDS: readonly RoomPermissionKind[] = ['allow_once', 'allow_session', 'deny', 'cancel', 'other']

/** Verbatim Core approval options for a pending request. Nothing is synthesized. */
export function roomPermissionChoices(approval: ActionApprovalView): RoomPermissionChoice[] {
  if (approval.status !== 'pending') return []
  return approval.options.map(option => {
    if (!ROOM_PERMISSION_KINDS.includes(option.kind)) {
      throw new Error(uiAttribute('授权选项无法识别，请刷新后重试。'))
    }
    return {
      optionId: option.optionId,
      kind: option.kind,
      label: option.label,
      consequence: option.consequence,
      scope: option.kind === 'allow_once' ? 'once' : option.kind === 'allow_session' ? 'session' : null
    }
  })
}

export interface RoomPermissionResolveInput {
  threadId: string
  approval: ActionApprovalView
  optionId: string
  reason?: string
}

export function roomPermissionParams(commandId: string, input: RoomPermissionResolveInput): unknown {
  return {
    commandId,
    threadId: input.threadId,
    approvalId: input.approval.id,
    expectedVersion: input.approval.version,
    optionId: input.optionId,
    reason: input.reason ?? uiAttribute('用户选择原生选项：{0}。', input.optionId)
  }
}

export async function resolveRoomPermission(
  port: RoomPort,
  input: RoomPermissionResolveInput
): Promise<StoredCommandResult> {
  const threadId = input.threadId.trim()
  if (threadId === '') throw new Error(uiAttribute('当前会话尚未准备好。'))
  if (input.approval.status !== 'pending') throw new Error(uiAttribute('这条授权已处理，无需重复确认。'))
  if (!input.approval.options.some(option => option.optionId === input.optionId)) {
    throw new Error(uiAttribute('所选授权选项不属于当前请求，请刷新后重试。'))
  }
  const outcome = classifyRoomCommand(await port.request<StoredCommandResult | null>(
    'action.approvals.resolve',
    roomPermissionParams(newCommandId(), { ...input, threadId })
  ))
  if (outcome.kind === 'unknown') throw new Error(outcome.message)
  if (outcome.kind === 'rejected') throw new LoomCommandRejected(outcome.result)
  return outcome.result
}

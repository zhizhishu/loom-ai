import type {
  AdapterInstallation,
  AdapterKind,
  AgentProfile,
  CreateAgentProfileCommand,
  MemberRuntimeConfiguration,
  ModelDescriptor,
  ModelSelection,
  AdapterPermissionConfig,
  PermissionOptionDescriptor,
  StoredCommandResult,
  UpdateAgentProfileCommand
} from '@contracts'
import { newCommandId } from '../../../shared/command-id'
import type { ThreadClient } from '../camp-client'
import {
  identityCommand,
  identityDraftFor,
  identityDraftIssue,
  type IdentityDraft
} from '../member-identity-draft'
import { assertApplied } from '../member-runtime-commands'
import { uiAttribute } from '../interface-language'

/**
 * LOOM assistant service: the single place that reads and writes what the native UI
 * calls an "assistant" (a Core AgentProfile plus its own Runtime configuration).
 *
 * Every Runtime fact here comes from a real `runtime.installations.list` row or from
 * the assistant's own persisted configuration. Nothing is installed, no global model
 * or permission default is changed, and no alternate Runtime or model is substituted.
 */

type Reader = Pick<ThreadClient, 'request'>

// ------------------------------------------------------------- runtime registry

/**
 * The four Runtime choices this surface offers. Exact Core AdapterKind ids only.
 * Pi is first because it is LOOM's built-in primary assistant, not because any
 * installation is certain: being listed first never claims a package is present.
 */
export const ASSISTANT_RUNTIME_KINDS = [
  'pi',
  'claude-code-cli',
  'codex-cli',
  'deepseek-harness'
] as const

export type AssistantRuntimeKind = (typeof ASSISTANT_RUNTIME_KINDS)[number]

export type AssistantTransportKind = 'native-cli' | 'embedded-pi'

export type AssistantRuntimePort = {
  kind: AssistantRuntimeKind
  /** Product name only. Installation state is never part of the registry. */
  label: string
  /** How the Host carries a turn today: a native CLI process it launches itself. */
  transport: AssistantTransportKind
  /**
   * The optional bundled launcher uses the same Pi protocol. Actual package
   * availability is a Host observation, never a constant in the UI registry.
   */
  embedded: { transport: 'embedded-pi'; availability: 'from-host' } | null
  /**
   * Pi is the built-in primary assistant's default brain
   * (`docs/loom/LOOM-ARCHITECTURE.md:143`: 主助手默认大脑). Like `label`, this is
   * product placement, never a claim that the package or launcher exists.
   */
  builtinPrimary: boolean
}

export const ASSISTANT_RUNTIME_REGISTRY: Readonly<
  Record<AssistantRuntimeKind, AssistantRuntimePort>
> = {
  pi: {
    kind: 'pi',
    label: 'Pi',
    transport: 'native-cli',
    embedded: { transport: 'embedded-pi', availability: 'from-host' },
    builtinPrimary: true
  },
  'claude-code-cli': {
    kind: 'claude-code-cli',
    label: 'Claude Code',
    transport: 'native-cli',
    embedded: null,
    builtinPrimary: false
  },
  'codex-cli': {
    kind: 'codex-cli',
    label: 'Codex CLI',
    transport: 'native-cli',
    embedded: null,
    builtinPrimary: false
  },
  'deepseek-harness': {
    kind: 'deepseek-harness',
    label: 'DSH',
    transport: 'native-cli',
    embedded: null,
    builtinPrimary: false
  }
}

/** Registry facts for a listed kind; `null` for every Runtime outside the registry. */
export function assistantRuntimePort(kind: AdapterKind): AssistantRuntimePort | null {
  return Object.hasOwn(ASSISTANT_RUNTIME_REGISTRY, kind)
    ? ASSISTANT_RUNTIME_REGISTRY[kind as AssistantRuntimeKind]
    : null
}

// ------------------------------------------------------------ runtime catalogue

/**
 * One selectable Runtime, carrying the installation the selector must show.
 * `installation === null` is the only honest statement when the Host reports none.
 */
export type AssistantRuntimeOption = {
  kind: AssistantRuntimeKind
  label: string
  installation: AdapterInstallation | null
  /** True only when a real enabled installation carries matching defaults. */
  usable: boolean
  models: ModelDescriptor[]
  permissionOptions: PermissionOptionDescriptor[]
  /** Current probe schema first; the installation's own default schema otherwise. */
  permissionSchemaVersion: number | null
  defaults: MemberRuntimeConfiguration | null
}

/**
 * The member-usable installation for one kind, matching the rule the member editor
 * already uses: a managed default installation in the default auth scope.
 */
export function assistantRuntimeInstallation(
  installations: readonly AdapterInstallation[],
  kind: AssistantRuntimeKind
): AdapterInstallation | null {
  return installations.find(installation => (
    installation.adapterKind === kind
    && installation.installationClass === 'managed_default'
    && installation.authScope === 'default'
  )) ?? null
}

function defaultsFor(
  installation: AdapterInstallation | null,
  kind: AssistantRuntimeKind
): MemberRuntimeConfiguration | null {
  const defaults = installation?.memberRuntimeDefaults ?? null
  if (!defaults) return null
  // A default that belongs to another Runtime is not evidence for this one.
  if (defaults.adapterKind !== kind || defaults.permissions.adapterKind !== kind) return null
  return defaults
}

function permissionDisplayOptions(kind: AssistantRuntimeKind, options: PermissionOptionDescriptor[]): PermissionOptionDescriptor[] {
  if (kind !== 'pi') return options
  const labels: Record<string, string> = {
    native: '使用 Pi 原生权限（不限工作目录）',
    workspace_read_only: '只读工作目录',
    workspace_read_write: '读写工作目录',
    workspace_workflow: '读写文件并处理任务'
  }
  return options.map(option => option.key === 'loom_file_access' ? {
    ...option,
    label: '文件与任务权限',
    description: '选择助手能在工作目录内做什么。受限模式不执行命令行或额外工具；原生模式不限制文件范围。',
    choices: option.choices.map(choice => ({ ...choice, label: labels[String(choice.value)] ?? choice.label }))
  } : option)
}

function optionFor(
  kind: AssistantRuntimeKind,
  installations: readonly AdapterInstallation[]
): AssistantRuntimeOption {
  const installation = assistantRuntimeInstallation(installations, kind)
  const defaults = defaultsFor(installation, kind)
  const snapshot = installation?.snapshot ?? null
  return {
    kind,
    label: ASSISTANT_RUNTIME_REGISTRY[kind].label,
    installation,
    usable: Boolean(installation && installation.enabled && installation.pathState === 'valid' && defaults),
    models: snapshot?.models ?? [],
    permissionOptions: permissionDisplayOptions(kind, installation?.permissionOptions ?? snapshot?.permissionOptions ?? []),
    permissionSchemaVersion: snapshot?.permissionSchemaVersion ?? defaults?.permissions.schemaVersion ?? null,
    defaults
  }
}

/** Real Runtime choices from the Host's own installation list; never a static claim. */
export async function readAssistantRuntimeOptions(client: Reader): Promise<AssistantRuntimeOption[]> {
  const installations = await client.request<AdapterInstallation[] | null>('runtime.installations.list')
  if (!Array.isArray(installations)) {
    throw new Error(uiAttribute('智能体安装列表读取结果不可用，请重试。'))
  }
  return ASSISTANT_RUNTIME_KINDS.map(kind => optionFor(kind, installations))
}

/**
 * The configuration this assistant would save for one Runtime: its own persisted
 * values when they already belong to that Runtime, otherwise that installation's
 * real defaults. No model is invented and no other Runtime is substituted.
 */
export function assistantRuntimeChoice(
  agent: AgentProfile,
  kind: AssistantRuntimeKind,
  installation: AdapterInstallation | null
): MemberRuntimeConfiguration | null {
  if (!installation || installation.adapterKind !== kind) return null
  const defaults = defaultsFor(installation, kind)
  if (!defaults) return null
  const persisted = agent.runtimeConfiguration
  const kept = persisted && persisted.adapterKind === kind
    && persisted.permissions.adapterKind === kind
    ? persisted
    : null
  const model: ModelSelection = structuredClone(kept ? kept.model : defaults.model)
  const permissions: AdapterPermissionConfig = structuredClone(
    kept ? kept.permissions : defaults.permissions
  )
  // The schema version is always the real current one, so stale values surface as a
  // Core schema-drift rejection instead of being silently rewritten here.
  return {
    adapterKind: kind,
    model,
    permissions: {
      adapterKind: kind,
      schemaVersion: installation.snapshot?.permissionSchemaVersion ?? permissions.schemaVersion,
      values: permissions.values
    },
    ...(kind === 'pi' ? { piPurge: structuredClone(kept?.piPurge ?? { mode: 'off', persona: '' }) } : {})
  }
}

// ------------------------------------------------- Pi Purge file-policy facts

/**
 * Permission key Core reads before it will stage a Pi Purge Append Run.
 * Mirrors `PI_FILE_ACCESS_KEY` (crates/rovai-core/src/pi/file_grant.rs:57).
 */
export const PI_FILE_ACCESS_KEY = 'loom_file_access'

/**
 * The three guarded `loom_file_access` policies Core accepts for Append; `native`,
 * an absent value and any unreadable value are all refused there
 * (agent_profile.rs:497-516 `pi_purge_append_without_file_grant`).
 */
export const PI_PURGE_FILE_ACCESS = [
  'workspace_read_only',
  'workspace_read_write',
  'workspace_workflow'
] as const

/** The one guarded policy this surface offers as a one-click repair. */
export const PI_PURGE_FILE_ACCESS_FIX = 'workspace_read_write'
export const PI_ASSISTANT_FILE_ACCESS_DEFAULT = 'workspace_workflow'

/**
 * The mode Core would read out of `permissions.values`, by the same strictness:
 * absent → `native` (legacy, never migrated); a bare mode string or an object
 * with exactly one `mode` key → that mode; anything else → unreadable.
 * See `mode_from_permissions` (pi/file_grant.rs:119-149).
 */
function piFileAccessMode(values: Record<string, unknown>): string {
  const raw = values[PI_FILE_ACCESS_KEY]
  if (raw === undefined) return 'native'
  if (typeof raw === 'string') return raw
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    // Exactly one `mode` key: an extra key is an error in Core, not a wider policy.
    const keys = Object.keys(raw)
    const mode = (raw as Record<string, unknown>).mode
    return keys.length === 1 && keys[0] === 'mode' && typeof mode === 'string' ? mode : 'unreadable'
  }
  return 'unreadable'
}

function guardsPiPurgeAppend(values: Record<string, unknown>): boolean {
  const mode = piFileAccessMode(values)
  return (PI_PURGE_FILE_ACCESS as readonly string[]).includes(mode)
}

/**
 * True exactly when Core would answer this draft with
 * `pi_purge_requires_file_grant`: Append is selected and the file policy is
 * `native`, absent or unreadable. Configuration-time warning only — Core stays
 * the authority and never has this draft silently widened for it.
 */
export function piPurgeNeedsFileGrant(choice: MemberRuntimeConfiguration | null): boolean {
  if (!choice || choice.adapterKind !== 'pi' || choice.piPurge?.mode !== 'append') return false
  return !guardsPiPurgeAppend(choice.permissions.values)
}

/** The one-click repair the caller offers next to that warning. */
function withPiFileAccess(
  choice: MemberRuntimeConfiguration,
  mode: string
): MemberRuntimeConfiguration {
  return {
    ...choice,
    permissions: {
      ...choice.permissions,
      values: { ...choice.permissions.values, [PI_FILE_ACCESS_KEY]: mode }
    }
  }
}

export function withPiPurgeFileGrant(
  choice: MemberRuntimeConfiguration
): MemberRuntimeConfiguration {
  return withPiFileAccess(choice, PI_PURGE_FILE_ACCESS_FIX)
}

/**
 * The values a *new* assistant starts from: the installation's own defaults.
 *
 * One Pi exception: an absent `loom_file_access` is read by Core as `native`
 * (pi/file_grant.rs:125-127), and `native` makes Pi Purge Append unsavable, so a
 * fresh Pi assistant starts at `workspace_workflow` instead of inheriting a
 * policy nobody chose. The workflow grant stays inside the same file boundary and adds
 * only the managed loom business tool needed for controlled dispatch; it never enables
 * shell. A default that is already guarded is kept as reported, and no other Runtime,
 * model or permission value is touched.
 */
export function assistantRuntimeSetupDefaults(
  option: AssistantRuntimeOption
): MemberRuntimeConfiguration | null {
  if (!option.defaults) return null
  const value = structuredClone(option.defaults)
  if (option.kind !== 'pi' || guardsPiPurgeAppend(value.permissions.values)) return value
  return withPiFileAccess(value, PI_ASSISTANT_FILE_ACCESS_DEFAULT)
}

/**
 * The one-line Runtime fact a Runtime picker shows under each Runtime name.
 * Pi is the built-in primary assistant, so an unusable Pi says what to connect
 * instead of the generic 「主机尚未发现」 nobody can act on.
 */
export function assistantRuntimeAvailabilityLabel(option: AssistantRuntimeOption): string {
  const builtinPrimary = ASSISTANT_RUNTIME_REGISTRY[option.kind].builtinPrimary
  if (!option.usable) {
    return builtinPrimary
      ? '内置主助手需要连接本机 Pi 运行环境'
      : option.installation ? '需要检查配置' : '主机尚未发现'
  }
  const models = `${option.models.length} 个可选模型${option.models.length === 0 ? ' · 默认模型需运行验证' : ''}`
  return builtinPrimary ? `内置 · 主助手默认大脑 · ${models}` : models
}

/** Save one exact-version Runtime choice; returns the receipt's new profile version. */
export async function saveAssistantRuntime({
  client,
  agent,
  choice
}: {
  client: Reader
  agent: AgentProfile
  choice: MemberRuntimeConfiguration
}): Promise<{ version: number }> {
  if (agent.presence === 'removed' || agent.removedAt !== null) {
    throw new Error(uiAttribute('该助手已不在团队中，无法保存智能体配置。'))
  }
  if (choice.piPurge && (choice.adapterKind !== 'pi'
    || (choice.piPurge.mode !== 'off' && choice.piPurge.mode !== 'append')
    || new TextEncoder().encode(choice.piPurge.persona).byteLength > 16 * 1024
    || (choice.piPurge.mode === 'append' && !choice.piPurge.persona.trim()))) {
    throw new Error(uiAttribute('Pi Purge 仅允许 Pi 的 Off/Append，开启时必须填写不超过 16 KB 的人格提示词。'))
  }
  const command = {
    agentId: agent.agentId,
    expectedVersion: agent.version,
    adapterKind: choice.adapterKind,
    model: structuredClone(choice.model),
    permissions: structuredClone(choice.permissions),
    ...(choice.adapterKind === 'pi' && choice.piPurge ? { piPurge: structuredClone(choice.piPurge) } : {})
  }
  const result = await client.request<StoredCommandResult | null>('members.runtime.set', {
    commandId: newCommandId(),
    command
  })
  if (!result || typeof result.status !== 'string') {
    throw new Error(uiAttribute('智能体配置的保存结果暂时不可用，请重新载入后核对。'))
  }
  assertApplied(result)
  const version = result.payload.version
  if (result.status !== 'applied' || !Number.isSafeInteger(version) || (version as number) <= agent.version) {
    throw new Error(uiAttribute('智能体配置已提交，但暂时无法确认最新版本，请重新载入后核对。'))
  }
  return { version: version as number }
}

// ------------------------------------------------------------------- identity

/**
 * The four identity facts the assistant surface edits, plus one optional field.
 * `purpose` is the profile's professional responsibilities; `style` is its
 * personality traits. `instructions` maps to working principles and is omitted
 * whenever the caller does not want to change them.
 */
export type AssistantIdentity = {
  name: string
  role: string
  purpose: string
  style: string[]
  instructions?: string
}

export function assistantIdentityOf(agent: AgentProfile): AssistantIdentity {
  return {
    name: agent.displayName,
    role: agent.teamRole,
    purpose: agent.professionalResponsibilities,
    style: [...agent.personalityTraits],
    ...(agent.workingPrinciples ? { instructions: agent.workingPrinciples } : {})
  }
}

/** Apply a patch without touching the avatar, growth topic or omitted working principles. */
export function assistantIdentityDraft(
  agent: AgentProfile,
  patch: Partial<AssistantIdentity> = {}
): IdentityDraft {
  const base = identityDraftFor(agent)
  return {
    displayName: patch.name ?? base.displayName,
    teamRole: patch.role ?? base.teamRole,
    professionalResponsibilities: patch.purpose ?? base.professionalResponsibilities,
    personalityTraits: patch.style ? [...patch.style] : base.personalityTraits,
    workingPrinciples: patch.instructions ?? base.workingPrinciples,
    growthTopic: base.growthTopic
  }
}

/** One assistant by id. Throws instead of returning a guess when Core gives none. */
export async function readAssistant(client: Reader, agentId: string): Promise<AgentProfile> {
  const profile = await client.request<AgentProfile | null>('members.get', { agentId })
  if (!profile || profile.agentId !== agentId) {
    throw new Error(uiAttribute('助手信息暂时无法读回，请重新载入后核对。'))
  }
  return profile
}

function identityRejectionMessage(result: StoredCommandResult): string {
  const message = result.payload.message
  if (result.code === 'agent_profile.version_conflict' || result.code === 'version_conflict') {
    return uiAttribute('助手已被其他操作更新，请重新载入后重试。')
  }
  if (result.code === 'agent_profile.display_name_conflict') {
    return uiAttribute('该名称已被其他助手使用，请换一个名称。')
  }
  return typeof message === 'string' && message !== ''
    ? message
    : uiAttribute('保存未完成：{0}', result.code)
}

/**
 * Save the editable identity fields and return the profile Core now holds.
 * Only `members.update` is issued: the avatar keeps its own command and its own
 * version, so an avatar change can never be replayed from here.
 */
export async function saveAssistantIdentity({
  client,
  agent,
  patch,
  agents = []
}: {
  client: Reader
  agent: AgentProfile
  patch: Partial<AssistantIdentity>
  /** Roster used for the local duplicate-name check; Core stays authoritative. */
  agents?: readonly AgentProfile[]
}): Promise<AgentProfile> {
  if (agent.presence === 'removed' || agent.removedAt !== null) {
    throw new Error(uiAttribute('该助手已不在团队中，无法保存。'))
  }
  const draft = assistantIdentityDraft(agent, patch)
  const issue = identityDraftIssue(draft, agent.agentId, [agent, ...agents])
  if (issue) throw new Error(issue.message)
  const identity = identityCommand(draft, null)
  if (JSON.stringify(identityDraftFor(agent)) === JSON.stringify(identity)) return agent
  // Same field set; `identityCommand` is typed as the Create|Update union (member-identity-draft.ts:28-41).
  const command = identityCommand(draft, agent) as UpdateAgentProfileCommand
  const result = await client.request<StoredCommandResult | null>('members.update', {
    commandId: newCommandId(),
    command
  })
  if (!result || typeof result.status !== 'string') {
    throw new Error(uiAttribute('助手信息的保存结果暂时不可用，请重新载入后核对。'))
  }
  if (result.status === 'rejected') throw new Error(identityRejectionMessage(result))
  return readAssistant(client, agent.agentId)
}

// --------------------------------------------------------------------- create

/**
 * An explicit `rejected` receipt for `members.create`: Core answered and no
 * assistant was created, so the caller may safely unlock the form and start
 * over with a fresh attempt.
 *
 * This type is deliberately *not* used for an unknown outcome (no receipt, an
 * unreadable receipt, or a create whose read-back failed). Those stay a plain
 * `Error` so the caller keeps the attempt and replays the exact same
 * `commandId`; Core then returns the assistant it already created instead of a
 * duplicate.
 */
export class AssistantCreateRejected extends Error {
  constructor(public readonly result: StoredCommandResult) {
    super(identityRejectionMessage(result))
    this.name = 'AssistantCreateRejected'
  }

  /** The Core rejection code, e.g. `agent_profile.display_name_conflict`. */
  get code(): string {
    return this.result.code
  }
}

/**
 * Create an assistant from the same identity facts. The command is exactly the
 * profile shape: no Runtime configuration, no model or permission value, and no
 * global preference is written. Core defaults the new profile as unconfigured.
 */
export async function createAssistant({
  client,
  identity,
  avatarRef = null,
  commandId = newCommandId()
}: {
  client: Reader
  identity: AssistantIdentity
  avatarRef?: string | null
  commandId?: string
}): Promise<AgentProfile> {
  const draft: IdentityDraft = {
    displayName: identity.name,
    teamRole: identity.role,
    professionalResponsibilities: identity.purpose,
    personalityTraits: [...identity.style],
    workingPrinciples: identity.instructions ?? '',
    growthTopic: ''
  }
  const issue = identityDraftIssue(draft, null, [])
  if (issue) throw new Error(issue.message)
  // `identityCommand(draft, null)` returns exactly the Create shape (member-identity-draft.ts:39-41).
  const fields = identityCommand(draft, null) as CreateAgentProfileCommand
  const command: CreateAgentProfileCommand = { ...fields, avatarRef }
  const result = await client.request<StoredCommandResult | null>('members.create', {
    commandId,
    command
  })
  if (!result || typeof result.status !== 'string') {
    throw new Error(uiAttribute('助手的创建结果暂时不可用，请重新载入名单后核对。'))
  }
  if (result.status === 'rejected') throw new AssistantCreateRejected(result)
  const created = result.resultEntity?.entityId ?? result.payload.agentId
  if (typeof created !== 'string' || created === '') {
    throw new Error(uiAttribute('助手已创建，但暂时无法读回，请刷新名单后重试。'))
  }
  return readAssistant(client, created)
}

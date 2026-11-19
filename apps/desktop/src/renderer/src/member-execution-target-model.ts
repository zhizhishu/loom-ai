import type {
  AdapterPermissionConfig,
  ExecutionNodeCli,
  ExecutionNodeRecord,
  MemberRuntimeConfiguration,
  ModelSelection,
  PermissionOptionDescriptor
} from '@contracts'
import { remoteNodes } from './nodes-model'

/**
 * The two Runtimes Core admits for a remote member target
 * (`RemoteMemberSelection::validate` in `crates/rovai-core/src/remote_execution.rs`).
 * This list is a Renderer mirror of that closed set, never a catalog probe.
 */
export const EXECUTION_TARGET_ADAPTERS = ['claude-code-cli', 'codex-cli'] as const
export type ExecutionTargetAdapterKind = (typeof EXECUTION_TARGET_ADAPTERS)[number]

/** One saved remote target. Identical to Core's `RemoteMemberSelection`. */
export type ExecutionTargetSelection = {
  nodeId: string
  workspaceId: string
  workspaceRoot: string
  adapterKind: ExecutionTargetAdapterKind
  model: ModelSelection
  permissions: AdapterPermissionConfig
}

/** One ready Mission workspace a remote node owns (`AvailableRemoteWorkspace`). */
export type ExecutionTargetWorkspace = {
  nodeId: string
  workspaceId: string
  workspaceRoot: string
  missionId: string
  missionTitle: string
}

/** Pure adapter facts from `runtimeDescriptors`; no installation is involved. */
export type ExecutionTargetRuntimeDescriptor = {
  adapterKind: ExecutionTargetAdapterKind
  permissionSchemaVersion: number
  permissionOptions: PermissionOptionDescriptor[]
  memberRuntimeDefaults: MemberRuntimeConfiguration
  supportsRuntimeDefaultModel: boolean
}

/** `members.executionTarget.get` result. */
export type ExecutionTargetView = {
  memberId: string
  revision: number
  selection: ExecutionTargetSelection | null
  availableWorkspaces: ExecutionTargetWorkspace[]
  runtimeDescriptors: ExecutionTargetRuntimeDescriptor[]
}

/** `members.executionTarget.save` result. A `null` selection means the local target. */
export type ExecutionTargetReceipt = {
  memberId: string
  revision: number
  selection: ExecutionTargetSelection | null
}

export type ExecutionTargetRemoteDraft = {
  nodeId: string
  workspaceId: string
  workspaceRoot: string
  adapterKind: ExecutionTargetAdapterKind
  /** Committed selection: the server's own explicit options are kept as returned. */
  model: ModelSelection
  /** Raw text in the model field. Unsubmitted text is part of the draft. */
  modelInput: string
  permissions: AdapterPermissionConfig
}

export type ExecutionTargetDraft = {
  mode: 'local' | 'remote'
  /** Kept while `mode === 'local'` so switching back does not lose remote edits. */
  remote: ExecutionTargetRemoteDraft | null
}

export type ExecutionTargetPayload = { selection: ExecutionTargetSelection | null }

export type ExecutionTargetBlock =
  | ''
  | 'read-error'
  | 'reload-required'
  | 'no-workspace'
  | 'workspace-required'
  | 'adapter-required'
  | 'node-unknown'

export type NodeTargetState = 'ready' | 'offline' | 'missing-cli' | 'revoked'

export type NodeTargetChoice = {
  node: ExecutionNodeRecord
  state: NodeTargetState
  /** Revoked and CLI-less nodes stay selectable only while they hold the saved value. */
  selectable: boolean
}

/** Core stores the Claude adapter under two names; both mean the same program. */
export function adapterKindMatches(candidate: string, wanted: ExecutionTargetAdapterKind): boolean {
  if (candidate === wanted) return true
  return wanted === 'claude-code-cli' && candidate === 'claude-code'
}

/** The newest CLI fact a node reported for this adapter, ignoring unusable paths. */
export function reportedCli(
  node: ExecutionNodeRecord,
  adapterKind: ExecutionTargetAdapterKind
): ExecutionNodeCli | null {
  const usable = node.clis.filter((cli) => (
    adapterKindMatches(cli.adapterKind, adapterKind)
    && cli.availability !== 'path_missing'
    && (cli.availability !== undefined || cli.pathPresent)
  ))
  return usable[0] ?? null
}

export function nodeTargetState(
  node: ExecutionNodeRecord,
  adapterKind: ExecutionTargetAdapterKind
): NodeTargetState {
  if (node.revokedAt) return 'revoked'
  if (!reportedCli(node, adapterKind)) return 'missing-cli'
  if (node.status !== 'online') return 'offline'
  return 'ready'
}

export function remoteNodeChoices(
  nodes: readonly ExecutionNodeRecord[],
  adapterKind: ExecutionTargetAdapterKind,
  selectedNodeId: string
): NodeTargetChoice[] {
  return remoteNodes([...nodes]).map((node) => {
    const state = nodeTargetState(node, adapterKind)
    return {
      node,
      state,
      // An offline node may still be configured; Core validates the rest.
      selectable: state === 'ready' || state === 'offline' || node.nodeId === selectedNodeId
    }
  })
}

export function descriptorFor(
  view: ExecutionTargetView | null,
  adapterKind: ExecutionTargetAdapterKind
): ExecutionTargetRuntimeDescriptor | null {
  return view?.runtimeDescriptors.find((descriptor) => descriptor.adapterKind === adapterKind) ?? null
}

/** Remote targets accept `runtime_default` or `explicit { modelId, options }` only. */
export function cloneModelSelection(model: ModelSelection): ModelSelection {
  if (model.mode === 'runtime_default') return { mode: 'runtime_default' }
  return {
    mode: 'explicit',
    modelId: model.modelId,
    options: { ...model.options }
  }
}

function clonePermissions(permissions: AdapterPermissionConfig): AdapterPermissionConfig {
  return {
    adapterKind: permissions.adapterKind,
    schemaVersion: permissions.schemaVersion,
    values: { ...permissions.values }
  }
}

export function remoteDraftFromSelection(selection: ExecutionTargetSelection): ExecutionTargetRemoteDraft {
  return {
    nodeId: selection.nodeId,
    workspaceId: selection.workspaceId,
    workspaceRoot: selection.workspaceRoot,
    adapterKind: selection.adapterKind,
    model: cloneModelSelection(selection.model),
    modelInput: selection.model.mode === 'explicit' ? selection.model.modelId : '',
    permissions: clonePermissions(selection.permissions)
  }
}

/** Defaults come from the descriptor Core shipped, never from a widened local guess. */
function remoteDraftFromDefaults(
  view: ExecutionTargetView,
  workspace: ExecutionTargetWorkspace | null
): ExecutionTargetRemoteDraft | null {
  const descriptor = view.runtimeDescriptors[0]
  if (!descriptor) return null
  return {
    nodeId: workspace?.nodeId ?? '',
    workspaceId: workspace?.workspaceId ?? '',
    workspaceRoot: workspace?.workspaceRoot ?? '',
    adapterKind: descriptor.adapterKind,
    model: { mode: 'runtime_default' },
    modelInput: '',
    permissions: {
      adapterKind: descriptor.adapterKind,
      schemaVersion: descriptor.permissionSchemaVersion,
      values: { ...descriptor.memberRuntimeDefaults.permissions.values }
    }
  }
}

/**
 * The remote draft a local member starts from. A saved remote selection always
 * wins so reopening the page never rewrites what Core already holds.
 */
export function preferredRemoteDraft(view: ExecutionTargetView): ExecutionTargetRemoteDraft | null {
  if (view.selection) return remoteDraftFromSelection(view.selection)
  return remoteDraftFromDefaults(view, view.availableWorkspaces[0] ?? null)
}

export function executionTargetDraftFromView(view: ExecutionTargetView): ExecutionTargetDraft {
  return view.selection
    ? { mode: 'remote', remote: remoteDraftFromSelection(view.selection) }
    : { mode: 'local', remote: preferredRemoteDraft(view) }
}

/** Empty input means the Runtime default; a changed ID starts from empty options. */
export function committedModel(remote: ExecutionTargetRemoteDraft): ModelSelection {
  const text = remote.modelInput.trim()
  if (text === '') return { mode: 'runtime_default' }
  if (remote.model.mode === 'explicit' && remote.model.modelId === text) {
    return cloneModelSelection(remote.model)
  }
  return { mode: 'explicit', modelId: text, options: {} }
}

export function setTargetMode(draft: ExecutionTargetDraft, mode: 'local' | 'remote', view: ExecutionTargetView): ExecutionTargetDraft {
  if (mode === draft.mode) return draft
  if (mode === 'local') return { ...draft, mode: 'local' }
  return { ...draft, mode: 'remote', remote: draft.remote ?? preferredRemoteDraft(view) }
}

export function workspaceChoices(view: ExecutionTargetView | null, nodeId: string): ExecutionTargetWorkspace[] {
  if (!view || !nodeId) return []
  return view.availableWorkspaces.filter((workspace) => workspace.nodeId === nodeId)
}

export function setTargetNode(draft: ExecutionTargetDraft, nodeId: string, view: ExecutionTargetView): ExecutionTargetDraft {
  const remote = draft.remote
  if (!remote || remote.nodeId === nodeId) return draft
  const choices = workspaceChoices(view, nodeId)
  // Keeping the current workspace when it belongs to the new node avoids spurious dirt.
  const kept = choices.find((workspace) => workspace.workspaceId === remote.workspaceId) ?? choices[0] ?? null
  return {
    ...draft,
    remote: {
      ...remote,
      nodeId,
      workspaceId: kept?.workspaceId ?? '',
      workspaceRoot: kept?.workspaceRoot ?? ''
    }
  }
}

export function setTargetWorkspace(draft: ExecutionTargetDraft, workspaceId: string, view: ExecutionTargetView): ExecutionTargetDraft {
  const remote = draft.remote
  if (!remote) return draft
  const workspace = workspaceChoices(view, remote.nodeId).find((entry) => entry.workspaceId === workspaceId)
  if (!workspace) return draft
  return {
    ...draft,
    remote: { ...remote, workspaceId: workspace.workspaceId, workspaceRoot: workspace.workspaceRoot }
  }
}

/** Same adapter keeps its selection; a different adapter starts from Core's defaults. */
export function setTargetAdapter(
  draft: ExecutionTargetDraft,
  adapterKind: ExecutionTargetAdapterKind,
  view: ExecutionTargetView
): ExecutionTargetDraft {
  const remote = draft.remote
  if (!remote || remote.adapterKind === adapterKind) return draft
  if (view.selection?.adapterKind === adapterKind) {
    const restored = remoteDraftFromSelection(view.selection)
    return {
      ...draft,
      remote: {
        ...restored,
        nodeId: remote.nodeId,
        workspaceId: remote.workspaceId,
        workspaceRoot: remote.workspaceRoot
      }
    }
  }
  const descriptor = descriptorFor(view, adapterKind)
  if (!descriptor) return draft
  return {
    ...draft,
    remote: {
      ...remote,
      adapterKind,
      model: { mode: 'runtime_default' },
      modelInput: '',
      permissions: {
        adapterKind,
        schemaVersion: descriptor.permissionSchemaVersion,
        values: { ...descriptor.memberRuntimeDefaults.permissions.values }
      }
    }
  }
}

export function setTargetModelInput(draft: ExecutionTargetDraft, modelInput: string): ExecutionTargetDraft {
  if (!draft.remote) return draft
  return { ...draft, remote: { ...draft.remote, modelInput } }
}

export function setTargetPermission(
  draft: ExecutionTargetDraft,
  key: string,
  value: string
): ExecutionTargetDraft {
  const remote = draft.remote
  if (!remote) return draft
  return {
    ...draft,
    remote: {
      ...remote,
      permissions: {
        ...remote.permissions,
        values: { ...remote.permissions.values, [key]: value }
      }
    }
  }
}

/** `null` means "not savable yet"; `{selection:null}` is the explicit local target. */
export function executionTargetPayload(draft: ExecutionTargetDraft): ExecutionTargetPayload | null {
  if (draft.mode === 'local') return { selection: null }
  const remote = draft.remote
  if (!remote || !remote.nodeId || !remote.workspaceId || !remote.workspaceRoot.trim()) return null
  return {
    selection: {
      nodeId: remote.nodeId,
      workspaceId: remote.workspaceId,
      workspaceRoot: remote.workspaceRoot,
      adapterKind: remote.adapterKind,
      model: committedModel(remote),
      permissions: {
        adapterKind: remote.permissions.adapterKind,
        schemaVersion: remote.permissions.schemaVersion,
        values: { ...remote.permissions.values }
      }
    }
  }
}

/**
 * One string per draft. It uses the committed model, so `abc` and ` abc `
 * describe the same target; a changed ID or a changed permission does not.
 */
export function executionTargetSignature(draft: ExecutionTargetDraft): string {
  if (draft.mode === 'local') return 'local'
  const remote = draft.remote
  if (!remote) return 'remote:none'
  return JSON.stringify([
    'remote',
    remote.nodeId,
    remote.workspaceId,
    remote.workspaceRoot,
    remote.adapterKind,
    committedModel(remote),
    remote.permissions
  ])
}

/** Whether the draft differs from one saved selection. */
export function executionTargetDirty(draft: ExecutionTargetDraft, saved: ExecutionTargetSelection | null): boolean {
  const baseline = saved
    ? executionTargetSignature({ mode: 'remote', remote: remoteDraftFromSelection(saved) })
    : 'local'
  return executionTargetSignature(draft) !== baseline
}

/**
 * Why the current draft cannot be submitted. Core stays the authority for
 * workspace readiness, membership and the node catalog; this only blocks
 * drafts that are incomplete or unverifiable in the Renderer.
 */
export function executionTargetBlock(
  draft: ExecutionTargetDraft,
  view: ExecutionTargetView | null,
  nodes: readonly ExecutionNodeRecord[] | null
): ExecutionTargetBlock {
  if (!view) return 'read-error'
  if (draft.mode === 'local') return ''
  const remote = draft.remote
  if (!remote) return 'no-workspace'
  if (!remote.nodeId) return 'no-workspace'
  if (!remote.workspaceId) return workspaceChoices(view, remote.nodeId).length ? 'workspace-required' : 'no-workspace'
  if (!descriptorFor(view, remote.adapterKind)) return 'adapter-required'
  // A node choice that is not the saved one needs a readable node list to be honest.
  if (view.selection?.nodeId !== remote.nodeId && !nodes) return 'node-unknown'
  return ''
}

export type ExecutionTargetSaveFailure =
  | { kind: 'conflict'; code: string }
  | { kind: 'rejected'; code: string }
  | { kind: 'unknown'; code: string }

/** Definite rejections. Anything else is an unknown outcome and is never retried automatically. */
const REJECTED_CODES: ReadonlySet<string> = new Set([
  'remote_target_workspace_unavailable',
  'remote_target_workspace_changed',
  'remote_target_workspace_generation_changed',
  'remote_target_member_unavailable',
  'remote_target_identity',
  'remote_target_workspace',
  'remote_target_adapter_unsupported',
  'remote_target_permissions',
  'remote_target_model',
  'remote_target_size',
  'remote_target_revision_overflow',
  'remote_target_invalid_input',
  'remote_target_runtime_configuration_invalid',
  'remote_target_stored_selection',
  'remote_catalog_node_not_found',
  'remote_catalog_node_not_remote',
  'remote_catalog_node_revoked',
  'remote_catalog_program_unavailable',
  'remote_catalog_installation_unavailable',
  'remote_catalog_identity_malformed',
  'remote_catalog_generation_out_of_range',
  'remote_catalog_adapter_ambiguous',
  'remote_catalog_target_changed',
  'remote_catalog_unavailable',
  'renderer_core_method_unsupported'
])

export function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return ''
}

export function executionTargetSaveFailure(error: unknown): ExecutionTargetSaveFailure {
  const code = errorCodeOf(error)
  if (code === 'remote_target_revision_conflict') return { kind: 'conflict', code }
  if (REJECTED_CODES.has(code)) return { kind: 'rejected', code }
  return { kind: 'unknown', code }
}

/* ------------------------------------------------------------------ *
 * UI state. This is the Renderer's view of Core, never a second truth:
 * `view` is whatever the last successful `get` returned for that member.
 * ------------------------------------------------------------------ */

export type TargetNotice =
  | { kind: 'none' }
  | { kind: 'saved' }
  | { kind: 'read-failed' }
  | { kind: 'conflict' }
  | { kind: 'unknown' }
  | { kind: 'rejected'; code: string }

export type MemberTargetState = {
  phase: 'loading' | 'ready' | 'error'
  /** Last successful server projection for this member. */
  view: ExecutionTargetView | null
  draft: ExecutionTargetDraft | null
  /** Real unsaved edits. It survives a failed or pending read. */
  dirty: boolean
  /** Conflict or unknown outcome: only a successful `get` clears it. */
  unknown: boolean
  saving: boolean
  notice: TargetNotice
  /** Bumped per read of this member; stale responses are ignored. */
  generation: number
  /** Token of the save in flight; a stale token never clears a newer save. */
  saveToken: number | null
}

export type ExecutionTargetState = {
  memberId: string | null
  members: Readonly<Record<string, MemberTargetState>>
}

export type ExecutionTargetClient = {
  get(memberId: string): Promise<ExecutionTargetView>
  save(input: {
    memberId: string
    expectedRevision: number
    selection: ExecutionTargetSelection | null
  }): Promise<ExecutionTargetReceipt>
}

/** What one save request was issued for; completion is applied to exactly this owner. */
export type ExecutionTargetSaveRequest = {
  token: number
  memberId: string
  generation: number
  expectedRevision: number
  selection: ExecutionTargetSelection | null
}

export const EMPTY_EXECUTION_TARGET_STATE: ExecutionTargetState = { memberId: null, members: {} }

function emptyMemberState(): MemberTargetState {
  return {
    phase: 'loading',
    view: null,
    draft: null,
    dirty: false,
    unknown: false,
    saving: false,
    notice: { kind: 'none' },
    generation: 0,
    saveToken: null
  }
}

export function memberTargetState(
  state: ExecutionTargetState,
  memberId: string | null
): MemberTargetState | null {
  return memberId ? state.members[memberId] ?? null : null
}

/**
 * Production controller for one member's run target. All asynchronous results
 * carry the member and generation they belong to, so a late `get` or `save`
 * can never overwrite a newer member, draft or notice. Every transition here is
 * what the component actually runs; tests drive this class through a deferred
 * client instead of a parallel model.
 */
export class ExecutionTargetController {
  #state: ExecutionTargetState = EMPTY_EXECUTION_TARGET_STATE
  #listeners = new Set<() => void>()
  #nextToken = 0
  #disposed = false
  readonly #client: ExecutionTargetClient

  constructor(client: ExecutionTargetClient) {
    this.#client = client
  }

  getState = (): ExecutionTargetState => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  dispose(): void {
    this.#disposed = true
    this.#listeners.clear()
  }

  #commit(next: ExecutionTargetState): void {
    if (this.#disposed) return
    this.#state = next
    for (const listener of [...this.#listeners]) listener()
  }

  #patch(memberId: string, patch: Partial<MemberTargetState>): void {
    const current = this.#state.members[memberId] ?? emptyMemberState()
    this.#commit({
      memberId: this.#state.memberId,
      members: { ...this.#state.members, [memberId]: { ...current, ...patch } }
    })
  }

  /** Show a member. Its cached draft, dirty and fence survive until a `get` answers. */
  select(memberId: string | null): void {
    if (this.#state.memberId === memberId) return
    const members = { ...this.#state.members }
    if (memberId && !members[memberId]) members[memberId] = emptyMemberState()
    this.#commit({ memberId, members })
  }

  /** Start one read for the current member. Refused while its save is in flight. */
  load(): boolean {
    const memberId = this.#state.memberId
    if (!memberId) return false
    const current = this.#state.members[memberId] ?? emptyMemberState()
    if (current.saving) return false
    const generation = current.generation + 1
    // Draft, dirty and the unknown fence stay: a pending read protects edits.
    this.#patch(memberId, { phase: current.view ? current.phase : 'loading', generation })
    void this.#client.get(memberId).then(
      (view) => this.#acceptView(memberId, generation, view),
      () => this.#rejectView(memberId, generation)
    )
    return true
  }

  #acceptView(memberId: string, generation: number, view: ExecutionTargetView): void {
    const current = this.#state.members[memberId]
    if (!current || current.generation !== generation) return
    // Keep the latest actual unsaved draft; a clean target takes the newest truth.
    const keepDraft = current.dirty && current.draft !== null
    const draft = keepDraft ? current.draft : executionTargetDraftFromView(view)
    const dirty = keepDraft && current.draft
      ? executionTargetDirty(current.draft, view.selection)
      : false
    this.#patch(memberId, {
      phase: 'ready',
      view,
      draft,
      dirty,
      unknown: false,
      notice: { kind: 'none' }
    })
  }

  #rejectView(memberId: string, generation: number): void {
    const current = this.#state.members[memberId]
    if (!current || current.generation !== generation) return
    // A failed read keeps the draft, the dirty flag, the fence and the last good view.
    this.#patch(memberId, current.view
      ? { phase: 'ready', notice: { kind: 'read-failed' } }
      : { phase: 'error' })
  }

  edit(draft: ExecutionTargetDraft): void {
    const memberId = this.#state.memberId
    if (!memberId) return
    const current = this.#state.members[memberId] ?? emptyMemberState()
    if (current.saving) return
    const dirty = current.view ? executionTargetDirty(draft, current.view.selection) : true
    this.#patch(memberId, { draft, dirty, notice: current.notice.kind === 'saved' ? { kind: 'none' } : current.notice })
  }

  /** Discard the draft for the last server truth. Never clears a conflict fence. */
  useServer(): boolean {
    const memberId = this.#state.memberId
    if (!memberId) return false
    const current = this.#state.members[memberId] ?? emptyMemberState()
    if (current.saving || current.unknown || !current.view) return false
    this.#patch(memberId, {
      draft: executionTargetDraftFromView(current.view),
      dirty: false,
      notice: { kind: 'none' }
    })
    return true
  }

  /** The request to issue, or `null` when this save must not be sent at all. */
  beginSave(): ExecutionTargetSaveRequest | null {
    const memberId = this.#state.memberId
    if (!memberId) return null
    const current = this.#state.members[memberId] ?? emptyMemberState()
    if (current.saving || current.unknown || !current.view || !current.draft || !current.dirty) return null
    const payload = executionTargetPayload(current.draft)
    if (!payload) return null
    const token = ++this.#nextToken
    // A read issued before this mutation cannot settle its outcome or restore
    // the pre-save baseline after the write completes.
    const generation = current.generation + 1
    // Flipped synchronously, so a second submit in the same tick cannot pass.
    this.#patch(memberId, { saving: true, saveToken: token, generation, notice: { kind: 'none' } })
    return {
      token,
      memberId,
      generation,
      expectedRevision: current.view.revision,
      selection: payload.selection
    }
  }

  async save(): Promise<void> {
    const request = this.beginSave()
    if (!request) return
    try {
      const receipt = await this.#client.save({
        memberId: request.memberId,
        expectedRevision: request.expectedRevision,
        selection: request.selection
      })
      this.completeSave(request, { ok: true, receipt })
    } catch (error) {
      this.completeSave(request, { ok: false, error })
    }
  }

  /** Applied to the member that issued the request, never to whoever is shown now. */
  completeSave(
    request: ExecutionTargetSaveRequest,
    result: { ok: true; receipt: ExecutionTargetReceipt } | { ok: false; error: unknown }
  ): void {
    const current = this.#state.members[request.memberId]
    if (!current || current.saveToken !== request.token) return
    if (current.generation !== request.generation) {
      this.#patch(request.memberId, { saving: false, saveToken: null })
      return
    }
    if (result.ok) {
      const view: ExecutionTargetView | null = current.view
        ? {
            ...current.view,
            memberId: result.receipt.memberId,
            revision: result.receipt.revision,
            selection: result.receipt.selection
          }
        : null
      this.#patch(request.memberId, {
        view,
        draft: view ? executionTargetDraftFromView(view) : current.draft,
        dirty: false,
        unknown: false,
        saving: false,
        saveToken: null,
        notice: { kind: 'saved' }
      })
      return
    }
    const failure = executionTargetSaveFailure(result.error)
    this.#patch(request.memberId, {
      saving: false,
      saveToken: null,
      unknown: failure.kind !== 'rejected',
      notice: failure.kind === 'conflict'
        ? { kind: 'conflict' }
        : failure.kind === 'unknown'
          ? { kind: 'unknown' }
          : { kind: 'rejected', code: failure.code }
    })
  }
}

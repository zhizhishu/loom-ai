import type { SkillImportInspection, SkillView, StoredCommandResult } from '@contracts'
// 只借类型：ThreadClient 是已认证的 Core 通道，这里不发任何自制 RPC。
import type { ThreadClient } from '../camp-client'
import { readErrorMessage } from '../error-message'
import {
  highRiskToConfirm,
  hookDefinitionMissing,
  isLocalHookScope,
  itemKey,
  pendingHookReview,
  previewRuntime,
  selectionsOf,
  type CapabilityCatalog,
  type CapabilityItem,
  type HookReviewSnapshot,
  type RunProjectionPreview
} from '../member-catalog-model'

/**
 * 队员目录的数据层：真实的 Core 读取/保存、运行投影预览和导入三步，不含 React、不含样式。
 *
 * 三条硬边界：
 * 1. 投影只是「下一次 Run 会拿到什么」的预览，永远不是本次运行真的应用了的证据。
 *    应用与否只有运行回执能说，所以这里只有 ready / unsupported / error，没有「已应用」。
 * 2. unsupported 和 error 都不等于「未应用」；它们是「不知道」。
 * 3. 勾选、来源标签和风险都由 Core 给；这里只做本地前置拒绝，绝不放宽 Core 的判断。
 */

export type CapabilityRpc = Pick<ThreadClient, 'request'>

/** 本地拒绝用 local. 前缀，永不伪装成 Core 错误码。 */
export type CapabilityErrorCode =
  | 'capability.revision_conflict'
  | 'capability.conflict'
  | 'capability.invalid_request'
  | 'capability.member_not_found'
  | 'capability.risk_acknowledgement_required'
  | 'capability.hook_review_required'
  | 'capability.hook_review_conflict'
  | 'capability.hook_review_scope_changed'
  | 'capability.skill_source_unavailable'
  | 'capability.mcp_rejected'
  | 'capability.toolbox_rejected'
  | 'local.selection_not_in_catalog'
  | 'local.snapshot_mismatch'
  | 'local.hook_review_required'
  | 'local.hook_definition_missing'
  | 'local.high_risk_acknowledgement_required'
  | 'local.projection_mismatch'
  | 'local.inspection_mismatch'
  | 'local.official_conflict'
  | 'local.skill_id_missing'
  | 'local.invalid_item'

/** Core 拒绝或本地前置拒绝。code 原样保留，界面靠它区分「过期」「冲突」「要审阅」。 */
export class CapabilityRequestError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message)
    this.name = 'CapabilityRequestError'
  }
}

function localError(code: CapabilityErrorCode, message: string): CapabilityRequestError {
  return new CapabilityRequestError(code, message)
}

/** 只读 Core 错误对象上的 code；不猜、不映射成别的码。 */
function requestCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code
  return ''
}

/** 任何拒绝都收敛成带 code 的实例，未知码保留为空串，界面自己决定措辞。 */
function asCapabilityError(error: unknown): CapabilityRequestError {
  if (error instanceof CapabilityRequestError) return error
  const code = requestCode(error)
  return new CapabilityRequestError(code, readErrorMessage(error, code || 'capability request failed'))
}

/** 下一次 Run 的投影状态。ready 只说「读到了」，不说「本次运行应用了」。 */
export type ProjectionRead =
  | { status: 'ready', preview: RunProjectionPreview }
  | { status: 'unsupported', runtime: string | null }
  | { status: 'error', code: string, message: string }

/** putItem 的回执形状，和 Core 的 MemberCapabilityPutResult 一致。 */
export type CapabilityPutResult = {
  id: string
  kind: string
  name: string
  toolNames: string[]
}

export type SkillImportPick = {
  candidateName: string
  expectedSkillVersion: number | null
  confirmUpdate: boolean
  /** 调用方生成并在重试时复用；同一次请求重放，不会重复导入。 */
  commandId: string
}

export type SkillCommitOutcome =
  | { status: 'applied', candidateName: string, skillId: string | null }
  | { status: 'rejected', candidateName: string, code: string, message: string }

/** 用户点出来的纯规则片段。scope 不给就按 Core 默认的 cloud。 */
export type RuleDraft = {
  id: string | null
  name: string
  body: string
  note?: string
  scope?: 'project' | 'cloud'
}

/**
 * 用户点出来的 hook 片段。建条目不会勾选、也不会批准：
 * 真要勾上仍需 Core 现算的正文摘要与范围摘要，走 hookReviewSnapshot。
 */
export type HookDraft = {
  id: string | null
  name: string
  body: string
  note?: string
  scope?: 'project' | 'cloud'
}

const ITEM_ID = /^[A-Za-z0-9_-]{1,80}$/u
const MAX_NAME = 120
const MAX_NOTE = 400
const MAX_BODY = 8000

function snippetPayload(kind: 'rule' | 'hook', draft: RuleDraft | HookDraft): Record<string, unknown> {
  const name = draft.name.trim()
  if (!name) throw localError('local.invalid_item', '规则或 hook 需要名称。')
  if (name.length > MAX_NAME) throw localError('local.invalid_item', '名称太长。')
  const note = (draft.note ?? '').trim()
  if (note.length > MAX_NOTE) throw localError('local.invalid_item', '说明太长。')
  const body = draft.body ?? ''
  if (body.length > MAX_BODY) throw localError('local.invalid_item', '正文太长。')
  const id = (draft.id ?? '').trim()
  if (id && !ITEM_ID.test(id)) {
    throw localError('local.invalid_item', '条目 id 只能使用字母、数字、下划线和连字符。')
  }
  const scope = draft.scope ?? 'cloud'
  if (scope !== 'project' && scope !== 'cloud') throw localError('local.invalid_item', 'scope 只能是 project 或 cloud。')
  return {
    kind,
    ...(id ? { itemId: id } : {}),
    name,
    note,
    scope,
    body,
    toolNames: []
  }
}

/** 一次目录读取。Core 是勾选状态的唯一来源，这里不做乐观合并。 */
export function readCapabilityCatalog(rpc: CapabilityRpc, agentId: string, localCampId?: string): Promise<CapabilityCatalog> {
  return rpc.request<CapabilityCatalog>('members.capabilityCatalog.get', { agentId, ...(localCampId ? { localCampId } : {}) })
    .catch((error: unknown) => { throw asCapabilityError(error) })
}

/**
 * 下一次 Run 的运行投影。任何非空运行端都发真实请求，
 * 能不能给出投影由 Core 裁决（runtime_required / runtime_unsupported 都算 unsupported，
 * 不当作「未应用」）。没选运行端才在本地短路。
 */
export async function readRunProjection(
  rpc: CapabilityRpc,
  agentId: string,
  runtime: string | null
): Promise<ProjectionRead> {
  const name = previewRuntime(runtime)
  if (!name) return { status: 'unsupported', runtime }
  try {
    const preview = await rpc.request<RunProjectionPreview>('members.runProjection.preview', { member: agentId, runtime: name })
    // 投影必须属于这次问的队员，别人的投影不冒充。
    if (!preview || preview.agentId !== agentId) {
      return { status: 'error', code: 'local.projection_mismatch', message: '运行投影不属于这位队员。' }
    }
    return { status: 'ready', preview }
  } catch (error: unknown) {
    const code = requestCode(error)
    if (code === 'runtime_required' || code === 'runtime_unsupported') return { status: 'unsupported', runtime }
    return { status: 'error', code, message: readErrorMessage(error, '运行投影读取失败') }
  }
}

/**
 * 定义、风险和审阅范围只能来自 Core 这次读取的目录；草稿只改 selected。
 * 草稿里自带的 hookDefinition / risk 不能用来替自己授权。
 */
function coreOwnedItems(catalog: CapabilityCatalog, draft: readonly CapabilityItem[]): CapabilityItem[] {
  const baseline = new Map(catalog.items.map((item) => [itemKey(item), item]))
  return draft.map((item) => {
    const saved = baseline.get(itemKey(item))
    if (!saved) return item
    return saved.kind === 'hook'
      ? { ...item, risk: saved.risk, hookDefinition: saved.hookDefinition ?? null }
      : { ...item, risk: saved.risk }
  })
}

/**
 * 保存勾选。catalog 必须是当前这份读取结果（它的 revision 就是 expectedRevision，
 * catalog.items 就是「已保存」的基线）。
 *
 * 提供了 reviewed 就必须和这次请求严格同源：同一队员、同一版本、同一组勾选；
 * 不比对 token（token 由界面自己生成与持有）。
 *
 * 定义、风险与审阅范围一律取这份 catalog（Core-owned），草稿只提供 selected；
 * 新勾上一条缺 Core 定义的 hook 在发请求前就拒绝。
 */
export async function saveCapabilitySelections(
  rpc: CapabilityRpc,
  catalog: CapabilityCatalog,
  draft: readonly CapabilityItem[],
  reviewed?: HookReviewSnapshot | null,
  localCampId?: string
): Promise<CapabilityCatalog> {
  const baseline = new Map(catalog.items.map((item) => [itemKey(item), item]))
  for (const item of draft) {
    if (!baseline.has(itemKey(item))) {
      throw localError('local.selection_not_in_catalog', `目录里没有 ${item.kind} ${item.id}。`)
    }
  }
  // 只拦「新勾上一条缺 Core 定义的 hook」。已经勾上的、这轮没改的保持原样，
  // 不能因为保存其他项就自动撤销它们。
  for (const item of draft) {
    const saved = baseline.get(itemKey(item))!
    if (!item.selected || saved.selected) continue
    if (hookDefinitionMissing(saved)) {
      throw localError('local.hook_definition_missing', `${item.name} 当前运行范围没有可审阅的 Hook 定义，暂不能启用。`)
    }
  }
  // 后面的审阅与风险判断全部用 Core 这次读取的定义，不用草稿里塞进来的定义。
  const owned = coreOwnedItems(catalog, draft)
  for (const item of owned) {
    const scope = item.hookDefinition?.reviewScope
    if (item.selected && item.kind === 'hook' && scope && isLocalHookScope(scope) && scope.campId !== localCampId) {
      throw localError('local.snapshot_mismatch', '工作位置已改变，请重新读取后确认。')
    }
  }
  const selections = selectionsOf(draft)
  if (reviewed) {
    if (reviewed.agentId !== catalog.agentId
      || reviewed.revision !== catalog.revision
      || JSON.stringify([...reviewed.selections].sort((a,b) => itemKey(a).localeCompare(itemKey(b)))) !== JSON.stringify([...selections].sort((a,b) => itemKey(a).localeCompare(itemKey(b))))) {
      throw localError('local.snapshot_mismatch', '这份审阅快照不属于这次勾选，请重新读取目录。')
    }
    const approved = new Set(reviewed.entries.map((entry) => entry.id))
    for (const item of pendingHookReview(owned)) {
      if (!approved.has(item.id)) {
        throw localError('local.hook_review_required', '还有 hook 的正文没审过。')
      }
    }
  } else {
    // Core 同样会拒绝；先在本地拒绝，省一次必然失败的写入，也绝不替用户批准。
    if (pendingHookReview(owned).length > 0) {
      throw localError('local.hook_review_required', '这条 hook 要先把正文和运行范围审一遍。')
    }
    if (highRiskToConfirm(owned, catalog.items).length > 0) {
      throw localError('local.high_risk_acknowledgement_required', '这条高风险项要用户确认之后才会勾上。')
    }
  }
  const acknowledgeHighRisk = reviewed ? reviewed.acknowledgeHighRisk : false
  if (!acknowledgeHighRisk && highRiskToConfirm(owned, catalog.items).length > 0) {
    throw localError('local.high_risk_acknowledgement_required', '这条高风险项要用户确认之后才会勾上。')
  }
  return rpc.request<CapabilityCatalog>('members.capabilityCatalog.set', {
    agentId: catalog.agentId,
    ...(localCampId ? { localCampId } : {}),
    expectedRevision: catalog.revision,
    acknowledgeHighRisk,
    selections,
    reviewedHooks: reviewed ? reviewed.approvals.map((entry) => ({ ...entry })) : []
  }).catch((error: unknown) => { throw asCapabilityError(error) })
}

/** 只读检查一个文件夹。用户给的路径原样上行，不改写、不猜默认目录。 */
export function inspectSkill(rpc: CapabilityRpc, sourcePath: string): Promise<SkillImportInspection> {
  const path = sourcePath.trim()
  if (!path) return Promise.reject(localError('local.inspection_mismatch', '先填写这份 Core 能读到的文件夹路径。'))
  return rpc.request<SkillImportInspection>('skills.import.inspect', { path })
    .catch((error: unknown) => { throw asCapabilityError(error) })
}

/** 已导入的技能 id：以存储的指令回执为准，不再猜一次。 */
function committedSkillId(result: StoredCommandResult): string | null {
  const payload: unknown = result.payload
  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const payloadId = typeof record.skillId === 'string' ? record.skillId : null
  if (payloadId) return payloadId
  return result.resultEntity?.entityType === 'skill' ? result.resultEntity.entityId : null
}

/**
 * 按用户点的那一个候选提交导入。stagingToken 和 expectedDigest 只来自这份不可变检查结果，
 * 绝不在用户点完之后再去重新检查一次。
 */
export async function commitSkill(
  rpc: CapabilityRpc,
  inspection: SkillImportInspection,
  pick: SkillImportPick
): Promise<SkillCommitOutcome> {
  const candidate = inspection.candidates.find((entry) => entry.name === pick.candidateName)
  if (!candidate) throw localError('local.inspection_mismatch', '这次检查里没有这个候选，请重新检查。')
  if (candidate.importAction === 'official_conflict') {
    throw localError('local.official_conflict', '这个名字属于内置技能，导入不能覆盖。')
  }
  if (candidate.existingSkillVersion !== pick.expectedSkillVersion) {
    throw localError('local.inspection_mismatch', '候选版本和这次检查对不上，请重新检查。')
  }
  const result = await rpc.request<StoredCommandResult>('skills.import.commit', {
    commandId: pick.commandId,
    command: {
      stagingToken: inspection.stagingToken,
      candidateName: candidate.name,
      expectedDigest: candidate.contentDigest,
      expectedSkillVersion: pick.expectedSkillVersion,
      confirmUpdate: pick.confirmUpdate
    }
  }).catch((error: unknown) => { throw asCapabilityError(error) })
  if (result.status !== 'applied') {
    return { status: 'rejected', candidateName: candidate.name, code: result.code, message: readErrorMessage(result, result.code) }
  }
  return { status: 'applied', candidateName: candidate.name, skillId: committedSkillId(result) }
}

/**
 * 把已导入的技能登记进目录。可重复调用（Core 是 upsert），且不会勾选任何东西：
 * 勾上仍然要用户在目录里自己点。
 */
export async function registerSkill(rpc: CapabilityRpc, skillId: string): Promise<CapabilityPutResult> {
  const id = skillId.trim()
  if (!id) throw localError('local.skill_id_missing', '导入回执里没有技能 id，先核对这次导入。')
  return rpc.request<CapabilityPutResult>('members.capabilityCatalog.putItem', {
    kind: 'skill',
    itemId: `library:${id}`,
    toolNames: []
  }).catch((error: unknown) => { throw asCapabilityError(error) })
}

/** 库里已有的导入技能；只用于展示「还没加进目录」，不自动登记。 */
export function listLibrary(rpc: CapabilityRpc): Promise<readonly SkillView[]> {
  return rpc.request<SkillView[]>('skills.list')
    .catch((error: unknown) => { throw asCapabilityError(error) })
}

/** 用户点出来的规则片段。只建条目，不勾选、不新增任何权限覆盖。 */
export async function putRule(rpc: CapabilityRpc, draft: RuleDraft): Promise<CapabilityPutResult> {
  return rpc.request<CapabilityPutResult>('members.capabilityCatalog.putItem', snippetPayload('rule', draft))
    .catch((error: unknown) => { throw asCapabilityError(error) })
}

/** 用户点出来的 hook 片段。建好仍是未审阅状态，勾上必须走精确审阅。 */
export async function putHook(rpc: CapabilityRpc, draft: HookDraft): Promise<CapabilityPutResult> {
  return rpc.request<CapabilityPutResult>('members.capabilityCatalog.putItem', snippetPayload('hook', draft))
    .catch((error: unknown) => { throw asCapabilityError(error) })
}

export type CapabilityPort = {
  read(agentId: string): Promise<CapabilityCatalog>
  preview(agentId: string, runtime: string | null): Promise<ProjectionRead>
  save(catalog: CapabilityCatalog, draft: readonly CapabilityItem[], reviewed?: HookReviewSnapshot | null): Promise<CapabilityCatalog>
  inspectSkill(sourcePath: string): Promise<SkillImportInspection>
  commitSkill(inspection: SkillImportInspection, pick: SkillImportPick): Promise<SkillCommitOutcome>
  registerSkill(skillId: string): Promise<CapabilityPutResult>
  listLibrary(): Promise<readonly SkillView[]>
  putRule(draft: RuleDraft): Promise<CapabilityPutResult>
  putHook(draft: HookDraft): Promise<CapabilityPutResult>
}

/** 把 useThreadClient() 的返回值直接绑成一个端口，界面只管调用。 */
export function createCapabilityPort(rpc: CapabilityRpc, localCampId?: string): CapabilityPort {
  return {
    read: (agentId) => readCapabilityCatalog(rpc, agentId, localCampId),
    preview: (agentId, runtime) => readRunProjection(rpc, agentId, runtime),
    save: (catalog, draft, reviewed) => saveCapabilitySelections(rpc, catalog, draft, reviewed, localCampId),
    inspectSkill: (sourcePath) => inspectSkill(rpc, sourcePath),
    commitSkill: (inspection, pick) => commitSkill(rpc, inspection, pick),
    registerSkill: (skillId) => registerSkill(rpc, skillId),
    listLibrary: () => listLibrary(rpc),
    putRule: (draft) => putRule(rpc, draft),
    putHook: (draft) => putHook(rpc, draft)
  }
}

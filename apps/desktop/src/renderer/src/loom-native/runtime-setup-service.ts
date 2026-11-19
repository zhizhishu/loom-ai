import type {
  AdapterCapabilitySnapshot,
  AdapterInstallation,
  AdapterKind,
  HostPlatformKey,
  ProductRuntimeAvailability,
  ProductRuntimeAvailabilityStatus,
  ProductRuntimeCatalogEntry,
  RuntimeFailureView,
  RuntimeModelCatalogCacheStatus,
  RuntimeModelCatalogTarget,
  RuntimeModelCatalogView,
  RuntimePlatformAdmission,
  RuntimePlatformAdmissionStatus,
  RuntimeProbeFailureClass,
  RuntimeStatus
} from '@contracts'
import type { ThreadClient } from '../camp-client'
import { readErrorMessage } from '../error-message'
import { runtimePlatformAdmissionFor, runtimeProductPresentation, type RuntimeStatusPresentation } from '../runtime-status'
// 只借类型与产品名：runtime-check.ts 的结果形状就是 Core 的真实回执。
import type { ProductRuntimeCheckResult } from '../runtime-check'
import { ASSISTANT_RUNTIME_KINDS, assistantRuntimePort, type AssistantRuntimeKind } from './assistant-service'

/**
 * 四种产品 Runtime 的**生命周期**数据层：只包住既有 Core 方法，不含 React、不含样式。
 *
 * 只用这六个已存在的方法：
 *   runtime.status.get / runtime.installations.list        （本文件默认只读这两个）
 *   runtime.discovery.rescan / runtime.product.ensure       （显式调用：扫描、让 Core 排一次检查）
 *   runtime.product.check / runtime.modelCatalog.open       （显式调用：真探一次、读模型目录）
 *
 * 四条硬边界：
 * 1. 默认读取不探测。列表加载只发 `runtime.status.get` + `runtime.installations.list`，
 *    绝不自动调用 `runtime.product.check`/`runtime.modelCatalog.open`：后两者会真的起进程，
 *    CLI 可能因此加载 extensions / hooks，模型目录也可能触发一次真实模型侧请求。
 *    所以它们只作为显式方法暴露，界面必须在用户明确点按后才能调用（见各函数注释）。
 * 2. 有路径不等于能运行，`enabled` 不等于可用。卡片把「找到程序」「版本支持」「探测待定/未验证」
 *    「认证」「模型目录缓存」「权限词表」「安装配置」分开报；绿色只由 `runtimeProductPresentation`
 *    依据 Core 的 availability 与平台准入给，不在本文件里自己算。
 * 3. 本文件不写任何东西：不改 CLI、不改模型、不改默认值、不建/改安装、不保存启动设置。
 *    没有「装一个 Runtime」这种能力，`runtime.product.ensure` 只是让 Core 排一次它自己的检查。
 * 4. 读不懂就报错，不猜：Core 返回未知状态或形状不符时返回 `local.runtime_status_schema_unsupported`，
 *    绝不把未知渲染成「可用」或「未安装」。
 */

export type RuntimeSetupRpc = Pick<ThreadClient, 'request'>

/** 产品层只做这四种 Runtime；id 就是 Core 的 AdapterKind。 */
export const PRODUCT_RUNTIME_KINDS = ASSISTANT_RUNTIME_KINDS

export type ProductRuntimeKind = AssistantRuntimeKind

export type RuntimeSetupErrorCode =
  | 'local.runtime_kind_unsupported'
  | 'local.runtime_status_unreadable'
  | 'local.runtime_status_schema_unsupported'
  | 'local.runtime_installations_unreadable'
  | 'local.runtime_model_catalog_mismatch'
  | 'local.runtime_catalog_unreadable'

/** Core 拒绝或本地前置拒绝；code 原样保留，界面靠它区分「未知」与「被拒」。 */
export class RuntimeSetupError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message)
    this.name = 'RuntimeSetupError'
  }
}

function setupError(code: RuntimeSetupErrorCode, message: string): RuntimeSetupError {
  return new RuntimeSetupError(code, message)
}

function asSetupError(error: unknown): RuntimeSetupError {
  if (error instanceof RuntimeSetupError) return error
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : ''
  return new RuntimeSetupError(code, readErrorMessage(error, code || 'Runtime 请求失败'))
}

/** 显式动作只有两种结局：Core 接受了，或它拒绝了。没有「大概成功」。 */
export type RuntimeSetupOutcome<T> =
  | { status: 'ok', value: T }
  | { status: 'rejected', code: string, message: string }

/** 探测/检查的进度，不冒充结果。 */
export type RuntimeCheckProgress =
  | { kind: 'never_attempted' }
  | { kind: 'pending', checking: boolean }
  | {
    kind: 'attempted'
    status: 'ready' | 'failed'
    failureClass: RuntimeProbeFailureClass
    diagnosticCode: string | null
    attemptedAt: string
  }

export type RuntimeVersionSupport = 'supported' | 'unsupported' | 'unverified'

/**
 * 设置面自己的事实状态，严格从 Core 的 availability + 平台准入推出来：
 * 只有 Core 最近一次真检查 `ready` 才是 `verified`；`enabled`、路径、缓存一律不升级为 verified。
 */
export type RuntimeSetupState =
  | 'verified'
  | 'check_pending'
  | 'found_unverified'
  | 'missing'
  | 'authentication_required'
  | 'incompatible'
  | 'needs_attention'
  | 'disabled'
  // LOOM 自有决定（Claude 禁用，2026-11-18）：准入层的策略禁用单独一个状态，
  // 不和用户自己关掉的 `disabled` 混用。
  | 'policy_disabled'
  | 'platform_unsupported'
  | 'unknown'

export type RuntimeProgramCard = {
  runtimeKind: ProductRuntimeKind
  /** 目录里的产品名，只来自既有 registry，不在这里另起名字。 */
  displayName: string
  commandName: string | null
  platformAdmission: { status: RuntimePlatformAdmissionStatus, reasonCode: string | null } | null
  /** 「本机找到了入口」。不代表能启动、能认证、能出模型目录。 */
  discovery: {
    status: 'detecting' | 'found' | 'missing' | 'unknown'
    executablePath: string | null
    source: string | null
    versionProbeSucceeded: boolean | null
    observedAt: string | null
    diagnosticCode: string | null
  }
  reportedVersion: string | null
  /** 版本是否受支持：只有真探测成功才算 supported，否则 unverified。 */
  versionSupport: RuntimeVersionSupport
  /** 设置面的严格状态：不因路径或 enabled 变绿。 */
  setupState: RuntimeSetupState
  check: {
    progress: RuntimeCheckProgress
    lastSuccessfulProbeAt: string | null
    failure: RuntimeFailureView | null
  }
  authentication: {
    /** 需要用户处理登录/凭据（来自 Core 的显式信号，不由路径推断）。 */
    required: boolean
    /** 仅当 Core 的最近一次检查真的 ready 时为 true。 */
    verified: boolean
    /** Core 自报的认证状态原文，不翻译成结论。 */
    status: string | null
  }
  modelCatalog: {
    cacheStatus: RuntimeModelCatalogCacheStatus | 'unknown'
    observedAt: string | null
    modelCount: number
  }
  permissions: {
    schemaVersion: number | null
    supportedCount: number
    unsupportedCount: number
  }
  installation: {
    installationId: string | null
    enabled: boolean
    pathState: 'valid' | 'path_missing' | 'unknown'
    /** 已启用的安装 + 已有成员默认配置。这不是「可用」。 */
    configured: boolean
    staleAt: string | null
  }
  /**
   * 最近一次真实运行证据不在这里读：本文件没有 Run 读取方法，所以如实报告「未读取」，
   * 由 Run/工作视图提供，绝不编造「上次运行成功」。
   */
  runEvidence: { available: false, reason: 'not_read_by_this_service' }
  /** 唯一的展示口径，来自既有 runtime-status 助手；不在本文件另算一套。 */
  presentation: RuntimeStatusPresentation
}

export type RuntimeSetupRead =
  | {
    status: 'ready'
    platform: HostPlatformKey | null
    cards: RuntimeProgramCard[]
    installations: AdapterInstallation[]
    catalog: ProductRuntimeCatalogEntry[]
    searchEnvironment: RuntimeStatus['searchEnvironment'] | null
  }
  | { status: 'error', code: string, message: string }

/** Core 现在会自报的全部 availability 状态；出现别的值说明契约变了，不能猜。 */
const KNOWN_AVAILABILITY_STATUS: readonly ProductRuntimeAvailabilityStatus[] = [
  'detecting',
  'missing',
  'found_uninspected',
  'light_ready',
  'installed_unverified',
  'checking',
  'ready',
  'authentication_required',
  'incompatible',
  'needs_attention',
  'path_missing',
  'disabled',
  'refresh_failed_using_last_success'
]

const KNOWN_ADMISSION_STATUS: readonly RuntimePlatformAdmissionStatus[] = [
  'qualified',
  'preview',
  'not_qualified',
  'unsupported',
  // LOOM 自有决定（Claude 禁用，2026-11-18）：产品策略禁用的准入状态。
  'disabled'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function productRuntimeKind(runtimeKind: AdapterKind): ProductRuntimeKind {
  const kind = ASSISTANT_RUNTIME_KINDS.find((candidate) => candidate === runtimeKind)
  if (!kind) {
    throw setupError('local.runtime_kind_unsupported', '这个 Runtime 不属于本工作面支持的四种。')
  }
  return kind
}

/**
 * 校验 `runtime.status.get` 的真实形状。未知状态、缺数组、非对象都当契约不符处理，
 * 让界面显示「暂时无法确认」，而不是把陌生值读成可用或未安装。
 */
function checkedStatus(payload: unknown): RuntimeStatus {
  if (!isRecord(payload)) {
    throw setupError('local.runtime_status_unreadable', 'Runtime 状态读取结果不可用，请重试。')
  }
  const availability = payload.runtimeAvailability
  const admissions = payload.runtimePlatformAdmission
  if (!Array.isArray(availability) || !Array.isArray(admissions)) {
    throw setupError('local.runtime_status_schema_unsupported', 'Runtime 状态缺少可识别的字段，请更新后再试。')
  }
  for (const entry of availability) {
    if (!isRecord(entry) || typeof entry.runtimeKind !== 'string') {
      throw setupError('local.runtime_status_schema_unsupported', 'Runtime 状态条目无法识别，请更新后再试。')
    }
    const status = entry.status
    if (typeof status !== 'string' || !KNOWN_AVAILABILITY_STATUS.includes(status as ProductRuntimeAvailabilityStatus)) {
      throw setupError('local.runtime_status_schema_unsupported', 'Core 报告了当前不认识的 Runtime 状态。')
    }
  }
  for (const entry of admissions) {
    if (!isRecord(entry) || typeof entry.status !== 'string'
      || !KNOWN_ADMISSION_STATUS.includes(entry.status as RuntimePlatformAdmissionStatus)) {
      throw setupError('local.runtime_status_schema_unsupported', 'Core 报告了当前不认识的平台准入状态。')
    }
  }
  return payload as unknown as RuntimeStatus
}

function checkedInstallations(payload: unknown): AdapterInstallation[] {
  if (!Array.isArray(payload)) {
    throw setupError('local.runtime_installations_unreadable', 'Runtime 安装列表读取结果不可用，请重试。')
  }
  for (const entry of payload) {
    if (!isRecord(entry) || typeof entry.adapterKind !== 'string' || typeof entry.id !== 'string') {
      throw setupError('local.runtime_installations_unreadable', 'Runtime 安装条目无法识别，请重试。')
    }
  }
  return payload as AdapterInstallation[]
}

function snapshotOf(installation: AdapterInstallation | null): AdapterCapabilitySnapshot | null {
  return installation?.snapshot ?? null
}

function availabilityOf(status: RuntimeStatus, runtimeKind: AdapterKind): ProductRuntimeAvailability | null {
  return status.runtimeAvailability?.find((row) => row.runtimeKind === runtimeKind) ?? null
}

function admissionOf(status: RuntimeStatus, runtimeKind: AdapterKind): RuntimePlatformAdmission | null {
  return runtimePlatformAdmissionFor(status.hostPlatform ?? null, status.runtimePlatformAdmission ?? [], runtimeKind)
}

function checkProgressOf(
  availability: ProductRuntimeAvailability | null,
  installation: AdapterInstallation | null,
  snapshot: AdapterCapabilitySnapshot | null
): RuntimeCheckProgress {
  const attempt = installation?.lastProbeAttempt ?? null
  if (attempt) {
    return {
      kind: 'attempted',
      status: attempt.status,
      failureClass: attempt.failureClass,
      diagnosticCode: attempt.diagnosticCode,
      attemptedAt: attempt.attemptedAt
    }
  }
  const pendingStatuses: ProductRuntimeAvailabilityStatus[] = [
    'detecting',
    'checking',
    'found_uninspected',
    'light_ready',
    'installed_unverified'
  ]
  if (availability && (availability.checking || pendingStatuses.includes(availability.status))) {
    return { kind: 'pending', checking: availability.checking }
  }
  if (snapshot?.lastAttemptedAt) {
    // 快照里有尝试时间但没有探测记录：只说明「曾经试过」，结论未知。
    return { kind: 'pending', checking: false }
  }
  return { kind: 'never_attempted' }
}

function versionSupportOf(
  availability: ProductRuntimeAvailability | null,
  attempt: RuntimeCheckProgress
): RuntimeVersionSupport {
  if (availability?.status === 'incompatible') return 'unsupported'
  if (attempt.kind === 'attempted' && attempt.failureClass === 'incompatible') return 'unsupported'
  if (attempt.kind === 'attempted' && attempt.status === 'ready') return 'supported'
  return 'unverified'
}

function authenticationOf(
  availability: ProductRuntimeAvailability | null,
  attempt: RuntimeCheckProgress,
  snapshot: AdapterCapabilitySnapshot | null
): RuntimeProgramCard['authentication'] {
  const failure = availability?.failure ?? null
  const required = availability?.status === 'authentication_required'
    || failure?.phase === 'authentication'
    || (attempt.kind === 'attempted' && attempt.failureClass === 'authentication_required')
  return {
    required,
    // 只有 Core 明确说 ready 才算验证通过；路径、enabled、缓存都不算。
    verified: availability?.status === 'ready',
    status: snapshot?.authenticationStatus ?? null
  }
}

function modelCatalogOf(
  installation: AdapterInstallation | null,
  snapshot: AdapterCapabilitySnapshot | null
): RuntimeProgramCard['modelCatalog'] {
  const cache = installation?.modelCatalog ?? null
  return {
    cacheStatus: cache?.status ?? 'unknown',
    observedAt: cache?.observedAt ?? snapshot?.observedAt ?? null,
    modelCount: snapshot?.models?.length ?? 0
  }
}

function permissionsOf(
  installation: AdapterInstallation | null,
  snapshot: AdapterCapabilitySnapshot | null
): RuntimeProgramCard['permissions'] {
  const options = installation?.permissionOptions ?? snapshot?.permissionOptions ?? []
  const supported = options.filter((option) => option.supported !== false).length
  return {
    schemaVersion: snapshot?.permissionSchemaVersion ?? null,
    supportedCount: supported,
    unsupportedCount: options.length - supported
  }
}

function setupStateOf(
  admission: RuntimePlatformAdmission | null,
  availability: ProductRuntimeAvailability | null
): RuntimeSetupState {
  if (admission?.status === 'unsupported') return 'platform_unsupported'
  if (admission?.status === 'not_qualified') return 'platform_unsupported'
  // LOOM 自有决定（Claude 禁用，2026-11-18）：产品策略禁用排在可用性之前，
  // 无论本机发现/探测结果如何都不能把它升级成 verified。
  if (admission?.status === 'disabled') return 'policy_disabled'
  if (!availability) return 'unknown'
  switch (availability.status) {
    case 'ready':
      return 'verified'
    case 'authentication_required':
      return 'authentication_required'
    case 'missing':
    case 'path_missing':
      return 'missing'
    case 'incompatible':
      return 'incompatible'
    case 'needs_attention':
      return 'needs_attention'
    case 'disabled':
      return 'disabled'
    case 'detecting':
    case 'checking':
      return 'check_pending'
    case 'found_uninspected':
    case 'light_ready':
    case 'installed_unverified':
    case 'refresh_failed_using_last_success':
      return 'found_unverified'
  }
  // 未知状态在上面已被 checkedStatus 拦下；这里只做防御，绝不猜成可用。
  return 'unknown'
}

function cardFor(
  runtimeKind: ProductRuntimeKind,
  status: RuntimeStatus,
  installation: AdapterInstallation | null
): RuntimeProgramCard {
  const availability = availabilityOf(status, runtimeKind)
  const snapshot = snapshotOf(installation)
  const attempt = checkProgressOf(availability, installation, snapshot)
  const attemptRecord = installation?.lastProbeAttempt ?? null
  const admission = admissionOf(status, runtimeKind)
  const discovery = availability?.discovery ?? null
  return {
    runtimeKind,
    displayName: assistantRuntimePort(runtimeKind)?.label ?? runtimeKind,
    commandName: installation?.commandName ?? null,
    platformAdmission: admission
      ? { status: admission.status, reasonCode: admission.reasonCode }
      : null,
    discovery: {
      status: discovery?.discoveryStatus ?? 'unknown',
      executablePath: discovery?.executablePath ?? null,
      source: discovery?.source ?? null,
      versionProbeSucceeded: discovery?.versionProbeSucceeded ?? null,
      observedAt: discovery?.observedAt ?? null,
      diagnosticCode: discovery?.diagnosticCode ?? availability?.diagnosticCode ?? null
    },
    reportedVersion: availability?.reportedVersion ?? discovery?.reportedVersion ?? snapshot?.reportedVersion ?? null,
    versionSupport: versionSupportOf(availability, attempt),
    setupState: setupStateOf(admission, availability),
    check: {
      progress: attempt,
      lastSuccessfulProbeAt: attemptRecord?.status === 'ready'
        ? attemptRecord.attemptedAt
        : (snapshot?.lastSuccessfulProbeAt ?? null),
      failure: availability?.failure ?? attemptRecord?.failure ?? null
    },
    authentication: authenticationOf(availability, attempt, snapshot),
    modelCatalog: modelCatalogOf(installation, snapshot),
    permissions: permissionsOf(installation, snapshot),
    installation: {
      installationId: availability?.installationId ?? installation?.id ?? null,
      enabled: installation?.enabled === true,
      pathState: installation?.pathState ?? 'unknown',
      // 已启用 + 路径有效 + 有成员默认配置；仍不等于可用。
      configured: Boolean(
        installation
        && installation.enabled
        && installation.pathState === 'valid'
        && installation.memberRuntimeDefaults
      ),
      staleAt: snapshot?.staleAt ?? null
    },
    runEvidence: { available: false, reason: 'not_read_by_this_service' },
    presentation: runtimeProductPresentation(admission, availability)
  }
}

/**
 * 默认读取：两种只读方法，一次拿全四张卡片。
 * 不发 `runtime.product.check`、不发 `runtime.modelCatalog.open`、不触发任何扫描，
 * 所以打开设置页不会拉起 CLI、不会加载 extensions/hooks、也不会请求模型。
 * 任一读取失败或形状不符都返回 error，绝不返回「四张都是未安装」。
 */
export async function readRuntimeSetup(rpc: RuntimeSetupRpc): Promise<RuntimeSetupRead> {
  try {
    const [rawStatus, rawInstallations] = await Promise.all([
      rpc.request<unknown>('runtime.status.get'),
      rpc.request<unknown>('runtime.installations.list')
    ])
    const status = checkedStatus(rawStatus)
    const installations = checkedInstallations(rawInstallations)
    const cards = PRODUCT_RUNTIME_KINDS.map((runtimeKind) =>
      cardFor(runtimeKind, status, installations.find((row) => row.adapterKind === runtimeKind) ?? null)
    )
    return {
      status: 'ready',
      platform: status.hostPlatform ?? null,
      cards,
      installations,
      catalog: status.runtimeCatalog ?? [],
      searchEnvironment: status.searchEnvironment ?? null
    }
  } catch (error: unknown) {
    const failure = asSetupError(error)
    return { status: 'error', code: failure.code, message: failure.message }
  }
}

async function explicit<T>(action: () => Promise<T>): Promise<RuntimeSetupOutcome<T>> {
  try {
    return { status: 'ok', value: await action() }
  } catch (error: unknown) {
    const failure = asSetupError(error)
    return { status: 'rejected', code: failure.code, message: failure.message }
  }
}

/**
 * 显式：请 Core 重新扫描本机 Runtime 入口。
 * `interactiveShell` 是旧客户端字段，Core 现在自己决定采集策略（只保留兼容读取），
 * 沿用既有调用方发送的同一份 payload，不新增字段。
 */
export function rescanRuntimeDiscovery(rpc: RuntimeSetupRpc): Promise<RuntimeSetupOutcome<{ requested: true }>> {
  return explicit(async () => {
    await rpc.request('runtime.discovery.rescan', { interactiveShell: true })
    return { requested: true as const }
  })
}

/**
 * 显式：让 Core 为这个 Runtime 排一次它自己的检查。
 * 这不是安装：本工作面没有安装器，Core 也不会被这条请求改成装软件。
 * 回执就是 Core 的 `{ scheduled, runtimeKind }`，`scheduled: false` 表示没有新排期，
 * 界面不能因此显示「已开始」。
 */
export function ensureProductRuntime(
  rpc: RuntimeSetupRpc,
  runtimeKind: ProductRuntimeKind
): Promise<RuntimeSetupOutcome<{ scheduled: boolean, runtimeKind: AdapterKind }>> {
  return explicit(async () => {
    const kind = productRuntimeKind(runtimeKind)
    const result = await rpc.request<{ scheduled: boolean, runtimeKind: AdapterKind }>('runtime.product.ensure', {
      runtimeKind: kind
    })
    if (!isRecord(result) || typeof result.scheduled !== 'boolean') {
      throw setupError('local.runtime_status_schema_unsupported', 'Core 没有返回可识别的排期结果。')
    }
    return { scheduled: result.scheduled, runtimeKind: result.runtimeKind ?? kind }
  })
}

/**
 * 显式：真探一次这个 Runtime。
 *
 * 这条会让 Core 起一次真实 CLI（`RuntimeLaunchPurpose::AvailabilityCheck`），
 * 因此可能执行该 CLI 的 extensions / hooks，也可能访问其登录态。
 * 只有在用户明确点「检查」时才能调用；不得作为列表加载或定时轮询的一部分。
 */
export function probeProductRuntime(
  rpc: RuntimeSetupRpc,
  runtimeKind: ProductRuntimeKind
): Promise<RuntimeSetupOutcome<ProductRuntimeCheckResult>> {
  return explicit(async () => {
    const kind = productRuntimeKind(runtimeKind)
    const result = await rpc.request<ProductRuntimeCheckResult>('runtime.product.check', {
      runtimeKind: kind
    })
    if (!isRecord(result) || typeof result.ready !== 'boolean' || typeof result.status !== 'string') {
      throw setupError('local.runtime_status_schema_unsupported', 'Core 没有返回可识别的检查结果。')
    }
    return result
  })
}

export type RuntimeModelCatalogOptions = {
  /** true 时等 Core 刷新完再回；false 只读缓存。 */
  waitForRefresh?: boolean
  /** 只有 DSH 支持按目标模型取上下文；其他 Runtime 传了也不发送。 */
  target?: RuntimeModelCatalogTarget
}

/**
 * 显式：读一个 Runtime 的模型目录。
 *
 * 默认 `waitForRefresh: false` 只读缓存；`true` 会真的启动 CLI 去取目录（可能访问模型侧），
 * 所以同样只能在用户动作里调用。这里只读不写：不选模型、不改助手配置、不改全局默认。
 */
export function openRuntimeModelCatalog(
  rpc: RuntimeSetupRpc,
  runtimeKind: ProductRuntimeKind,
  options: RuntimeModelCatalogOptions = {}
): Promise<RuntimeSetupOutcome<RuntimeModelCatalogView>> {
  return explicit(async () => {
    const kind = productRuntimeKind(runtimeKind)
    const view = await rpc.request<RuntimeModelCatalogView>('runtime.modelCatalog.open', {
      runtimeKind: kind,
      ...(options.waitForRefresh ? { waitForRefresh: true } : {}),
      ...(kind === 'deepseek-harness' && options.target ? options.target : {})
    })
    if (!isRecord(view) || view.runtimeKind !== kind || !Array.isArray(view.models)) {
      throw setupError('local.runtime_model_catalog_mismatch', '模型目录不属于这个 Runtime，请重新读取。')
    }
    return view
  })
}

export type RuntimeSetupPort = {
  /** 只读，不会起进程。 */
  read(): Promise<RuntimeSetupRead>
  rescan(): Promise<RuntimeSetupOutcome<{ requested: true }>>
  ensure(runtimeKind: ProductRuntimeKind): Promise<RuntimeSetupOutcome<{ scheduled: boolean, runtimeKind: AdapterKind }>>
  /** 会起真实 CLI。 */
  probe(runtimeKind: ProductRuntimeKind): Promise<RuntimeSetupOutcome<ProductRuntimeCheckResult>>
  /** 会起真实 CLI（waitForRefresh 时）。 */
  modelCatalog(runtimeKind: ProductRuntimeKind, options?: RuntimeModelCatalogOptions): Promise<RuntimeSetupOutcome<RuntimeModelCatalogView>>
}

/** 把 useThreadClient() 的返回值直接绑成一个端口，界面只管调用。 */
export function createRuntimeSetupPort(rpc: RuntimeSetupRpc): RuntimeSetupPort {
  return {
    read: () => readRuntimeSetup(rpc),
    rescan: () => rescanRuntimeDiscovery(rpc),
    ensure: (runtimeKind) => ensureProductRuntime(rpc, runtimeKind),
    probe: (runtimeKind) => probeProductRuntime(rpc, runtimeKind),
    modelCatalog: (runtimeKind, options) => openRuntimeModelCatalog(rpc, runtimeKind, options)
  }
}

import type {
  CoreMethod,
  LoomClaim,
  LoomClaimsListResult,
  LoomReview,
  LoomTaskStatus,
  LoomVerification,
  MissionStatus,
  ThreadSnapshot
} from '@contracts'
import { readErrorMessage } from '../error-message'
import { uiAttribute } from '../interface-language'
import { artifactCandidateFacts, type ArtifactCandidateFacts } from './artifact-service'
import type { LoomArtifact, LoomCandidate, WorkBundle } from './types'

/**
 * V2 运行事实（只读）：把今天真实存在的 Core 投影整理成 Goal / Bot / Lead / Worker / Run /
 * Artifact 六类事实，供原 UI 接线使用。本模块不发写命令、不含 React、不含样式，也不产出
 * 「进度百分比」这类没有回执支撑的数字——没有回执就没有进度。
 *
 * 四条读取纪律：
 * 1. 能力靠 Host 宣告：Host 没有明确宣告 `loom.claims.list` 时一个请求都不发，结果记为
 *    `unavailable(not_declared)`；不靠「试一次失败就当没有」来推断能力。另有一条独立的
 *    只读观测路径（`readClaimsListObserved`）：不做任何宣告、不写任何 registry，在已认证
 *    通道上真实读一次，让回执自己证明接口存在——观测到的事实不等于授权，也不改写任何
 *    能力结论；Host 照旧只认它自己的宣告。
 * 2. 三种坏结果严格分开：RPC 读取失败 → `failed`；回执形状不认识 → `unknown`；
 *    未宣告、方法确实不被支持或 V2 接口尚不存在 → `unavailable`。三者都不等于「空列表」。
 * 3. 认领只信 Host：`expired` 直接抄 Host 的判定（服务端时钟），不拿本地时间重算；
 *    同一任务取 fence 代次最大的那条，同代次保留 Host 先给出的那条。
 * 4. 责任不是授权：Task 的 assignee 只是责任归属，只有 Host 的认领把它记成 claimant，
 *    才算「这个 Agent 正占着这个任务」。
 *
 * 注册 / 核验 / Review / 验收四个状态各自读自己的来源，绝不互相推导：登记了不等于核验过，
 * 核验过不等于验收通过，候选的验收状态也不因为存在 Review 记录就被改写。
 */

// ------------------------------------------------------------------ read states

/** 读不到的具体原因。「空」和「没读到」在类型层面就不是同一件事。 */
export type V2UnavailableReason =
  /** Host 没宣告这个接口：一次请求都没发。 */
  | 'not_declared'
  /** V2 接口本身还不存在（Bot 记录 / Goal 记录 / capability 物化）。 */
  | 'interface_not_available'
  /** 产物没有归属候选，核验/Review/验收没有可挂的主体。 */
  | 'no_candidate'
  /** 拿到的 Thread 不是这份 Mission 的 Thread，不混读成员与 Run。 */
  | 'thread_mismatch'
  /** 没有 Mission 标识就不猜一个去查。 */
  | 'mission_required'
  /** 已认证通道真实读了一次，结构化回执带精确码证明该方法不存在/不被支持。 */
  | 'method_unsupported'
  /** 请求的 Mission 与事实包的 Mission 不一致：不发请求，也不映射别家回执。 */
  | 'mission_mismatch'

export type V2ReadState<T> =
  | { status: 'observed'; value: T }
  | { status: 'unavailable'; reason: V2UnavailableReason }
  | { status: 'failed'; message: string }
  | { status: 'unknown'; message: string }

/** 明确不可用的接口：只有 unavailable 一种可能，不给「看起来有值」的余地。 */
export type V2UnavailableFact = { status: 'unavailable'; reason: V2UnavailableReason }

function notAvailable(): V2UnavailableFact {
  return { status: 'unavailable', reason: 'interface_not_available' }
}

function threadMismatch<T>(): V2ReadState<T> {
  return { status: 'unavailable', reason: 'thread_mismatch' }
}

/** 把一次未读到的投影，按同一原因转成另一种载荷的失败态（观测态不可转换）。 */
function propagateFailure<T>(state: V2ReadState<unknown>): V2ReadState<T> | null {
  if (state.status === 'observed') return null
  return state
}

// ------------------------------------------------------------- host declaration

export const CLAIMS_LIST_METHOD = 'loom.claims.list' as const

/**
 * Host 对自己实现了哪些 Core 方法的一次明确宣告。空/缺失的宣告 = 什么都没宣告，
 * 调用方因此不会为了「探一下」而发出任何请求。
 */
export interface V2HostDeclaration {
  readonly declaredMethods: readonly string[]
}

export function hostDeclares(
  declaration: V2HostDeclaration | null | undefined,
  method: string
): boolean {
  if (declaration === null || declaration === undefined) return false
  if (!Array.isArray(declaration.declaredMethods)) return false
  return declaration.declaredMethods.includes(method)
}

// -------------------------------------------------------------------- port

/** 唯一的 Host 面：已认证的 Core 请求通道。本模块只用它读，不用它写。 */
export interface V2RunPort {
  request<T>(method: CoreMethod, params?: unknown): Promise<T>
}

// ---------------------------------------------------------------- claims list

/** 一次认领投影：一批认领 + Host 判定 expired 时用的那一个服务端时刻。 */
export type V2ClaimProjection = Pick<LoomClaimsListResult, 'evaluatedAt' | 'claims'>

// 文案按需翻译：界面语言可能在模块加载之后才确定，不在模块顶层冻结一份。
const claimsUnknownMessage = (): string => uiAttribute('认领回执无法识别，认领状态尚未确认。')
const claimsFailedMessage = (): string => uiAttribute('认领状态读取失败，尚未确认谁在执行。')

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** 单条认领：缺字段、类型不对、expired 不是布尔值，一律按坏回执处理，不猜默认值。 */
function readClaimRow(value: unknown): LoomClaim | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (!isNonEmptyString(row.claimId)) return null
  if (!isNonEmptyString(row.taskId)) return null
  if (!isNonEmptyString(row.agentRunId)) return null
  if (typeof row.fenceGeneration !== 'number' || !Number.isInteger(row.fenceGeneration)) return null
  if (!isNonEmptyString(row.claimedAt)) return null
  if (!isNonEmptyString(row.leaseExpiresAt)) return null
  if (typeof row.expired !== 'boolean') return null
  const claimant = row.claimantAgentId
  if (claimant !== null && typeof claimant !== 'string') return null
  const released = row.releasedAt
  if (released !== null && typeof released !== 'string') return null
  return {
    claimId: row.claimId,
    taskId: row.taskId,
    agentRunId: row.agentRunId,
    claimantAgentId: claimant ?? null,
    fenceGeneration: row.fenceGeneration,
    claimedAt: row.claimedAt,
    leaseExpiresAt: row.leaseExpiresAt,
    releasedAt: released ?? null,
    expired: row.expired
  }
}

/** 回执分类：只认契约里的形状。形状不认识就是 `unknown`，不折成「没有认领」。 */
export function classifyClaimsReceipt(value: unknown): V2ReadState<V2ClaimProjection> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'unknown', message: claimsUnknownMessage() }
  }
  const record = value as Record<string, unknown>
  if (!isNonEmptyString(record.evaluatedAt) || !Array.isArray(record.claims)) {
    return { status: 'unknown', message: claimsUnknownMessage() }
  }
  const claims: LoomClaim[] = []
  for (const row of record.claims) {
    const claim = readClaimRow(row)
    if (claim === null) return { status: 'unknown', message: claimsUnknownMessage() }
    claims.push(claim)
  }
  return { status: 'observed', value: { evaluatedAt: record.evaluatedAt, claims } }
}

/**
 * 唯一的认领读取入口。未宣告不发请求；没有 missionId 不发请求；
 * 抛错是 `failed`，坏回执是 `unknown`，两者都不推进任何「已认领」结论。
 */
export async function readClaimsList(
  port: V2RunPort,
  declaration: V2HostDeclaration | null | undefined,
  missionId: string
): Promise<V2ReadState<V2ClaimProjection>> {
  const mission = missionId.trim()
  if (mission === '') return { status: 'unavailable', reason: 'mission_required' }
  if (!hostDeclares(declaration, CLAIMS_LIST_METHOD)) {
    return { status: 'unavailable', reason: 'not_declared' }
  }
  let receipt: unknown
  try {
    receipt = await port.request<unknown>(CLAIMS_LIST_METHOD, { missionId: mission })
  } catch (error) {
    return { status: 'failed', message: readErrorMessage(error, claimsFailedMessage()) }
  }
  return classifyClaimsReceipt(receipt)
}

/** 认领读取走哪条路径：默认仍按 Host 宣告门；observe-readonly 改走一次只读观测。 */
export type V2ClaimsAccess = 'declared' | 'observe-readonly'

/**
 * 只有错误对象自身携带这些精确结构化 code 之一，才允许判 `method_unsupported`。
 * 当前 Core 构建对未知方法没有专属 code：`application.rs` 的 dispatch 兜底
 * `unsupported core method: {method}` 是 anyhow bail，落进 `request_error_body`
 * 的共享兜底 `CORE_REQUEST_FAILED`，与所有基础设施失败同码，message 文本一律
 * 不作为判定依据——所以共享码只能保守归 `failed`，永不凭文本降级。
 */
const METHOD_UNSUPPORTED_CODES: readonly string[] = ['METHOD_NOT_FOUND', 'METHOD_UNSUPPORTED']

/** 结构化失败回执的最小形状（main 进程 `RovaiRequestError` 的 `code` 字段子集）。 */
function structuredErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : null
}

/** 一次观测读取的失败分类：精确码才 unsupported，其余全部保守 failed。 */
function classifyClaimsRequestError(error: unknown, fallback: string): V2ReadState<never> {
  const code = structuredErrorCode(error)
  if (code !== null && METHOD_UNSUPPORTED_CODES.includes(code)) {
    return { status: 'unavailable', reason: 'method_unsupported' }
  }
  return { status: 'failed', message: readErrorMessage(error, fallback) }
}

/**
 * 只读观测路径（与宣告门完全独立）：对 `loom.claims.list` 在已认证通道上执行
 * 恰好一次真实读取。这是「观测事实」，不是 Host 宣告，也不是授权：成功只证明
 * 这一次读取存在，不写任何 registry，不给任何后续调用额外的资格；本模块只读，
 * Core 侧没有用户可见的写副作用，也不做自动重试或其它接口探测。
 */
export async function readClaimsListObserved(
  port: V2RunPort,
  missionId: string
): Promise<V2ReadState<V2ClaimProjection>> {
  const mission = missionId.trim()
  if (mission === '') return { status: 'unavailable', reason: 'mission_required' }
  let receipt: unknown
  try {
    receipt = await port.request<unknown>(CLAIMS_LIST_METHOD, { missionId: mission })
  } catch (error) {
    return classifyClaimsRequestError(error, claimsFailedMessage())
  }
  return classifyClaimsReceipt(receipt)
}

/**
 * 同一任务可能有多代认领：取 fence 代次最大的那条；同代次保留 Host 先给出的那条。
 * 不按本地时间挑「看起来更新」的，也不按过期状态重排。
 */
export function latestClaimByTask(claims: readonly LoomClaim[]): Map<string, LoomClaim> {
  const latest = new Map<string, LoomClaim>()
  for (const claim of claims) {
    const current = latest.get(claim.taskId)
    if (current === undefined || claim.fenceGeneration > current.fenceGeneration) {
      latest.set(claim.taskId, claim)
    }
  }
  return latest
}

/** 认领展示态：已释放优先于过期——释放是结论，过期只是没续上。
 * `expired` 只读 Host 的判定，这里绝不拿本地时钟重算。 */
export type V2ClaimLeaseState = 'held' | 'expired' | 'released'

export function claimLeaseState(claim: LoomClaim): V2ClaimLeaseState {
  if (claim.releasedAt !== null) return 'released'
  return claim.expired ? 'expired' : 'held'
}

// ------------------------------------------------------------------- facts

/** Goal：今天唯一权威的目标记录仍是 Mission 本体，原样投影，不加百分比。 */
export interface V2GoalFacts {
  mission: {
    missionId: string
    threadId: string
    title: string
    description: string
    status: MissionStatus
    defaultLeadAgentId: string | null
    memberAgentIds: readonly string[]
  }
  /** V2 Goal 记录（独立进度/验收）尚不存在：不造阶段，也不造进度。 */
  v2Record: V2UnavailableFact
}

/** Bot：Core 当前的成员投影，一个字段都不加工。 */
export interface V2BotFacts {
  agentId: string
  displayName: string
  teamRole: string
  isDefaultLead: boolean
  membershipStatus: 'active' | 'left'
  presence: ThreadSnapshot['members'][number]['profilePresence']
}

/** Lead：Thread 的默认 Lead，与 Mission 记录的默认负责人各自保留。 */
export interface V2LeadFacts {
  /** null = Thread 没有默认 Lead，不是「还没读到」。 */
  agentId: string | null
  /** 该 Agent 在当前成员投影里的 Bot 事实；不在投影里时为 null，不编造。 */
  bot: V2BotFacts | null
  /** 与 Mission 记录的默认负责人是否一致；不一致时两个事实都保留，不择一。 */
  matchesMissionLead: boolean
}

/** Worker：一个 Task 的责任归属 + 它当前那一代认领。 */
export interface V2WorkerFacts {
  taskId: string
  title: string
  status: LoomTaskStatus
  /** 责任归属，不是执行授权：assignee 本身不构成认领。 */
  assigneeAgentId: string | null
  /** 只有 Host 的认领把该 Agent 记成 claimant 时才为 true。 */
  assigneeIsClaimant: boolean
  blockedReason: string | null
  /** observed(null) = Host 说这个任务没有认领；未读到则是对应失败态。 */
  claim: V2ReadState<LoomClaim | null>
}

/** Run：Thread 里已记录的 AgentRun，只做定位与状态，不推断任务完成。 */
export interface V2RunFactsEntry {
  agentRunId: string
  agentId: string
  taskId: string | null
  status: ThreadSnapshot['agentRuns'][number]['status']
  /** Host 的原始等待原因；只在等待态展示，不据此推断授权或任务已完成。 */
  waitReason: string | null
  startedAt: string | null
  endedAt: string | null
}

/** 单个状态的三态：已记录 / 未记录 / 读不到。空不等于「没发生」。 */
export type V2StatusFact<T> =
  | { state: 'recorded'; value: T }
  | { state: 'not_recorded' }
  | { state: 'unavailable'; reason: V2UnavailableReason }

/** Artifact：登记、核验、Review、验收四个状态彼此独立。 */
export interface V2ArtifactFacts {
  artifact: LoomArtifact
  /** 证据归属候选（历史版本时是当初产出它的那一版），来自既有事实层。 */
  candidate: LoomCandidate | null
  /** 归属候选的既有事实（版本/链头/可验收/钉住的标准），不重复实现。 */
  overlay: ArtifactCandidateFacts
  /** 登记：产物行本身就是登记记录（sha256/字节由 Host 登记时算出）。登记不等于核验。 */
  registration: V2StatusFact<{
    sha256: string
    sizeBytes: number
    creatorId: string
    registeredAt: string
  }>
  /** 核验：只认不可变核验记录，与人工验收是两条轴。 */
  verification: V2StatusFact<LoomVerification>
  /** Review：只认不可变评审记录，不改写候选的验收状态。 */
  review: V2StatusFact<LoomReview>
  /** 验收：只认候选自身的验收投影，不因为存在 Review 记录而被改写。 */
  acceptance: V2StatusFact<LoomCandidate['acceptanceStatus']>
}

/** 一次只读快照：六类事实 + 明确尚不存在的 V2 接口。 */
export interface V2RunFacts {
  missionId: string
  goal: V2GoalFacts
  bots: V2ReadState<readonly V2BotFacts[]>
  lead: V2ReadState<V2LeadFacts>
  runs: V2ReadState<readonly V2RunFactsEntry[]>
  workers: readonly V2WorkerFacts[]
  artifacts: readonly V2ArtifactFacts[]
  claims: V2ReadState<V2ClaimProjection>
  /** V2 Bot 记录 / Goal 记录 / capability 物化接口都还不存在：恒 unavailable，不拿今天的投影冒充。 */
  pendingInterfaces: {
    bots: V2UnavailableFact
    goals: V2UnavailableFact
    capabilities: V2UnavailableFact
  }
}

// ------------------------------------------------------------ pure builders

export function goalFacts(mission: WorkBundle['mission']): V2GoalFacts {
  return {
    mission: {
      missionId: mission.missionId,
      threadId: mission.threadId,
      title: mission.title,
      description: mission.description,
      status: mission.status,
      defaultLeadAgentId: mission.defaultLeadAgentId,
      memberAgentIds: [...mission.memberAgentIds]
    },
    v2Record: notAvailable()
  }
}

export function botFacts(thread: ThreadSnapshot): V2BotFacts[] {
  return thread.members.map(member => ({
    agentId: member.agentId,
    displayName: member.displayName,
    teamRole: member.teamRole,
    isDefaultLead: member.isDefaultLead,
    membershipStatus: member.membershipStatus,
    presence: member.profilePresence
  }))
}

export function leadFacts(
  thread: ThreadSnapshot,
  mission: WorkBundle['mission'],
  bots: readonly V2BotFacts[]
): V2LeadFacts {
  const agentId = thread.thread.defaultLeadAgentId
  const bot = agentId === null ? null : bots.find(entry => entry.agentId === agentId) ?? null
  return { agentId, bot, matchesMissionLead: agentId === mission.defaultLeadAgentId }
}

export function runFacts(thread: ThreadSnapshot): V2RunFactsEntry[] {
  return thread.agentRuns.map(run => ({
    agentRunId: run.id,
    agentId: run.agentId,
    taskId: run.taskId,
    status: run.status,
    waitReason: run.waitReason ?? null,
    startedAt: run.startedAt,
    endedAt: run.endedAt
  }))
}

/**
 * Worker 事实：认领状态整批从 Host 投影来。未读到认领时每个任务都是同一原因的失败态，
 * 而不是「看起来没人认领」；assignee 只有被认领记成 claimant 时才算占着任务。
 */
export function workerFacts(
  bundle: WorkBundle,
  claims: V2ReadState<V2ClaimProjection>
): V2WorkerFacts[] {
  const failure = claims.status === 'observed' ? null : propagateFailure<LoomClaim | null>(claims)
  const latest = claims.status === 'observed' ? latestClaimByTask(claims.value.claims) : null
  return bundle.tasks.map(task => {
    const claim: V2ReadState<LoomClaim | null> = failure !== null
      ? failure
      : { status: 'observed', value: latest?.get(task.taskId) ?? null }
    const owner = claim.status === 'observed' ? claim.value : null
    const claimant = owner === null ? null : owner.claimantAgentId
    // 「正占着」要求这一代认领仍然未释放且未过期：释放是结论，过期是没续上，
    // 两者都只是历史事实，不能把该 Agent 说成还占着任务。
    const holds = owner !== null && owner.releasedAt === null && owner.expired === false
    return {
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      assigneeAgentId: task.assigneeAgentId,
      // assignee 是责任，不是授权：只有 Host 的活认领把它记成 claimant 才算。
      assigneeIsClaimant: task.assigneeAgentId !== null
        && claimant !== null
        && claimant === task.assigneeAgentId
        && holds,
      blockedReason: task.blockedReason,
      claim
    }
  })
}

/**
 * Artifact 事实：四个状态各读各的来源。没有归属候选时，核验/Review/验收都是
 * `unavailable(no_candidate)`——没有主体就没有结论，不写「未核验/待验收」冒充已知。
 */
export function artifactFacts(
  bundle: WorkBundle,
  preferredFor: (artifact: LoomArtifact) => LoomCandidate | null = () => null
): V2ArtifactFacts[] {
  return bundle.artifacts.map((artifact): V2ArtifactFacts => {
    const overlay = artifactCandidateFacts(bundle, artifact, preferredFor(artifact))
    const candidate = overlay.candidate
    const missing: V2StatusFact<never> = { state: 'unavailable', reason: 'no_candidate' }
    return {
      artifact,
      candidate,
      overlay,
      registration: {
        state: 'recorded',
        value: {
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          creatorId: artifact.creatorId,
          registeredAt: artifact.createdAt
        }
      },
      verification: candidate === null
        ? missing
        : overlay.verification === null
          ? { state: 'not_recorded' }
          : { state: 'recorded', value: overlay.verification },
      review: candidate === null
        ? missing
        : overlay.review === null
          ? { state: 'not_recorded' }
          : { state: 'recorded', value: overlay.review },
      acceptance: candidate === null
        ? missing
        : { state: 'recorded', value: candidate.acceptanceStatus }
    }
  })
}

// ------------------------------------------------------------- orchestrator

export interface V2RunFactsInput {
  port: V2RunPort
  /** Host 的明确宣告；null = 什么都没宣告。observe-readonly 路径下不读它、不伪造它。 */
  declaration: V2HostDeclaration | null
  missionId: string
  bundle: WorkBundle
  thread: ThreadSnapshot
  /** 可选：调用方已选中的候选（必须自己拥有这份证据），否则取最新拥有者。 */
  preferredFor?: (artifact: LoomArtifact) => LoomCandidate | null
  /** 默认 'declared'：保持未宣告零请求语义；'observe-readonly' 改走一次只读观测。 */
  claimsAccess?: V2ClaimsAccess
}

/**
 * 只读快照入口。先对表 Mission（空白→mission_required，与事实包不一致→mission_mismatch，
 * 两种情况都不发请求），Mission 一致后才发唯一可能的一次 `loom.claims.list`：默认
 * 'declared' 只在 Host 宣告了它时发；'observe-readonly' 在已认证通道上直接观测一次，
 * 不读不伪造宣告。其余事实全部来自调用方已拿到的 Mission 投影与 Thread 投影。
 * 读不到就如实标注，绝不因为读不到而编一份「空进度」。
 */
export async function readV2RunFacts(input: V2RunFactsInput): Promise<V2RunFacts> {
  // Mission 先对表：空白不猜一个去查，与事实包不一致不发请求、也不把另一个
  // Mission 的认领回执映射到当前任务上。
  const requestedMission = input.missionId.trim()
  const missionMatchesBundle = requestedMission === input.bundle.mission.missionId.trim()
  const claims = requestedMission === ''
    ? { status: 'unavailable', reason: 'mission_required' } as const
    : !missionMatchesBundle
      ? { status: 'unavailable', reason: 'mission_mismatch' } as const
      : input.claimsAccess === 'observe-readonly'
        ? await readClaimsListObserved(input.port, input.missionId)
        : await readClaimsList(input.port, input.declaration, input.missionId)
  const threadMatchesMission = input.thread.thread.id === input.bundle.mission.threadId
  const bots = threadMatchesMission ? botFacts(input.thread) : null
  return {
    missionId: input.bundle.mission.missionId,
    goal: goalFacts(input.bundle.mission),
    bots: bots === null
      ? threadMismatch<readonly V2BotFacts[]>()
      : { status: 'observed', value: bots },
    lead: bots === null
      ? threadMismatch<V2LeadFacts>()
      : { status: 'observed', value: leadFacts(input.thread, input.bundle.mission, bots) },
    runs: threadMatchesMission
      ? { status: 'observed', value: runFacts(input.thread) }
      : threadMismatch<readonly V2RunFactsEntry[]>(),
    workers: workerFacts(input.bundle, claims),
    artifacts: artifactFacts(input.bundle, input.preferredFor),
    claims,
    pendingInterfaces: {
      bots: notAvailable(),
      goals: notAvailable(),
      capabilities: notAvailable()
    }
  }
}

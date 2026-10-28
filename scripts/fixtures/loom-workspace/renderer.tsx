import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentProfile, MissionActivity, MissionDelivery, MissionRecord, LoomPlan, LoomTask, LoomTaskStatus, LoomDependency, LoomCandidate, LoomReview, LoomVerification, LoomReviewRecordInput, LoomReviewRecordReceipt, LoomVerificationRecordInput, LoomVerificationRecordReceipt, LoomClaim, LoomClaimsListResult } from '@contracts'
import { LoomWorkspace } from '../../../apps/desktop/src/renderer/src/LoomWorkspace'
import { ThreadClientProvider, type ThreadClient } from '../../../apps/desktop/src/renderer/src/camp-client'
import { applyAppearanceSnapshot } from '../../../apps/desktop/src/renderer/src/theme'
import { DEFAULT_APPEARANCE } from '../../../apps/desktop/src/shared/appearance'
import '../../../apps/desktop/src/renderer/src/styles.css'
import '../../../apps/desktop/src/renderer/src/mission.css'
import '../../../apps/desktop/src/renderer/src/loom-workspace.css'

// UI-only acceptance for the production LOOM workspace: production component tree,
// production stylesheets and a deterministic in-memory Thread client.
// No Core, SQLite, Skill Library, Runtime or daily userData is touched here.

type LoomCall = { method: string; params: unknown }
// 写入回执也留在 fixtures 侧：payload 与回执都要能在验收脚本里逐字段断言。
type LoomWrite = {
  method: string
  params: Record<string, unknown>
  receipt: LoomReviewRecordReceipt | LoomVerificationRecordReceipt
}
type LoomState = {
  plan: LoomPlan
  tasks: LoomTask[]
  candidates: LoomCandidate[]
  reviews: LoomReview[]
  verifications: LoomVerification[]
}
// 认领回读的六种回包形态：空 / held / 同任务多代次 / 租约过期 / 已释放 / 认领者为空。
type LoomClaimsScenario = 'empty' | 'held' | 'multiGeneration' | 'expired' | 'released' | 'anonymous'
type LoomQa = {
  calls: LoomCall[]
  writes: LoomWrite[]
  errors: string[]
  selections: string[]
  countOf(method: string): number
  state(): LoomState
  reset(): void
  setTheme(theme: 'day' | 'night'): void
  setClaims(scenario: LoomClaimsScenario, options?: { fail?: boolean }): void
}
declare global { interface Window { loomQA: LoomQa } }

const createdAt = '2026-09-27T08:00:00.000Z'
// 候选提交把 ready 推进到 in_review：真实 Core 在同一条命令里把任务 updated_at 推到提交时刻、revision +1，
// 夹具跟着这两个一致性字段走，不造一个「状态变了但时间线没变」的假基线。
const submittedAt = '2026-09-27T08:30:00.000Z'
const baseSha = 'a'.repeat(40)

function agentProfile(agentId: string, displayName: string, memberOrder: number): AgentProfile {
  return {
    agentId, displayName, avatarRef: null, accent: null, teamRole: '队员',
    professionalResponsibilities: '实现与复核', personalityTraits: [], workingPrinciples: '',
    growthTopic: '', defaultCapabilities: [], presence: 'present', runtimeConfiguration: null,
    runtimeReadiness: { status: 'light_ready', blockers: [] }, memberOrder, version: 1,
    createdAt, updatedAt: createdAt, removedAt: null
  }
}

const agents: AgentProfile[] = [agentProfile('agent-lead', '亚纪', 0), agentProfile('agent-build', '临舟', 1)]

const mission: MissionRecord = {
  missionId: 'mission-loom-018', title: '补齐使命工作区恢复路径',
  description: '让使命从保存、开始、恢复到交付都有清晰的状态。',
  status: 'in_progress', sourceMessageId: null, number: 18, hasUnread: false,
  threadId: 'rvcamp_01h47kvsy5fk1shh6w1g60eec1', projectPath: '/workspace/rovai-ai',
  projectBindingKind: 'directory', detailsVersion: 1, tags: ['Core'], attachments: [],
  createdAt, updatedAt: createdAt, memberAgentIds: agents.map(agent => agent.agentId),
  defaultLeadAgentId: agents[0].agentId, runningAgentIds: [agents[1].agentId], startAvailable: false,
  workspaceEverCreated: true, workspaceResourcesPresent: true, cleanupAvailable: true
}

// Mock LOOM Plan/Task/Dependency for archify flow view
const plan: LoomPlan = {
  planId: 'plan-loom-018',
  missionId: mission.missionId,
  goal: '实现工作区恢复与验收闭环',
  acceptanceCriteria: {
    version: 'v1',
    criteria: [
      { criterionId: 'c1', text: '工作区保存后可恢复' },
      { criterionId: 'c2', text: '交付有独立验收记录' }
    ]
  },
  createdAt,
  revision: 1
}

const tasks: LoomTask[] = [
  {
    taskId: 'task-1', planId: plan.planId,
    title: '设计恢复协议', description: '定义工作区快照格式',
    assigneeAgentId: 'agent-lead', status: 'done',
    acceptanceCriteria: plan.acceptanceCriteria,
    blockedReason: null, createdAt, updatedAt: createdAt, revision: 1
  },
  {
    taskId: 'task-2', planId: plan.planId,
    title: '实现快照保存', description: '在 Core 中实现工作区快照',
    assigneeAgentId: 'agent-build', status: 'done',
    acceptanceCriteria: plan.acceptanceCriteria,
    blockedReason: null, createdAt, updatedAt: createdAt, revision: 1
  },
  // task-3 的候选已提交，所以基线状态是 in_review（ready → in_review 由候选提交完成）。
  // 真实 Core 只允许 in_review 的任务被评审（LOOM_TASK_NOT_IN_REVIEW），夹具不再留一条
  // 「ready 直接接受评审」的迁移给 UI 走。
  {
    taskId: 'task-3', planId: plan.planId,
    title: '实现恢复逻辑', description: '从快照恢复工作区状态',
    assigneeAgentId: 'agent-build', status: 'in_review',
    acceptanceCriteria: plan.acceptanceCriteria,
    blockedReason: null, createdAt, updatedAt: submittedAt, revision: 2
  },
  {
    taskId: 'task-4', planId: plan.planId,
    title: '验收测试', description: '验证恢复正确性',
    assigneeAgentId: 'agent-lead', status: 'blocked',
    acceptanceCriteria: plan.acceptanceCriteria,
    blockedReason: '等待恢复逻辑完成', createdAt, updatedAt: createdAt, revision: 1
  }
]

const dependencies: LoomDependency[] = [
  { dependencyId: 'dep-1', planId: plan.planId, upstreamTaskId: 'task-1', downstreamTaskId: 'task-2', condition: 'task_done', resolvedArtifactId: null, resolution: null, createdAt },
  { dependencyId: 'dep-2', planId: plan.planId, upstreamTaskId: 'task-2', downstreamTaskId: 'task-3', condition: 'task_done', resolvedArtifactId: null, resolution: null, createdAt },
  { dependencyId: 'dep-3', planId: plan.planId, upstreamTaskId: 'task-3', downstreamTaskId: 'task-4', condition: 'artifact_accepted', resolvedArtifactId: null, resolution: null, createdAt }
]

// 候选与验收记录：task-1 已核验且已验收，task-3 的候选等待评审（任务处于 in_review），
// 所以 task-4 的 artifact_accepted 边仍然未释放，blocked 断言继续成立。
const loomCriteria = plan.acceptanceCriteria
const candidates: LoomCandidate[] = [
  { candidateId: 'candidate-1', taskId: 'task-1', agentRunId: 'run-1', contentHash: 'sha256:restore-protocol', evidenceIds: ['evidence-1', 'evidence-2'], acceptanceCriteria: loomCriteria, previousCandidateId: null, verificationStatus: 'verified', acceptanceStatus: 'accepted', createdAt },
  { candidateId: 'candidate-2', taskId: 'task-3', agentRunId: 'run-2', contentHash: 'sha256:restore-runtime', evidenceIds: ['evidence-3'], acceptanceCriteria: loomCriteria, previousCandidateId: null, verificationStatus: 'unverified', acceptanceStatus: 'pending', createdAt }
]

const reviews: LoomReview[] = [
  { reviewId: 'review-1', candidateId: 'candidate-1', acceptanceCriteriaVersion: loomCriteria.version, verdict: 'accepted', reason: '恢复协议已覆盖保存与恢复两条路径', criteriaResults: loomCriteria.criteria.map((criterion, index) => ({ criterionId: criterion.criterionId, satisfied: true, evidenceIds: [`evidence-${index + 1}`], note: null })), reviewerId: 'local_user', reviewedAt: createdAt }
]

const verifications: LoomVerification[] = [
  { verificationId: 'verification-1', candidateId: 'candidate-1', method: 'manual', executorId: 'local_user', result: 'passed', evidenceIds: ['evidence-1'], verifiedAt: createdAt }
]

// 认领回读：loom.claims.list 的回包由用例切换。时刻一律固定成字符串——evaluatedAt 是服务端
// 判定过期用的那一个瞬间，租约时间同理；任何一处用 Date.now() 都会让「已过期 / 未过期」
// 随运行时刻翻面，同一份夹具就不再有确定结论。
const claimsEvaluatedAt = '2026-09-27T10:00:00.000Z'
const claimClaimedAt = '2026-09-27T09:50:00.000Z'
const claimLeaseOpen = '2026-09-27T10:05:00.000Z'
const claimLeaseLapsed = '2026-09-27T09:55:00.000Z'
const claimReleasedAt = '2026-09-27T09:58:00.000Z'

function makeClaim(claim: Pick<LoomClaim, 'claimId' | 'taskId' | 'agentRunId'> & Partial<LoomClaim>): LoomClaim {
  return {
    claimId: claim.claimId,
    taskId: claim.taskId,
    agentRunId: claim.agentRunId,
    claimantAgentId: claim.claimantAgentId ?? null,
    fenceGeneration: claim.fenceGeneration ?? 1,
    claimedAt: claim.claimedAt ?? claimClaimedAt,
    leaseExpiresAt: claim.leaseExpiresAt ?? claimLeaseOpen,
    releasedAt: claim.releasedAt ?? null,
    expired: claim.expired ?? false
  }
}

const claimsByScenario: Readonly<Record<LoomClaimsScenario, LoomClaim[]>> = {
  // a. 空列表：没有认领时 Core 回空数组，UI 必须落到 none，而不是留一块空壳。
  empty: [],
  // b. 单条 held：task-2 被临舟的 run 占着，租约在未来、fence 第 1 代。
  held: [makeClaim({ claimId: 'claim-task-2-fence-1', taskId: 'task-2', agentRunId: 'run-8f3a2c11', claimantAgentId: 'agent-build', fenceGeneration: 1 })],
  // c. 同一任务多代次：fence 1 已释放、fence 2 held，节点只能显示最高的 fence 2。
  multiGeneration: [
    makeClaim({ claimId: 'claim-task-3-fence-1', taskId: 'task-3', agentRunId: 'run-0d1e2f33', claimantAgentId: 'agent-lead', fenceGeneration: 1, releasedAt: claimReleasedAt }),
    makeClaim({ claimId: 'claim-task-3-fence-2', taskId: 'task-3', agentRunId: 'run-9c8d7e66', claimantAgentId: 'agent-build', fenceGeneration: 2 })
  ],
  // d. 租约过期：releasedAt 仍为空，expired 由服务端判定为 true。
  expired: [makeClaim({ claimId: 'claim-task-4-fence-1', taskId: 'task-4', agentRunId: 'run-4a4a4a44', claimantAgentId: 'agent-lead', leaseExpiresAt: claimLeaseLapsed, expired: true })],
  // e. 已释放（且刻意让 expired 也为 true）：释放是结论，过期只是没续上，UI 必须先认释放。
  released: [makeClaim({ claimId: 'claim-task-1-fence-1', taskId: 'task-1', agentRunId: 'run-2b2b2b22', claimantAgentId: 'agent-build', releasedAt: claimReleasedAt, expired: true })],
  // f. claimantAgentId 为 null：没有绑定 Agent 的认领只能回退到 agentRunId 原值。
  anonymous: [makeClaim({ claimId: 'claim-task-2-fence-1', taskId: 'task-2', agentRunId: 'run-7f7f7f7f', claimantAgentId: null })]
}

let claimsScenario: LoomClaimsScenario = 'empty'
// 读失败开关：打开后 loom.claims.list 直接抛错。抛错不等于「夹具没应答这个方法」，所以
// 不进 errors；UI 必须落到「认领状态未知」，不许自己猜一个 none 或一个 held。
let claimsReadFails = false

function readClaims(): LoomClaimsListResult {
  if (claimsReadFails) throw new Error('LOOM fixture forced the claims projection read to fail')
  return { evaluatedAt: claimsEvaluatedAt, claims: structuredClone(claimsByScenario[claimsScenario]) }
}

const delivery: MissionDelivery = {
  threadId: mission.threadId, workingDirectory: '/workspace/rovai-ai-mission-018', git: true,
  workspace: {
    id: 'workspace-mission-loom-018', missionId: mission.missionId, threadId: mission.threadId,
    executionHostId: 'host-local', sourceDirectory: '/workspace/rovai-ai',
    repositoryRoot: '/workspace/rovai-ai', gitCommonDir: '/workspace/rovai-ai/.git',
    worktreePath: '/workspace/rovai-ai-mission-018',
    workingDirectory: '/workspace/rovai-ai-mission-018',
    baseBranch: 'main', managedBranch: 'rovai/mission/018', baseSha, state: 'ready',
    cleanupWorktreeRemoved: false, cleanupBranchRemoved: false, diagnostic: null
  },
  pullRequests: [], files: Array.from({ length: 18 }, (_, index) => ({
    attachmentId: `delivery-attachment-${index}`, displayName: `review-evidence-${String(index + 1).padStart(2, '0')}.md`,
    kind: 'file', fileCount: 1, mediaType: 'text/markdown', byteSize: 1024, previewKind: 'none',
    messageId: `delivery-message-${index}`, agentId: agents[index % agents.length].agentId, createdAt
  }))
}

const activity: MissionActivity[] = [
  { id: 4, kind: 'created', actorType: 'user', actorId: 'local_user', changes: {}, createdAt },
  { id: 3, kind: 'started', actorType: 'agent', actorId: agents[0].agentId, changes: {}, createdAt },
  { id: 2, kind: 'status', actorType: 'agent', actorId: agents[0].agentId, changes: { status: 'in_progress' }, createdAt },
  { id: 1, kind: 'members', actorType: 'user', actorId: 'local_user', changes: {}, createdAt },
  ...Array.from({ length: 80 }, (_, index): MissionActivity => ({
    id: 100 + index, kind: index % 2 ? 'members' : 'lead', actorType: 'agent',
    actorId: agents[index % agents.length].agentId, changes: {}, createdAt
  }))
]

const calls: LoomCall[] = []
const writes: LoomWrite[] = []
const errors: string[] = []
const selections: string[] = []

// 写入侧状态：验收/核验两条轴的写结果直接落在内存投影上，六个读方法随之回读一致数据。
const writeStamp = '2026-09-27T09:00:00.000Z'
let writeSequence = 0
// 每条点击用例都从同一初始态开始：基线在首次写入前冻结，reset() 原样拷回。
const baseline = {
  tasks: structuredClone(tasks),
  candidates: structuredClone(candidates),
  reviews: structuredClone(reviews),
  verifications: structuredClone(verifications)
}

function restoreBaseline<T>(target: T[], source: readonly T[]): void {
  target.splice(0, target.length, ...structuredClone(source))
}

/** 验收写入：接受 → done/accepted，驳回 → ready/rejected；回执照 LoomReviewRecordReceipt 全字段。 */
function recordLoomReview(input: LoomReviewRecordInput): LoomReviewRecordReceipt {
  const task = tasks.find(entry => entry.taskId === input.taskId)
  if (task === undefined) throw new Error(`LOOM fixture has no task ${input.taskId}`)
  const candidate = candidates.find(entry => entry.candidateId === input.candidateId)
  if (candidate === undefined) throw new Error(`LOOM fixture has no candidate ${input.candidateId}`)
  // 真实 Core 只评审 in_review 的任务（crates/rovai-core/src/loom.rs:2271 LOOM_TASK_NOT_IN_REVIEW）。
  // 夹具不比 Core 宽松：别的状态一律拒绝，免得 UI 测到一条真实 Core 不接受的迁移。
  if (task.status !== 'in_review') {
    throw new Error(`LOOM task ${task.taskId} is ${task.status} and cannot be reviewed`)
  }
  const taskIndex = tasks.indexOf(task)
  const candidateIndex = candidates.indexOf(candidate)
  writeSequence += 1
  const review: LoomReview = {
    reviewId: `review-fixture-${writeSequence}`,
    candidateId: candidate.candidateId,
    acceptanceCriteriaVersion: input.acceptanceCriteriaVersion,
    verdict: input.verdict,
    reason: input.reason,
    criteriaResults: input.criteriaResults.map(result => ({ ...result, evidenceIds: [...result.evidenceIds] })),
    // 契约里 reviewerId 由 Core 从可信身份注入（CURRENT_USER_ID）；fixture 落的就是那个唯一身份。
    reviewerId: 'local_user',
    reviewedAt: writeStamp
  }
  const taskStatus: LoomTaskStatus = input.verdict === 'accepted' ? 'done' : 'ready'
  reviews.push(review)
  candidates[candidateIndex] = { ...candidate, acceptanceStatus: input.verdict }
  // Core 在评审落库时一并改写任务 updated_at 与 revision（accepted → DONE，rejected → READY）。
  tasks[taskIndex] = { ...task, status: taskStatus, updatedAt: writeStamp, revision: task.revision + 1 }
  return {
    review,
    missionId: input.missionId,
    planId: task.planId,
    taskId: task.taskId,
    taskStatus,
    candidateAcceptanceStatus: input.verdict,
    releasedDependencyIds: [],
    replayed: false
  }
}

/** 核验写入：passed → verified，failed → failed；核验与验收是两条独立的轴。 */
function recordLoomVerification(input: LoomVerificationRecordInput): LoomVerificationRecordReceipt {
  const task = tasks.find(entry => entry.taskId === input.taskId)
  if (task === undefined) throw new Error(`LOOM fixture has no task ${input.taskId}`)
  const candidate = candidates.find(entry => entry.candidateId === input.candidateId)
  if (candidate === undefined) throw new Error(`LOOM fixture has no candidate ${input.candidateId}`)
  const candidateIndex = candidates.indexOf(candidate)
  writeSequence += 1
  const verification: LoomVerification = {
    verificationId: `verification-fixture-${writeSequence}`,
    candidateId: candidate.candidateId,
    method: input.method,
    // 契约里 executorId 由 Core 从可信 Host 身份注入；fixture 落的就是那个唯一身份。
    executorId: 'local_user',
    result: input.result,
    evidenceIds: input.evidenceIds === undefined ? [] : [...input.evidenceIds],
    verifiedAt: writeStamp
  }
  const candidateVerificationStatus = input.result === 'passed' ? 'verified' : 'failed'
  verifications.push(verification)
  candidates[candidateIndex] = { ...candidate, verificationStatus: candidateVerificationStatus }
  return {
    verification,
    missionId: input.missionId,
    planId: task.planId,
    taskId: task.taskId,
    candidateVerificationStatus,
    releasedDependencyIds: [],
    replayed: false
  }
}

const replies: Readonly<Record<string, unknown>> = {
  'preferences.tasks.get': { enabled: false, headsUpAfterSequence: 0, observedThroughChangeSequence: 0 },
  'missions.delivery': delivery,
  'missions.activity': activity,
  'loom.plan.get': plan,
  'loom.tasks.list': tasks,
  'loom.dependencies.list': dependencies,
  'loom.candidates.list': candidates,
  'loom.reviews.list': reviews,
  'loom.verifications.list': verifications
}

async function request<T>(method: string, params: unknown = {}): Promise<T> {
  calls.push({ method, params })
  let reply: unknown
  if (method === 'loom.review.record') {
    const receipt = recordLoomReview(params as LoomReviewRecordInput)
    writes.push({ method, params: params as Record<string, unknown>, receipt })
    reply = receipt
  } else if (method === 'loom.verification.record') {
    const receipt = recordLoomVerification(params as LoomVerificationRecordInput)
    writes.push({ method, params: params as Record<string, unknown>, receipt })
    reply = receipt
  } else if (method === 'loom.claims.list') {
    // 认领投影按场景生成；读失败开关在这里抛错，让 UI 走「认领状态未知」分支。
    reply = readClaims()
  } else if (method === 'missions.diffSession.release') {
    // 写成功后的收尾副作用：只应答，不进 writes，也不参与 loom 写方法统计。
    reply = { released: true }
  } else {
    reply = replies[method]
  }
  if (reply === undefined) {
    errors.push(method)
    throw new Error(`LOOM fixture has no reply for ${method}`)
  }
  return structuredClone(reply) as T
}

const client = {
  request, platform: 'darwin',
  attachments: {
    kind: 'download',
    download: async () => { throw new Error('LOOM fixture must not download an attachment') }
  }
} as unknown as ThreadClient

function setTheme(theme: 'day' | 'night'): void {
  applyAppearanceSnapshot(document.documentElement, { ...DEFAULT_APPEARANCE, preference: theme, resolvedTheme: theme })
}

// Hidden Electron acceptance windows still model an attentive foreground user.
Object.defineProperty(document, 'hasFocus', { value: () => true })
Object.defineProperty(document, 'visibilityState', { value: 'visible' })
setTheme(new URLSearchParams(location.search).get('theme') === 'night' ? 'night' : 'day')

// reset() 换 key 强制重挂载：LoomWorkspace 会按恢复后的初始数据重读六个投影，
// 这样每条点击用例都从同一个初始态开始，不继承上一条用例写下的结论。
let remountWorkspace: () => void = () => undefined

function LoomFixture() {
  const [generation, setGeneration] = useState(0)
  remountWorkspace = () => setGeneration(current => current + 1)
  return <ThreadClientProvider client={client}>
    <LoomWorkspace
      key={generation}
      mission={mission}
      agents={agents}
      onSource={messageId => { selections.push(messageId) }}
      onNotify={() => undefined}
      onWorkspaceCleanupRequested={async () => undefined}
    />
  </ThreadClientProvider>
}

window.loomQA = {
  calls, writes, errors, selections,
  countOf: method => calls.filter(call => call.method === method).length,
  state: () => structuredClone({ plan, tasks, candidates, reviews, verifications }),
  reset: () => {
    restoreBaseline(tasks, baseline.tasks)
    restoreBaseline(candidates, baseline.candidates)
    restoreBaseline(reviews, baseline.reviews)
    restoreBaseline(verifications, baseline.verifications)
    // 认领回读也回初始态：空列表、读成功，下一条用例自己切形态。
    claimsScenario = 'empty'
    claimsReadFails = false
    calls.length = 0
    writes.length = 0
    remountWorkspace()
  },
  setTheme,
  // 切回包后重挂载：无论生产侧是「挂载时读」「进编排时读」还是「写后重读」，都会拿到新回包。
  setClaims: (scenario, options) => {
    claimsScenario = scenario
    claimsReadFails = options?.fail === true
    remountWorkspace()
  }
}

createRoot(document.getElementById('root')!).render(<LoomFixture />)

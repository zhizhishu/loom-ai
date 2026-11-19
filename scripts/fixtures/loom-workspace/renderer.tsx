import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentProfile, ExecutionNodeRecord, MissionActivity, MissionDelivery, MissionRecord, NodeOutputPage, LoomPlan, LoomTask, LoomTaskStatus, LoomDependency, LoomCandidate, LoomReview, LoomVerification, LoomReviewRecordInput, LoomReviewRecordReceipt, LoomVerificationRecordInput, LoomVerificationRecordReceipt, LoomClaim, LoomClaimsListResult, LoomArtifact, LoomArtifactsListResult } from '@contracts'
// 控制层类型只从 renderer 的唯一切换点取，不在夹具里另写一套。
import type { LoomControlPauseInput, LoomControlPolicy, LoomControlPolicyInput, LoomControlSnapshot, LoomDispatch, LoomStageReview } from '../../../apps/desktop/src/renderer/src/loom-control-model'
import { LoomWorkspace } from '../../../apps/desktop/src/renderer/src/LoomWorkspace'
import type { NodeApi } from '../../../apps/desktop/src/renderer/src/nodes-api'
import { ThreadClientProvider, type ThreadClient } from '../../../apps/desktop/src/renderer/src/camp-client'
import { applyAppearanceSnapshot } from '../../../apps/desktop/src/renderer/src/theme'
import { DEFAULT_APPEARANCE } from '../../../apps/desktop/src/shared/appearance'
import type { LoomArtifactPreviewInput, LoomArtifactPreviewResult } from '@contracts'
import '../../../apps/desktop/src/renderer/src/styles.css'
import '../../../apps/desktop/src/renderer/src/mission.css'
import '../../../apps/desktop/src/renderer/src/loom-workspace.css'
// Mikka 外壳／对话／右栏 + 组合层：夹具是独立的右栏工作区，不是 navigation-shell，
// 所以只给根节点挂 .loom-mikka 拿到令牌与作用域，不引入外壳布局。
import '../../../apps/desktop/src/renderer/src/loom-mikka-shell.css'
import '../../../apps/desktop/src/renderer/src/loom-mikka-chat.css'
import '../../../apps/desktop/src/renderer/src/loom-mikka-panel.css'
import '../../../apps/desktop/src/renderer/src/loom-mikka.css'

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
type LoomClaimsScenario = 'empty' | 'held' | 'multiGeneration' | 'expired' | 'released' | 'anonymous' | 'live'
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
  setArtifacts(options?: { fail?: boolean }): void
  setLive(mode: 'mixed' | 'none'): void
  failClaimsWithNodes(): void
  setPlanHidden(hidden: boolean): void
  setControl(options?: { fail?: boolean; approved?: boolean; paused?: boolean; partial?: boolean }): void
  setReworkChain(): void
  driftControlRevision(): void
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
    blockedReason: null, executionHostId: 'node_local', createdAt, updatedAt: submittedAt, revision: 2
  },
  {
    taskId: 'task-4', planId: plan.planId,
    title: '验收测试', description: '验证恢复正确性',
    assigneeAgentId: 'agent-lead', status: 'blocked',
    acceptanceCriteria: plan.acceptanceCriteria,
    blockedReason: '等待恢复逻辑完成', executionHostId: 'node_desk', createdAt, updatedAt: createdAt, revision: 1
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
  anonymous: [makeClaim({ claimId: 'claim-task-2-fence-1', taskId: 'task-2', agentRunId: 'run-7f7f7f7f', claimantAgentId: null })],
  live: [
    makeClaim({ claimId: 'claim-live-local', taskId: 'task-3', agentRunId: 'run-local-1', claimantAgentId: 'agent-build' }),
    makeClaim({ claimId: 'claim-live-remote', taskId: 'task-4', agentRunId: 'run-remote-1', claimantAgentId: 'agent-lead' })
  ]
}

function encodeFrame(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

let liveNodes: ExecutionNodeRecord[] = []
let liveLines: string[] = []
let planHidden = false

function mixedNodes(): ExecutionNodeRecord[] {
  const startedAt = new Date(Date.now() - 90_000).toISOString()
  const heartbeat = new Date(Date.now() - 40_000).toISOString()
  return [
    {
      nodeId: 'node_local', displayName: 'loom-a', role: 'local', revocable: false, status: 'online',
      os: 'linux', arch: 'x64', pairedAt: startedAt, revokedAt: null, lastHeartbeat: new Date().toISOString(),
      activeRunCount: 1,
      activeRuns: [{ runId: 'run-local-1', attempt: 1, runtime: 'codex-cli', status: 'running', ackedSeq: 1, startedAt }],
      clis: []
    },
    {
      nodeId: 'node_desk', displayName: 'desk-b', role: 'remote', revocable: true, status: 'offline',
      os: 'linux', arch: 'x64', pairedAt: startedAt, revokedAt: null, lastHeartbeat: heartbeat,
      activeRunCount: 1,
      activeRuns: [{ runId: 'run-remote-1', attempt: 1, runtime: 'claude-code-cli', status: 'running', ackedSeq: 8, startedAt }],
      clis: []
    }
  ]
}

const fixtureNodes: NodeApi = {
  list: async () => ({ nodes: structuredClone(liveNodes) }),
  pair: async () => { throw new Error('LOOM fixture does not pair nodes') },
  revoke: async () => { throw new Error('LOOM fixture does not revoke nodes') },
  output: async (runId, from): Promise<NodeOutputPage> => {
    if (runId === 'run-local-1' && liveLines.length < 40) liveLines.push(`帧 ${liveLines.length + 1}`)
    const source = runId === 'run-local-1' ? liveLines : ['远端停在断线前']
    const frames = source.map((text, index) => ({ seq: index + 1, stream: 'stdout', data: encodeFrame(text) }))
      .filter(frame => frame.seq >= from)
    const last = frames.at(-1)
    return {
      runId,
      attempt: 1,
      nodeId: runId === 'run-remote-1' ? 'node_desk' : 'node_local',
      runtime: runId === 'run-remote-1' ? 'claude-code-cli' : 'codex-cli',
      status: 'running',
      ackedSeq: source.length,
      exitCode: null,
      frames,
      truncated: false,
      nextFrom: last ? last.seq + 1 : from
    }
  }
}

let claimsScenario: LoomClaimsScenario = 'empty'
// 读失败开关：打开后 loom.claims.list 直接抛错。抛错不等于「夹具没应答这个方法」，所以
// 不进 errors；UI 必须落到「认领状态未知」，不许自己猜一个 none 或一个 held。
let claimsReadFails = false

function readClaims(): LoomClaimsListResult {
  if (claimsReadFails) throw new Error('LOOM fixture forced the claims projection read to fail')
  return { evaluatedAt: claimsEvaluatedAt, claims: structuredClone(claimsByScenario[claimsScenario]) }
}

// 产物登记回读：固定两条。一条与候选的 evidenceId 对得上（evidence-1），一条对不上任何候选
// （evidence-9），好让「已登记 / 未登记」两个分支在同一张卡片上同时可见。
// sha256 都是合法 64 位十六进制，sizeBytes 一小一大（512 B / 2.5 MiB），单位换算能被断言。
const artifactsRegisteredAt = '2026-09-27T09:30:00.000Z'
const artifactShaShort = 'a1b2c3d4'.repeat(8)
const artifactShaLong = 'f0e1d2c3'.repeat(8)
const artifacts: LoomArtifact[] = [
  {
    artifactId: 'evidence-1', planId: plan.planId, taskId: 'task-1', agentRunId: 'run-1',
    relativePath: 'artifacts/restore-protocol.md', sha256: artifactShaShort, sizeBytes: 512,
    contentType: 'text/markdown', creatorId: 'local_user', createdAt: artifactsRegisteredAt
  },
  {
    artifactId: 'evidence-9', planId: plan.planId, taskId: null, agentRunId: null,
    relativePath: 'artifacts/runtime/restore-trace-with-a-deliberately-long-file-name.log',
    sha256: artifactShaLong, sizeBytes: 2_621_440, contentType: 'text/plain',
    creatorId: 'local_user', createdAt: artifactsRegisteredAt
  }
]

// 读失败开关：打开后 loom.artifacts.list 直接抛错。抛错不等于「夹具没应答这个方法」，所以不进
// errors；UI 只能把候选卡的产物区降级成「产物信息读取失败」，不许说成「未登记」，也不许拦下其余投影。
let artifactsReadFails = false

function readArtifacts(): LoomArtifactsListResult {
  if (artifactsReadFails) throw new Error('LOOM fixture forced the artifacts projection read to fail')
  return { artifacts: structuredClone(artifacts) }
}

// 正文只读预览：只有 evidence-1 归档了正文，文本固定，供浮层断言使用；其余产物按 Core 的语义
// 回 not_archived，不编造正文。预览不记录任何验收/核验状态。
const artifactPreviewText: Readonly<Record<string, string>> = {
  'evidence-1': '# 恢复协议\n\n恢复顺序：快照 → 校验 → 回放。\n回滚窗口：15 分钟。\n\nLOOM-PREVIEW-READY\n'
}

function readArtifactPreview(input: LoomArtifactPreviewInput): LoomArtifactPreviewResult {
  const artifact = artifacts.find(entry => entry.artifactId === input.artifactId)
  if (artifact === undefined) throw new Error(`LOOM fixture has no artifact ${input.artifactId}`)
  const text = artifactPreviewText[artifact.artifactId]
  return {
    artifactId: artifact.artifactId,
    relativePath: artifact.relativePath,
    contentType: artifact.contentType,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    text: text === undefined ? null : text,
    unavailableReason: text === undefined ? 'not_archived' : null
  }
}

// 助手审查（stageReviews）与技术核验、用户接受是三条独立的轴。
// 基线：candidate-1 阶段审查通过，candidate-2 还没有审查（任务停在 in_review）。
const stageReviewsBaseline: LoomStageReview[] = [{
  stageReviewId: 'stage-review-1', taskId: 'task-1', candidateId: 'candidate-1',
  reviewerAgentId: 'agent-lead', reviewerAgentRunId: 'run-review-1', policyRevision: 1,
  manifestHash: 'sha256:manifest-1', verdict: 'pass', reason: '协议与验收标准一一对应',
  criteriaResults: loomCriteria.criteria.map((criterion, index) => ({
    criterionId: criterion.criterionId, satisfied: true,
    evidenceIds: index === 0 ? ['evidence-1'] : [], note: null
  })),
  reviewedAt: artifactsRegisteredAt
}]

// 派发记录：一条已结算的执行派发 + 一条在途的审查派发，预算用得起来也读得出来。
const dispatchesBaseline: LoomDispatch[] = [
  { dispatchId: 'dispatch-1', taskId: 'task-3', kind: 'execute', candidateId: null, policyRevision: 1, recipientAgentId: 'agent-build', deliveryId: null, status: 'settled', reason: null, createdAt },
  { dispatchId: 'dispatch-2', taskId: 'task-3', kind: 'review', candidateId: 'candidate-2', policyRevision: 1, recipientAgentId: 'agent-lead', deliveryId: null, status: 'dispatched', reason: '等待助手审查结论', createdAt: submittedAt }
]

// 返工链场景：candidate-2 被要求返工，所以 candidate-3 沿 previousCandidateId 出现。
// 旧版（candidate-2）必须从界面上失去接受入口——这条只能靠真实数据造出来。
const reworkCandidate: LoomCandidate = {
  candidateId: 'candidate-3', taskId: 'task-3', agentRunId: 'run-3',
  contentHash: 'sha256:restore-runtime-v2', evidenceIds: ['evidence-1'], acceptanceCriteria: loomCriteria,
  previousCandidateId: 'candidate-2', verificationStatus: 'unverified', acceptanceStatus: 'pending',
  createdAt: '2026-09-27T09:10:00.000Z'
}
const reworkStageReview: LoomStageReview = {
  stageReviewId: 'stage-review-2', taskId: 'task-3', candidateId: 'candidate-2',
  reviewerAgentId: 'agent-lead', reviewerAgentRunId: 'run-review-2', policyRevision: 1,
  manifestHash: 'sha256:manifest-2', verdict: 'request_changes', reason: '恢复失败分支没有覆盖',
  criteriaResults: loomCriteria.criteria.map((criterion, index) => ({
    criterionId: criterion.criterionId, satisfied: index === 0,
    evidenceIds: [], note: index === 0 ? null : '缺失败分支证据'
  })),
  reviewedAt: submittedAt
}

// 控制投影：策略默认为 null（真实未批准）。controlRevision 是 Core 侧修订计数（任何 write +1），
// controlAuthorizationRevision 只在 configure 时 +1——两者分开记才能造出「别人改了策略」的冲突，
// 也才能证明 pause/resume 不会让旧授权的审查突然复活。
type FixtureControlPolicy = LoomControlPolicy & { authorizationRevision: number }
let controlPolicy: FixtureControlPolicy | null = null
let controlRevision = 0
let controlAuthorizationRevision = 0
let controlReadFails = false
let controlPartial = false
let stageReviews: LoomStageReview[] = structuredClone(stageReviewsBaseline)
let dispatches: LoomDispatch[] = structuredClone(dispatchesBaseline)

function controlSnapshot(): LoomControlSnapshot {
  if (controlReadFails) throw new Error('LOOM fixture forced the control projection read to fail')
  const snapshot = {
    missionId: mission.missionId,
    policy: controlPolicy === null ? null : structuredClone(controlPolicy),
    stageReviews: structuredClone(stageReviews),
    dispatches: structuredClone(dispatches),
    evaluatedAt: claimsEvaluatedAt
  }
  if (controlPartial) {
    // 缺必需字段的投影：界面必须落到「读不到」，不能当成「未批准」。
    const partial = snapshot as unknown as Record<string, unknown>
    if (snapshot.policy !== null) delete (partial.policy as Record<string, unknown>).authorizationRevision
    delete partial.dispatches
  }
  return snapshot
}

// 修订冲突是真冲突：expectedRevision 对不上就抛，和 Core 的乐观并发一致。
function expectControlRevision(expectedRevision: number): void {
  if (expectedRevision !== controlRevision) {
    throw new Error(`loom control revision conflict: expected ${expectedRevision} but current is ${controlRevision}`)
  }
}

function configureControl(input: LoomControlPolicyInput): LoomControlSnapshot {
  expectControlRevision(input.expectedRevision)
  controlRevision += 1
  // configure 是唯一推进授权修订的写入：旧授权下的审查从此失效。
  controlAuthorizationRevision += 1
  controlPolicy = {
    missionId: input.missionId, planId: plan.planId, revision: controlRevision,
    authorizationRevision: controlAuthorizationRevision,
    enabled: input.enabled, paused: false,
    taskIds: [...input.taskIds],
    reviewers: input.reviewers.map(reviewer => ({ ...reviewer })),
    maxDispatches: input.maxDispatches, maxReworksPerTask: input.maxReworksPerTask,
    expiresAt: input.expiresAt, approvedBy: 'local_user',
    approvedAt: writeStamp, updatedAt: writeStamp
  }
  return controlSnapshot()
}

function pauseControl(input: LoomControlPauseInput): LoomControlSnapshot {
  if (controlPolicy === null) throw new Error('LOOM fixture has no control policy to pause')
  expectControlRevision(input.expectedRevision)
  controlRevision += 1
  controlPolicy = { ...controlPolicy, revision: controlRevision, paused: input.paused, updatedAt: writeStamp }
  return controlSnapshot()
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

// 写入侧状态：验收/核验两条轴的写结果直接落在内存投影上，八个读方法随之回读一致数据。
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
  } else if (planHidden && (method === 'loom.plan.get' || method === 'loom.tasks.list' || method === 'loom.dependencies.list')) {
    reply = method === 'loom.plan.get' ? null : []
  } else if (method === 'loom.artifacts.list') {
    // 产物投影固定两条；读失败开关在这里抛错，让 UI 只降级候选卡的产物区。
    reply = readArtifacts()
  } else if (method === 'loom.artifact.preview') {
    // 正文只读预览（LoomArtifactPreviewResult）：固定文本，不动任何写入口。
    reply = readArtifactPreview(params as LoomArtifactPreviewInput)
  } else if (method === 'loom.control.get') {
    // 控制投影：读失败开关在这里抛错，UI 只能落到「读不到」，不许冒充未启用。
    reply = controlSnapshot()
  } else if (method === 'loom.control.configure') {
    reply = configureControl(params as LoomControlPolicyInput)
  } else if (method === 'loom.control.pause') {
    reply = pauseControl(params as LoomControlPauseInput)
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

// reset() 换 key 强制重挂载：LoomWorkspace 会按恢复后的初始数据重读八个投影，
// 这样每条点击用例都从同一个初始态开始，不继承上一条用例写下的结论。
let remountWorkspace: () => void = () => undefined

function LoomFixture() {
  const [generation, setGeneration] = useState(0)
  remountWorkspace = () => setGeneration(current => current + 1)
  return <ThreadClientProvider client={client}>
    <div className="loom-mikka" data-loom-generation={generation} style={{ display: 'contents' }}>
    <LoomWorkspace
      key={generation}
      mission={mission}
      agents={agents}
      nodes={fixtureNodes}
      onSource={messageId => { selections.push(messageId) }}
      onNotify={() => undefined}
      onWorkspaceCleanupRequested={async () => undefined}
    />
    </div>
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
    liveNodes = []
    liveLines = []
    planHidden = false
    // 产物回读同样回初始态：两条已登记产物、读成功。
    artifactsReadFails = false
    // 控制投影回初始态：没有批准过策略、两个修订归零、读成功、基线审查与派发。
    controlPolicy = null
    controlRevision = 0
    controlAuthorizationRevision = 0
    controlReadFails = false
    controlPartial = false
    stageReviews = structuredClone(stageReviewsBaseline)
    dispatches = structuredClone(dispatchesBaseline)
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
  },
  // 产物回读只有「读成功 / 读失败」两个开关（没有场景维度），切换后同样重挂载。
  setArtifacts: options => {
    artifactsReadFails = options?.fail === true
    remountWorkspace()
  },
  setLive: mode => {
    planHidden = false
    liveLines = []
    claimsReadFails = false
    if (mode === 'none') {
      liveNodes = []
      claimsScenario = 'empty'
    } else {
      liveNodes = mixedNodes()
      claimsScenario = 'live'
    }
    remountWorkspace()
  },
  failClaimsWithNodes: () => {
    planHidden = false
    liveLines = []
    liveNodes = mixedNodes()
    claimsScenario = 'live'
    claimsReadFails = true
    remountWorkspace()
  },
  setPlanHidden: hidden => {
    planHidden = hidden
    remountWorkspace()
  },
  // 控制投影开关：读失败 / 已批准（可选已暂停）/ 缺必需字段。都走重挂载，三种生产实现都能拿到新回包。
  setControl: options => {
    controlReadFails = options?.fail === true
    controlPartial = options?.partial === true
    if (options?.approved === true) {
      controlRevision += 1
      controlAuthorizationRevision += 1
      controlPolicy = {
        missionId: mission.missionId, planId: plan.planId, revision: controlRevision,
        authorizationRevision: controlAuthorizationRevision,
        enabled: true, paused: options?.paused === true, taskIds: ['task-3'],
        reviewers: [{ taskId: 'task-3', reviewerAgentId: 'agent-lead' }],
        maxDispatches: 3, maxReworksPerTask: 1, expiresAt: null,
        approvedBy: 'local_user', approvedAt: writeStamp, updatedAt: writeStamp
      }
    }
    remountWorkspace()
  },
  // 返工链：candidate-2 的审查要求返工，candidate-3 成为链头；
  // 期间又 configure 过一次（authorizationRevision 2），所以 candidate-2 那条 policyRevision 1 的审查已失效。
  setReworkChain: () => {
    candidates.push(structuredClone(reworkCandidate))
    stageReviews.push(structuredClone(reworkStageReview))
    // 重新授权过一次（authorizationRevision 2）：candidate-2 那条 policyRevision 1 的审查因此失效。
    // revision 任何 write 都 +1，所以这里前进 2 步，保持 revision ≥ authorizationRevision。
    controlRevision += 2
    controlAuthorizationRevision = 2
    controlPolicy = {
      missionId: mission.missionId, planId: plan.planId, revision: controlRevision,
      authorizationRevision: controlAuthorizationRevision,
      enabled: true, paused: false, taskIds: ['task-3'],
      reviewers: [{ taskId: 'task-3', reviewerAgentId: 'agent-lead' }],
      maxDispatches: 3, maxReworksPerTask: 1, expiresAt: null,
      approvedBy: 'local_user', approvedAt: writeStamp, updatedAt: writeStamp
    }
    remountWorkspace()
  },
  // 模拟另一个客户端改了策略：修订号前推但不通知界面，下一次写入必须撞冲突。
  driftControlRevision: () => {
    controlRevision += 1
    if (controlPolicy !== null) controlPolicy = { ...controlPolicy, revision: controlRevision }
  }
}

createRoot(document.getElementById('root')!).render(<LoomFixture />)

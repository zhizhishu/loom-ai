import { createRoot } from 'react-dom/client'
import type { AgentProfile, MissionActivity, MissionDelivery, MissionRecord, LoomPlan, LoomTask, LoomDependency, LoomCandidate, LoomReview, LoomVerification } from '@contracts'
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
type LoomQa = {
  calls: LoomCall[]
  errors: string[]
  selections: string[]
  countOf(method: string): number
  setTheme(theme: 'day' | 'night'): void
}
declare global { interface Window { loomQA: LoomQa } }

const createdAt = '2026-09-27T08:00:00.000Z'
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
  {
    taskId: 'task-3', planId: plan.planId,
    title: '实现恢复逻辑', description: '从快照恢复工作区状态',
    assigneeAgentId: 'agent-build', status: 'ready',
    acceptanceCriteria: plan.acceptanceCriteria,
    blockedReason: null, createdAt, updatedAt: createdAt, revision: 1
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

// 候选与验收记录：task-1 已核验且已验收，task-3 只有待验收候选，所以 task-4 的
// artifact_accepted 边仍然未释放，blocked 断言继续成立。
const loomCriteria = plan.acceptanceCriteria
const candidates: LoomCandidate[] = [
  { candidateId: 'candidate-1', taskId: 'task-1', agentRunId: 'run-1', contentHash: 'sha256:restore-protocol', evidenceIds: ['evidence-1', 'evidence-2'], acceptanceCriteria: loomCriteria, previousCandidateId: null, verificationStatus: 'verified', acceptanceStatus: 'accepted', createdAt },
  { candidateId: 'candidate-2', taskId: 'task-3', agentRunId: 'run-2', contentHash: 'sha256:restore-runtime', evidenceIds: ['evidence-3'], acceptanceCriteria: loomCriteria, previousCandidateId: null, verificationStatus: 'unverified', acceptanceStatus: 'pending', createdAt }
]

const reviews: LoomReview[] = [
  { reviewId: 'review-1', candidateId: 'candidate-1', acceptanceCriteriaVersion: loomCriteria.version, verdict: 'accepted', reason: '恢复协议已覆盖保存与恢复两条路径', criteriaResults: loomCriteria.criteria.map((criterion, index) => ({ criterionId: criterion.criterionId, satisfied: true, evidenceIds: [`evidence-${index + 1}`], note: null })), reviewerId: 'user-local', reviewedAt: createdAt }
]

const verifications: LoomVerification[] = [
  { verificationId: 'verification-1', candidateId: 'candidate-1', method: 'manual', executorId: 'user-local', result: 'passed', evidenceIds: ['evidence-1'], verifiedAt: createdAt }
]

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
  { id: 4, kind: 'created', actorType: 'user', actorId: 'user-local', changes: {}, createdAt },
  { id: 3, kind: 'started', actorType: 'agent', actorId: agents[0].agentId, changes: {}, createdAt },
  { id: 2, kind: 'status', actorType: 'agent', actorId: agents[0].agentId, changes: { status: 'in_progress' }, createdAt },
  { id: 1, kind: 'members', actorType: 'user', actorId: 'user-local', changes: {}, createdAt },
  ...Array.from({ length: 80 }, (_, index): MissionActivity => ({
    id: 100 + index, kind: index % 2 ? 'members' : 'lead', actorType: 'agent',
    actorId: agents[index % agents.length].agentId, changes: {}, createdAt
  }))
]

const calls: LoomCall[] = []
const errors: string[] = []
const selections: string[] = []
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
  const reply = replies[method]
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

window.loomQA = {
  calls, errors, selections, countOf: method => calls.filter(call => call.method === method).length, setTheme
}

createRoot(document.getElementById('root')!).render(<ThreadClientProvider client={client}>
  <LoomWorkspace
    mission={mission}
    agents={agents}
    onSource={messageId => { selections.push(messageId) }}
    onNotify={() => undefined}
    onWorkspaceCleanupRequested={async () => undefined}
  />
</ThreadClientProvider>)

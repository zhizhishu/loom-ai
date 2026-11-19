import { describe, expect, it, vi } from 'vitest'
import type {
  AgentRunView,
  LoomClaim,
  LoomReview,
  LoomTask,
  LoomVerification,
  MissionRecord,
  ThreadMemberView,
  ThreadSnapshot
} from '@contracts'
import type { LoomArtifact, LoomCandidate, WorkBundle } from './types'
import {
  artifactFacts,
  botFacts,
  claimLeaseState,
  classifyClaimsReceipt,
  CLAIMS_LIST_METHOD,
  goalFacts,
  hostDeclares,
  latestClaimByTask,
  leadFacts,
  readClaimsListObserved,
  readV2RunFacts,
  runFacts,
  workerFacts,
  type V2ClaimProjection,
  type V2HostDeclaration,
  type V2ReadState,
  type V2RunPort
} from './v2-run-service'

// ------------------------------------------------------------------- fixtures

const member = (
  agentId: string,
  displayName: string,
  over: Partial<ThreadMemberView> = {}
): ThreadMemberView => ({
  agentId,
  displayName,
  avatarRef: null,
  teamRole: 'engineer',
  accent: 'blue',
  membershipStatus: 'active',
  leaveRequestedAt: null,
  profilePresence: 'present',
  memberOrder: 0,
  isDefaultLead: false,
  version: 1,
  ...over
})

const run = (id: string, over: Partial<AgentRunView> = {}): AgentRunView => ({
  id,
  threadTurnId: null,
  conversationId: 'conv-1',
  agentId: 'agent-worker',
  taskId: 'task-1',
  responsibilityKey: id,
  responsibilityGeneration: 1,
  purpose: 'execute',
  completionRole: 'required',
  status: 'succeeded',
  waitReason: null,
  cancelRequestedAt: null,
  cancelReasonCode: null,
  cancelAcknowledgedAt: null,
  terminalResolutionSource: null,
  terminalReasonCode: null,
  failure: null,
  runtimeModel: null,
  executionEpoch: 1,
  permissionSemantics: 'core_enforced_v1',
  invocationKind: 'direct',
  triggerDeliveryGeneration: 1,
  a2aParentAgentRunId: null,
  a2aRootAgentRunId: null,
  a2aDepth: 0,
  executionEvidenceCount: 0,
  executionEvidenceChangeSequence: 0,
  hasUnsettledExternalEffects: false,
  workspace: null,
  startingGitObservation: null,
  endingGitObservation: null,
  version: 1,
  createdAt: '2026-11-15T00:00:00Z',
  startedAt: null,
  endedAt: null,
  updatedAt: '2026-11-15T00:00:00Z',
  ...over
} as unknown as AgentRunView)

const thread = (over: {
  id?: string
  members?: ThreadMemberView[]
  agentRuns?: AgentRunView[]
  defaultLeadAgentId?: string | null
} = {}): ThreadSnapshot => ({
  schemaVersion: 36,
  throughGlobalSequence: 10,
  thread: {
    id: over.id ?? 'camp-1',
    title: 'Ship it',
    missionId: 'rvm_1',
    activationState: 'active',
    projectBindingKind: 'quick_chat',
    projectPath: '',
    defaultLeadAgentId: over.defaultLeadAgentId === undefined ? 'agent-lead' : over.defaultLeadAgentId,
    membershipGeneration: 1,
    version: 1,
    createdAt: '2026-11-15T00:00:00Z',
    updatedAt: '2026-11-15T00:00:00Z'
  },
  members: over.members ?? [
    member('agent-lead', 'Lead', { isDefaultLead: true }),
    member('agent-worker', 'Worker')
  ],
  membershipReconciliations: [],
  tasksEnabled: true,
  tasks: [],
  messages: [],
  messageDeliveries: [],
  turns: [],
  agentRuns: over.agentRuns ?? [],
  executionEvidence: [],
  agentRunFileChanges: [],
  contextManifests: [],
  approvals: [],
  actions: [],
  timeline: []
} as unknown as ThreadSnapshot)

const mission = (over: Partial<MissionRecord> = {}): MissionRecord => ({
  missionId: 'rvm_1',
  threadId: 'camp-1',
  title: 'Ship the thing',
  description: 'Make the button work',
  status: 'in_progress',
  sourceMessageId: null,
  number: 7,
  hasUnread: false,
  projectPath: '',
  projectBindingKind: 'quick_chat',
  detailsVersion: 1,
  tags: [],
  attachments: [],
  createdAt: '2026-11-15T00:00:00Z',
  updatedAt: '2026-11-15T00:00:00Z',
  memberAgentIds: ['agent-lead', 'agent-worker'],
  defaultLeadAgentId: 'agent-lead',
  runningAgentIds: [],
  startAvailable: true,
  workspaceEverCreated: false,
  workspaceResourcesPresent: false,
  cleanupAvailable: false,
  ...over
} as unknown as MissionRecord)

const task = (over: Partial<LoomTask> & { taskId: string }): LoomTask => ({
  planId: 'plan-1',
  title: over.taskId,
  description: '',
  assigneeAgentId: null,
  status: 'ready',
  acceptanceCriteria: { version: 'ac-1', criteria: [] },
  blockedReason: null,
  createdAt: '2026-11-15T00:00:00Z',
  updatedAt: '2026-11-15T00:00:00Z',
  revision: 1,
  ...over
})

const artifact = (over: Partial<LoomArtifact> & { artifactId: string }): LoomArtifact => ({
  planId: 'plan-1',
  taskId: 'task-1',
  agentRunId: 'run-1',
  relativePath: 'docs/report.md',
  sha256: 'sha256-report',
  sizeBytes: 1234,
  contentType: 'text/markdown',
  creatorId: 'agent-worker',
  createdAt: '2026-11-15T02:00:00Z',
  ...over
})

const candidate = (over: Partial<LoomCandidate> & { candidateId: string }): LoomCandidate => ({
  taskId: 'task-1',
  agentRunId: 'run-1',
  contentHash: 'hash-1',
  evidenceIds: [],
  acceptanceCriteria: { version: 'ac-1', criteria: [] },
  previousCandidateId: null,
  verificationStatus: 'unverified',
  acceptanceStatus: 'pending',
  createdAt: '2026-11-15T02:00:00Z',
  ...over
})

const verification = (over: Partial<LoomVerification> & { candidateId: string }): LoomVerification => ({
  verificationId: 'ver-1',
  method: 'rerun the tests',
  executorId: 'host',
  result: 'passed',
  evidenceIds: [],
  verifiedAt: '2026-11-15T03:00:00Z',
  ...over
})

const review = (over: Partial<LoomReview> & { candidateId: string }): LoomReview => ({
  reviewId: 'rev-1',
  acceptanceCriteriaVersion: 'ac-1',
  verdict: 'accepted',
  reason: 'looks right',
  criteriaResults: [],
  reviewerId: 'user',
  reviewedAt: '2026-11-15T04:00:00Z',
  ...over
})

const claim = (over: Partial<LoomClaim> & { claimId: string; taskId: string }): LoomClaim => ({
  agentRunId: 'run-1',
  claimantAgentId: 'agent-worker',
  fenceGeneration: 1,
  claimedAt: '2026-11-15T00:00:00Z',
  leaseExpiresAt: '2026-11-15T01:00:00Z',
  releasedAt: null,
  expired: false,
  ...over
})

const bundle = (over: Partial<WorkBundle> = {}): WorkBundle => ({
  mission: mission(),
  plan: null,
  tasks: [task({ taskId: 'task-1', assigneeAgentId: 'agent-worker' })],
  candidates: [],
  artifacts: [],
  reviews: [],
  verifications: [],
  ...over
})

const declared = (...methods: string[]): V2HostDeclaration => ({ declaredMethods: methods })

const port = (request: ReturnType<typeof vi.fn>): V2RunPort => ({
  request: request as unknown as V2RunPort['request']
})

const claimsReceipt = (claims: LoomClaim[], evaluatedAt = '2026-11-15T00:30:00Z') => ({
  evaluatedAt,
  claims
})

// ---------------------------------------------------------------------- tests

describe('host declaration gates the only request this module makes', () => {
  it('treats a missing, empty or unrelated declaration as not declared', () => {
    expect(hostDeclares(null, CLAIMS_LIST_METHOD)).toBe(false)
    expect(hostDeclares(undefined, CLAIMS_LIST_METHOD)).toBe(false)
    expect(hostDeclares(declared(), CLAIMS_LIST_METHOD)).toBe(false)
    expect(hostDeclares(declared('loom.artifacts.list'), CLAIMS_LIST_METHOD)).toBe(false)
    expect(hostDeclares(declared(CLAIMS_LIST_METHOD), CLAIMS_LIST_METHOD)).toBe(true)
  })

  it('sends no claims request when the Host never declared the method', async () => {
    const request = vi.fn()
    const facts = await readV2RunFacts({
      port: port(request),
      declaration: null,
      missionId: 'rvm_1',
      bundle: bundle(),
      thread: thread()
    })
    expect(request).not.toHaveBeenCalled()
    expect(facts.claims).toEqual({ status: 'unavailable', reason: 'not_declared' })
    expect(facts.workers[0].claim).toEqual({ status: 'unavailable', reason: 'not_declared' })
    expect(facts.workers[0].assigneeIsClaimant).toBe(false)
  })

  it('sends no claims request when there is no Mission to ask about', async () => {
    const request = vi.fn()
    const facts = await readV2RunFacts({
      port: port(request),
      declaration: declared(CLAIMS_LIST_METHOD),
      missionId: '   ',
      bundle: bundle(),
      thread: thread()
    })
    expect(request).not.toHaveBeenCalled()
    expect(facts.claims).toEqual({ status: 'unavailable', reason: 'mission_required' })
  })

  it('asks exactly once, with the mission id, when the Host declared the method', async () => {
    const request = vi.fn().mockResolvedValue(claimsReceipt([]))
    const facts = await readV2RunFacts({
      port: port(request),
      declaration: declared(CLAIMS_LIST_METHOD),
      missionId: 'rvm_1',
      bundle: bundle(),
      thread: thread()
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(CLAIMS_LIST_METHOD, { missionId: 'rvm_1' })
    expect(facts.claims.status).toBe('observed')
  })
})

describe('read failures and bad receipts never become empty success', () => {
  it('reports a failed RPC read as failed, not as "nobody claimed it"', async () => {
    const request = vi.fn().mockRejectedValue(new Error('offline'))
    const facts = await readV2RunFacts({
      port: port(request),
      declaration: declared(CLAIMS_LIST_METHOD),
      missionId: 'rvm_1',
      bundle: bundle(),
      thread: thread()
    })
    expect(facts.claims).toEqual({ status: 'failed', message: 'offline' })
    expect(facts.workers[0].claim).toEqual({ status: 'failed', message: 'offline' })
  })

  it('reports an unrecognized receipt as unknown', () => {
    expect(classifyClaimsReceipt(null).status).toBe('unknown')
    expect(classifyClaimsReceipt([]).status).toBe('unknown')
    expect(classifyClaimsReceipt({ claims: [] }).status).toBe('unknown')
    expect(classifyClaimsReceipt({ evaluatedAt: '2026-11-15T00:00:00Z' }).status).toBe('unknown')
    const badRow = classifyClaimsReceipt({
      evaluatedAt: '2026-11-15T00:00:00Z',
      claims: [{ ...claim({ claimId: 'c1', taskId: 'task-1' }), expired: 'yes' }]
    })
    expect(badRow.status).toBe('unknown')
  })

  it('keeps an empty claim list distinguishable from an unread one', async () => {
    const request = vi.fn().mockResolvedValue(claimsReceipt([]))
    const facts = await readV2RunFacts({
      port: port(request),
      declaration: declared(CLAIMS_LIST_METHOD),
      missionId: 'rvm_1',
      bundle: bundle(),
      thread: thread()
    })
    expect(facts.claims).toEqual({
      status: 'observed',
      value: { evaluatedAt: '2026-11-15T00:30:00Z', claims: [] }
    })
    expect(facts.workers[0].claim).toEqual({ status: 'observed', value: null })
  })
})

describe('claim generations and lease state come from the Host only', () => {
  it('picks the highest fence generation per task and keeps Host order on a tie', () => {
    const claims = [
      claim({ claimId: 'c1', taskId: 'task-1', fenceGeneration: 1 }),
      claim({ claimId: 'c3', taskId: 'task-1', fenceGeneration: 3 }),
      claim({ claimId: 'c2', taskId: 'task-1', fenceGeneration: 2 }),
      claim({ claimId: 'c4', taskId: 'task-2', fenceGeneration: 2 }),
      claim({ claimId: 'c5', taskId: 'task-2', fenceGeneration: 2 })
    ]
    const latest = latestClaimByTask(claims)
    expect(latest.get('task-1')?.claimId).toBe('c3')
    expect(latest.get('task-2')?.claimId).toBe('c4')
  })

  it('never recomputes expiry from the local clock and prefers released over expired', () => {
    const longPast = '2000-01-01T00:00:00Z'
    expect(claimLeaseState(claim({ claimId: 'c1', taskId: 't', leaseExpiresAt: longPast }))).toBe('held')
    expect(claimLeaseState(claim({ claimId: 'c2', taskId: 't', expired: true }))).toBe('expired')
    expect(claimLeaseState(claim({
      claimId: 'c3',
      taskId: 't',
      expired: true,
      releasedAt: '2026-11-15T00:20:00Z'
    }))).toBe('released')
  })

  it('treats an assignee as responsibility only, never as a claim', () => {
    const observed: V2ReadState<V2ClaimProjection> = {
      status: 'observed',
      value: {
        evaluatedAt: '2026-11-15T00:30:00Z',
        claims: [claim({ claimId: 'c1', taskId: 'task-1', claimantAgentId: 'agent-other' })]
      }
    }
    const [other] = workerFacts(bundle(), observed)
    expect(other.assigneeAgentId).toBe('agent-worker')
    expect(other.assigneeIsClaimant).toBe(false)

    const claimed = workerFacts(bundle(), {
      status: 'observed',
      value: {
        evaluatedAt: '2026-11-15T00:30:00Z',
        claims: [claim({ claimId: 'c1', taskId: 'task-1', claimantAgentId: 'agent-worker' })]
      }
    })
    expect(claimed[0].assigneeIsClaimant).toBe(true)

    const unclaimed = workerFacts(bundle(), {
      status: 'observed',
      value: { evaluatedAt: '2026-11-15T00:30:00Z', claims: [] }
    })
    expect(unclaimed[0].assigneeIsClaimant).toBe(false)
    expect(unclaimed[0].claim).toEqual({ status: 'observed', value: null })
  })
})

describe('registration, verification, review and acceptance stay independent', () => {
  const artifactBundle = (over: Partial<WorkBundle> = {}) => bundle({
    artifacts: [artifact({ artifactId: 'art-1' })],
    candidates: [candidate({ candidateId: 'cand-1', evidenceIds: ['art-1'] })],
    ...over
  })

  it('reports each status from its own source without deriving one from another', () => {
    const [facts] = artifactFacts(artifactBundle({
      reviews: [review({ candidateId: 'cand-1', verdict: 'accepted' })]
    }))
    expect(facts.registration.state).toBe('recorded')
    // 有 Review 记录，但没有任何核验记录：核验仍是「未记录」，不是「已核验」。
    expect(facts.verification).toEqual({ state: 'not_recorded' })
    expect(facts.review.state).toBe('recorded')
    // 候选自身的验收投影仍是 pending：不因为 Review 是 accepted 就改写。
    expect(facts.acceptance).toEqual({ state: 'recorded', value: 'pending' })
  })

  it('records a verification row as recorded without touching acceptance', () => {
    const [facts] = artifactFacts(artifactBundle({
      verifications: [verification({ candidateId: 'cand-1', result: 'failed' })]
    }))
    expect(facts.verification.state).toBe('recorded')
    expect(facts.verification.state === 'recorded' && facts.verification.value.result).toBe('failed')
    expect(facts.review).toEqual({ state: 'not_recorded' })
    expect(facts.acceptance).toEqual({ state: 'recorded', value: 'pending' })
  })

  it('reports the three candidate-bound statuses as unavailable when nothing owns the artifact', () => {
    const [facts] = artifactFacts(bundle({ artifacts: [artifact({ artifactId: 'art-1' })] }))
    expect(facts.candidate).toBeNull()
    expect(facts.overlay.candidate).toBeNull()
    expect(facts.registration.state).toBe('recorded')
    expect(facts.verification).toEqual({ state: 'unavailable', reason: 'no_candidate' })
    expect(facts.review).toEqual({ state: 'unavailable', reason: 'no_candidate' })
    expect(facts.acceptance).toEqual({ state: 'unavailable', reason: 'no_candidate' })
  })
})

describe('Goal, Bot, Lead and Run facts are projections, not promises', () => {
  it('projects the Mission goal verbatim and marks the V2 interfaces as not available', () => {
    const facts = goalFacts(mission({ status: 'not_started' }))
    expect(facts.mission).toEqual({
      missionId: 'rvm_1',
      threadId: 'camp-1',
      title: 'Ship the thing',
      description: 'Make the button work',
      status: 'not_started',
      defaultLeadAgentId: 'agent-lead',
      memberAgentIds: ['agent-lead', 'agent-worker']
    })
    expect(facts.v2Record).toEqual({ status: 'unavailable', reason: 'interface_not_available' })
    expect(Object.keys(facts)).toEqual(['mission', 'v2Record'])
  })

  it('reports Bot and Lead from the member projection without inventing a lead', () => {
    const snapshot = thread({
      members: [
        member('agent-lead', 'Lead', { isDefaultLead: true }),
        member('agent-away', 'Away', { profilePresence: 'away' })
      ],
      defaultLeadAgentId: 'agent-gone'
    })
    const bots = botFacts(snapshot)
    expect(bots).toHaveLength(2)
    expect(bots[1].presence).toBe('away')
    const lead = leadFacts(snapshot, mission(), bots)
    expect(lead.agentId).toBe('agent-gone')
    expect(lead.bot).toBeNull()
    expect(lead.matchesMissionLead).toBe(false)

    const noLead = leadFacts(thread({ defaultLeadAgentId: null }), mission(), bots)
    expect(noLead.agentId).toBeNull()
    expect(noLead.bot).toBeNull()
  })

  it('projects Runs as recorded and refuses to mix another Thread in', async () => {
    const request = vi.fn().mockResolvedValue(claimsReceipt([]))
    const matching = await readV2RunFacts({
      port: port(request),
      declaration: declared(CLAIMS_LIST_METHOD),
      missionId: 'rvm_1',
      bundle: bundle(),
      thread: thread({ agentRuns: [run('run-1', { status: 'running', startedAt: '2026-11-15T01:00:00Z' })] })
    })
    expect(matching.runs).toEqual({
      status: 'observed',
      value: [{
        agentRunId: 'run-1',
        agentId: 'agent-worker',
        taskId: 'task-1',
        status: 'running',
        waitReason: null,
        startedAt: '2026-11-15T01:00:00Z',
        endedAt: null
      }]
    })
    expect(runFacts(thread()).length).toBe(0)

    const mismatched = await readV2RunFacts({
      port: port(request),
      declaration: declared(CLAIMS_LIST_METHOD),
      missionId: 'rvm_1',
      bundle: bundle(),
      thread: thread({ id: 'camp-2', agentRuns: [run('run-9')] })
    })
    expect(mismatched.bots).toEqual({ status: 'unavailable', reason: 'thread_mismatch' })
    expect(mismatched.lead).toEqual({ status: 'unavailable', reason: 'thread_mismatch' })
    expect(mismatched.runs).toEqual({ status: 'unavailable', reason: 'thread_mismatch' })
    // 目标与认领是 Mission 作用域的，不因为 Thread 不匹配就丢掉。
    expect(mismatched.goal.mission.missionId).toBe('rvm_1')
    expect(mismatched.claims.status).toBe('observed')
  })

  it('always reports the V2 Bot/Goal/capability interfaces as unavailable', async () => {
    const request = vi.fn().mockResolvedValue(claimsReceipt([]))
    const facts = await readV2RunFacts({
      port: port(request),
      declaration: declared(CLAIMS_LIST_METHOD),
      missionId: 'rvm_1',
      bundle: bundle(),
      thread: thread()
    })
    expect(facts.pendingInterfaces).toEqual({
      bots: { status: 'unavailable', reason: 'interface_not_available' },
      goals: { status: 'unavailable', reason: 'interface_not_available' },
      capabilities: { status: 'unavailable', reason: 'interface_not_available' }
    })
    // 没有进度字段可被误读成「已完成多少」。
    expect(Object.keys(facts).sort()).toEqual([
      'artifacts', 'bots', 'claims', 'goal', 'lead', 'missionId', 'pendingInterfaces', 'runs', 'workers'
    ])
  })
})

describe('observed claims read proves the interface with a real receipt, not a declaration', () => {
  // 模拟 main 进程 RovaiRequestError：message 之外的 kind/code 才是结构化事实。
  const structuredFailure = (code: string, message: string): unknown =>
    Object.assign(new Error(message), { kind: 'infrastructure_failure', code, retryable: false })

  it('an unknown Host that serves a valid receipt is observed with the actual claims', async () => {
    const request = vi.fn().mockResolvedValue(
      claimsReceipt([claim({ claimId: 'c1', taskId: 'task-1' })])
    )
    const state = await readClaimsListObserved(port(request), 'rvm_1')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(CLAIMS_LIST_METHOD, { missionId: 'rvm_1' })
    expect(state).toEqual({
      status: 'observed',
      value: { evaluatedAt: '2026-11-15T00:30:00Z', claims: [claim({ claimId: 'c1', taskId: 'task-1' })] }
    })
  })

  it('a structured method-not-found rejection is unavailable, never an empty list', async () => {
    const request = vi.fn().mockRejectedValue(structuredFailure('METHOD_NOT_FOUND', 'request rejected'))
    const state = await readClaimsListObserved(port(request), 'rvm_1')
    expect(request).toHaveBeenCalledTimes(1)
    expect(state).toEqual({ status: 'unavailable', reason: 'method_unsupported' })
  })

  it('the current Core fallback code stays failed even when the message says unsupported', async () => {
    // 当前 Core 对未知方法没有专属 code：兜底是共享的 CORE_REQUEST_FAILED，
    // message 含 "unsupported core method" 文本绝不构成降级依据。
    const request = vi.fn().mockRejectedValue(structuredFailure(
      'CORE_REQUEST_FAILED',
      'unsupported core method: loom.claims.list'
    ))
    const state = await readClaimsListObserved(port(request), 'rvm_1')
    expect(state).toEqual({ status: 'failed', message: 'unsupported core method: loom.claims.list' })
  })

  it('permission, timeout and network failures are failed, never unsupported or empty', async () => {
    const permission = await readClaimsListObserved(
      port(vi.fn().mockRejectedValue(structuredFailure('session_required', '连接已失效，请重新登录。'))),
      'rvm_1'
    )
    expect(permission).toEqual({ status: 'failed', message: '连接已失效，请重新登录。' })

    const timeout = await readClaimsListObserved(
      port(vi.fn().mockRejectedValue(new Error('Rust Core request timed out: loom.claims.list'))),
      'rvm_1'
    )
    expect(timeout.status).toBe('failed')

    const network = await readClaimsListObserved(
      port(vi.fn().mockRejectedValue(new Error('offline'))),
      'rvm_1'
    )
    expect(network).toEqual({ status: 'failed', message: 'offline' })
  })

  it('an unrecognized receipt stays unknown, not an empty success', async () => {
    const request = vi.fn().mockResolvedValue({ claims: [] })
    const state = await readClaimsListObserved(port(request), 'rvm_1')
    expect(state.status).toBe('unknown')
  })

  it('sends nothing when there is no Mission to observe', async () => {
    const request = vi.fn()
    const state = await readClaimsListObserved(port(request), '   ')
    expect(request).not.toHaveBeenCalled()
    expect(state).toEqual({ status: 'unavailable', reason: 'mission_required' })
  })
})

describe('observe-readonly access in readV2RunFacts', () => {
  it('reads once through the authenticated channel without any declaration', async () => {
    const request = vi.fn().mockResolvedValue(claimsReceipt([]))
    const facts = await readV2RunFacts({
      port: port(request),
      declaration: null,
      claimsAccess: 'observe-readonly',
      missionId: 'rvm_1',
      bundle: bundle(),
      thread: thread()
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(CLAIMS_LIST_METHOD, { missionId: 'rvm_1' })
    expect(facts.claims).toEqual({
      status: 'observed',
      value: { evaluatedAt: '2026-11-15T00:30:00Z', claims: [] }
    })
    expect(facts.workers[0].claim).toEqual({ status: 'observed', value: null })
    expect(facts.workers[0].assigneeIsClaimant).toBe(false)
  })

  it('defaults to the declared gate when claimsAccess is not given', async () => {
    const request = vi.fn()
    const facts = await readV2RunFacts({
      port: port(request),
      declaration: null,
      missionId: 'rvm_1',
      bundle: bundle(),
      thread: thread()
    })
    expect(request).not.toHaveBeenCalled()
    expect(facts.claims).toEqual({ status: 'unavailable', reason: 'not_declared' })
  })
})

describe('mission identity gates every claims read', () => {
  it('never sends a claims request when the requested Mission differs from the bundle', async () => {
    const request = vi.fn()
    const declaredFacts = await readV2RunFacts({
      port: port(request),
      declaration: declared(CLAIMS_LIST_METHOD),
      missionId: 'rvm_2',
      bundle: bundle(),
      thread: thread()
    })
    expect(request).not.toHaveBeenCalled()
    expect(declaredFacts.claims).toEqual({ status: 'unavailable', reason: 'mission_mismatch' })
    expect(declaredFacts.workers[0].claim).toEqual({ status: 'unavailable', reason: 'mission_mismatch' })
    expect(declaredFacts.workers[0].assigneeIsClaimant).toBe(false)

    const observedFacts = await readV2RunFacts({
      port: port(request),
      declaration: null,
      claimsAccess: 'observe-readonly',
      missionId: 'rvm_2',
      bundle: bundle(),
      thread: thread()
    })
    expect(request).not.toHaveBeenCalled()
    expect(observedFacts.claims).toEqual({ status: 'unavailable', reason: 'mission_mismatch' })
    expect(observedFacts.workers[0].claim).toEqual({ status: 'unavailable', reason: 'mission_mismatch' })
  })

  it('still sends exactly one request when the trimmed ids agree', async () => {
    const request = vi.fn().mockResolvedValue(claimsReceipt([]))
    const facts = await readV2RunFacts({
      port: port(request),
      declaration: declared(CLAIMS_LIST_METHOD),
      claimsAccess: 'observe-readonly',
      missionId: ' rvm_1 ',
      bundle: bundle(),
      thread: thread()
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(facts.claims.status).toBe('observed')
  })
})

describe('a stale or released claim never presents its agent as holding the task', () => {
  const observed = (claims: LoomClaim[]): V2ReadState<V2ClaimProjection> => ({
    status: 'observed',
    value: { evaluatedAt: '2026-11-15T00:30:00Z', claims }
  })

  it('keeps assigneeIsClaimant true only for a live matching claim', () => {
    const live = workerFacts(bundle(), observed([claim({ claimId: 'c1', taskId: 'task-1' })]))
    expect(live[0].assigneeIsClaimant).toBe(true)

    const expired = workerFacts(bundle(), observed([
      claim({ claimId: 'c1', taskId: 'task-1', expired: true })
    ]))
    expect(expired[0].assigneeIsClaimant).toBe(false)
    // 过期认领本身仍是 observed 的事实，只是不再构成「正占着」。
    expect(expired[0].claim).toEqual({
      status: 'observed',
      value: claim({ claimId: 'c1', taskId: 'task-1', expired: true })
    })

    const released = workerFacts(bundle(), observed([
      claim({ claimId: 'c1', taskId: 'task-1', releasedAt: '2026-11-15T00:20:00Z' })
    ]))
    expect(released[0].assigneeIsClaimant).toBe(false)

    const releasedAndExpired = workerFacts(bundle(), observed([
      claim({ claimId: 'c1', taskId: 'task-1', expired: true, releasedAt: '2026-11-15T00:20:00Z' })
    ]))
    expect(releasedAndExpired[0].assigneeIsClaimant).toBe(false)
  })
})

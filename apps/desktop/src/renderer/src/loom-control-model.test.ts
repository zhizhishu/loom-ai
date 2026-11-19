import { describe, expect, it } from 'vitest'
import type { LoomArtifact, LoomCandidate, LoomDependency } from '@contracts'
import {
  EMPTY_LOOM_CONTROL_DRAFT,
  loomAssetRelations,
  loomCandidateAcceptable,
  loomCandidateVersions,
  loomControlDraftFromPolicy,
  loomControlInput,
  loomControlProblems,
  loomControlRevisionConflict,
  loomControlSnapshotProblem,
  loomControlState,
  loomDispatchTally,
  loomDependencyReasonLabel,
  loomPolicyAuthorizationRevision,
  loomPolicyExpired,
  loomStageReviewFreshness,
  loomStageReviewLatest,
  loomStageReviewPassesCurrently,
  loomUnreleasedInbound,
  loomVersionLabel,
  type LoomControlPolicy,
  type LoomControlSnapshot,
  type LoomStageReview
} from './loom-control-model'

const createdAt = '2026-09-27T08:00:00.000Z'
const criteria = { version: 'v1', criteria: [{ criterionId: 'c1', text: '可恢复' }] }

function candidate(candidateId: string, taskId: string, previousCandidateId: string | null, at = createdAt): LoomCandidate {
  return {
    candidateId,
    taskId,
    agentRunId: `run-${candidateId}`,
    contentHash: `sha256:${candidateId}`,
    evidenceIds: [`evidence-${candidateId}`],
    acceptanceCriteria: criteria,
    previousCandidateId,
    verificationStatus: 'unverified',
    acceptanceStatus: 'pending',
    createdAt: at
  }
}

/** 契约里的策略类型 + 本次新增的授权修订；测试跟着真实字段走，不另立一套。 */
type FixturePolicy = LoomControlPolicy & { authorizationRevision: number }

function policy(overrides: Partial<FixturePolicy> = {}): FixturePolicy {
  return {
    missionId: 'mission-1',
    planId: 'plan-1',
    revision: 1,
    authorizationRevision: 1,
    enabled: true,
    paused: false,
    taskIds: ['task-1'],
    reviewers: [{ taskId: 'task-1', reviewerAgentId: 'agent-lead' }],
    maxDispatches: 3,
    maxReworksPerTask: 1,
    expiresAt: null,
    approvedBy: 'local_user',
    approvedAt: createdAt,
    updatedAt: createdAt,
    ...overrides
  }
}

function snapshot(overrides: Partial<LoomControlSnapshot> = {}): LoomControlSnapshot {
  return { missionId: 'mission-1', policy: null, stageReviews: [], dispatches: [], evaluatedAt: createdAt, ...overrides }
}

describe('loom control state', () => {
  // 读失败绝不能被渲染成「未启用」：那会把一次失败的读当成一条业务结论。
  it('reports unreadable instead of disabled when the projection read failed', () => {
    expect(loomControlState(snapshot({ policy: policy() }), 'boom')).toBe('unreadable')
    expect(loomControlState(null, 'boom')).toBe('unreadable')
    expect(loomControlState(null, '')).toBe('reading')
  })

  it('separates unapproved, disabled, paused and approved', () => {
    expect(loomControlState(snapshot(), '')).toBe('unapproved')
    expect(loomControlState(snapshot({ policy: policy({ enabled: false }) }), '')).toBe('disabled')
    expect(loomControlState(snapshot({ policy: policy({ paused: true }) }), '')).toBe('paused')
    expect(loomControlState(snapshot({ policy: policy() }), '')).toBe('approved')
  })

  it('only calls it a conflict on the Core conflict code or a self-described receipt', () => {
    expect(loomControlRevisionConflict(new Error('LOOM_CONTROL_REVISION_CONFLICT: 3 vs 1'))).toBe(true)
    expect(loomControlRevisionConflict(new Error('loom control revision conflict: expected 3 but current is 4'))).toBe(true)
    expect(loomControlRevisionConflict(new Error('network down'))).toBe(false)
    expect(loomControlRevisionConflict(new Error('LOOM_TASK_NOT_IN_REVIEW'))).toBe(false)
    expect(loomControlRevisionConflict(undefined)).toBe(false)
  })
})

describe('loom candidate version chains', () => {
  it('numbers a rework chain and marks exactly one latest tip', () => {
    const versions = loomCandidateVersions([
      candidate('c1', 'task-1', null),
      candidate('c2', 'task-1', 'c1', '2026-09-27T09:00:00.000Z'),
      candidate('c3', 'task-1', 'c2', '2026-09-27T10:00:00.000Z')
    ])
    expect(versions.map(entry => [entry.candidateId, entry.version, entry.latest])).toEqual([
      ['c1', 1, false],
      ['c2', 2, false],
      ['c3', 3, true]
    ])
    expect(loomCandidateAcceptable(versions, 'c3')).toBe(true)
    // 旧版不接受：界面必须锁住，Core 也会拒。
    expect(loomCandidateAcceptable(versions, 'c2')).toBe(false)
  })

  // 成环：不抛错、不死循环，版本号仍然算得出来。
  it('survives a previousCandidateId cycle', () => {
    const versions = loomCandidateVersions([
      candidate('c1', 'task-1', 'c2'),
      candidate('c2', 'task-1', 'c1')
    ])
    expect(versions.length).toBe(2)
    expect(versions.every(entry => Number.isFinite(entry.version) && entry.version >= 1)).toBe(true)
  })

  // 父版本不在投影里（跨任务或读不到）：当链根处理，不假设自己知道全局历史。
  it('treats a missing parent candidate as the chain root', () => {
    const versions = loomCandidateVersions([candidate('c9', 'task-1', 'c-missing')])
    expect(versions).toEqual([
      { candidateId: 'c9', taskId: 'task-1', version: 1, latest: true, previousCandidateId: 'c-missing' }
    ])
  })

  it('never marks two candidates of one task as latest', () => {
    const versions = loomCandidateVersions([
      candidate('c1', 'task-1', null),
      candidate('c2', 'task-2', null)
    ])
    expect(versions.filter(entry => entry.latest).map(entry => entry.candidateId).sort()).toEqual(['c1', 'c2'])
    expect(loomVersionLabel(undefined)).toBe('v1')
    expect(loomVersionLabel(4)).toBe('v4')
  })
})

describe('loom stage reviews', () => {
  it('takes the latest stage review per candidate and keeps it separate from acceptance', () => {
    const reviews: LoomStageReview[] = [
      { stageReviewId: 's1', taskId: 'task-1', candidateId: 'c1', reviewerAgentId: 'agent-lead', reviewerAgentRunId: 'r1', policyRevision: 1, manifestHash: 'm1', verdict: 'request_changes', reason: '缺失败分支', criteriaResults: [], reviewedAt: '2026-09-27T09:00:00.000Z' },
      { stageReviewId: 's2', taskId: 'task-1', candidateId: 'c1', reviewerAgentId: 'agent-lead', reviewerAgentRunId: 'r2', policyRevision: 2, manifestHash: 'm2', verdict: 'pass', reason: '补齐了', criteriaResults: [], reviewedAt: '2026-09-27T10:00:00.000Z' }
    ]
    expect(loomStageReviewLatest(reviews, 'c1')?.stageReviewId).toBe('s2')
    expect(loomStageReviewLatest(reviews, 'c-unknown')).toBeNull()
    expect(loomStageReviewLatest([], 'c1')).toBeNull()
  })
})

describe('loom dispatches', () => {
  it('counts cancelled dispatches outside the budget', () => {
    const tally = loomDispatchTally([
      { dispatchId: 'd1', taskId: 'task-1', kind: 'execute', candidateId: null, policyRevision: 1, recipientAgentId: 'agent-build', deliveryId: null, status: 'settled', reason: null, createdAt },
      { dispatchId: 'd2', taskId: 'task-1', kind: 'review', candidateId: 'c1', policyRevision: 1, recipientAgentId: 'agent-lead', deliveryId: null, status: 'dispatched', reason: null, createdAt },
      { dispatchId: 'd3', taskId: 'task-1', kind: 'rework', candidateId: 'c1', policyRevision: 1, recipientAgentId: 'agent-build', deliveryId: null, status: 'cancelled', reason: '用户取消', createdAt }
    ])
    expect(tally).toEqual({ used: 3, cancelled: 1 })
  })

  // 取消不返还额度：界面与 Core 记账一致，不看 status。
  it('counts every historical dispatch against the budget, cancelled included', () => {
    const dispatches = ['settled', 'cancelled', 'blocked'] as const
    const tally = loomDispatchTally(dispatches.map((status, index) => ({
      dispatchId: `d${index}`,
      taskId: 'task-1',
      kind: 'execute' as const,
      candidateId: null,
      policyRevision: 1,
      recipientAgentId: 'agent-build',
      deliveryId: null,
      status,
      reason: null,
      createdAt
    })))
    expect(tally).toEqual({ used: 3, cancelled: 1 })
  })
})

describe('loom dependency reasons', () => {
  it('translates every blocking code and never invents one for null', () => {
    expect(loomDependencyReasonLabel('candidate_not_accepted')).toBe('上游候选未通过用户验收')
    expect(loomDependencyReasonLabel('review_criteria_mismatch')).toContain('版本不一致')
    expect(loomDependencyReasonLabel(null)).toBe('')
    expect(loomUnreleasedInbound([
      { dependencyId: 'd1', upstreamTaskId: 'task-1', reason: 'candidate_not_verified' },
      { dependencyId: 'd2', upstreamTaskId: 'task-2', reason: null }
    ])).toEqual([{ dependencyId: 'd1', upstreamTaskId: 'task-1', reason: 'candidate_not_verified' }])
  })
})

describe('loom asset relations', () => {
  const artifacts: LoomArtifact[] = [{
    artifactId: 'evidence-c1',
    planId: 'plan-1',
    taskId: 'task-1',
    agentRunId: 'run-c1',
    relativePath: 'artifacts/report.md',
    sha256: 'a'.repeat(64),
    sizeBytes: 512,
    contentType: 'text/markdown',
    creatorId: 'local_user',
    createdAt
  }]
  const unresolved: LoomDependency = {
    dependencyId: 'dep-open', planId: 'plan-1', upstreamTaskId: 'task-1', downstreamTaskId: 'task-2',
    condition: 'artifact_accepted', resolvedArtifactId: null, resolution: null, createdAt
  }
  const resolved: LoomDependency = {
    ...unresolved,
    dependencyId: 'dep-frozen',
    resolvedArtifactId: 'evidence-c1',
    resolution: { resolvedAt: createdAt, upstreamTaskRevision: 1, candidateId: 'c1', reviewId: 'review-1' }
  }

  // 使用者只认已冻结事实：未释放的边不许被当成「有人在用」。
  it('only names consumers that the dependency冻结 fact actually froze', () => {
    const [relation] = loomAssetRelations({
      candidates: [candidate('c1', 'task-1', null)],
      dependencies: [unresolved],
      artifacts,
      stageReviews: []
    })
    expect(relation.registration).toBe('registered')
    expect(relation.relativePath).toBe('artifacts/report.md')
    expect(relation.producerAgentRunId).toBe('run-c1')
    expect(relation.consumers).toEqual([])
  })

  it('names the downstream task once the edge is frozen', () => {
    const [relation] = loomAssetRelations({
      candidates: [candidate('c1', 'task-1', null)],
      dependencies: [unresolved, resolved],
      artifacts,
      stageReviews: []
    })
    expect(relation.consumers).toEqual([{ dependencyId: 'dep-frozen', downstreamTaskId: 'task-2' }])
  })

  // 同一个 artifactId 不够：上游任务与候选都得对上，否则就是猜。
  it('never guesses a consumer from a shared artifact id alone', () => {
    const otherTask: LoomDependency = { ...resolved, dependencyId: 'dep-other-task', upstreamTaskId: 'task-9' }
    const otherCandidate: LoomDependency = {
      ...resolved,
      dependencyId: 'dep-other-candidate',
      resolution: { ...resolved.resolution!, candidateId: 'c9' }
    }
    const [relation] = loomAssetRelations({
      candidates: [candidate('c1', 'task-1', null)],
      dependencies: [otherTask, otherCandidate],
      artifacts,
      stageReviews: []
    })
    expect(relation.consumers).toEqual([])
  })

  // 产物投影读不到时必须说「未知」，不许降级成「未登记」，也不许借别的候选的路径。
  it('keeps unknown apart from unregistered', () => {
    const unknown = loomAssetRelations({
      candidates: [candidate('c1', 'task-1', null)],
      dependencies: [],
      artifacts: null,
      stageReviews: null
    })
    expect(unknown.map(entry => entry.registration)).toEqual(['unknown'])
    expect(unknown[0].relativePath).toBeNull()
    expect(unknown[0].producerCreatorId).toBeNull()
    expect(unknown[0].evidenceId).toBe('evidence-c1')

    const unregistered = loomAssetRelations({
      candidates: [candidate('c1', 'task-1', null)],
      dependencies: [],
      artifacts: [],
      stageReviews: []
    })
    expect(unregistered.map(entry => entry.registration)).toEqual(['unregistered'])
  })

  it('emits one row for a candidate with no evidence instead of borrowing one', () => {
    const bare: LoomCandidate = { ...candidate('c9', 'task-9', null), evidenceIds: [] }
    const rows = loomAssetRelations({ candidates: [bare], dependencies: [], artifacts, stageReviews: [] })
    expect(rows.length).toBe(1)
    expect(rows[0].evidenceId).toBe('')
    expect(rows[0].registration).toBe('unregistered')
  })
})

describe('loom control draft', () => {
  it('starts empty and refuses to approve without an explicit budget', () => {
    expect(loomControlProblems(EMPTY_LOOM_CONTROL_DRAFT)).toEqual(['no_tasks', 'max_dispatches', 'max_reworks'])
    expect(loomControlInput('mission-1', 'command-1', 0, EMPTY_LOOM_CONTROL_DRAFT)).toBeNull()
  })

  it('requires an independent reviewer for every selected task', () => {
    const draft = { ...EMPTY_LOOM_CONTROL_DRAFT, taskIds: ['task-1', 'task-2'], reviewers: { 'task-1': 'agent-lead' }, maxDispatches: '2', maxReworksPerTask: '1' }
    expect(loomControlProblems(draft)).toEqual(['missing_reviewer'])
  })

  it('rejects zero dispatches and negative reworks but accepts a real draft', () => {
    const base = { taskIds: ['task-1'], reviewers: { 'task-1': 'agent-lead' }, expiresAt: '' }
    expect(loomControlProblems({ ...base, maxDispatches: '0', maxReworksPerTask: '1' })).toEqual(['max_dispatches'])
    expect(loomControlProblems({ ...base, maxDispatches: '2', maxReworksPerTask: '-1' })).toEqual(['max_reworks'])
    expect(loomControlProblems({ ...base, maxDispatches: '2', maxReworksPerTask: '0' })).toEqual([])
    const input = loomControlInput('mission-1', 'command-1', 3, { ...base, maxDispatches: '2', maxReworksPerTask: '0' })
    expect(input).toEqual({
      missionId: 'mission-1',
      commandId: 'command-1',
      expectedRevision: 3,
      enabled: true,
      taskIds: ['task-1'],
      reviewers: [{ taskId: 'task-1', reviewerAgentId: 'agent-lead' }],
      maxDispatches: 2,
      maxReworksPerTask: 0,
      expiresAt: null
    })
  })

  it('drops a malformed expiry instead of silently inventing today', () => {
    const draft = { taskIds: ['task-1'], reviewers: { 'task-1': 'agent-lead' }, maxDispatches: '1', maxReworksPerTask: '0', expiresAt: 'not-a-date' }
    expect(loomControlProblems(draft)).toEqual(['expires_at'])
    expect(loomControlInput('mission-1', 'command-1', 0, draft)).toBeNull()
  })

  it('round-trips a real approved policy back into the form', () => {
    const draft = loomControlDraftFromPolicy(policy({ expiresAt: '2026-10-01T00:00:00.000Z' }))
    expect(draft.taskIds).toEqual(['task-1'])
    expect(draft.reviewers).toEqual({ 'task-1': 'agent-lead' })
    expect(draft.maxDispatches).toBe('3')
    expect(draft.maxReworksPerTask).toBe('1')
    expect(loomControlProblems(draft)).toEqual([])
    expect(loomControlDraftFromPolicy(policy()).expiresAt).toBe('')
  })
})

// 授权有效性与过期：都是「界面该不该说知道」的判定边界，不重复 Core 的规则。
describe('loom control validity, expiry and authorization revision', () => {
  it('treats a snapshot with missing required fields as unreadable, never unapproved', () => {
    const missingDispatches = {
      missionId: 'mission-1', policy: null, stageReviews: [], evaluatedAt: createdAt
    } as unknown as LoomControlSnapshot
    expect(loomControlSnapshotProblem(missingDispatches)).toBe('dispatches')
    expect(loomControlState(missingDispatches, '')).toBe('unreadable')

    const missingAuthorization = snapshot({ policy: { ...policy(), authorizationRevision: undefined } as unknown as FixturePolicy })
    expect(loomControlSnapshotProblem(missingAuthorization)).toBe('authorizationRevision')
    expect(loomControlState(missingAuthorization, '')).toBe('unreadable')
    expect(loomPolicyAuthorizationRevision(policy())).toBe(1)
    // 完整且没有策略才是真的未批准。
    expect(loomControlState(snapshot(), '')).toBe('unapproved')
  })

  it('decides expiry from the server evaluatedAt, not the local clock', () => {
    const approved = policy({ expiresAt: '2026-12-31T00:00:00.000Z' })
    expect(loomPolicyExpired(approved, '2026-12-30T00:00:00.000Z')).toBe(false)
    expect(loomPolicyExpired(approved, '2027-01-01T00:00:00.000Z')).toBe(true)
    expect(loomPolicyExpired(policy(), '2027-01-01T00:00:00.000Z')).toBe(false)
    expect(loomControlState(snapshot({ policy: approved, evaluatedAt: '2027-01-01T00:00:00.000Z' }), '')).toBe('expired')
    // 过期盖过暂停：已经失效的授权不能靠「继续」复活。
    expect(loomControlState(
      snapshot({ policy: { ...approved, paused: true }, evaluatedAt: '2027-01-01T00:00:00.000Z' }), ''
    )).toBe('expired')
  })

  it('only counts a stage review as current when policyRevision matches authorizationRevision', () => {
    const authorized = policy({ authorizationRevision: 2 })
    const review = (policyRevision: number): LoomStageReview => ({
      stageReviewId: `stage-${policyRevision}`,
      taskId: 'task-1',
      candidateId: 'c1',
      reviewerAgentId: 'agent-lead',
      reviewerAgentRunId: 'run-1',
      policyRevision,
      manifestHash: 'sha256:manifest',
      verdict: 'pass',
      reason: '',
      criteriaResults: [],
      reviewedAt: createdAt
    })
    expect(loomStageReviewFreshness(review(2), authorized)).toBe('current')
    expect(loomStageReviewFreshness(review(1), authorized)).toBe('stale')
    // 没有策略时无法判定，不冒充当前有效。
    expect(loomStageReviewFreshness(review(2), null)).toBe('unknown')
    // 失效的 pass 不能再当「当前通过」。
    expect(loomStageReviewPassesCurrently(review(1), authorized)).toBe(false)
    expect(loomStageReviewPassesCurrently(review(2), authorized)).toBe(true)
    // 非 pass 永远不是「当前通过」，也永远不是人工验收。
    expect(loomStageReviewPassesCurrently({ ...review(2), verdict: 'request_changes' }, authorized)).toBe(false)
  })
})

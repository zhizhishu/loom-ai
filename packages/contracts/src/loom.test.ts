// 契约回归：逐条验收结论必须覆盖每条 criterionId 且全为 satisfied，依赖才可释放。
// 反例任一成立就返回 false —— 空结论、缺条、重复条、任一条不满足。
import { describe, expect, it } from 'vitest'
import { loomEvaluateDependency, loomReviewSatisfiesCriteria } from './loom'
import type {
  LoomAcceptanceCriteriaSnapshot,
  LoomAcceptanceCriterion,
  LoomAcceptanceCriterionResult,
  LoomCandidate,
  LoomDependency,
  LoomDependencyGraph,
  LoomReview,
  LoomTask
} from './loom'

const PLAN_ID = 'plan_1'
const CRITERIA_VERSION = 'ac-v2'

const CRITERIA: LoomAcceptanceCriterion[] = [
  { criterionId: 'criterion_one', text: 'one' },
  { criterionId: 'criterion_two', text: 'two' }
]

const SNAPSHOT: LoomAcceptanceCriteriaSnapshot = {
  version: CRITERIA_VERSION,
  criteria: CRITERIA
}

function result(criterionId: string, satisfied = true): LoomAcceptanceCriterionResult {
  return {
    criterionId,
    satisfied,
    evidenceIds: [`evidence_${criterionId}`],
    note: null
  }
}

function review(criteriaResults: LoomAcceptanceCriterionResult[]): LoomReview {
  return {
    reviewId: 'review_1',
    candidateId: 'candidate_1',
    acceptanceCriteriaVersion: CRITERIA_VERSION,
    verdict: 'accepted',
    reason: 'reviewed against the candidate criteria version',
    criteriaResults,
    reviewerId: 'local_user',
    reviewedAt: '2026-01-02T00:00:00Z'
  }
}

const UPSTREAM_TASK: LoomTask = {
  taskId: 'task_a',
  planId: PLAN_ID,
  title: 'Task A',
  description: 'Upstream task',
  assigneeAgentId: null,
  status: 'done',
  acceptanceCriteria: SNAPSHOT,
  blockedReason: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  revision: 3
}

const DOWNSTREAM_TASK: LoomTask = {
  taskId: 'task_b',
  planId: PLAN_ID,
  title: 'Task B',
  description: 'Downstream task',
  assigneeAgentId: null,
  status: 'ready',
  acceptanceCriteria: SNAPSHOT,
  blockedReason: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  revision: 1
}

const ARTIFACT_EDGE: LoomDependency = {
  dependencyId: 'dep_task_a_task_b',
  planId: PLAN_ID,
  upstreamTaskId: 'task_a',
  downstreamTaskId: 'task_b',
  condition: 'artifact_accepted',
  resolvedArtifactId: null,
  resolution: null,
  createdAt: '2026-01-01T00:00:00Z'
}

const ACCEPTED_CANDIDATE: LoomCandidate = {
  candidateId: 'candidate_1',
  taskId: 'task_a',
  agentRunId: 'run_1',
  contentHash: 'sha256:candidate_1',
  evidenceIds: [],
  acceptanceCriteria: SNAPSHOT,
  previousCandidateId: null,
  verificationStatus: 'verified',
  acceptanceStatus: 'accepted',
  createdAt: '2026-01-01T00:00:00Z'
}

function graph(criteriaResults: LoomAcceptanceCriterionResult[]): LoomDependencyGraph {
  return {
    tasks: [UPSTREAM_TASK, DOWNSTREAM_TASK],
    dependencies: [ARTIFACT_EDGE],
    candidates: [ACCEPTED_CANDIDATE],
    reviews: [review(criteriaResults)],
    evaluatedAt: '2026-01-02T00:00:00Z'
  }
}

describe('Loom review satisfaction over the criteria snapshot', () => {
  it('rejects an empty criteriaResults array', () => {
    expect(loomReviewSatisfiesCriteria(review([]), CRITERIA)).toBe(false)
  })

  it('rejects a missing criterionId', () => {
    const partial = [result('criterion_one')]
    expect(loomReviewSatisfiesCriteria(review(partial), CRITERIA)).toBe(false)
  })

  it('rejects a duplicated criterionId', () => {
    const duplicated = [result('criterion_one'), result('criterion_one')]
    expect(loomReviewSatisfiesCriteria(review(duplicated), CRITERIA)).toBe(false)
  })

  it('rejects a result whose satisfied flag is false', () => {
    const unsatisfied = [result('criterion_one'), result('criterion_two', false)]
    expect(loomReviewSatisfiesCriteria(review(unsatisfied), CRITERIA)).toBe(false)
  })

  it('accepts a complete all-satisfied result set regardless of order', () => {
    const complete = [result('criterion_two'), result('criterion_one')]
    expect(loomReviewSatisfiesCriteria(review(complete), CRITERIA)).toBe(true)
  })
})

describe('Loom dependency release with an incomplete review', () => {
  it('keeps the artifact edge unsatisfied with reason review_criteria_incomplete', () => {
    const evaluation = loomEvaluateDependency(ARTIFACT_EDGE, graph([result('criterion_one')]))
    expect(evaluation.satisfied).toBe(false)
    expect(evaluation.reason).toBe('review_criteria_incomplete')
    expect(evaluation.resolution).toBeNull()
  })

  it('releases the artifact edge once every criterion is satisfied', () => {
    const complete = [result('criterion_one'), result('criterion_two')]
    const evaluation = loomEvaluateDependency(ARTIFACT_EDGE, graph(complete))
    expect(evaluation.satisfied).toBe(true)
    expect(evaluation.reason).toBeNull()
    expect(evaluation.resolution?.reviewId).toBe('review_1')
    expect(evaluation.resolution?.candidateId).toBe('candidate_1')
  })
})

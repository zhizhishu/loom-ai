// Read-only acceptance judgments over persisted task, candidate and control facts.
// One successful task must never stand in for the other tasks in the approved scope.

const lower = value => String(value ?? '').toLowerCase()

/** Follow the recorded revision links. API ordering/tied timestamps are not a version identity. */
export function candidateLineage (candidates, taskId) {
  const rows = candidates.filter(row => row.taskId === taskId)
  if (rows.length === 0) return { ordered: [], latest: null, reason: 'candidate_missing' }
  const byId = new Map(rows.map(row => [row.candidateId, row]))
  if (rows.some(row => typeof row.candidateId !== 'string' || row.candidateId === '') || byId.size !== rows.length) {
    return { ordered: [], latest: null, reason: 'candidate_identity_ambiguous' }
  }
  const roots = rows.filter(row => !row.previousCandidateId)
  if (roots.length !== 1 || rows.some(row => row.previousCandidateId && !byId.has(row.previousCandidateId))) {
    return { ordered: [], latest: null, reason: 'candidate_chain_invalid' }
  }
  const ordered = []
  const seen = new Set()
  let current = roots[0]
  while (current) {
    if (seen.has(current.candidateId)) return { ordered: [], latest: null, reason: 'candidate_chain_invalid' }
    seen.add(current.candidateId)
    ordered.push(current)
    const children = rows.filter(row => row.previousCandidateId === current.candidateId)
    if (children.length > 1) return { ordered: [], latest: null, reason: 'candidate_chain_ambiguous' }
    current = children[0]
  }
  if (ordered.length !== rows.length) return { ordered: [], latest: null, reason: 'candidate_chain_invalid' }
  return { ordered, latest: ordered.at(-1), reason: null }
}

/** Core permits one stage verdict per candidate and authorization; older approvals do not count. */
export function stageReviewForCandidate (candidate, stageReviews, authorizationRevision) {
  if (!candidate) return null
  const matches = stageReviews.filter(row => row.taskId === candidate.taskId
    && row.candidateId === candidate.candidateId
    && (authorizationRevision == null || row.policyRevision === authorizationRevision))
  return matches.length === 1 ? matches[0] : null
}

/** A task is ready for Owner review only after its latest candidate passed and its handoff settled. */
export function taskDeliveryOutcomes ({
  taskIds = [], tasks = [], candidates = [], stageReviews = [], dispatches = [], authorizationRevision = null
} = {}) {
  const scope = [...new Set(taskIds)]
  const scopeValid = scope.length > 0 && scope.length === taskIds.length
    && scope.every(id => typeof id === 'string' && id !== '')
  const outcomes = scope.map(taskId => {
    const problems = []
    const taskRows = tasks.filter(row => row.taskId === taskId)
    const task = taskRows.length === 1 ? taskRows[0] : null
    let terminalFailure = false
    if (!task) problems.push('task_missing_or_ambiguous')
    if (task?.blockedReason) {
      problems.push(`task_blocked:${task.blockedReason}`)
      terminalFailure = true
    }
    if (task && lower(task.status) !== 'in_review') problems.push(`task_not_in_review:${task.status}`)
    if (['blocked', 'canceled', 'cancelled', 'done'].includes(lower(task?.status))) terminalFailure = true
    const lineage = candidateLineage(candidates, taskId)
    if (lineage.reason) problems.push(lineage.reason)
    const candidate = lineage.latest
    const review = stageReviewForCandidate(candidate, stageReviews, authorizationRevision)
    if (candidate && lower(candidate.acceptanceStatus) !== 'pending') problems.push('candidate_not_pending')
    if (!review || lower(review.verdict) !== 'pass') problems.push('latest_candidate_not_passed')
    if (lower(review?.verdict) === 'blocked') terminalFailure = true
    const ownDispatches = dispatches.filter(row => row.taskId === taskId)
    const authorizedDispatches = ownDispatches.filter(row => authorizationRevision == null
      || row.policyRevision === authorizationRevision)
    if (authorizedDispatches.some(row => lower(row.status) !== 'settled')) problems.push('dispatch_not_settled')
    if (authorizedDispatches.some(row => ['blocked', 'cancelled'].includes(lower(row.status)))) terminalFailure = true
    if (!ownDispatches.some(row => lower(row.kind) === 'execute' && lower(row.status) === 'settled')) {
      problems.push('execute_dispatch_missing')
    }
    for (const kind of ['review', 'handoff']) {
      if (!candidate || !ownDispatches.some(row => lower(row.kind) === kind
        && row.candidateId === candidate.candidateId
        && lower(row.status) === 'settled'
        && (authorizationRevision == null || row.policyRevision === authorizationRevision))) {
        problems.push(`latest_${kind}_dispatch_missing`)
      }
    }
    return {
      taskId, status: task?.status ?? null, blockedReason: task?.blockedReason ?? null,
      latestCandidateId: candidate?.candidateId ?? null,
      stageReviewId: review?.stageReviewId ?? null,
      stageVerdict: review?.verdict ?? null,
      passed: problems.length === 0, terminalFailure,
      reasons: problems.map(reason => `task:${taskId}:${reason}`)
    }
  })
  return {
    allPassed: scopeValid && outcomes.every(row => row.passed),
    terminalFailure: outcomes.some(row => row.terminalFailure),
    outcomes,
    reasons: [...(!scopeValid ? ['approved_task_scope_invalid'] : []), ...outcomes.flatMap(row => row.reasons)]
  }
}

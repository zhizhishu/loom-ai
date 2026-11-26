import type { AgentRunView } from '@contracts'

/** Mikka run-retry.ts:22-23 的总次数口径；LOOM 这里是首跑后的自动恢复次数上限。 */
export const AUTOMATIC_RETRY_LIMIT = 3

export type ManualRetryUx = 'hidden' | 'automatic' | 'available'

const runTime = (run: AgentRunView): string => run.startedAt ?? run.createdAt

/** 手动重试是另一条 lane：同一责任已经有更新的 Attempt 时不重复入口；
 *  可自动恢复的失败在前 3 次自动重试预算内只显示自动重试状态。 */
export function manualRetryUx(run: AgentRunView, runs: readonly AgentRunView[]): ManualRetryUx {
  if (run.status !== 'failed') return 'hidden'
  const laneTaskId = run.loomTaskId ?? run.taskId
  const sameLane = runs.filter(candidate => candidate.conversationId === run.conversationId
    && candidate.agentId === run.agentId
    && (candidate.loomTaskId ?? candidate.taskId) === laneTaskId
    && candidate.purpose === run.purpose)
  const newer = sameLane.filter(candidate => candidate.id !== run.id && runTime(candidate) >= runTime(run))
  if (newer.some(candidate => ['queued', 'running', 'waiting'].includes(candidate.status))) return 'automatic'
  if (newer.length) return 'hidden'
  const automaticRetryNumber = run.automaticRetryOrdinal ? run.automaticRetryOrdinal - 1 : 0
  const loomRetryLane = run.automaticRetryEligible === true || run.automaticRetryOrdinal != null
  if (loomRetryLane && run.failure?.retryable && run.automaticRetryEligible !== false && !run.hasUnsettledExternalEffects && automaticRetryNumber < AUTOMATIC_RETRY_LIMIT) return 'automatic'
  return 'available'
}

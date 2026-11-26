import { describe, expect, it } from 'vitest'
import type { AgentRunView } from '@contracts'
import { manualRetryUx } from './retry-ux'

const run = (over: Partial<AgentRunView> = {}): AgentRunView => ({
  id: 'r1', threadTurnId: null, conversationId: 'th', agentId: 'a', taskId: 'task',
  responsibilityKey: 'k', responsibilityGeneration: 0, purpose: 'do', completionRole: 'required',
  status: 'failed', waitReason: null, cancelRequestedAt: null, cancelReasonCode: null, cancelAcknowledgedAt: null,
  terminalResolutionSource: 'runtime_terminal', terminalReasonCode: null,
  failure: { runtimeKind: 'pi', origin: 'runtime', phase: 'execution', code: 'x', summary: 'x', detail: null, retryable: true },
  runtimeModel: null, executionEpoch: 0, permissionSemantics: 'core_enforced_v1', invocationKind: 'direct',
  triggerDeliveryGeneration: 0, automaticRetryEligible: true, loomTaskId: 'loom-task', a2aParentAgentRunId: null, a2aRootAgentRunId: null, a2aDepth: 0,
  executionEvidenceCount: 0, executionEvidenceChangeSequence: 0, hasUnsettledExternalEffects: false,
  workspace: null, startingGitObservation: null, endingGitObservation: null, version: 1,
  createdAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z', updatedAt: '2026-01-01T00:01:00Z', ...over
})

describe('manual retry lane', () => {
  it('keeps manual retry disabled while automatic retries remain', () => {
    const first = run()
    expect(manualRetryUx(first, [first])).toBe('automatic')
    expect(manualRetryUx(run({ automaticRetryOrdinal: 3 }), [first])).toBe('automatic')
  })
  it('opens manual retry after the third automatic retry failure', () => {
    const third = run({ automaticRetryOrdinal: 4 })
    expect(manualRetryUx(third, [third])).toBe('available')
  })
  it('hides older attempts once a newer attempt exists', () => {
    const first = run()
    const next = run({ id: 'r2', automaticRetryOrdinal: 2, createdAt: '2026-01-01T00:02:00Z', startedAt: '2026-01-01T00:02:00Z', status: 'running', endedAt: null })
    expect(manualRetryUx(first, [first, next])).toBe('automatic')
  })
  it('does not let another loom task in the same conversation suppress manual retry', () => {
    const third = run({ automaticRetryOrdinal: 4 })
    const other = run({ id: 'other', loomTaskId: 'other-task', status: 'running', endedAt: null, createdAt: '2026-01-01T00:03:00Z', startedAt: '2026-01-01T00:03:00Z' })
    expect(manualRetryUx(third, [third, other])).toBe('available')
  })
  it('does not treat ordinary chat failures as loom automatic retries', () => {
    const direct = run({ taskId: null, automaticRetryEligible: false, loomTaskId: null })
    expect(manualRetryUx(direct, [direct])).toBe('available')
  })
  it('opens manual retry immediately when Core says automatic retry is ineligible', () => {
    const failed = run({ automaticRetryEligible: false })
    expect(manualRetryUx(failed, [failed])).toBe('available')
  })
  it('uses the Core loom retry gate even when the Run has no durable task id', () => {
    const loomRun = run({ taskId: null, automaticRetryEligible: true })
    expect(manualRetryUx(loomRun, [loomRun])).toBe('automatic')
  })
  it('opens manual retry when external effects make automatic recovery unsafe', () => {
    const failed = run({ hasUnsettledExternalEffects: true })
    expect(manualRetryUx(failed, [failed])).toBe('available')
  })
  it('does not trap non-retryable failures behind automatic retry state', () => {
    const failed = run({ failure: { runtimeKind: 'pi', origin: 'runtime', phase: 'execution', code: 'x', summary: 'x', detail: null, retryable: false } })
    expect(manualRetryUx(failed, [failed])).toBe('available')
  })
})

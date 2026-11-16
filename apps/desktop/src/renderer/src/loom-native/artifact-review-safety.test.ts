import { describe, expect, it, vi } from 'vitest'
import type { LoomReviewRecordReceipt } from '@contracts'
import type { LoomArtifact, LoomCandidate, LoomTask, WorkBundle } from './types'
import {
  artifactCandidateFacts,
  discardUnconfirmedReviewAttempt,
  prepareArtifactReviewAttempt,
  recallUnconfirmedReviewAttempt,
  refreshArtifactSelection,
  rememberUnconfirmedReviewAttempt,
  sendArtifactReviewAttempt,
  submitArtifactReview,
  unconfirmedAttemptLifecycle,
  type ArtifactReviewAttempt,
  type LoomRpc
} from './artifact-service'

// ------------------------------------------------------------------- fixtures

const criteria = {
  version: 'pinned-v1',
  criteria: [
    { criterionId: 'a', text: 'Content verified' },
    { criterionId: 'b', text: 'Review complete' }
  ]
}
const task = {
  taskId: 't', planId: 'p', title: 'Actual work', description: 'Actual description',
  assigneeAgentId: 'a', status: 'in_review' as const, acceptanceCriteria: criteria,
  blockedReason: null, createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z', revision: 1
} satisfies LoomTask
const artifact = {
  artifactId: 'file1', planId: 'p', taskId: 't', agentRunId: 'r',
  relativePath: 'out/report.md', sha256: 'a'.repeat(64), sizeBytes: 32,
  contentType: 'text/markdown', creatorId: 'a', createdAt: '2026-11-13T00:00:00Z'
} satisfies LoomArtifact
const reworkArtifact = {
  ...artifact, artifactId: 'file2', sha256: 'b'.repeat(64), createdAt: '2026-11-13T05:00:00Z'
} satisfies LoomArtifact
const first = {
  candidateId: 'c1', taskId: 't', agentRunId: 'r', contentHash: 'a'.repeat(64),
  evidenceIds: ['file1'], acceptanceCriteria: criteria, previousCandidateId: null,
  verificationStatus: 'unverified' as const, acceptanceStatus: 'pending' as const,
  createdAt: '2026-11-13T00:00:00Z'
} satisfies LoomCandidate
const rework = {
  ...first, candidateId: 'c2', contentHash: 'b'.repeat(64), evidenceIds: ['file2'],
  previousCandidateId: 'c1', createdAt: '2026-11-13T05:00:00Z'
} satisfies LoomCandidate

const mission = (missionId: string, over: Partial<WorkBundle['mission']> = {}): WorkBundle['mission'] => ({
  missionId, threadId: 'camp-1', title: 'Ship it', description: '', status: 'in_progress' as const,
  defaultLeadAgentId: 'a', memberAgentIds: ['a'], ...over
} as WorkBundle['mission'])

const bundle = (candidates: LoomCandidate[] = [first], artifacts: LoomArtifact[] = [artifact], missionId = 'm'): WorkBundle => ({
  mission: mission(missionId),
  plan: null,
  tasks: [task],
  candidates,
  artifacts,
  reviews: [],
  verifications: []
})

/**
 * 保留 mock 与生产 Rpc 的精确交叉：request 既满足 LoomRpc 契约，又保留 vi.Mock 的
 * .mock/.mockResolvedValueOnce 等断言面，不用 any/ts-ignore 擦掉任何一侧。
 */
type RpcMock = LoomRpc & { request: ReturnType<typeof vi.fn> }
const rpc = (request: ReturnType<typeof vi.fn>): RpcMock => ({ request } as unknown as RpcMock)

const facts = (candidates: LoomCandidate[] = [first], artifacts: LoomArtifact[] = [artifact]) =>
  artifactCandidateFacts(bundle(candidates, artifacts), artifacts[0], candidates[0])

const draft = (over: Partial<{ candidateId: string; verdict: 'accepted' | 'rejected'; reason: string; satisfied: string[] }> = {}) => ({
  candidateId: 'c1', verdict: 'accepted' as const, reason: 'Reviewed', satisfied: ['a', 'b'], ...over
})

const attemptOf = (missionId = 'm', candidates: LoomCandidate[] = [first]): ArtifactReviewAttempt =>
  prepareArtifactReviewAttempt(missionId, facts(candidates), draft())

const receiptFor = (attempt: ArtifactReviewAttempt, over: Record<string, unknown> = {}): LoomReviewRecordReceipt => ({
  review: {
    reviewId: 'rev-1', candidateId: attempt.candidateId,
    acceptanceCriteriaVersion: attempt.payload.acceptanceCriteriaVersion,
    verdict: attempt.payload.verdict, reason: attempt.payload.reason,
    // 深拷贝条目与 evidenceIds：生产 payload 深冻结是真实保护，
    // 测试写坏回执时必须能改到 fixture，而不是撞 readonly 提前抛错。
    criteriaResults: attempt.payload.criteriaResults.map(row => ({
      ...row,
      evidenceIds: [...row.evidenceIds]
    })),
    reviewerId: 'local_user', reviewedAt: '2026-11-13T06:00:00Z'
  },
  missionId: attempt.missionId,
  planId: 'p',
  taskId: attempt.taskId,
  taskStatus: 'done',
  candidateAcceptanceStatus: 'accepted',
  releasedDependencyIds: [],
  replayed: false,
  ...over
} as LoomReviewRecordReceipt)

/** main 进程 RovaiRequestError 形状的精确结构化拒绝。 */
const structuredRejection = () => Object.assign(new Error('LOOM_REVIEW_EXISTS: already reviewed'), {
  kind: 'domain_rejection', code: 'LOOM_REVIEW_EXISTS', retryable: false
})

// ---------------------------------------------------------------------- tests

describe('a lost receipt retry re-sends the exact same frozen package', () => {
  it('keeps one commandId and one payload across retries and rpc objects', async () => {
    const attempt = attemptOf()
    const dropReceipt = vi.fn().mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(receiptFor(attempt))
    const firstOut = await sendArtifactReviewAttempt(rpc(dropReceipt), attempt)
    expect(firstOut.state).toBe('unknown')
    const secondRpc = rpc(vi.fn().mockResolvedValue(receiptFor(attempt)))
    const secondOut = await sendArtifactReviewAttempt(secondRpc, attempt)
    expect(secondOut.state).toBe('completed')
    const firstCall = dropReceipt.mock.calls[0]
    const secondCall = secondRpc.request.mock.calls[0]
    expect(firstCall[0]).toBe('loom.review.record')
    expect(secondCall[0]).toBe('loom.review.record')
    // 同一 commandId、同一份字段：Core 的 commandId 重放（loom.rs review_record）保证安全重试。
    expect(secondCall[1].commandId).toBe(firstCall[1].commandId)
    expect(secondCall[1]).toEqual(firstCall[1])
    expect(secondCall[1]).toEqual({
      missionId: 'm', taskId: 't', candidateId: 'c1', commandId: attempt.commandId,
      acceptanceCriteriaVersion: 'pinned-v1', verdict: 'accepted', reason: 'Reviewed',
      criteriaResults: [
        { criterionId: 'a', satisfied: true, evidenceIds: [], note: null },
        { criterionId: 'b', satisfied: true, evidenceIds: [], note: null }
      ]
    })
    expect(secondCall[1]).not.toHaveProperty('reviewerId')
  })

  it('freezes the attempt so a retry path cannot mutate the payload or commandId', () => {
    const attempt = attemptOf()
    expect(Object.isFrozen(attempt)).toBe(true)
    expect(Object.isFrozen(attempt.payload)).toBe(true)
    expect(Object.isFrozen(attempt.payload.criteriaResults)).toBe(true)
    expect(Object.isFrozen(attempt.payload.criteriaResults[0])).toBe(true)
    // 深冻结包括嵌套数组：evidenceIds 也不能 push 改写。
    expect(Object.isFrozen(attempt.payload.criteriaResults[0].evidenceIds)).toBe(true)
    expect(() => { (attempt.payload.criteriaResults[0].evidenceIds as string[]).push('forged') }).toThrow()
    expect(attempt.payload.criteriaResults[0].evidenceIds).toEqual([])
    expect(attempt.planId).toBe('p')
    expect(() => { (attempt as { commandId: string }).commandId = 'forged' }).toThrow()
    expect(() => { (attempt.payload as { reason: string }).reason = 'forged' }).toThrow()
    expect(attempt.payload.reason).toBe('Reviewed')
  })

  it('the unconfirmed attempt survives in memory and is recalled, not rebuilt', () => {
    const channel = rpc(vi.fn())
    const attempt = attemptOf()
    rememberUnconfirmedReviewAttempt(channel, attempt)
    const recalled = recallUnconfirmedReviewAttempt(channel, 'm', 'c1')
    expect(recalled).toBe(attempt)
    expect(recalled?.commandId).toBe(attempt.commandId)
    expect(recalled?.payload).toEqual(attempt.payload)
    // 没有记录的通道/候选取不到，也不新建。
    expect(recallUnconfirmedReviewAttempt(rpc(vi.fn()), 'm', 'c1')).toBeNull()
    expect(recallUnconfirmedReviewAttempt(channel, 'm', 'other')).toBeNull()
  })

  it('an unknown outcome never marks completed and never allows a new command', async () => {
    const channel = rpc(vi.fn().mockRejectedValue(new Error('Rust Core request timed out')))
    const attempt = attemptOf()
    rememberUnconfirmedReviewAttempt(channel, attempt)
    const outcome = await sendArtifactReviewAttempt(channel, attempt)
    expect(outcome.state).toBe('unknown')
    expect(recallUnconfirmedReviewAttempt(channel, 'm', 'c1')).toBe(attempt)
  })

  it('send remembers the attempt atomically before sending and tracks the real lifecycle', async () => {
    const channel = rpc(vi.fn().mockRejectedValue(new Error('offline')))
    const attempt = attemptOf()
    expect(unconfirmedAttemptLifecycle(channel, attempt)).toBeNull()
    const outcome = await sendArtifactReviewAttempt(channel, attempt)
    expect(outcome.state).toBe('unknown')
    // send 自己完成登记与状态推进：UI 不 remember 也有同一条可取回。
    expect(unconfirmedAttemptLifecycle(channel, attempt)).toBe('unknown')
    expect(recallUnconfirmedReviewAttempt(channel, 'm', 'c1')).toBe(attempt)
  })

  it('concurrent sends of the same attempt share one in-flight promise', async () => {
    let settle!: (receipt: LoomReviewRecordReceipt) => void
    const request = vi.fn().mockImplementation(
      () => new Promise<LoomReviewRecordReceipt>(resolve => { settle = resolve })
    )
    const channel = rpc(request)
    const attempt = attemptOf()
    const first = sendArtifactReviewAttempt(channel, attempt)
    const second = sendArtifactReviewAttempt(channel, attempt)
    expect(second).toBe(first)
    // The production sender installs its in-flight record before entering RPC.
    // Let that deferred call start, then deliver its deliberately held receipt.
    await Promise.resolve()
    expect(channel.request).toHaveBeenCalledTimes(1)
    settle(receiptFor(attempt))
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(a.state).toBe('completed')
    expect(request).toHaveBeenCalledTimes(1)
    expect(unconfirmedAttemptLifecycle(channel, attempt)).toBe('completed')
  })

  it('a synchronous rpc throw still registers in-flight and a retry really re-sends', async () => {
    const request = vi.fn<() => Promise<LoomReviewRecordReceipt>>(() => { throw new Error('sync boom') })
    const channel = rpc(request)
    const attempt = attemptOf()
    // 同步 throw 不丢单：attempt 已登记为 unknown，不是卡在 sending。
    const outcome = await sendArtifactReviewAttempt(channel, attempt)
    expect(outcome.state).toBe('unknown')
    expect(unconfirmedAttemptLifecycle(channel, attempt)).toBe('unknown')
    // 显式 retry 真的再发同一 commandId，并能拿到回执。
    request.mockImplementation(() => Promise.resolve(receiptFor(attempt)))
    const retry = await sendArtifactReviewAttempt(channel, attempt)
    expect(retry.state).toBe('completed')
    expect(unconfirmedAttemptLifecycle(channel, attempt)).toBe('completed')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('refuses to send a different attempt over an existing unconfirmed one', async () => {
    const channel = rpc(vi.fn())
    const original = attemptOf()
    rememberUnconfirmedReviewAttempt(channel, original)
    const rival = attemptOf()
    expect(rival.commandId).not.toBe(original.commandId)
    await expect(sendArtifactReviewAttempt(channel, rival)).rejects.toThrow('另一个未确认')
    expect(channel.request).not.toHaveBeenCalled()
    expect(recallUnconfirmedReviewAttempt(channel, 'm', 'c1')).toBe(original)
    // 原 attempt 仍可正常发送。
    channel.request.mockResolvedValueOnce(receiptFor(original))
    expect((await sendArtifactReviewAttempt(channel, original)).state).toBe('completed')
  })
})

describe('unconfirmed attempts cannot be reused or overwritten across payloads or identities', () => {
  it('refuses to overwrite an unconfirmed attempt for the same rpc+mission+candidate', () => {
    const channel = rpc(vi.fn())
    const attempt = attemptOf()
    rememberUnconfirmedReviewAttempt(channel, attempt)
    const changed = prepareArtifactReviewAttempt('m', facts(), draft({ reason: 'Changed mind' }))
    expect(changed.commandId).not.toBe(attempt.commandId)
    expect(() => rememberUnconfirmedReviewAttempt(channel, changed)).toThrow('不能覆盖')
    expect(recallUnconfirmedReviewAttempt(channel, 'm', 'c1')).toBe(attempt)
  })

  it('keeps different missions and candidates as separate unconfirmed attempts', () => {
    const channel = rpc(vi.fn())
    const attemptM = attemptOf('m')
    const attemptOtherMission = attemptOf('m2')
    const attemptOtherCandidate = prepareArtifactReviewAttempt('m', facts([rework], [reworkArtifact]), draft({ candidateId: 'c2' }))
    rememberUnconfirmedReviewAttempt(channel, attemptM)
    rememberUnconfirmedReviewAttempt(channel, attemptOtherMission)
    rememberUnconfirmedReviewAttempt(channel, attemptOtherCandidate)
    expect(recallUnconfirmedReviewAttempt(channel, 'm', 'c1')).toBe(attemptM)
    expect(recallUnconfirmedReviewAttempt(channel, 'm2', 'c1')).toBe(attemptOtherMission)
    expect(recallUnconfirmedReviewAttempt(channel, 'm', 'c2')).toBe(attemptOtherCandidate)
  })

  it('submitArtifactReview with an explicit attempt rejects cross-identity use', async () => {
    const channel = rpc(vi.fn())
    const attempt = attemptOf('m')
    rememberUnconfirmedReviewAttempt(channel, attempt)
    await expect(submitArtifactReview(channel, 'other', facts(), draft(), attempt)).rejects.toThrow('另一个 Mission')
    expect(channel.request).not.toHaveBeenCalled()
    const reworkFacts = artifactCandidateFacts(bundle([rework], [reworkArtifact]), reworkArtifact, rework)
    const reworkAttempt = prepareArtifactReviewAttempt('m', reworkFacts, draft({ candidateId: 'c2' }))
    await expect(submitArtifactReview(channel, 'm', facts(), draft(), reworkAttempt)).rejects.toThrow('另一个候选')
    expect(channel.request).not.toHaveBeenCalled()
  })
})

describe('only a real, matching receipt marks the attempt completed', () => {
  it('accepts a full receipt whose identity matches the frozen attempt', async () => {
    const attempt = attemptOf()
    const receipt = receiptFor(attempt)
    const outcome = await sendArtifactReviewAttempt(rpc(vi.fn().mockResolvedValue(receipt)), attempt)
    expect(outcome).toEqual({ state: 'completed', receipt })
  })

  it('treats a replayed receipt (replayed=true) as completed — Core re-returned the recorded verdict', async () => {
    const attempt = attemptOf()
    const outcome = await sendArtifactReviewAttempt(
      rpc(vi.fn().mockResolvedValue(receiptFor(attempt, { replayed: true }))), attempt
    )
    expect(outcome.state).toBe('completed')
    expect(outcome.state === 'completed' && outcome.receipt.replayed).toBe(true)
  })

  it('treats shape-broken or identity-mismatched returns as unknown, never success', async () => {
    const attempt = attemptOf()
    const broken: unknown[] = [
      null,
      {},
      receiptFor(attempt, { review: {} }),
      receiptFor(attempt, { missionId: 'other' }),
      receiptFor(attempt, { taskId: 'other' }),
      receiptFor(attempt, { candidateAcceptanceStatus: 'pended' }),
      receiptFor(attempt, { taskStatus: 'done_instantly' }),
      receiptFor(attempt, { releasedDependencyIds: [42] }),
      receiptFor(attempt, { replayed: 'no' })
    ]
    for (const value of broken) {
      const outcome = await sendArtifactReviewAttempt(rpc(vi.fn().mockResolvedValue(value)), attempt)
      expect(outcome.state, JSON.stringify(value)).toBe('unknown')
    }
    const wrongCandidate = receiptFor(attempt)
    ;(wrongCandidate.review as { candidateId: string }).candidateId = 'c2'
    const outcome = await sendArtifactReviewAttempt(rpc(vi.fn().mockResolvedValue(wrongCandidate)), attempt)
    expect(outcome.state).toBe('unknown')
    const wrongVerdict = receiptFor(attempt)
    ;(wrongVerdict.review as { verdict: string }).verdict = 'rejected'
    expect((await sendArtifactReviewAttempt(rpc(vi.fn().mockResolvedValue(wrongVerdict)), attempt)).state).toBe('unknown')
    const wrongReason = receiptFor(attempt)
    ;(wrongReason.review as { reason: string }).reason = 'forged'
    expect((await sendArtifactReviewAttempt(rpc(vi.fn().mockResolvedValue(wrongReason)), attempt)).state).toBe('unknown')
  })

  it('classifies a structured domain rejection as rejected and everything else as unknown', async () => {
    const attempt = attemptOf()
    const rejection = structuredRejection()
    const rejected = await sendArtifactReviewAttempt(rpc(vi.fn().mockRejectedValue(rejection)), attempt)
    expect(rejected).toEqual({ state: 'rejected', code: 'LOOM_REVIEW_EXISTS', message: rejection.message })

    // 消息里带 rejection 字样但没有结构化 kind/code：无确证，一律 unknown。
    const unproven = new Error('server said review exists')
    expect((await sendArtifactReviewAttempt(rpc(vi.fn().mockRejectedValue(unproven)), attempt)).state).toBe('unknown')
    expect((await sendArtifactReviewAttempt(rpc(vi.fn().mockRejectedValue(new Error('offline'))), attempt)).state).toBe('unknown')
  })

  it('validates the full receipt contract: identity, payload match and Core verdict semantics', async () => {
    const attempt = attemptOf()
    // pending 不能算 completed；planId 不符、标准版本不符、criteriaResults 被改、
    // reviewerId/reviewedAt 缺失、非 replay 的 task 状态与 verdict 不一致都一律 unknown。
    const broken: unknown[] = [
      receiptFor(attempt, { candidateAcceptanceStatus: 'pending' }),
      receiptFor(attempt, { candidateAcceptanceStatus: 'rejected' }),
      receiptFor(attempt, { planId: 'other-plan' }),
      (() => {
        const r = receiptFor(attempt)
        r.review.acceptanceCriteriaVersion = 'other-version'
        return r
      })(),
      (() => {
        const r = receiptFor(attempt)
        r.review.criteriaResults = []
        return r
      })(),
      (() => {
        const r = receiptFor(attempt)
        ;(r.review.criteriaResults[0] as { satisfied: boolean }).satisfied = false
        return r
      })(),
      (() => {
        const r = receiptFor(attempt)
        r.review.reviewerId = ''
        return r
      })(),
      (() => {
        const r = receiptFor(attempt)
        r.review.reviewedAt = ''
        return r
      })(),
      receiptFor(attempt, { taskStatus: 'ready' })
    ]
    for (const value of broken) {
      const outcome = await sendArtifactReviewAttempt(rpc(vi.fn().mockResolvedValue(value)), attempt)
      expect(outcome.state, JSON.stringify(value)).toBe('unknown')
    }
    // replay 回执的 taskStatus 是 Core 读到的当前状态：accepted 评审 + 当前 ready 合法。
    const replayedMoved = receiptFor(attempt, { replayed: true, taskStatus: 'ready' })
    expect((await sendArtifactReviewAttempt(rpc(vi.fn().mockResolvedValue(replayedMoved)), attempt)).state)
      .toBe('completed')
  })

  it('a no-task attempt can only weak-check planId shape', async () => {
    const noTaskFacts = artifactCandidateFacts({ ...bundle([first]), tasks: [] }, artifact, first)
    const attempt = prepareArtifactReviewAttempt('m', noTaskFacts, draft())
    expect(attempt.planId).toBeNull()
    expect((await sendArtifactReviewAttempt(
      rpc(vi.fn().mockResolvedValue(receiptFor(attempt, { planId: 'any-plan' }))), attempt
    )).state).toBe('completed')
    expect((await sendArtifactReviewAttempt(
      rpc(vi.fn().mockResolvedValue(receiptFor(attempt, { planId: '' }))), attempt
    )).state).toBe('unknown')
  })

  it('cleans the memory store only when the reason matches the internal lifecycle', async () => {
    // 各场景用独立 rpc：unknown 的保护不硬清，后续场景不与之争同 scope。
    // completed：confirmed_receipt 只在真实拿到回执后有效。
    const settledChannel = rpc(vi.fn())
    const settled = attemptOf()
    rememberUnconfirmedReviewAttempt(settledChannel, settled)
    expect(discardUnconfirmedReviewAttempt(settledChannel, settled, 'confirmed_receipt')).toBe(false)
    settledChannel.request.mockResolvedValueOnce(receiptFor(settled))
    expect((await sendArtifactReviewAttempt(settledChannel, settled)).state).toBe('completed')
    expect(discardUnconfirmedReviewAttempt(settledChannel, settled, 'confirmed_receipt')).toBe(true)
    expect(recallUnconfirmedReviewAttempt(settledChannel, 'm', 'c1')).toBeNull()
    expect(discardUnconfirmedReviewAttempt(settledChannel, settled, 'confirmed_receipt')).toBe(false)

    // rejected：结构化拒绝后 confirmed_rejection 才有效。
    const rejectedChannel = rpc(vi.fn())
    const rejectedAttempt = attemptOf()
    rememberUnconfirmedReviewAttempt(rejectedChannel, rejectedAttempt)
    rejectedChannel.request.mockRejectedValueOnce(structuredRejection())
    expect((await sendArtifactReviewAttempt(rejectedChannel, rejectedAttempt)).state).toBe('rejected')
    expect(discardUnconfirmedReviewAttempt(rejectedChannel, rejectedAttempt, 'confirmed_rejection')).toBe(true)
    expect(recallUnconfirmedReviewAttempt(rejectedChannel, 'm', 'c1')).toBeNull()

    // never_sent：确实没发送过才有效。
    const neverSentChannel = rpc(vi.fn())
    const neverSent = attemptOf()
    rememberUnconfirmedReviewAttempt(neverSentChannel, neverSent)
    expect(discardUnconfirmedReviewAttempt(neverSentChannel, neverSent, 'never_sent')).toBe(true)
    expect(recallUnconfirmedReviewAttempt(neverSentChannel, 'm', 'c1')).toBeNull()

    // unknown：谎称任何理由都删不掉；只能同包重试（保护保留，不硬清状态）。
    const stuckChannel = rpc(vi.fn())
    const stuck = attemptOf()
    rememberUnconfirmedReviewAttempt(stuckChannel, stuck)
    stuckChannel.request.mockRejectedValueOnce(new Error('offline'))
    expect((await sendArtifactReviewAttempt(stuckChannel, stuck)).state).toBe('unknown')
    expect(unconfirmedAttemptLifecycle(stuckChannel, stuck)).toBe('unknown')
    expect(discardUnconfirmedReviewAttempt(stuckChannel, stuck, 'confirmed_receipt')).toBe(false)
    expect(discardUnconfirmedReviewAttempt(stuckChannel, stuck, 'confirmed_rejection')).toBe(false)
    expect(discardUnconfirmedReviewAttempt(stuckChannel, stuck, 'never_sent')).toBe(false)
    expect(recallUnconfirmedReviewAttempt(stuckChannel, 'm', 'c1')).toBe(stuck)

    // 旧 attempt 对象删不掉同 scope 的新 attempt；换新包必须先明确清理旧的。
    const overwriteChannel = rpc(vi.fn())
    const old = attemptOf()
    rememberUnconfirmedReviewAttempt(overwriteChannel, old)
    expect(discardUnconfirmedReviewAttempt(overwriteChannel, old, 'never_sent')).toBe(true)
    const newer = attemptOf()
    rememberUnconfirmedReviewAttempt(overwriteChannel, newer)
    expect(discardUnconfirmedReviewAttempt(overwriteChannel, old, 'never_sent')).toBe(false)
    expect(recallUnconfirmedReviewAttempt(overwriteChannel, 'm', 'c1')).toBe(newer)
    expect(discardUnconfirmedReviewAttempt(overwriteChannel, newer, 'never_sent')).toBe(true)
  })

  it('rejects an explicit attempt whose draft content differs from the frozen payload', async () => {
    const channel = rpc(vi.fn())
    const attempt = attemptOf()
    await expect(submitArtifactReview(channel, 'm', facts(), draft({ reason: 'Changed' }), attempt))
      .rejects.toThrow('内容不一致')
    await expect(submitArtifactReview(channel, 'm', facts(), draft({ verdict: 'rejected' }), attempt))
      .rejects.toThrow('内容不一致')
    const rejectedAttempt = prepareArtifactReviewAttempt('m', facts(), draft({ verdict: 'rejected', satisfied: ['a'] }))
    const secondChannel = rpc(vi.fn())
    await expect(submitArtifactReview(secondChannel, 'm', facts(), draft({ verdict: 'rejected', satisfied: ['a', 'b'] }), rejectedAttempt))
      .rejects.toThrow('内容不一致')
    // 内容不一致在发送前拒绝：一个请求都不发，store 也未登记（登记发生在 send）。
    expect(channel.request).not.toHaveBeenCalled()
    expect(secondChannel.request).not.toHaveBeenCalled()
    expect(recallUnconfirmedReviewAttempt(channel, 'm', 'c1')).toBeNull()
  })

  it('submitArtifactReview with an explicit attempt returns the receipt and clears the store', async () => {
    const channel = rpc(vi.fn())
    const attempt = attemptOf()
    rememberUnconfirmedReviewAttempt(channel, attempt)
    channel.request.mockResolvedValueOnce(receiptFor(attempt))
    const receipt = await submitArtifactReview(channel, 'm', facts(), draft(), attempt)
    expect(receipt.review.candidateId).toBe('c1')
    expect(channel.request).toHaveBeenCalledTimes(1)
    expect(recallUnconfirmedReviewAttempt(channel, 'm', 'c1')).toBeNull()
  })
})

describe('refreshArtifactSelection never jumps candidates or trusts a changed identity', () => {
  it('keeps the same candidate and reflects the newest revision as latest=false', () => {
    const selection = { artifact, candidate: first, bundle: bundle() }
    const refreshed = refreshArtifactSelection(selection, [bundle([first, rework], [artifact, reworkArtifact])])
    expect(refreshed.contextAvailable).toBe(true)
    expect(refreshed.selection.candidate?.candidateId).toBe('c1')
    expect(refreshed.selection.bundle).not.toBe(selection.bundle)
    const refreshedFacts = artifactCandidateFacts(
      refreshed.selection.bundle, refreshed.selection.artifact, refreshed.selection.candidate
    )
    // 旧候选仍是这份证据的归属，但返工后不再是链头：latest=false，写入口关闭。
    expect(refreshedFacts.latest).toBe(false)
    expect(refreshedFacts.reviewable).toBe(false)
    expect(refreshedFacts.candidate?.candidateId).toBe('c1')
  })

  it('updates the bundle without a candidate for an ownerless artifact', () => {
    const selection = { artifact, candidate: null, bundle: bundle([], [artifact]) }
    const refreshed = refreshArtifactSelection(selection, [bundle([rework], [artifact, reworkArtifact])])
    expect(refreshed.contextAvailable).toBe(true)
    expect(refreshed.selection.candidate).toBeNull()
    expect(refreshed.selection.bundle).not.toBe(selection.bundle)
  })

  it('keeps the old read-only selection with contextAvailable=false on any mismatch', () => {
    const selection = { artifact, candidate: first, bundle: bundle() }
    // Mission 消失。
    expect(refreshArtifactSelection(selection, [bundle([first], [artifact], 'other')]))
      .toEqual({ selection, contextAvailable: false })
    expect(refreshArtifactSelection(selection, []))
      .toEqual({ selection, contextAvailable: false })
    // 产物缺失。
    expect(refreshArtifactSelection(selection, [bundle([first], [])]))
      .toEqual({ selection, contextAvailable: false })
    // 同 artifactId 但 sha256 变化：身份变化，不更新。
    const rehashed = { ...artifact, sha256: 'c'.repeat(64) }
    expect(refreshArtifactSelection(selection, [bundle([first], [rehashed])]))
      .toEqual({ selection, contextAvailable: false })
    // 候选不再拥有这份证据：不自动跳到别的候选。
    const disowned = { ...first, evidenceIds: ['file2'] }
    expect(refreshArtifactSelection(selection, [bundle([disowned], [artifact])]))
      .toEqual({ selection, contextAvailable: false })
    // 候选消失（返工换了候选）：保持旧 selection，不跳到 c2。
    expect(refreshArtifactSelection(selection, [bundle([rework], [artifact, reworkArtifact])]))
      .toEqual({ selection, contextAvailable: false })
    // immutable 候选内容变化：同 candidateId 但 contentHash/taskId/钉住的验收标准变化都拒绝。
    expect(refreshArtifactSelection(selection, [bundle([{ ...first, contentHash: 'c'.repeat(64) }], [artifact])]))
      .toEqual({ selection, contextAvailable: false })
    expect(refreshArtifactSelection(selection, [bundle([{ ...first, taskId: 'other' }], [artifact])]))
      .toEqual({ selection, contextAvailable: false })
    expect(refreshArtifactSelection(selection, [bundle([
      { ...first, acceptanceCriteria: { version: 'pinned-v2', criteria: criteria.criteria } }
    ], [artifact])]))
      .toEqual({ selection, contextAvailable: false })
    // 同 artifactId/hash 但 task/run 归属变化：另一份事实，拒绝。
    expect(refreshArtifactSelection(selection, [bundle([first], [{ ...artifact, taskId: 'other' }])]))
      .toEqual({ selection, contextAvailable: false })
    expect(refreshArtifactSelection(selection, [bundle([first], [{ ...artifact, agentRunId: 'other' }])]))
      .toEqual({ selection, contextAvailable: false })
    // 旧候选在刷新后仍是同一个 candidateId：显示 latest=false，不会变成新候选。
    const stillSame = refreshArtifactSelection(selection, [bundle([first, rework], [artifact, reworkArtifact])])
    expect(stillSame.contextAvailable).toBe(true)
    expect(stillSame.selection.candidate?.candidateId).toBe('c1')
    expect(artifactCandidateFacts(stillSame.selection.bundle, stillSame.selection.artifact, stillSame.selection.candidate).latest)
      .toBe(false)
  })
})

describe('legacy submitArtifactReview stays backward compatible', () => {
  it('still generates a fresh commandId per call without an attempt', async () => {
    const channel = rpc(vi.fn().mockResolvedValue(receiptFor(attemptOf())))
    await submitArtifactReview(channel, 'm', facts(), draft())
    await submitArtifactReview(channel, 'm', facts(), draft())
    expect(channel.request).toHaveBeenCalledTimes(2)
    const [firstCall, secondCall] = channel.request.mock.calls
    expect(firstCall[1].commandId).not.toBe(secondCall[1].commandId)
    expect(firstCall[1]).not.toHaveProperty('reviewerId')
  })

  it('still refuses a historical candidate outside the component', async () => {
    const request = vi.fn()
    const historical = artifactCandidateFacts(
      bundle([first, rework], [artifact, reworkArtifact]), artifact, first
    )
    await expect(submitArtifactReview(rpc(request), 'm', historical, draft())).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
})

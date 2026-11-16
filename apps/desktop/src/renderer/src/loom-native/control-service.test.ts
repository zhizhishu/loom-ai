import { describe, expect, it, vi } from 'vitest'
import type { AgentProfile, CoreMethod, LoomControlPolicy, LoomControlSnapshot, LoomTask, ThreadSnapshot } from '@contracts'
import { loomControlRevisionConflict } from '../loom-control-model'
import {
  LOOM_CONTROL_CONFIGURE,
  LOOM_CONTROL_GET,
  LOOM_CONTROL_PAUSE,
  beginConfigure,
  beginPause,
  classifyControlSnapshot,
  controlPanelProblems,
  controlPauseAllowed,
  controlRejectionCode,
  controlState,
  controlWritable,
  isNoWriteRejection,
  readControl,
  reviewerChoices,
  reviewerScope,
  submitControl,
  type ControlAttempt,
  type ControlPort,
  type ReviewerScope
} from './control-service'

// ---------------------------------------------------------------- fixtures

const agent = (agentId: string, over: Partial<AgentProfile> = {}): AgentProfile => ({
  agentId,
  displayName: agentId.toUpperCase(),
  presence: 'present',
  removedAt: null,
  teamRole: 'engineer',
  ...over
} as unknown as AgentProfile)

const task = (taskId: string, assigneeAgentId: string | null): LoomTask => ({
  taskId,
  planId: 'plan-1',
  title: `Task ${taskId}`,
  description: '',
  assigneeAgentId,
  status: 'ready',
  acceptanceCriteria: { version: 'v1', criteria: [{ criterionId: 'c1', text: 'real' }] },
  blockedReason: null,
  createdAt: '2026-11-16T00:00:00Z',
  updatedAt: '2026-11-16T00:00:00Z',
  revision: 1
} as unknown as LoomTask)

const policy = (over: Partial<LoomControlPolicy> = {}): LoomControlPolicy => ({
  missionId: 'm1',
  planId: 'plan-1',
  revision: 3,
  authorizationRevision: 2,
  enabled: true,
  paused: false,
  taskIds: ['t1'],
  reviewers: [{ taskId: 't1', reviewerAgentId: 'agent-2' }],
  maxDispatches: 8,
  maxReworksPerTask: 2,
  expiresAt: null,
  approvedBy: 'local_user',
  approvedAt: '2026-11-16T00:00:00Z',
  updatedAt: '2026-11-16T00:00:00Z',
  ...over
})

const snapshot = (over: Partial<LoomControlSnapshot> = {}): LoomControlSnapshot => ({
  missionId: 'm1',
  policy: policy(),
  stageReviews: [],
  dispatches: [],
  evaluatedAt: '2026-11-16T00:00:00Z',
  ...over
})

const draft = () => ({
  taskIds: ['t1'],
  reviewers: { t1: 'agent-2' },
  maxDispatches: '8',
  maxReworksPerTask: '2',
  expiresAt: ''
})

/** 测试用请求句柄：签名与 ControlPort 一致，`mock.calls` 才是 [method, params] 元组。 */
type RequestHandle = (method: CoreMethod, params?: unknown) => Promise<unknown>

const mockRequest = (impl: RequestHandle) => vi.fn(impl)

const port = (request: RequestHandle): ControlPort => ({ request: request as ControlPort['request'] })

const knownScope = (memberAgentIds: string[] = ['agent-1', 'agent-2']): ReviewerScope =>
  ({ status: 'known', threadId: 'thread-1', memberAgentIds: new Set(memberAgentIds) })

const threadSnapshot = (over: { threadId?: string; members?: unknown[] } = {}): ThreadSnapshot => ({
  thread: { id: over.threadId ?? 'thread-1' },
  members: over.members ?? [
    { agentId: 'agent-1', membershipStatus: 'active', profilePresence: 'present' },
    { agentId: 'agent-2', membershipStatus: 'active', profilePresence: 'present' }
  ]
} as unknown as ThreadSnapshot)

// ------------------------------------------------------------------ reading

describe('control-service reading', () => {
  it('treats a failed read as unreadable, never as "not approved", and sends no write', async () => {
    const request = mockRequest(async () => { throw new Error('offline') })
    const read = await readControl(port(request), 'm1')
    expect(request.mock.calls.map(call => call[0])).toEqual([LOOM_CONTROL_GET])
    expect(request).toHaveBeenCalledWith(LOOM_CONTROL_GET, { missionId: 'm1' })
    expect(read.status).toBe('failed')
    expect(controlState(read)).toBe('unreadable')
    expect(controlState(read)).not.toBe('unapproved')
    expect(controlWritable(controlState(read))).toBe(false)
  })

  it('never invents a mission to query', async () => {
    const request = mockRequest(async () => snapshot())
    const read = await readControl(port(request), '   ')
    expect(request).not.toHaveBeenCalled()
    expect(read.status).toBe('failed')
    expect(controlState(read)).toBe('unreadable')
  })

  it('refuses a snapshot that belongs to another mission', async () => {
    const read = classifyControlSnapshot(snapshot({ missionId: 'm2' }), 'm1')
    expect(read.status).toBe('failed')
    expect(controlState(read)).toBe('unreadable')
    if (read.status !== 'failed') throw new Error('a foreign snapshot must not be observed')
    expect(read.message).toMatch(/另一项工作/u)
  })

  it('refuses an incomplete snapshot instead of filling defaults', async () => {
    const incomplete = { ...snapshot(), evaluatedAt: undefined } as unknown as LoomControlSnapshot
    const read = classifyControlSnapshot(incomplete, 'm1')
    expect(read.status).toBe('failed')
    expect(controlState(read)).toBe('unreadable')
  })

  it('reads a real snapshot as observed and derives the control state from server time', async () => {
    const request = mockRequest(async () => snapshot())
    const read = await readControl(port(request), 'm1')
    expect(read.status).toBe('observed')
    expect(controlState(read)).toBe('approved')
    // 到期只看服务端 evaluatedAt：同一份策略在过期时刻变成 expired。
    const expired = classifyControlSnapshot(snapshot({
      policy: policy({ expiresAt: '2026-11-16T00:00:00Z' }),
      evaluatedAt: '2026-11-16T00:00:01Z'
    }), 'm1')
    expect(controlState(expired)).toBe('expired')
  })
})

// ------------------------------------------------------------------ writing

describe('control-service writing', () => {
  it('sends the exact configure payload taken from the production contract', async () => {
    const built = beginConfigure({
      missionId: 'm1',
      commandId: 'cmd-1',
      expectedRevision: 0,
      draft: draft(),
      tasks: [task('t1', 'agent-1')],
      agents: [agent('agent-1'), agent('agent-2')],
      scope: knownScope()
    })
    expect('attempt' in built).toBe(true)
    if (!('attempt' in built)) return
    expect(built.attempt.input).toEqual({
      missionId: 'm1',
      commandId: 'cmd-1',
      expectedRevision: 0,
      enabled: true,
      taskIds: ['t1'],
      reviewers: [{ taskId: 't1', reviewerAgentId: 'agent-2' }],
      maxDispatches: 8,
      maxReworksPerTask: 2,
      expiresAt: null
    })
    expect(Object.keys(built.attempt.input).sort()).toEqual([
      'commandId', 'enabled', 'expectedRevision', 'expiresAt',
      'maxDispatches', 'maxReworksPerTask', 'missionId', 'reviewers', 'taskIds'
    ])
    const request = mockRequest(async () => snapshot())
    const outcome = await submitControl(port(request), built.attempt)
    expect(request).toHaveBeenCalledWith(LOOM_CONTROL_CONFIGURE, built.attempt.input)
    expect(outcome.status).toBe('applied')
  })

  it('sends the exact pause payload and keeps the CAS revision', async () => {
    const built = beginPause({ missionId: 'm1', commandId: 'cmd-2', policy: policy({ revision: 7 }), paused: true })
    expect('attempt' in built).toBe(true)
    if (!('attempt' in built)) return
    expect(built.attempt.input).toEqual({ missionId: 'm1', commandId: 'cmd-2', expectedRevision: 7, paused: true })
    const request = mockRequest(async () => snapshot())
    await submitControl(port(request), built.attempt)
    expect(request).toHaveBeenCalledWith(LOOM_CONTROL_PAUSE, built.attempt.input)
  })

  it('keeps the same commandId and payload across an unknown outcome so a retry can reconcile', async () => {
    const built = beginConfigure({
      missionId: 'm1',
      commandId: 'cmd-keep',
      expectedRevision: 3,
      draft: draft(),
      tasks: [task('t1', 'agent-1')],
      agents: [agent('agent-1'), agent('agent-2')],
      scope: knownScope()
    })
    if (!('attempt' in built)) throw new Error('the draft must be submittable')
    const request = mockRequest(async () => { throw new Error('socket closed') })
    const first = await submitControl(port(request), built.attempt)
    const second = await submitControl(port(request), built.attempt)
    expect(first.status).toBe('unknown')
    expect(second.status).toBe('unknown')
    const [firstMethod, firstPayload] = request.mock.calls[0]
    const [secondMethod, secondPayload] = request.mock.calls[1]
    expect(secondMethod).toBe(firstMethod)
    // 同一份 payload 对象（不是重新构造的等价对象）：请求编号与范围预算都不会漂移。
    expect(secondPayload).toBe(firstPayload)
    expect((secondPayload as { commandId: string }).commandId).toBe('cmd-keep')
  })

  it('treats an unusable receipt as unknown, and a snapshot of another mission as unknown too', async () => {
    const built = beginPause({ missionId: 'm1', commandId: 'cmd-3', policy: policy(), paused: false })
    if (!('attempt' in built)) throw new Error('the pause must be submittable')
    const broken = await submitControl(port(mockRequest(async () => ({ ok: true }))), built.attempt)
    expect(broken.status).toBe('unknown')
    const foreign = await submitControl(port(mockRequest(async () => snapshot({ missionId: 'm2' }))), built.attempt)
    expect(foreign.status).toBe('unknown')
  })

  it('never treats an applied receipt without a standing policy as a save', async () => {
    const built = beginPause({ missionId: 'm1', commandId: 'cmd-null', policy: policy(), paused: true })
    if (!('attempt' in built)) throw new Error('the pause must be submittable')
    // 有效但 policy 为 null 的快照不是「保存成功」，也不能把 revision 当作合理。
    const noPolicy = await submitControl(port(mockRequest(async () => snapshot({ policy: null }))), built.attempt)
    expect(noPolicy.status).toBe('unknown')
    const zeroRevision = await submitControl(port(mockRequest(async () => snapshot({
      policy: policy({ revision: 0, authorizationRevision: 0 })
    }))), built.attempt)
    expect(zeroRevision.status).toBe('unknown')
  })

  it('recognises a definitive Core rejection so a new intent may start', async () => {
    const built = beginPause({ missionId: 'm1', commandId: 'cmd-4', policy: policy(), paused: true })
    if (!('attempt' in built)) throw new Error('the pause must be submittable')
    const rejection = Object.assign(new Error('LOOM_CONTROL_REVISION_CONFLICT: stale approval'), { code: 'LOOM_CONTROL_REVISION_CONFLICT' })
    expect(controlRejectionCode(rejection)).toBe('LOOM_CONTROL_REVISION_CONFLICT')
    const outcome = await submitControl(port(mockRequest(async () => { throw rejection })), built.attempt)
    expect(outcome.status).toBe('rejected')
    expect(outcome.status === 'rejected' ? outcome.code : '').toBe('LOOM_CONTROL_REVISION_CONFLICT')
    expect(loomControlRevisionConflict(new Error(outcome.status === 'rejected' ? outcome.message : ''))).toBe(true)
  })

  it('treats an unlisted outcome-unknown code as unknown and keeps the attempt', async () => {
    const built = beginPause({ missionId: 'm1', commandId: 'cmd-unknown', policy: policy(), paused: true })
    if (!('attempt' in built)) throw new Error('the pause must be submittable')
    expect(isNoWriteRejection('LOOM_UNKNOWN_OUTCOME')).toBe(false)
    const request = mockRequest(async () => {
      throw Object.assign(new Error('LOOM_UNKNOWN_OUTCOME: the Host lost the receipt'), { code: 'LOOM_UNKNOWN_OUTCOME' })
    })
    const first = await submitControl(port(request), built.attempt)
    expect(first.status).toBe('unknown')
    await submitControl(port(request), built.attempt)
    const [firstMethod, firstPayload] = request.mock.calls[0]
    const [secondMethod, secondPayload] = request.mock.calls[1]
    expect(secondMethod).toBe(firstMethod)
    expect(secondPayload).toBe(firstPayload)
  })

  it('does not mistake a transport failure for a rejection', () => {
    expect(controlRejectionCode(new Error('socket hang up'))).toBeNull()
    expect(controlRejectionCode(new Error('读取超时，请重试'))).toBeNull()
    expect(controlRejectionCode(new Error('LOOM_CONTROL_PAUSED: paused'))).toBe('LOOM_CONTROL_PAUSED')
    // PAUSED 属于阶段审查路径的拒绝，不是 configure/pause 的写入前拒绝：这里按 unknown 处理。
    expect(isNoWriteRejection('LOOM_CONTROL_PAUSED')).toBe(false)
    expect(isNoWriteRejection('LOOM_UNKNOWN_OUTCOME')).toBe(false)
    expect(isNoWriteRejection('LOOM_CONTROL_REVISION_CONFLICT')).toBe(true)
    expect(isNoWriteRejection(null)).toBe(false)
  })
})

// ------------------------------------------------------ scope and reviewers

describe('control-service scope', () => {
  it('refuses a reviewer who is the task assignee and builds no attempt', () => {
    const tasks = [task('t1', 'agent-1')]
    const agents = [agent('agent-1'), agent('agent-2')]
    expect(controlPanelProblems({ ...draft(), reviewers: { t1: 'agent-1' } }, tasks, agents, knownScope())).toContain('reviewer_self')
    const built = beginConfigure({
      missionId: 'm1', commandId: 'cmd-self', expectedRevision: 0,
      draft: { ...draft(), reviewers: { t1: 'agent-1' } }, tasks, agents, scope: knownScope()
    })
    expect('attempt' in built).toBe(false)
    expect(reviewerChoices(agents, knownScope(), 'agent-1').map(entry => entry.agentId)).toEqual(['agent-2'])
  })

  it('refuses a reviewer who is no longer a current member', () => {
    const tasks = [task('t1', 'agent-1')]
    const agents = [agent('agent-1'), agent('agent-2', { presence: 'removed' })]
    const problems = controlPanelProblems({ ...draft(), reviewers: { t1: 'agent-2' } }, tasks, agents, knownScope())
    expect(problems).toContain('reviewer_not_member')
    const built = beginConfigure({
      missionId: 'm1', commandId: 'cmd-member', expectedRevision: 0, draft: draft(), tasks, agents, scope: knownScope()
    })
    expect('attempt' in built).toBe(false)
  })

  it('takes the reviewer scope from the current Thread only, and blocks when it is unknown', () => {
    const tasks = [task('t1', 'agent-1')]
    const agents = [agent('agent-1'), agent('agent-2'), agent('agent-3')]
    // Thread 里 agent-2 已离队、agent-3 不在 Thread 中：两者都不能当独立审查者。
    const thread = threadSnapshot({
      members: [
        { agentId: 'agent-1', membershipStatus: 'active', profilePresence: 'present' },
        { agentId: 'agent-2', membershipStatus: 'left', profilePresence: 'present' }
      ]
    })
    const scope = reviewerScope(thread, 'thread-1')
    expect(scope.status).toBe('known')
    expect(reviewerChoices(agents, scope, 'agent-1')).toEqual([])
    expect(controlPanelProblems({ ...draft(), reviewers: { t1: 'agent-3' } }, tasks, agents, scope))
      .toContain('reviewer_not_member')
    // Thread 不存在 / 与 Mission 不匹配：成员范围 unknown，不能选择也不能提交。
    expect(reviewerScope(null, 'thread-1')).toEqual({ status: 'unknown', reason: 'thread_missing' })
    const mismatch = reviewerScope(threadSnapshot({ threadId: 'thread-other' }), 'thread-1')
    expect(mismatch).toEqual({ status: 'unknown', reason: 'thread_mismatch' })
    expect(reviewerChoices(agents, mismatch, 'agent-1')).toEqual([])
    expect(controlPanelProblems(draft(), tasks, agents, mismatch)).toContain('reviewer_membership_unknown')
    const built = beginConfigure({
      missionId: 'm1', commandId: 'cmd-scope', expectedRevision: 0, draft: draft(), tasks, agents, scope: mismatch
    })
    expect('attempt' in built).toBe(false)
  })

  it('still asks for a reviewer and a real budget instead of defaulting them', () => {
    const problems = controlPanelProblems(
      { taskIds: ['t1'], reviewers: {}, maxDispatches: '', maxReworksPerTask: '', expiresAt: '' },
      [task('t1', 'agent-1')],
      [agent('agent-1'), agent('agent-2')],
      knownScope()
    )
    expect(problems).toContain('missing_reviewer')
    expect(problems).toContain('max_dispatches')
    expect(problems).toContain('max_reworks')
  })

  it('keeps pause unavailable for an expired, disabled or unreadable authorization', () => {
    expect(controlPauseAllowed('expired', policy())).toBe(false)
    expect(controlPauseAllowed('disabled', policy({ enabled: false }))).toBe(false)
    expect(controlPauseAllowed('unreadable', policy())).toBe(false)
    expect(controlPauseAllowed('reading', policy())).toBe(false)
    expect(controlPauseAllowed('approved', policy())).toBe(true)
    expect(controlPauseAllowed('paused', policy({ paused: true }))).toBe(true)
    // 已过期仍可重新批准范围：可写性不等于「可继续」。
    expect(controlWritable('expired')).toBe(true)
  })

  it('never builds an attempt from an empty command identity', () => {
    const built = beginConfigure({
      missionId: 'm1', commandId: '  ', expectedRevision: 0, draft: draft(),
      tasks: [task('t1', 'agent-1')], agents: [agent('agent-1'), agent('agent-2')], scope: knownScope()
    })
    expect('attempt' in built).toBe(false)
    expect('invalid' in built).toBe(true)
  })
})

// --------------------------------------------------------------- guard rails

describe('control-service boundaries', () => {
  it('never writes anything when only reading', async () => {
    const request = mockRequest(async () => snapshot())
    await readControl(port(request), 'm1')
    const methods = request.mock.calls.map(call => call[0])
    expect(methods).toEqual([LOOM_CONTROL_GET])
    expect(methods).not.toContain(LOOM_CONTROL_CONFIGURE)
    expect(methods).not.toContain(LOOM_CONTROL_PAUSE)
  })

  it('exposes no attempt that could accept a candidate', () => {
    const built: ReturnType<typeof beginPause> = beginPause({ missionId: 'm1', commandId: 'cmd-5', policy: policy(), paused: true })
    if (!('attempt' in built)) throw new Error('the pause must be submittable')
    const attempt: ControlAttempt = built.attempt
    expect(attempt.kind).toBe('pause')
    expect(Object.keys(attempt.input).sort()).toEqual(['commandId', 'expectedRevision', 'missionId', 'paused'])
  })
})

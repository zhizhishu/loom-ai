import { describe, expect, it, vi } from 'vitest'
import type { MissionRecord, StoredCommandResult } from '@contracts'
import {
  createTrackedWork,
  newWorkAttempt,
  startTrackedWork,
  trackedWorkProblems,
  workAttemptSignature,
  WorkCommandRejected,
  WorkCommandUnknown,
  WorkStartFailed,
  type ResumableWorkAttempt,
  type TrackedWorkDraft
} from './work-service'

const applied = (code: string, payload: Record<string, unknown>, status: StoredCommandResult['status'] = 'applied'): StoredCommandResult => ({
  commandId: 'x', commandType: 'mission', status, code, payload, resultEntity: null, recordedAt: '2026-11-13T00:00:00Z'
})

const createReceipt = applied('mission.created', { missionId: 'rvm_1', missionNumber: 7, threadId: 'camp_1' })
const startedReceipt = { ...applied('mission.started', { missionId: 'rvm_1', threadId: 'camp_1', threadMessageId: 'msg_1', deliveryIds: ['d1'] }), status: 'accepted' } as StoredCommandResult
const alreadyRunningReceipt = applied('mission.already_running', { missionId: 'rvm_1', threadId: 'camp_1', alreadyRunning: true })

const missionRecord = (binding: MissionRecord['projectBindingKind']): MissionRecord => ({
  missionId: 'rvm_1', threadId: 'camp_1', title: 'Ship the thing', description: 'goal', status: 'not_started',
  sourceMessageId: null, number: 7, hasUnread: false, projectPath: binding === 'quick_chat' ? '' : '/repo',
  projectBindingKind: binding, detailsVersion: 1, tags: [], attachments: [], createdAt: '', updatedAt: '',
  memberAgentIds: ['agent'], defaultLeadAgentId: 'agent', runningAgentIds: [], startAvailable: true,
  workspaceEverCreated: false, workspaceResourcesPresent: false, cleanupAvailable: false
} as unknown as MissionRecord)

const draft = (over: Partial<TrackedWorkDraft> = {}): TrackedWorkDraft => ({
  name: 'Ship the thing',
  goal: 'Make the button work',
  memberAgentIds: ['agent', 'peer'],
  defaultLeadAgentId: 'agent',
  workspace: null,
  ...over
})

function mockPort(request: ReturnType<typeof vi.fn>): import('./work-service').WorkPort {
  return { request: request as import('./work-service').WorkPort['request'] }
}

describe('tracked work validation (zero RPC)', () => {
  it('flags an empty draft without any request', () => {
    const request = vi.fn()
    expect(trackedWorkProblems({ name: '', goal: '', memberAgentIds: [], defaultLeadAgentId: '', workspace: null })).toEqual([
      'name_required', 'goal_required', 'no_members'
    ])
    expect(request).not.toHaveBeenCalled()
  })
  it('createTrackedWork refuses an invalid draft before any RPC', async () => {
    const request = vi.fn()
    await expect(createTrackedWork(mockPort(request), draft({ name: '  ', goal: '' }))).rejects.toThrow('名称')
    expect(request).not.toHaveBeenCalled()
  })
  it('requires the primary lead to be a member and a nonempty goal', () => {
    expect(trackedWorkProblems(draft({ defaultLeadAgentId: 'other' }))).toEqual(['lead_not_member'])
    expect(trackedWorkProblems(draft({ goal: '  ' }))).toEqual(['goal_required'])
    expect(trackedWorkProblems(draft({ workspace: { name: 'x', projectPath: '  ' } }))).toEqual(['workspace_path_required'])
    expect(trackedWorkProblems(draft())).toEqual([])
  })
})

describe('tracked work create payload', () => {
  it('sends the exact missions.create stored-command shape for quick_chat (no team, no start)', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(createReceipt)
      .mockResolvedValueOnce(missionRecord('quick_chat'))
    const { result, attempt } = await createTrackedWork(mockPort(request), draft())
    expect(request.mock.calls.map(call => call[0])).toEqual(['missions.create', 'missions.get'])
    expect(request).toHaveBeenCalledWith('missions.create', {
      commandId: attempt.commandId,
      command: {
        title: 'Ship the thing',
        description: 'Make the button work',
        projectPath: '',
        projectBindingKind: 'quick_chat',
        memberAgentIds: ['agent', 'peer'],
        defaultLeadAgentId: 'agent',
        tags: []
      }
    })
    expect(result).toEqual({ missionId: 'rvm_1', threadId: 'camp_1', projectBindingKind: 'quick_chat', start: 'not_started' })
    expect(attempt.missionId).toBe('rvm_1')
    expect(attempt.threadId).toBe('camp_1')
  })
  it('uses the directory binding with the chosen project path and readback binding kind', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(createReceipt)
      .mockResolvedValueOnce(missionRecord('directory'))
    const { result } = await createTrackedWork(mockPort(request), draft({ workspace: { name: 'Repo', projectPath: '/repo' } }))
    expect(request).toHaveBeenCalledWith('missions.create', expect.objectContaining({
      command: expect.objectContaining({ projectBindingKind: 'directory', projectPath: '/repo' })
    }))
    expect(result.projectBindingKind).toBe('directory')
  })
  it('keeps a saved team when the draft carries one and dedupes members', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(createReceipt)
      .mockResolvedValueOnce(missionRecord('quick_chat'))
    const team = { teamId: 'team_1', expectedVersion: 3 }
    await createTrackedWork(mockPort(request), draft({ team, memberAgentIds: ['agent', 'agent'] }))
    expect(request).toHaveBeenCalledWith('missions.create', expect.objectContaining({
      command: expect.objectContaining({ team, memberAgentIds: ['agent'] })
    }))
  })
})

describe('tracked work create-only never starts', () => {
  it('issues one create and one readback, never missions.start or any message send', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(createReceipt)
      .mockResolvedValueOnce(missionRecord('quick_chat'))
    await createTrackedWork(mockPort(request), draft())
    expect(request.mock.calls.map(call => call[0])).toEqual(['missions.create', 'missions.get'])
    const [method] = request.mock.calls[0]
    expect(method).toBe('missions.create')
    expect(request.mock.calls.some(([m]) => m === 'missions.start' || m === 'threads.messages.send')).toBe(false)
  })
})

describe('unknown create outcome reconcile', () => {
  it('retains the original commandId on transport failure and retries the same command', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(createReceipt)
      .mockResolvedValueOnce(missionRecord('quick_chat'))
    let attempt: ResumableWorkAttempt | undefined
    try {
      await createTrackedWork(mockPort(request), draft())
      expect.fail('first attempt must fail')
    } catch (error) {
      expect(error).toBeInstanceOf(WorkCommandUnknown)
      attempt = (error as WorkCommandUnknown).attempt
      expect(attempt.missionId).toBeNull()
      expect(attempt.threadId).toBeNull()
    }
    const { attempt: resumed } = await createTrackedWork(mockPort(request), draft(), { attempt })
    expect(resumed.commandId).toBe(attempt!.commandId)
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1])
  })
  it('refuses a resume whose draft signature no longer matches the stored command', async () => {
    const first = newWorkAttempt(draft())
    const changed = newWorkAttempt(draft({ goal: 'different goal' }), first.commandId)
    const request = vi.fn()
    await expect(createTrackedWork(mockPort(request), draft({ goal: 'different goal' }), { attempt: first }))
      .rejects.toThrow('尚未确认')
    expect(request).not.toHaveBeenCalled()
    expect(workAttemptSignature(changed)).not.toBe(workAttemptSignature(first))
  })
  it('treats an applied create with missing IDs as unknown, keeping the attempt resumable', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(applied('mission.created', {}))
      .mockResolvedValueOnce(createReceipt)
      .mockResolvedValueOnce(missionRecord('quick_chat'))
    try {
      await createTrackedWork(mockPort(request), draft())
      expect.fail('applied-but-incomplete must fail')
    } catch (error) {
      expect(error).toBeInstanceOf(WorkCommandUnknown)
      expect((error as WorkCommandUnknown).attempt.missionId).toBeNull()
    }
    const { attempt } = await createTrackedWork(mockPort(request), draft(), {
      attempt: (request.mock.calls[0][1] as { commandId: string }).commandId
        ? { commandId: (request.mock.calls[0][1] as { commandId: string }).commandId, command: (request.mock.calls[0][1] as { command: unknown }).command as ResumableWorkAttempt['command'], missionId: null, threadId: null }
        : undefined
    })
    expect(attempt.missionId).toBe('rvm_1')
  })
})

describe('rejected create keeps nothing applied but reports rejection distinctly', () => {
  it('throws WorkCommandRejected with the Core code', async () => {
    const request = vi.fn().mockResolvedValue({ ...createReceipt, status: 'rejected', code: 'camp.invalid_initial_member' })
    await expect(createTrackedWork(mockPort(request), draft())).rejects.toMatchObject({
      name: 'WorkCommandRejected',
      result: { code: 'camp.invalid_initial_member' }
    })
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('explicit start is a separate command', () => {
  it('successful start calls missions.start exactly once and reports queued, never running', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(createReceipt)
      .mockResolvedValueOnce(missionRecord('quick_chat'))
      .mockResolvedValueOnce(startedReceipt)
    const { result, attempt } = await createTrackedWork(mockPort(request), draft(), { start: { commandId: 'start-1' } })
    expect(request).toHaveBeenCalledTimes(3)
    expect(request).toHaveBeenLastCalledWith('missions.start', { commandId: 'start-1', command: { missionId: 'rvm_1' } })
    expect(result.start).toBe('queued')
    expect(attempt.missionId).toBe('rvm_1')
  })
  it('already_running from Core is reported without a second dispatch', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(createReceipt)
      .mockResolvedValueOnce(missionRecord('quick_chat'))
      .mockResolvedValueOnce(alreadyRunningReceipt)
    const { result } = await createTrackedWork(mockPort(request), draft(), { start: { commandId: 'start-1' } })
    expect(result.start).toBe('already_running')
    expect(request).toHaveBeenCalledTimes(3)
  })
  it('a rejected start keeps the created Mission and retries only the same start command', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(createReceipt)
      .mockResolvedValueOnce(missionRecord('quick_chat'))
      .mockResolvedValueOnce({ ...startedReceipt, status: 'rejected', code: 'mission.lead_unavailable' })
      .mockResolvedValueOnce(startedReceipt)
    let failed: WorkStartFailed | undefined
    try {
      await createTrackedWork(mockPort(request), draft(), { start: { commandId: 'start-1' } })
      expect.fail('rejected start must fail')
    } catch (error) {
      failed = error as WorkStartFailed
    }
    expect(failed).toBeInstanceOf(WorkStartFailed)
    expect(failed!.attempt.missionId).toBe('rvm_1')
    expect(failed!.startCommandId).toBe('start-1')
    // Retry the same start commandId only; no recreate happens.
    const status = await startTrackedWork(mockPort(request), failed!.attempt, failed!.startCommandId)
    expect(status).toBe('queued')
    expect(request.mock.calls.filter(([method]) => method === 'missions.start')).toHaveLength(2)
    expect(request.mock.calls.filter(([method]) => method === 'missions.create')).toHaveLength(1)
    expect(request).toHaveBeenLastCalledWith('missions.start', { commandId: 'start-1', command: { missionId: 'rvm_1' } })
  })
  it('an unknown start outcome is a WorkStartFailed that keeps creation IDs for a same-command retry', async () => {
    const attempt: ResumableWorkAttempt = { ...newWorkAttempt(draft()), missionId: 'rvm_1', threadId: 'camp_1' }
    const request = vi.fn().mockRejectedValueOnce(new Error('timeout'))
    await expect(startTrackedWork(mockPort(request), attempt, 'start-1')).rejects.toMatchObject({
      name: 'WorkStartFailed',
      attempt: { missionId: 'rvm_1' },
      startCommandId: 'start-1'
    })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('missions.start', { commandId: 'start-1', command: { missionId: 'rvm_1' } })
  })
  it('refuses to start without a confirmed creation', async () => {
    const request = vi.fn()
    const attempt = newWorkAttempt(draft())
    await expect(startTrackedWork(mockPort(request), attempt, 'start-1')).rejects.toBeInstanceOf(WorkStartFailed)
    expect(request).not.toHaveBeenCalled()
  })
})

describe('readback and no-optimism', () => {
  it('readbacks a mismatching record as unknown instead of trusting the payload alone', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(createReceipt)
      .mockResolvedValueOnce({ ...missionRecord('quick_chat'), missionId: 'rvm_other' })
    await expect(createTrackedWork(mockPort(request), draft())).rejects.toBeInstanceOf(WorkCommandUnknown)
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('never claims a workspace or a running model: only observed binding and queued start', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(createReceipt)
      .mockResolvedValueOnce({ ...missionRecord('quick_chat'), workspaceEverCreated: false, workspaceResourcesPresent: false })
      .mockResolvedValueOnce(startedReceipt)
    const { result } = await createTrackedWork(mockPort(request), draft(), { start: { commandId: 'start-1' } })
    expect(result.start).toBe('queued')
    expect(JSON.stringify(result)).not.toContain('workspaceReady')
    expect(JSON.stringify(result)).not.toContain('running')
  })
})

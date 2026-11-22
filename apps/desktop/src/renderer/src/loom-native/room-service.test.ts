import { describe, expect, it, vi } from 'vitest'
import type {
  ActionApprovalView,
  AgentProfile,
  CoreMethod,
  NavigationSnapshot,
  StoredCommandResult,
  ThreadCreationPreflight,
  ThreadMemberRemovalPreview,
  ThreadSnapshot
} from '@contracts'
import type { BusinessEnvironment } from '../business-environment'
import { LoomCommandRejected } from './service'
import {
  addRoomMembers,
  applyKnownWorkspace,
  changeRoomLead,
  chooseRoomWorkspace,
  createRoom,
  emptyRoomDraft,
  initialRoomDraft,
  QUICK_CHAT_CHOICE,
  readHiddenRooms,
  readRoomMemberRemovalPreview,
  removeRoomMembers,
  resolveRoomPermission,
  ROOM_LEAD_REMOVAL_BLOCKED,
  roomDraftProblems,
  roomPort,
  roomPermissionChoices,
  roomRoster,
  setRoomHidden,
  roomSubmitProblem,
  roomWorkspaceChoices,
  type RoomDraft,
  type RoomPort
} from './room-service'

type RecordedCall = { method: string; params: Record<string, unknown> | undefined }

function applied(payload: Record<string, unknown> = {}): StoredCommandResult {
  return {
    commandId: 'c', commandType: 'x', status: 'applied', code: 'ok',
    payload, resultEntity: null, recordedAt: '2026-11-13T00:00:00Z'
  }
}

function rejected(code: string): StoredCommandResult {
  return { ...applied(), status: 'rejected' as const, code }
}

function fakePort(
  handlers: Partial<Record<string, (params: Record<string, unknown> | undefined) => unknown>> = {},
  overrides: Partial<RoomPort> = {}
): { port: RoomPort; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const port: RoomPort = {
    request: async <T,>(method: CoreMethod, params?: unknown): Promise<T> => {
      calls.push({ method, params: params as Record<string, unknown> | undefined })
      const handler = handlers[method]
      if (!handler) throw new Error(`unexpected ${method}`)
      const value = await handler(params as Record<string, unknown> | undefined)
      if (value instanceof Error) throw value
      return value as T
    },
    selectWorkspaceDirectory: async () => null,
    registerProject: async () => undefined,
    nativeDirectoryPicker: false,
    ...overrides
  }
  return { port, calls }
}

function member(id: string, over: Record<string, unknown> = {}): AgentProfile {
  return {
    agentId: id,
    displayName: id.toUpperCase(),
    avatarRef: null,
    accent: null,
    teamRole: 'Build',
    professionalResponsibilities: '',
    personalityTraits: [],
    workingPrinciples: '',
    growthTopic: '',
    defaultCapabilities: [],
    presence: 'present',
    runtimeConfiguration: { adapterKind: 'pi', model: { mode: 'runtime_default' }, permissions: { adapterKind: 'pi', schemaVersion: 1, values: {} } },
    runtimeReadiness: { status: 'ready', blockers: [] },
    memberOrder: 0,
    version: 1,
    createdAt: '',
    updatedAt: '',
    removedAt: null,
    ...over
  } as unknown as AgentProfile
}

function preflightOf(ids: readonly string[], lead: string | null = null): ThreadCreationPreflight {
  return {
    admissible: ids.length > 0,
    presentMembers: ids.map((agentId, memberOrder) => ({
      agentId, displayName: agentId, memberOrder, runtimeConfigured: true, runtimeReadiness: 'ready' as const
    })),
    initialLeadAgentId: lead,
    blockers: []
  }
}

function previewOf(agentId: string, over: Record<string, unknown> = {}): ThreadMemberRemovalPreview {
  return {
    threadId: 't', agentId, displayName: agentId.toUpperCase(),
    membershipGeneration: 3, membershipVersion: 1, isDefaultLead: false,
    remainingMemberCount: 1, nextDefaultLeadAgentId: null,
    nonTerminalAgentRunCount: 0, openAssignedTaskCount: 0,
    pendingDeliveryCount: 0, runningDeliveryCount: 0,
    removable: true, blockerCode: null,
    ...over
  } as unknown as ThreadMemberRemovalPreview
}

function approvalOf(over: Record<string, unknown> = {}): ActionApprovalView {
  return {
    id: 'approval', actionId: 'action', actionKind: 'fs.write', actionSummary: 'write file',
    canonicalInput: null, reason: null, agentRunId: 'run', agentId: 'a', adapterKind: 'pi',
    nativeMethod: null, requestDigest: null, permissionSemantics: 'core_enforced_v1',
    options: [
      { optionId: 'once', kind: 'allow_once', label: '允许一次', consequence: '下一次调用生效', nativeResponseDigest: 'd1' },
      { optionId: 'session', kind: 'allow_session', label: '本会话允许', consequence: '仅本次会话', nativeResponseDigest: 'd2' },
      { optionId: 'deny', kind: 'deny', label: '拒绝', consequence: '不执行', nativeResponseDigest: 'd3' }
    ],
    status: 'pending', requestedForUserId: 'local_user', resolvedByType: null, resolvedById: null,
    resolutionCode: null, version: 3, requestedAt: '', resolvedAt: null,
    ...over
  } as unknown as ActionApprovalView
}

describe('room draft defaults', () => {
  it('starts with one Lead only and never selects every assistant', () => {
    const draft = initialRoomDraft(preflightOf(['a', 'b', 'c']), null)
    expect(draft.memberAgentIds).toEqual(['a'])
    expect(draft.leadAgentId).toBe('a')
    expect(draft.workspace).toBeNull()
    expect(draft.collaborationMode).toBe('peer')
  })

  it('uses only valid saved-team members and their Lead', () => {
    const draft = initialRoomDraft(preflightOf(['a', 'b']), { memberAgentIds: ['b', 'gone'], defaultLeadAgentId: 'b' })
    expect(draft.memberAgentIds).toEqual(['b'])
    expect(draft.leadAgentId).toBe('b')
  })

  it('falls back to a single available Lead when the saved team is unusable', () => {
    const draft = initialRoomDraft(preflightOf(['a', 'b'], 'b'), { memberAgentIds: ['gone'], defaultLeadAgentId: 'gone' })
    expect(draft.memberAgentIds).toEqual(['b'])
    expect(draft.leadAgentId).toBe('b')
  })
})

describe('room draft validation', () => {
  const agents = [member('a'), member('b')]
  const group: RoomDraft = { ...emptyRoomDraft(), memberAgentIds: ['a', 'b'], leadAgentId: 'a' }

  it('reports the actual blocking problems', () => {
    expect(roomDraftProblems(emptyRoomDraft(), agents)).toContain('no_members')
    expect(roomDraftProblems({ ...group, leadAgentId: 'zzz' }, agents)).toContain('lead_not_member')
    expect(roomDraftProblems({ ...group, memberAgentIds: ['a', 'removed'] },
      [...agents, member('removed', { presence: 'removed' })])).toContain('member_unavailable')
    expect(roomDraftProblems({ ...group, name: 'x'.repeat(81) }, agents)).toContain('name_too_long')
    expect(roomDraftProblems(group, agents)).toEqual([])
  })

  it('allows assembling a group before model setup without admitting any execution', () => {
    const unconfigured = agents.map(agent => ({ ...agent, runtimeConfiguration: null,
      runtimeReadiness: { status: 'runtime_not_configured' as const, blockers: [] } }))
    expect(roomDraftProblems(group, unconfigured)).toEqual([])
  })

  it('never reaches Core with an invalid draft', async () => {
    const { port, calls } = fakePort({ 'threads.create': () => applied({ threadId: 't' }) })
    await expect(createRoom(port, { ...group, leadAgentId: 'zzz' }, agents)).rejects.toThrow()
    await expect(createRoom(port, { ...group, memberAgentIds: ['a', 'removed'], leadAgentId: 'a' },
      [...agents, member('removed', { presence: 'removed' })])).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

describe('createRoom', () => {
  const agents = [member('a'), member('b')]
  const group: RoomDraft = { ...emptyRoomDraft(), memberAgentIds: ['a', 'b'], leadAgentId: 'a', name: '  新  群组 ' }

  it('sends the exact create payload and reuses an explicit command id', async () => {
    const { port, calls } = fakePort({ 'threads.create': () => applied({ threadId: 't1' }) })
    await expect(createRoom(port, group, agents, 'fixed-id')).resolves.toEqual({ threadId: 't1', registrationWarning: null })
    expect(calls.map(call => call.method)).toEqual(['threads.create'])
    expect(calls[0].params).toEqual({
      commandId: 'fixed-id',
      name: '新 群组',
      workspace: null,
      memberAgentIds: ['a', 'b'],
      defaultLeadAgentId: 'a',
      collaborationMode: 'peer',
      activationState: 'active'
    })
  })

  it('keeps the created Thread when only the optional project registration fails', async () => {
    const registerProject = vi.fn().mockRejectedValue(new Error('preferences unavailable'))
    const { port, calls } = fakePort(
      { 'threads.create': () => applied({ threadId: 't2' }) },
      { registerProject }
    )
    const result = await createRoom(port, { ...group, workspace: { name: 'repo', projectPath: '/repo' } }, agents)
    expect(result.threadId).toBe('t2')
    expect(result.registrationWarning).not.toBeNull()
    expect(registerProject).toHaveBeenCalledWith('/repo')
    expect(calls[0].params?.workspace).toEqual({ projectPath: '/repo' })
    expect(calls.map(call => call.method)).toEqual(['threads.create'])
  })

  it('fails instead of reporting success on a missing, unknown or rejected receipt', async () => {
    const missing = fakePort({ 'threads.create': () => null })
    await expect(createRoom(missing.port, group, agents)).rejects.toThrow()
    const unknown = fakePort({ 'threads.create': () => ({ status: 'maybe', payload: { threadId: 't' } }) })
    await expect(createRoom(unknown.port, group, agents)).rejects.toThrow()
    const noThread = fakePort({ 'threads.create': () => applied({}) })
    await expect(createRoom(noThread.port, group, agents)).rejects.toThrow()
    const denied = fakePort({ 'threads.create': () => rejected('team.conflict') })
    await expect(createRoom(denied.port, group, agents)).rejects.toBeInstanceOf(LoomCommandRejected)
  })
})

describe('addRoomMembers', () => {
  it('issues one CAS command per member and carries the generation Core returned', async () => {
    const generations = [8, 9]
    const { port, calls } = fakePort({
      'threads.members.add': params => {
        expect(params?.command).toMatchObject({ threadId: 't' })
        return applied({ membershipGeneration: generations.shift(), changed: true })
      }
    })
    const outcome = await addRoomMembers(port, { threadId: 't', agentIds: ['a', 'b'], membershipGeneration: 4 })
    expect(outcome).toEqual({ addedAgentIds: ['a', 'b'], unchangedAgentIds: [], failures: [] })
    expect(calls.map(call => (call.params?.command as { expectedMembershipGeneration: number }).expectedMembershipGeneration))
      .toEqual([4, 8])
    expect(calls.some(call => call.method === 'thread.messages.send')).toBe(false)
  })

  it('stops without advancing when a membership conflict is returned', async () => {
    const { port, calls } = fakePort({ 'threads.members.add': () => rejected('camp.membership_generation_conflict') })
    const outcome = await addRoomMembers(port, { threadId: 't', agentIds: ['a', 'b'], membershipGeneration: 2 })
    expect(calls).toHaveLength(1)
    expect(outcome.addedAgentIds).toEqual([])
    expect(outcome.failures.map(failure => failure.agentId)).toEqual(['a', 'b'])
  })

  it('stops without advancing when the returned generation is unknown', async () => {
    const { port, calls } = fakePort({ 'threads.members.add': () => applied({ changed: true }) })
    const outcome = await addRoomMembers(port, { threadId: 't', agentIds: ['a', 'b'], membershipGeneration: 2 })
    expect(calls).toHaveLength(1)
    expect(outcome.failures.map(failure => failure.agentId)).toEqual(['a', 'b'])
  })

  it('reports an unreadable receipt as failure and never as added', async () => {
    const { port } = fakePort({ 'threads.members.add': () => new Error('connection lost') })
    const outcome = await addRoomMembers(port, { threadId: 't', agentIds: ['a'], membershipGeneration: 1 })
    expect(outcome.addedAgentIds).toEqual([])
    expect(outcome.failures).toHaveLength(1)
  })

  it('refuses to guess an unknown generation up front', async () => {
    const { port, calls } = fakePort({ 'threads.members.add': () => applied({ membershipGeneration: 3 }) })
    await expect(addRoomMembers(port, { threadId: 't', agentIds: ['a'], membershipGeneration: 0 })).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

describe('changeRoomLead', () => {
  it('sends the successor CAS payload', async () => {
    const { port, calls } = fakePort({ 'threads.changeDefaultLead': () => applied() })
    await changeRoomLead(port, { threadId: 't', successorAgentId: 'b', expectedVersion: 7 })
    expect(calls[0].params).toMatchObject({
      command: { threadId: 't', successorAgentId: 'b', expectedVersion: 7 }
    })
    expect(typeof calls[0].params?.commandId).toBe('string')
  })

  it('fails on an unknown receipt and on a rejected command', async () => {
    const unknown = fakePort({ 'threads.changeDefaultLead': () => ({}) })
    await expect(changeRoomLead(unknown.port, { threadId: 't', successorAgentId: 'b', expectedVersion: 1 })).rejects.toThrow()
    const denied = fakePort({ 'threads.changeDefaultLead': () => rejected('camp.member_not_active') })
    await expect(changeRoomLead(denied.port, { threadId: 't', successorAgentId: 'b', expectedVersion: 1 }))
      .rejects.toBeInstanceOf(LoomCommandRejected)
  })
})

describe('readRoomMemberRemovalPreview', () => {
  it('reads the exact member of this Thread and returns Core\'s preview verbatim', async () => {
    const preview = previewOf('b', { membershipGeneration: 5, membershipVersion: 2 })
    const { port, calls } = fakePort({ 'threads.members.removalPreview': () => preview })
    await expect(readRoomMemberRemovalPreview(port, 't', 'b')).resolves.toEqual(preview)
    expect(calls).toEqual([{ method: 'threads.members.removalPreview', params: { threadId: 't', agentId: 'b' } }])
  })

  it('refuses a preview that is not provably this member with usable revisions', async () => {
    const otherMember = fakePort({ 'threads.members.removalPreview': () => previewOf('someone-else') })
    await expect(readRoomMemberRemovalPreview(otherMember.port, 't', 'b')).rejects.toThrow()
    const otherThread = fakePort({ 'threads.members.removalPreview': () => previewOf('b', { threadId: 'other' }) })
    await expect(readRoomMemberRemovalPreview(otherThread.port, 't', 'b')).rejects.toThrow()
    const noVersion = fakePort({ 'threads.members.removalPreview': () => previewOf('b', { membershipVersion: 0 }) })
    await expect(readRoomMemberRemovalPreview(noVersion.port, 't', 'b')).rejects.toThrow()
    const noGeneration = fakePort({ 'threads.members.removalPreview': () => previewOf('b', { membershipGeneration: null }) })
    await expect(readRoomMemberRemovalPreview(noGeneration.port, 't', 'b')).rejects.toThrow()
    const missing = fakePort({ 'threads.members.removalPreview': () => null })
    await expect(readRoomMemberRemovalPreview(missing.port, 't', 'b')).rejects.toThrow()
  })
})

describe('removeRoomMembers', () => {
  it('submits the previewed generation and the member version for one member', async () => {
    const { port, calls } = fakePort({
      'threads.members.removalPreview': () => previewOf('b', { membershipGeneration: 3, membershipVersion: 2 }),
      'threads.members.remove': () => applied({ membershipGeneration: 4, membershipStatus: 'left', changed: true })
    })
    const outcome = await removeRoomMembers(port, { threadId: 't', agentIds: ['b'] })
    expect(outcome).toEqual({ removedAgentIds: ['b'], failures: [], nextDefaultLeadAgentId: null })
    expect(calls[1].params).toMatchObject({
      command: { threadId: 't', agentId: 'b', expectedMembershipGeneration: 3, expectedMembershipVersion: 2 }
    })
    expect((calls[1].params?.command as Record<string, unknown>).replacementDefaultLeadAgentId).toBeUndefined()
  })

  it('never removes the primary Lead before another assistant takes over', async () => {
    const { port, calls } = fakePort({
      'threads.members.removalPreview': () => previewOf('a', { isDefaultLead: true })
    })
    const outcome = await removeRoomMembers(port, { threadId: 't', agentIds: ['a', 'b'] })
    expect(outcome.removedAgentIds).toEqual([])
    expect(outcome.failures.map(failure => failure.message)).toEqual([ROOM_LEAD_REMOVAL_BLOCKED, ROOM_LEAD_REMOVAL_BLOCKED])
    expect(calls.some(call => call.method === 'threads.members.remove')).toBe(false)
  })

  it('stops the batch when Core reports a stale roster', async () => {
    const { port, calls } = fakePort({
      'threads.members.removalPreview': params => previewOf(String(params?.agentId)),
      'threads.members.remove': () => rejected('camp.membership_generation_conflict')
    })
    const outcome = await removeRoomMembers(port, { threadId: 't', agentIds: ['b', 'c'] })
    expect(outcome.removedAgentIds).toEqual([])
    expect(outcome.failures.map(failure => failure.agentId)).toEqual(['b', 'c'])
    expect(calls.filter(call => call.method === 'threads.members.remove')).toHaveLength(1)
  })

  it('refuses to remove a Lead whose successor was refused by Core', async () => {
    const { port } = fakePort({
      'threads.members.removalPreview': () => previewOf('b'),
      'threads.members.remove': () => rejected('camp.default_lead_unavailable')
    })
    const outcome = await removeRoomMembers(port, { threadId: 't', agentIds: ['b'] })
    expect(outcome.removedAgentIds).toEqual([])
    expect(outcome.failures).toHaveLength(1)
  })

  it('treats an unreadable preview or receipt as unconfirmed, never as removed', async () => {
    const unreadable = fakePort({ 'threads.members.removalPreview': () => null })
    const blocked = await removeRoomMembers(unreadable.port, { threadId: 't', agentIds: ['b', 'c'] })
    expect(blocked.removedAgentIds).toEqual([])
    expect(blocked.failures.map(failure => failure.agentId)).toEqual(['b', 'c'])

    const unknown = fakePort({
      'threads.members.removalPreview': () => previewOf('b'),
      'threads.members.remove': () => new Error('connection lost')
    })
    const lost = await removeRoomMembers(unknown.port, { threadId: 't', agentIds: ['b'] })
    expect(lost.removedAgentIds).toEqual([])
    expect(lost.failures).toHaveLength(1)
  })

  it('stops when the receipt did not advance the generation', async () => {
    const { port } = fakePort({
      'threads.members.removalPreview': () => previewOf('b', { membershipGeneration: 3 }),
      'threads.members.remove': () => applied({ membershipGeneration: 3, changed: true })
    })
    const outcome = await removeRoomMembers(port, { threadId: 't', agentIds: ['b'] })
    expect(outcome.removedAgentIds).toEqual([])
    expect(outcome.failures).toHaveLength(1)
  })

  it('reports an ended membership instead of pretending it removed the member', async () => {
    const { port, calls } = fakePort({
      'threads.members.removalPreview': params => previewOf(String(params?.agentId), { removable: false, blockerCode: 'camp.member_not_active' }),
      'threads.members.remove': () => applied({ membershipGeneration: 4 })
    })
    const outcome = await removeRoomMembers(port, { threadId: 't', agentIds: ['b'] })
    expect(outcome.removedAgentIds).toEqual([])
    expect(outcome.failures).toEqual([{ agentId: 'b', message: '该助手已不在群里，请刷新后重试。' }])
    expect(calls.some(call => call.method === 'threads.members.remove')).toBe(false)
  })

  it('refuses an empty target set without sending anything', async () => {
    const { port, calls } = fakePort({})
    await expect(removeRoomMembers(port, { threadId: ' ', agentIds: ['b'] })).rejects.toThrow()
    await expect(removeRoomMembers(port, { threadId: 't', agentIds: ['', ''] })).resolves.toEqual({
      removedAgentIds: [], failures: [], nextDefaultLeadAgentId: null
    })
    expect(calls).toEqual([])
  })
})

describe('setRoomHidden', () => {
  it('hides by one Core command and never removes a single assistant', async () => {
    const { port, calls } = fakePort({
      'threads.setHidden': () => applied({ threadId: 't', hidden: true, hiddenAt: '2026-01-01T00:00:00Z' })
    })
    await setRoomHidden(port, { threadId: 't', hidden: true })
    expect(calls.map(call => call.method)).toEqual(['threads.setHidden'])
    expect(calls[0].params).toEqual({ commandId: expect.any(String), command: { threadId: 't', hidden: true } })
    // 退出群聊不再是「把助手全部移出」：一个人都不动。
    expect(calls.some(call => call.method === 'threads.members.remove')).toBe(false)
    expect(calls.some(call => call.method === 'threads.members.removalPreview')).toBe(false)
    expect(calls.some(call => call.method === 'thread.messages.send')).toBe(false)
  })

  it('restores with the same switch', async () => {
    const { port, calls } = fakePort({
      'threads.setHidden': () => applied({ threadId: 't', hidden: false, hiddenAt: null })
    })
    await setRoomHidden(port, { threadId: 't', hidden: false })
    expect((calls[0].params?.command as { hidden: boolean }).hidden).toBe(false)
  })

  it('treats a receipt that does not carry back the flag as unconfirmed', async () => {
    const { port } = fakePort({ 'threads.setHidden': () => applied({ threadId: 't' }) })
    await expect(setRoomHidden(port, { threadId: 't', hidden: true })).rejects.toThrow('隐藏结果未确认')
  })

  it('surfaces a rejected receipt and never reports success', async () => {
    const { port } = fakePort({
      'threads.setHidden': () => rejected('camp.not_found')
    })
    await expect(setRoomHidden(port, { threadId: 't', hidden: true })).rejects.toThrow()
  })

  it('refuses a blank Thread id without touching Core', async () => {
    const { port, calls } = fakePort({})
    await expect(setRoomHidden(port, { threadId: ' ', hidden: true })).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

describe('readHiddenRooms', () => {
  it('reads the hidden list verbatim', async () => {
    const rows = [{ id: 't', title: '旧群', projectPath: '/local', hiddenAt: '2026-01-01T00:00:00Z' }]
    const { port, calls } = fakePort({ 'threads.hiddenList': () => rows })
    await expect(readHiddenRooms(port)).resolves.toEqual(rows)
    expect(calls.map(call => call.method)).toEqual(['threads.hiddenList'])
  })

  it('never turns an unreadable receipt into an empty list', async () => {
    const { port } = fakePort({ 'threads.hiddenList': () => ({ rows: [] }) })
    await expect(readHiddenRooms(port)).rejects.toThrow('已隐藏列表读取结果不可用')
  })
})

describe('roomRoster', () => {
  it('marks exactly one primary Lead and leaves left members out of the participants', () => {
    const snapshot = {
      thread: { id: 't', defaultLeadAgentId: 'a' },
      members: [
        { agentId: 'a', displayName: 'A', avatarRef: null, teamRole: 'Lead', profilePresence: 'present', membershipStatus: 'active' },
        { agentId: 'b', displayName: 'B', avatarRef: null, teamRole: 'Build', profilePresence: 'present', membershipStatus: 'active' },
        { agentId: 'c', displayName: 'C', avatarRef: null, teamRole: 'Build', profilePresence: 'present', membershipStatus: 'left' }
      ]
    } as unknown as ThreadSnapshot
    const roster = roomRoster(snapshot)
    expect(roster.primaryLeadAgentId).toBe('a')
    expect(roster.participants.map(entry => entry.agentId)).toEqual(['a', 'b'])
    expect(roster.participants.filter(entry => entry.isPrimaryLead)).toHaveLength(1)
  })

  it('reports no primary Lead for a zero-member Thread', () => {
    const roster = roomRoster({ thread: { id: 't', defaultLeadAgentId: null }, members: [] } as unknown as ThreadSnapshot)
    expect(roster).toEqual({ primaryLeadAgentId: null, participants: [] })
  })
})

describe('permissions', () => {
  it('keeps Core options verbatim and session-scoped', () => {
    const choices = roomPermissionChoices(approvalOf())
    expect(choices.map(choice => choice.optionId)).toEqual(['once', 'session', 'deny'])
    expect(choices.map(choice => choice.scope)).toEqual(['once', 'session', null])
    expect(choices[1]).toMatchObject({ kind: 'allow_session', label: '本会话允许', consequence: '仅本次会话' })
    expect(choices.some(choice => choice.optionId === 'allow_always')).toBe(false)
  })

  it('offers nothing for a resolved request and refuses an unknown option kind', () => {
    expect(roomPermissionChoices(approvalOf({ status: 'approved' }))).toEqual([])
    expect(() => roomPermissionChoices(approvalOf({
      options: [{ optionId: 'x', kind: 'always', label: 'x', consequence: 'x', nativeResponseDigest: 'd' }]
    }))).toThrow()
  })

  it('rejects an option Core never offered without sending anything', async () => {
    const { port, calls } = fakePort({ 'action.approvals.resolve': () => applied() })
    await expect(resolveRoomPermission(port, { threadId: 't', approval: approvalOf(), optionId: 'allow_always' }))
      .rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('resolves with the exact approval version and option', async () => {
    const { port, calls } = fakePort({ 'action.approvals.resolve': () => applied() })
    const result = await resolveRoomPermission(port, { threadId: 't', approval: approvalOf(), optionId: 'session' })
    expect(result.status).toBe('applied')
    expect(calls[0].params).toMatchObject({
      threadId: 't', approvalId: 'approval', expectedVersion: 3, optionId: 'session'
    })
  })
})

describe('workspace', () => {
  it('accepts only a Host-reported project or a quick chat', () => {
    const draft: RoomDraft = { ...emptyRoomDraft(), memberAgentIds: ['a'], leadAgentId: 'a' }
    expect(applyKnownWorkspace(draft, QUICK_CHAT_CHOICE).workspace).toBeNull()
    expect(applyKnownWorkspace(draft, { kind: 'project', projectKey: 'k', name: 'repo', projectPath: '/repo' }).workspace)
      .toEqual({ name: 'repo', projectPath: '/repo' })
    expect(() => applyKnownWorkspace(draft, { kind: 'project', projectKey: 'k', name: 'repo', projectPath: ' ' })).toThrow()
    const choices = roomWorkspaceChoices({
      schemaVersion: 3, throughGlobalSequence: 1, quickChat: { totalCount: 0, recentThreads: [] },
      projects: [{ projectKey: 'k', name: 'repo', projectPath: '/repo', lastActivityAt: '', totalCount: 0, recentThreads: [] }]
    } as unknown as NavigationSnapshot)
    expect(choices[0]).toEqual(QUICK_CHAT_CHOICE)
    expect(choices[1]).toMatchObject({ kind: 'project', projectPath: '/repo' })
  })

  it('uses the Host picker and keeps the draft when it is cancelled', async () => {
    const draft: RoomDraft = { ...emptyRoomDraft(), memberAgentIds: ['a'], leadAgentId: 'a' }
    const cancelled = fakePort({}, { selectWorkspaceDirectory: async () => null })
    await expect(chooseRoomWorkspace(cancelled.port, draft)).resolves.toBe(draft)
    const chosen = fakePort({}, { selectWorkspaceDirectory: async () => ({ name: 'repo', projectPath: '/repo' }) })
    await expect(chooseRoomWorkspace(chosen.port, draft)).resolves.toMatchObject({ workspace: { projectPath: '/repo' } })
    const empty = fakePort({}, { selectWorkspaceDirectory: async () => ({ name: '', projectPath: '' }) })
    await expect(chooseRoomWorkspace(empty.port, draft)).rejects.toThrow()
  })
})

describe('roomPort', () => {
  it('projects the real environment capabilities without inventing any', async () => {
    const request = vi.fn().mockResolvedValue(null)
    const registerProjects = vi.fn().mockResolvedValue({})
    const base = {
      client: { request },
      selectWorkspaceDirectory: async () => null,
      preferences: { navigationPreferences: { registerProjects } }
    } as unknown as BusinessEnvironment
    const web = roomPort(base)
    expect(web.nativeDirectoryPicker).toBe(false)
    await web.registerProject('/repo')
    expect(registerProjects).toHaveBeenCalledWith(['/repo'])
    expect(roomPort({ ...base, desktop: {} } as unknown as BusinessEnvironment).nativeDirectoryPicker).toBe(true)
  })
})

// 主按钮永远可点，点下去说缺什么（Mikka `new-group-dialog.tsx:68-72,151`）。
describe('roomSubmitProblem', () => {
  it('names the missing member instead of leaving the primary button dead', () => {
    const agents = [member('a')]
    const draft: RoomDraft = emptyRoomDraft()
    expect(roomSubmitProblem(draft, agents, preflightOf(['a']))).toBe('请至少选择一位队员。')
  })

  it('says nothing when the draft can actually be created', () => {
    const agents = [member('a')]
    const draft: RoomDraft = { ...emptyRoomDraft(), memberAgentIds: ['a'], leadAgentId: 'a' }
    expect(roomSubmitProblem(draft, agents, preflightOf(['a']))).toBeNull()
    // 还没读到 preflight（null）时不能凭空报错。
    expect(roomSubmitProblem(draft, agents, null)).toBeNull()
  })

  it('sends the person to create an assistant when the host has none', () => {
    expect(roomSubmitProblem(emptyRoomDraft(), [], preflightOf([]))).toBe('当前主机还没有可用助手。请先新建或启用一位助手。')
  })

  it('keeps the existing member problems unchanged', () => {
    const agents = [member('a'), member('b')]
    const leadMissing: RoomDraft = { ...emptyRoomDraft(), memberAgentIds: ['a'], leadAgentId: 'b' }
    expect(roomSubmitProblem(leadMissing, agents, preflightOf(['a', 'b']))).toBe('队长必须是已选队员之一。')
    const unavailable: RoomDraft = { ...emptyRoomDraft(), memberAgentIds: ['gone'], leadAgentId: 'gone' }
    expect(roomSubmitProblem(unavailable, agents, preflightOf(['a']))).toBe('所选队员已不可用，请重新选择。')
  })
})

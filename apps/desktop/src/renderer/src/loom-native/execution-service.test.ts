import { describe, expect, it, vi } from 'vitest'
import type { ExecutionNodeRecord } from '@contracts'
import { nodeFailure, type NodeApi } from '../nodes-api'
import {
  executionTargetDraftFromView,
  setTargetWorkspace,
  type ExecutionTargetRuntimeDescriptor,
  type ExecutionTargetView
} from '../member-execution-target-model'
import {
  ExecutionRequestError,
  createExecutionService,
  remoteRuntimes,
  type ExecutionRpc
} from './execution-service'

type Call = { method: string, params: unknown }

/** 录制式假 RPC：只记录真实的 method/params，并按录制结果回复。 */
function recorded(handler: (method: string, params: unknown) => Promise<unknown>) {
  const calls: Call[] = []
  const rpc: ExecutionRpc = {
    request: (<T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params })
      return handler(method, params) as Promise<T>
    }) as unknown as ExecutionRpc['request']
  }
  return { rpc, calls }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function descriptor(kind: string): ExecutionTargetRuntimeDescriptor {
  return {
    adapterKind: kind,
    permissionSchemaVersion: 1,
    permissionOptions: [],
    memberRuntimeDefaults: { model: { mode: 'runtime_default' }, permissions: { adapterKind: kind, schemaVersion: 1, values: {} } },
    supportsRuntimeDefaultModel: true
  } as unknown as ExecutionTargetRuntimeDescriptor
}

function view(over: Partial<ExecutionTargetView> = {}): ExecutionTargetView {
  return {
    memberId: 'member',
    revision: 5,
    selection: null,
    availableWorkspaces: [],
    runtimeDescriptors: [descriptor('claude-code-cli'), descriptor('codex-cli')],
    ...over
  }
}

const remoteSelection = {
  nodeId: 'node-1',
  workspaceId: 'ws-1',
  workspaceRoot: '/srv/ws-1',
  adapterKind: 'claude-code-cli',
  model: { mode: 'runtime_default' },
  permissions: { adapterKind: 'claude-code-cli', schemaVersion: 1, values: {} }
} as unknown as NonNullable<ExecutionTargetView['selection']>

const remoteView = view({
  revision: 5,
  selection: remoteSelection,
  availableWorkspaces: [
    { nodeId: 'node-1', workspaceId: 'ws-1', workspaceRoot: '/srv/ws-1', missionId: 'm1', missionTitle: 'One' },
    { nodeId: 'node-1', workspaceId: 'ws-2', workspaceRoot: '/srv/ws-2', missionId: 'm2', missionTitle: 'Two' },
    { nodeId: 'node-2', workspaceId: 'ws-9', workspaceRoot: '/srv/ws-9', missionId: 'm3', missionTitle: 'Three' }
  ]
})

const nodeRecord = { nodeId: 'node-1', displayName: 'Box', role: 'remote', status: 'online', revokedAt: null, clis: [] } as unknown as ExecutionNodeRecord

function nodeApi(over: Partial<NodeApi> = {}): NodeApi {
  return {
    list: vi.fn().mockResolvedValue({ nodes: [nodeRecord] }),
    pair: vi.fn(),
    revoke: vi.fn(),
    output: vi.fn(),
    ...over
  } as unknown as NodeApi
}

describe('运行位置读写', () => {
  it('reads one member target with the real get payload', async () => {
    const { rpc, calls } = recorded(async () => remoteView)
    const service = createExecutionService(rpc, null)
    expect((await service.read('member')).revision).toBe(5)
    expect(calls).toEqual([{ method: 'members.executionTarget.get', params: { memberId: 'member' } }])
  })

  it('saves with exactly the CAS payload Core expects, local target included', async () => {
    const { rpc, calls } = recorded(async () => ({ memberId: 'member', revision: 6, selection: null }))
    const service = createExecutionService(rpc, null)
    const receipt = await service.save({ memberId: 'member', expectedRevision: 5, selection: null })
    expect(receipt).toEqual({ memberId: 'member', revision: 6, selection: null })
    expect(calls).toEqual([{
      method: 'members.executionTarget.save',
      params: { memberId: 'member', expectedRevision: 5, selection: null }
    }])
  })

  it('keeps a Core refusal code instead of restating it', async () => {
    const { rpc } = recorded(async () => { throw nodeFailure('remote_target_revision_conflict') })
    const service = createExecutionService(rpc, null)
    await expect(service.read('member')).rejects.toBeInstanceOf(ExecutionRequestError)
    await expect(service.read('member')).rejects.toMatchObject({ code: 'remote_target_revision_conflict' })
  })
})

describe('节点列表：读不到不等于离线', () => {
  it('reports unavailable without any call when the host has no node channel', async () => {
    const { rpc, calls } = recorded(async () => view())
    const service = createExecutionService(rpc, null)
    expect(await service.nodes()).toEqual({ status: 'unavailable', code: 'nodes_unavailable' })
    expect(calls).toHaveLength(0)
  })

  it('reports unavailable on a failed read, and never an empty node list', async () => {
    const failing = createExecutionService(recorded(async () => view()).rpc, nodeApi({
      list: vi.fn().mockRejectedValue(nodeFailure('nodes_unreachable'))
    }))
    expect(await failing.nodes()).toEqual({ status: 'unavailable', code: 'nodes_unreachable' })
    const quiet = createExecutionService(recorded(async () => view()).rpc, nodeApi({
      list: vi.fn().mockRejectedValue(new Error('boom'))
    }))
    expect(await quiet.nodes()).toEqual({ status: 'unavailable', code: 'nodes_unreadable' })
  })

  it('passes through the real node list, including an empty one', async () => {
    const service = createExecutionService(recorded(async () => view()).rpc, nodeApi())
    expect(await service.nodes()).toEqual({ status: 'ready', nodes: [nodeRecord] })
    const empty = createExecutionService(recorded(async () => view()).rpc, nodeApi({
      list: vi.fn().mockResolvedValue({ nodes: [] })
    }))
    expect(await empty.nodes()).toEqual({ status: 'ready', nodes: [] })
  })
})

describe('可选远端运行端与工作区', () => {
  it('offers only runtimes Core actually announces as remote adapters', () => {
    // 即便有人往 descriptor 里塞了 DSH/Pi，也不会变成可选的远端运行端。
    const injected = view({ runtimeDescriptors: [descriptor('pi'), descriptor('codex-cli')] })
    expect(remoteRuntimes(injected)).toEqual(['codex-cli'])
    expect(remoteRuntimes(view())).toEqual(['claude-code-cli', 'codex-cli'])
    expect(remoteRuntimes(null)).toEqual([])
  })

  it('lists workspaces of one node only', () => {
    const service = createExecutionService(recorded(async () => view()).rpc, null)
    expect(service.workspaces(remoteView, 'node-1').map((entry) => entry.workspaceId)).toEqual(['ws-1', 'ws-2'])
    expect(service.workspaces(remoteView, '')).toEqual([])
    expect(service.workspaces(null, 'node-1')).toEqual([])
  })

  it('blocks only what the renderer cannot confirm, never widening Core', () => {
    const service = createExecutionService(recorded(async () => view()).rpc, null)
    const draft = executionTargetDraftFromView(remoteView)
    expect(service.block(null, remoteView, [nodeRecord])).toBe('read-error')
    expect(service.block({ mode: 'local', remote: draft.remote }, remoteView, [nodeRecord])).toBe('')
    expect(service.block(draft, remoteView, [nodeRecord])).toBe('')
    expect(service.block(draft, remoteView, null)).toBe('') // Existing saved target is known; new choices still require node evidence.
    const other = { ...draft, remote: { ...draft.remote!, nodeId: 'node-2', workspaceId: '', workspaceRoot: '' } }
    const ready = { ...other, remote: { ...other.remote, workspaceId: 'ws-9', workspaceRoot: '/srv/ws-9' } }
    expect(service.block(draft, remoteView, [nodeRecord])).toBe('')
    expect(service.block(other, remoteView, [nodeRecord])).toBe('workspace-required')
    // 新选的节点要读到节点列表才算确认；读不到就停在 node-unknown，不猜。
    expect(service.block(ready, remoteView, null)).toBe('node-unknown')
    const homeless = { ...ready, remote: { ...ready.remote, nodeId: 'node-3', workspaceId: '', workspaceRoot: '' } }
    expect(service.block(homeless, remoteView, [nodeRecord])).toBe('no-workspace')
    expect(service.block(draft, view({ runtimeDescriptors: [] }), [nodeRecord])).toBe('adapter-required')
  })

  it('classifies a save failure without ever retrying it', () => {
    const service = createExecutionService(recorded(async () => view()).rpc, null)
    expect(service.failure(nodeFailure('remote_target_revision_conflict'))).toEqual({ kind: 'conflict', code: 'remote_target_revision_conflict' })
    expect(service.failure(nodeFailure('remote_catalog_node_revoked'))).toEqual({ kind: 'rejected', code: 'remote_catalog_node_revoked' })
    expect(service.failure(new Error('network died'))).toEqual({ kind: 'unknown', code: '' })
  })
})

describe('控制器：CAS、冲突与结果不明', () => {
  it('is one shared controller per port, so the fence cannot fork', () => {
    const service = createExecutionService(recorded(async () => view()).rpc, null)
    expect(service.controller()).toBe(service.controller())
  })

  it('sends the server revision and the edited selection, then adopts the receipt', async () => {
    let saved: unknown = null
    const { rpc, calls } = recorded(async (method, params) => {
      if (method === 'members.executionTarget.get') return remoteView
      saved = params
      return { memberId: 'member', revision: 6, selection: { ...remoteSelection, workspaceId: 'ws-2', workspaceRoot: '/srv/ws-2' } }
    })
    const controller = createExecutionService(rpc, null).controller()
    controller.select('member')
    controller.load()
    await tick()
    const draft = controller.getState().members.member.draft!
    controller.edit(setTargetWorkspace(draft, 'ws-2', remoteView))
    expect(controller.getState().members.member.dirty).toBe(true)
    await controller.save()
    expect(saved).toMatchObject({ memberId: 'member', expectedRevision: 5 })
    expect((saved as { selection: { workspaceId: string } }).selection.workspaceId).toBe('ws-2')
    const state = controller.getState().members.member
    expect(state.view?.revision).toBe(6)
    expect(state.dirty).toBe(false)
    expect(state.notice).toEqual({ kind: 'saved' })
    expect(calls.filter((call) => call.method === 'members.executionTarget.save')).toHaveLength(1)
  })

  it('refuses a second submit in the same tick instead of sending twice', async () => {
    const { rpc, calls } = recorded(async () => remoteView)
    const controller = createExecutionService(rpc, null).controller()
    controller.select('member')
    controller.load()
    await tick()
    controller.edit(setTargetWorkspace(controller.getState().members.member.draft!, 'ws-2', remoteView))
    const first = controller.beginSave()
    expect(first).not.toBeNull()
    expect(controller.beginSave()).toBeNull()
    controller.completeSave(first!, { ok: true, receipt: { memberId: 'member', revision: 6, selection: remoteSelection } })
    expect(calls.filter((call) => call.method === 'members.executionTarget.save')).toHaveLength(0)
    expect(controller.getState().members.member.dirty).toBe(false)
  })

  it('a definite rejection stays savable; an unknown outcome locks until a fresh read', async () => {
    let fail: string = 'remote_catalog_node_revoked'
    const { rpc } = recorded(async (method) => {
      if (method === 'members.executionTarget.get') return remoteView
      throw nodeFailure(fail)
    })
    const controller = createExecutionService(rpc, null).controller()
    controller.select('member')
    controller.load()
    await tick()
    controller.edit(setTargetWorkspace(controller.getState().members.member.draft!, 'ws-2', remoteView))
    await controller.save()
    let state = controller.getState().members.member
    expect(state.notice).toEqual({ kind: 'rejected', code: 'remote_catalog_node_revoked' })
    expect(state.unknown).toBe(false)
    expect(state.dirty).toBe(true)

    fail = 'remote_target_unheard_of'
    await controller.save()
    state = controller.getState().members.member
    expect(state.notice).toEqual({ kind: 'unknown' })
    expect(state.unknown).toBe(true)
    // 结果不明时不重发，也不悄悄改成服务器值。
    expect(controller.beginSave()).toBeNull()
    expect(controller.useServer()).toBe(false)

    controller.load()
    await tick()
    state = controller.getState().members.member
    expect(state.unknown).toBe(false)
    expect(state.notice).toEqual({ kind: 'none' })
  })
})

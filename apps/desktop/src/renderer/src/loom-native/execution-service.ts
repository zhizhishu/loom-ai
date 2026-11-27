import type { ExecutionNodeRecord, MissionRecord } from '@contracts'
// 只借类型：ThreadClient 是已认证的 Core 通道，这里不发任何自制 RPC。
import type { ThreadClient } from '../camp-client'
import { readErrorMessage } from '../error-message'
import { nodeErrorCode, type NodeApi } from '../nodes-api'
import {
  ExecutionTargetController,
  EXECUTION_TARGET_ADAPTERS,
  executionTargetBlock,
  executionTargetSaveFailure,
  workspaceChoices,
  type ExecutionTargetAdapterKind,
  type ExecutionTargetBlock,
  type ExecutionTargetDraft,
  type ExecutionTargetReceipt,
  type ExecutionTargetSaveFailure,
  type ExecutionTargetSelection,
  type ExecutionTargetView,
  type ExecutionTargetWorkspace
} from '../member-execution-target-model'

/**
 * 「助手在哪台机器上跑」的数据层：运行位置读写 + 一次远端工作区准备 + 节点列表读。
 *
 * 它不持有第二份状态。CAS（expectedRevision）、冲突/结果不明栅栏、脏比较
 * 全部留在纯 ExecutionTargetController 里，这里只是把网络接到它身上。
 *
 * 三件事故意不做：
 * 1. 不轮询节点：间隔由界面自己决定（NODE_LIST_POLL_MS 在 nodes-api.ts）。
 * 2. 没有节点通道就说「读不到」，不说「离线」。
 * 3. 这份 Core 没有屏幕/电脑控制接口，所以这里也不提供任何屏幕控制器。
 */

export type ExecutionRpc = Pick<ThreadClient, 'request'>

/** 一次节点列表读。unavailable 是「不知道」，不是「没有节点」，更不是「离线」。 */
export type ExecutionNodeListRead =
  | { status: 'ready', nodes: readonly ExecutionNodeRecord[] }
  | { status: 'unavailable', code: string }

export type ExecutionSaveInput = {
  memberId: string
  expectedRevision: number
  selection: ExecutionTargetSelection | null
}

/**
 * The admitted remote workspace prepare. The Host reads the Mission's own Thread
 * itself, so `campId` is never the browser's to name.
 */
export type PrepareRemoteWorkspaceInput = {
  missionId: string
  nodeId: string
  sourceRoot: string
}

/** The workspace projection `POST /api/v1/nodes/workspaces` also returns. */
export type PrepareRemoteWorkspaceReceipt = {
  missionId: string
  campId: string
  nodeId: string
  ownerName: string
  ownerRole: string
  worktree: string
  source: string
  branch: string
  baseSha: string | null
}

export class ExecutionRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ExecutionRequestError'
  }
}

function requestCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code
  return ''
}

function asExecutionError(error: unknown): ExecutionRequestError {
  if (error instanceof ExecutionRequestError) return error
  return new ExecutionRequestError(requestCode(error), readErrorMessage(error, '运行位置读取失败'))
}

/** 远端只认 Core 实际宣告的那几个运行端；没宣告的一律不出现。 */
export function remoteRuntimes(view: ExecutionTargetView | null): ExecutionTargetAdapterKind[] {
  if (!view) return []
  const announced = new Set(view.runtimeDescriptors.map((descriptor) => descriptor.adapterKind))
  return EXECUTION_TARGET_ADAPTERS.filter((kind) => announced.has(kind))
}

export type ExecutionService = {
  read(memberId: string): Promise<ExecutionTargetView>
  save(input: ExecutionSaveInput): Promise<ExecutionTargetReceipt>
  prepareRemote(input: PrepareRemoteWorkspaceInput): Promise<PrepareRemoteWorkspaceReceipt>
  /** The Mission this Thread is, or `null` when the Thread has none. */
  missionOfThread(threadId: string | null): Promise<string | null>
  nodes(): Promise<ExecutionNodeListRead>
  workspaces(view: ExecutionTargetView | null, nodeId: string): ExecutionTargetWorkspace[]
  runtimes(view: ExecutionTargetView | null): ExecutionTargetAdapterKind[]
  block(
    draft: ExecutionTargetDraft | null,
    view: ExecutionTargetView | null,
    nodes: readonly ExecutionNodeRecord[] | null
  ): ExecutionTargetBlock
  failure(error: unknown): ExecutionTargetSaveFailure
  controller(): ExecutionTargetController
}

/**
 * 把已认证的 Core 通道和（可缺的）节点通道绑成一个端口。
 * nodes 为 null 表示这份宿主根本没暴露节点通道，读节点一律 unavailable。
 */
export function createExecutionService(rpc: ExecutionRpc, nodes: NodeApi | null): ExecutionService {
  const read = (memberId: string): Promise<ExecutionTargetView> =>
    rpc.request<ExecutionTargetView>('members.executionTarget.get', { memberId })
      .catch((error: unknown) => { throw asExecutionError(error) })

  const save = (input: ExecutionSaveInput): Promise<ExecutionTargetReceipt> =>
    rpc.request<ExecutionTargetReceipt>('members.executionTarget.save', {
      memberId: input.memberId,
      expectedRevision: input.expectedRevision,
      selection: input.selection
    }).catch((error: unknown) => { throw asExecutionError(error) })

  /** One prepare on one node. It creates the workspace; it never saves a target. */
  const prepareRemote = (input: PrepareRemoteWorkspaceInput): Promise<PrepareRemoteWorkspaceReceipt> =>
    rpc.request<PrepareRemoteWorkspaceReceipt>('missions.workspace.prepareRemote', {
      missionId: input.missionId,
      nodeId: input.nodeId,
      sourceRoot: input.sourceRoot
    }).catch((error: unknown) => {
      throw new ExecutionRequestError(requestCode(error), readErrorMessage(error, '准备工作区没有完成'))
    })

  /** A Thread is a Mission's Thread only when Core already says so; never inferred. */
  const missionOfThread = async (threadId: string | null): Promise<string | null> => {
    if (!threadId) return null
    const missions = await rpc.request<readonly MissionRecord[]>('missions.list')
      .catch((error: unknown) => { throw asExecutionError(error) })
    return missions?.find((mission) => mission.threadId === threadId)?.missionId ?? null
  }

  let shared: ExecutionTargetController | null = null

  return {
    read,
    save,
    prepareRemote,
    missionOfThread,
    async nodes() {
      if (!nodes) return { status: 'unavailable', code: 'nodes_unavailable' }
      try {
        return { status: 'ready', nodes: (await nodes.list()).nodes }
      } catch (error) {
        return { status: 'unavailable', code: nodeErrorCode(error) }
      }
    },
    workspaces: (view, nodeId) => workspaceChoices(view, nodeId),
    runtimes: (view) => remoteRuntimes(view),
    block: (draft, view, records) => draft ? executionTargetBlock(draft, view, records) : 'read-error',
    failure: (error) => executionTargetSaveFailure(error),
    /** 一个端口一个控制器：冲突/不明栅栏只有一份，不会被读两遍。 */
    controller() {
      shared ??= new ExecutionTargetController({ get: read, save })
      return shared
    }
  }
}

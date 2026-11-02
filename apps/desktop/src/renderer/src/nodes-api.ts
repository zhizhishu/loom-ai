import type {
  ExecutionNodeList,
  ExecutionNodePairing,
  ExecutionNodeRevocation,
  NodeChannelApi,
  NodeChannelResult,
  NodeOutputPage
} from '@contracts'

/** Renderer-facing node API. Web calls the session directly; Desktop unwraps the Main envelope. */
export interface NodeApi {
  list(): Promise<ExecutionNodeList>
  pair(): Promise<ExecutionNodePairing>
  revoke(nodeId: string): Promise<ExecutionNodeRevocation>
  output(runId: string, from: number): Promise<NodeOutputPage>
}

export function nodeFailure(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string }
  error.code = code
  return error
}

export function nodeErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return 'nodes_unreadable'
}

function unwrap<T>(result: NodeChannelResult<T>): T {
  if (!result.ok) throw nodeFailure(result.code)
  return result.value
}

export function nodeApiFromChannel(channel: NodeChannelApi | undefined): NodeApi {
  return {
    async list() {
      if (!channel) throw nodeFailure('nodes_unavailable')
      return unwrap(await channel.list())
    },
    async pair() {
      if (!channel) throw nodeFailure('nodes_unavailable')
      return unwrap(await channel.pair())
    },
    async revoke(nodeId) {
      if (!channel) throw nodeFailure('nodes_unavailable')
      return unwrap(await channel.revoke(nodeId))
    },
    async output(runId, from) {
      if (!channel) throw nodeFailure('nodes_unavailable')
      return unwrap(await channel.output(runId, from))
    }
  }
}

export const NODE_LIST_POLL_MS = 5000

/**
 * Desktop Main talks to the already-running Web server as an administrator.
 * The renderer receives node rows and pairing codes, never the administrator
 * token or a node token.
 */

export type NodeCore = {
  request(method: 'host.web.status' | 'host.web.token', params?: unknown): Promise<unknown>
}

export type NodeFetch = (input: string, init?: RequestInit) => Promise<Response>

export type NodeSession = { origin: string; token: string }

export type NodeChannelSession = { current: NodeSession | null }

type StatusShape = {
  enabled?: boolean
  listen?: string
  origin?: string
  addresses?: { origin: string }[]
}

const HOST_WEB_PROTOCOL_VERSION = 5

export class NodeChannelError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export function isNodeId(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
}

export function nodeOrigin(status: StatusShape): string | null {
  const addresses = status.addresses ?? []
  const loopback = addresses.find(item => {
    try {
      const host = new URL(item.origin).hostname
      return host === '127.0.0.1' || host === '::1' || host === 'localhost'
    } catch {
      return false
    }
  })
  if (loopback) return loopback.origin.replace(/\/$/, '')
  if (status.origin && /^https?:\/\//.test(status.origin)) return status.origin.replace(/\/$/, '')
  if (status.listen && !status.listen.startsWith('0.0.0.0:') && !status.listen.startsWith('[::]:')) {
    return `http://${status.listen}`
  }
  const first = addresses[0]?.origin
  return first ? first.replace(/\/$/, '') : null
}

function errorCode(body: unknown, status: number): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const code = (body as { error?: { code?: unknown } }).error?.code
    if (typeof code === 'string' && code.length > 0 && code.length < 80) return code
  }
  return status === 401 ? 'session_required' : 'nodes_unavailable'
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

async function ensureSession(core: NodeCore, session: NodeChannelSession, fetchImpl: NodeFetch): Promise<NodeSession> {
  const status = await core.request('host.web.status') as StatusShape
  if (!status || status.enabled !== true) throw new NodeChannelError('nodes_unavailable')
  const origin = nodeOrigin(status)
  if (!origin) throw new NodeChannelError('nodes_unavailable')
  if (session.current?.origin === origin) return session.current
  const credential = await core.request('host.web.token') as { administratorToken?: unknown }
  const administratorToken = credential?.administratorToken
  if (typeof administratorToken !== 'string' || administratorToken.length === 0) {
    throw new NodeChannelError('nodes_unavailable')
  }
  const response = await fetchImpl(`${origin}/api/v1/login`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: HOST_WEB_PROTOCOL_VERSION, administratorToken })
  })
  const body = await readJson(response)
  if (!response.ok) throw new NodeChannelError(errorCode(body, response.status))
  const token = body && typeof body === 'object' ? (body as { token?: unknown }).token : undefined
  if (typeof token !== 'string' || token.length === 0) throw new NodeChannelError('nodes_unavailable')
  session.current = { origin, token }
  return session.current
}

export function isRunId(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value)
}

export async function nodeChannelCall(
  core: NodeCore,
  session: NodeChannelSession,
  operation: 'list' | 'pair' | 'revoke' | 'output',
  nodeId: string | undefined,
  fetchImpl: NodeFetch,
  output?: { runId: string; from: number }
): Promise<{ ok: true; value: unknown } | { ok: false; code: string }> {
  if (operation === 'revoke' && !isNodeId(nodeId)) return { ok: false, code: 'node_not_found' }
  if (operation === 'output' && (!isRunId(output?.runId) || !Number.isInteger(output?.from) || (output?.from ?? 0) < 1)) {
    return { ok: false, code: 'node_run_not_found' }
  }
  let authed: NodeSession
  try {
    authed = await ensureSession(core, session, fetchImpl)
  } catch (error) {
    session.current = null
    return { ok: false, code: error instanceof NodeChannelError ? error.code : 'nodes_unavailable' }
  }
  const path = operation === 'list'
    ? '/api/v1/nodes'
    : operation === 'pair'
      ? '/api/v1/nodes/pair'
      : operation === 'output'
        ? `/api/v1/nodes/runs/${output?.runId}/output/${output?.from}`
        : `/api/v1/nodes/${nodeId}/revoke`
  const request = (token: string) => fetchImpl(`${authed.origin}${path}`, {
    method: operation === 'list' || operation === 'output' ? 'GET' : 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
  })
  try {
    let response = await request(authed.token)
    if (response.status === 401) {
      session.current = null
      authed = await ensureSession(core, session, fetchImpl)
      response = await request(authed.token)
    }
    const body = await readJson(response)
    if (!response.ok) return { ok: false, code: errorCode(body, response.status) }
    return { ok: true, value: body }
  } catch (error) {
    session.current = null
    return { ok: false, code: error instanceof NodeChannelError ? error.code : 'nodes_unavailable' }
  }
}

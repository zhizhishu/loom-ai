import { describe, expect, it } from 'vitest'
import { isNodeId, nodeChannelCall, nodeOrigin, type NodeChannelSession, type NodeCore, type NodeFetch } from './node-channel'

const status = {
  enabled: true,
  listen: '127.0.0.1:8767',
  addresses: [{ origin: 'http://127.0.0.1:8767' }, { origin: 'http://10.0.0.8:8767' }]
}

function core(enabled = true): NodeCore {
  return {
    async request(method) {
      if (method === 'host.web.status') return enabled ? status : { enabled: false, sessions: 0 }
      if (method === 'host.web.token') return { administratorToken: 'a'.repeat(64) }
      throw new Error(method)
    }
  }
}

describe('desktop node channel', () => {
  it('prefers the loopback origin', () => {
    expect(nodeOrigin(status)).toBe('http://127.0.0.1:8767')
    expect(nodeOrigin({ enabled: true, listen: '0.0.0.0:8767', addresses: [{ origin: 'http://10.0.0.8:8767' }] })).toBe('http://10.0.0.8:8767')
    expect(isNodeId('node_abc-1')).toBe(true)
    expect(isNodeId('../etc')).toBe(false)
  })

  it('logs in once and reuses the session for list, pair, and revoke', async () => {
    const calls: string[] = []
    const fetchImpl: NodeFetch = async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${input}`)
      const url = String(input)
      if (url.endsWith('/api/v1/login')) {
        const body = JSON.parse(String(init?.body))
        expect(body.administratorToken).toBe('a'.repeat(64))
        expect(body.protocolVersion).toBe(5)
        return Response.json({ token: 'session-token' })
      }
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer session-token')
      if (url.endsWith('/api/v1/nodes')) return Response.json({ nodes: [] })
      if (url.endsWith('/api/v1/nodes/pair')) return Response.json({ pairingCode: 'same-code', expiresInSeconds: 500, connectUrl: 'ws://127.0.0.1:8767/api/v1/nodes/connect' })
      if (url.endsWith('/api/v1/nodes/node_desk/revoke')) return Response.json({ nodeId: 'node_desk', revokedAt: '2026-11-01T10:19:00.000Z', status: 'offline' })
      return new Response(JSON.stringify({ error: { code: 'missing' } }), { status: 404 })
    }
    const session: NodeChannelSession = { current: null }
    const listed = await nodeChannelCall(core(), session, 'list', undefined, fetchImpl)
    const paired = await nodeChannelCall(core(), session, 'pair', undefined, fetchImpl)
    const revoked = await nodeChannelCall(core(), session, 'revoke', 'node_desk', fetchImpl)
    expect(listed).toEqual({ ok: true, value: { nodes: [] } })
    expect(paired.ok && paired.value).toMatchObject({ pairingCode: 'same-code' })
    expect(revoked.ok && revoked.value).toMatchObject({ nodeId: 'node_desk' })
    expect(calls.filter(call => call.includes('/login'))).toHaveLength(1)
    expect(calls.some(call => call.includes('administratorToken'))).toBe(false)
  })

  it('reports a closed web service without calling login', async () => {
    const fetchImpl: NodeFetch = async () => {
      throw new Error('should not fetch')
    }
    const result = await nodeChannelCall(core(false), { current: null }, 'list', undefined, fetchImpl)
    expect(result).toEqual({ ok: false, code: 'nodes_unavailable' })
  })

  it('refreshes the session after a 401 and surfaces node errors', async () => {
    let logins = 0
    const fetchImpl: NodeFetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/login')) {
        logins += 1
        return Response.json({ token: `session-${logins}` })
      }
      if (logins === 1) return new Response(JSON.stringify({ error: { code: 'session_required' } }), { status: 401 })
      return new Response(JSON.stringify({ error: { code: 'node_not_revocable' } }), { status: 409 })
    }
    const result = await nodeChannelCall(core(), { current: null }, 'revoke', 'node_local', fetchImpl)
    expect(result).toEqual({ ok: false, code: 'node_not_revocable' })
    expect(logins).toBe(2)
    expect(await nodeChannelCall(core(), { current: null }, 'revoke', '../secret', fetchImpl)).toEqual({ ok: false, code: 'node_not_found' })
  })
})

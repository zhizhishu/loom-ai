import { afterEach, expect, it, vi } from 'vitest'
import { ConsoleClient } from './client'

afterEach(() => vi.unstubAllGlobals())

it('calls the node list, pair, and revoke routes with the browser session', async () => {
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
  vi.stubGlobal('sessionStorage', storage)
  vi.stubGlobal('localStorage', storage)
  const calls: string[] = []
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    const address = String(url)
    calls.push(`${options?.method ?? 'GET'} ${address}`)
    if (address.endsWith('/api/v1/login')) {
      return Response.json({ protocolVersion: 5, token: 'a'.repeat(64), clientId: 'd'.repeat(64), editorProof: 'e'.repeat(64), ownerId: 'local_user' })
    }
    expect(new Headers(options?.headers).get('Authorization')).toBe(`Bearer ${'a'.repeat(64)}`)
    if (address.endsWith('/api/v1/nodes')) return Response.json({ nodes: [{ nodeId: 'node_local', displayName: 'loom-a', role: 'local', revocable: false, status: 'online', os: null, arch: null, pairedAt: '2026-11-01T00:00:00.000Z', revokedAt: null, lastHeartbeat: null, activeRunCount: 0, activeRuns: [], clis: [] }] })
    if (address.endsWith('/api/v1/nodes/pair')) return Response.json({ pairingCode: 'same-code', expiresInSeconds: 600, connectUrl: 'ws://127.0.0.1:8767/api/v1/nodes/connect' })
    if (address.endsWith('/api/v1/nodes/node_desk/revoke')) return Response.json({ nodeId: 'node_desk', revokedAt: '2026-11-01T10:19:00.000Z', status: 'offline' })
    return new Response(JSON.stringify({ error: { code: 'missing' } }), { status: 404 })
  })
  const client = new ConsoleClient('http://127.0.0.1:8767', fetcher)
  await client.login('b'.repeat(64))
  try {
    expect((await client.listNodes()).nodes[0]?.displayName).toBe('loom-a')
    expect(await client.pairNode()).toMatchObject({ pairingCode: 'same-code' })
    expect(await client.revokeNode('node_desk')).toMatchObject({ status: 'offline' })
    expect(calls).toContain('GET http://127.0.0.1:8767/api/v1/nodes')
    expect(calls).toContain('POST http://127.0.0.1:8767/api/v1/nodes/pair')
    expect(calls).toContain('POST http://127.0.0.1:8767/api/v1/nodes/node_desk/revoke')
  } finally {
    client.clear()
  }
})

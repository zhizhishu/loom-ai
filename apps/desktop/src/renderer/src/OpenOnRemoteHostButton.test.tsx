import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RemoteHostApi } from '@contracts'
import { OpenOnRemoteHostButton, remoteHostOffer } from './OpenOnRemoteHostButton'

const api: RemoteHostApi = {
  list: async () => ({ ok: true, value: [] }),
  add: async () => ({ ok: false, code: 'remote_host_failed' }),
  remove: async () => ({ ok: true, value: [] }),
  open: async () => ({ ok: true, value: null })
}
const bero = { id: 'host-bero-0001', label: 'bero', origin: 'https://loom-bero.example.ts.net' }
const office = { id: 'host-office-01', label: 'office', origin: 'http://100.64.0.8:8767' }

describe('open on remote host offer', () => {
  it('offers nothing without the Desktop bridge or saved hosts', () => {
    expect(remoteHostOffer(null, [bero])).toEqual({ kind: 'none' })
    expect(remoteHostOffer(api, [])).toEqual({ kind: 'none' })
  })

  it('opens the only host directly and lists several in a menu', () => {
    expect(remoteHostOffer(api, [bero])).toEqual({ kind: 'direct', host: bero })
    expect(remoteHostOffer(api, [bero, office])).toEqual({ kind: 'menu', hosts: [bero, office] })
  })

  it('renders nothing before the list arrives and on Web', () => {
    expect(renderToStaticMarkup(<OpenOnRemoteHostButton api={api} />)).toBe('')
    expect(renderToStaticMarkup(<OpenOnRemoteHostButton api={null} />)).toBe('')
  })
})

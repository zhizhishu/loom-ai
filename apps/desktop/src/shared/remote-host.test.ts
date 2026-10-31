import { describe, expect, it } from 'vitest'
import { REMOTE_HOST_LIMIT, remoteHostAllowsNavigation, remoteHostLabel, remoteHostOrigin, sanitizeRemoteHosts } from './remote-host'

describe('remote host origin', () => {
  it('accepts http(s) Server roots and reduces them to the origin', () => {
    expect(remoteHostOrigin(' https://loom-bero.tail1234.ts.net/ ')).toEqual({ origin: 'https://loom-bero.tail1234.ts.net' })
    expect(remoteHostOrigin('http://100.64.0.7:8767')).toEqual({ origin: 'http://100.64.0.7:8767' })
    expect(remoteHostOrigin('HTTPS://Example.COM')).toEqual({ origin: 'https://example.com' })
  })

  it('refuses everything that is not a bare Server root', () => {
    expect(remoteHostOrigin('')).toEqual({ error: 'remote_host_url_invalid' })
    expect(remoteHostOrigin('example.com')).toEqual({ error: 'remote_host_url_protocol' })
    expect(remoteHostOrigin('file:///etc/passwd')).toEqual({ error: 'remote_host_url_protocol' })
    expect(remoteHostOrigin('javascript:alert(1)')).toEqual({ error: 'remote_host_url_protocol' })
    expect(remoteHostOrigin('https://user:pass@example.com')).toEqual({ error: 'remote_host_url_credentials' })
    expect(remoteHostOrigin('https://example.com/login')).toEqual({ error: 'remote_host_url_path' })
    expect(remoteHostOrigin('https://example.com/?token=abc')).toEqual({ error: 'remote_host_url_path' })
    expect(remoteHostOrigin('https://example.com/#token')).toEqual({ error: 'remote_host_url_path' })
    expect(remoteHostOrigin('https://exa mple.com')).toEqual({ error: 'remote_host_url_invalid' })
  })
})

describe('remote host list', () => {
  it('keeps only well-formed unique entries up to the limit', () => {
    const hosts = sanitizeRemoteHosts({ hosts: [
      { id: 'host-0001', label: ' bero ', origin: 'https://loom.example.com' },
      { id: 'host-0001', label: 'duplicate id', origin: 'https://other.example.com' },
      { id: 'host-0002', label: 'duplicate origin', origin: 'https://loom.example.com' },
      { id: 'host-0003', label: 'path smuggled', origin: 'https://evil.example.com/x' },
      { id: 'BAD', label: 'bad id', origin: 'https://x.example.com' },
      'nonsense',
      { id: 'host-0004', label: '', origin: 'http://100.64.0.7:8767' }
    ] })
    expect(hosts).toEqual([
      { id: 'host-0001', label: 'bero', origin: 'https://loom.example.com' },
      { id: 'host-0004', label: '100.64.0.7:8767', origin: 'http://100.64.0.7:8767' }
    ])
    const many = { hosts: Array.from({ length: REMOTE_HOST_LIMIT + 4 }, (_, index) => ({
      id: `host-${String(index).padStart(4, '0')}`, label: '', origin: `https://h${index}.example.com`
    })) }
    expect(sanitizeRemoteHosts(many)).toHaveLength(REMOTE_HOST_LIMIT)
    expect(sanitizeRemoteHosts(null)).toEqual([])
  })

  it('labels fall back to the host and drop control characters', () => {
    expect(remoteHostLabel('\u0007 远端\n', 'https://a.example.com')).toBe('远端')
    expect(remoteHostLabel('   ', 'https://a.example.com:8443')).toBe('a.example.com:8443')
  })
})

describe('remote host navigation', () => {
  it('stays on the entry origin', () => {
    expect(remoteHostAllowsNavigation('https://loom.example.com', 'https://loom.example.com/api/v1/login')).toBe(true)
    expect(remoteHostAllowsNavigation('https://loom.example.com', 'https://loom.example.com.evil.net/')).toBe(false)
    expect(remoteHostAllowsNavigation('https://loom.example.com', 'http://loom.example.com/')).toBe(false)
    expect(remoteHostAllowsNavigation('https://loom.example.com', 'not a url')).toBe(false)
  })
})

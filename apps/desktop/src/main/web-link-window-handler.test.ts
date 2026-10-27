import { expect, it, vi } from 'vitest'
import { webLinkWindowHandler } from './web-link-window-handler'
import { openWebLink } from '../renderer/src/WebLink'

it('opens HTTP/HTTPS once without changing ports, parameters or fragments', async () => {
  const open = vi.fn(async () => {})
  const failed = vi.fn(async () => {})
  const handler = webLinkWindowHandler(open, failed)
  for (const url of ['http://localhost:8766/a?x=1&y=2#part', 'http://192.168.1.5:8080/a', 'https://example.com/a']) {
    expect(handler({ url })).toEqual({ action: 'deny' })
    expect(open).toHaveBeenLastCalledWith(url)
  }
  for (const url of ['www.example.com', 'file:///tmp/a', 'javascript:alert(1)', 'https://', 'http://a\nb']) handler({ url })
  expect(open).toHaveBeenCalledTimes(3)
  await Promise.resolve()
  expect(failed).not.toHaveBeenCalled()
})

it.each(['throw', 'reject'])('reports a confirmed %s once in the launching process', async (mode) => {
  const open = vi.fn(() => { if (mode === 'throw') throw new Error('launch'); return Promise.reject(new Error('launch')) })
  const failed = vi.fn(async () => {})
  webLinkWindowHandler(open, failed)({ url: 'http://localhost:8766/a' })
  await Promise.resolve(); await Promise.resolve()
  expect(open).toHaveBeenCalledTimes(1)
  expect(failed).toHaveBeenCalledTimes(1)
})

it('Web null/noopener is not an error, while an explicit exception is reported without retry', () => {
  const open = vi.fn(() => null)
  vi.stubGlobal('window', { open })
  try {
    const failed = vi.fn()
    openWebLink('http://localhost:3000/a?x=1#part', failed)
    expect(open).toHaveBeenCalledExactlyOnceWith('http://localhost:3000/a?x=1#part', '_blank', 'noopener,noreferrer')
    expect(failed).not.toHaveBeenCalled()
    open.mockImplementation(() => { throw new Error('blocked') })
    openWebLink('https://example.com', failed)
    expect(open).toHaveBeenCalledTimes(2)
    expect(failed).toHaveBeenCalledExactlyOnceWith('无法打开链接，请重试或复制地址。')
  } finally { vi.unstubAllGlobals() }
})

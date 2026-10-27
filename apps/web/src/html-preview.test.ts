import { webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrowserHtmlPreview } from './html-preview'
import type { ConsoleClient } from './client'
import { validPreviewOrigin } from '../../../packages/html-preview/src/protocol'

afterEach(() => vi.unstubAllGlobals())
it('injects the shared bridge into authorized HTML without resaving source or including editing credentials', async () => {
  vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) })
  vi.stubGlobal('location', { origin: 'http://192.168.1.2:8766' })
  const original = '<!doctype html><html><head><title>中文</title></head><body><h1>页面</h1><script>window.works=true</script></body></html>'
  const files = vi.fn().mockResolvedValue({ ok: true, value: { text: original, contentGeneration: 'g', contentVersion: { size: original.length, mtimeMs: 1 } } })
  const result = await createBrowserHtmlPreview({ files } as unknown as ConsoleClient, { handleId: 'handle-not-for-the-frame', expectedGeneration: 'g' })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const preview = result.value
  expect(validPreviewOrigin(preview, location.origin)).toBe(true)
  expect(files).toHaveBeenCalledExactlyOnceWith('readHtml', { handleId: 'handle-not-for-the-frame', expectedGeneration: 'g' })
  const tag = /<script src="(data:text\/javascript;base64,[^"]+)" data-rovai-preview-diagnostic><\/script>/u.exec(preview.sandboxedDocument!)!
  expect(preview.sandboxedDocument!.replace(tag[0], '')).toBe(original)
  const script = new TextDecoder().decode(Uint8Array.from(atob(tag[1].split(',')[1]), ch => ch.charCodeAt(0)))
  const config = JSON.parse(/\)\((\{"previewId".*?\}),function/u.exec(script)![1])
  expect(config.map.length).toBe(tag[0].length)
  expect(config.browserDocument).toBe(true)
  expect(config.origin).toBe(location.origin)
  expect(preview.origin).toBe(location.origin)
  expect(preview.sandboxedDocument).not.toContain('handle-not-for-the-frame')
  expect(preview.entryUrl).not.toContain('handle-not-for-the-frame')
})

it('does not produce a preview from a failed or stale generation-bound read', async () => {
  const failure = { ok: false, error: { code: 'source_not_authorized', message: 'expired', retryable: true } }
  const files = vi.fn().mockResolvedValue(failure)
  const transport = { files } as unknown as ConsoleClient
  await expect(createBrowserHtmlPreview(transport, { handleId: 'h', expectedGeneration: 'g' })).resolves.toEqual(failure)
  files.mockResolvedValue({ ok: true, value: { text: 'stale', contentGeneration: 'old', contentVersion: {} } })
  await expect(createBrowserHtmlPreview(transport, { handleId: 'h', expectedGeneration: 'g' })).resolves.toMatchObject({ ok: false, error: { code: 'read_failed' } })
})

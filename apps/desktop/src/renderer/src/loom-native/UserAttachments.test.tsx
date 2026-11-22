import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ThreadMessageAttachmentView } from '@contracts'
import { MessageAttachments, PendingAttachments, addPickedAttachments, pasteAttachments } from './UserAttachments'

const render = (el: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(el)
const attachment = (over: Partial<ThreadMessageAttachmentView> = {}): ThreadMessageAttachmentView => ({
  id: 'a1', displayName: 'photo.png', kind: 'file', fileCount: null,
  mediaType: 'image/png', byteSize: 327_680, previewKind: 'image', availability: 'available', ...over
})

/** Mikka `components/chat/chat-file-cards.tsx` + `components/motion/attachment-upload.tsx` `ImageThumbnail`. */
describe('pending attachments in the native composer', () => {
  it('lists every held file with its name, type and size, and a remove action', () => {
    const files = [
      new File(['abc'], 'photo.png', { type: 'image/png' }),
      new File(['defgh'], 'notes.md', { type: 'text/markdown' })
    ]
    const html = render(createElement(PendingAttachments, { files, onRemove: () => {} }))
    expect(html).toContain('role="group"')
    expect(html).toContain('aria-label="待发送附件"')
    expect(html).toContain('photo.png')
    expect(html).toContain('PNG · 1 KB')
    expect(html).toContain('notes.md')
    expect(html).toContain('MD · 1 KB')
    expect(html).toContain('aria-label="移除photo.png"')
    expect(html).toContain('aria-label="移除notes.md"')
  })

  it('keeps the type glyph until a picture can be decoded, never a broken image', () => {
    const html = render(createElement(PendingAttachments, {
      files: [new File(['abc'], 'photo.png', { type: 'image/png' })], onRemove: () => {}
    }))
    expect(html).not.toContain('<img')
    expect(html).toContain('class="ln-attachment-thumb is-image"')
  })

  it('renders nothing when the composer holds no file', () => {
    expect(render(createElement(PendingAttachments, { files: [], onRemove: () => {} }))).toBe('')
  })

  it('appends a pasted picture instead of replacing the strip', () => {
    const held = new File(['old'], 'notes.md', { type: 'text/markdown' })
    const pasted = new File(['png'], 'shot.png', { type: 'image/png' })
    let next: File[] = []
    expect(pasteAttachments({ files: [pasted] as unknown as FileList }, [held], files => { next = files })).toBe(true)
    expect(next).toEqual([held, pasted])
  })

  it('leaves a pasted paragraph to the textarea', () => {
    let called = false
    expect(pasteAttachments({ files: [] as unknown as FileList }, [], () => { called = true })).toBe(false)
    expect(called).toBe(false)
  })

  it('appends the picked files', () => {
    const held = new File(['old'], 'notes.md', { type: 'text/markdown' })
    const picked = new File(['pdf'], 'report.pdf', { type: 'application/pdf' })
    let next: File[] = []
    addPickedAttachments([picked] as unknown as FileList, [held], files => { next = files })
    expect(next).toEqual([held, picked])
  })
})

describe('attachments a sent message carries', () => {
  const view = (attachments: ThreadMessageAttachmentView[]): string => render(createElement(MessageAttachments, {
    attachments, threadId: 'th', messageId: 'm1', onOpen: () => {}
  }))

  it('shows an image attachment with its thumbnail slot, name, type and size', () => {
    const html = view([attachment()])
    expect(html).toContain('class="ln-file-card is-image"')
    expect(html).toContain('class="ln-attachment-thumb is-image"')
    expect(html).toContain('aria-label="预览附件 photo.png"')
    expect(html).toContain('<strong>photo.png</strong>')
    expect(html).toContain('<small>PNG · 320 KB</small>')
  })

  it('shows a file attachment as a card with the type icon and the size line', () => {
    const html = view([attachment({ id: 'a2', displayName: 'report.pdf', mediaType: 'application/pdf', previewKind: 'none', byteSize: 1024 })])
    expect(html).toContain('class="ln-file-card"')
    expect(html).toContain('aria-label="打开附件 report.pdf"')
    expect(html).toContain('<small>PDF · 1 KB</small>')
  })

  it('never offers a missing or unreadable file as openable', () => {
    const missing = view([attachment({ availability: 'missing' })])
    expect(missing).toContain('class="ln-file-card is-image is-unavailable"')
    expect(missing).toContain('disabled')
    expect(missing).toContain('文件已不可用')
    const unreadable = view([attachment({ id: 'a3', previewKind: 'none', availability: 'unreadable' })])
    expect(unreadable).toContain('文件无法读取')
  })

  it('names a pasted block as 粘贴内容 instead of guessing its extension', () => {
    const html = view([attachment({
      id: 'a4', displayName: 'pasted-1.txt', mediaType: 'text/plain', previewKind: 'none', pastedTextPreview: '第一行'
    })])
    expect(html).toContain('<strong>第一行</strong>')
    expect(html).toContain('<small>粘贴内容</small>')
  })

  it('renders nothing for a message without attachments', () => {
    expect(view([])).toBe('')
  })
})

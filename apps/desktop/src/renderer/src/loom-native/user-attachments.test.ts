import { describe, expect, it } from 'vitest'
import {
  USER_ATTACHMENT_ACCEPT, clipboardAttachmentFiles, formatUserAttachmentSize, listedAttachmentFiles,
  messageAttachmentCards, pendingAttachmentViews, previewImageBlob, supportedUserAttachment,
  userAttachmentAvailabilityLabel, userAttachmentDetail, userAttachmentKind
} from './user-attachments'

/** Mikka `packages/protocol/src/chat-attachments.ts` + `components/chat/chat-file-cards.tsx`, as LOOM copies them. */
const attachment = (over: Partial<Parameters<typeof messageAttachmentCards>[0][number]> = {}) => ({
  id: 'a1', displayName: 'photo.png', kind: 'file' as const, fileCount: null,
  mediaType: 'image/png', byteSize: 327_680, previewKind: 'image' as const,
  availability: 'available' as const, ...over
})

describe('user attachment helpers', () => {
  it('offers the same file kinds the upstream picker accepts', () => {
    for (const extension of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'docx', 'md', 'ts', 'mp3', 'wav']) {
      expect(USER_ATTACHMENT_ACCEPT).toContain(`.${extension}`)
    }
    expect(USER_ATTACHMENT_ACCEPT.endsWith(',text/*')).toBe(true)
    expect(supportedUserAttachment('notes.md')).toBe(true)
    expect(supportedUserAttachment('scan.pdf', 'application/pdf')).toBe(true)
    expect(supportedUserAttachment('notes', 'text/plain')).toBe(true)
    expect(supportedUserAttachment('payload.exe', 'application/x-msdownload')).toBe(false)
  })

  it('names the kind from the media type, and falls back to the extension', () => {
    expect(userAttachmentKind('photo.png', 'image/png')).toBe('image')
    expect(userAttachmentKind('voice.m4a', 'audio/mp4')).toBe('audio')
    expect(userAttachmentKind('photo.png', '')).toBe('image')
    expect(userAttachmentKind('voice.wav', 'application/octet-stream')).toBe('audio')
    expect(userAttachmentKind('report.pdf', 'application/pdf')).toBe('file')
    // A media type that contradicts the name keeps the media type: the type is what the projection says.
    expect(userAttachmentKind('photo.png', 'application/pdf')).toBe('file')
  })

  it('prints KB below a megabyte and one decimal above it, never a zero-size file', () => {
    expect(formatUserAttachmentSize(1)).toBe('1 KB')
    expect(formatUserAttachmentSize(2048)).toBe('2 KB')
    expect(formatUserAttachmentSize(327_680)).toBe('320 KB')
    expect(formatUserAttachmentSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatUserAttachmentSize(3_276_800)).toBe('3.1 MB')
    expect(formatUserAttachmentSize(null)).toBe('大小未知')
  })

  it('writes the upstream `TYPE · size` description line', () => {
    expect(userAttachmentDetail('photo.png', 327_680)).toBe('PNG · 320 KB')
    // Upstream prints `name.split('.').at(-1)` in capitals, so a dotless name prints itself.
    expect(userAttachmentDetail('no-extension', 1024)).toBe('NO-EXTENSION · 1 KB')
    expect(userAttachmentDetail('trailing.', 1024)).toBe('文件 · 1 KB')
    expect(userAttachmentDetail('report.pdf', null)).toBe('PDF · 大小未知')
  })

  it('keeps the availability problem where upstream shows it', () => {
    expect(userAttachmentAvailabilityLabel('available')).toBeNull()
    expect(userAttachmentAvailabilityLabel('unknown')).toBeNull()
    expect(userAttachmentAvailabilityLabel('missing')).toBe('文件已不可用')
    expect(userAttachmentAvailabilityLabel('unreadable')).toBe('文件无法读取')
    expect(userAttachmentAvailabilityLabel('kind_changed')).toBe('文件类型已变化')
  })

  it('keeps each pending file as its own row, picture only where it has one', () => {
    const first = new File(['abc'], 'photo.png', { type: 'image/png' })
    const second = new File(['defgh'], 'notes.md', { type: 'text/markdown' })
    const rows = pendingAttachmentViews([first, second], ['blob:first'])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ name: 'photo.png', kind: 'image', detail: 'PNG · 1 KB', previewUrl: 'blob:first' })
    expect(rows[1]).toMatchObject({ name: 'notes.md', kind: 'file', detail: 'MD · 1 KB', previewUrl: null })
    expect(rows[0].key).not.toBe(rows[1].key)
  })

  it('reads a sent attachment through the projection, not the extension', () => {
    const [image] = messageAttachmentCards([attachment()])
    expect(image).toMatchObject({ kind: 'image', title: 'photo.png', detail: 'PNG · 320 KB', image: true, unavailable: false })

    const [sentAsFile] = messageAttachmentCards([attachment({ previewKind: 'none' })])
    expect(sentAsFile.image).toBe(false)

    const [gone] = messageAttachmentCards([attachment({ availability: 'missing' })])
    expect(gone).toMatchObject({ detail: '文件已不可用', unavailable: true })

    const [pasted] = messageAttachmentCards([attachment({
      displayName: 'pasted-1.txt', mediaType: 'text/plain', previewKind: 'none', pastedTextPreview: '第一行'
    })])
    expect(pasted).toMatchObject({ title: '第一行', detail: '粘贴内容', image: false })

    const [folder] = messageAttachmentCards([attachment({
      displayName: 'src', kind: 'directory', fileCount: 12, mediaType: 'inode/directory', previewKind: 'none', byteSize: 2048
    })])
    expect(folder).toMatchObject({ kind: 'file', detail: '12 个文件 · 2 KB', image: false })
  })

  it('takes clipboard files only, so a copied paragraph stays a paragraph', () => {
    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    expect(clipboardAttachmentFiles({ files: [file] as unknown as FileList })).toEqual([file])
    expect(clipboardAttachmentFiles({ files: null })).toEqual([])
    expect(clipboardAttachmentFiles(null)).toEqual([])
    expect(listedAttachmentFiles([file] as unknown as FileList)).toEqual([file])
    expect(listedAttachmentFiles(null)).toEqual([])
  })

  it('turns either preview shape into one blob of its own type', () => {
    const bytes = new Blob(['png'])
    const fromBytes = previewImageBlob({ mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) })
    expect(fromBytes.type).toBe('image/png')
    expect(fromBytes.size).toBe(3)
    const fromBlob = previewImageBlob({ blob: bytes })
    expect(fromBlob).toBe(bytes)
  })
})

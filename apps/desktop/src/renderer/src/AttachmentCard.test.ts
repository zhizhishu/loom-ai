import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ThreadMessageAttachmentView, LocalAttachmentOwnerLocator } from '@contracts'
import { AttachmentCard } from './AttachmentCard'
import { changeInterfaceLanguage } from './interface-language'
import { languageTestApi } from './interface-language-test-api'

vi.mock('./FilePreviewContext', () => ({
  useOptionalFilePreview: () => ({ open: vi.fn() })
}))

const fileAttachment: ThreadMessageAttachmentView = {
  id: 'attachment-1',
  displayName: 'report.md',
  kind: 'file',
  fileCount: 1,
  mediaType: 'text/markdown',
  byteSize: 128,
  previewKind: 'none',
  availability: 'available'
}

const composerLocators: Array<[string, LocalAttachmentOwnerLocator, boolean]> = [[
  'Thread composer',
  { owner: 'composer', threadId: 'camp-1', attachmentRefId: fileAttachment.id },
  true
], [
  'single-chat composer',
  {
    owner: 'single_chat_composer',
    threadId: 'camp-1',
    conversationId: 'conversation-1',
    attachmentRefId: fileAttachment.id
  },
  false
]]

describe('AttachmentCard composer actions', () => {
  it('shows escaped pasted content and a localized label while preserving file identity in every presentation', async () => {
    try {
      for (const [language, label, empty] of [['zh-CN', '粘贴内容', '空白文本'], ['en', 'Pasted text', 'Whitespace only']] as const) {
        await changeInterfaceLanguage(languageTestApi, language)
        for (const presentation of ['composer', 'user-timeline', 'agent-timeline'] as const) {
          for (const pastedTextPreview of ['# Claude Code <script>', '']) {
            const markup = renderToStaticMarkup(createElement(AttachmentCard, {
              attachment: { ...fileAttachment, displayName: '粘贴内容-1.txt', pastedTextPreview },
              locator: { owner: 'composer', threadId: 'camp-1', attachmentRefId: fileAttachment.id },
              presentation
            }))
            expect(markup).toContain(pastedTextPreview ? '# Claude Code &lt;script&gt;' : empty)
            expect(markup).toContain(`<small>${label}</small>`)
            expect(markup).toContain('粘贴内容-1.txt')
            expect(markup).not.toContain('file-extension-label')
          }
        }
      }
    } finally { await changeInterfaceLanguage(languageTestApi, 'zh-CN') }
  })

  it.each(composerLocators)('exposes preview and applicable context actions in the %s', (_name, locator, hasContextMenu) => {
    const markup = renderToStaticMarkup(createElement(AttachmentCard, {
      attachment: fileAttachment,
      locator,
      presentation: 'composer'
    }))

    expect(markup).toMatch(/<button class="attachment-open(?: [^"]*)?"/)
    expect(markup).toContain('aria-label="打开文件预览 report.md"')
    expect(markup.includes('attachment-context-anchor')).toBe(hasContextMenu)
  })

  it('exposes a primary open button for a composer directory', () => {
    const directoryAttachment: ThreadMessageAttachmentView = {
      ...fileAttachment,
      id: 'attachment-directory',
      displayName: 'research',
      kind: 'directory',
      fileCount: 3,
      mediaType: 'inode/directory'
    }
    const markup = renderToStaticMarkup(createElement(AttachmentCard, {
      attachment: directoryAttachment,
      locator: {
        owner: 'composer',
        threadId: 'camp-1',
        attachmentRefId: directoryAttachment.id
      },
      presentation: 'composer'
    }))

    expect(markup).toMatch(/<button class="attachment-open(?: [^"]*)?"/)
    expect(markup).toContain('aria-label="打开文件夹 research"')
    expect(markup).toContain('attachment-context-anchor')
  })

  it.each(composerLocators)('keeps a loading image focusable without falling back to a file action in the %s', (_name, locator) => {
    const imageAttachment: ThreadMessageAttachmentView = {
      ...fileAttachment,
      id: 'attachment-image',
      displayName: 'diagram.png',
      mediaType: 'image/png',
      previewKind: 'image'
    }
    const markup = renderToStaticMarkup(createElement(AttachmentCard, {
      attachment: imageAttachment,
      locator: { ...locator, attachmentRefId: imageAttachment.id },
      presentation: 'composer'
    }))

    expect(markup).toMatch(/<button class="attachment-open(?: [^"]*)?"/)
    expect(markup).toContain('aria-label="预览附件 diagram.png"')
    expect(markup).toContain('aria-disabled="true"')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).not.toContain('attachment-context-anchor')
  })
})

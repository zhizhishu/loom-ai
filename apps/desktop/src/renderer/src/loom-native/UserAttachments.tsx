import { useEffect, useState } from 'react'
import type { LocalAttachmentOwnerLocator, ThreadMessageAttachmentView } from '@contracts'
import { Icon } from './icons'
import {
  clipboardAttachmentFiles, listedAttachmentFiles, messageAttachmentCard, pendingAttachmentViews, previewImageBlob,
  userAttachmentKind, type UserAttachmentKind
} from './user-attachments'

/**
 * Counterpart of Mikka `components/chat/chat-file-cards.tsx` (the cards the composer and a
 * sent message draw) plus `components/motion/attachment-upload.tsx` `ImageThumbnail` (the
 * picture a pending image shows instead of a file glyph).
 *
 * LOOM has no chat-attachment upload route of its own, so the two places differ from
 * upstream only where the bytes come from: a pending file is a local `File` (its object
 * URL is the thumbnail), and a sent attachment is read back through the Core attachment
 * preview the caller passes in (`loadPreview` → `client.composerAttachments.preview`).
 * No marker syntax, no upload progress, no retry toast — see `user-attachments.ts`.
 */
export type AttachmentPreviewLoader = (
  locator: LocalAttachmentOwnerLocator
) => Promise<{ mediaType: string; bytes: Uint8Array } | { blob: Blob } | null>

/** Upstream `ImageThumbnail`: a small square picture; a file that cannot decode keeps the glyph. */
function AttachmentThumbnail({ url, kind }: { url: string | null; kind: UserAttachmentKind }) {
  return <span className={`ln-attachment-thumb is-${kind}`} aria-hidden="true">
    {url ? <img src={url} alt=""/> : <Icon name={kind} size={20}/>}
  </span>
}

/**
 * The pending strip: one row per file the composer still holds, with its picture, its name,
 * its type and size, and the remove action. Upstream removes by attachment id (the
 * server owns the bytes); here the row removes the `File` itself, so the send keeps
 * exactly the files the strip shows.
 */
export function PendingAttachments({ files, onRemove }: {
  files: File[]
  onRemove(files: File[]): void
}) {
  const [urls, setUrls] = useState<readonly (string | null)[]>([])
  useEffect(() => {
    if (typeof URL.createObjectURL !== 'function') { setUrls([]); return }
    const created: string[] = []
    const next = files.map(file => {
      if (userAttachmentKind(file.name, file.type) !== 'image') return null
      const url = URL.createObjectURL(file)
      created.push(url)
      return url
    })
    setUrls(next)
    return () => { for (const url of created) URL.revokeObjectURL(url) }
  }, [files])
  const items = pendingAttachmentViews(files, urls)
  if (!items.length) return null
  return <div className="ln-pending-files" role="group" aria-label="待发送附件">
    {items.map((item, index) => <span className="ln-pending-attachment" key={item.key}>
      <AttachmentThumbnail url={item.previewUrl} kind={item.kind}/>
      <span className="ln-pending-attachment-copy">
        <strong title={item.name}>{item.name}</strong>
        <small>{item.detail}</small>
      </span>
      <button type="button" aria-label={`移除${item.name}`} title={`移除${item.name}`}
        onClick={() => onRemove(files.filter((_, position) => position !== index))}><Icon name="close" size={12}/></button>
    </span>)}
  </div>
}

function MessageAttachment({ attachment, threadId, messageId, loadPreview, onOpen }: {
  attachment: ThreadMessageAttachmentView
  threadId: string
  messageId: string
  loadPreview?: AttachmentPreviewLoader
  onOpen(attachmentId: string): void
}) {
  const card = messageAttachmentCard(attachment)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const canPreview = card.image && !card.unavailable && Boolean(loadPreview)
  useEffect(() => {
    if (!canPreview || !loadPreview) return
    let active = true
    let objectUrl: string | null = null
    setUrl(null)
    setFailed(false)
    void loadPreview({ owner: 'message', threadId, messageId, attachmentRefId: attachment.id })
      .then(preview => {
        if (!active) return
        if (!preview) { setFailed(true); return }
        objectUrl = URL.createObjectURL(previewImageBlob(preview))
        setUrl(objectUrl)
      })
      .catch(() => { if (active) setFailed(true) })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment.id, canPreview, loadPreview, messageId, threadId])
  const thumbnail = card.image && canPreview && !failed ? url : null
  return <button type="button" className={`ln-file-card${card.image ? ' is-image' : ''}${card.unavailable ? ' is-unavailable' : ''}`}
    disabled={card.unavailable} aria-busy={card.image && canPreview && !url && !failed ? true : undefined}
    aria-label={card.image ? `预览附件 ${attachment.displayName}` : `打开附件 ${attachment.displayName}`}
    title={attachment.displayName} onClick={() => onOpen(attachment.id)}>
    <AttachmentThumbnail url={thumbnail} kind={card.image ? 'image' : card.kind}/>
    <span><strong>{card.title}</strong><small>{card.detail}</small></span>
    <Icon name="right" size={14}/>
  </button>
}

/**
 * The attachments a message carries: upstream's `ChatFileCards sent` — picture first
 * when the projection says it is an image, then the name and `TYPE · size` line that
 * a sent file card shows.
 */
export function MessageAttachments({ attachments, threadId, messageId, loadPreview, onOpen }: {
  attachments: ThreadMessageAttachmentView[]
  threadId: string
  messageId: string
  loadPreview?: AttachmentPreviewLoader
  onOpen(attachmentId: string): void
}) {
  if (!attachments.length) return null
  return <div className="ln-message-files">
    {attachments.map(attachment => <MessageAttachment key={attachment.id} attachment={attachment}
      threadId={threadId} messageId={messageId} loadPreview={loadPreview} onOpen={onOpen}/>)}
  </div>
}

/** Upstream `onPaste`: only a paste that carries files takes over the event. */
export function pasteAttachments(
  clipboard: { files?: FileList | null } | null | undefined,
  files: File[],
  onFiles: (files: File[]) => void
): boolean {
  const pasted = clipboardAttachmentFiles(clipboard)
  if (!pasted.length) return false
  onFiles([...files, ...pasted])
  return true
}

/** Upstream `fileInput.onFiles`: the picker appends, it never replaces the strip. */
export function addPickedAttachments(
  list: FileList | null | undefined,
  files: File[],
  onFiles: (files: File[]) => void
): void {
  const picked = listedAttachmentFiles(list)
  if (!picked.length) return
  onFiles([...files, ...picked])
}

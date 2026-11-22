import type { AttachmentPreview, LocalAttachmentAvailability, ThreadMessageAttachmentView } from '@contracts'

/**
 * Counterpart of Mikka `packages/protocol/src/chat-attachments.ts`,
 * `components/chat/use-chat-files.ts` and `components/chat/chat-file-cards.tsx`.
 *
 * The accept list, the extension groups, the file-card title/detail copy and the
 * image/audio/file icon choice are upstream values, copied so the two chat
 * composers offer the same files. LOOM has no chat-attachment upload endpoint of
 * its own: the bytes travel through the existing Core composer-attachment path
 * (`client.composerAttachments.prepare`), and a sent attachment is read back
 * through `client.composerAttachments.preview` — so nothing here invents a route,
 * a marker syntax (`[mikka-file:…]`) or an upload state machine.
 *
 * Documented degradations (no new dependency, no new endpoint):
 * - Upstream keeps attachment references inside the draft text and uploads them one
 *   by one with per-file progress/retry. LOOM's Core path stages the files at send
 *   and keeps them in the local draft, so the pending strip has no `uploading` /
 *   `processing` / retry state; a failure surfaces as the send error the composer
 *   already shows.
 * - Upstream rejects oversized/unsupported files when they are added. LOOM keeps the
 *   picker's `accept` filter and leaves the count cap to the existing send path
 *   (`MAX_LOCAL_COMPOSER_ATTACHMENTS`), which already refuses the eleventh file.
 */

/** Mikka `CHAT_FILE_MAX_BYTES` / `CHAT_FILE_MAX_COUNT` (`packages/protocol/src/chat-attachments.ts`). */
export const USER_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024
export const USER_ATTACHMENT_MAX_COUNT = 10

const TEXT_EXTENSIONS =
  'txt md markdown mdx rst csv tsv json jsonl ndjson yaml yml toml xml html htm css scss sass less log js jsx ts tsx mjs cjs mts cts py ipynb go rs java rb sh bash zsh fish sql c h cc cpp cxx hpp cs swift kt kts scala php vue svelte dart ex exs erl hs lua pl r jl tex ini cfg conf properties diff patch graphql gql proto dockerfile makefile env gitignore gitconfig editorconfig'
export const USER_TEXT_EXTENSIONS = new Set(TEXT_EXTENSIONS.split(' '))
export const USER_DOCUMENT_EXTENSIONS = new Set('pdf docx xlsx xls pptx odt ods odp rtf epub'.split(' '))
export const USER_IMAGE_EXTENSIONS = new Set('png jpg jpeg webp gif'.split(' '))
export const USER_AUDIO_EXTENSIONS = new Set('wav mp3 mpeg oga ogg flac aac m4a webm mp4 pcm'.split(' '))

/** Upstream `CHAT_FILE_ACCEPT`, so both composers' pickers offer the same kinds of file. */
export const USER_ATTACHMENT_ACCEPT =
  [...USER_TEXT_EXTENSIONS, ...USER_DOCUMENT_EXTENSIONS, ...USER_IMAGE_EXTENSIONS, ...USER_AUDIO_EXTENSIONS]
    .map(extension => `.${extension}`)
    .join(',') + ',text/*'

export type UserAttachmentKind = 'image' | 'audio' | 'file'

/** Upstream `fileExtension` + `supportedChatFile`, with the kind the card icon needs. */
export function userAttachmentExtension(name: string): string {
  return name.toLowerCase().split('.').at(-1) ?? ''
}

export function supportedUserAttachment(name: string, mediaType = ''): boolean {
  const extension = userAttachmentExtension(name)
  return mediaType.startsWith('text/')
    || USER_TEXT_EXTENSIONS.has(extension)
    || USER_DOCUMENT_EXTENSIONS.has(extension)
    || USER_IMAGE_EXTENSIONS.has(extension)
    || USER_AUDIO_EXTENSIONS.has(extension)
}

/** Upstream picks `Image` / `AudioLines` / `FileText` in `chat-file-cards.tsx`; the media type wins, the extension decides when it is missing. */
export function userAttachmentKind(name: string, mediaType: string | null = ''): UserAttachmentKind {
  const type = (mediaType ?? '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('audio/')) return 'audio'
  const extension = userAttachmentExtension(name)
  if (type === '' || type === 'application/octet-stream') {
    if (USER_IMAGE_EXTENSIONS.has(extension)) return 'image'
    if (USER_AUDIO_EXTENSIONS.has(extension)) return 'audio'
  }
  return 'file'
}

/** Upstream `chat-file-cards.tsx`: `ceil(size / 1024)` KB below a megabyte, one decimal above it. */
export function formatUserAttachmentSize(byteSize: number | null): string {
  if (byteSize === null || !Number.isFinite(byteSize) || byteSize < 0) return '大小未知'
  return byteSize < 1024 * 1024 ? `${Math.ceil(byteSize / 1024)} KB` : `${(byteSize / 1024 / 1024).toFixed(1)} MB`
}

/** Upstream `FileExtensionLabel`: the extension in capitals, `文件` when there is none. */
export function userAttachmentFormat(name: string): string {
  const extension = userAttachmentExtension(name)
  return extension === '' ? '文件' : extension.toUpperCase()
}

/** Upstream `AttachmentDescription`: `TYPE · size`. */
export function userAttachmentDetail(name: string, byteSize: number | null): string {
  return `${userAttachmentFormat(name)} · ${formatUserAttachmentSize(byteSize)}`
}

/** Upstream shows the availability problem instead of the type line, never a size that pretends to be readable. */
export function userAttachmentAvailabilityLabel(availability: LocalAttachmentAvailability): string | null {
  if (availability === 'missing') return '文件已不可用'
  if (availability === 'unreadable') return '文件无法读取'
  if (availability === 'kind_changed') return '文件类型已变化'
  return null
}

/** One card in the pending strip: upstream's media + title + description + remove action. */
export type PendingAttachmentView = {
  key: string
  name: string
  detail: string
  kind: UserAttachmentKind
  previewUrl: string | null
}

/** A local file the composer is still holding: no type line can lie, the size comes from the File itself. */
export function pendingAttachmentViews(
  files: readonly File[],
  previewUrls: readonly (string | null)[] = []
): PendingAttachmentView[] {
  return files.map((file, index) => ({
    key: `${file.name}:${file.size}:${file.lastModified}:${index}`,
    name: file.name,
    detail: userAttachmentDetail(file.name, file.size),
    kind: userAttachmentKind(file.name, file.type),
    previewUrl: previewUrls[index] ?? null
  }))
}

/** One card in a message: what was sent, with the thumbnail an image attachment can show. */
export type MessageAttachmentCard = {
  attachment: ThreadMessageAttachmentView
  kind: UserAttachmentKind
  title: string
  detail: string
  image: boolean
  unavailable: boolean
}

export function messageAttachmentCard(attachment: ThreadMessageAttachmentView): MessageAttachmentCard {
  const unavailableLabel = userAttachmentAvailabilityLabel(attachment.availability)
  const directory = attachment.kind === 'directory'
  const pastedText = !directory && typeof attachment.pastedTextPreview === 'string'
  return {
    attachment,
    kind: directory ? 'file' : userAttachmentKind(attachment.displayName, attachment.mediaType),
    title: pastedText ? attachment.pastedTextPreview || '空白文本' : attachment.displayName,
    detail: unavailableLabel
      ?? (pastedText
        ? '粘贴内容'
        : directory
          ? `${attachment.fileCount === null ? '文件数未知' : `${attachment.fileCount} 个文件`} · ${formatUserAttachmentSize(attachment.byteSize)}`
          : userAttachmentDetail(attachment.displayName, attachment.byteSize)),
    // Upstream trusts the projection's `previewKind`; a MIME sniff here would be a second truth.
    image: attachment.previewKind === 'image',
    unavailable: attachment.availability === 'missing' || attachment.availability === 'unreadable'
  }
}

export function messageAttachmentCards(attachments: readonly ThreadMessageAttachmentView[]): MessageAttachmentCard[] {
  return attachments.map(messageAttachmentCard)
}

/** Upstream `onPaste` reads the clipboard files, not the clipboard text. */
export function clipboardAttachmentFiles(data: { files?: FileList | null } | null | undefined): File[] {
  return data?.files ? Array.from(data.files) : []
}

/** Upstream `fileInput.onFiles` appends the picked files to the ones already chosen. */
export function listedAttachmentFiles(list: FileList | null | undefined): File[] {
  return list ? Array.from(list) : []
}

/** Upstream `AttachmentCard` turns either preview shape into one Blob. */
export function previewImageBlob(preview: AttachmentPreview | { blob: Blob }): Blob {
  if ('blob' in preview) return preview.blob
  return new Blob([Uint8Array.from(preview.bytes).buffer], { type: preview.mediaType })
}

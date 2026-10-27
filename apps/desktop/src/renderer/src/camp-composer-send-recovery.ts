import type { ThreadComposerDraftView } from '@contracts'
import { emptyLocalThreadComposerDraft, loadLocalThreadComposerDraft, saveLocalThreadComposerDraft } from './camp-composer-local-store'

type Recovery = { submitted: unknown; previous: ThreadComposerDraftView; next: ThreadComposerDraftView }
const listeners = new Set<(recovery: Recovery) => void>()

export function onLocalThreadSendRecovered(listener: (recovery: Recovery) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Compare owned submission data, independent of JSON property ordering. Local
// availability/probe metadata and the draft revision are not part of the command.
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => equal(value, right[index]))
  if (!object(left) || !object(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]))
}

export function localDraftMatchesSubmission(draft: ThreadComposerDraftView, submitted: unknown): boolean {
  if (!object(submitted) || submitted.threadId !== draft.threadId) return false
  let content = draft.content
  // Sending materializes a continuation recipient without rewriting the saved
  // editor document. Accept only that exact materialization as an alternative.
  if (!equal(content, submitted.content) && draft.continuationIntent && !draft.replyIntent
    && !content.segments.some(segment => segment.kind === 'atom' && ['member', 'all_members'].includes(segment.atom.type))) {
    content = { version: 2, segments: [
      { kind: 'atom', atom: { type: 'member', agentId: draft.continuationIntent.recipient.agentId } },
      { kind: 'text', text: ' ' }, ...content.segments
    ] }
  }
  return equal(content, submitted.content)
    && equal(draft.quotes, submitted.quotes)
    && (draft.replyIntent?.replyToThreadMessageId ?? null) === submitted.replyToThreadMessageId
    && equal(draft.attachments.map(attachment => ({
      id: attachment.id, sourcePath: attachment.sourcePath, displayName: attachment.displayName,
      kind: attachment.kind, mediaType: attachment.mediaType, observedByteSize: attachment.byteSize,
      ...(attachment.pastedTextPreview !== undefined ? { pastedTextPreview: attachment.pastedTextPreview } : {})
    })), submitted.sourceAttachments)
}

/** Settles restored sends only. Live send promises retain the normal Composer path. */
export function recoverLocalThreadSend(submitted: unknown, result: unknown, storage?: Parameters<typeof loadLocalThreadComposerDraft>[1]): void {
  if (!object(submitted) || typeof submitted.threadId !== 'string' || !object(result)
    || !object(result.commandResult) || result.commandResult.status !== 'applied') return
  const previous = loadLocalThreadComposerDraft(submitted.threadId, storage)
  if (!previous || !localDraftMatchesSubmission(previous, submitted)) return
  const next = emptyLocalThreadComposerDraft(previous.threadId, previous.revision + 1, previous.continuationIntent)
  saveLocalThreadComposerDraft(next, storage)
  // Storage alone cannot update an already-mounted Lexical editor. Notify its
  // coordinator synchronously before recovery releases the interaction gate.
  for (const listener of listeners) listener({ submitted, previous, next })
}

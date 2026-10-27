import type { ThreadComposerDraftView, ThreadMessageView, ComposerDocument } from '@contracts'
import { PendingThreadDraftPersistence } from './pending-thread-draft'
import { describe, expect, it, vi } from 'vitest'
import {
  DraftMutationCoordinator,
  draftCoordinatorChangeRefreshesProjection,
  StaleDraftEpochError,
  type DraftMutation
} from './draft-mutation-coordinator'

function document(text: string): ComposerDocument {
  return {
    version: 2,
    segments: text ? [{ kind: 'text', text }] : []
  }
}

function draft(threadId: string, revision: number, text = ''): ThreadComposerDraftView {
  return {
    quotes: [],
    threadId,
    body: text,
    content: document(text),
    revision,
    attachments: [],
    replyIntent: null,
    continuationIntent: null,
    updatedAt: null,
    expiresAt: null
  }
}

function message(id: string): ThreadMessageView {
  return { id } as ThreadMessageView
}

describe('DraftMutationCoordinator', () => {
  it('publishes each locally accepted attachment mutation and its completion only once', async () => {
    const changed = vi.fn()
    const accepted = vi.fn()
    const coordinator = new DraftMutationCoordinator({
      load: async () => draft('active', 1),
      mutate: async (current, mutation) => {
        const next = { ...current, revision: current.revision + 1 }
        if (mutation.kind === 'add_source_attachment' || mutation.kind === 'remove_source_attachment') {
          mutation.onAccepted?.(next)
        }
        return next
      },
      onChange: changed
    })
    coordinator.beginEpoch('active', draft('active', 1))
    changed.mockClear()
    await coordinator.addSourceAttachment({ name: 'paste.txt' } as File, { pastedText: true, onAccepted: accepted })
    expect(accepted).toHaveBeenCalledTimes(1)
    expect(changed).toHaveBeenCalledTimes(1)
    await coordinator.removeSourceAttachment('attachment', true, accepted)
    expect(accepted).toHaveBeenCalledTimes(2)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(coordinator.getCurrentDraft()?.revision).toBe(3)
  })

  it('retains an accepted attachment when Pending presence fails, including later edits', async () => {
    let saved = draft('pending', 1)
    const persistence = new PendingThreadDraftPersistence({
      request: vi.fn().mockRejectedValue(new Error('presence offline'))
    }, next => { saved = next })
    const attachment = {
      id: '11111111-1111-4111-8111-111111111111', displayName: '粘贴内容-1.txt',
      kind: 'file' as const, mediaType: 'text/plain', byteSize: 10_001,
      fileCount: 1, previewKind: 'none' as const, availability: 'available' as const
    }
    const coordinator = new DraftMutationCoordinator({
      load: async () => { await persistence.persist(saved); return saved },
      mutate: async (current, mutation) => {
        const next = {
          ...current, revision: current.revision + 1,
          attachments: mutation.kind === 'add_source_attachment' ? [...current.attachments, attachment] : current.attachments,
          content: mutation.kind === 'save_content' ? mutation.content : current.content
        }
        await persistence.persist(next, mutation.kind === 'add_source_attachment' ? () => mutation.onAccepted?.(next) : undefined)
        return next
      }
    })
    coordinator.beginEpoch('pending', saved)
    const accepted = vi.fn()
    await expect(coordinator.addSourceAttachment({ name: attachment.displayName } as File, { pastedText: true, onAccepted: accepted })).rejects.toThrow('presence offline')
    expect(accepted).toHaveBeenCalledOnce()
    expect(coordinator.getCurrentDraft()?.attachments).toEqual([attachment])
    await expect(coordinator.saveContent(document('typed later'))).rejects.toThrow('presence offline')
    expect(saved.attachments).toEqual([attachment])
    expect(saved.content).toEqual(document('typed later'))
  })

  it('does not mark an attachment accepted when local Pending storage rejects it', async () => {
    const persistence = new PendingThreadDraftPersistence({ request: vi.fn() }, () => { throw new Error('storage full') })
    const coordinator = new DraftMutationCoordinator({
      load: async () => draft('pending', 1),
      mutate: async (current, mutation) => {
        await persistence.persist(current, mutation.kind === 'add_source_attachment' ? () => mutation.onAccepted?.(current) : undefined)
        return current
      }
    })
    coordinator.beginEpoch('pending', draft('pending', 1))
    const accepted = vi.fn()
    await expect(coordinator.addSourceAttachment({ name: 'paste.txt' } as File, { pastedText: true, onAccepted: accepted })).rejects.toThrow('storage full')
    expect(accepted).not.toHaveBeenCalled()
  })

  it('keeps ordinary content-save acknowledgements out of Workspace projection renders', () => {
    expect(draftCoordinatorChangeRefreshesProjection('save_content')).toBe(false)
    expect(draftCoordinatorChangeRefreshesProjection('add_source_attachment')).toBe(true)
    expect(draftCoordinatorChangeRefreshesProjection('load')).toBe(true)
  })

  it('serializes every mutation against the latest authoritative revision', async () => {
    const calls: Array<{ kind: DraftMutation['kind']; revision: number }> = []
    let releaseAttachment!: () => void
    const attachmentPending = new Promise<void>((resolve) => { releaseAttachment = resolve })
    const coordinator = new DraftMutationCoordinator({
      load: async () => draft('camp-a', 1),
      mutate: async (current, mutation) => {
        calls.push({ kind: mutation.kind, revision: current.revision })
        if (mutation.kind === 'add_source_attachment') await attachmentPending
        return {
          ...current,
          content: mutation.kind === 'save_content' ? mutation.content : current.content,
          revision: current.revision + 1
        }
      }
    })
    coordinator.beginEpoch('camp-a', draft('camp-a', 10, 'old'))

    const attachment = coordinator.addSourceAttachment({ name: 'design.png' } as File)
    const save = coordinator.saveContent(document('new'))
    await Promise.resolve()

    expect(calls).toEqual([{ kind: 'add_source_attachment', revision: 10 }])
    releaseAttachment()
    await Promise.all([attachment, save])

    expect(calls).toEqual([
      { kind: 'add_source_attachment', revision: 10 },
      { kind: 'save_content', revision: 11 }
    ])
    expect(coordinator.getCurrentDraft()).toMatchObject({ revision: 12, content: document('new') })
  })

  it('returns a queued input after earlier saves and fences late results from another Thread', async () => {
    const originalCrypto = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) })
    try {
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const mutations: Array<{ draft: ThreadComposerDraftView; mutation: DraftMutation }> = []
    const coordinator = new DraftMutationCoordinator({
      load: async () => draft('camp-a', 1),
      mutate: async (current, mutation) => {
        mutations.push({ draft: current, mutation })
        if (mutation.kind === 'return_pending_input') await waiting
        return draft(current.threadId, current.revision + 1, mutation.kind === 'return_pending_input' ? 'queued' : 'typed')
      }
    })
    coordinator.beginEpoch('camp-a', draft('camp-a', 1))
    await coordinator.saveContent(document('typed'))
    const returned = coordinator.returnPendingInput('input-b', 3, null)
    await Promise.resolve()
    expect(mutations[1]).toMatchObject({ draft: { revision: 2 }, mutation: {
      kind: 'return_pending_input', pendingInputId: 'input-b', expectedRevision: 3, editToken: null
    } })
    coordinator.beginEpoch('camp-b', draft('camp-b', 4, 'keep this'))
    release()
    await expect(returned).rejects.toBeInstanceOf(StaleDraftEpochError)
    expect(coordinator.getCurrentDraft()).toMatchObject({ threadId: 'camp-b', content: document('keep this') })
    } finally { vi.stubGlobal('crypto', originalCrypto) }
  })

  it('waits for earlier mutations before deciding that a content snapshot is unchanged', async () => {
    const changes: string[] = []
    const mutate = vi.fn(async (current: ThreadComposerDraftView, mutation: DraftMutation) => ({
      ...current,
      revision: current.revision + 1,
      content: mutation.kind === 'save_content' ? mutation.content : current.content
    }))
    const coordinator = new DraftMutationCoordinator({
      load: async () => draft('camp-a', 1),
      mutate,
      onChange: (_draft, _epoch, kind) => changes.push(kind)
    })
    coordinator.beginEpoch('camp-a', draft('camp-a', 4, 'same'))

    const reply = coordinator.startReply(message('message-1'))
    const unchanged = coordinator.saveContent(document('same'))
    await Promise.all([reply, unchanged])

    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate.mock.calls[0]?.[0].revision).toBe(4)
    expect(await coordinator.waitForIdle()).toMatchObject({ revision: 5 })
    expect(changes).toEqual(['begin_epoch', 'start_reply'])
  })

  it('labels content saves separately from projection-changing mutations', async () => {
    const changes: string[] = []
    const coordinator = new DraftMutationCoordinator({
      load: async () => draft('camp-a', 1),
      mutate: async (current, mutation) => ({
        ...current,
        revision: current.revision + 1,
        content: mutation.kind === 'save_content' ? mutation.content : current.content
      }),
      onChange: (_draft, _epoch, kind) => changes.push(kind)
    })
    coordinator.beginEpoch('camp-a', draft('camp-a', 3, 'old'))

    await coordinator.saveContent(document('new'))
    await coordinator.addSourceAttachment({ name: 'notes.txt' } as File)

    expect(changes).toEqual(['begin_epoch', 'save_content', 'add_source_attachment'])
  })

  it('serializes an authoritative reload with mutations that arrive while it is pending', async () => {
    let releaseLoad!: () => void
    const loadPending = new Promise<void>((resolve) => { releaseLoad = resolve })
    const calls: Array<{ kind: 'load' | DraftMutation['kind']; revision?: number }> = []
    const coordinator = new DraftMutationCoordinator({
      load: async () => {
        calls.push({ kind: 'load' })
        await loadPending
        return draft('camp-a', 11, 'remote')
      },
      mutate: async (current, mutation) => {
        calls.push({ kind: mutation.kind, revision: current.revision })
        return { ...current, revision: current.revision + 1 }
      }
    })
    coordinator.beginEpoch('camp-a', draft('camp-a', 10, 'local'))

    const reload = coordinator.load()
    const reply = coordinator.startReply(message('message-1'))
    await Promise.resolve()

    expect(calls).toEqual([{ kind: 'load' }])
    releaseLoad()
    await Promise.all([reload, reply])

    expect(calls).toEqual([
      { kind: 'load' },
      { kind: 'start_reply', revision: 11 }
    ])
    expect(coordinator.getCurrentDraft()).toMatchObject({ revision: 12 })

    // The background reader's acceptance fence runs before onChange/currentDraft.
    const before = coordinator.getCurrentDraft()
    await coordinator.load(() => false)
    expect(coordinator.getCurrentDraft()).toBe(before)
  })

  it('fences late results from an earlier Draft epoch', async () => {
    let releaseOld!: () => void
    const oldPending = new Promise<void>((resolve) => { releaseOld = resolve })
    const coordinator = new DraftMutationCoordinator({
      load: async (threadId) => draft(threadId, 1),
      mutate: async (current) => {
        if (current.threadId === 'camp-a') await oldPending
        return { ...current, revision: current.revision + 1 }
      }
    })
    coordinator.beginEpoch('camp-a', draft('camp-a', 7))
    const oldOperation = coordinator.cancelReply()
    await Promise.resolve()

    coordinator.beginEpoch('camp-b', draft('camp-b', 20))
    releaseOld()

    await expect(oldOperation).rejects.toBeInstanceOf(StaleDraftEpochError)
    expect(coordinator.getCurrentDraft()).toMatchObject({ threadId: 'camp-b', revision: 20 })
  })

  it('refreshes authority after a failed mutation without hiding the original failure', async () => {
    const failure = new Error('revision conflict')
    const load = vi.fn(async () => draft('camp-a', 9, 'remote'))
    const coordinator = new DraftMutationCoordinator({
      load,
      mutate: async () => { throw failure }
    })
    coordinator.beginEpoch('camp-a', draft('camp-a', 8, 'local'))

    await expect(coordinator.removeSourceAttachment('attachment-1')).rejects.toBe(failure)
    expect(load).toHaveBeenCalledWith('camp-a')
    expect(coordinator.getCurrentDraft()).toMatchObject({ revision: 9, body: 'remote' })
  })
})

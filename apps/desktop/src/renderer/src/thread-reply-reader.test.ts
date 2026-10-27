import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThreadReplyPage } from '@contracts'
import type { ThreadClient } from './camp-client'
import { ThreadReplyReader } from './thread-reply-reader'

const page = (messageId = 'a', sequence = 1, watermark = 10): ThreadReplyPage => ({
  schemaVersion: 1, threadId: 't', messageId, rootMessageId: 'root', throughGlobalSequence: watermark,
  sourceAvailable: true, replyCount: 70, hasEarlier: sequence > 1, hasLater: true,
  messages: [{ id: messageId, sequence, version: 1 } as ThreadReplyPage['messages'][number]], runAnchorMessageIds: ['root']
})
const tick = async () => { await vi.advanceTimersByTimeAsync(110) }
const fixture = () => {
  vi.useFakeTimers()
  const request = vi.fn().mockResolvedValue(page())
  const reader = new ThreadReplyReader('t', { request } as unknown as ThreadClient)
  const stop = reader.start()
  return { request, reader, stop }
}
afterEach(() => vi.useRealTimers())

describe('reply page read ownership', () => {
  it('does no closed reads and reuses unchanged pages on re-entry', async () => {
    const { reader, request, stop } = fixture()
    reader.invalidate(); await tick()
    expect(request).not.toHaveBeenCalled()
    reader.open('a'); await tick()
    reader.close(); reader.open('a'); await tick()
    expect(reader.getSnapshot().page?.messages[0].id).toBe('a')
    expect(request).toHaveBeenCalledTimes(1)
    reader.changed({ threadId: 'another', throughGlobalSequence: 20, indexChanged: true }); await tick()
    expect(request).toHaveBeenCalledTimes(1)
    stop()
  })

  it('uses both cursor directions without appending an unbounded rendered history', async () => {
    const { reader, request, stop } = fixture()
    reader.open('a'); await tick()
    request.mockResolvedValue(page('a', 51))
    reader.page(false); await tick()
    expect(request.mock.lastCall?.[1]).toMatchObject({ sequence: 1, before: false, limit: 50 })
    expect(reader.getSnapshot().page?.messages).toHaveLength(1)
    expect(reader.getSnapshot().page?.messages[0].sequence).toBe(51)
    reader.page(true); await tick()
    expect(request.mock.lastCall?.[1]).toMatchObject({ sequence: 51, before: true })
    stop()
  })

  it('coalesces invalidations behind one read and rejects the stale response', async () => {
    const { reader, request, stop } = fixture()
    let resolve!: (value: ThreadReplyPage) => void
    request.mockImplementationOnce(() => new Promise<ThreadReplyPage>(done => { resolve = done }))
    reader.open('a')
    for (let watermark = 11; watermark <= 20; watermark++) reader.changed({ threadId: 't', throughGlobalSequence: watermark, indexChanged: false })
    await tick()
    expect(request).toHaveBeenCalledTimes(1)
    request.mockResolvedValue(page('a', 2, 20))
    resolve(page()); await tick()
    expect(request).toHaveBeenCalledTimes(2)
    expect(reader.getSnapshot().page?.messages[0].sequence).toBe(2)
    stop()
  })

  it('cannot let a previous chain or an unmounted Host publish a late page', async () => {
    const { reader, request, stop } = fixture()
    let resolve!: (value: ThreadReplyPage) => void
    request.mockImplementationOnce(() => new Promise<ThreadReplyPage>(done => { resolve = done }))
    reader.open('a'); reader.open('b')
    request.mockResolvedValue(page('b'))
    resolve(page('a')); await tick()
    expect(reader.getSnapshot().page?.messageId).toBe('b')
    stop(); reader.open('c'); await tick()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('removes unavailable content before refresh and rejects wrong-owner or regressed pages', async () => {
    const { reader, request, stop } = fixture()
    reader.open('a'); await tick()
    reader.changed({ threadId: 't', throughGlobalSequence: 11, indexChanged: false, unavailableMessageIds: ['a'] })
    expect(reader.getSnapshot().page?.messages).toEqual([])
    await tick()
    expect(reader.getSnapshot().status).toBe('error')
    request.mockResolvedValue({ ...page('a', 1, 12), threadId: 'wrong' })
    reader.retry(); await tick()
    expect(reader.getSnapshot().status).toBe('error')
    expect(reader.getSnapshot().page?.messages).toEqual([])
    request.mockResolvedValue(page('a', 2, 12))
    reader.retry(); await tick()
    expect(reader.getSnapshot().status).toBe('ready')
    stop()
  })

  it('refreshes membership only for newly observed Run anchors', async () => {
    const { reader, request, stop } = fixture()
    reader.setRunAnchors(['root']); reader.open('a'); await tick()
    reader.setRunAnchors(['root']); await tick()
    reader.setRunAnchors([]); await tick()
    expect(request).toHaveBeenCalledTimes(1)
    reader.setRunAnchors(['older-unloaded-parent']); await tick()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.lastCall?.[1].runAnchorMessageIds).toEqual(['older-unloaded-parent'])
    stop()
  })
})

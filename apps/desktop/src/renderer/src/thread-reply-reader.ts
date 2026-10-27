import type { ThreadMessageChange, ThreadReplyPage, ThreadReplyPageParams } from '@contracts'
import type { ThreadClient } from './camp-client'

export interface ReplyReaderState {
  messageId: string | null
  page: ThreadReplyPage | null
  status: 'idle' | 'loading' | 'ready' | 'error'
}
type Cursor = { sequence: number; before: boolean }

/** Per-mounted Thread, bounded page cache, one in-flight read plus a coalesced trailing read. */
export class ThreadReplyReader {
  #state: ReplyReaderState = { messageId: null, page: null, status: 'idle' }
  #listeners = new Set<() => void>()
  #cache = new Map<string, ThreadReplyPage>()
  #cursor: Cursor = { sequence: 0, before: false }
  #anchors: string[] = []
  #generation = 0
  #watermark = 0
  #active = false
  #pending = false
  #dirty = false
  #timer: ReturnType<typeof setTimeout> | null = null
  constructor(readonly threadId: string, readonly client: ThreadClient) {}
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
  getSnapshot = (): ReplyReaderState => this.#state
  #set(patch: Partial<ReplyReaderState>): void {
    this.#state = { ...this.#state, ...patch }
    this.#listeners.forEach(listener => listener())
  }
  start(): () => void {
    this.#active = true
    const unsubscribe = [
      this.client.onEvent?.(event => {
        if (event.method === 'thread.messages.changed') this.changed(event.params as ThreadMessageChange)
        if (event.method === 'runtime.state' && (event.params as { status?: string })?.status === 'ready') this.invalidate()
      }),
      this.client.onInvalidated?.(change => {
        if (!change || change.resync) this.invalidate()
        else change.messages?.forEach(message => this.changed(message))
      })
    ]
    if (this.#state.messageId) this.invalidate()
    return () => {
      this.#active = false
      this.#generation++
      if (this.#timer) clearTimeout(this.#timer)
      this.#timer = null
      unsubscribe.forEach(stop => stop?.())
    }
  }
  changed(change: ThreadMessageChange): void {
    if (change.threadId !== this.threadId || change.throughGlobalSequence <= this.#watermark) return
    this.#watermark = change.throughGlobalSequence
    // Hide removed content immediately, before any asynchronous refresh can settle.
    const unavailable = new Set(change.unavailableMessageIds ?? [])
    if (this.#state.page && unavailable.size) this.#set({ page: {
      ...this.#state.page, messages: this.#state.page.messages.filter(message => !unavailable.has(message.id))
    } })
    this.invalidate()
  }
  setRunAnchors(anchors: string[]): void {
    const next = [...new Set(anchors)].sort().slice(0, 96)
    const added = next.some(id => !this.#anchors.includes(id))
    this.#anchors = next
    if (added) this.invalidate()
  }
  invalidate = (): void => {
    this.#cache.clear()
    this.#generation++
    this.#dirty = true
    if (!this.#active || !this.#state.messageId || this.#timer || this.#pending) return
    this.#timer = setTimeout(() => { this.#timer = null; void this.#read() }, 100)
  }
  open = (messageId: string): void => {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#generation++
    this.#cursor = { sequence: 0, before: false }
    this.#set({ messageId, page: null, status: 'loading' })
    const cached = this.#cache.get(this.#key())
    if (cached) { this.#dirty = false; this.#set({ page: cached, status: 'ready' }); return }
    this.#dirty = true
    void this.#read()
  }
  close = (): void => {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#dirty = false
    this.#generation++
    this.#set({ messageId: null, status: 'idle' })
  }
  page = (before: boolean): void => {
    const messages = this.#state.page?.messages
    if (!messages?.length || this.#state.status === 'loading') return
    this.#cursor = { sequence: before ? messages[0].sequence : messages[messages.length - 1].sequence, before }
    this.#generation++
    this.#set({ status: 'loading' })
    const cached = this.#cache.get(this.#key())
    if (cached) { this.#dirty = false; this.#set({ page: cached, status: 'ready' }); return }
    this.#dirty = true
    void this.#read()
  }
  retry = (): void => { this.#dirty = true; void this.#read() }
  #key(): string { return `${this.#state.messageId}:${this.#cursor.before}:${this.#cursor.sequence}` }
  async #read(): Promise<void> {
    if (!this.#active || !this.#state.messageId || this.#pending) return
    this.#pending = true
    this.#dirty = false
    const generation = this.#generation
    const key = this.#key()
    const params: ThreadReplyPageParams = { threadId: this.threadId, messageId: this.#state.messageId,
      ...this.#cursor, limit: 50, runAnchorMessageIds: this.#anchors }
    this.#set({ status: 'loading' })
    try {
      const page = await this.client.request<ThreadReplyPage>('thread.messages.replies', params)
      if (!this.#active || generation !== this.#generation) return
      if (!page || page.schemaVersion !== 1 || page.threadId !== this.threadId || page.messageId !== params.messageId
        || page.throughGlobalSequence < this.#watermark || page.messages.length > 50
        || page.messages.some((message, index) => index > 0 && message.sequence <= page.messages[index - 1].sequence)) throw new Error('Invalid reply page')
      this.#cache.delete(key)
      this.#cache.set(key, page)
      if (this.#cache.size > 8) this.#cache.delete(this.#cache.keys().next().value!)
      this.#set({ page, status: 'ready' })
    } catch {
      if (this.#active && generation === this.#generation) this.#set({ status: 'error' })
    } finally {
      this.#pending = false
      if (this.#dirty && this.#active && this.#state.messageId) void this.#read()
    }
  }
}

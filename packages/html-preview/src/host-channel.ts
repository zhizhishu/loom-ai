import { validPreviewOrigin, type HtmlPreviewDescriptor } from './protocol'

export type HtmlPreviewMessage = Record<string, unknown> & { type: string }

/** Browser-only host transport. A challenge is sent to the current WindowProxy;
 * document IDs alone are never accepted as proof of a current document. */
export class HtmlPreviewHostChannel {
  readonly #listeners = new Set<(message: HtmlPreviewMessage) => void>()
  #connectionId = ''
  #documentId: string | null = null
  #connected = false
  #initialized = false
  constructor(readonly preview: HtmlPreviewDescriptor, readonly frame: () => Window | null) {}
  get connected(): boolean { return this.#connected }
  subscribe(listener: (message: HtmlPreviewMessage) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
  #emit(message: HtmlPreviewMessage): void { this.#listeners.forEach(listener => listener(message)) }
  connect(): void {
    this.#connectionId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''); this.#documentId = null; this.#connected = false
    this.#emit({ type: 'connecting' })
    this.frame()?.postMessage({ protocol: 'rovai-html-preview-v1', previewId: this.preview.previewId,
      generation: this.preview.generation, type: 'connect', connectionId: this.#connectionId }, this.preview.origin)
  }
  send(type: string, data: Record<string, unknown> = {}): void {
    if (!this.#connected) return
    this.frame()?.postMessage({ ...data, protocol: 'rovai-html-preview-v1', previewId: this.preview.previewId,
      generation: this.preview.generation, documentId: this.#documentId, connectionId: this.#connectionId, type }, this.preview.origin)
  }
  attach(host: Window): () => void {
    if (!validPreviewOrigin(this.preview, host.location.origin)) throw new Error('预览站点通信来源无效。')
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source !== this.frame() || event.origin !== this.preview.origin) return
      const data = event.data as Record<string, unknown> | null
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.protocol !== 'rovai-html-preview-v1'
        || data.previewId !== this.preview.previewId || data.generation !== this.preview.generation
        || typeof data.type !== 'string' || typeof data.documentId !== 'string' || !data.documentId || data.documentId.length > 128) return
      if (data.type === 'bootstrap-ready' && this.preview.sandboxedDocument !== undefined) {
        if (this.#initialized) return
        this.#initialized = true
        this.frame()?.postMessage({ protocol: 'rovai-html-preview-v1', type: 'initialize',
          previewId: this.preview.previewId, generation: this.preview.generation, html: this.preview.sandboxedDocument }, this.preview.origin)
        return
      }
      if (data.type === 'hello') { this.connect(); return }
      if (data.connectionId !== this.#connectionId) return
      if (data.type === 'connected') {
        this.#documentId = data.documentId; this.#connected = true
        this.#emit({ type: 'connected', documentId: data.documentId }); return
      }
      if (!this.#connected || data.documentId !== this.#documentId) return
      if (['state', 'diagnostic', 'server-diagnostics', 'find-ready', 'find-invalidated', 'find-open', 'find-close', 'find-document', 'fragment-result', 'reading-position', 'link'].includes(data.type)) this.#emit(data as HtmlPreviewMessage)
    }
    host.addEventListener('message', receive)
    // Wait for the bridge hello or iframe load; the initial about:blank
    // has no preview document or bridge to authenticate.
    this.#emit({ type: 'connecting' })
    return () => { host.removeEventListener('message', receive); this.#connectionId = ''; this.#connected = false; this.#documentId = null }
  }
}

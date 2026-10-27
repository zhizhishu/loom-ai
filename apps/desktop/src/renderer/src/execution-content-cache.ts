/** Shared by a retained Run; full bodies and row state have a separate byte budget. */
export class ExecutionContentCache {
  private entries = new Map<string, { value: unknown; bytes: number }>()
  private pending = new Map<string, Promise<unknown>>()
  onChange: (() => void) | null = null
  bytes = 0
  async load<T>(key: string, request: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key)
    if (cached !== undefined) return cached
    const pending = this.pending.get(key)
    if (pending) return pending as Promise<T>
    const promise = request().then(value => { this.set(key, value); return value })
    this.pending.set(key, promise)
    try { return await promise } finally { if (this.pending.get(key) === promise) this.pending.delete(key) }
  }
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key); this.entries.set(key, entry)
    return entry.value as T
  }
  set(key: string, value: unknown): void {
    this.bytes -= this.entries.get(key)?.bytes ?? 0
    this.entries.delete(key)
    const bytes = JSON.stringify(value)?.length * 2 || 0
    this.entries.set(key, { value, bytes }); this.bytes += bytes
    for (const [oldKey, entry] of this.entries) {
      if (this.entries.size <= 256 && this.bytes <= 8 * 1024 * 1024) break
      this.entries.delete(oldKey); this.bytes -= entry.bytes
    }
    this.onChange?.()
  }
}

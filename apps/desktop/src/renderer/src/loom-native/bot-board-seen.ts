type SeenStorage = Pick<Storage, 'getItem' | 'setItem'>
const prefix = 'loom.board.seen.v1:'
export function readSeen(key: string, storage: SeenStorage = window.localStorage): string | undefined {
  const id = storage.getItem(prefix+key)
  return id || undefined
}
export function markViewed(key: string, id: string, storage: SeenStorage = window.localStorage): void {
  storage.setItem(prefix+key,id)
  if (storage.getItem(prefix+key) !== id) throw new Error('查看标记未能保存。')
}

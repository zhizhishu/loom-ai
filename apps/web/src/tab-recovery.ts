/** Non-secret document leases serialize tab ownership, including copied
 * sessionStorage. IndexedDB transactions work on HTTP LAN origins as well as
 * HTTPS. This lease contains no credentials or editing content; it owns only
 * the tab's editor and drafts, independently from browser authentication. */
const DATABASE = 'rovai-web-tab-owners-v1'
const LIFETIME = 30_000
export const RECOVERY_KEY = 'rovai.web.session.v1'
export interface RecoveryStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

export async function acquireTabRecovery(storage: RecoveryStorage = sessionStorage) {
  const documentId = randomId()
  const oldTabId = storage.getItem('rovai.web.tab.v1')
  let tabId = oldTabId ?? randomId()
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('leases')
    request.onerror = () => reject(new Error('无法准备当前标签页的编辑恢复存储。'))
    request.onsuccess = () => resolve(request.result)
  })
  let active = true
  const lease = (release = false): Promise<boolean> => new Promise((resolve, reject) => {
    const transaction = database.transaction('leases', 'readwrite')
    const store = transaction.objectStore('leases')
    const request = store.get(tabId)
    let accepted = false
    request.onsuccess = () => {
      const current = request.result as { documentId: string; until: number } | undefined
      if (release) { if (current?.documentId === documentId) store.delete(tabId); return }
      const released = localStorage.getItem(`rovai.web.released:${tabId}`)
      if (!current || current.documentId === documentId || current.documentId === released || current.until <= Date.now()) {
        accepted = true; store.put({ documentId, until: Date.now() + LIFETIME }, tabId)
      }
    }
    transaction.oncomplete = () => resolve(accepted)
    transaction.onerror = () => reject(new Error('无法核对当前标签页的编辑归属。'))
    transaction.onabort = transaction.onerror
  })
  let owned = await lease()
  // pagehide releases asynchronously. Give that queued transaction time to finish
  // before classifying a same-tab reload as a copied, still-live tab.
  if (!owned) { await new Promise(resolve => setTimeout(resolve, 150)); owned = await lease() }
  const fork = !owned
  if (fork) { tabId = randomId(); if (!await lease()) throw new Error('无法建立独立标签页。') }
  storage.setItem('rovai.web.tab.v1', tabId)
  const assert = async () => {
    if (!active || !await lease()) throw new Error('此页面的编辑归属已改变，请刷新后恢复。')
  }
  const heartbeat = setInterval(() => { if (active) void lease().then(ok => { if (!ok) active = false }).catch(() => { active = false }) }, 5000)
  const hide = () => {
    active = false
    // Async IDB writes may be abandoned when a document unloads. This synchronous,
    // non-secret release marker lets the next document claim that exact lease.
    localStorage.setItem(`rovai.web.released:${tabId}`, documentId)
    void lease(true)
  }
  const show = () => { void lease().then(ok => { active = ok }) }
  window.addEventListener('pagehide', hide)
  window.addEventListener('pageshow', show)
  return {
    fork, assert,
    close() { clearInterval(heartbeat); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show); hide() }
  }
}

function randomId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** One ordinary Bearer Session lets this browser reopen. Editor proofs, drafts,
 * commands and tab ownership are deliberately absent from durable auth storage. */
export interface BrowserSession {
  version: 1
  origin: string
  token: string
  ownerId: string
  expiresAt: number | null
}
export interface AuthStorage {
  read(): Promise<BrowserSession | null>
  write(session: BrowserSession, expectedToken?: string, current?: () => boolean): Promise<void>
  remove(token: string): Promise<void>
}
export const TAB_AUTH_KEY = 'rovai.web.auth.v1'

let database: Promise<IDBDatabase> | undefined
const openBrowserDatabase = () => database ??= new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open('rovai-web-auth-v1', 1)
  request.onupgradeneeded = () => request.result.createObjectStore('sessions')
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => { database = undefined; reject(new Error('无法打开浏览器登录存储。')) }
})

/** Serialize only active preference writes across tabs. The navigation JSON stays
 * in localStorage; this existing IDB store holds no copy, queue or project data. */
export async function withBrowserPreferenceWrite<T>(scope: string, update: () => T): Promise<T> {
  const db = await openBrowserDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('sessions', 'readwrite')
    const request = transaction.objectStore('sessions').get(`presentation:${scope}`)
    let result: T
    let failure: unknown
    request.onsuccess = () => {
      try { result = update() } catch (error) { failure = error; transaction.abort() }
    }
    transaction.oncomplete = () => resolve(result)
    transaction.onerror = transaction.onabort = () => reject(failure ?? new Error('界面偏好暂时无法保存。'))
  })
}

export function browserAuthStorage(origin: string): AuthStorage {
  const access = async (update?: (value: BrowserSession | null, store: IDBObjectStore) => void): Promise<BrowserSession | null> => {
    const db = await openBrowserDatabase()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('sessions', update ? 'readwrite' : 'readonly')
      const store = transaction.objectStore('sessions')
      const request = store.get(origin)
      let value: BrowserSession | null = null
      request.onsuccess = () => { value = request.result ?? null; update?.(value, store) }
      transaction.oncomplete = () => resolve(value)
      transaction.onerror = transaction.onabort = () => reject(new Error('登录状态未能保存，请检查浏览器存储后重试。'))
    })
  }
  return {
    read: () => access(),
    async write(value, expectedToken, current = () => true) {
      await access((previous, store) => {
        if (current() && (expectedToken === undefined || previous === null || previous.token === expectedToken)) store.put(value, origin)
      })
    },
    async remove(token) { await access((previous, store) => { if (previous?.token === token) store.delete(origin) }) }
  }
}

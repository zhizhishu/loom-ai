import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { BrowserWindow, session as electronSession, shell, type Session } from 'electron'
import {
  REMOTE_HOST_LIMIT,
  remoteHostAllowsNavigation,
  remoteHostLabel,
  remoteHostOrigin,
  sanitizeRemoteHosts,
  type RemoteHostEntry
} from '../shared/remote-host'
import { isWebUrl } from '../web-url'
import { writePrivateJson } from './general-preferences'

/**
 * The Desktop's list of remote Rovai Servers, kept in userData beside the other
 * small preference files. Only origins and labels are stored; each remote
 * console signs in through its own login page inside an isolated partition.
 */
export class RemoteHostsStore {
  readonly #filePath: string
  #hosts: RemoteHostEntry[]
  #writeTail: Promise<void> = Promise.resolve()

  private constructor(filePath: string, hosts: RemoteHostEntry[]) {
    this.#filePath = filePath
    this.#hosts = hosts
  }

  static async load(filePath: string): Promise<RemoteHostsStore> {
    let source: unknown = null
    try { source = JSON.parse(await readFile(filePath, 'utf8')) as unknown } catch { source = null }
    return new RemoteHostsStore(filePath, sanitizeRemoteHosts(source))
  }

  list(): RemoteHostEntry[] {
    return this.#hosts.map(host => ({ ...host }))
  }

  get(id: string): RemoteHostEntry | null {
    return this.#hosts.find(host => host.id === id) ?? null
  }

  async add(address: unknown, label: unknown): Promise<RemoteHostEntry> {
    if (typeof address !== 'string') throw new RemoteHostError('remote_host_url_invalid')
    const parsed = remoteHostOrigin(address)
    if ('error' in parsed) throw new RemoteHostError(parsed.error)
    if (this.#hosts.some(host => host.origin === parsed.origin)) throw new RemoteHostError('remote_host_exists')
    if (this.#hosts.length >= REMOTE_HOST_LIMIT) throw new RemoteHostError('remote_host_limit')
    const entry: RemoteHostEntry = {
      id: `host-${randomUUID()}`,
      origin: parsed.origin,
      label: remoteHostLabel(typeof label === 'string' ? label : '', parsed.origin)
    }
    await this.#persist([...this.#hosts, entry])
    return { ...entry }
  }

  async remove(id: unknown): Promise<void> {
    if (typeof id !== 'string' || !this.get(id)) throw new RemoteHostError('remote_host_not_found')
    await this.#persist(this.#hosts.filter(host => host.id !== id))
  }

  async #persist(next: RemoteHostEntry[]): Promise<void> {
    const write = this.#writeTail.then(() => writePrivateJson(this.#filePath, { version: 1, hosts: next }))
    this.#writeTail = write.catch(() => undefined)
    await write
    this.#hosts = next
  }
}

export class RemoteHostError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'RemoteHostError'
  }
}

/**
 * One isolated window per remote Server. The remote console is untrusted web
 * content: no preload, no Node, sandboxed, its own persistent partition (so its
 * login survives restarts without touching the local App's session), every
 * permission refused, and navigation pinned to the entry's origin. Links that
 * leave the origin go to the system browser instead.
 */
export class RemoteHostWindows {
  readonly #windows = new Map<string, BrowserWindow>()
  readonly #createSession: (id: string) => Session

  constructor(options: { createSession?: (id: string) => Session } = {}) {
    this.#createSession = options.createSession
      ?? (id => electronSession.fromPartition(`persist:rovai-remote-host-${id}`))
  }

  open(entry: RemoteHostEntry): void {
    const existing = this.#windows.get(entry.id)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
      return
    }
    const remoteSession = this.#createSession(entry.id)
    remoteSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    remoteSession.setPermissionCheckHandler(() => false)
    const window = new BrowserWindow({
      width: 1280,
      height: 820,
      title: entry.label,
      autoHideMenuBar: true,
      webPreferences: {
        session: remoteSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false
      }
    })
    const pin = (event: { preventDefault(): void }, target: string): void => {
      if (remoteHostAllowsNavigation(entry.origin, target)) return
      event.preventDefault()
      if (isWebUrl(target)) void shell.openExternal(target)
    }
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (!remoteHostAllowsNavigation(entry.origin, url) && isWebUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', pin)
    window.webContents.on('will-redirect', pin)
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.on('closed', () => {
      if (this.#windows.get(entry.id) === window) this.#windows.delete(entry.id)
    })
    this.#windows.set(entry.id, window)
    void window.loadURL(`${entry.origin}/`)
  }

  close(id: string): void {
    const window = this.#windows.get(id)
    if (window && !window.isDestroyed()) window.close()
    this.#windows.delete(id)
  }
}

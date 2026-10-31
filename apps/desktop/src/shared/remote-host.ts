/**
 * Remote Rovai Server entries the Desktop can open in an isolated window.
 *
 * An entry is only an origin plus a label. Credentials never live here: the remote
 * Server's own login page asks for its token, and the session cookie stays in the
 * entry's private Electron partition.
 */

export const REMOTE_HOST_LIMIT = 16
export const REMOTE_HOST_LABEL_LIMIT = 60

export interface RemoteHostEntry {
  id: string
  label: string
  origin: string
}

export type RemoteHostOriginError =
  | 'remote_host_url_invalid'
  | 'remote_host_url_protocol'
  | 'remote_host_url_credentials'
  | 'remote_host_url_path'

/**
 * Reduce a user-typed address to its origin. Only http(s), no credentials, and
 * nothing after the host but an optional trailing slash: a remote console is
 * always its Server root, so a path, query or fragment is refused instead of
 * silently dropped.
 */
export function remoteHostOrigin(value: string): { origin: string } | { error: RemoteHostOriginError } {
  const text = value.trim()
  if (!text || /[\s\u0000-\u001f\u007f\\]/u.test(text)) return { error: 'remote_host_url_invalid' }
  if (!/^https?:\/\//iu.test(text)) return { error: 'remote_host_url_protocol' }
  let url: URL
  try { url = new URL(text) } catch { return { error: 'remote_host_url_invalid' } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'remote_host_url_protocol' }
  if (!url.hostname) return { error: 'remote_host_url_invalid' }
  if (url.username || url.password) return { error: 'remote_host_url_credentials' }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) return { error: 'remote_host_url_path' }
  return { origin: url.origin }
}

export function remoteHostLabel(value: string, origin: string): string {
  const label = value.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, REMOTE_HOST_LABEL_LIMIT)
  return label || new URL(origin).host
}

const ID_PATTERN = /^[a-z0-9-]{8,64}$/u

/** Keep only well-formed, unique entries; the file is user data and may be edited by hand. */
export function sanitizeRemoteHosts(source: unknown): RemoteHostEntry[] {
  const hosts = source && typeof source === 'object' && Array.isArray((source as { hosts?: unknown }).hosts)
    ? (source as { hosts: unknown[] }).hosts
    : []
  const seenIds = new Set<string>()
  const seenOrigins = new Set<string>()
  const entries: RemoteHostEntry[] = []
  for (const candidate of hosts) {
    if (entries.length >= REMOTE_HOST_LIMIT) break
    if (!candidate || typeof candidate !== 'object') continue
    const { id, label, origin } = candidate as Record<string, unknown>
    if (typeof id !== 'string' || !ID_PATTERN.test(id) || seenIds.has(id)) continue
    if (typeof origin !== 'string') continue
    const parsed = remoteHostOrigin(origin)
    if (!('origin' in parsed) || parsed.origin !== origin || seenOrigins.has(origin)) continue
    seenIds.add(id)
    seenOrigins.add(origin)
    entries.push({ id, origin, label: remoteHostLabel(typeof label === 'string' ? label : '', origin) })
  }
  return entries
}

/** True only for a navigation that stays on the entry's own origin. */
export function remoteHostAllowsNavigation(origin: string, target: string): boolean {
  try { return new URL(target).origin === origin } catch { return false }
}

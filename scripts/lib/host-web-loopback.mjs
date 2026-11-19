// A deliberately tiny static file server: it exists so the real Chrome can load ONE built fixture
// directory over loopback. It never proxies, never lists a directory, never follows a symlink out of
// its root and never serves anything outside `root`.
//
// Boundaries:
// - GET/HEAD only; any other method is 405.
// - The decoded request path is resolved against the real root; the real path must stay inside it.
// - A path segment starting with `.` is refused (no dotfiles, no `.git`).
// - No directory listing: a directory request only ever maps to its own `index.html`.
// - `Cache-Control: no-store`, and no cookie is ever read or written.

import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
})

/** True only when `candidate` is `root` itself or a descendant, compared after resolution. */
export function insideRoot (root, candidate) {
  const base = resolve(root)
  const target = resolve(candidate)
  if (target === base) return true
  return target.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * Pure path decision: decode, refuse NUL / traversal / dot-segments / non-rooted specifiers, then
 * join under `root`. Returns `{status:'file'|'redirect'|'rejected', path}` so the caller never has to
 * guess what a request meant.
 */
export function resolveRequestPath (root, rawUrl) {
  const rawPath = String(rawUrl ?? '/').split('?')[0].split('#')[0]
  let decoded
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return { status: 'rejected', reason: 'undecodable_path' }
  }
  if (decoded.includes('\0')) return { status: 'rejected', reason: 'nul_byte' }
  if (!decoded.startsWith('/')) return { status: 'rejected', reason: 'relative_path' }
  const segments = decoded.split('/').filter(segment => segment !== '')
  if (segments.some(segment => segment === '..' || segment.startsWith('.'))) {
    return { status: 'rejected', reason: 'dot_segment' }
  }
  const candidate = join(root, ...segments)
  if (!insideRoot(root, candidate)) return { status: 'rejected', reason: 'outside_root' }
  return { status: 'file', path: candidate, trailingSlash: decoded.endsWith('/') }
}

/**
 * Serve one built directory on 127.0.0.1 with an OS-assigned port.
 * `requests` is an append-only log of `{method, url, status}` so a test can prove what was asked.
 */
export async function serveStatic (root) {
  const realRoot = await realpath(root)
  const rootStat = await stat(realRoot)
  if (!rootStat.isDirectory()) throw new Error(`static root is not a directory: ${realRoot}`)
  const requests = []
  const server = createServer((request, response) => {
    const method = request.method ?? 'GET'
    const finish = (status) => {
      requests.push({ method, url: request.url ?? '', status })
      response.statusCode = status
    }
    if (method !== 'GET' && method !== 'HEAD') {
      finish(405)
      response.setHeader('Allow', 'GET, HEAD')
      response.end('method not allowed')
      return
    }
    const decision = resolveRequestPath(realRoot, request.url)
    if (decision.status !== 'file') {
      finish(403)
      response.end('refused')
      return
    }
    const send = async () => {
      const target = decision.trailingSlash ? join(decision.path, 'index.html') : decision.path
      let real
      try {
        const linkStat = await lstat(target)
        // A symlink is never followed: the fixture build must be a plain tree of real files.
        if (linkStat.isSymbolicLink()) return finish(403), response.end('refused')
        real = await realpath(target)
      } catch {
        return finish(404), response.end('not found')
      }
      if (!insideRoot(realRoot, real)) return finish(403), response.end('refused')
      let fileStat
      try {
        fileStat = await stat(real)
      } catch {
        return finish(404), response.end('not found')
      }
      if (!fileStat.isFile()) return finish(404), response.end('not found')
      finish(200)
      response.setHeader('Content-Type', MIME[extname(real).toLowerCase()] ?? 'application/octet-stream')
      response.setHeader('Content-Length', String(fileStat.size))
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('X-Content-Type-Options', 'nosniff')
      if (method === 'HEAD') return response.end()
      createReadStream(real).pipe(response)
      return undefined
    }
    void send().catch(() => {
      finish(500)
      response.end('server error')
    })
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('static server did not bind a port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    root: realRoot,
    requests,
    async close () {
      await new Promise(done => server.close(done))
    }
  }
}

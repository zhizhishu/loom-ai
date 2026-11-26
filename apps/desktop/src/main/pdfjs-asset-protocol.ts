import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

/**
 * pdf.js 的静态资产（worker、cmaps、standard_fonts、wasm、iccs）在主窗口里走专用特权协议。
 *
 * 生产走 `loadFile`，页面地址是 `file://…/out/renderer/index.html`；页面用 fetch/XHR 取
 * `file://` 兄弟文件在 Chromium 里必然失败（file 源既不允许 XHR，也给不出 CORS 头）。
 * 所以这些资产统一改写成 `rovai-pdfjs://asset/<相对路径>`，由主进程按白名单读盘返回。
 *
 * 越权形状一律拒绝、绝不「修正」：绝对路径、`..` 穿越（含百分号编码）、反斜杠、盘符、
 * 控制字符、非 `asset` 主机都得到 null，随后由调用方变成 404。
 */

export const PDFJS_ASSET_SCHEME = 'rovai-pdfjs'

/** 协议里唯一允许的主机名：`rovai-pdfjs://asset/...`。 */
const ASSET_HOST = 'asset'

/**
 * 基本 MIME 表。模块工人必须拿到 `text/javascript`（Chromium 会按 MIME 拒绝模块脚本），
 * `.wasm` 必须是 `application/wasm`；其余 pdf.js 资产按不透明字节交给浏览器即可。
 */
const CONTENT_TYPES: Record<string, string> = {
  '.bcmap': 'application/octet-stream',
  '.icc': 'application/octet-stream',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.otf': 'font/otf',
  '.pfb': 'application/octet-stream',
  '.ttc': 'font/collection',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
}

export function pdfjsAssetContentType(pathOrUrl: string): string {
  return CONTENT_TYPES[extname(pathOrUrl).toLowerCase()] ?? 'application/octet-stream'
}

function assetSegment(encoded: string): string | null {
  if (encoded === '') return null
  let decoded: string
  try {
    decoded = decodeURIComponent(encoded)
  } catch {
    return null
  }
  // 解码后再判：`%2e%2e`、`%2f`、`%5c` 都是逃逸尝试，而不是要读的文件名。
  if (decoded === '.' || decoded === '..') return null
  if (decoded.includes('/') || decoded.includes('\\') || decoded.includes(':')) return null
  if (/[\0\r\n]/u.test(decoded)) return null
  return decoded
}

/** 原始 URL → 资产根下的相对路径段；任何不合规形状都是 null。查询串（`?v=`）仅用于缓存破除，忽略。 */
export function parsePdfjsAssetUrl(rawUrl: string): string[] | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${PDFJS_ASSET_SCHEME}:` || url.hostname !== ASSET_HOST) return null
  if (url.username !== '' || url.password !== '' || url.port !== '') return null
  const raw = url.pathname.split('/')
  // 绝对路径的第一个空段是 `//asset` 之后那一个 `/`，是必要的；其余空段（含目录形式的结尾斜杠）一律拒绝。
  if (raw[0] === '') raw.shift()
  if (raw.length === 0 || raw.includes('')) return null
  const segments: string[] = []
  for (const encoded of raw) {
    const segment = assetSegment(encoded)
    if (segment === null) return null
    segments.push(segment)
  }
  return segments.length === 0 ? null : segments
}

/** 资产根 + 已校验的相对路径段 → 绝对文件路径；解析后仍在根内才返回，否则 null。 */
export function resolvePdfjsAssetPath(root: string, rawUrl: string): string | null {
  const segments = parsePdfjsAssetUrl(rawUrl)
  if (segments === null) return null
  const base = resolve(root)
  const target = resolve(base, ...segments)
  if (target !== base && !target.startsWith(`${base}${sep}`)) return null
  return target
}

/**
 * 生成 `protocol.handle('rovai-pdfjs', …)` 的处理函数：只服务 GET/HEAD，只读根目录里的文件，
 * 统一带 CORS 与 nosniff，并提供正确的 Content-Type。
 */
export function createPdfjsAssetHandler(root: string): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405 })
    }
    const target = resolvePdfjsAssetPath(root, request.url)
    if (target === null) return new Response(null, { status: 404 })
    let bytes: Buffer
    try {
      bytes = await readFile(target)
    } catch {
      // 目录、缺文件、权限问题对一个静态白名单协议都是「没有这个资产」。
      return new Response(null, { status: 404 })
    }
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Content-Type': pdfjsAssetContentType(target),
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff'
    }
    if (request.method === 'HEAD') return new Response(null, { headers })
    // readFile 给的是池化的 Buffer：按偏移切片，类型上再钉成独立 ArrayBuffer 供 Response 使用。
    return new Response(
      new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength),
      { headers }
    )
  }
}

import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'

/**
 * PDF 预览的运行时底座（成果浮层专用）。
 *
 * 三件事只在这里做一次：把 pdf.js 的工人与静态资源钉在正确的地址上（生产走主进程特权
 * 协议，开发走 document.baseURI）、把归档字节交给 pdf.js、以及算单页画布的像素几何。
 * 渲染界面在 `ArtifactPdfPreview.tsx`，两者都不碰验收数据。
 *
 * 为什么资产地址要分两条路：Electron 生产走 `loadFile`，页面地址是 `file://…/out/renderer/
 * index.html`。`file:` 页面既不能 XHR/fetch 同源文件，也没有可用 CORS，pdf.js 自己去取
 * cmaps/字体/wasm 一定失败；所以 `file:` 下改写成主进程的 `rovai-pdfjs://asset/…`
 * （见 `apps/desktop/src/main/pdfjs-asset-protocol.ts`）。开发期页面是 http，Vite 的 public
 * 目录提供 `pdfjs/…`，继续按相对 document.baseURI 解析即可。
 */

/** 静态资源目录名：postinstall 从 `node_modules/pdfjs-dist` 复制到 renderer public。 */
export const PDFJS_ASSET_ROOT = 'pdfjs'

/** 生产只读资产协议：主机名固定 `asset`，根目录是 out/renderer/pdfjs。 */
export const PDFJS_ASSET_SCHEME = 'rovai-pdfjs'
export const PDFJS_ASSET_ORIGIN = `${PDFJS_ASSET_SCHEME}://asset/`

/** 单页画布像素上限（16Mpx ≈ 64MiB）：极端页面先降采样，一张图吃不掉整个进程。 */
export const PDF_MAX_CANVAS_PIXELS = 16_000_000

/** 无 document（单测/SSR）时的占位基准，只用于解析出可断言的 URL 形状。 */
const DOCUMENT_BASE_FALLBACK = 'http://localhost/'

function documentBase(): string {
  return typeof document === 'undefined' ? DOCUMENT_BASE_FALLBACK : document.baseURI
}

/**
 * `pdfjs/<path>` 在两种页面基址下的绝对地址。
 *
 * - http/https（开发、或未来的远程页面）：按 document.baseURI 相对解析，不写死站点根。
 * - `file:`（生产 loadFile）：转成 `rovai-pdfjs://asset/<path>`，协议根就是 `renderer/pdfjs`，
 *   所以路径里不再带 `pdfjs/` 前缀——前缀由主进程的资产根负责。
 */
export function pdfjsAssetUrl(path: string, base: string = documentBase()): string {
  const assetPath = path.replace(/^\/+/u, '')
  const relative = new URL(`${PDFJS_ASSET_ROOT}/${assetPath}`, base)
  if (relative.protocol === 'file:') return `${PDFJS_ASSET_ORIGIN}${assetPath}`
  return relative.href
}

/**
 * 工人地址带 `?v=<pdf.js 版本>`：升级依赖后不会命中旧版本的缓存工人，
 * 也不会出现主线程与工人版本不一致时的解析错误。两种协议形态都走这一个函数。
 */
export function pdfjsWorkerUrl(version: string, base: string = documentBase()): string {
  const url = new URL(pdfjsAssetUrl('pdf.worker.min.mjs', base))
  url.searchParams.set('v', version)
  return url.href
}

/** 单页画布几何：CSS 尺寸用于布局占位，像素尺寸是 backing store 的大小。 */
export type PdfPageGeometry = {
  css: { width: number; height: number }
  pixels: { width: number; height: number }
  /** 像素/CSS 比不为 1 时给 pdf.js 的 transform；为 1 时省掉。 */
  transform: [number, number, number, number, number, number] | undefined
}

/**
 * 画布几何：宽高按同一个 ratio 缩放（别分别截断，那会把页面拉成另一个宽高比），
 * ratio 同时受设备像素比和总像素上限约束。纯函数，单测直接钉住内存上限。
 */
export function pdfPageGeometry(
  width: number,
  height: number,
  deviceRatio = 1,
  maxPixels = PDF_MAX_CANVAS_PIXELS
): PdfPageGeometry {
  const css = {
    width: Math.max(1, Math.round(Number.isFinite(width) ? width : 1)),
    height: Math.max(1, Math.round(Number.isFinite(height) ? height : 1))
  }
  const ratio = Math.min(
    Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1,
    Math.sqrt(maxPixels / (css.width * css.height))
  )
  return {
    css,
    pixels: {
      width: Math.max(1, Math.round(css.width * ratio)),
      height: Math.max(1, Math.round(css.height * ratio))
    },
    transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0]
  }
}

/** 未渲染的页按首页尺寸占位：只留页高和页码，滚动条不会因为懒渲染跳动。 */
export function pdfPageSlotSize(baseWidth: number, baseHeight: number, scale: number): { width: number; height: number } {
  const width = Number.isFinite(baseWidth) && baseWidth > 0 ? baseWidth : 0
  const height = Number.isFinite(baseHeight) && baseHeight > 0 ? baseHeight : 0
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

/** 失败原因只做归类与截断，保留可诊断的部分，不把整段堆栈塞进界面。 */
export function pdfRenderErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message
    : typeof error === 'string' ? error : ''
  const detail = raw.trim()
  if (/password/iu.test(detail)) return '这份 PDF 受密码保护，无法预览。'
  if (/InvalidPDF|MissingPDF|UnexpectedResponse|not a PDF/iu.test(detail)) return '这份 PDF 无法解析。'
  return detail === '' ? 'PDF 渲染失败。' : `PDF 渲染失败：${detail.slice(0, 200)}`
}

/** 一次已打开的 PDF：文档代理 + 释放入口，调用方只需 destroy。 */
export type ArtifactPdfDocument = {
  version: string
  document: PDFDocumentProxy
  destroy(): Promise<void>
}

let workerConfigured = false

/**
 * 懒加载 pdf.js legacy build 并打开归档字节。
 *
 * legacy build 是给「不是最新 Chromium」的运行时兜底用的；这里只在真正要看 PDF 时才 import，
 * 不让每个打开成果浮层的人都下载解析器。`data` 传副本：pdf.js 会转移缓冲区所有权，
 * 原字节仍需支持下载与重试。
 */
export async function openArtifactPdf(bytes: Uint8Array, base: string = documentBase()): Promise<ArtifactPdfDocument> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (!workerConfigured) {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl(pdfjs.version, base)
    workerConfigured = true
  }
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: pdfjsAssetUrl('cmaps/', base),
    cMapPacked: true,
    standardFontDataUrl: pdfjsAssetUrl('standard_fonts/', base),
    wasmUrl: pdfjsAssetUrl('wasm/', base),
    iccUrl: pdfjsAssetUrl('iccs/', base),
    // 归档字节已经在手里：不请求远端、不做分块拉取，离线也能看。
    disableStream: true,
    disableAutoFetch: true,
    disableRange: true
  })
  const document = await task.promise
  return {
    version: pdfjs.version,
    document,
    // v6 的 document 代理不再自己 destroy：释放必须回到 loading task，
    // 否则工人与已解析的字体/页面资源会一直留在进程里。
    destroy: async () => { await task.destroy() }
  }
}

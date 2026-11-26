import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { Icon } from './icons'
import {
  openArtifactPdf,
  pdfPageGeometry,
  pdfPageSlotSize,
  pdfRenderErrorMessage,
  type ArtifactPdfDocument
} from './artifact-pdf'

/**
 * 成果浮层里的 PDF 预览：连续滚动分页，最少要有加载、失败、页数和缩放。
 *
 * 只做展示：字节来自 `loom.artifact.preview` 的归档内容，这里既不重新读取文件，
 * 也不写任何核验/验收状态。渲染全部在画布上完成——不用 PDF 自带的 viewer，
 * 也就不会把文档里的脚本或外链带进 Electron 渲染进程。
 *
 * 内存上限是硬要求：8MiB/数百页的文档不能把每一页都画进画布。这里给每页只留
 * 一个「页高占位 + 页码」，用 IntersectionObserver 把视口附近的页标成 live，
 * 只有 live 页持有画布 backing store；离屏、切档、缩放都会把 canvas.width/height
 * 归零（立即释放位图），所以同驻留的页数由视口高度决定，与文档页数无关。
 */

const MIN_ZOOM = 0.5
const MAX_ZOOM = 3
const ZOOM_STEP = 0.25
/** 视口外再留一屏：滚动时下一批页已经画好，但活动页数仍是常数。 */
const PDF_PAGE_ROOT_MARGIN = '900px 0px'
/** 没有 IntersectionObserver 的极端环境也只兜底前几页，不退回「整本一起渲染」。 */
const FALLBACK_LIVE_PAGES = 4

type CancelableRender = { cancel(): void; promise: Promise<void> }

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100))
}

function deviceRatio(): number {
  const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio
  return Number.isFinite(ratio) && ratio > 0 ? Math.min(ratio, 2) : 1
}

/** 释放一张画布的位图内存：宽高一归零，backing store 立刻回收。 */
function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0
  canvas.height = 0
}

export type ArtifactPdfPageProps = {
  pdfDocument: PDFDocumentProxy | null
  pageNumber: number
  scale: number
  /** 在视口附近才渲染；离屏页只保留占位与页码。 */
  live: boolean
  /** 首页尺寸在当前缩放下的大小，用于未渲染页的占位。 */
  slot: { width: number; height: number }
  onError(cause: unknown): void
}

/**
 * 单页：自己负责画布的生命周期。live 变 false、缩放变化、文档变化、卸载都会
 * 取消渲染任务并把 canvas 归零，绝不留一份离屏位图在内存里。
 */
export function ArtifactPdfPage({
  pdfDocument, pageNumber, scale, live, slot, onError
}: ArtifactPdfPageProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // 已渲染过的真实页高按 scale 记住：再次离屏/回屏时占位与真实页一致，滚动条不跳。
  const [rendered, setRendered] = useState<{ scale: number; height: number } | null>(null)
  const renderedHeight = rendered !== null && rendered.scale === scale ? rendered.height : null

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    if (pdfDocument === null || !live) {
      // 未就绪或离屏：只留占位，位图立即放手。
      releaseCanvas(canvas)
      return
    }
    let cancelled = false
    let task: CancelableRender | null = null
    let proxy: { cleanup(): void } | null = null
    void (async () => {
      try {
        const page = await pdfDocument.getPage(pageNumber)
        if (cancelled) return
        proxy = page
        const viewport = page.getViewport({ scale })
        const geometry = pdfPageGeometry(viewport.width, viewport.height, deviceRatio())
        canvas.width = geometry.pixels.width
        canvas.height = geometry.pixels.height
        canvas.style.width = `${geometry.css.width}px`
        canvas.style.height = `${geometry.css.height}px`
        task = page.render({ canvas, viewport, transform: geometry.transform })
        setRendered({ scale, height: geometry.css.height })
        await task.promise
      } catch (cause) {
        if (cancelled) return
        // 取消是滚动/缩放导致的，不是错误；其余失败必须显示出来，不能留白冒充成功。
        if (cause instanceof Error && cause.name === 'RenderingCancelledException') return
        onError(cause)
      }
    })()
    return () => {
      cancelled = true
      try {
        task?.cancel()
      } catch {
        // 渲染已经结束时 cancel 会抛，这不是失败。
      }
      releaseCanvas(canvas)
      // 连工人侧的操作符/字体也还回去：页面滚出视口后只剩占位，不再替它留解析结果。
      try {
        proxy?.cleanup()
      } catch {
        // 清理失败不影响释放：画布已经归零。
      }
    }
  }, [pdfDocument, pageNumber, scale, live, onError])

  return <div
    className="ln-artifact-pdf-page"
    data-page={pageNumber}
    data-live={live ? 'true' : 'false'}
    data-rendered={renderedHeight === null ? 'false' : 'true'}
    style={{ height: `${renderedHeight ?? slot.height}px`, width: `${slot.width}px` }}
  >
    <canvas ref={canvasRef} aria-hidden="true"/>
    <span className="ln-artifact-pdf-page-number">{pageNumber}</span>
  </div>
}

export function ArtifactPdfPreview({ bytes, fileName }: {
  bytes: Uint8Array
  fileName: string
}): React.JSX.Element {
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [baseSize, setBaseSize] = useState<{ width: number; height: number } | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [visiblePages, setVisiblePages] = useState<ReadonlySet<number>>(() => new Set<number>())
  const [zoom, setZoom] = useState(1)
  const [fitWidth, setFitWidth] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const pagesRef = useRef<HTMLDivElement | null>(null)

  // 打开归档字节：一次一份，失败留下可读原因，重试只换 attempt。
  useEffect(() => {
    let live = true
    let opened: ArtifactPdfDocument | null = null
    setStatus('loading')
    setError(null)
    setPdfDocument(null)
    setPageCount(0)
    setBaseSize(null)
    setVisiblePages(new Set<number>())
    void (async () => {
      try {
        opened = await openArtifactPdf(bytes)
        if (!live) { void opened.destroy().catch(() => undefined); return }
        // 首页同时给出总页数和占位用的基准尺寸：其余页不必为了布局去解析。
        const first = await opened.document.getPage(1)
        if (!live) { void opened.destroy().catch(() => undefined); return }
        const viewport = first.getViewport({ scale: 1 })
        setBaseSize({ width: viewport.width, height: viewport.height })
        setPageCount(opened.document.numPages)
        setPdfDocument(opened.document)
        setStatus('ready')
      } catch (cause) {
        if (!live) return
        setStatus('error')
        setError(pdfRenderErrorMessage(cause))
      }
    })()
    return () => {
      live = false
      // 文档代理持有工人/画布资源；关闭浮层、切文件、重试都必须释放。
      if (opened !== null) void opened.destroy().catch(() => undefined)
    }
  }, [bytes, attempt])

  // 适配宽度需要用文档区真实宽度，窗口缩放时跟着变。
  useEffect(() => {
    const host = pagesRef.current
    if (host === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0
      setContainerWidth(width > 0 ? width : 0)
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [status])

  const fitScale = useMemo(() => {
    if (baseSize === null || baseSize.width <= 0) return null
    const available = containerWidth > 0 ? containerWidth - 8 : 0
    if (available <= 0) return null
    return clampZoom(available / baseSize.width)
  }, [baseSize, containerWidth])

  const scale = fitWidth ? fitScale ?? 1 : zoom
  const slot = baseSize === null
    ? { width: 1, height: 1 }
    : pdfPageSlotSize(baseSize.width, baseSize.height, scale)

  // 只有一个观察器，观察所有页占位：只把视口附近的页标成 live。
  // 依赖 pageCount：页是从 0 建起来的，建完必须重新 observe。
  useEffect(() => {
    const host = pagesRef.current
    if (host === null || pageCount === 0) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisiblePages(new Set(Array.from({ length: Math.min(FALLBACK_LIVE_PAGES, pageCount) }, (_, index) => index + 1)))
      return
    }
    const observer = new IntersectionObserver(entries => {
      setVisiblePages(current => {
        const next = new Set(current)
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page)
          if (!Number.isInteger(page) || page < 1) continue
          if (entry.isIntersecting) next.add(page)
          else next.delete(page)
        }
        return next
      })
    }, { root: host, rootMargin: PDF_PAGE_ROOT_MARGIN })
    for (const node of host.querySelectorAll<HTMLElement>('[data-page]')) observer.observe(node)
    return () => observer.disconnect()
  }, [pageCount, pdfDocument])

  // 稳定的失败入口：页面把它放进 effect 依赖里，不稳定会每帧重渲。
  const failPreview = useCallback((cause: unknown) => {
    setStatus('error')
    setError(pdfRenderErrorMessage(cause))
  }, [])

  const stepZoom = useCallback((delta: number) => {
    setFitWidth(false)
    setZoom(current => clampZoom((fitWidth ? fitScale ?? 1 : current) + delta))
  }, [fitWidth, fitScale])

  const retry = (): void => setAttempt(value => value + 1)

  if (status === 'error') {
    return <div className="ln-artifact-state" data-state="error" role="alert">
      <span>{error ?? 'PDF 渲染失败。'}</span>
      <button type="button" className="ln-artifact-retry" onClick={retry}>重试</button>
    </div>
  }

  return <div className="ln-artifact-pdf" data-state={status}>
    <div className="ln-artifact-pdf-bar" role="toolbar" aria-label="PDF 预览控制">
      <span className="ln-artifact-pdf-pages" role="status">
        {status === 'loading' ? '正在打开 PDF…' : `共 ${pageCount} 页`}
      </span>
      <span className="ln-artifact-pdf-actions">
        <button
          type="button" title="缩小" aria-label="缩小"
          disabled={status !== 'ready'} onClick={() => stepZoom(-ZOOM_STEP)}
        ><Icon name="minus" size={14}/></button>
        <span className="ln-artifact-pdf-zoom" aria-label="当前缩放">{Math.round(scale * 100)}%</span>
        <button
          type="button" title="放大" aria-label="放大"
          disabled={status !== 'ready'} onClick={() => stepZoom(ZOOM_STEP)}
        ><Icon name="plus" size={14}/></button>
        <button
          type="button" className="ln-artifact-pdf-fit" data-active={fitWidth ? 'true' : 'false'}
          aria-pressed={fitWidth} title="适配宽度" aria-label="适配宽度"
          disabled={status !== 'ready'} onClick={() => { setZoom(scale); setFitWidth(true) }}
        >适配宽度</button>
      </span>
    </div>
    <div
      className="ln-artifact-pdf-pages-scroll" ref={pagesRef}
      role="document" aria-label={`${fileName} PDF 预览`}
    >
      {pageCount === 0
        ? <div className="ln-artifact-state" data-state="reading" role="status">正在打开 PDF…</div>
        : Array.from({ length: pageCount }, (_, index) => {
            const pageNumber = index + 1
            return <ArtifactPdfPage
              key={pageNumber}
              pdfDocument={pdfDocument}
              pageNumber={pageNumber}
              scale={scale}
              live={visiblePages.has(pageNumber)}
              slot={slot}
              onError={failPreview}
            />
          })}
    </div>
  </div>
}

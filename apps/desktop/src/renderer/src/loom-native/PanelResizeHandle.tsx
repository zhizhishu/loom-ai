import { useRef, type RefObject } from 'react'
import { clampPanelWidth, type PanelSide, type PanelWidths } from './panel-resize'

/** Updates the frame CSS variable while dragging (no React rerender of chat
 * transcripts on each pointermove). Commits width only on pointerup. */
export function PanelResizeHandle({ side, frame, widths, sidebarOpen, inspectorOpen, onResize }: {
  side: PanelSide; frame: RefObject<HTMLElement | null>; widths: PanelWidths
  sidebarOpen: boolean; inspectorOpen: boolean; onResize(side: PanelSide, value: number): void
}) {
  const dragging = useRef(false)
  const animation = useRef(0)
  const pending = useRef<number | null>(null)
  const variable = side === 'sidebar' ? '--ln-sidebar-width' : '--ln-inspector-width'
  const update = (wanted: number) => {
    const host = frame.current
    if (!host) return
    const live: PanelWidths = {
      sidebar: Number.parseFloat(host.style.getPropertyValue('--ln-sidebar-width')) || widths.sidebar,
      inspector: Number.parseFloat(host.style.getPropertyValue('--ln-inspector-width')) || widths.inspector
    }
    const value = clampPanelWidth(side, wanted, host.clientWidth, live, sidebarOpen, inspectorOpen)
    if (!Number.isFinite(value)) return
    host.style.setProperty(variable, `${value}px`)
    return value
  }
  const start = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !frame.current) return
    event.preventDefault()
    const handle = event.currentTarget
    dragging.current = true
    pending.current = null
    handle.setPointerCapture(event.pointerId)
    frame.current.classList.add('ln-is-resizing')
  }
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !frame.current) return
    const rect = frame.current.getBoundingClientRect()
    pending.current = side === 'sidebar' ? event.clientX - rect.left : rect.right - event.clientX
    if (!animation.current) animation.current = requestAnimationFrame(() => {
      animation.current = 0
      if (dragging.current && pending.current !== null) update(pending.current)
    })
  }
  const stop = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    if (animation.current) cancelAnimationFrame(animation.current)
    animation.current = 0
    if (pending.current !== null) update(pending.current)
    pending.current = null
    dragging.current = false
    const host = frame.current
    host?.classList.remove('ln-is-resizing')
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const value = host && Number.parseFloat(host.style.getPropertyValue(variable))
    if (typeof value === 'number' && Number.isFinite(value)) onResize(side, value)
  }
  const keyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const value = widths[side] + (side === 'sidebar' ? 1 : -1) * (event.key === 'ArrowRight' ? 24 : -24)
    const next = update(value)
    if (next !== undefined) onResize(side, next)
  }
  return <div className="ln-panel-resize" role="separator" tabIndex={0}
    aria-label={side === 'sidebar' ? '调整左侧会话栏宽度' : '调整右侧工作栏宽度'}
    aria-orientation="vertical" aria-valuemin={side === 'sidebar' ? 190 : 245}
    aria-valuemax={side === 'sidebar' ? 510 : 720} aria-valuenow={Math.round(widths[side])}
    title="拖动改变宽度 · 键盘左右箭头也可调整"
    onPointerDown={start} onPointerMove={move} onPointerUp={stop}
    onPointerCancel={stop} onLostPointerCapture={() => { dragging.current = false; pending.current = null; if(animation.current) cancelAnimationFrame(animation.current); animation.current=0; frame.current?.classList.remove('ln-is-resizing') }}
    onKeyDown={keyboard}><span aria-hidden="true"/></div>
}

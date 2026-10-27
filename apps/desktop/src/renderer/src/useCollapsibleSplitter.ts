import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { prefersReducedMotion } from './reduced-motion'

const COLLAPSE_TRAVEL = 64
const COLLAPSE_MS = 160
const REVERSE_TRAVEL = 24
export type FoldEdge = 'minimum' | 'maximum'

export type SplitterPhase = 'idle' | 'dragging' | 'detent' | 'preparing' | 'closing' | 'collapsed'

interface SplitterOptions<Snapshot> {
  size: number
  collapsed: boolean
  minimum: number
  maximum: number
  collapsedSize?: number
  expandAt?: number
  axis?: 'x' | 'y'
  direction: 1 | -1
  disabled?: boolean
  /** A page/selection change invalidates pending frames and async save results. */
  scopeKey?: string | number | null
  readSize?(): number
  scale?(): number
  capture(): Snapshot
  onPreview(size: number): void
  onCommit(size: number): void
  /** Omit for a boundary that resizes without folding. */
  onCollapse?(snapshot: Snapshot): void
  onCollapseMaximum?(snapshot: Snapshot): void
  maximumCollapsedSize?: number
  onCollapseMaximumFrame?(size: number): void
  /** Full visual fold while capture remains on the same divider; commit on release. */
  onFoldPreview?(edge: FoldEdge | null): void
  onCancel(snapshot: Snapshot): void
  onActiveChange?(active: boolean): void
  /** May paint below the expanded minimum without changing the saved preference. */
  onCollapseFrame?(size: number): void
  prepareCollapse?(): boolean | Promise<boolean>
}

interface Gesture<Snapshot> {
  pointerId: number
  target: HTMLDivElement
  coordinate: number
  size: number
  scale: number
  raw: number
  snapshot: Snapshot
  phase: SplitterPhase
  generation: number
  released: boolean
  moved: boolean
  foldEdge: FoldEdge | null
  peak: number
  rejectedEdge: FoldEdge | null
}

/** Convert CSS zoom / transformed layout pixels to pointer coordinates once per gesture. */
export function splitterScale(element: HTMLElement | null, axis: 'x' | 'y' = 'x'): number {
  if (!element) return 1
  const rect = element.getBoundingClientRect()
  const scale = axis === 'x' ? rect.width / element.offsetWidth : rect.height / element.offsetHeight
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

/** A spatial detent: another 64px folds during the drag, with no mouse-up or dwell gate. */
export function useCollapsibleSplitter<Snapshot>(options: SplitterOptions<Snapshot>) {
  const latest = useRef(options)
  latest.current = options
  const gesture = useRef<Gesture<Snapshot> | null>(null)
  const frame = useRef<number | null>(null)
  const dragged = useRef(false)
  const dragClickSequence = useRef(false)
  const pointerUp = useRef<(event: Pick<PointerEvent, 'pointerId' | 'clientX' | 'clientY'>) => void>(() => {})
  const [phase, setPhase] = useState<SplitterPhase>('idle')
  const [edge, setEdge] = useState<'minimum' | 'maximum'>('minimum')

  const clearPending = useCallback((): void => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
  }, [])

  const release = useCallback((): void => {
    const active = gesture.current
    gesture.current = null
    clearPending()
    if (!active) return
    active.generation++
    delete active.target.dataset.foldState
    delete active.target.dataset.resizing
    if (active.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId)
    latest.current.onFoldPreview?.(null)
    latest.current.onActiveChange?.(false)
    setPhase('idle')
  }, [clearPending])

  const cancel = useCallback((): void => {
    const active = gesture.current
    if (!active) return
    latest.current.onCancel(active.snapshot)
    release()
  }, [release])

  const changePhase = (active: Gesture<Snapshot>, next: SplitterPhase): void => {
    active.phase = next
    active.target.dataset.foldState = next
    setPhase(next)
  }

  const finishFold = (active: Gesture<Snapshot>): void => {
    const o = latest.current
    const upper = active.foldEdge === 'maximum'
    release()
    if (upper) o.onCollapseMaximum?.(active.snapshot)
    else o.onCollapse?.(active.snapshot)
  }

  const collapse = async (active: Gesture<Snapshot>, upper = false): Promise<void> => {
    clearPending()
    active.foldEdge = upper ? 'maximum' : 'minimum'
    active.peak = active.raw
    const generation = ++active.generation
    const current = (): boolean => gesture.current === active && active.generation === generation
    changePhase(active, 'preparing')
    let permitted = true
    try { permitted = await (latest.current.prepareCollapse?.() ?? true) }
    catch { permitted = false }
    if (!current()) return
    if (!permitted) {
      active.foldEdge = null
      active.rejectedEdge = upper ? 'maximum' : 'minimum'
      changePhase(active, 'detent')
      if (active.released) {
        latest.current.onCommit(upper ? latest.current.maximum : latest.current.minimum)
        release()
      }
      return
    }
    changePhase(active, 'closing')
    const started = performance.now()
    const duration = prefersReducedMotion() ? 0 : COLLAPSE_MS
    const animate = (now: number): void => {
      frame.current = null
      if (!current()) return
      const o = latest.current
      const progress = duration === 0 ? 1 : Math.min(1, (now - started) / duration)
      const end = upper ? o.maximumCollapsedSize ?? o.maximum : o.collapsedSize ?? 0
      const start = upper ? o.maximum : o.minimum
      const paint = upper ? o.onCollapseMaximumFrame ?? o.onPreview : o.onCollapseFrame ?? o.onPreview
      paint(end + (start - end) * Math.pow(1 - progress, 3))
      if (progress < 1) {
        frame.current = requestAnimationFrame(animate)
      } else {
        changePhase(active, 'collapsed')
        if (active.released) finishFold(active)
        else o.onFoldPreview?.(active.foldEdge)
      }
    }
    frame.current = requestAnimationFrame(animate)
  }

  // Keep pointer capture through the full visual fold. A deliberate reversal reopens
  // the minimum-width pane and rebases the same gesture, without jumping on mouse-up.
  const reverseFold = (active: Gesture<Snapshot>, coordinate: number): boolean => {
    if (!active.foldEdge) return false
    const upper = active.foldEdge === 'maximum'
    active.peak = upper ? Math.max(active.peak, active.raw) : Math.min(active.peak, active.raw)
    const reversed = upper ? active.peak - active.raw : active.raw - active.peak
    if (reversed < REVERSE_TRAVEL) return false
    clearPending()
    active.generation++
    active.foldEdge = null
    active.rejectedEdge = null
    latest.current.onFoldPreview?.(null)
    const boundary = upper ? latest.current.maximum : latest.current.minimum
    const inRange = active.raw >= latest.current.minimum && active.raw <= latest.current.maximum
    if (!inRange) {
      active.coordinate = coordinate
      active.size = active.raw = boundary
    }
    latest.current.onPreview(active.raw)
    changePhase(active, inRange ? 'dragging' : 'detent')
    return true
  }

  const update = (active: Gesture<Snapshot>): void => {
    const o = latest.current
    if (o.collapsed) {
      if (active.raw < (o.expandAt ?? o.minimum)) {
        changePhase(active, 'collapsed')
        return
      }
      changePhase(active, 'dragging')
    }
    if (o.onCollapseMaximum && active.raw >= o.maximum) {
      setEdge('maximum')
      o.onPreview(o.maximum)
      if (active.raw >= o.maximum + COLLAPSE_TRAVEL && active.rejectedEdge !== 'maximum') void collapse(active, true)
      else changePhase(active, 'detent')
      return
    }
    setEdge('minimum')
    if (active.raw > o.minimum) {
      active.rejectedEdge = null
      changePhase(active, 'dragging')
      o.onPreview(Math.min(o.maximum, active.raw))
      return
    }
    o.onPreview(o.minimum)
    if (o.onCollapse && active.raw <= o.minimum - COLLAPSE_TRAVEL && active.rejectedEdge !== 'minimum') void collapse(active)
    else changePhase(active, o.onCollapse ? 'detent' : 'dragging')
  }

  const readPointer = (active: Gesture<Snapshot>, event: Pick<PointerEvent, 'clientX' | 'clientY'>): void => {
    const o = latest.current
    const coordinate = o.axis === 'y' ? event.clientY : event.clientX
    active.raw = active.size + (coordinate - active.coordinate) * o.direction / active.scale
    active.moved ||= Math.abs(active.raw - active.size) > .5
    dragged.current ||= active.moved
  }

  pointerUp.current = event => {
    const active = gesture.current
    if (!active || active.pointerId !== event.pointerId || active.released) return
    readPointer(active, event)
    // Discard any older move frame before committing the release coordinate.
    // A running fold owns its RAF until the visual transition has finished.
    if (!active.foldEdge) clearPending()
    const o = latest.current
    if (!active.moved) { cancel(); return }
    if (active.foldEdge) {
      const reversed = reverseFold(active, o.axis === 'y' ? event.clientY : event.clientX)
      if (!reversed) {
        active.released = true
        if (active.phase === 'collapsed') finishFold(active)
        return
      }
    }
    const folded = o.collapsed && active.raw < (o.expandAt ?? o.minimum)
    if (!folded && active.rejectedEdge !== 'maximum' && o.onCollapseMaximum && active.raw >= o.maximum + COLLAPSE_TRAVEL) {
      active.released = true
      o.onPreview(o.maximum)
      setEdge('maximum')
      void collapse(active, true)
      return
    }
    if (!folded && active.rejectedEdge !== 'minimum' && o.onCollapse && active.raw <= o.minimum - COLLAPSE_TRAVEL) {
      active.released = true
      o.onPreview(o.minimum)
      void collapse(active)
      return
    }
    if (!folded) o.onCommit(Math.max(o.minimum, Math.min(o.maximum, active.raw)))
    release()
  }

  const finishAtLastPointer = useCallback((): void => {
    const active = gesture.current
    if (!active || active.released) return
    const o = latest.current
    const coordinate = active.coordinate + (active.raw - active.size) * active.scale / o.direction
    pointerUp.current({ pointerId: active.pointerId,
      clientX: o.axis === 'y' ? 0 : coordinate,
      clientY: o.axis === 'y' ? coordinate : 0 })
  }, [])

  const isolateDragClick = (event: ReactMouseEvent<HTMLDivElement>, double = false): void => {
    if (event.detail === 0) return
    // Browser click counts delimit a new click sequence; no arbitrary cooldown
    // makes intentional clicks wait. A dragged click cannot count toward reset.
    if (!double && event.detail === 1) dragClickSequence.current = dragged.current
    else dragClickSequence.current ||= dragged.current
    if (dragClickSequence.current) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  useEffect(() => {
    const end = (event: PointerEvent): void => pointerUp.current(event)
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !gesture.current) return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    // Observe release before retargeting/lost-capture cleanup and React handlers.
    // The React handler below remains an idempotent fallback.
    window.addEventListener('pointerup', end, true)
    window.addEventListener('keydown', escape, true)
    window.addEventListener('blur', finishAtLastPointer)
    window.addEventListener('resize', finishAtLastPointer)
    return () => {
      window.removeEventListener('pointerup', end, true)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('blur', finishAtLastPointer)
      window.removeEventListener('resize', finishAtLastPointer)
      cancel()
    }
  }, [cancel, finishAtLastPointer])

  useLayoutEffect(cancel, [cancel, options.disabled, options.scopeKey])
  useLayoutEffect(finishAtLastPointer, [finishAtLastPointer, options.minimum, options.maximum])

  return {
    active: phase !== 'idle',
    phase,
    edge,
    target: gesture.current?.target ?? null,
    cancel,
    finish: finishAtLastPointer,
    handlers: {
      onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
        const o = latest.current
        if (event.button !== 0 || !event.isPrimary || o.disabled || gesture.current) return
        dragged.current = false
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        event.currentTarget.dataset.resizing = 'true'
        const size = o.readSize?.() ?? o.size
        const scale = o.scale?.() ?? 1
        const active: Gesture<Snapshot> = {
          pointerId: event.pointerId, target: event.currentTarget,
          coordinate: o.axis === 'y' ? event.clientY : event.clientX,
          size, scale: Number.isFinite(scale) && scale > 0 ? scale : 1, raw: size,
          snapshot: o.capture(), phase: o.collapsed ? 'collapsed' : 'dragging',
          generation: 0, released: false, moved: false, foldEdge: null, peak: size, rejectedEdge: null
        }
        gesture.current = active
        setPhase(active.phase)
        o.onActiveChange?.(true)
      },
      onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
        const active = gesture.current
        if (!active || active.pointerId !== event.pointerId || active.released) return
        readPointer(active, event)
        if (!active.moved) return
        event.preventDefault()
        if (active.foldEdge) {
          reverseFold(active, latest.current.axis === 'y' ? event.clientY : event.clientX)
          return
        }
        clearPending()
        frame.current = requestAnimationFrame(() => {
          frame.current = null
          if (gesture.current === active) update(active)
        })
      },
      onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
        pointerUp.current(event)
      },
      onPointerCancel(event: ReactPointerEvent<HTMLDivElement>): void {
        if (gesture.current?.pointerId === event.pointerId) finishAtLastPointer()
      },
      onLostPointerCapture(event: ReactPointerEvent<HTMLDivElement>): void {
        // Losing input is an end, not an Undo. Use the latest known pointer
        // sample; never reinterpret retargeted cleanup coordinates as a move.
        if (gesture.current?.pointerId === event.pointerId) finishAtLastPointer()
      },
      onClickCapture(event: ReactMouseEvent<HTMLDivElement>): void { isolateDragClick(event) },
      onDoubleClickCapture(event: ReactMouseEvent<HTMLDivElement>): void { isolateDragClick(event, true) }
    }
  }
}

import { useEffect, useRef, useState } from 'react'
import { uiAttribute } from './interface-language'
import { splitterScale, useCollapsibleSplitter } from './useCollapsibleSplitter'

export const DEFAULT_CAPABILITY_WIDTH = 320
export function defaultCapabilityWidth(viewport: number): number {
  return viewport >= 2300 ? 400 : viewport >= 1600 ? 360 : DEFAULT_CAPABILITY_WIDTH
}
export function capabilityListWidth(preferred: number, available: number): number {
  return Math.round(
    Math.max(
      240,
      Math.min(
        Number.isFinite(preferred) ? preferred : DEFAULT_CAPABILITY_WIDTH,
        560,
        Math.max(240, available - 391)
      )
    )
  )
}

export function useCapabilitySplitter(storageKey: string, controls: string, enabled = true) {
  const root = useRef<HTMLDivElement>(null)
  const divider = useRef<HTMLDivElement>(null)
  const preferred = useRef<number | null>(null)
  const available = useRef(0)
  const currentWidth = useRef(DEFAULT_CAPABILITY_WIDTH)
  const [bounds, setBounds] = useState({ compact: false, maximum: 560 })
  const setWidth = (value: number, save: boolean): void => {
    const width = capabilityListWidth(value, available.current)
    currentWidth.current = width
    root.current?.style.setProperty('--capability-list-width', `${width}px`)
    divider.current?.setAttribute('aria-valuenow', String(width))
    divider.current?.setAttribute('aria-valuetext', uiAttribute("列表宽度 {0} 像素", String(width)))
    if (save) {
      preferred.current = width
      try { window.localStorage.setItem(storageKey, String(width)) }
      catch { /* Keep the in-window preference usable. */ }
    }
  }
  const splitter = useCollapsibleSplitter({
    size: currentWidth.current, readSize: () => currentWidth.current,
    collapsed: false, minimum: 240, maximum: bounds.maximum, direction: 1,
    disabled: !enabled || bounds.compact, scopeKey: storageKey,
    scale: () => splitterScale(root.current),
    capture: () => currentWidth.current,
    onPreview: width => setWidth(width, false),
    onCommit: width => setWidth(width, true),
    onCancel: width => setWidth(width, false),
    onActiveChange: active => {
      if (active) root.current?.setAttribute('data-resizing', 'true')
      else root.current?.removeAttribute('data-resizing')
    }
  })
  useEffect(() => {
    preferred.current = null
    try {
      const stored = Number(window.localStorage.getItem(storageKey))
      if (stored >= 240 && stored <= 560) preferred.current = stored
    } catch { /* Local layout is available without storage. */ }
    const measure = (initial = false): void => {
      // CSS zoom affects pointer coordinates, not the layout's width budget.
      const next = root.current?.clientWidth ?? 0
      if (!initial && next === available.current) return
      splitter.finish()
      available.current = next
      setBounds({ compact: next < 620, maximum: capabilityListWidth(560, next) })
      setWidth(preferred.current ?? defaultCapabilityWidth(window.innerWidth), false)
    }
    measure(true)
    const observer = new ResizeObserver(() => measure())
    if (root.current) observer.observe(root.current)
    return () => observer.disconnect()
  }, [storageKey, enabled])
  const reset = (): void => {
    splitter.cancel()
    preferred.current = null
    try { window.localStorage.removeItem(storageKey) } catch {}
    setWidth(defaultCapabilityWidth(window.innerWidth), false)
  }
  const separator = (
    <div className="capability-divider-rail">
      <div
        ref={divider}
        className="capability-divider"
        role="separator"
        tabIndex={0}
        aria-label={uiAttribute("调整列表宽度")}
        aria-orientation="vertical"
        aria-valuemin={240}
        aria-valuemax={bounds.maximum}
        aria-valuenow={currentWidth.current}
        aria-valuetext={uiAttribute("列表宽度 {0} 像素", String(currentWidth.current))}
        aria-controls={controls}
        title={uiAttribute("拖动调整宽度，双击复位；方向键也可调整")}
        {...splitter.handlers}
        onDoubleClick={reset}
        onKeyDown={(event) => {
          if (splitter.active || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return
          event.preventDefault()
          if (event.key === 'Enter') { reset(); return }
          setWidth(event.key === 'Home' ? 240 : event.key === 'End' ? bounds.maximum
            : currentWidth.current + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 24 : 8), true)
        }}
      />
    </div>
  )
  return { root, compact: bounds.compact, separator }
}

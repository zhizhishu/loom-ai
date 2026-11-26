import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** Mikka `components/chat/collapsible-message.tsx`：超过 320px 才折叠，折叠后露出约 240px。 */
export const MESSAGE_FOLD_AFTER = 320

/**
 * 长消息折到前几行，下面给「显示更多 / 收起」。只用 ResizeObserver 跟随内容自身高度，
 * 不用定时器；短消息不出现多余按钮。
 */
export function CollapsibleMessage({ children }: { children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [long, setLong] = useState(false)
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    const element = content.current
    if (!element) return
    const measure = () => setLong(element.scrollHeight > MESSAGE_FOLD_AFTER)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const folded = long && !open
  return <div className="ln-collapsible-message" data-folded={folded ? '' : undefined}>
    <div ref={frame} className={`ln-collapsible-frame${folded ? ' is-folded' : ''}`}>
      <div ref={content} className="ln-collapsible-content">{children}</div>
    </div>
    {long && <button type="button" className="ln-collapsible-toggle" aria-expanded={open}
      onClick={() => {
        setOpen(value => !value)
        if (open) requestAnimationFrame(() => frame.current?.scrollIntoView({ block: 'nearest' }))
      }}>{open ? '收起' : '显示更多'}</button>}
  </div>
}

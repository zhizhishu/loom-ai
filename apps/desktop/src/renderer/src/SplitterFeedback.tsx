import { createPortal } from 'react-dom'
import type { SplitterPhase } from './useCollapsibleSplitter'
import './splitter-feedback.css'

/** One transient confirmation for every collapsible boundary; never captures input. */
export function SplitterFeedback({ phase, target, label }: {
  phase: SplitterPhase
  target: HTMLElement | null
  label: string
}): React.JSX.Element | null {
  if (!target?.isConnected || phase !== 'detent') return null
  const rect = target.getBoundingClientRect()
  const horizontal = target.getAttribute('aria-orientation') === 'horizontal'
  const left = Math.max(8, Math.min(window.innerWidth - 240, horizontal ? rect.left + 16 : rect.right + 10))
  const top = Math.max(8, Math.min(window.innerHeight - 48, rect.top + (horizontal ? 14 : 64)))
  return createPortal(<div className="splitter-feedback" role="status" aria-live="polite" aria-atomic="true"
    style={{ left, top }}>
    {label}
  </div>, document.body)
}

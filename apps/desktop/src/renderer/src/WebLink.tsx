import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AppToast } from './AppToast'
import { uiAttribute } from './interface-language'
import { isWebUrl } from '../../web-url'
import { ResourceReferenceIcon } from './FilePreviewTabIcon'

export const WEB_LINK_OPEN_FAILED = '无法打开链接，请重试或复制地址。'
export const WEB_LINK_COPY_FAILED = '复制失败，请重试。'

export function openWebLink(target: string, onError: (message: string) => void): void {
  try {
    if (!isWebUrl(target)) throw new Error('Invalid web URL')
    // null is also the successful noopener result. Never retry an unknown outcome.
    window.open(target, '_blank', 'noopener,noreferrer')
  } catch { onError(uiAttribute(WEB_LINK_OPEN_FAILED)) }
}

export function WebLinkFeedback({ message, onClose }: { message: string | null; onClose(): void }): ReactNode {
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(onClose, 5000)
    return () => clearTimeout(timer)
  }, [message, onClose])
  return message && createPortal(<div data-quote-exclude data-file-find-exclude>
    <AppToast toast={{ message, tone: 'danger' }} onClose={onClose} />
  </div>, document.body)
}

export function WebLink({ target, children, className = 'message-web-reference' }: {
  target: string; children: ReactNode; className?: string
}): React.JSX.Element {
  const before = useRef<Range | null>(null)
  const [error, setError] = useState<string | null>(null)
  return <><a className={className} href={target} target="_blank" rel="noopener noreferrer" draggable={false}
    onPointerDown={() => {
      const selection = window.getSelection()
      before.current = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null
    }}
    onPointerCancel={() => { before.current = null }}
    onClick={event => {
      event.preventDefault()
      const previous = before.current
      before.current = null
      const selection = window.getSelection()
      if (event.detail > 0 && selection?.rangeCount && !selection.isCollapsed) {
        const range = selection.getRangeAt(0)
        if (!previous || range.compareBoundaryPoints(Range.START_TO_START, previous) !== 0
          || range.compareBoundaryPoints(Range.END_TO_END, previous) !== 0) return
      }
      openWebLink(target, setError)
    }}>
      <ResourceReferenceIcon kind="web" className="resource-reference-icon web-reference-icon" />
      {children}
    </a>
    <WebLinkFeedback message={error} onClose={() => setError(null)} /></>
}

import type { ReactNode } from 'react'
import { AppDialogGlyph, DialogControlIcon } from './AppDialog'
import { UiText, uiAttribute } from './interface-language'

export function MemoryChangeNotice({ children, review = false, onOpen, onClose }: {
  children: ReactNode
  review?: boolean
  onOpen(): void
  onClose(): void
}): React.JSX.Element {
  return <div className="memory-change-notice" role="status" aria-live="polite" aria-atomic="true">
    <AppDialogGlyph name={review ? 'clock' : 'brain'} />
    <span>{children}</span>
    <button className="memory-notice-open" type="button" onClick={onOpen}><UiText zh={review ? '查看审核' : '查看'} /><DialogControlIcon name="chevron" /></button>
    <button className="memory-notice-close" type="button" aria-label={uiAttribute('关闭记忆通知')} onClick={onClose}><DialogControlIcon name="close" /></button>
  </div>
}

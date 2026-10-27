import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { UiText, uiAttribute } from './interface-language'

/** Shared dismissal for the non-modal Thread detail and Single Chat surfaces. */
export function useThreadPanelDismiss({ visible, panelRef, onClose }: {
  visible: boolean
  panelRef: RefObject<HTMLElement | null>
  onClose(): void
}): (keyboard?: boolean) => void {
  const previousInput = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const rememberInput = (target: EventTarget | null): void => {
      if (!(target instanceof HTMLElement) || panelRef.current?.contains(target)) return
      if (target.matches('textarea, input:not([type="checkbox"]):not([type="radio"])') || target.isContentEditable) {
        previousInput.current = target
      }
    }
    rememberInput(document.activeElement)
    const onFocus = (event: FocusEvent): void => rememberInput(event.target)
    document.addEventListener('focusin', onFocus)
    return () => document.removeEventListener('focusin', onFocus)
  }, [panelRef])

  const dismiss = useCallback((keyboard = false): void => {
    const active = document.activeElement
    if (active instanceof HTMLElement && panelRef.current?.contains(active)) {
      const workspace = panelRef.current.closest('.camp-workspace')
      const target = [previousInput.current,
        workspace?.querySelector<HTMLElement>('.conversation-controls .structured-mention-editor'),
        workspace?.querySelector<HTMLElement>('.reply-detail-panel')
      ].find(node => node?.isConnected && node.getClientRects().length && !node.matches(':disabled'))
      if (keyboard && target) target.focus({ preventScroll: true })
      else active.blur()
    }
    onClose()
  }, [onClose, panelRef])

  useEffect(() => {
    if (!visible) return
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      if (document.querySelector('.app-dialog, .mention-profile-popover, [role="menu"][data-state="open"], [role="dialog"][data-state="open"]')) return
      // Tool results own their first Escape, returning to their command summary.
      if (event.target instanceof Element && event.target.closest('.tool-call-result-scroll')) return
      event.preventDefault()
      dismiss(true)
    }
    document.addEventListener('keydown', dismissOnEscape)
    return () => document.removeEventListener('keydown', dismissOnEscape)
  }, [visible, dismiss])

  return dismiss
}

export function ThreadPanelCollapseButton({ label, mobile, onDismiss }: {
  label: string
  mobile: boolean
  onDismiss(keyboard: boolean): void
}): React.JSX.Element {
  return <button className="camp-detail-collapse" type="button" aria-label={label}
    title={uiAttribute("收起 · Esc")} onClick={event => onDismiss(event.detail === 0)}>
    {!mobile && <span><UiText zh={"收起"} /></span>}
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={mobile ? 'm4 4 8 8m0-8-8 8' : 'm4 10 4-4 4 4'} />
    </svg>
  </button>
}

export function ThreadPanelDismissHint(): React.JSX.Element {
  return <span className="camp-detail-dismiss-hint"><kbd>Esc</kbd><UiText zh={" 收起"} /></span>
}

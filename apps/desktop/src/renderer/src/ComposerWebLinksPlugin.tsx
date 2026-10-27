import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useEffect, useRef, useState } from 'react'
import { registerComposerWebLinks, type ComposerWebLink } from './composer-web-links'
import { openWebLink, WebLinkFeedback, WEB_LINK_COPY_FAILED } from './WebLink'
import { WebLinkActions } from './WebLinkActions'
import { writeClipboardText } from './clipboard'
import { useUiText } from './interface-language'

export function ComposerWebLinksPlugin(): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const t = useUiText()
  const [active, setActive] = useState<ComposerWebLink | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const [error, setError] = useState<string | null>(null)
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null)
  const indexRef = useRef<ReturnType<typeof registerComposerWebLinks> | null>(null)
  const anchor = useRef({ getBoundingClientRect: () => activeRef.current?.range.getBoundingClientRect() ?? new DOMRect() })

  useEffect(() => {
    const close = (): void => setActive(null)
    const index = registerComposerWebLinks(editor, close)
    indexRef.current = index
    let removeRootListeners = (): void => {}
    const unregister = editor.registerRootListener(root => {
      removeRootListeners()
      close()
      // Keep link actions inside the dialog's focus and pointer boundary, outside
      // the writing plane that clips the description's scrollable content.
      setPortalHost(root?.closest<HTMLElement>('[role="dialog"]') ?? null)
      if (!root) return
      let down: { x: number; y: number } | null = null
      let dragged = false
      const pointerDown = (event: PointerEvent): void => {
        close()
        down = { x: event.clientX, y: event.clientY }; dragged = false
      }
      const pointerMove = (event: PointerEvent): void => {
        if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) {
          dragged = true; close()
        }
      }
      const cancel = (): void => { down = null; dragged = true; close() }
      const click = (event: MouseEvent): void => {
        down = null
        if (event.button !== 0 || event.detail > 1 || dragged || !editor.isEditable() || editor.isComposing()) return
        if (!window.getSelection()?.isCollapsed) return
        const link = index.current().find(link => [...link.range.getClientRects()].some(box =>
          event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom))
        if (!link) return
        const mac = window.rovai?.platform === 'darwin' || /Mac|iPhone|iPad/u.test(navigator.platform)
        if (mac ? event.metaKey : event.ctrlKey) {
          event.preventDefault()
          openWebLink(link.target, setError)
        } else setActive(link)
      }
      const keydown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape' && activeRef.current) {
          event.preventDefault(); event.stopPropagation(); close()
        } else if (!['Tab', 'Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) close()
      }
      root.addEventListener('pointerdown', pointerDown)
      root.addEventListener('click', click)
      root.addEventListener('beforeinput', close, true)
      root.addEventListener('compositionstart', close, true)
      root.addEventListener('keydown', keydown, true)
      root.addEventListener('pointercancel', cancel)
      window.addEventListener('pointermove', pointerMove)
      window.addEventListener('scroll', close, true)
      window.addEventListener('resize', close)
      removeRootListeners = () => {
        root.removeEventListener('pointerdown', pointerDown)
        root.removeEventListener('click', click)
        root.removeEventListener('beforeinput', close, true)
        root.removeEventListener('compositionstart', close, true)
        root.removeEventListener('keydown', keydown, true)
        root.removeEventListener('pointercancel', cancel)
        window.removeEventListener('pointermove', pointerMove)
        window.removeEventListener('scroll', close, true)
        window.removeEventListener('resize', close)
      }
    })
    return () => { unregister(); removeRootListeners(); index.destroy(); indexRef.current = null }
  }, [editor])

  const currentLink = (): ComposerWebLink | null => {
    if (!active || editor.isComposing() || !editor.isEditable()
      || !active.range.startContainer.isConnected
      || !indexRef.current?.current().includes(active)
      || active.range.toString() !== active.literal) return null
    return active
  }
  const copy = async (): Promise<void> => {
    const link = currentLink()
    if (!link) { setActive(null); return }
    const root = editor.getRootElement()
    const focused = document.activeElement
    const selection = window.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null
    const copied = await writeClipboardText(link.target)
    if (!indexRef.current?.current().includes(link)) return
    // The existing clipboard fallback temporarily selects a textarea. Restore
    // only that displaced editor selection, never focus stolen by later input.
    if (focused === root && document.activeElement === document.body && range?.startContainer.isConnected) {
      root?.focus({ preventScroll: true })
      selection?.removeAllRanges(); selection?.addRange(range)
    }
    if (!copied) setError(t(WEB_LINK_COPY_FAILED))
  }
  return <>
    <WebLinkActions target={active?.target ?? null} anchor={anchor} portalContainer={portalHost} onClose={() => setActive(null)}
      onOpen={() => { const link = currentLink(); if (link) openWebLink(link.target, setError); else setActive(null) }}
      onCopy={() => { void copy() }} />
    <WebLinkFeedback message={error} onClose={() => setError(null)} />
  </>
}

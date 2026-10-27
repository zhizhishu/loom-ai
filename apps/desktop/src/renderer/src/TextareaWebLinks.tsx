import { useEffect, useRef, useState, type RefObject } from 'react'
import { projectWebLinkRanges } from './safe-markdown-model'
import { WebLinkActions } from './WebLinkActions'
import { openWebLink, WebLinkFeedback, WEB_LINK_COPY_FAILED } from './WebLink'
import { writeClipboardText } from './clipboard'
import { useUiText } from './interface-language'

/** Native textarea keeps its own editing, selection, and undo behavior. Read the
 * caret after a click; no mirror, text replacement, or input-time parsing. */
export function TextareaWebLinks({ inputRef, value, enabled }: {
  inputRef: RefObject<HTMLTextAreaElement | null>
  value: string
  enabled: boolean
}): React.JSX.Element {
  const t = useUiText()
  const [active, setActive] = useState<{ source: string; target: string; x: number; y: number } | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const composing = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const anchor = useRef({ getBoundingClientRect: () => new DOMRect(activeRef.current?.x ?? 0, activeRef.current?.y ?? 0) })
  useEffect(() => { setActive(null) }, [value, enabled])
  useEffect(() => {
    const input = inputRef.current
    if (!input || !enabled) return
    const close = (): void => setActive(null)
    let down: { x: number; y: number } | null = null
    let dragged = false
    const pointerDown = (event: PointerEvent): void => {
      close(); down = { x: event.clientX, y: event.clientY }; dragged = false
    }
    const pointerMove = (event: PointerEvent): void => {
      if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) { dragged = true; close() }
    }
    const cancel = (): void => { down = null; dragged = true; close() }
    const click = (event: MouseEvent): void => {
      down = null
      if (event.button !== 0 || event.detail > 1 || dragged || composing.current || input.disabled
        || input.selectionStart !== input.selectionEnd) return
      const source = input.value
      // Blank/padding clicks can place the native caret at either URL endpoint.
      // Conservatively activate only positions strictly inside the URL.
      const link = projectWebLinkRanges(source).find(link => link.start < input.selectionStart && input.selectionStart < link.end)
      if (!link) return
      const mac = window.rovai?.platform === 'darwin' || /Mac|iPhone|iPad/u.test(navigator.platform)
      if (mac ? event.metaKey : event.ctrlKey) { event.preventDefault(); openWebLink(link.target, setError) }
      else setActive({ source, target: link.target, x: event.clientX, y: event.clientY })
    }
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && activeRef.current) { event.preventDefault(); event.stopPropagation(); close() }
      else if (!['Tab', 'Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) close()
    }
    const compositionStart = (): void => { composing.current = true; close() }
    const compositionEnd = (): void => { composing.current = false }
    input.addEventListener('pointerdown', pointerDown)
    input.addEventListener('pointercancel', cancel)
    input.addEventListener('click', click)
    input.addEventListener('beforeinput', close, true)
    input.addEventListener('input', close, true)
    input.addEventListener('keydown', keydown, true)
    input.addEventListener('compositionstart', compositionStart)
    input.addEventListener('compositionend', compositionEnd)
    window.addEventListener('pointermove', pointerMove)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      composing.current = false
      input.removeEventListener('pointerdown', pointerDown)
      input.removeEventListener('pointercancel', cancel)
      input.removeEventListener('click', click)
      input.removeEventListener('beforeinput', close, true)
      input.removeEventListener('input', close, true)
      input.removeEventListener('keydown', keydown, true)
      input.removeEventListener('compositionstart', compositionStart)
      input.removeEventListener('compositionend', compositionEnd)
      window.removeEventListener('pointermove', pointerMove)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [inputRef, enabled])
  const currentTarget = (): string | null => enabled && !composing.current && !inputRef.current?.disabled
    && active?.source === inputRef.current?.value ? active?.target ?? null : null
  const copy = async (): Promise<void> => {
    const target = currentTarget(), input = inputRef.current
    if (!target || !input) { setActive(null); return }
    const source = input.value, focused = document.activeElement === input
    const { selectionStart, selectionEnd, selectionDirection } = input
    const copied = await writeClipboardText(target)
    if (input.value !== source || !input.isConnected) return
    if (focused && document.activeElement === document.body) {
      input.focus({ preventScroll: true }); input.setSelectionRange(selectionStart, selectionEnd, selectionDirection)
    }
    if (!copied) setError(t(WEB_LINK_COPY_FAILED))
  }
  return <>
    <WebLinkActions target={active?.target ?? null} anchor={anchor} onClose={() => setActive(null)}
      onOpen={() => { const target = currentTarget(); if (target) openWebLink(target, setError); else setActive(null) }}
      onCopy={() => { void copy() }} />
    <WebLinkFeedback message={error} onClose={() => setError(null)} />
  </>
}

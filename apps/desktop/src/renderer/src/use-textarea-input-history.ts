import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { InputHistoryNavigation, isInputHistoryKey } from './input-history'

export function useTextareaInputHistory({
  target, getHistory, draft, setDraft, inputRef
}: {
  target: string | null
  getHistory(): string[]
  draft: string
  setDraft(value: string): void
  inputRef: RefObject<HTMLTextAreaElement | null>
}) {
  const current = useRef({ draft, setDraft, getHistory })
  current.current = { draft, setDraft, getHistory }
  const [preview, setPreview] = useState<string | null>(null)
  const previewRef = useRef<string | null>(null)
  const selection = useRef<{ start: number; end: number } | null>(null)
  const navigation = useMemo(() => target ? new InputHistoryNavigation(() => current.current.getHistory(), {
    capture: () => ({
      draft: current.current.draft,
      start: inputRef.current?.selectionStart ?? 0,
      end: inputRef.current?.selectionEnd ?? 0
    }),
    preview(text, boundary) {
      const offset = boundary === 'start' ? 0 : text.length
      selection.current = { start: offset, end: offset }
      previewRef.current = text
      setPreview(text)
    },
    restore(snapshot) {
      selection.current = snapshot
      previewRef.current = null
      setPreview(null)
      if (current.current.draft !== snapshot.draft) current.current.setDraft(snapshot.draft)
    }
  }) : null, [target, inputRef])

  const reset = (): void => {
    navigation?.adopt()
    previewRef.current = null
    selection.current = null
    setPreview(null)
  }
  useLayoutEffect(() => {
    reset()
    return () => { navigation?.adopt() }
  }, [navigation])
  // Explicit external replacements (e.g. returning Pending to the composer)
  // become the normal draft. Replacement actions also reset when the text is equal.
  useLayoutEffect(() => { reset() }, [draft])
  useLayoutEffect(() => {
    const position = selection.current
    if (!position) return
    inputRef.current?.setSelectionRange(position.start, position.end)
    selection.current = null
  }, [preview, draft])

  const value = preview ?? draft
  return {
    value,
    reset,
    cancel: () => navigation?.cancel(),
    edit(text: string) { reset(); current.current.setDraft(text) },
    adopt(): string {
      const text = previewRef.current ?? current.current.draft
      reset()
      current.current.setDraft(text)
      return text
    },
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
      if (!navigation || event.currentTarget.disabled || !isInputHistoryKey(event.nativeEvent)) return false
      const input = event.currentTarget
      if (input.selectionStart !== input.selectionEnd) return false
      if (event.key === 'Escape') {
        if (!navigation.cancel()) return false
      } else if (event.key === 'ArrowUp') {
        if (input.selectionStart !== 0 || !navigation.older()) return false
      } else {
        if (input.selectionEnd !== input.value.length || !navigation.newer()) return false
      }
      event.preventDefault()
      return true
    }
  }
}

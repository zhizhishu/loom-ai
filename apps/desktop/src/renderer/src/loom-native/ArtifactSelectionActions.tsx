import { useMemo, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Icon } from './icons'

/** Mikka `selection-actions.tsx`：选中文本上方给「引用 / 复制」，引用交给对话输入框。 */
export function ArtifactSelectionActions({ selection, onQuote, onClose }: {
  selection: { text: string; range: Range } | null
  onQuote(text: string): void
  onClose(): void
}) {
  const [copied, setCopied] = useState(false)
  const anchor = useMemo(() => ({ current: {
    getBoundingClientRect: () => selection?.range.getBoundingClientRect() ?? new DOMRect()
  } }), [selection])
  const quote = () => {
    if (!selection) return
    onQuote(selection.text)
    window.getSelection()?.removeAllRanges()
    onClose()
  }
  const copy = async () => {
    if (!selection) return
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard')
      await navigator.clipboard.writeText(selection.text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return <Popover.Root open={selection !== null} onOpenChange={open => { if (!open) onClose() }} modal={false}>
    {selection && <Popover.Anchor virtualRef={anchor}/>}
    {selection && <Popover.Content className="ln-selection-actions" side="top" sideOffset={8} collisionPadding={8}
      aria-label="引用所选文字" updatePositionStrategy="always" hideWhenDetached
      onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
      onMouseUp={event => event.stopPropagation()}>
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={quote}><Icon name="quote" size={13}/>引用</button>
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => { void copy() }}><Icon name={copied ? 'check' : 'copy'} size={13}/>{copied ? '已复制' : '复制'}</button>
    </Popover.Content>}
  </Popover.Root>
}

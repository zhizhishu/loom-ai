import type { JSX } from 'react'
import { uiAttribute } from './interface-language'

export function MessageQuotePreview({
  authorLabel,
  body,
  onReveal
}: {
  authorLabel: string
  body: string
  onReveal?(): void
}): JSX.Element {
  const excerpt = body.split(/\s+/u).filter(Boolean).join(' ')
  const label = `${authorLabel} · ${excerpt}`
  const preview = (
    <>
      <span className="reply-quote-prefix">{uiAttribute('回复')}</span>
      <strong>{authorLabel}</strong>
      <span>{excerpt}</span>
    </>
  )
  if (!onReveal) {
    return (
      <span className="reply-parent-quote is-static" title={label}>
        {preview}
      </span>
    )
  }
  return (
    <button className="reply-parent-quote" type="button" title={label} onClick={onReveal}>
      {preview}
    </button>
  )
}

export function ReplyMark(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.3 4.1 2.7 7.3l3.6 3.2M3 7.3h5.4c2.7 0 4.2 1.2 4.6 3.6" />
    </svg>
  )
}

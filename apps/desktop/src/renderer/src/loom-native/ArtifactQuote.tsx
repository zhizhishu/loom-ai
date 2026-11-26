import type { ReactNode } from 'react'
import type { ArtifactQuote } from './artifact-quote'
import { Icon } from './icons'

const words = (quote: ArtifactQuote) => quote.kind === 'element' ? quote.label ?? quote.text : quote.text

/** Mikka `artifact-quote.tsx` QuoteChip：输入框上方等待发送的一行引用，× 只移除引用。 */
export function ArtifactQuoteChip({ quote, onRemove }: { quote: ArtifactQuote; onRemove(): void }) {
  const text = words(quote)
  return <div className="ln-artifact-quote-chip" data-slot="artifact-quote-chip">
    <Icon name="quote" size={13}/>
    <span title={text}>{text}</span>
    <small>成果 v{quote.version}</small>
    <button type="button" aria-label="移除成果引用" title="移除成果引用" onClick={onRemove}><Icon name="close" size={12}/></button>
  </div>
}

/** Mikka `artifact-quote.tsx` QuoteLine：已发消息 bubble 顶部的引用行。 */
export function ArtifactQuoteLine({ quote, icon = null as ReactNode | null }: { quote: ArtifactQuote; icon?: ReactNode }) {
  return <div className="ln-artifact-quote-line" data-slot="artifact-quote" data-kind={quote.kind}>
    {icon ?? <Icon name="quote" size={13}/>}
    <span>{words(quote)}</span>
  </div>
}

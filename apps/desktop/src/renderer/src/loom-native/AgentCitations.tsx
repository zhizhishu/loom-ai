import { createContext, useContext, type ComponentProps } from 'react'
import { CITATION_HREF, type CitationKind } from './citations'
import { Icon } from './icons'

export type CitationReference = { kind: CitationKind; id: string; label?: string | null }
export type CitationContextValue = {
  resolve?: (id: string, kind: CitationKind | 'any') => CitationReference | null
  onOpen?: (reference: CitationReference) => void
}

/** Conversation-local citation facts and navigation. Null means chips degrade exactly as upstream does without lookup. */
export const AgentCitationContext = createContext<CitationContextValue | null>(null)

const shortId = (id: string) => id.slice(0, 8)

/** Compact task/run chip. Explicit citations keep their raw-id fallback when lookup has no fact. */
export function CitationChip({ id, kind }: { id: string; kind: CitationKind | 'any' }) {
  const context = useContext(AgentCitationContext)
  const resolved = context?.resolve?.(id, kind) ?? null
  if (kind === 'any' && !resolved) return <>{id}</>
  const reference: CitationReference = resolved ?? { kind: kind === 'any' ? 'run' : kind, id }
  const label = resolved?.label || `${reference.kind === 'issue' ? '任务' : '运行'} ${shortId(reference.id)}`
  const text = <><Icon name={reference.kind === 'issue' ? 'board' : 'branch'} size={12}/><span>{label}</span></>
  const className = 'ln-citation-chip'
  if (!context?.onOpen) return <span className={className} data-citation-kind={reference.kind} data-citation-id={reference.id}>{text}</span>
  return <button type="button" className={className} data-citation-kind={reference.kind} data-citation-id={reference.id}
    title={`打开${reference.kind === 'issue' ? '任务' : '运行'}引用`} aria-label={`打开${reference.kind === 'issue' ? '任务' : '运行'}引用：${label}`}
    onClick={() => context.onOpen?.(reference)}>{text}</button>
}

/** Markdown `a`: citation links become chips; ordinary links keep the existing external-link behaviour. */
export function CitationAnchor({ href, children, className: _className, ...props }: ComponentProps<'a'>) {
  const context = useContext(AgentCitationContext)
  if (href?.startsWith(CITATION_HREF)) {
    const [kind, id] = href.slice(CITATION_HREF.length).split('/') as [CitationKind | 'any', string]
    if ((kind === 'issue' || kind === 'run' || kind === 'any') && id) {
      if (kind === 'any' && !context?.resolve?.(id, 'any')) return <>{children}</>
      return <CitationChip id={id} kind={kind}/>
    }
  }
  return <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>
}

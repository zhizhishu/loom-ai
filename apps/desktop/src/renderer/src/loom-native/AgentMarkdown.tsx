import { Children, createContext, isValidElement, memo, use, type ComponentProps, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AgentCodeBlock } from './AgentCodeBlock'
import { AgentImage } from './AgentImage'
import { AgentMermaid } from './AgentMermaid'
import { AgentOpenUi } from './AgentOpenUi'
import { imageSourceInMessage, plainText } from './agent-images'
import { parseOpenUI } from './openui-lang'
import { remarkCitations, withoutPartialCitation } from './citations'
import { CitationAnchor } from './AgentCitations'

const MARKDOWN_PLUGINS = [remarkGfm, remarkCitations]

export type AgentMarkdownProps = {
  text: string
  isStreaming?: boolean
}

/** Whether the reply is still arriving, for the code and diagram blocks inside it. */
const MarkdownStreaming = createContext(false)

/**
 * Counterpart of Mikka `components/workspace/agent-markdown.tsx`, cut down to what this round carries:
 * GFM Markdown, Mermaid fences, OpenUI card fences, citation chips and message pictures. Upstream's math split (`agent-math-markdown`, KaTeX)
 * is not part of LOOM yet and is left out instead of stubbed. `img` is upstream's
 * `MarkdownImage` (agent-markdown.tsx:37-40) with one difference: upstream can refuse the picture because it
 * ships a lookup-driven illustration component, LOOM has no such lookup, so a message's own https URL is shown
 * and only an unusable one degrades to its alt text.
 */
export const AgentMarkdown = memo(function AgentMarkdown({ text, isStreaming = false }: AgentMarkdownProps) {
  const shown = isStreaming ? withoutPartialCitation(text) : text
  return <div data-agent-markdown className="ln-markdown">
    <MarkdownStreaming value={isStreaming}>
      <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} skipHtml components={components}>{shown}</ReactMarkdown>
    </MarkdownStreaming>
  </div>
})

function MarkdownTable({ node: _node, ...props }: ComponentProps<'table'> & { node?: unknown }) {
  return <div tabIndex={0} role="region" aria-label="Markdown 表格"><table {...props} /></div>
}

function MarkdownImage({ node: _node, src, alt, title }: ComponentProps<'img'> & { node?: unknown }) {
  const source = imageSourceInMessage(typeof src === 'string' ? src : undefined)
  if (!source) return <span className="ln-markdown-image-note">{plainText(alt) || '图片'}</span>
  return <AgentImage src={source} alt={alt ?? ''} caption={title} />
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  const isStreaming = use(MarkdownStreaming)
  const child = Children.toArray(children).find(child => isValidElement<{ className?: string; children?: ReactNode }>(child))
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return null
  const source = String(child.props.children ?? '').replace(/\n$/, '')
  const language = (/language-([^\s]+)/.exec(child.props.className ?? '')?.[1] ?? 'text').toLowerCase()
  // An OpenUI fence draws its cards where the reply parses as OpenUI, and keeps the source where it does not —
  // a reply still arriving, or a card the parser refuses, stays readable instead of turning into a half-drawn card.
  if (language === 'openui' && parseOpenUI(source) !== null) return <div className="ln-agent-code-block"><AgentOpenUi text={source}/></div>
  return <div className="ln-agent-code-block">{language === 'mermaid'
    ? <AgentMermaid source={source} isStreaming={isStreaming} />
    : <AgentCodeBlock code={source} language={language} isStreaming={isStreaming} />}</div>
}

/**
 * Defined once: react-markdown uses these as element types, so a new function per render would remount every
 * paragraph, chip and code block on each streamed token, replaying their enter animations (the chat flashed).
 */
const components: NonNullable<ComponentProps<typeof ReactMarkdown>['components']> = {
  a: ({ node: _node, ...props }) => <CitationAnchor {...props} />,
  img: MarkdownImage,
  pre: MarkdownPre,
  table: MarkdownTable,
}

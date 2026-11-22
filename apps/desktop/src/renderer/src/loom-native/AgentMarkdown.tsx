import { Children, createContext, isValidElement, memo, use, type ComponentProps, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AgentCodeBlock } from './AgentCodeBlock'
import { AgentMermaid } from './AgentMermaid'

const MARKDOWN_PLUGINS = [remarkGfm]

export type AgentMarkdownProps = {
  text: string
  isStreaming?: boolean
}

/** Whether the reply is still arriving, for the code and diagram blocks inside it. */
const MarkdownStreaming = createContext(false)

/**
 * Counterpart of Mikka `components/workspace/agent-markdown.tsx`, cut down to what this round carries:
 * GFM Markdown plus Mermaid fences. Upstream's math split (`agent-math-markdown`, KaTeX), citation remark
 * plugin and illustration image component are not part of LOOM yet and are left out instead of stubbed;
 * `img` therefore keeps the plain lazy `<img>` this shell already rendered.
 */
export const AgentMarkdown = memo(function AgentMarkdown({ text, isStreaming = false }: AgentMarkdownProps) {
  return <div data-agent-markdown className="ln-markdown">
    <MarkdownStreaming value={isStreaming}>
      <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} skipHtml components={components}>{text}</ReactMarkdown>
    </MarkdownStreaming>
  </div>
})

function MarkdownTable({ node: _node, ...props }: ComponentProps<'table'> & { node?: unknown }) {
  return <div tabIndex={0} role="region" aria-label="Markdown 表格"><table {...props} /></div>
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  const isStreaming = use(MarkdownStreaming)
  const child = Children.toArray(children).find(child => isValidElement<{ className?: string; children?: ReactNode }>(child))
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return null
  const source = String(child.props.children ?? '').replace(/\n$/, '')
  const language = /language-([^\s]+)/.exec(child.props.className ?? '')?.[1] ?? 'text'
  return <div className="ln-agent-code-block">{language.toLowerCase() === 'mermaid'
    ? <AgentMermaid source={source} isStreaming={isStreaming} />
    : <AgentCodeBlock code={source} language={language} isStreaming={isStreaming} />}</div>
}

/**
 * Defined once: react-markdown uses these as element types, so a new function per render would remount every
 * paragraph, chip and code block on each streamed token, replaying their enter animations (the chat flashed).
 */
const components: NonNullable<ComponentProps<typeof ReactMarkdown>['components']> = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  img: ({ node: _node, ...props }) => <img {...props} alt={props.alt || ''} loading="lazy" />,
  pre: MarkdownPre,
  table: MarkdownTable,
}

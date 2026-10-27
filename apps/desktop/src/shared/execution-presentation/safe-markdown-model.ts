import remarkGfm from 'remark-gfm'
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import remarkCjkFriendlyStrikethrough from 'remark-cjk-friendly-gfm-strikethrough/parseOnly'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

type MarkdownNode = {
  type?: unknown
  value?: unknown
  checked?: unknown
  children?: unknown
}

export type RawHtmlPolicy = 'text' | 'drop'

const safeMarkdownParser = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkCjkFriendly)
  .use(remarkCjkFriendlyStrikethrough, { singleTilde: false })

const omittedNodeTypes = new Set([
  'definition',
  'image',
  'imageReference'
])

const visibleStructuralNodeTypes = new Set([
  'blockquote',
  'code',
  'list',
  'table',
  'thematicBreak'
])

function markdownNodeHasRenderableContent(value: unknown, rawHtmlPolicy: RawHtmlPolicy): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const node = value as MarkdownNode
  const type = typeof node.type === 'string' ? node.type : ''
  if (type === 'html') return rawHtmlPolicy === 'text' && typeof node.value === 'string' && node.value.trim().length > 0
  if (omittedNodeTypes.has(type)) return false
  if (visibleStructuralNodeTypes.has(type)) return true
  if (
    (type === 'inlineCode' || type === 'text')
    && typeof node.value === 'string'
    && node.value.trim().length > 0
  ) {
    return true
  }
  if (type === 'listItem' && typeof node.checked === 'boolean') return true
  return Array.isArray(node.children)
    && node.children.some(child => markdownNodeHasRenderableContent(child, rawHtmlPolicy))
}

export function safeMarkdownHasRenderableContent(source: string, rawHtmlPolicy: RawHtmlPolicy = 'text'): boolean {
  if (!source.trim()) return false
  return markdownNodeHasRenderableContent(safeMarkdownParser.parse(source), rawHtmlPolicy)
}

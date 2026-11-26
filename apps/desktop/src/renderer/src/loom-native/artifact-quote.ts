export interface ArtifactQuote {
  artifactId: string
  version: number
  kind: 'text' | 'element'
  text: string
  label?: string
  selector?: string
}

export const QUOTE_TEXT_MAX = 2000

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, ' ')
const escapeBody = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const unescape = (value: string) => value.replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&')

export function withQuote(text: string, quote: ArtifactQuote | null | undefined): string {
  if (!quote) return text
  const attributes = [`artifact="${escapeAttribute(quote.artifactId)}"`, `version="${quote.version}"`, `kind="${quote.kind}"`]
  if (quote.label) attributes.push(`label="${escapeAttribute(quote.label)}"`)
  if (quote.selector) attributes.push(`selector="${escapeAttribute(quote.selector)}"`)
  return `<quote ${attributes.join(' ')}>${escapeBody(quote.text.slice(0, QUOTE_TEXT_MAX))}</quote>\n${text}`
}

const QUOTE = /^<quote ((?:[a-z]+="[^"]*"\s*)+)>([\s\S]*?)<\/quote>\n?/

export function splitQuote(message: string): { quote: ArtifactQuote | null; text: string } {
  const match = QUOTE.exec(message)
  if (!match) return { quote: null, text: message }
  const attributes = Object.fromEntries([...match[1].matchAll(/([a-z]+)="([^"]*)"/g)].map(([, key, value]) => [key, unescape(value)]))
  const version = Number(attributes.version)
  if (!attributes.artifact || !Number.isInteger(version) || version < 1 || (attributes.kind !== 'text' && attributes.kind !== 'element')) return { quote: null, text: message }
  return {
    quote: {
      artifactId: attributes.artifact,
      version,
      kind: attributes.kind,
      text: unescape(match[2]),
      ...(attributes.label ? { label: attributes.label } : {}),
      ...(attributes.selector ? { selector: attributes.selector } : {})
    },
    text: message.slice(match[0].length)
  }
}

function selectorWithin(root: HTMLElement, target: Element): string {
  const parts: string[] = []
  let current: Element | null = target
  while (current && current !== root) {
    const parent: Element | null = current.parentElement
    if (!parent) break
    const index = Array.prototype.indexOf.call(parent.children, current) + 1
    parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${index})`)
    current = parent
  }
  return parts.join('>')
}

export function quoteFromSelection(artifactId: string, root: HTMLElement | null, kind: 'text' | 'element', fileName: string): ArtifactQuote | null {
  if (!root || typeof window === 'undefined') return null
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const text = selection.toString().trim().slice(0, QUOTE_TEXT_MAX)
  if (!text) return null
  if (kind === 'text') return { artifactId, version: 1, kind, text }
  const node = range.commonAncestorContainer
  const element = node instanceof Element ? node : node.parentElement
  if (!element || !root.contains(element)) return null
  return { artifactId, version: 1, kind, text, label: `元素 · ${fileName}`, selector: selectorWithin(root, element) }
}

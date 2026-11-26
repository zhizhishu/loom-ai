// Mikka `lib/artifacts/quote.ts`：成果选文放在消息开头，助手按原位读到，
// 聊天界面再把它拆出来画在正文上方。
//   <quote artifact="<id>" version="2" kind="text">核对首页并保存截图</quote>
//   请把首页截图放大一点

export interface ArtifactQuote {
  artifactId: string
  version: number
  kind: 'text' | 'element'
  /** The quoted words, or the element's text. */
  text: string
  /** For an element: its chip label, such as 「卡片 · 首页截图」. */
  label?: string
  /** For an element: a CSS selector that finds it in that version. */
  selector?: string
}

export const QUOTE_TEXT_MAX = 2000

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, ' ')
const escapeBody = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const unescape = (value: string) => value.replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&')

/** The message text with the quote in front. */
export function withQuote(text: string, quote: ArtifactQuote | null | undefined): string {
  if (!quote) return text
  const attributes = [`artifact="${escapeAttribute(quote.artifactId)}"`, `version="${quote.version}"`, `kind="${quote.kind}"`]
  if (quote.label) attributes.push(`label="${escapeAttribute(quote.label)}"`)
  if (quote.selector) attributes.push(`selector="${escapeAttribute(quote.selector)}"`)
  return `<quote ${attributes.join(' ')}>${escapeBody(quote.text.slice(0, QUOTE_TEXT_MAX))}</quote>\n${text}`
}

const QUOTE = /^<quote ((?:[a-z]+="[^"]*"\s*)+)>([\s\S]*?)<\/quote>\n?/

/** Splits a stored message into its quote, if it starts with one, and the rest. */
export function splitQuote(message: string): { quote: ArtifactQuote | null; text: string } {
  const match = QUOTE.exec(message)
  if (!match) return { quote: null, text: message }
  const attributes = Object.fromEntries([...match[1].matchAll(/([a-z]+)="([^"]*)"/g)].map(([, key, value]) => [key, unescape(value)]))
  const version = Number(attributes.version)
  if (!attributes.artifact || !Number.isInteger(version) || version < 1 || (attributes.kind !== 'text' && attributes.kind !== 'element')) return { quote: null, text: message }
  return {
    quote: {
      artifactId: attributes.artifact, version, kind: attributes.kind, text: unescape(match[2]),
      ...(attributes.label ? { label: attributes.label } : {}),
      ...(attributes.selector ? { selector: attributes.selector } : {})
    },
    text: message.slice(match[0].length)
  }
}

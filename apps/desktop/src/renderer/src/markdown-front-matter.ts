import { isMap, parseDocument, stringify as stringifyYaml } from 'yaml'

export interface MarkdownMetadataField {
  key: string
  value: string
}

export type MarkdownFrontMatter =
  | { kind: 'metadata'; fields: MarkdownMetadataField[] }
  | { kind: 'error'; raw: string }

export interface ParsedMarkdownDocument {
  body: string
  frontMatter: MarkdownFrontMatter | null
}

interface FrontMatterBoundary {
  body: string
  inner: string
  raw: string
}

const FRONT_MATTER_DELIMITER = /^---[ \t]*$/u
const METADATA_KEY_LINE = /^(?:[A-Za-z_][A-Za-z0-9_.-]*|'[^'\r\n]+'|"[^"\r\n]+")\s*:/mu

function readLine(source: string, start: number): { content: string; next: number } {
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (character !== '\n' && character !== '\r') continue
    const newlineLength = character === '\r' && source[index + 1] === '\n' ? 2 : 1
    return { content: source.slice(start, index), next: index + newlineLength }
  }
  return { content: source.slice(start), next: source.length }
}

function frontMatterBoundary(source: string): FrontMatterBoundary | null {
  const firstLineStart = source.charCodeAt(0) === 0xfeff ? 1 : 0
  const firstLine = readLine(source, firstLineStart)
  if (!FRONT_MATTER_DELIMITER.test(firstLine.content) || firstLine.next === source.length) return null

  let lineStart = firstLine.next
  while (lineStart < source.length) {
    const line = readLine(source, lineStart)
    if (FRONT_MATTER_DELIMITER.test(line.content)) {
      return {
        body: source.slice(line.next),
        inner: source.slice(firstLine.next, lineStart),
        raw: source.slice(0, line.next)
      }
    }
    lineStart = line.next
  }
  return null
}

function scalarText(value: unknown): string | null {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return value === '' ? '""' : value
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value)
  return null
}

function metadataKey(value: unknown): string {
  const key = scalarText(value)
  if (key === null) throw new Error('Metadata keys must be scalar values')
  return key
}

function metadataValue(value: unknown): string {
  const scalar = scalarText(value)
  if (scalar !== null) return scalar
  if (!(Array.isArray(value) || value instanceof Map)) throw new Error('Unsupported metadata value')
  return stringifyYaml(value, {
    collectionStyle: 'block',
    indent: 2,
    lineWidth: 0
  }).trimEnd()
}

function unchanged(source: string): ParsedMarkdownDocument {
  return { body: source, frontMatter: null }
}

/**
 * Projects only a closed YAML mapping at the very start of a Markdown file.
 * Ambiguous horizontal rules, fenced examples, and unclosed headers remain in
 * the Markdown body so presentation parsing can never swallow ordinary prose.
 */
export function parseMarkdownFrontMatter(source: string): ParsedMarkdownDocument {
  const boundary = frontMatterBoundary(source)
  if (!boundary) return unchanged(source)
  if (!boundary.inner.trim()) return { body: boundary.body, frontMatter: null }

  try {
    const document = parseDocument(boundary.inner, {
      intAsBigInt: true,
      prettyErrors: false,
      schema: 'core',
      strict: true,
      uniqueKeys: true
    })
    if (document.errors.length || document.warnings.length) {
      return METADATA_KEY_LINE.test(boundary.inner)
        ? { body: boundary.body, frontMatter: { kind: 'error', raw: boundary.raw } }
        : unchanged(source)
    }
    if (!isMap(document.contents)) return unchanged(source)

    const values = document.toJS({ mapAsMap: true, maxAliasCount: 100 }) as unknown
    if (!(values instanceof Map)) return unchanged(source)
    const fields = [...values.entries()].map(([key, value]) => ({
      key: metadataKey(key),
      value: metadataValue(value)
    }))
    return {
      body: boundary.body,
      frontMatter: fields.length ? { kind: 'metadata', fields } : null
    }
  } catch {
    return METADATA_KEY_LINE.test(boundary.inner)
      ? { body: boundary.body, frontMatter: { kind: 'error', raw: boundary.raw } }
      : unchanged(source)
  }
}

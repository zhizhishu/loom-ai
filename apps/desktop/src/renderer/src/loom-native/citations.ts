/** Shared message syntax copied from Mikka `lib/coordinator/citation-parts.ts` and `citations.ts`. */
export type CitationKind = 'issue' | 'run'

export type CitationPart =
  | { type: 'text'; text: string }
  | { type: 'citation'; kind: CitationKind | null; id: string; raw: string }
  | { type: 'link'; url: string; label: string | null; raw: string }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const URL_CHARS = '[^\\s<>()\\[\\]"\'`\\u0080-\\uffff]+'
const CITATION = new RegExp(`\\[([^\\]\\n]{1,200})\\]\\((https?://${URL_CHARS})\\)|(https?://${URL_CHARS})|\\[\\[(issue|run):(${UUID})\\]\\]|\\b(${UUID})\\b`, 'gi')
const TRAILING = /[.,;:!?。，；：！？、）]+$/

/** Splits reply text into plain text, issue/run citations and web links, in order. */
export function splitCitations(text: string): CitationPart[] {
  const parts: CitationPart[] = []
  let last = 0
  for (const match of text.matchAll(CITATION)) {
    if (match.index > last) parts.push({ type: 'text', text: text.slice(last, match.index) })
    let raw = match[0]
    if (match[2]) parts.push({ type: 'link', url: match[2], label: match[1].trim() || null, raw })
    else if (match[3]) {
      raw = match[3].replace(TRAILING, '')
      parts.push({ type: 'link', url: raw, label: null, raw })
    } else parts.push({ type: 'citation', kind: match[4] ? match[4].toLowerCase() as CitationKind : null, id: (match[5] ?? match[6]).toLowerCase(), raw })
    last = match.index + raw.length
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) })
  return parts
}

/** Marks a run cited directly after its issue; the blank gap belongs to the pair, not to the sentence. */
export function pairCitations(parts: readonly CitationPart[]): (CitationPart & { after?: string })[] {
  const out: (CitationPart & { after?: string })[] = []
  for (const part of parts) {
    const gap = out.at(-1), before = gap?.type === 'text' && !gap.text.trim() && !gap.text.includes('\n') ? out.at(-2) : gap
    if (part.type === 'citation' && part.kind === 'run' && before?.type === 'citation' && before.kind === 'issue') {
      if (gap !== before) out.pop()
      out.push({ ...part, after: before.id })
    } else out.push(part)
  }
  return out
}

const PARTIAL_CITATION = /\[(?:\[(?:i(?:s(?:s(?:u(?:e(?::[0-9a-f-]{0,36}\]?)?)?)?)?)?|r(?:u(?:n(?::[0-9a-f-]{0,36}\]?)?)?)?)?)?$/i

/** Streamed text without a citation that has not fully arrived, so its marker never shows before its chip. */
export function withoutPartialCitation(text: string): string {
  return text.replace(PARTIAL_CITATION, '')
}

export const CITATION_HREF = '#cite/'

type MdastNode = { type: string; value?: string; url?: string; children?: MdastNode[] }

/**
 * Mikka `remarkCitations`: citations and bare ids become links rendered as chips;
 * plain-text line breaks stay line breaks. Existing links and code are left alone.
 */
export function remarkCitations() {
  const autolink = (link: MdastNode): MdastNode[] => {
    const [first, ...rest] = splitCitations(link.url ?? '')
    if (first?.type !== 'link' || !rest.length) return [link]
    return [
      { type: 'link', url: first.url, children: [{ type: 'text', value: first.url }] },
      { type: 'text', value: rest.map(part => part.type === 'text' ? part.text : part.raw).join('') }
    ]
  }
  return (tree: MdastNode) => {
    const walk = (node: MdastNode) => {
      if (!node.children || node.type === 'link' || node.type === 'linkReference') return
      node.children = node.children.flatMap(child => {
        if (child.type === 'link' && child.children?.length === 1 && child.children[0].value === child.url) return autolink(child)
        if (child.type !== 'text' || !child.value) { walk(child); return [child] }
        return pairCitations(splitCitations(child.value)).flatMap<MdastNode>(part => {
          if (part.type === 'citation') return [{ type: 'link', url: `${CITATION_HREF}${part.kind ?? 'any'}/${part.id}${part.after ? `/after/${part.after}` : ''}`, children: [{ type: 'text', value: part.raw }] }]
          if (part.type === 'link') return [{ type: 'link', url: part.url, children: [{ type: 'text', value: part.label ?? part.url }] }]
          return part.text.split('\n').flatMap((line, index) => [...(index ? [{ type: 'break' } as MdastNode] : []), ...(line ? [{ type: 'text', value: line } as MdastNode] : [])])
        })
      })
    }
    walk(tree)
  }
}

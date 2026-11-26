import { diffArrays } from 'diff'

// Inline differences between two versions of a Markdown artifact. The older
// version is the one on screen: what the newer one dropped shows struck
// through, what it added shows on a light green ground. The diff runs on the
// Markdown source, line by line and then word by word inside changed lines;
// changed words are wrapped in private-use characters that remarkDiff turns
// into <del> and <ins> after parsing, so Markdown syntax is never broken by
// inserted tags.

const INS_OPEN = ''
const INS_CLOSE = ''
const DEL_OPEN = ''
const DEL_CLOSE = ''
const MARKERS = /[-]/g

/** Tokens that carry Markdown structure stay outside the marks. */
const SYNTAX = /^(?:\s+|[|#>*_`~\-+:]+|\d+[.)])$/

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null

function words(line: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(line), part => part.segment)
  return line.match(/\s+|[\p{L}\p{N}_]+|./gu) ?? []
}

/** Wraps each run of real words in `open`/`close`, leaving syntax and spaces bare. */
function mark(tokens: readonly string[], open: string, close: string): string {
  let out = ''
  let inside = false
  for (const token of tokens) {
    const bare = SYNTAX.test(token)
    if (bare && inside) { out += close; inside = false }
    if (!bare && !inside) { out += open; inside = true }
    out += token
  }
  return inside ? out + close : out
}

/** A whole line added or dropped: its list, heading or quote prefix stays bare. */
function markLine(line: string, open: string, close: string): string {
  const prefix = /^\s*(?:(?:[-*+]|\d+[.)]|#{1,6}|>)\s+)?/.exec(line)?.[0] ?? ''
  return prefix + mark(words(line.slice(prefix.length)), open, close)
}

interface Change { removed: string[]; added: string[] }
type Part = string[] | Change

/**
 * Word changes in one line, with short unchanged bits between two changes
 * folded into them, so 「登录页面已打开」→「登录成功，已跳转到首页」 reads as one
 * phrase replaced rather than a scatter of single characters.
 */
function lineParts(older: string, newer: string): Part[] {
  const parts: Part[] = []
  for (const part of diffArrays(words(older), words(newer))) {
    const last = parts.at(-1)
    const change = last && !Array.isArray(last) ? last : null
    if (part.removed || part.added) {
      const target = change ?? { removed: [], added: [] }
      if (!change) parts.push(target)
      target[part.removed ? 'removed' : 'added'].push(...part.value)
    } else parts.push(part.value)
  }
  for (let index = 1; index < parts.length - 1; index++) {
    const same = parts[index]
    const before = parts[index - 1]
    const after = parts[index + 1]
    if (!Array.isArray(same) || Array.isArray(before) || Array.isArray(after) || same.join('').replace(/\s/g, '').length > 2) continue
    parts.splice(index - 1, 3, { removed: [...before.removed, ...same, ...after.removed], added: [...before.added, ...same, ...after.added] })
    index = 0
  }
  // A short word stub left between a change and a cell edge or punctuation goes with the change too: 「待补充」→「已补充」 rather than 「待」→「已」.
  const edge = (token: string) => SYNTAX.test(token) || /^[\p{P}\s]+$/u.test(token)
  const short = (tokens: readonly string[]) => tokens.length > 0 && tokens.join('').length <= 2
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (Array.isArray(part)) continue
    const before = parts[index - 1]
    if (Array.isArray(before)) {
      let start = before.length
      while (start > 0 && !edge(before[start - 1])) start--
      const stub = before.slice(start)
      if (short(stub) && (start === 0 || edge(before[start - 1]))) {
        before.splice(start)
        part.removed.unshift(...stub)
        part.added.unshift(...stub)
      }
    }
    const after = parts[index + 1]
    if (Array.isArray(after)) {
      let end = 0
      while (end < after.length && !edge(after[end])) end++
      const stub = after.slice(0, end)
      if (short(stub)) {
        after.splice(0, end)
        part.removed.push(...stub)
        part.added.push(...stub)
      }
    }
  }
  return parts
}

function changedLine(older: string, newer: string): string {
  return lineParts(older, newer).map(part => Array.isArray(part)
    ? part.join('')
    : mark(part.removed, DEL_OPEN, DEL_CLOSE) + mark(part.added, INS_OPEN, INS_CLOSE)).join('')
}

/** Takes the markers out of agent text, so only the diff can make them. */
export function stripDiffMarkers(text: string): string {
  return text.replace(MARKERS, '')
}

/** The older source with the newer one's changes marked in. Both are plain Markdown. */
export function markdownDiff(older: string, newer: string): string {
  const out: string[] = []
  const parts = diffArrays(stripDiffMarkers(older).split('\n'), stripDiffMarkers(newer).split('\n'))
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    const next = parts[index + 1]
    if (part.removed && next?.added) {
      // Changed lines pair up in order; the rest are whole lines dropped or added.
      const pairs = Math.min(part.value.length, next.value.length)
      for (let line = 0; line < pairs; line++) out.push(changedLine(part.value[line], next.value[line]))
      for (const line of part.value.slice(pairs)) out.push(line.trim() ? markLine(line, DEL_OPEN, DEL_CLOSE) : line)
      for (const line of next.value.slice(pairs)) out.push(line.trim() ? markLine(line, INS_OPEN, INS_CLOSE) : line)
      index++
    } else if (part.removed) out.push(...part.value.map(line => line.trim() ? markLine(line, DEL_OPEN, DEL_CLOSE) : line))
    else if (part.added) out.push(...part.value.map(line => line.trim() ? markLine(line, INS_OPEN, INS_CLOSE) : line))
    else out.push(...part.value)
  }
  return out.join('\n')
}

type MdastNode = { type: string; value?: string; children?: MdastNode[]; data?: Record<string, unknown> }

/**
 * Remark plugin: turns the markers into `del` and `ins` elements. A mark may
 * open in one text node and close in a later one (across emphasis or table
 * cells), so the walk keeps the open mark as it goes. Code keeps its text
 * without marks.
 */
export function remarkDiff() {
  return (tree: MdastNode) => {
    let mode: 'ins' | 'del' | null = null
    const wrap = (value: string): MdastNode => mode
      ? { type: mode === 'ins' ? 'diffInsert' : 'diffDelete', data: { hName: mode }, children: [{ type: 'text', value }] }
      : { type: 'text', value }
    const walk = (node: MdastNode) => {
      if (!node.children) return
      node.children = node.children.flatMap(child => {
        if ((child.type === 'code' || child.type === 'inlineCode') && child.value) { child.value = stripDiffMarkers(child.value); return [child] }
        if (child.type !== 'text' || !child.value) { walk(child); return [child] }
        const out: MdastNode[] = []
        let buffer = ''
        for (const char of child.value) {
          const next = char === INS_OPEN ? 'ins' : char === DEL_OPEN ? 'del' : char === INS_CLOSE || char === DEL_CLOSE ? null : undefined
          if (next === undefined) { buffer += char; continue }
          if (buffer) out.push(wrap(buffer))
          buffer = ''
          mode = next
        }
        if (buffer) out.push(wrap(buffer))
        return out
      })
    }
    walk(tree)
  }
}

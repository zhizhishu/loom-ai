/**
 * Counterpart of Mikka `lib/openui-lang.ts`, copied whole: parser, signatures, text fallback and the chip
 * Markdown. It is the card format the Coordinator writes when a card helps more than text: `root = Stack([...])`,
 * more `name = Expr` lines it may refer to, components called with positional arguments, JSON-like strings,
 * arrays and objects with bare keys. No imports, so the reader carries over verbatim.
 *
 * LOOM has no `@openuidev/react-lang` and adds no packages, so `AgentOpenUi.tsx` draws the cards this file reads
 * with the shell's own elements instead of OpenUI's renderer. `isImageQuery` stays the reader-side rule only:
 * LOOM has no image lookup yet (M8 r2 reads the `src` a reply carries), so nothing on this side searches.
 */

export type Value = string | number | boolean | null | Value[] | { [key: string]: Value } | Component
export interface Component { kind: 'component'; name: string; props: Record<string, Value>; args: Value[] }

/** Argument names in signature order (lib/agent-ui.spec.json), for the components the app draws or reads text from. */
const SIGNATURES: Record<string, string[]> = {
  Stack: ['children', 'direction', 'gap', 'align', 'justify', 'wrap'],
  BeResponse: ['children'],
  TextContent: ['text', 'size'],
  InlineText: ['parts'],
  BeCard: ['title', 'children', 'description'],
  BeQuestions: ['context', 'questions'],
  BeApproval: ['title', 'description', 'context'],
  BeFollowUps: ['items'],
  BeButton: ['label', 'action', 'variant'],
  BeCardGrid: ['children'],
  BeImageCard: ['title', 'query', 'description', 'tags', 'prompt'],
  BeImage: ['query', 'alt', 'caption'],
  TaskChip: ['id'],
  RunChip: ['id'],
  SourceChip: ['url', 'label'],
}

/** Image search words the server accepts (agentImageQuery in lib/agent-images.ts): 2–160 characters, no line breaks, tags or links. */
export function isImageQuery(query: string) {
  const value = query.trim()
  return value.length >= 2 && value.length <= 160 && !/[\r\n<>]/.test(value) && !/https?:\/\//i.test(value)
}

/**
 * Where a reply's OpenUI starts: the first line that assigns `root`, outside a
 * fenced code block, as the web's chat finds it (lib/agent-ui-source.ts).
 * Words the bot wrote before it are its prose, shown above the cards.
 */
export function splitOpenUI(text: string): { prose: string; source: string } | null {
  const match = /(^|\n)[ \t]*root[ \t]*=/.exec(text)
  if (!match) return null
  const at = match.index + match[1].length
  const before = text.slice(0, at)
  if ((before.match(/(^|\n)[ \t]*(```|~~~)/g) ?? []).length % 2) return null
  return { prose: before.trim(), source: text.slice(at) }
}

/** Whether a reply is OpenUI rather than Markdown. */
export const isOpenUI = (text: string) => splitOpenUI(text) !== null

class Reader {
  i = 0
  constructor(readonly text: string) {}

  space() {
    while (this.i < this.text.length) {
      const c = this.text[this.i]
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') this.i++
      else if (c === '/' && this.text[this.i + 1] === '/') { while (this.i < this.text.length && this.text[this.i] !== '\n') this.i++ }
      else break
    }
  }

  peek() { this.space(); return this.text[this.i] }

  expect(c: string) {
    if (this.peek() !== c) throw new Error(`expected ${c} at ${this.i}`)
    this.i++
  }

  identifier(): string | null {
    this.space()
    const match = /^[A-Za-z_$][\w$]*/.exec(this.text.slice(this.i))
    if (!match) return null
    this.i += match[0].length
    return match[0]
  }

  string(): string {
    const quote = this.text[this.i++]
    let out = ''
    while (this.i < this.text.length) {
      const c = this.text[this.i++]
      if (c === quote) return out
      if (c !== '\\') { out += c; continue }
      const e = this.text[this.i++]
      if (e === 'n') out += '\n'
      else if (e === 't') out += '\t'
      else if (e === 'r') out += '\r'
      else if (e === 'u') { out += String.fromCharCode(parseInt(this.text.slice(this.i, this.i + 4), 16)); this.i += 4 }
      else out += e
    }
    throw new Error('unterminated string')
  }

  list(close: string): Value[] {
    const items: Value[] = []
    while (this.peek() !== close) {
      if (this.i >= this.text.length) throw new Error(`expected ${close}`)
      items.push(this.value())
      if (this.peek() === ',') this.i++
    }
    this.i++
    return items
  }

  value(): Value {
    const c = this.peek()
    if (c === '"' || c === "'") return this.string()
    if (c === '[') { this.i++; return this.list(']') }
    if (c === '{') {
      this.i++
      const object: Record<string, Value> = {}
      while (this.peek() !== '}') {
        if (this.i >= this.text.length) throw new Error('expected }')
        const at = this.peek()
        const key = at === '"' || at === "'" ? this.string() : this.identifier()
        if (key === null) throw new Error(`expected a key at ${this.i}`)
        this.expect(':')
        object[key] = this.value()
        if (this.peek() === ',') this.i++
      }
      this.i++
      return object
    }
    const number = /^-?\d+(\.\d+)?/.exec(this.text.slice(this.i))
    if (number) { this.i += number[0].length; return Number(number[0]) }
    const name = this.identifier()
    if (name === null) throw new Error(`unexpected ${c ?? 'end'} at ${this.i}`)
    if (name === 'true' || name === 'false') return name === 'true'
    if (name === 'null' || name === 'undefined') return null
    if (this.peek() === '(') {
      this.i++
      const args = this.list(')')
      const names = SIGNATURES[name] ?? []
      const props: Record<string, Value> = {}
      args.forEach((arg, index) => { if (names[index]) props[names[index]] = arg })
      return { kind: 'component', name, props, args }
    }
    return { kind: 'component', name: '$ref', props: { name }, args: [] }
  }
}

function resolve(value: Value, statements: Map<string, Value>, depth = 0): Value {
  if (depth > 20 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => resolve(item, statements, depth + 1))
  if (isComponent(value)) {
    if (value.name === '$ref') {
      const target = statements.get(String(value.props.name))
      return target === undefined ? null : resolve(target, statements, depth + 1)
    }
    const props: Record<string, Value> = {}
    for (const [key, prop] of Object.entries(value.props)) props[key] = resolve(prop, statements, depth + 1)
    return { ...value, props, args: value.args.map(arg => resolve(arg, statements, depth + 1)) }
  }
  const object: Record<string, Value> = {}
  for (const [key, item] of Object.entries(value)) object[key] = resolve(item, statements, depth + 1)
  return object
}

export function isComponent(value: Value | undefined): value is Component {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as Component).kind === 'component')
}

function readStatements(text: string) {
  const split = splitOpenUI(text)
  if (!split) return null
  try {
    const reader = new Reader(split.source)
    const statements = new Map<string, Value>()
    let roots = 0
    while (reader.peek() !== undefined) {
      const name = reader.identifier()
      if (!name) throw new Error(`expected a statement at ${reader.i}`)
      reader.expect('=')
      statements.set(name, reader.value())
      if (name === 'root') roots++
      if (reader.peek() === ';') reader.i++
    }
    return { statements, roots }
  } catch {
    return null
  }
}

/** Several SDK messages can settle into one reply. Only the final root assignment is displayed. */
export function openUIRootCount(text: string): number {
  return readStatements(text)?.roots ?? 0
}

export function parseOpenUI(text: string): Value | null {
  const document = readStatements(text)
  const root = document?.statements.get('root')
  try {
    return document && root !== undefined ? resolve(root, document.statements) : null
  } catch {
    // Component-shaped objects with invalid props or args retain the text fallback.
    return null
  }
}

export const str = (value: Value | undefined) => typeof value === 'string' ? value : ''
export const arr = (value: Value | undefined): Value[] => Array.isArray(value) ? value : []
export const obj = (value: Value | undefined): Record<string, Value> =>
  value && typeof value === 'object' && !Array.isArray(value) && !isComponent(value) ? value as Record<string, Value> : {}

/** InlineText parts and chips as Markdown with the chat's citation tokens, so the Markdown view draws them as chips. */
export function inlineMarkdown(value: Value | undefined): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(inlineMarkdown).join('')
  if (!isComponent(value)) return ''
  if (value.name === 'TaskChip') return `[[issue:${str(value.props.id)}]]`
  if (value.name === 'RunChip') return `[[run:${str(value.props.id)}]]`
  if (value.name === 'SourceChip') {
    const url = str(value.props.url)
    return url ? `[${str(value.props.label) || url}](${url})` : ''
  }
  if (value.name === 'InlineText') return inlineMarkdown(value.props.parts)
  return ''
}

/**
 * The words in a card, one block per line: what a reply shows where its card
 * cannot be drawn, and what a push says about it. Ids, styles and prompts
 * the person never sees are left out.
 */
export function openUIText(value: Value | undefined): string {
  const lines: string[] = []
  const walk = (node: Value | undefined) => {
    if (typeof node === 'string') { if (node.trim()) lines.push(node.trim()); return }
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node === null || node === undefined || typeof node !== 'object') return
    if (!isComponent(node)) {
      for (const key of ['title', 'label', 'text', 'content', 'detail']) walk(obj(node)[key])
      return
    }
    switch (node.name) {
      case 'TextContent': walk(node.props.text); return
      case 'InlineText': lines.push(inlineMarkdown(node.props.parts)); return
      case 'BeCard': walk(node.props.title); walk(node.props.description); walk(node.props.children); return
      case 'BeApproval': walk(node.props.title); walk(node.props.description); return
      case 'BeQuestions':
        for (const question of arr(node.props.questions)) {
          walk(obj(question).title)
          for (const option of arr(obj(question).options)) {
            const label = str(obj(option).label)
            if (label) lines.push(`- ${label}`)
          }
        }
        return
      case 'BeFollowUps':
        for (const item of arr(node.props.items)) {
          const label = str(obj(item).label)
          if (label) lines.push(`- ${label}`)
        }
        return
      case 'BeButton': walk(node.props.label); return
      // The image search words are English for the lookup, not for the person.
      case 'BeImageCard': walk(node.props.title); walk(node.props.description); return
      case 'BeImage': walk(node.props.caption); return
      case 'TaskChip': case 'RunChip': case 'SourceChip': lines.push(inlineMarkdown(node)); return
      default:
        // An unknown card: its strings, positional or named (title, text, description…), in order.
        for (const arg of node.args) {
          // Links, ids and style words ("outline", "info-light") are not words the person reads.
          if (typeof arg === 'string' && (/^(https?:|#)/.test(arg) || /^[0-9a-f-]{36}$/i.test(arg) || /^[a-z][a-z-]*$/.test(arg))) continue
          walk(arg)
        }
    }
  }
  walk(value)
  return lines.join('\n')
}

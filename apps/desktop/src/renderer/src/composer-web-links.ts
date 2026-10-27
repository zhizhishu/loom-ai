import { $getNodeByKey, $getRoot, $isElementNode, $isLineBreakNode, $isTextNode, TextNode, type LexicalEditor, type ElementNode } from 'lexical'
import { projectWebLinkRanges } from './safe-markdown-model'

export type ComposerWebLink = { range: Range; target: string; literal: string }
type TextSpan = { node: Text; key: string; start: number; end: number; offset: number }
type LinkPoint = { key: string; offset: number }
type TrackedLink = ComposerWebLink & { start: LinkPoint; end: LinkPoint; nodes: Set<string> }
const HIGHLIGHT = 'rovai-composer-web-link'
const SETTLE_MS = 150

function textSpans(editor: LexicalEditor, key: string, start = 0): TextSpan[] {
  const element = editor.getElementByKey(key)
  const spans: TextSpan[] = []
  if (!element) return spans
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let offset = 0
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    spans.push({ node, key, start: start + offset, end: start + offset + node.length, offset })
    offset += node.length
  }
  return spans
}

const linkKey = (link: { start: LinkPoint; end: LinkPoint; target: string }): string =>
  `${link.start.key}:${link.start.offset}-${link.end.key}:${link.end.offset}:${link.target}`

/** Markdown context belongs to the parser. Coalesce edits before projecting the
 * current source, outside the input/update path; gestures flush pending work.
 * Between projections, keep untouched links anchored within changed TextNodes.
 * These disposable positions only change DOM ranges, never editor state or drafts. */
export function registerComposerWebLinks(editor: LexicalEditor, changed: () => void): {
  current(): readonly ComposerWebLink[]
  destroy(): void
} {
  let links = new Map<string, TrackedLink>()
  const byNode = new Map<string, Set<TrackedLink>>()
  let pending = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearPaint = (): void => {
    const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined
    const highlight = registry?.get(HIGHLIGHT)
    for (const link of links.values()) highlight?.delete(link.range)
    if (highlight?.size === 0) registry?.delete(HIGHLIGHT)
  }
  const refresh = (): void => {
    clearTimeout(timer)
    if (!pending || !editor.getRootElement()) return
    if (editor.isComposing()) { timer = setTimeout(refresh, SETTLE_MS); return }
    pending = false
    let source = ''
    const spans: TextSpan[] = []
    editor.getEditorState().read(() => {
      const visit = (node: ElementNode): void => {
        for (const child of node.getChildren()) {
          if ($isElementNode(child)) { visit(child); source += '\n' }
          else if ($isTextNode(child)) {
            spans.push(...textSpans(editor, child.getKey(), source.length))
            source += child.getTextContent()
          } else source += $isLineBreakNode(child) ? '\n' : '\ufffc' // Never scan Atom labels.
        }
      }
      visit($getRoot())
    })
    const next = new Map<string, TrackedLink>()
    let cursor = 0
    const point = (offset: number): { span: TextSpan; offset: number; index: number } | null => {
      while (cursor < spans.length && spans[cursor].end < offset) cursor++
      const span = spans[cursor]
      return span && offset >= span.start ? { span, offset: offset - span.start, index: cursor } : null
    }
    for (const link of projectWebLinkRanges(source)) {
      const start = point(link.start), end = point(link.end)
      if (!start || !end) continue
      const anchors = {
        start: { key: start.span.key, offset: start.span.offset + start.offset },
        end: { key: end.span.key, offset: end.span.offset + end.offset }
      }
      const key = linkKey({ ...anchors, target: link.target })
      const literal = source.slice(link.start, link.end)
      let rendered = links.get(key)
      if (!rendered || rendered.literal !== literal || rendered.range.startContainer !== start.span.node || rendered.range.startOffset !== start.offset
        || rendered.range.endContainer !== end.span.node || rendered.range.endOffset !== end.offset) {
        const range = document.createRange()
        range.setStart(start.span.node, start.offset); range.setEnd(end.span.node, end.offset)
        rendered = { range, target: link.target, literal, ...anchors,
          nodes: new Set(spans.slice(start.index, end.index + 1).map(span => span.key)) }
      }
      next.set(key, rendered)
    }
    const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined
    if (registry && typeof Highlight !== 'undefined') {
      const highlight = registry.get(HIGHLIGHT) ?? new Highlight()
      for (const [key, link] of links) if (next.get(key) !== link) highlight.delete(link.range)
      for (const link of next.values()) highlight.add(link.range)
      if (highlight.size) registry.set(HIGHLIGHT, highlight)
      else registry.delete(HIGHLIGHT)
    }
    links = next
    byNode.clear()
    for (const link of links.values()) for (const key of link.nodes) {
      const indexed = byNode.get(key) ?? new Set<TrackedLink>()
      indexed.add(link)
      byNode.set(key, indexed)
    }
  }
  // Mutation listeners run after DOM reconciliation, including destroyed nodes.
  // Index by TextNode so typing never walks unrelated links or editor subtrees.
  const unregisterMutations = editor.registerMutationListener(TextNode, (mutations, { prevEditorState }) => {
    const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined
    const highlight = registry?.get(HIGHLIGHT)
    for (const [key, mutation] of mutations) {
      const affected = byNode.get(key)
      if (!affected) continue
      const previous = prevEditorState.read(() => $getNodeByKey(key)?.getTextContent()) ?? ''
      const text = mutation === 'destroyed' ? null
        : editor.getEditorState().read(() => $getNodeByKey(key)?.getTextContent()) ?? null
      const spans = text === null ? [] : textSpans(editor, key)
      // One conservative replacement interval per changed node. Multiple edits
      // spanning a link invalidate it; Markdown semantics stay with refresh().
      let from = 0, oldEnd = previous.length, newEnd = text?.length ?? 0
      if (text !== null && previous !== text) {
        while (from < oldEnd && from < newEnd && previous[from] === text[from]) from++
        while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd-- }
      }
      const retained: TrackedLink[] = []
      for (const link of affected) {
        const oldKey = linkKey(link)
        let start = link.start.offset, end = link.end.offset
        let valid = text !== null && link.start.key === key && link.end.key === key
        if (valid && previous !== text) {
          if (oldEnd <= start) { start += newEnd - oldEnd; end += newEnd - oldEnd }
          else if (from <= end) valid = false // Edits at the URL tail may extend it.
        }
        const first = spans.find(span => start >= span.start && start < span.end)
        const last = spans.find(span => end > span.start && end <= span.end)
        if (valid && first && last && text?.slice(start, end) === link.literal) {
          link.range.setStart(first.node, start - first.start)
          link.range.setEnd(last.node, end - last.start)
          valid = link.range.toString() === link.literal
        } else valid = false
        links.delete(oldKey)
        if (!valid) {
          highlight?.delete(link.range)
          for (const nodeKey of link.nodes) {
            const indexed = byNode.get(nodeKey)
            indexed?.delete(link)
            if (indexed?.size === 0) byNode.delete(nodeKey)
          }
          continue
        }
        link.start.offset = start; link.end.offset = end
        retained.push(link)
      }
      // Re-key together: an insertion can move one repeated URL onto another's old key.
      for (const link of retained) links.set(linkKey(link), link)
    }
    if (highlight?.size === 0) registry?.delete(HIGHLIGHT)
  }, { skipInitialization: true })
  const unregister = editor.registerUpdateListener(({ dirtyLeaves, dirtyElements }) => {
    if (!dirtyLeaves.size && !dirtyElements.size) return
    changed()
    pending = true
    clearTimeout(timer)
    timer = setTimeout(refresh, SETTLE_MS)
  })
  const unregisterRoot = editor.registerRootListener(root => {
    clearTimeout(timer)
    clearPaint(); links.clear(); byNode.clear()
    pending = true
    if (root) refresh()
  })
  return {
    current: () => { refresh(); return editor.isComposing() ? [] : [...links.values()] },
    destroy: () => { unregister(); unregisterMutations(); unregisterRoot(); clearTimeout(timer); clearPaint(); links.clear(); byNode.clear() }
  }
}

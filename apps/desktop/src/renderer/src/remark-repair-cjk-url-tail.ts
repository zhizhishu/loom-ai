import { bareWebLinks } from './web-link-ranges'
import type { MarkdownNode as ModelMarkdownNode } from './safe-markdown-model'

type MarkdownNode = Pick<ModelMarkdownNode, 'type' | 'value' | 'url' | 'position'> & { children?: MarkdownNode[] }

/** Source syntax, not label equality, distinguishes explicit links from GFM guesses. */
export function isExplicitMarkdownLink(node: MarkdownNode, source: string): boolean {
  const start = node.position?.start.offset
  return start !== undefined && (source[start] === '[' || source[start] === '<')
}

export function remarkRepairCjkUrlTail(): (tree: MarkdownNode, file: { value: unknown }) => void {
  return function transform(tree, file): void {
    const source = String(file.value)
    const visit = (parent: MarkdownNode): void => {
      if (!parent.children || ['code', 'inlineCode', 'html', 'link', 'linkReference'].includes(parent.type ?? '')) return
      const children: MarkdownNode[] = []
      for (const child of parent.children) {
        // Undo only GFM's automatic link creation. Rescan contiguous text so
        // localhost/IPs and query punctuation share the same boundary rules.
        const node = child.type === 'link' && !isExplicitMarkdownLink(child, source)
          ? { type: 'text', value: child.children?.map(part => part.value ?? '').join(''), position: child.position }
          : child
        const previous = children.at(-1)
        if (node.type === 'text' && previous?.type === 'text' && previous.position && node.position
          && previous.position.end.offset === node.position.start.offset) {
          previous.value = (previous.value ?? '') + (node.value ?? '')
          previous.position = { start: previous.position.start, end: node.position.end }
        } else children.push(node)
      }
      parent.children = children.flatMap(node => {
        if (node.type !== 'text' || !node.value) { visit(node); return [node] }
        const parts: MarkdownNode[] = []
        let offset = 0
        const start = node.position?.start.offset, end = node.position?.end.offset
        // GFM can invent a link after entity decoding and omit its position.
        // Only addresses found in both the source and its display text qualify.
        if (start === undefined || end === undefined) return [node]
        const sourceTargets = new Set(bareWebLinks(source.slice(start, end)).map(link => link.target))
        for (const link of bareWebLinks(node.value)) {
          if (!sourceTargets.has(link.target)) continue
          if (link.start > offset) parts.push({ type: 'text', value: node.value.slice(offset, link.start) })
          parts.push({ type: 'link', url: link.target, children: [{ type: 'text', value: node.value.slice(link.start, link.end) }] })
          offset = link.end
        }
        if (offset < node.value.length) parts.push({ type: 'text', value: node.value.slice(offset) })
        return parts
      })
    }
    visit(tree)
  }
}

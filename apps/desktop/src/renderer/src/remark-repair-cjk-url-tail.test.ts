import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FileReferenceText } from './FileReferenceLink'
import { projectWebLinkRanges } from './safe-markdown-model'
import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { remarkRepairCjkUrlTail } from './remark-repair-cjk-url-tail'

type Node = { type?: string; value?: string; url?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } }
const parser = unified().use(remarkParse).use(remarkGfm)
const repair = remarkRepairCjkUrlTail()
const text = (node: Node): string => node.value ?? node.children?.map(text).join('') ?? ''

it.each([
  ['前 http://localhost:3000/a?x=1&y=2#part。后', ['http://localhost:3000/a?x=1&y=2#part']],
  ['http://192.168.1.5:8080/a https://[::1]:3000/a', ['http://192.168.1.5:8080/a', 'https://[::1]:3000/a']],
  ['www.example.com example.com a@example.com', []],
  ['h&#116;tp://example.com https://example\\.com', []],
  ['h&#116;tp://example.com https://example.com/good', ['https://example.com/good']],
  ['\\*说明\\* http://localhost:3000/a?x=1&amp;y=2', ['http://localhost:3000/a?x=1&amp;y=2']],
  ['[https://example.com/a?q=中文，参数](https://example.com/a?q=中文，参数)', ['https://example.com/a?q=中文，参数']],
  ['[标题](https://example.com/a?q=中文，参数)', ['https://example.com/a?q=中文，参数']],
  ['https://example.com/?q=hello!。后', ['https://example.com/?q=hello!']],
  ['[文档](https://example.com/Foo_(bar)?x=%29&y=2#f)', ['https://example.com/Foo_(bar)?x=%29&y=2#f']],
  ['[标题](<http://localhost:3000/a?q=1> "标题")', ['http://localhost:3000/a?q=1']],
  ['前 \u0060http://localhost:3000\u0060 后\n\n~~~txt\nhttps://example.com\n~~~', []],
  ['\u0060跨行\nhttp://localhost:3000\n代码\u0060', []]
])('keeps literal user text and uses source-aware targets: %s', (source, expected) => {
  const ranges = projectWebLinkRanges(source)
  expect(ranges.map(link => link.target)).toEqual(expected)
  const markup = renderToStaticMarkup(createElement(FileReferenceText, { text: source }))
  expect(markup.replace(/<[^>]*>/gu, '').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#x27;', "'")).toBe(source)
  const tree = parser.parse(source)
  repair(tree, { value: source })
  const targets: string[] = []
  const visit = (node: Node): void => { if (node.type === 'link' && node.url) targets.push(node.url); node.children?.forEach(visit) }
  visit(tree)
  expect(targets).toEqual(expected)
})


describe('CJK URL tail repair', () => {
  it.each([
    ['https://x.com/a，然后', 'https://x.com/a', '，然后'],
    ['https://x.com/a)。', 'https://x.com/a', ')。'],
    ['https://x.com/a)。（下一句）', 'https://x.com/a', ')。（下一句）'],
    ['https://x.com/Foo_(bar)。', 'https://x.com/Foo_(bar)', '。'],
    ['https://x.com/Foo_(bar))。', 'https://x.com/Foo_(bar)', ')。'],
    ['https://x.com/a?b=1&c=2）。', 'https://x.com/a?b=1&c=2', '）。'],
    ['https://x.com/a?q=hello!。正文', 'https://x.com/a?q=hello!', '。正文'],
    ['https://x.com/a?value=%EF%BC%89）。正文', 'https://x.com/a?value=%EF%BC%89', '）。正文'],
    ['https://x.com/a,.。正文', 'https://x.com/a', ',.。正文'],
    ['http://x.com/a【说明】', 'http://x.com/a', '【说明】']
  ])('splits %s without losing or duplicating text', (source, url, tail) => {
    const root: Node = { type: 'paragraph', children: [{ type: 'link', url: source, position: { start: { offset: 0 }, end: { offset: source.length } }, children: [{ type: 'text', value: source }] }] }
    repair(root, { value: source })
    expect(root.children).toEqual([
      { type: 'link', url, children: [{ type: 'text', value: url }] },
      { type: 'text', value: tail }
    ])
    expect(text(root)).toBe(source)
  })

  it('keeps GFM protocol guesses as inert text', () => {
    const source = 'www.example.com/a）。正文'
    const tree = parser.parse(source)
    repair(tree, { value: source })
    expect(tree.children[0]).toMatchObject({ children: [
      { type: 'text', value: source }
    ] })
  })

  it.each([
    '[需求文档](https://x.com/a）。后续正文)',
    '[需求文档](https://x.com/a)',
    '<https://x.com/a>',
    'https://x.com/Foo_(bar)',
    '`https://x.com/a）。`',
    '```\nhttps://x.com/a）。\n```',
    '[README.md](README.md)',
    '[file:///tmp/a）。](file:///tmp/a）。)',
    '[file](#rovai-file-reference=a.ts)',
    'https://x.com/a?value=%EF%BC%89&b=1'
  ])('leaves an ordinary or deliberately labelled link untouched: %s', (source) => {
    const tree = parser.parse(source)
    const original = structuredClone(tree)
    repair(tree, { value: source })
    expect(text(tree)).toBe(text(original))
    expect(JSON.stringify(tree).match(/"url":"[^"]*"/gu)).toEqual(JSON.stringify(original).match(/"url":"[^"]*"/gu))
  })

  it('preserves all visible characters at every incomplete streaming boundary', () => {
    const url = 'https://x.com/a?b=1&c=2）。中文正文：'
    for (const source of [url, `[${url}](${url})`, `已读取（${url}`]) {
      for (let end = 1; end <= source.length; end += 1) {
        const tree = parser.parse(source.slice(0, end))
        const originalText = text(tree)
        repair(tree, { value: source.slice(0, end) })
        expect(text(tree)).toBe(originalText)
      }
    }
  })
})

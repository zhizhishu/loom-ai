import { describe, expect, it } from 'vitest'
import { pairCitations, remarkCitations, splitCitations, withoutPartialCitation } from './citations'

const ISSUE = '3f6c1a52-8d0e-4b7a-9c3e-1f2a3b4c5d6e'
const RUN = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

type Node = { type: string; value?: string; url?: string; children?: Node[] }
const text = (value: string): Node => ({ type: 'text', value })
const transform = (...children: Node[]) => {
  const tree: Node = { type: 'root', children: [{ type: 'paragraph', children }] }
  remarkCitations()(tree)
  return tree.children?.[0].children
}

describe('Mikka citation syntax', () => {
  it('splits explicit and bare citations in order', () => {
    expect(splitCitations(`派给 [[run:${RUN}]] 处理 ${ISSUE}`)).toEqual([
      { type: 'text', text: '派给 ' },
      { type: 'citation', kind: 'run', id: RUN, raw: `[[run:${RUN}]]` },
      { type: 'text', text: ' 处理 ' },
      { type: 'citation', kind: null, id: ISSUE, raw: ISSUE }
    ])
  })
  it('pairs a run directly after its issue and drops only the blank gap', () => {
    expect(pairCitations(splitCitations(`[[issue:${ISSUE}]]   [[run:${RUN}]]。`))).toEqual([
      { type: 'citation', kind: 'issue', id: ISSUE, raw: `[[issue:${ISSUE}]]` },
      { type: 'citation', kind: 'run', id: RUN, raw: `[[run:${RUN}]]`, after: ISSUE },
      { type: 'text', text: '。' }
    ])
  })
  it('turns citations into chip links and keeps plain-text line breaks', () => {
    expect(transform(text(`已派给 [[run:${RUN}]]\n处理 ${ISSUE}`))).toEqual([
      text('已派给 '),
      { type: 'link', url: `#cite/run/${RUN}`, children: [text(`[[run:${RUN}]]`)] },
      { type: 'break' },
      text('处理 '),
      { type: 'link', url: `#cite/any/${ISSUE}`, children: [text(ISSUE)] }
    ])
  })
  it('hides a partial citation while the reply streams', () => {
    expect(withoutPartialCitation(`正在看 [[run:${RUN.slice(0, 12)}`)).toBe('正在看 ')
    expect(withoutPartialCitation(`完成 [[run:${RUN}]]`)).toBe(`完成 [[run:${RUN}]]`)
  })
})

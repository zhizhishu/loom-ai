import { describe, expect, it } from 'vitest'
import { graphEdgePath, layoutFactGraph, type GraphEdge } from './graph-layout'

const edge = (source: string, target: string): GraphEdge => ({ id: `${source}:${target}`, source, target, label: 'depends on' })

describe('fact graph layout', () => {
  it('lays out explicit dependency levels and disconnected work without inventing links', () => {
    const result = layoutFactGraph(['a', 'b', 'c', 'other'], [edge('a', 'b'), edge('b', 'c')])
    expect(result.nodes.map(node => [node.id, node.column])).toEqual([['a', 0], ['b', 1], ['c', 2], ['other', 0]])
    expect(result.edges.map(row => row.id)).toEqual(['a:b', 'b:c'])
    expect(result.cyclicIds).toEqual([])
    expect(result.nodes.every(node => node.x >= 0 && node.y >= 0)).toBe(true)
    expect(result.nodes[3]!.y).toBeGreaterThan(result.nodes[0]!.y)
  })
  it('keeps missing endpoints diagnostic rather than creating phantom work', () => {
    const missing = edge('missing', 'a')
    const result = layoutFactGraph(['a'], [missing])
    expect(result.nodes.map(node => node.id)).toEqual(['a'])
    expect(result.edges).toEqual([])
    expect(result.missingEdges).toEqual([missing])
  })
  it('terminates on cycles, keeps all actual edges and reports affected nodes', () => {
    const result = layoutFactGraph(['a', 'b', 'c', 'root'], [edge('a', 'b'), edge('b', 'a'), edge('b', 'c')])
    expect(result.cyclicIds).toEqual(['a', 'b', 'c'])
    expect(result.edges).toHaveLength(3)
    expect(result.nodes).toHaveLength(4)
    expect(Number.isFinite(result.width)).toBe(true)
    expect(result.height).toBeGreaterThan(0)
  })
  it('handles duplicate identifiers and the empty graph deterministically', () => {
    expect(layoutFactGraph(['a', 'a'], []).nodes).toHaveLength(1)
    expect(layoutFactGraph([], [])).toEqual({ nodes: [], edges: [], missingEdges: [], cyclicIds: [], width: 320, height: 220 })
  })
  it('routes forward and reverse edges with finite numeric control points', () => {
    const a = { id: 'a', x: 28, y: 28, column: 0 }
    const b = { id: 'b', x: 328, y: 156, column: 1 }
    expect(graphEdgePath(a, b)).toMatch(/^M .* C /)
    expect(graphEdgePath(b, a)).toMatch(/^M .* C /)
    expect(graphEdgePath(b, a)).not.toMatch(/NaN|Infinity/)
  })
})

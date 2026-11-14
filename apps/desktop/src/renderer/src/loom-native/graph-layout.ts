/** Deterministic fact-graph layout. Missing endpoints and cycles stay diagnostic;
 * timestamps never create edges and graph geometry never mutates domain state. */
export type GraphEdge = { id: string; source: string; target: string; label: string; resolved?: boolean }
export type PositionedNode = { id: string; x: number; y: number; column: number }
export type GraphLayout = { nodes: PositionedNode[]; edges: GraphEdge[]; width: number; height: number; missingEdges: GraphEdge[]; cyclicIds: string[] }
export const GRAPH_NODE_WIDTH = 218
export const GRAPH_NODE_HEIGHT = 92
const X_GAP = 82
const Y_GAP = 36
const PAD = 28

export function layoutFactGraph(ids: readonly string[], input: readonly GraphEdge[]): GraphLayout {
  const unique = [...new Set(ids)]
  const known = new Set(unique)
  const edges = input.filter(edge => known.has(edge.source) && known.has(edge.target))
  const missingEdges = input.filter(edge => !known.has(edge.source) || !known.has(edge.target))
  const indegree = new Map(unique.map(id => [id, 0]))
  const outgoing = new Map(unique.map(id => [id, [] as string[]]))
  const rank = new Map(unique.map(id => [id, 0]))
  for (const edge of edges) {
    outgoing.get(edge.source)!.push(edge.target)
    indegree.set(edge.target, indegree.get(edge.target)! + 1)
  }
  const queue = unique.filter(id => indegree.get(id) === 0)
  const visited = new Set<string>()
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor]!
    visited.add(id)
    for (const target of outgoing.get(id)!) {
      rank.set(target, Math.max(rank.get(target)!, rank.get(id)! + 1))
      indegree.set(target, indegree.get(target)! - 1)
      if (indegree.get(target) === 0) queue.push(target)
    }
  }
  // This includes nodes blocked by a cycle, deliberately not called a completed DAG.
  const cyclicIds = unique.filter(id => !visited.has(id))
  const cycleColumn = Math.max(0, ...[...visited].map(id => rank.get(id)!)) + (visited.size ? 1 : 0)
  for (const id of cyclicIds) rank.set(id, cycleColumn)
  const nextRow = new Map<number, number>()
  const nodes = unique.map(id => {
    const column = rank.get(id)!
    const row = nextRow.get(column) ?? 0
    nextRow.set(column, row + 1)
    return { id, column, x: PAD + column * (GRAPH_NODE_WIDTH + X_GAP), y: PAD + row * (GRAPH_NODE_HEIGHT + Y_GAP) }
  })
  return { nodes, edges, missingEdges, cyclicIds,
    width: Math.max(320, ...nodes.map(node => node.x + GRAPH_NODE_WIDTH + PAD)),
    height: Math.max(220, ...nodes.map(node => node.y + GRAPH_NODE_HEIGHT + PAD)) }
}

export function graphEdgePath(from: PositionedNode, to: PositionedNode): string {
  const x1 = from.x + GRAPH_NODE_WIDTH
  const y1 = from.y + GRAPH_NODE_HEIGHT / 2
  const x2 = to.x
  const y2 = to.y + GRAPH_NODE_HEIGHT / 2
  if (x2 > x1) {
    const middle = x1 + (x2 - x1) / 2
    return `M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`
  }
  // Cyclic / reverse edges are drawn, not silently omitted or inferred away.
  const bend = Math.max(x1, x2 + GRAPH_NODE_WIDTH) + 28
  return `M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y2 - 24}, ${x2 + GRAPH_NODE_WIDTH / 2} ${to.y}`
}

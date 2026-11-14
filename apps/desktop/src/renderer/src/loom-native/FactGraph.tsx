import { useEffect, useId, useMemo, useState } from 'react'
import type { LoomDependency } from '@contracts'
import type { AgentProfile, ArtifactSelection, WorkBundle } from './types'
import { Avatar } from './Avatar'
import { Icon, IconButton } from './icons'
import { graphEdgePath, layoutFactGraph, GRAPH_NODE_WIDTH, GRAPH_NODE_HEIGHT, type GraphEdge } from './graph-layout'
import { loomCandidateVersions } from '../loom-control-model'

type Node = { id: string; kind: 'task' | 'candidate' | 'artifact'; title: string; detail: string; status: string; agent?: AgentProfile; artifact?: ArtifactSelection; conversation: string }
const TASK_STATE: Record<string, string> = { draft: '计划中', ready: '待开始', in_progress: '进行中', in_review: '审查中', blocked: '受阻', done: '执行已结束', canceled: '已取消' }

/** Geometry from explicit relationships, never guessed from creation order. */
export function FactGraph({ bundle, dependencies, agents, view, onArtifact, onConversation, focusedTaskId, onTaskSelect }: {
  bundle: WorkBundle; dependencies: LoomDependency[]; agents: AgentProfile[]; view: 'flow' | 'assets'
  onArtifact(value: ArtifactSelection): void; onConversation(id: string): void
  focusedTaskId?: string | null; onTaskSelect?(taskId: string | null): void
}) {
  const [zoom, setZoom] = useState(.85)
  const [selected, setSelected] = useState<string | null>(focusedTaskId ? `task:${focusedTaskId}` : null)
  useEffect(() => {
    if (focusedTaskId === undefined) return
    setSelected(current => {
      if (!focusedTaskId) return null
      if (current === `task:${focusedTaskId}`) return current
      if (bundle.candidates.some(row => `candidate:${row.candidateId}` === current && row.taskId === focusedTaskId)) return current
      if (bundle.artifacts.some(row => `artifact:${row.artifactId}` === current && row.taskId === focusedTaskId)) return current
      return `task:${focusedTaskId}`
    })
  }, [focusedTaskId, bundle.candidates, bundle.artifacts])
  const [query, setQuery] = useState('')
  const marker = `graph-arrow-${useId().replace(/:/g, '')}`
  const { nodes, layout } = useMemo(() => {
    const rows: Node[] = []
    const edges: GraphEdge[] = []
    const versions = loomCandidateVersions(bundle.candidates)
    const taskId = (id: string) => `task:${id}`
    const candidateId = (id: string) => `candidate:${id}`
    const artifactId = (id: string) => `artifact:${id}`
    for (const task of bundle.tasks) {
      const agent = agents.find(item => item.agentId === task.assigneeAgentId)
      rows.push({ id: taskId(task.taskId), kind: 'task', title: task.title, detail: task.blockedReason || task.description || '没有补充说明', status: TASK_STATE[task.status] ?? '状态未确认', agent, conversation: bundle.mission.threadId })
    }
    if (view === 'flow') {
      for (const edge of dependencies) edges.push({ id: edge.dependencyId, source: taskId(edge.upstreamTaskId), target: taskId(edge.downstreamTaskId), label: edge.resolution ? '依赖已释放' : '等待依赖', resolved: Boolean(edge.resolution) })
    } else {
      for (const candidate of bundle.candidates) {
        const version = versions.find(item => item.candidateId === candidate.candidateId)
        const task = bundle.tasks.find(item => item.taskId === candidate.taskId)
        const file = bundle.artifacts.find(item => candidate.evidenceIds.includes(item.artifactId))
        const acceptance = candidate.acceptanceStatus === 'accepted' ? '用户已接受' : candidate.acceptanceStatus === 'rejected' ? '用户已退回' : '等待用户审阅'
        const verification = candidate.verificationStatus === 'verified' ? '技术核验通过' : candidate.verificationStatus === 'failed' ? '技术核验失败' : '尚未技术核验'
        rows.push({ id: candidateId(candidate.candidateId), kind: 'candidate', title: `成果 v${version?.version ?? 1}${version?.latest ? ' · 最新' : ''}`, detail: `${task?.title ?? '关联工作未载入'}\n${acceptance}\n${verification}`, status: acceptance, conversation: bundle.mission.threadId, ...(file ? { artifact: { artifact: file, candidate, bundle } } : {}) })
        edges.push({ id: `produced:${candidate.candidateId}`, source: taskId(candidate.taskId), target: candidateId(candidate.candidateId), label: '产出' })
        if (candidate.previousCandidateId) edges.push({ id: `revision:${candidate.candidateId}`, source: candidateId(candidate.previousCandidateId), target: candidateId(candidate.candidateId), label: '修订为' })
        for (const id of candidate.evidenceIds) edges.push({ id: `evidence:${candidate.candidateId}:${id}`, source: candidateId(candidate.candidateId), target: artifactId(id), label: '包含文件' })
      }
      for (const file of bundle.artifacts) {
        const candidate = bundle.candidates.find(item => item.evidenceIds.includes(file.artifactId)) ?? null
        rows.push({ id: artifactId(file.artifactId), kind: 'artifact', title: file.relativePath.split(/[\\/]/).pop() || file.relativePath, detail: file.relativePath, status: `归档 · ${file.sha256.slice(0, 10)}…`, artifact: { artifact: file, candidate, bundle }, conversation: bundle.mission.threadId })
      }
    }
    return { nodes: rows, layout: layoutFactGraph(rows.map(node => node.id), edges) }
  }, [bundle, dependencies, agents, view])
  const selectedNode = nodes.find(node => node.id === selected)
  const positions = new Map(layout.nodes.map(node => [node.id, node]))
  const normalized = query.trim().toLocaleLowerCase()
  return <div className="ln-fact-graph">
    <div className="ln-graph-tools"><label className="ln-graph-search"><Icon name="search" size={14}/><input aria-label="查找图中工作或成果" type="search" placeholder="查找图中内容" value={query} onChange={event => setQuery(event.target.value)}/></label><div className="ln-graph-zoom"><IconButton icon="minus" label="缩小关系图" disabled={zoom <= .4} onClick={() => setZoom(value => Math.max(.4, +(value - .1).toFixed(2)))}/><button type="button" className="ln-graph-scale" onClick={() => setZoom(.85)} aria-label="恢复关系图缩放">{Math.round(zoom * 100)}%</button><IconButton icon="plus" label="放大关系图" disabled={zoom >= 1.4} onClick={() => setZoom(value => Math.min(1.4, +(value + .1).toFixed(2)))}/></div></div>
    {(layout.missingEdges.length > 0 || layout.cyclicIds.length > 0) && <p className="ln-graph-diagnostic" role="status">{layout.missingEdges.length > 0 ? `${layout.missingEdges.length} 条关系的端点尚未载入。` : ''}{layout.cyclicIds.length > 0 ? '存在循环或受循环影响的工作，请检查依赖。' : ''}</p>}
    <div className="ln-graph-viewport" tabIndex={0} aria-label={view === 'flow' ? '可滚动工作流程图' : '可滚动成果版本图'}>
      <div className="ln-graph-size" style={{ width: layout.width * zoom, height: layout.height * zoom }}><div className="ln-graph-plane" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
        <svg width={layout.width} height={layout.height} className="ln-graph-edges" aria-label="真实关系连线"><defs><marker id={marker} markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M1 1L6 4L1 7" fill="none" stroke="currentColor" strokeWidth="1.3"/></marker></defs>{layout.edges.map(edge => {
          const from = positions.get(edge.source)!, to = positions.get(edge.target)!
          return <g key={edge.id} className={edge.resolved === false ? 'is-waiting' : ''}><path d={graphEdgePath(from, to)} markerEnd={`url(#${marker})`}><title>{edge.label}</title></path>{to.x > from.x + GRAPH_NODE_WIDTH && <text x={(from.x + GRAPH_NODE_WIDTH + to.x) / 2} y={(from.y + to.y + GRAPH_NODE_HEIGHT) / 2 - 9} textAnchor="middle">{edge.label}</text>}</g>
        })}</svg>
        {nodes.map(node => {
          const position = positions.get(node.id)!
          const dimmed = normalized && !`${node.title} ${node.detail} ${node.agent?.displayName ?? ''}`.toLocaleLowerCase().includes(normalized)
          return <button key={node.id} type="button" className={`ln-map-node ln-graph-node is-${node.kind}${selected === node.id ? ' is-focused' : ''}${dimmed ? ' is-dimmed' : ''}`} style={{ left: position.x, top: position.y, width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT }} onClick={() => { const next = selected === node.id ? null : node.id; setSelected(next); if (!next) onTaskSelect?.(null); else if (node.kind === 'task') onTaskSelect?.(node.id.slice(5)); else if (node.kind === 'candidate') onTaskSelect?.(bundle.candidates.find(row => `candidate:${row.candidateId}` === node.id)?.taskId ?? null); else onTaskSelect?.(node.artifact?.artifact.taskId ?? null) }} aria-pressed={selected === node.id} title={`${node.title}\n${node.detail}`}><span className="ln-graph-node-kind">{node.kind === 'task' ? <Avatar agent={node.agent} name="工作" size={21}/> : <Icon name={node.kind === 'candidate' ? 'branch' : 'file'} size={18}/>}<span>{node.kind === 'task' ? node.agent?.displayName ?? '未指派' : node.kind === 'candidate' ? '成果版本' : '归档文件'}</span></span><strong>{node.title}</strong><small>{node.status}</small></button>
        })}
        {!nodes.length && <p className="ln-inspector-empty">这里还没有工作或成果。</p>}
      </div></div>
    </div>
    {selectedNode && <section className="ln-graph-detail" aria-label="选中的图节点"><div><strong>{selectedNode.title}</strong><IconButton icon="close" label="关闭节点详情" onClick={() => setSelected(null)}/></div><p>{selectedNode.detail}</p><div className="ln-graph-detail-actions">{selectedNode.artifact && <button type="button" className="ln-action is-primary" onClick={() => onArtifact(selectedNode.artifact!)}>打开对应成果</button>}<button type="button" className="ln-action" onClick={() => onConversation(selectedNode.conversation)}>打开相关对话</button></div></section>}
  </div>
}

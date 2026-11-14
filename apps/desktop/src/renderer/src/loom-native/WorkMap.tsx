import { useEffect, useState } from 'react'
import type { LoomDependency } from '@contracts'
import type { ThreadClient } from '../camp-client'
import type { AgentProfile, ArtifactSelection, WorkBundle } from './types'
import { FormMessage } from './Controls'
import { FactGraph } from './FactGraph'

/** Read-only fact projection. Edges come from dependency/lineage IDs, never time. */
export function WorkMap({ bundles, agents, client, onArtifact, onConversation, initialView = 'flow', hideViewTabs = false, focusedTaskId, onTaskSelect }: {
  bundles: WorkBundle[]; agents: AgentProfile[]; client: ThreadClient
  onArtifact(value: ArtifactSelection): void; onConversation(threadId: string): void
  initialView?: 'flow' | 'assets'; hideViewTabs?: boolean; focusedTaskId?: string | null; onTaskSelect?(taskId: string | null): void
}) {
  const [view, setView] = useState<'flow' | 'assets'>(initialView)
  useEffect(() => setView(initialView), [initialView])
  const [dependencies, setDependencies] = useState<Record<string, LoomDependency[]>>({})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const signature = bundles.map(bundle => `${bundle.mission.missionId}:${bundle.plan?.revision ?? 0}:${bundle.tasks.map(task => task.revision).join(',')}`).join('|')
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    void Promise.all(bundles.map(async bundle => {
      const value = await client.request<LoomDependency[]>('loom.dependencies.list', { missionId: bundle.mission.missionId })
      if (!Array.isArray(value)) throw new Error('工作依赖返回了不兼容的数据。')
      return [bundle.mission.missionId, value] as const
    })).then(entries => { if (!cancelled) setDependencies(Object.fromEntries(entries)) })
      .catch(cause => { if (!cancelled) { setDependencies({}); setError(cause instanceof Error ? cause.message : '工作依赖暂时读取失败。') } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [client, signature, reload])
  const taskCount = bundles.reduce((sum, bundle) => sum + bundle.tasks.length, 0)
  const assetCount = bundles.reduce((sum, bundle) => sum + bundle.artifacts.length, 0)
  return <section className="ln-work-map" aria-label="工作与资产关系图">
    {!hideViewTabs && <nav className="ln-segment-tabs ln-map-tabs" aria-label="关系图类型"><button type="button" className={view === 'flow' ? 'is-selected' : ''} onClick={() => setView('flow')}>工作流程</button><button type="button" className={view === 'assets' ? 'is-selected' : ''} onClick={() => setView('assets')}>资产关系</button></nav>}
    <div className="ln-map-legend"><span>{taskCount} 项工作</span><span>{assetCount} 份文件</span><span>来自真实记录 · 只读</span></div>
    {error && <><FormMessage error>{error}</FormMessage><button type="button" className="ln-action" onClick={() => setReload(value => value + 1)}>重新读取依赖</button></>}
    {!bundles.length && <p className="ln-inspector-empty">建立第一项工作后，流程和成果关系会出现在这里。</p>}
    {bundles.map(bundle => <section key={bundle.mission.missionId} className="ln-map-lane"><h3>{bundle.mission.title}</h3>
      <FactGraph key={`${bundle.mission.missionId}:${view}`} bundle={bundle} agents={agents} dependencies={dependencies[bundle.mission.missionId] ?? []} view={view} focusedTaskId={focusedTaskId} onTaskSelect={onTaskSelect} onArtifact={onArtifact} onConversation={onConversation}/>
    </section>)}
    {view === 'flow' && loading && <p className="ln-cap-state" role="status">正在读取依赖关系…</p>}
  </section>
}

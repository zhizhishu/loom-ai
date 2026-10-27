import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentProfile, MissionRecord, LoomPlan, LoomTask, LoomDependency } from '@contracts'
import { loomTaskReady } from '@contracts'
import { Icon } from './MissionControls'
import { MissionDeliveryPanel, MissionActivityPanel } from './MissionDelivery'
import { UiText, uiAttribute, useUiText } from './interface-language'
import { useThreadClient } from './camp-client'

export type LoomSection = 'activity' | 'plan' | 'delivery'

function LoomEmpty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="loom-empty">
    <span className="loom-empty-mark" aria-hidden="true"><i/><i/><i/></span>
    <h3>{title}</h3>
    <div>{children}</div>
  </div>
}

/** 依赖图渲染：archify 流程视图。就绪判定走控制层契约，不在 UI 里另立规则。 */
function LoomFlow({ tasks, dependencies, agents }: {
  tasks: LoomTask[]
  dependencies: LoomDependency[]
  agents: AgentProfile[]
}) {
  const t = useUiText()
  // 尚无 Candidate/Review 读取路径，传空集合：artifact_accepted 边因此保持未释放，
  // 不会被"上游 done"误判为已验收。
  const graph = { tasks, dependencies, candidates: [], reviews: [], evaluatedAt: new Date(0).toISOString() }
  const readyTasks = tasks.filter(task => loomTaskReady(task.taskId, graph).ready)
  const blockedTasks = tasks.filter(task => task.status === 'blocked')
  
  return <div className="loom-flow">
    <div className="loom-flow-header">
      <span className="loom-eyebrow">{t('任务依赖')}</span>
      <div className="loom-flow-stats">
        <span>{t('可执行')}: {readyTasks.length}</span>
        <span>{t('阻塞')}: {blockedTasks.length}</span>
        <span>{t('总任务')}: {tasks.length}</span>
      </div>
    </div>
    
    <div className="loom-flow-graph">
      {tasks.map(task => {
        const upstreams = dependencies.filter(d => d.downstreamTaskId === task.taskId)
        const ready = loomTaskReady(task.taskId, graph).ready
        const assignee = agents.find(a => a.agentId === task.assigneeAgentId)
        
        return <div key={task.taskId} className={`loom-flow-node ${ready ? 'ready' : ''} ${task.status}`}>
          <div className="loom-flow-node-header">
            <span className="loom-flow-node-title">{task.title}</span>
            <span className="loom-flow-node-status">{t(task.status)}</span>
          </div>
          {assignee && <div className="loom-flow-node-assignee">{assignee.displayName}</div>}
          {upstreams.length > 0 && (
            <div className="loom-flow-node-deps">
              {t('依赖')}: {upstreams.map(d => {
                const upstream = tasks.find(entry => entry.taskId === d.upstreamTaskId)
                return upstream?.title ?? d.upstreamTaskId
              }).join(', ')}
            </div>
          )}
          {task.blockedReason && (
            <div className="loom-flow-node-blocked">{task.blockedReason}</div>
          )}
        </div>
      })}
    </div>
  </div>
}

function PlanWorkspace({ mission, agents, plan, tasks, dependencies, loading, error }: {
  mission: MissionRecord
  agents: AgentProfile[]
  plan: LoomPlan | null
  tasks: LoomTask[]
  dependencies: LoomDependency[]
  loading?: boolean
  error?: string
}) {
  const t = useUiText()
  
  if (loading) {
    return <div className="loom-plan">
      <header className="loom-section-heading">
        <div><span className="loom-eyebrow">LOOM · {t('编排')}</span><h2>{t('工作关系')}</h2></div>
        <span className="loom-number">M-{String(mission.number).padStart(3, '0')}</span>
      </header>
      <LoomEmpty title={t('正在读取编排…')}>
        <p>{t('从控制面读取计划、任务与依赖关系。')}</p>
      </LoomEmpty>
    </div>
  }
  
  if (error) {
    return <div className="loom-plan">
      <header className="loom-section-heading">
        <div><span className="loom-eyebrow">LOOM · {t('编排')}</span><h2>{t('工作关系')}</h2></div>
        <span className="loom-number">M-{String(mission.number).padStart(3, '0')}</span>
      </header>
      <LoomEmpty title={t('读取编排失败')}>
        <p>{error}</p>
        <p>{t('请检查控制面连接后重试。')}</p>
      </LoomEmpty>
    </div>
  }
  
  if (!plan || tasks.length === 0) {
    return <div className="loom-plan">
      <header className="loom-section-heading">
        <div><span className="loom-eyebrow">LOOM · {t('编排')}</span><h2>{t('工作关系')}</h2></div>
        <span className="loom-number">M-{String(mission.number).padStart(3, '0')}</span>
      </header>
      <p className="loom-intro">{t('把目标、责任与交付放在同一张工作图上。执行状态和人工验收各自保留。')}</p>
      <LoomEmpty title={t('尚未配置编排')}>
        <p>{t('这个使命还没有任务依赖或执行计划。')}</p>
        <p>{t('由主助手建立计划后，这里会显示任务关系、负责队员和真实阻塞。')}</p>
      </LoomEmpty>
      <section className="loom-foundation" aria-label={uiAttribute('当前使命基础')}>
        <div><span>{t('当前使命')}</span><strong>{mission.title}</strong></div>
        <div><span>{t('队员')}</span><strong>{mission.memberAgentIds.length}</strong></div>
        <div><span>{t('执行中')}</span><strong>{mission.runningAgentIds.length}</strong></div>
      </section>
    </div>
  }
  
  return <div className="loom-plan">
    <header className="loom-section-heading">
      <div><span className="loom-eyebrow">LOOM · {t('编排')}</span><h2>{plan.goal}</h2></div>
      <span className="loom-number">M-{String(mission.number).padStart(3, '0')}</span>
    </header>
    <p className="loom-intro">{t('把目标、责任与交付放在同一张工作图上。执行状态和人工验收各自保留。')}</p>
    <LoomFlow tasks={tasks} dependencies={dependencies} agents={agents} />
  </div>
}

function DeliveryReview() {
  const t = useUiText()
  return <div className="loom-delivery-context">
    <header className="loom-section-heading">
      <div><span className="loom-eyebrow">LOOM · {t('交付')}</span><h2>{t('成果与验收')}</h2></div>
    </header>
    <section className="loom-review-state" aria-label={uiAttribute('人工验收状态')}>
      <span className="loom-review-mark" aria-hidden="true"/>
      <div><strong>{t('独立验收尚未接入')}</strong><p>{t('执行结束或使命完成均不代表验收通过。接入可追溯的验收记录后，才能在这里接受或打回。')}</p></div>
    </section>
    <section className="loom-criteria">
      <h3>{t('验收条件')}</h3>
      <p>{t('尚未配置独立的验收条件。')}
        <span>{t('后续由任务合同提供；当前使命描述仍可在对话中查看。')}</span>
      </p>
    </section>
  </div>
}

export function LoomWorkspace({ mission, agents, onSource, onNotify, onWorkspaceCleanupRequested }: {
  mission: MissionRecord; agents: AgentProfile[]; onSource(id: string): void
  onNotify(message: string): void; onWorkspaceCleanupRequested(threadId: string): Promise<void>
}) {
  const [section, setSection] = useState<LoomSection>('activity')
  const [visited, setVisited] = useState<ReadonlySet<LoomSection>>(() => new Set(['activity']))
  const shared = useRef<HTMLDivElement>(null)
  const scrollPositions = useRef<Partial<Record<LoomSection, { top: number; left: number }>>>({})
  
  const client = useThreadClient()
  const [plan, setPlan] = useState<LoomPlan | null>(null)
  const [tasks, setTasks] = useState<LoomTask[]>([])
  const [dependencies, setDependencies] = useState<LoomDependency[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  
  useLayoutEffect(() => {
    if (section === 'plan') return
    const saved = scrollPositions.current[section]
    const node = shared.current
    if (node && saved) { node.scrollTop = saved.top; node.scrollLeft = saved.left }
  }, [section])
  
  useLayoutEffect(() => {
    let alive = true
    setLoading(true)
    void Promise.all([
      client.request<LoomPlan | null>('loom.plan.get', { missionId: mission.missionId }),
      client.request<LoomTask[]>('loom.tasks.list', { missionId: mission.missionId }),
      client.request<LoomDependency[]>('loom.dependencies.list', { missionId: mission.missionId })
    ]).then(([p, t, d]) => {
      if (alive) { setPlan(p); setTasks(t); setDependencies(d); setError('') }
    }).catch(e => {
      if (alive) setError(e.message ?? '读取编排数据失败')
    }).finally(() => {
      if (alive) setLoading(false)
    })
    return () => { alive = false }
  }, [client, mission.missionId])
  
  const select = (next: LoomSection): void => {
    const node = shared.current
    if (node && section !== 'plan') scrollPositions.current[section] = { top: node.scrollTop, left: node.scrollLeft }
    setSection(next)
    setVisited(current => current.has(next) ? current : new Set(current).add(next))
  }
  return <div className="loom-workspace">
    <nav className="loom-section-tabs" aria-label={uiAttribute('使命工作区')}>
      {(['activity', 'plan', 'delivery'] as const).map(id => <button key={id} type="button" aria-pressed={section === id} onClick={() => select(id)}>
        {id === 'plan' && <Icon name="branch"/>}{id === 'delivery' && <Icon name="check"/>}
        <UiText zh={id === 'activity' ? '活动' : id === 'plan' ? '编排' : '交付'}/>
      </button>)}
    </nav>
    <div className="loom-section-body">
      {visited.has('plan') && <div hidden={section !== 'plan'}><PlanWorkspace mission={mission} agents={agents} plan={plan} tasks={tasks} dependencies={dependencies} loading={loading} error={error}/></div>}
      <div ref={shared} className={section === 'delivery' ? 'loom-delivery' : 'mission-activity-document'} hidden={section === 'plan'}>
        {visited.has('delivery') && <div hidden={section !== 'delivery'}><DeliveryReview/></div>}
        <MissionDeliveryPanel mission={mission} agents={agents} onSource={onSource} onNotify={onNotify} onWorkspaceCleanupRequested={onWorkspaceCleanupRequested}/>
        <div hidden={section !== 'activity'}><MissionActivityPanel mission={mission} agents={agents} onSource={onSource}/></div>
      </div>
    </div>
  </div>
}

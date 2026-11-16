import type { ReactNode } from 'react'
import type { LoomClaim } from '@contracts'
import type { ArtifactSelection, WorkBundle } from './types'
import { Icon } from './icons'
import { agentRunWaitDetail } from '../../../shared/execution-presentation'
import { uiAttribute } from '../interface-language'
import { claimLeaseState, type V2ReadState, type V2RunFacts, type V2StatusFact, type V2UnavailableReason } from './v2-run-service'
import './run-status.css'

/** Read-only product surface. Each status comes from its own Core record;
 * no development fixture, model provenance or acceptance is inferred here. */
function reasonText(reason: V2UnavailableReason): string {
  const labels: Record<string, string> = {
    not_declared: '当前连接没有提供认领信息',
    method_unsupported: '当前主机版本不支持读取认领信息',
    interface_not_available: '该扩展记录暂不可用',
    no_candidate: '尚未关联候选成果',
    thread_mismatch: '对话与工作不匹配，未混用记录',
    mission_mismatch: '工作标识不匹配，未读取其他工作的记录',
    mission_required: '请先选择一项工作'
  }
  return uiAttribute(labels[reason] ?? '这项记录暂不可用')
}
function readNote(state: V2ReadState<unknown>): string | null {
  if (state.status === 'observed') return null
  if (state.status === 'failed') return uiAttribute('读取失败：') + state.message
  if (state.status === 'unknown') return uiAttribute('回执无法识别：') + state.message
  return reasonText(state.reason)
}
const label = (status: string, labels: Record<string, string>): string => uiAttribute(labels[status] ?? status)
const taskLabel = (s: string) => label(s, { draft:'草稿',ready:'待开始',blocked:'受阻',in_review:'审核中',done:'已完成',canceled:'已取消' })
const runLabel = (s: string) => label(s, { queued:'排队中',running:'执行中',waiting:'等待中',succeeded:'执行已结束',failed:'执行失败',cancelled:'已取消' })
const goalLabel = (s: string) => label(s, { needs_you:'需要你处理',not_started:'未开始',in_progress:'进行中',completed:'已完成' })
function statusText<T>(state: V2StatusFact<T>, render: (value:T)=>string, missing:string): string {
  return state.state === 'recorded' ? render(state.value) : state.state === 'not_recorded' ? uiAttribute(missing) : reasonText(state.reason)
}
function Group({ title, children }: { title:string; children:ReactNode }) {
  return <section className="ln-run-group"><h3>{title}</h3>{children}</section>
}
function ReadNote({ state }: { state:V2ReadState<unknown> }) {
  const text = readNote(state)
  return text === null ? null : <p className="ln-run-note" role={state.status === 'failed' || state.status === 'unknown' ? 'alert' : undefined}>{text}</p>
}
function leaseLabel(claim:LoomClaim): string {
  return label(claimLeaseState(claim), { held:'认领有效',expired:'认领已过期',released:'认领已释放' })
}
function fileName(path:string): string { return path.split(/[\\/]/u).filter(Boolean).pop() ?? path }

export function V2BotStatusPanel({ facts, bundle, onArtifact }: {
  facts:V2RunFacts; bundle:WorkBundle; onArtifact(selection:ArtifactSelection):void
}) {
  // A late projection must never acquire a newer bundle's review context.
  if (facts.missionId !== bundle.mission.missionId || facts.goal.mission.threadId !== bundle.mission.threadId) {
    return <p className="ln-run-note" role="alert">{uiAttribute('工作上下文已变化，请重新读取。')}</p>
  }
  const bots = facts.bots.status === 'observed' ? facts.bots.value : []
  const names = new Map(bots.map(bot => [bot.agentId, bot.displayName]))
  const resolveName = (id:string|null) => id === null ? uiAttribute('未指派') : names.get(id) || uiAttribute('其他助手')
  const titles = new Map(facts.workers.map(worker => [worker.taskId, worker.title]))
  const runs = facts.runs.status === 'observed' ? facts.runs.value : []
  const lead = facts.lead.status === 'observed' ? facts.lead.value : null
  return <section className="ln-run-panel" aria-label={uiAttribute('运行与成果概览')} data-mission-id={facts.missionId}>
    <div className="ln-run-goal">
      <div className="ln-run-line"><h2>{facts.goal.mission.title}</h2><span className="ln-run-badge">{goalLabel(facts.goal.mission.status)}</span></div>
      {facts.goal.mission.description && <p className="ln-run-description">{facts.goal.mission.description}</p>}
      <p className="ln-run-meta">{uiAttribute('负责人：')}{lead ? resolveName(lead.agentId) : uiAttribute('尚未确认')}
        {lead && !lead.matchesMissionLead && <span> · {uiAttribute('负责人记录不一致，请核对')}</span>}</p>
      <ReadNote state={facts.lead}/><ReadNote state={facts.bots}/>
    </div>

    <Group title={uiAttribute('成果')}>
      <p className="ln-run-hint">{uiAttribute('打开文件查看正文与审阅记录。打开不会自动接受成果。')}</p>
      {facts.artifacts.length === 0 ? <p className="ln-run-empty">{uiAttribute('尚无已登记成果。执行完成不等于成果已经交付。')}</p>
        : <ul className="ln-run-list">{facts.artifacts.map(entry => <li key={entry.artifact.artifactId} className="ln-run-artifact">
          <button type="button" className="ln-run-file" aria-label={uiAttribute('打开产物：') + fileName(entry.artifact.relativePath)}
            onClick={()=>onArtifact({ artifact:entry.artifact,candidate:entry.candidate,bundle })}>
            <Icon name="file" size={21}/><span><strong>{fileName(entry.artifact.relativePath)}</strong><small>{uiAttribute('已登记 · ')}{resolveName(entry.artifact.creatorId)}</small></span><Icon name="right" size={15}/>
          </button>
          <dl className="ln-run-facts">
            <div data-fact="verification"><dt>{uiAttribute('技术核验')}</dt><dd>{statusText(entry.verification,v=>uiAttribute(v.result==='passed'?'已通过':'未通过'),'未核验')}</dd></div>
            <div data-fact="review"><dt>{uiAttribute('评审记录')}</dt><dd>{statusText(entry.review,v=>uiAttribute(v.verdict==='accepted'?'已通过':'已退回'),'尚无评审')}</dd></div>
            <div data-fact="acceptance"><dt>{uiAttribute('用户接受')}</dt><dd>{statusText(entry.acceptance,v=>label(v,{accepted:'已接受',rejected:'已拒绝',pending:'待决定'}),'尚无结论')}</dd></div>
          </dl>
        </li>)}</ul>}
    </Group>

    <Group title={uiAttribute('任务分工')}>
      <ReadNote state={facts.claims}/>
      {facts.workers.length === 0 ? <p className="ln-run-empty">{uiAttribute('尚无任务记录。')}</p>
        : <ul className="ln-run-list">{facts.workers.map(worker => {
          const claim = worker.claim.status==='observed' ? worker.claim.value : null
          const activeClaim = claim !== null && claimLeaseState(claim)==='held'
          return <li key={worker.taskId} className="ln-run-task" data-task-id={worker.taskId}>
            <div className="ln-run-line"><strong>{worker.title}</strong><span className="ln-run-badge">{taskLabel(worker.status)}</span></div>
            <p className="ln-run-meta">{uiAttribute('负责：')}{resolveName(worker.assigneeAgentId)}
              {claim && <span> · {leaseLabel(claim)}{activeClaim && ' · '+uiAttribute('认领者：')+resolveName(claim.claimantAgentId)}</span>}
              {worker.claim.status==='observed' && claim===null && <span> · {uiAttribute('暂无认领记录')}</span>}
            </p>
            {worker.blockedReason && <p className="ln-run-note">{worker.blockedReason}</p>}
          </li>
        })}</ul>}
    </Group>

    <Group title={uiAttribute('执行记录')}>
      <ReadNote state={facts.runs}/>
      {facts.runs.status==='observed' && (runs.length===0 ? <p className="ln-run-empty">{uiAttribute('尚无执行记录。')}</p>
        : <ul className="ln-run-list">{runs.map(run=><li key={run.agentRunId} className="ln-run-task">
          <div className="ln-run-line"><strong>{resolveName(run.agentId)}</strong><span className="ln-run-badge">{runLabel(run.status)}</span></div>
          {run.taskId && <p className="ln-run-meta">{titles.get(run.taskId) ?? uiAttribute('关联任务不在当前列表中')}</p>}
          {run.status === 'waiting' && typeof run.waitReason === 'string' && run.waitReason.trim() !== '' && <p className="ln-run-note">{uiAttribute('等待原因：')}{uiAttribute((agentRunWaitDetail(run.waitReason) ?? (/\p{Script=Han}/u.test(run.waitReason) ? run.waitReason : '等待进一步处理，具体原因见来源与诊断。')).replaceAll('Rovai AI', 'LOOM'))}</p>}
        </li>)}</ul>)}
    </Group>

    <details className="ln-run-diagnostics"><summary>{uiAttribute('来源与诊断')}</summary>
      <p>{uiAttribute('这里只展示当前工作已有的主机记录，不推断模型来源、能力调用或完整交付。执行、核验、评审和用户接受分别读取，不相互代替。')}</p>
      <dl><div><dt>{uiAttribute('工作')}</dt><dd>{facts.missionId}</dd></div>
        <div><dt>{uiAttribute('认领读取')}</dt><dd>{facts.claims.status}{facts.claims.status==='unavailable' ? ' / '+facts.claims.reason : ''}</dd></div>
        {facts.claims.status==='observed' && <div><dt>{uiAttribute('主机判定时间')}</dt><dd>{facts.claims.value.evaluatedAt}</dd></div>}
        {Object.entries(facts.pendingInterfaces).map(([name,state])=><div key={name}><dt>{name}</dt><dd>{state.status+' / '+state.reason}</dd></div>)}
      </dl>
      {facts.claims.status==='observed' && facts.claims.value.claims.length===0 && <p>{uiAttribute('主机返回空认领列表；不据此推断助手空闲或没有执行。')}</p>}
      {facts.claims.status==='observed' && facts.claims.value.claims.map(claim=><p key={claim.claimId}>{uiAttribute('任务：')}{claim.taskId} · {uiAttribute('认领者：')}{claim.claimantAgentId ?? uiAttribute('未记录')} · {leaseLabel(claim)} · {uiAttribute('代次：')}{claim.fenceGeneration}</p>)}
      {runs.map(run=><p key={run.agentRunId}>{uiAttribute('执行：')}{run.agentRunId}{run.status==='waiting' && run.waitReason ? ' · '+run.waitReason : ''}</p>)}
      {facts.artifacts.map(entry=><p key={entry.artifact.artifactId}>{fileName(entry.artifact.relativePath)} · sha256 {entry.artifact.sha256}</p>)}
    </details>
  </section>
}

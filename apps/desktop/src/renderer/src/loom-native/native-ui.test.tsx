import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type {
  LoomArtifactPreviewResult,
  LoomControlPolicy,
  LoomControlSnapshot,
  LoomDispatch,
  LoomReview,
  LoomStageReview,
  MissionRecord
} from '@contracts'
import type { WorkBundle, LoomArtifact, LoomCandidate, LoomTask, ConversationItem, WorkControlFacts } from './types'
import { Sidebar } from './Sidebar'
import { Markdown } from './ConversationView'
import { workStatus } from './Inspector'
import { Inspector } from './Inspector'
import { ArtifactReviewStatus } from './ArtifactView'
import { artifactCandidateFacts, previewStateFromResult, reviewDraftComplete, submitArtifactReview, artifactFileName, readArtifactPreview, type LoomRpc } from './artifact-service'

const criteria = { version: 'pinned-v1', criteria: [{ criterionId: 'a', text: 'Content verified' }, { criterionId: 'b', text: 'Review complete' }] }
const task = { taskId:'t',planId:'p',title:'Actual work',description:'Actual description',assigneeAgentId:'a',status:'ready',acceptanceCriteria:criteria,blockedReason:null,createdAt:'2026-11-13T00:00:00Z',updatedAt:'2026-11-13T00:00:00Z',revision:1 } satisfies LoomTask
const artifact = { artifactId:'file1',planId:'p',taskId:'t',agentRunId:'r',relativePath:'out/report.md',sha256:'a'.repeat(64),sizeBytes:32,contentType:'text/markdown',creatorId:'a',createdAt:'2026-11-13T00:00:00Z' } satisfies LoomArtifact
const first = { candidateId:'c1',taskId:'t',agentRunId:'r',contentHash:'a'.repeat(64),evidenceIds:['file1'],acceptanceCriteria:criteria,previousCandidateId:null,verificationStatus:'unverified',acceptanceStatus:'pending',createdAt:'2026-11-13T00:00:00Z' } satisfies LoomCandidate
const second: LoomCandidate = { ...first,candidateId:'c2',evidenceIds:['file2'],previousCandidateId:'c1',createdAt:'2026-11-13T00:01:00Z' }
const mission = { missionId:'m',threadId:'th',title:'Real mission',runningAgentIds:[] } as unknown as MissionRecord
function bundle(candidates: LoomCandidate[] = [first], over: Partial<WorkBundle> = {}): WorkBundle { return {mission,plan:null,tasks:[task],candidates,artifacts:[artifact],reviews:[],verifications:[],...over} }
const preview: LoomArtifactPreviewResult = { artifactId:'file1',relativePath:'out/report.md',contentType:'text/markdown',sizeBytes:32,sha256:artifact.sha256,text:'# Exact archived text',unavailableReason:null }

// Control projection fixtures: the same shapes `loom.control.get` returns, so
// 「审查中／等你」的判定读的是真合同字段，不是为测试编出来的中间态。
const stageReview = (over: Partial<LoomStageReview> = {}): LoomStageReview => ({
  stageReviewId:'sr1',taskId:'t',candidateId:'c1',reviewerAgentId:'r',reviewerAgentRunId:'rr',
  policyRevision:1,manifestHash:'h',verdict:'pass',reason:'',criteriaResults:[],
  reviewedAt:'2026-11-13T06:00:00Z',...over })
const dispatch = (over: Partial<LoomDispatch> = {}): LoomDispatch => ({
  dispatchId:'d1',taskId:'t',kind:'review',candidateId:'c1',policyRevision:1,recipientAgentId:'r',
  deliveryId:null,status:'dispatched',reason:null,createdAt:'2026-11-13T06:00:00Z',...over })
const policy = (over: Partial<LoomControlPolicy> = {}): LoomControlPolicy => ({
  missionId:'m',planId:'p',revision:1,authorizationRevision:1,enabled:true,paused:false,
  taskIds:['t'],reviewers:[{taskId:'t',reviewerAgentId:'r'}],maxDispatches:4,maxReworksPerTask:1,
  expiresAt:null,approvedBy:'local_user',approvedAt:'2026-11-13T05:00:00Z',
  updatedAt:'2026-11-13T05:00:00Z',...over })
const observed = (over: Partial<LoomControlSnapshot> = {}): WorkControlFacts => ({ status:'observed',
  snapshot:{ missionId:'m',policy:null,stageReviews:[],dispatches:[],evaluatedAt:'2026-11-13T06:00:00Z',...over } })
const unknown = (reason: 'not_read' | 'read_failed' | 'invalid'): WorkControlFacts => ({ status:'unknown',reason,message:reason })
const review = (over: Partial<LoomReview> = {}): LoomReview => ({
  reviewId:'rev1',candidateId:'c1',acceptanceCriteriaVersion:criteria.version,verdict:'rejected',
  reason:'Needs another pass',criteriaResults:[],reviewerId:'local_user',reviewedAt:'2026-11-13T06:00:00Z',...over })

describe('native reference frontend boundaries', () => {
  it('renders a unified conversation sidebar without the old shell or project headings', () => {
    const items: ConversationItem[] = [{id:'th',title:'Actual conversation',subtitle:'Latest actual reply',agentId:null,threadId:'th',missionId:'m',unread:true,updatedAt:null}]
    const html = renderToStaticMarkup(createElement(Sidebar,{agents:[],items,selectedId:'th',loading:false,onSelect:()=>{},onCreate:()=>{},onCollapse:()=>{}}))
    expect(html).toContain('ln-conversation-row is-selected')
    expect(html).toContain('Actual conversation'); expect(html).toContain('Latest actual reply')
    expect(html).toContain('aria-current="page"');expect(html).toContain('ln-unread-dot')
    expect(html).not.toMatch(/unified-sidebar|camp-nav|mission-rail|Rovai|ROVAI|使命板|项目目录/)
  })
  it('keeps rich table/code/list structure instead of flattening messages', () => {
    const html=renderToStaticMarkup(createElement(Markdown,{text:'| PR | Status |\n|---|---|\n| #1 | Review |\n\n1. First\n2. Next\n\n```ts\nconst a = 1\n```'}))
    expect(html).toContain('<table>');expect(html).toContain('<ol>');expect(html).toContain('<pre>')
  })
  it('does not turn arbitrary Markdown scripts into executable HTML', () => {
    const html=renderToStaticMarkup(createElement(Markdown,{text:'<script>alert(1)</script>'}))
    expect(html).not.toContain('<script>')
  })
  it('does not label ready work as running without actual run state', () => {
    expect(workStatus({task,mission,candidate:null}).group).toBe('待开始')
  })
  it('uses actual running agent membership to show execution', () => {
    expect(workStatus({task,mission:{...mission,runningAgentIds:['a']},candidate:null}).group).toBe('进行中')
  })
  it('keeps pending acceptance separate from done once the control facts are read', () => {
    // 没有独立审查者、审查也不在办：候选的 pending 就是「等你」。
    expect(workStatus({task:{...task,status:'done'},mission,candidate:first,control:observed()}).group).toBe('等待你')
  })
  it('does not show a pending candidate as waiting while the machine review is in flight', () => {
    // 机器审查中 + 候选 pending：卡片是「审查中」，绝不提前占你的队列。
    for (const status of ['waiting','dispatched'] as const) {
      const card = workStatus({task:{...task,status:'in_review'},mission,candidate:first,
        control:observed({dispatches:[dispatch({status})]})})
      expect(card).toEqual({label:'审查中',group:'进行中',icon:'progress'})
    }
  })
  it('never reads a pending candidate as waiting when the control facts are unknown', () => {
    for (const reason of ['not_read','read_failed','invalid'] as const) {
      expect(workStatus({task:{...task,status:'done'},mission,candidate:first,control:unknown(reason)}).group).toBe('进行中')
      expect(workStatus({task,candidate:first,mission}).label).toBe('审查中')
    }
  })
  it('waits for you once the assigned machine review has come back', () => {
    expect(workStatus({task:{...task,status:'in_review'},mission,candidate:first,
      control:observed({policy:policy(),stageReviews:[stageReview()]})})).toMatchObject({label:'等你',group:'等待你'})
    // 授权下指定了独立审查者但还没交回结论：仍在审查中。
    expect(workStatus({task:{...task,status:'in_review'},mission,candidate:first,
      control:observed({policy:policy()})})).toMatchObject({label:'审查中',group:'进行中'})
  })
  it('a rework request or a stale machine verdict never becomes your queue', () => {
    expect(workStatus({task:{...task,status:'in_review'},mission,candidate:first,
      control:observed({policy:policy(),stageReviews:[stageReview({verdict:'request_changes'})]})}).label).toBe('返工中')
    // 旧授权下的「要求返工」已被取代：需要新授权下重新审，不是返工也不是等你。
    expect(workStatus({task:{...task,status:'in_review'},mission,candidate:first,
      control:observed({policy:policy({authorizationRevision:2}),stageReviews:[stageReview({verdict:'request_changes'})]})}).label)
      .toBe('审查中')
  })
  it('shows the artifact-side outcome for accepted, rejected, blocked and preparing work', () => {
    const accepted = {...first,acceptanceStatus:'accepted' as const}
    expect(workStatus({task:{...task,status:'done'},mission,candidate:accepted,control:observed()}))
      .toMatchObject({label:'已接受',group:'已完成'})
    const rejected = {...first,acceptanceStatus:'rejected' as const}
    expect(workStatus({task:{...task,status:'in_review'},mission,candidate:rejected,control:observed()}))
      .toMatchObject({label:'返工中',group:'进行中'})
    // 当前授权下的阶段审查判了阻塞：受阻。
    expect(workStatus({task:{...task,status:'in_review'},mission,candidate:first,
      control:observed({policy:policy(),stageReviews:[stageReview({verdict:'blocked'})]})}).group).toBe('受阻')
    // 候选已登记、归档还没见到：准备中。
    expect(workStatus({task,candidate:first,mission,hasArtifact:false,control:observed()}))
      .toMatchObject({label:'准备中',group:'进行中'})
  })
  it('does not hide blocked work behind a pending candidate', () => {
    expect(workStatus({task:{...task,status:'blocked'},mission,candidate:first}).group).toBe('受阻')
  })
  it('treats a Core blocker written only onto the task as blocked', () => {
    // 预算耗尽/前置结果未知不改任务状态，只写 blocked_reason：仍必须说「受阻」。
    for (const reason of ['loom.dispatch_budget_exhausted','loom.rework_budget_exhausted','loom.dispatch_previous_outcome_unknown'] as const) {
      expect(workStatus({task:{...task,status:'in_review',blockedReason:reason},mission,candidate:first,control:observed()}))
        .toMatchObject({label:'受阻',group:'受阻'})
    }
  })
  // 卡片渲染夹具：直接挂真实 Inspector，再截出一张 ln-task-card 的 HTML。
  const card = (control: WorkControlFacts, tasks: LoomTask[] = [task], candidates: LoomCandidate[] = [first],
    extra: Partial<WorkBundle> = {}) => {
    const html = renderToStaticMarkup(createElement(Inspector, {
      agents: [], bundles: [bundle(candidates, { control, tasks, ...extra })],
      agent: null, mode: 'work' as const, tab: 'work' as const,
      onTab: () => {}, onMode: () => {}, onClose: () => {}, onExpand: () => {}, expanded: false,
      onArtifact: () => {}, onOpenConversation: () => {}, loading: false
    }))
    return html.match(/<button class="ln-task-card"[\s\S]*?<\/button>/)?.[0] ?? ''
  }
  it('keeps an accepted card out of 受阻 when Core left a dispatch blocker on the task', () => {
    // 真实链：机器审查 pass → handoff 派发写阻塞原因 → 用户接受。Core 只把任务改成 DONE，
    // 不清 blocked_reason；卡片必须停在「已完成 · 已接受」，不能永久挂在「受阻」。
    const accepted = { ...first, acceptanceStatus: 'accepted' as const }
    for (const reason of ['loom.dispatch_budget_exhausted', 'loom.dispatch_recipient_unavailable'] as const) {
      const done: LoomTask = { ...task, status: 'done', blockedReason: reason }
      const control = observed()
      expect(workStatus({ task: done, mission, candidate: accepted, control, reviews: [review({ verdict: 'accepted' })] }))
        .toMatchObject({ label: '已接受', group: '已完成' })
      expect(workStatus({ task: done, mission, candidate: accepted, control: undefined }))
        .toMatchObject({ label: '已接受', group: '已完成' })
      const html = card(control, [done], [accepted], { reviews: [review({ verdict: 'accepted' })] })
      expect(html).toContain('已接受')
      expect(html).not.toContain('受阻')
      // 浮层与资产行同一条规则：同一份归档报「已接受」，不报「受阻」。
      const facts = artifactCandidateFacts(
        bundle([accepted], { control, tasks: [done], reviews: [review({ verdict: 'accepted' })] }), artifact, null)
      expect(facts.reviewKind).toBe('accepted')
      // 同一原因配上仍待验收的候选：仍是「受阻」，不能为了终局把在办说成没停。
      expect(workStatus({ task: { ...task, status: 'in_review', blockedReason: reason }, mission, candidate: first, control }))
        .toMatchObject({ label: '受阻', group: '受阻' })
    }
  })
  it('prints the derived status on the card even when the task already has a description', () => {
    // 有描述的任务不能把状态顶掉：描述与状态同时可见。
    const reviewing = card(observed({ dispatches: [dispatch()] }))
    expect(reviewing).toContain('Actual description')
    expect(reviewing).toContain('审查中')
    expect(card(observed({ policy: policy(), stageReviews: [stageReview({ verdict: 'request_changes' })] }))).toContain('返工中')
    const blocked: LoomTask = { ...task, blockedReason: 'loom.rework_budget_exhausted' }
    expect(card(observed(), [blocked])).toContain('受阻')
  })
})

describe('native immutable artifact and explicit acceptance', () => {
  it('returns the exact archived text, not the current disk contents', () => {
    expect(previewStateFromResult(preview)).toEqual({status:'ready',text:preview.text})
  })
  it.each(['binary','too_large','not_archived'] as const)('preserves unavailable state %s', reason => {
    expect(previewStateFromResult({...preview,text:null,unavailableReason:reason})).toEqual({status:'unavailable',reason})
  })
  it('reports invalid preview payload as error instead of pretending no archive exists', () => {
    expect(previewStateFromResult({...preview,text:null})).toMatchObject({status:'error'})
  })
  it('historical file stays attached to its historical candidate and cannot be accepted', () => {
    const facts=artifactCandidateFacts(bundle([first,second]),artifact,first)
    expect(facts.candidate?.candidateId).toBe('c1');expect(facts.latest).toBe(false);expect(facts.reviewable).toBe(false)
  })
  it('does not swap evidence ownership to an unrelated preferred candidate', () => {
    expect(artifactCandidateFacts(bundle([first,second]),artifact,second).candidate?.candidateId).toBe('c1')
  })
  it('uses the candidate-pinned criteria rather than plan mutation', () => {
    expect(artifactCandidateFacts(bundle(),artifact,first).criteriaVersion).toBe('pinned-v1')
  })
  it('requires nonblank reason and every criterion for acceptance', () => {
    const facts=artifactCandidateFacts(bundle(),artifact,first)
    expect(reviewDraftComplete({candidateId:'c1',verdict:'accepted',reason:'  ',satisfied:['a','b']},facts)).toBe(false)
    expect(reviewDraftComplete({candidateId:'c1',verdict:'accepted',reason:'Reviewed',satisfied:['a']},facts)).toBe(false)
    expect(reviewDraftComplete({candidateId:'c1',verdict:'accepted',reason:'Reviewed',satisfied:['a','b']},facts)).toBe(true)
    expect(reviewDraftComplete({candidateId:'c1',verdict:'rejected',reason:'Needs revision',satisfied:[]},facts)).toBe(true)
  })
  it('cannot submit a historical review even if invoked outside the component', async () => {
    const request=vi.fn();const facts=artifactCandidateFacts(bundle([first,second]),artifact,first)
    await expect(submitArtifactReview({request} as unknown as LoomRpc,'m',facts,{candidateId:'c1',verdict:'accepted',reason:'Yes',satisfied:['a','b']})).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
  it('submits exactly the pinned candidate and criteria with no spoofed reviewer identity', async () => {
    const request=vi.fn().mockResolvedValue({});const facts=artifactCandidateFacts(bundle(),artifact,first)
    await submitArtifactReview({request} as unknown as LoomRpc,'m',facts,{candidateId:'c1',verdict:'accepted',reason:' Reviewed ',satisfied:['a','b']})
    expect(request).toHaveBeenCalledTimes(1)
    const [method,input]=request.mock.calls[0]
    expect(method).toBe('loom.review.record');expect(input).toMatchObject({missionId:'m',candidateId:'c1',taskId:'t',acceptanceCriteriaVersion:'pinned-v1',reason:'Reviewed'})
    expect(input).not.toHaveProperty('reviewerId');expect(input.criteriaResults).toHaveLength(2)
  })
  it('keeps filenames without promoting path strings into file access', () => {expect(artifactFileName('out/report.md')).toBe('report.md')})
  it('opens a historical result through its own archive instead of the newest one', async () => {
    const request = vi.fn().mockResolvedValue(preview)
    const state = await readArtifactPreview({request} as unknown as LoomRpc,'m',artifact.artifactId)
    expect(request).toHaveBeenCalledWith('loom.artifact.preview',{missionId:'m',artifactId:'file1'})
    expect(state).toEqual({status:'ready',text:preview.text})
    // 历史候选保留自己的归档与旧版本状态：已归档、不可验收。
    const facts = artifactCandidateFacts(bundle([first,second],{control:observed()}),artifact,null)
    expect(facts.candidate?.candidateId).toBe('c1')
    expect(facts.reviewKind).toBe('ready')
    expect(facts.reviewable).toBe(false)
  })
})

describe('artifact status never says you are being waited on while the machine reviews', () => {
  it('shows 审查中 for a candidate the machine review has not concluded', () => {
    const html = renderToStaticMarkup(createElement(ArtifactReviewStatus,{kind:'reviewing'}))
    expect(html).toContain('成果状态')
    expect(html).toContain('审查中')
    expect(html).toContain('助手审查还没有交回结论。')
    expect(html).not.toContain('等你')
  })
  it('shows 等你 only when the review conclusion has come back', () => {
    const html = renderToStaticMarkup(createElement(ArtifactReviewStatus,{kind:'review'}))
    expect(html).toContain('data-state="review"')
    expect(html).toContain('等你')
    expect(html).not.toContain('审查中')
  })
  it('shows the rework and archived states in the same place', () => {
    expect(renderToStaticMarkup(createElement(ArtifactReviewStatus,{kind:'fixing'}))).toContain('返工中')
    expect(renderToStaticMarkup(createElement(ArtifactReviewStatus,{kind:'ready'}))).toContain('已归档')
  })
  it('keeps a superseded artifact archived instead of reporting a rework in progress', () => {
    const second = {...first,candidateId:'c2',agentRunId:'r2',evidenceIds:['file2'],previousCandidateId:'c1',createdAt:'2026-11-13T00:05:00Z'}
    const secondArtifact = {...artifact,artifactId:'file2',sha256:'b'.repeat(64),createdAt:'2026-11-13T00:05:00Z'}
    // c1 已被 c2 取代，返工说的是链头 c2：旧归档只能显示「已归档」，不能声称助手在改它。
    const facts = artifactCandidateFacts(bundle([first,second],{
      artifacts:[artifact,secondArtifact],
      control: observed({ policy: policy(), stageReviews: [stageReview({candidateId:'c2',verdict:'request_changes'})] })
    }), artifact, null)
    expect(facts.candidate?.candidateId).toBe('c1')
    expect(facts.latest).toBe(false)
    expect(facts.reviewKind).toBe('ready')
    const html = renderToStaticMarkup(createElement(ArtifactReviewStatus,{kind:facts.reviewKind}))
    expect(html).toContain('已归档')
    expect(html).not.toContain('返工中')
    expect(html).not.toContain('等你')
  })
  it('renders nothing when there is no artifact-side conclusion to show', () => {
    expect(renderToStaticMarkup(createElement(ArtifactReviewStatus,{kind:'none'}))).toBe('')
  })
  it('places a machine-reviewed pending candidate under 进行中, not under 等待你', () => {
    const panel = (control: WorkControlFacts) => renderToStaticMarkup(createElement(Inspector, {
      agents: [], bundles: [bundle([first], { control })],
      agent: null, mode: 'work' as const, tab: 'work' as const,
      onTab: () => {}, onMode: () => {}, onClose: () => {}, onExpand: () => {}, expanded: false,
      onArtifact: () => {}, onOpenConversation: () => {}, loading: false
    }))
    // 机器审查还在办：卡片在「进行中」，等待你的分组根本不存在。
    const inReview = panel(observed({ dispatches: [dispatch({ status: 'dispatched' })] }))
    expect(inReview).toContain('进行中（1）')
    expect(inReview).not.toContain('等待你（')
    // 审查结论已交回：才进「等待你」。
    const concluded = panel(observed())
    expect(concluded).toContain('等待你（1）')
    expect(concluded).not.toContain('进行中（1）')
  })
  it('shows the artifact status on the asset row it opens', () => {
    const assets = (control: WorkControlFacts) => renderToStaticMarkup(createElement(Inspector, {
      agents: [], bundles: [bundle([first], { control })],
      agent: null, mode: 'assets' as const, tab: 'assets' as const,
      onTab: () => {}, onMode: () => {}, onClose: () => {}, onExpand: () => {}, expanded: false,
      onArtifact: () => {}, onOpenConversation: () => {}, loading: false
    }))
    expect(assets(observed({ dispatches: [dispatch()] }))).toContain('审查中')
    expect(assets(observed())).toContain('等你')
  })
})

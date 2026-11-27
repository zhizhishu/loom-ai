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
import type { PiQuestion } from './pi-questions'
import { Sidebar } from './Sidebar'
import { AgentMarkdown } from './AgentMarkdown'
import { workStatus, attentionFactsFromWork, flattenWork } from './Inspector'
import { Inspector } from './Inspector'
import { ATTENTION_BUDGET } from './attention'
import { ArtifactReviewStatus } from './ArtifactView'
import { artifactCandidateFacts, previewStateFromResult, reviewDraftComplete, submitArtifactReview, artifactFileName, readArtifactPreview, artifactMediaKind, decodeArtifactBase64, normalizeArtifactMediaType, type LoomRpc } from './artifact-service'
import { PDF_MAX_CANVAS_PIXELS, pdfPageGeometry, pdfPageSlotSize, pdfRenderErrorMessage, pdfjsAssetUrl, pdfjsWorkerUrl } from './artifact-pdf'
import { ArtifactPdfPage, ArtifactPdfPreview } from './ArtifactPdfPreview'

const criteria = { version: 'pinned-v1', criteria: [{ criterionId: 'a', text: 'Content verified' }, { criterionId: 'b', text: 'Review complete' }] }
const task = { taskId:'t',planId:'p',title:'Actual work',description:'Actual description',assigneeAgentId:'a',status:'ready',acceptanceCriteria:criteria,blockedReason:null,createdAt:'2026-11-13T00:00:00Z',updatedAt:'2026-11-13T00:00:00Z',revision:1 } satisfies LoomTask
const artifact = { artifactId:'file1',planId:'p',taskId:'t',agentRunId:'r',relativePath:'out/report.md',sha256:'a'.repeat(64),sizeBytes:32,contentType:'text/markdown',creatorId:'a',createdAt:'2026-11-13T00:00:00Z' } satisfies LoomArtifact
const first = { candidateId:'c1',taskId:'t',agentRunId:'r',contentHash:'a'.repeat(64),evidenceIds:['file1'],acceptanceCriteria:criteria,previousCandidateId:null,verificationStatus:'unverified',acceptanceStatus:'pending',createdAt:'2026-11-13T00:00:00Z' } satisfies LoomCandidate
const second: LoomCandidate = { ...first,candidateId:'c2',evidenceIds:['file2'],previousCandidateId:'c1',createdAt:'2026-11-13T00:01:00Z' }
const mission = { missionId:'m',threadId:'th',title:'Real mission',runningAgentIds:[] } as unknown as MissionRecord
function bundle(candidates: LoomCandidate[] = [first], over: Partial<WorkBundle> = {}): WorkBundle { return {mission,plan:null,tasks:[task],candidates,artifacts:[artifact],reviews:[],verifications:[],...over} }
const preview: LoomArtifactPreviewResult = { artifactId:'file1',relativePath:'out/report.md',contentType:'text/markdown',sizeBytes:32,sha256:artifact.sha256,text:'# Exact archived text',bytesBase64:null,mediaType:null,unavailableReason:null }

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
    const html=renderToStaticMarkup(createElement(AgentMarkdown,{text:'| PR | Status |\n|---|---|\n| #1 | Review |\n\n1. First\n2. Next\n\n```ts\nconst a = 1\n```'}))
    expect(html).toContain('<table>');expect(html).toContain('<ol>');expect(html).toContain('data-agent-code-pre')
  })
  it('does not turn arbitrary Markdown scripts into executable HTML', () => {
    const html=renderToStaticMarkup(createElement(AgentMarkdown,{text:'<script>alert(1)</script>'}))
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

// 四个页签的空态：搬 Mikka `components/ui/empty.tsx` 的 `Empty / EmptyHeader /
// EmptyMedia / EmptyTitle / EmptyContent`，空态里必须带一个下一步动作
// （`issue-list.tsx:49-51`、`project-workspace.tsx:62` 的用例）。
describe('workspace dock empty states (Mikka empty.tsx)', () => {
  const dock = (mode: 'work' | 'assets' | 'map' | 'computer') => renderToStaticMarkup(createElement(Inspector, {
    agents: [], bundles: [], agent: null, mode, tab: 'details' as const,
    onTab: () => {}, onMode: () => {}, onClose: () => {}, onExpand: () => {}, expanded: false,
    onArtifact: () => {}, onOpenConversation: () => {}, loading: false,
    onCreateWork: () => {}, onConnectDevice: () => {}
  }))
  it('gives every tab the same empty structure with a next step', () => {
    const work = dock('work')
    expect(work).toContain('data-slot="empty"')
    expect(work).toContain('data-slot="empty-title"')
    expect(work).toContain('从一个目标开始')
    expect(work).toContain('创建一项工作')
    expect(dock('assets')).toContain('成果会留在这里')
    const flow = dock('map')
    expect(flow).toContain('流程和成果关系会连在这里')
    expect(flow).toContain('创建一项工作')
    const computer = dock('computer')
    expect(computer).toContain('还没有可以查看的电脑')
    expect(computer).toContain('去连接设备')
  })
  it('keeps the old flat grey paragraph out of the four tabs', () => {
    for (const mode of ['work', 'assets', 'map', 'computer'] as const) {
      expect(dock(mode)).not.toContain('ln-inspector-empty')
      expect(dock(mode)).not.toContain('ln-dock-empty')
    }
  })
})

// 媒体预览：图片、PDF 与视频走同一条 loom.artifact.preview 回执的字节，Markdown/纯文本的行为不动。
// 这里的断言只吃契约字段（mediaType/bytesBase64），不编造 Core 不会返回的形状。
describe('artifact media preview', () => {
  // 0x89 0x50 0x4e 0x47 = PNG 魔数前四字节；base64 由 Core 的标准编码产生。
  const pngBase64 = 'iVBORw=='
  const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
  const media = (over: Partial<LoomArtifactPreviewResult> = {}): LoomArtifactPreviewResult =>
    ({ ...preview, relativePath: 'out/shot.png', text: null, bytesBase64: pngBase64, mediaType: 'image/png', ...over })

  it('maps a whitelisted image to the image media state with the archived bytes', () => {
    const state = previewStateFromResult(media())
    expect(state.status).toBe('media')
    expect(state).toMatchObject({ status: 'media', media: { mediaType: 'image/png', kind: 'image' } })
    expect(state.status === 'media' ? Array.from(state.media.bytes) : null).toEqual(Array.from(pngBytes))
  })
  it('maps a PDF to the pdf media state instead of the text body', () => {
    const state = previewStateFromResult(media({ relativePath: 'out/report.pdf', mediaType: 'application/pdf', bytesBase64: 'JVBERi0=' }))
    expect(state).toMatchObject({ status: 'media', media: { mediaType: 'application/pdf', kind: 'pdf' } })
  })
  it('maps whitelisted videos to the video media state', () => {
    for (const mediaType of ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'] as const) {
      const state = previewStateFromResult(media({ relativePath: 'out/recording.mp4', mediaType, bytesBase64: 'dmlkZW8=' }))
      expect(state).toMatchObject({ status: 'media', media: { mediaType, kind: 'video' } })
    }
  })
  it('never serves media bytes as text even when both fields are present', () => {
    // 字节恰好是 UTF-8 也不行：命中媒体就走媒体，文本分支只属于非媒体文件。
    const state = previewStateFromResult(media({ text: 'looks like text' }))
    expect(state.status).toBe('media')
    expect(state).not.toHaveProperty('text')
  })
  it('keeps Markdown and plain text exactly as they were', () => {
    expect(previewStateFromResult({ ...preview, bytesBase64: null, mediaType: null }))
      .toEqual({ status: 'ready', text: '# Exact archived text' })
    expect(previewStateFromResult(media({ relativePath: 'out/notes.txt', mediaType: null, bytesBase64: null, text: 'plain' })))
      .toEqual({ status: 'ready', text: 'plain' })
  })
  it('reports a media hit without usable bytes as an error instead of success', () => {
    for (const broken of [null, '', 'not base64!', 'abc']) {
      expect(previewStateFromResult(media({ bytesBase64: broken }))).toMatchObject({ status: 'error' })
    }
    // 缺字段同样不能当成「不是媒体」而落回文本。
    const missing = { ...preview, relativePath: 'out/shot.png', text: null, mediaType: 'image/png' }
    expect(previewStateFromResult(missing)).toMatchObject({ status: 'error' })
  })
  it('does not treat unsupported or malformed media types as media', () => {
    for (const value of ['image/svg+xml', 'text/html', 'image/png; charset=binary', '', null, 42]) {
      expect(normalizeArtifactMediaType(value)).toBeNull()
    }
    // 不认识的类型：有正文就仍是正文，没正文就是读失败。
    expect(previewStateFromResult(media({ mediaType: 'image/svg+xml', text: '<svg/>' })))
      .toEqual({ status: 'ready', text: '<svg/>' })
    expect(previewStateFromResult(media({ mediaType: 'image/svg+xml', text: null })))
      .toMatchObject({ status: 'error' })
  })
  it('keeps the Core unavailable reasons in front of any media branch', () => {
    for (const reason of ['too_large', 'not_archived', 'binary'] as const) {
      expect(previewStateFromResult(media({ bytesBase64: null, unavailableReason: reason })))
        .toEqual({ status: 'unavailable', reason })
    }
  })
  it('only accepts strict standard base64', () => {
    expect(decodeArtifactBase64(pngBase64)).toEqual(pngBytes)
    expect(decodeArtifactBase64('')).toBeNull()
    expect(decodeArtifactBase64('iVBORw')).toBeNull()
    expect(decodeArtifactBase64('iVBO Rw==')).toBeNull()
    expect(decodeArtifactBase64('iVBORw==\n')).toBeNull()
    expect(decodeArtifactBase64(42)).toBeNull()
    expect(artifactMediaKind('application/pdf')).toBe('pdf')
    for (const image of ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const) {
      expect(artifactMediaKind(image)).toBe('image')
    }
    for (const video of ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'] as const) {
      expect(artifactMediaKind(video)).toBe('video')
    }
  })
  it('serves pdf.js assets from the privileged protocol on file: pages and relatively on http', () => {
    const fileBase = 'file:///app/out/renderer/index.html'
    // 生产 loadFile：file 页面自己取不到 file:// 兄弟资源（CORS/XHR 都不允许），
    // 改走主进程协议，协议根就是 out/renderer/pdfjs，所以路径里不再带 pdfjs/ 前缀。
    expect(pdfjsAssetUrl('cmaps/', fileBase)).toBe('rovai-pdfjs://asset/cmaps/')
    expect(pdfjsAssetUrl('/standard_fonts/', fileBase)).toBe('rovai-pdfjs://asset/standard_fonts/')
    expect(pdfjsAssetUrl('wasm/', fileBase)).toBe('rovai-pdfjs://asset/wasm/')
    expect(pdfjsAssetUrl('iccs/', fileBase)).toBe('rovai-pdfjs://asset/iccs/')
    expect(pdfjsWorkerUrl('6.4.299', fileBase)).toBe('rovai-pdfjs://asset/pdf.worker.min.mjs?v=6.4.299')
    // 开发期是 http 基址：同一相对路径解析到 dev server，不是站点根，也不是私有协议。
    expect(pdfjsAssetUrl('cmaps/', 'http://localhost:5173/')).toBe('http://localhost:5173/pdfjs/cmaps/')
    expect(pdfjsWorkerUrl('6.4.299', 'http://localhost:5173/'))
      .toBe('http://localhost:5173/pdfjs/pdf.worker.min.mjs?v=6.4.299')
    // 两种形态都不许出现 `file:` 直读，也不许把 pdfjs/ 再嵌一层。
    for (const url of ['cmaps/', 'standard_fonts/', 'wasm/', 'iccs/', 'pdf.worker.min.mjs'].map(path => pdfjsAssetUrl(path, fileBase))) {
      expect(url.startsWith('rovai-pdfjs://asset/')).toBe(true)
      expect(url.includes('file:')).toBe(false)
      expect(url.includes('pdfjs/pdfjs')).toBe(false)
    }
    // http 形态仍然是「文档基址 + pdfjs/…」：根路径 `/pdfjs` 在生产 loadFile 下会 404。
    for (const url of ['cmaps/', 'wasm/', 'iccs', 'pdf.worker.min.mjs'].map(path => pdfjsAssetUrl(path, 'https://rovai.example/out/renderer/index.html'))) {
      expect(url.startsWith('https://rovai.example/out/renderer/pdfjs/')).toBe(true)
    }
  })
  it('caps a single page bitmap and keeps the page aspect ratio', () => {
    // A4 @2x：普通页不降采样，占位与位图都按同一比例放大。
    const a4 = pdfPageGeometry(595, 842, 2)
    expect(a4.css).toEqual({ width: 595, height: 842 })
    expect(a4.pixels).toEqual({ width: 1190, height: 1684 })
    expect(a4.transform).toEqual([2, 0, 0, 2, 0, 0])
    // 怪页（两万点见方）也只许吃到像素上限，且宽高比不能被拉歪。
    const huge = pdfPageGeometry(20000, 20000, 2)
    expect(huge.pixels.width * huge.pixels.height).toBeLessThanOrEqual(PDF_MAX_CANVAS_PIXELS)
    expect(huge.pixels.width * huge.pixels.height * 4).toBeLessThanOrEqual(64 * 1024 * 1024)
    expect(Math.abs(huge.pixels.width / huge.pixels.height - 1)).toBeLessThan(0.01)
    // 1:1 时不传 transform（pdf.js 默认就是 1:1），dpr 非法也退回 1。
    expect(pdfPageGeometry(600, 800, 1).transform).toBeUndefined()
    expect(pdfPageGeometry(600, 800, Number.NaN).pixels).toEqual({ width: 600, height: 800 })
  })
  it('sizes a not-yet-rendered page from the first page so scrolling never jumps', () => {
    expect(pdfPageSlotSize(595, 842, 1)).toEqual({ width: 595, height: 842 })
    expect(pdfPageSlotSize(595, 842, 1.5)).toEqual({ width: 893, height: 1263 })
    expect(pdfPageSlotSize(0, Number.NaN, 2)).toEqual({ width: 1, height: 1 })
  })
  it('gives an off-screen page a height placeholder and a page number instead of a bitmap', () => {
    // 离屏页只留占位与页码：没有位图就没有 backing store，页数再多也不涨内存。
    const html = renderToStaticMarkup(createElement(ArtifactPdfPage, {
      pdfDocument: null, pageNumber: 7, scale: 1.5, live: false,
      slot: pdfPageSlotSize(595, 842, 1.5), onError: () => undefined
    }))
    expect(html).toContain('data-page="7"')
    expect(html).toContain('data-live="false"')
    expect(html).toContain('data-rendered="false"')
    expect(html).toContain('height:1263px')
    expect(html).toContain('width:893px')
    expect(html).toContain('ln-artifact-pdf-page-number">7</span>')
  })
  it('gives the PDF surface the required controls and a loading state before any render', () => {
    // 静态渲染只跑到「打开中」：真正的画布渲染要 Electron 的 canvas，这里锁定的是
    // 页数位、缩小/放大/适配宽度和加载态都必须真实存在，而不是空白容器。
    const html = renderToStaticMarkup(createElement(ArtifactPdfPreview, { bytes: Uint8Array.from([0x25, 0x50]), fileName: 'report.pdf' }))
    expect(html).toContain('ln-artifact-pdf')
    expect(html).toContain('正在打开 PDF…')
    expect(html).toContain('aria-label="缩小"')
    expect(html).toContain('aria-label="放大"')
    expect(html).toContain('aria-label="适配宽度"')
    expect(html).toContain('aria-label="report.pdf PDF 预览"')
  })
  it('classifies pdf.js failures into readable messages without leaking a stack', () => {
    expect(pdfRenderErrorMessage(new Error('No password given'))).toBe('这份 PDF 受密码保护，无法预览。')
    expect(pdfRenderErrorMessage(new Error('InvalidPDFException: bad xref'))).toBe('这份 PDF 无法解析。')
    expect(pdfRenderErrorMessage(new Error('boom'))).toBe('PDF 渲染失败：boom')
    expect(pdfRenderErrorMessage(undefined)).toBe('PDF 渲染失败。')
    expect(pdfRenderErrorMessage(new Error('x'.repeat(400))).length).toBeLessThan(240)
  })
})

// 注意力评分/预算（attention.ts，Mikka score/budget/interrupt 的 renderer 移植）：
// 「等待你」分组按分数排序、只露出预算内条数，其余聚合成一行；计数只算预算内有效项。
describe('attention budget in the 等待你 group', () => {
  const waiting = (entries: Array<{ taskId: string; title: string; createdAt: string }>) => {
    const tasks: LoomTask[] = []
    const candidates: LoomCandidate[] = []
    for (const entry of entries) {
      tasks.push({ ...task, taskId: entry.taskId, title: entry.title, status: 'done' })
      candidates.push({ ...first, candidateId: `c-${entry.taskId}`, taskId: entry.taskId, createdAt: entry.createdAt })
    }
    return bundle(candidates, { tasks, control: observed() })
  }
  const dock = (bundles: WorkBundle[]) => renderToStaticMarkup(createElement(Inspector, {
    agents: [], bundles, agent: null, mode: 'work' as const, tab: 'work' as const,
    onTab: () => {}, onMode: () => {}, onClose: () => {}, onExpand: () => {}, expanded: false,
    onArtifact: () => {}, onOpenConversation: () => {}, loading: false
  }))
  it('surfaces only the budgeted first cards and aggregates the rest into one quiet line', () => {
    const entries = Array.from({ length: 7 }, (_, index) =>
      ({ taskId: `wt-${index}`, title: `实际工作 ${index}`, createdAt: '2026-11-13T00:00:00Z' }))
    const html = dock([waiting(entries)])
    // 分组标题仍是真实总数；卡片只露出预算内条数，其余聚合成一行。
    expect(html).toContain('等待你（7）')
    expect(html.match(/ln-task-card/g)).toHaveLength(ATTENTION_BUDGET)
    expect(html).toContain('还有 2 项')
  })
  it('orders the surfaced cards by attention score: the longest waiting first', () => {
    const html = dock([waiting([
      { taskId: 'fresh', title: '刚交回的结论', createdAt: '2999-01-01T00:00:00Z' },
      { taskId: 'stale', title: '等了一天的结论', createdAt: '2020-01-01T00:00:00Z' }
    ])])
    expect(html.indexOf('等了一天的结论')).toBeGreaterThan(-1)
    expect(html.indexOf('等了一天的结论')).toBeLessThan(html.indexOf('刚交回的结论'))
  })
  it('keeps the tab badge on the budgeted count instead of the raw total', () => {
    const entries = Array.from({ length: 7 }, (_, index) =>
      ({ taskId: `wt-${index}`, title: `实际工作 ${index}`, createdAt: '2026-11-13T00:00:00Z' }))
    expect(dock([waiting(entries)])).toContain('<i>5</i>')
    expect(dock([waiting(entries.slice(0, 2))])).toContain('<i>2</i>')
  })
  it('reads waiting work as attention facts and never counts other groups', () => {
    const question: PiQuestion = {
      threadId: 'th', agentRunId: 'run-1', executionEpoch: 1, hostInstanceId: 'host-1', taskId: 't',
      status: 'waiting_for_user', request: { id: 'r1', method: 'select', title: '选一个', options: ['A'] }
    }
    const facts = attentionFactsFromWork(flattenWork([waiting([
      { taskId: 't', title: '实际工作', createdAt: '2026-11-12T00:00:00Z' }
    ])], [question]))
    // 提问优先于普通待验收；时间读链头候选的登记时间。
    expect(facts).toEqual([{ id: 't', kind: 'question', title: '实际工作', threadId: 'th', missionId: 'm', taskId: 't', createdAt: '2026-11-12T00:00:00Z' }])
    // 待开始的工作不是「等你」，不进注意力事实。
    expect(attentionFactsFromWork(flattenWork([bundle([first], { tasks: [task] })]))).toEqual([])
  })
})

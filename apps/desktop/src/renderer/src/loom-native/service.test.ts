import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile, LoomControlSnapshot, LoomStageReview, MissionRecord, NavigationSnapshot, ThreadOpenProjection } from '@contracts'
import type { ThreadClient } from '../camp-client'
import { emptyLocalThreadComposerDraft, loadLocalThreadComposerDraft, saveLocalThreadComposerDraft } from '../camp-composer-local-store'
import { bootstrapSelection, conversationItems, createThreadForAgent, latestStageReview, LOOM_BUNDLE_CONCURRENCY, prepareSendDraft, readThreadSnapshot, readWorkBundle, readWorkBundles, readWorkBundlesFast, sendThreadMessage, stageDraftAttachments, stageReviewFacts, threadMessageSendParams, workControl } from './service'
import type { WorkBundle } from './types'
import { ConsoleClient, type WebOperation } from '../../../../../web/src/client'
import { notifyUnconfirmedThreadSend } from '../camp-client'
import { readOutbox } from './pending-outbox-store'

it.each(['text', 'attachment', 'storage failure'])('observes an in-flight Web %s send without taking over pending-command recovery', async mode => {
  const threadId = 'web-in-flight'
  if (mode === 'attachment') saveLocalThreadComposerDraft({
    ...emptyLocalThreadComposerDraft(threadId), body: 'later', attachments: [{
      id: '11111111-1111-4111-8111-111111111111', sourcePath: '/controlled/file', displayName: 'file.txt',
      kind: 'file', fileCount: null, mediaType: 'text/plain', byteSize: 4, previewKind: 'none', availability: 'available'
    }]
  })
  let rejectSend: ((error: Error) => void) | undefined
  let recorded = false
  let reconciles = 0
  const dispatches: Array<Record<string, unknown>> = []
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
    if (String(url).endsWith('/login')) return Response.json({ protocolVersion: 5, token: 'a'.repeat(64), clientId: 'd'.repeat(64), editorProof: 'e'.repeat(64), ownerId: 'local_user' })
    const request = JSON.parse(String(options?.body))
    if (request.operation === 'commands.reconcile') {
      reconciles++
      return Response.json({ result: recorded ? { state: 'recorded', result: { commandResult: applied } } : { state: 'unknown' } })
    }
    expect(request.operation).toBe('thread.messages.send')
    dispatches.push(request.params)
    return new Promise<Response>((_, reject) => { rejectSend = reject })
  })
  const transport = new ConsoleClient('http://localhost:4317', fetcher)
  await transport.login('b'.repeat(64))
  const client = mockClient(vi.fn((method, params) => transport.request(method as WebOperation, params)))
  const enqueue = mode === 'storage failure' ? vi.fn(() => { throw new Error('quota') }) : undefined
  let settled = false
  const sending = sendThreadMessage(client, { threadId, text: 'later', files: [] }, enqueue).then(result => { settled = true; return result })
  await vi.waitFor(() => expect(rejectSend).toBeTypeOf('function'))
  expect(readOutbox(threadId)).toEqual([])
  rejectSend!(new TypeError('response lost'))
  await vi.waitFor(() => expect(reconciles).toBeGreaterThan(0))
  expect(transport.pendingCommandCount).toBe(1)
  expect(settled).toBe(false)
  if (mode === 'text') {
    expect(readOutbox(threadId)).toMatchObject([{ commandId: dispatches[0]!.commandId, params: dispatches[0], state: 'unconfirmed', text: 'later' }])
    notifyUnconfirmedThreadSend(dispatches[0])
    expect(readOutbox(threadId)).toHaveLength(1)
  } else expect(readOutbox(threadId)).toEqual([])
  if (enqueue) expect(enqueue).toHaveBeenCalledOnce()
  recorded = true
  await vi.waitFor(async () => { await transport.reconcilePending(); expect(transport.pendingCommandCount).toBe(0) })
  await expect(sending).resolves.toEqual({ threadMessageId: 'msg1' })
  if (mode === 'text') expect(readOutbox(threadId)).toMatchObject([{ state: 'accepted' }])
  expect(dispatches).toHaveLength(1)
  transport.clear()
})

it.each(['accepted', 'rejected'])('does not enqueue a Web send with an explicit %s result or retain its observer', async outcome => {
  const threadId = 'web-explicit'
  let params: Record<string, unknown> | undefined
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
    if (String(url).endsWith('/login')) return Response.json({ protocolVersion: 5, token: 'a'.repeat(64), clientId: 'd'.repeat(64), editorProof: 'e'.repeat(64), ownerId: 'local_user' })
    const request = JSON.parse(String(options?.body))
    if (request.operation === 'commands.reconcile') return Response.json({ result: { state: 'unknown' } })
    params = request.params
    return Response.json(outcome === 'accepted' ? { result: { commandResult: applied } } : { error: { code: 'INVALID_ARGUMENT', message: 'invalid' } })
  })
  const transport = new ConsoleClient('http://localhost:4317', fetcher)
  await transport.login('b'.repeat(64))
  const client = mockClient(vi.fn((method, input) => transport.request(method as WebOperation, input)))
  const sending = sendThreadMessage(client, { threadId, text: 'later', files: [] })
  if (outcome === 'accepted') await expect(sending).resolves.toEqual({ threadMessageId: 'msg1' })
  else await expect(sending).rejects.toThrow('invalid')
  notifyUnconfirmedThreadSend(params)
  expect(readOutbox(threadId)).toEqual([])
  expect(transport.pendingCommandCount).toBe(0)
  transport.clear()
})

it('queues a known offline failure as unsent and freezes its command identity',async()=>{
  const offline=Object.assign(new Error('offline'),{code:'transport.unavailable'})
  const request=vi.fn().mockRejectedValue(offline);const enqueue=vi.fn()
  await expect(sendThreadMessage(mockClient(request),{threadId:'offline-known',text:'later',files:[]},enqueue)).rejects.toBe(offline)
  expect(enqueue).toHaveBeenCalledTimes(1)
  expect(enqueue.mock.calls[0]?.[0]).toMatchObject({state:'pending',commandId:request.mock.calls[0]?.[1].commandId,params:request.mock.calls[0]?.[1]})
})
it('never persists existing draft attachments even when the current File list is empty',async()=>{
  const threadId='outbox-saved-attachment'
  const draft={...emptyLocalThreadComposerDraft(threadId),body:'file',attachments:[{id:'11111111-1111-4111-8111-111111111111',sourcePath:'/controlled/file',displayName:'file.txt',kind:'file',fileCount:null,mediaType:'text/plain',byteSize:4,previewKind:'none',availability:'available'}]}
  saveLocalThreadComposerDraft(draft as ReturnType<typeof emptyLocalThreadComposerDraft>)
  const enqueue=vi.fn();const request=vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
  await expect(sendThreadMessage(mockClient(request),{threadId,text:'file',files:[]},enqueue)).rejects.toThrow('附件不能')
  expect(enqueue).not.toHaveBeenCalled()
})
it('does not confuse an explicit request error with transport uncertainty',async()=>{
  const error=Object.assign(new Error('invalid'),{code:'INVALID_ARGUMENT'})
  const enqueue=vi.fn();const request=vi.fn().mockRejectedValue(error)
  await expect(sendThreadMessage(mockClient(request),{threadId:'outbox-invalid',text:'invalid',files:[]},enqueue)).rejects.toBe(error)
  expect(enqueue).not.toHaveBeenCalled()
})
let store: Map<string,string>
beforeEach(() => {
  store=new Map()
  vi.stubGlobal('window',{localStorage:{getItem:(key:string)=>store.get(key)??null,setItem:(key:string,value:string)=>store.set(key,value),removeItem:(key:string)=>store.delete(key)}})
})
afterEach(()=>vi.unstubAllGlobals())
const mission={missionId:'m',threadId:'mission-thread',title:'Existing group',description:'Actual mission',defaultLeadAgentId:'agent',hasUnread:false,runningAgentIds:[],updatedAt:'2026-11-13T00:00:00Z'} as unknown as MissionRecord
const navigation={schemaVersion:3,throughGlobalSequence:4,quickChat:{totalCount:0,recentThreads:[]},projects:[]} satisfies NavigationSnapshot
const agent={agentId:'agent',displayName:'Helper',presence:'present',removedAt:null,memberOrder:0,teamRole:'Build'} as AgentProfile
const applied={commandId:'x',commandType:'thread.messages.send',status:'applied',code:'ok',payload:{threadMessageId:'msg1'},resultEntity:null,recordedAt:'2026-11-13T00:00:00Z'}
function mockClient(request: ReturnType<typeof vi.fn>) {const recovery=new Map<string,unknown>();return {request,editingRecovery:{get:(k:string)=>recovery.get(k),set:(k:string,v:unknown)=>recovery.set(k,v)}} as unknown as ThreadClient}

describe('native data boundary and read-only startup',()=>{
  it('includes real mission threads even when ordinary navigation excludes them',()=>{
    const items=conversationItems([agent],navigation,[mission]);expect(items.find(x=>x.threadId==='mission-thread')).toMatchObject({title:'Existing group',missionId:'m'})
    expect(items.find(x=>x.id==='agent:agent')).toBeDefined();expect(bootstrapSelection(items,[mission])?.threadId).toBe('mission-thread')
  })
  it('orphan member selection is represented without a fabricated conversation',()=>{
    const items=conversationItems([agent],navigation,[]);expect(items).toHaveLength(1);expect(items[0].threadId).toBeNull()
  })
  it('uses the actual Web-approved open method instead of a desktop-only snapshot method',async()=>{
    const projection={schemaVersion:9,throughGlobalSequence:4,thread:{id:'t'},members:[],membershipReconciliations:[],tasksEnabled:false,messages:[],messageDeliveries:[],turns:[],agentRuns:[],executionEvidence:[],agentRunFileChanges:[],approvals:[]} as unknown as ThreadOpenProjection
    const request=vi.fn().mockResolvedValue(projection)
    expect((await readThreadSnapshot(mockClient(request),'t')).thread.id).toBe('t')
    expect(request).toHaveBeenCalledWith('threads.open',expect.objectContaining({threadId:'t'}))
  })
  it('rejects a snapshot for a different conversation',async()=>{
    const request=vi.fn().mockResolvedValue({schemaVersion:9,thread:{id:'other'}})
    await expect(readThreadSnapshot(mockClient(request),'t')).rejects.toThrow()
  })
  it('creates only a pending, one-member quick-chat when explicitly requested',async()=>{
    const request=vi.fn().mockResolvedValue({...applied,payload:{threadId:'new'}})
    await createThreadForAgent(mockClient(request),'agent')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('threads.create',expect.objectContaining({workspace:null,memberAgentIds:['agent'],defaultLeadAgentId:'agent',activationState:'pending'}))
  })
})

describe('native work bundle review facts',()=>{
  const stageReview={stageReviewId:'sr1',taskId:'task-1',candidateId:'cand-1',reviewerAgentId:'agent',
    reviewerAgentRunId:'run-1',policyRevision:2,manifestHash:'sha256:abc',verdict:'request_changes',
    reason:'criteria 2 missing',criteriaResults:[],reviewedAt:'2026-11-13T00:00:00Z'} as LoomStageReview
  const snapshot=(over:Partial<LoomControlSnapshot>={})=>({missionId:'m',policy:null,
    stageReviews:[stageReview],dispatches:[],evaluatedAt:'2026-11-13T00:00:00Z',...over}) as LoomControlSnapshot
  const candidate={candidateId:'cand-1',taskId:'task-1',agentRunId:'run-1',contentHash:'sha256:x',
    evidenceIds:[],acceptanceCriteria:{version:'v1',criteria:[]},previousCandidateId:null,
    verificationStatus:'unverified',acceptanceStatus:'pending',createdAt:'2026-11-13T00:00:00Z'}
  /** 一个按方法路由的 Fake Host：默认给空集合，控制投影按 `control` 决定。 */
  function host(options:{control?:unknown;controlError?:unknown;reviews?:unknown;many?:unknown}={}) {
    const request=vi.fn(async(method:string):Promise<unknown>=>{
      if(method==='loom.control.get'){
        if(options.controlError!==undefined) throw options.controlError
        return options.control??snapshot()
      }
      if(method==='loom.bundles.getMany') return options.many??{bundles:[]}
      if(method==='loom.plan.get') return null
      if(method==='loom.tasks.list') return [{taskId:'task-1',title:'T'}]
      if(method==='loom.candidates.list') return [candidate]
      if(method==='loom.reviews.list') return 'reviews' in options ? options.reviews : []
      if(method==='loom.artifacts.list') return {artifacts:[]}
      return []
    })
    return mockClient(request)
  }
  it('reads the actual control projection and its stage reviews',async()=>{
    const bundle=await readWorkBundle(host(),mission)
    expect(bundle.control?.status).toBe('observed')
    const facts=stageReviewFacts(bundle)
    expect(facts.status).toBe('observed')
    if(facts.status!=='observed') throw Error('unreachable')
    expect(facts.stageReviews).toHaveLength(1)
    expect(latestStageReview(facts.stageReviews,'cand-1')?.verdict).toBe('request_changes')
    expect(latestStageReview(facts.stageReviews,'cand-2')).toBeNull()
  })
  it('keeps a control projection for another Mission unknown instead of adopting it',async()=>{
    const bundle=await readWorkBundle(host({control:snapshot({missionId:'other'})}),mission)
    const control=workControl(bundle)
    expect(control).toMatchObject({status:'unknown',reason:'invalid'})
    if(control.status!=='unknown') throw Error('unreachable')
    expect(control.message).toContain('另一项工作')
    // 未知不回推结论：阶段审查不是空列表，也不会被读成「在等你」。
    expect(stageReviewFacts(bundle).status).toBe('unknown')
  })
  it('treats a snapshot without the stage-review receipt as unknown, not as no review',async()=>{
    const incomplete=snapshot() as unknown as Record<string,unknown>
    delete incomplete.stageReviews
    const bundle=await readWorkBundle(host({control:incomplete}),mission)
    const control=workControl(bundle)
    expect(control).toMatchObject({status:'unknown',reason:'invalid'})
    if(control.status!=='unknown') throw Error('unreachable')
    expect(control.message).toContain('stageReviews')
    expect(stageReviewFacts(bundle)).toMatchObject({status:'unknown',reason:'invalid'})
  })
  it('keeps the bundle with unknown facts when the control read itself fails',async()=>{
    const bundle=await readWorkBundle(host({controlError:new Error('offline')}),mission)
    const control=workControl(bundle)
    expect(control).toMatchObject({status:'unknown',reason:'read_failed'})
    if(control.status!=='unknown') throw Error('unreachable')
    expect(control.message).toBe('offline')
    expect(stageReviewFacts(bundle).status).toBe('unknown')
  })
  it('fails a missing review receipt instead of inventing a pending review',async()=>{
    await expect(readWorkBundle(host({reviews:null}),mission)).rejects.toThrow()
    const all=await readWorkBundles(host({reviews:null}),[mission])
    expect(all.bundles).toHaveLength(0)
    expect(all.errors).toHaveLength(1)
  })
  it('treats a bundle without a control read as not read, never as approved',()=>{
    const bare={mission,plan:null,tasks:[],candidates:[],artifacts:[],reviews:[],verifications:[]} as WorkBundle
    expect(workControl(bare)).toMatchObject({status:'unknown',reason:'not_read'})
    expect(stageReviewFacts(bare)).toMatchObject({status:'unknown',reason:'not_read'})
  })
  const row=(over:Record<string,unknown>={})=>({missionId:'m',plan:null,tasks:[{taskId:'task-1',title:'T'}],candidates:[candidate],
    reviews:[],verifications:[],artifacts:{artifacts:[]},...over})
  it('fills an absent batch control projection with the same facts the ordinary read returns',async()=>{
    const batched=await readWorkBundlesFast(host({many:{bundles:[row()]}}),[mission])
    const ordinary=await readWorkBundle(host(),mission)
    expect(batched.errors).toHaveLength(0)
    expect(batched.bundles).toHaveLength(1)
    expect(workControl(batched.bundles[0])).toEqual(workControl(ordinary))
    expect(stageReviewFacts(batched.bundles[0])).toEqual(stageReviewFacts(ordinary))
    expect(stageReviewFacts(batched.bundles[0])).toMatchObject({status:'observed'})
    const facts=stageReviewFacts(batched.bundles[0])
    if(facts.status!=='observed') throw Error('unreachable')
    expect(latestStageReview(facts.stageReviews,'cand-1')).toEqual(stageReview)
  })
  it('applies the same control classification to a batch row that carries it',async()=>{
    const many={bundles:[row({control:snapshot()})]}
    const batched=await readWorkBundlesFast(host({many}),[mission])
    expect(workControl(batched.bundles[0])).toEqual(workControl(await readWorkBundle(host(),mission)))
    const wrong={bundles:[row({control:snapshot({missionId:'other'})})]}
    const other=await readWorkBundlesFast(host({many:wrong}),[mission])
    expect(workControl(other.bundles[0])).toMatchObject({status:'unknown',reason:'invalid'})
    // 批次行自带错 Mission 投影时也不会再被逐 Mission 覆写成“读到了”。
    expect(other.bundles[0].control).toMatchObject({status:'unknown',reason:'invalid'})
  })
  it('reads batch control facts with bounded concurrency instead of an unbounded storm',async()=>{
    const missions=Array.from({length:9},(_,index)=>({...mission,
      missionId:`m${index}`,threadId:`t${index}`,title:`M${index}`}) as MissionRecord)
    let inFlight=0,peak=0
    const request=vi.fn(async(method:string,params?:{missionId?:string;missionIds?:string[]}):Promise<unknown>=>{
      // 严格按请求的 missionIds 回行：多回或漏回都会让批量投影形状校验失败、退化为六源回退，
      // 那样这条用例就测不到“批量行缺 control 时按 Mission 补读”的路径。
      if(method==='loom.bundles.getMany') return {bundles:(params?.missionIds??[]).map(id=>row({missionId:id}))}
      if(method==='loom.control.get'){
        inFlight+=1;peak=Math.max(peak,inFlight)
        await new Promise(resolve=>setTimeout(resolve,0))
        inFlight-=1
        return snapshot({missionId:String(params?.missionId??'m')})
      }
      // 批次成功时不该再发六源单读：发出来就说明走的是回退路径，不是被测路径。
      throw Error(`batch control read must not issue ${method}`)
    })
    const batched=await readWorkBundlesFast(mockClient(request),missions)
    const calls=(name:string)=>request.mock.calls.filter(([method])=>method===name)
    expect(batched.errors).toHaveLength(0)
    expect(batched.bundles).toHaveLength(9)
    // 9 个 Mission 被 8+1 分两批：既有批量请求，也有逐 Mission 的 control 补读，没有六源单读。
    expect(calls('loom.bundles.getMany').map(([,params])=>params?.missionIds)).toEqual([
      missions.slice(0,8).map(item=>item.missionId),[missions[8].missionId]])
    expect(calls('loom.control.get')).toHaveLength(9)
    expect(peak).toBe(LOOM_BUNDLE_CONCURRENCY)
    for(const bundle of batched.bundles) expect(workControl(bundle).status).toBe('observed')
  })
  it('keeps the bundle unknown when the batch and the control read both fail',async()=>{
    const client=host({many:Promise.reject(new Error('batch unavailable')),controlError:new Error('offline')})
    const recovered=await readWorkBundlesFast(client,[mission])
    expect(recovered.errors).toHaveLength(0)
    expect(recovered.bundles).toHaveLength(1)
    expect(recovered.bundles[0].tasks).toHaveLength(1)
    expect(workControl(recovered.bundles[0])).toMatchObject({status:'unknown',reason:'read_failed'})
    expect(stageReviewFacts(recovered.bundles[0]).status).toBe('unknown')
  })
  it('keeps the six sources when a control receipt is malformed instead of dropping the bundle',async()=>{
    const malformed=snapshot() as unknown as Record<string,unknown>
    delete malformed.policy
    const ordinary=await readWorkBundle(host({control:malformed}),mission)
    expect(ordinary.tasks).toHaveLength(1)
    expect(ordinary.candidates).toHaveLength(1)
    expect(workControl(ordinary)).toMatchObject({status:'unknown',reason:'invalid'})
    const batched=await readWorkBundlesFast(host({many:{bundles:[row({control:malformed})]}}),[mission])
    expect(batched.bundles).toHaveLength(1)
    expect(batched.bundles[0].tasks).toHaveLength(1)
    expect(workControl(batched.bundles[0])).toMatchObject({status:'unknown',reason:'invalid'})
  })
  it('selects the newest stage review across an unordered ledger and keeps ledger order on ties',()=>{
    const older={...stageReview,stageReviewId:'older',reviewedAt:'2026-11-12T00:00:00Z'}
    const newest={...stageReview,stageReviewId:'newest',reviewedAt:'2026-11-14T00:00:00Z'}
    const middle={...stageReview,stageReviewId:'middle',reviewedAt:'2026-11-13T00:00:00Z'}
    expect(latestStageReview([older,newest,middle],'cand-1')?.stageReviewId).toBe('newest')
    expect(latestStageReview([newest,older,middle],'cand-1')?.stageReviewId).toBe('newest')
    const first={...stageReview,stageReviewId:'first'}
    const last={...stageReview,stageReviewId:'last'}
    expect(latestStageReview([first,last],'cand-1')?.stageReviewId).toBe('last')
    expect(latestStageReview([last,first],'cand-1')?.stageReviewId).toBe('first')
    expect(latestStageReview([older,newest,{...newest,stageReviewId:'other-candidate',candidateId:'cand-2'}],'cand-1')?.stageReviewId)
      .toBe('newest')
    expect(latestStageReview([],'cand-1')).toBeNull()
  })
  it('recovers a failed batch through ordinary reads with the same facts',async()=>{
    const client=host({many:Promise.reject(new Error('batch unavailable'))})
    // `many` 是一个拒绝的 Promise：getMany 直接失败，必须走逐 Mission 的普通读取。
    const recovered=await readWorkBundlesFast(client,[mission])
    const ordinary=await readWorkBundle(host(),mission)
    expect(recovered.errors).toHaveLength(0)
    expect(recovered.bundles).toHaveLength(1)
    expect(recovered.bundles[0].tasks).toEqual(ordinary.tasks)
    expect(recovered.bundles[0].candidates).toEqual(ordinary.candidates)
    expect(recovered.bundles[0].reviews).toEqual(ordinary.reviews)
    expect(workControl(recovered.bundles[0])).toEqual(workControl(ordinary))
    expect(stageReviewFacts(recovered.bundles[0])).toEqual(stageReviewFacts(ordinary))
  })
})

describe('native sender preservation and replay',()=>{
  it('treats the visible edited body as confirmed while preserving the draft revision',()=>{
    const old={...emptyLocalThreadComposerDraft('t'),revision:7,body:'old',content:{version:2 as const,segments:[{kind:'text' as const,text:'old'}]}}
    saveLocalThreadComposerDraft(old)
    const prepared=prepareSendDraft('t','different')
    expect(prepared.revision).toBe(7)
    expect(prepared.body).toBe('different')
    expect(prepared.content.segments).toEqual([{kind:'text',text:'different'}])
  })
  it('keeps text after a rejected command and never declares success',async()=>{
    const request=vi.fn().mockResolvedValue({commandResult:{...applied,status:'rejected',code:'denied'}})
    await expect(sendThreadMessage(mockClient(request),{threadId:'t',text:'Keep me',files:[]})).rejects.toThrow()
    expect(loadLocalThreadComposerDraft('t')?.body).toBe('Keep me')
  })
  it('clears the actual draft only after an applied command receipt',async()=>{
    const request=vi.fn().mockResolvedValue({commandResult:applied})
    await sendThreadMessage(mockClient(request),{threadId:'t',text:'Send me',files:[]})
    expect(loadLocalThreadComposerDraft('t')).toBeNull()
  })
  it('replays the same command id after an ambiguous transport failure',async()=>{
    const request=vi.fn().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce({commandResult:applied})
    const client=mockClient(request)
    await expect(sendThreadMessage(client,{threadId:'t',text:'Once',files:[]})).rejects.toThrow('connection lost')
    await sendThreadMessage(client,{threadId:'t',text:'Once',files:[]})
    expect(request.mock.calls[0][1].commandId).toBe(request.mock.calls[1][1].commandId)
  })
  it('keeps draft on a null command result',async()=>{
    const request=vi.fn().mockResolvedValue({commandResult:null})
    await expect(sendThreadMessage(mockClient(request),{threadId:'t',text:'Unknown',files:[]})).rejects.toThrow()
    expect(loadLocalThreadComposerDraft('t')?.body).toBe('Unknown')
  })
  it('fails before sending if an attachment has no controlled source path',()=>{
    const draft={...emptyLocalThreadComposerDraft('t'),attachments:[{id:'a',sourcePath:null}]} as unknown as ReturnType<typeof emptyLocalThreadComposerDraft>
    expect(()=>threadMessageSendParams('cmd',draft)).toThrow('来源')
  })
  it('does not collapse distinct files merely because name and size match',async()=>{
    const first=new File(['abc'],'same.txt'),second=new File(['xyz'],'same.txt')
    const prepare=vi.fn().mockResolvedValueOnce({id:'one',sourcePath:'/one',displayName:'same.txt',byteSize:3}).mockResolvedValueOnce({id:'two',sourcePath:'/two',displayName:'same.txt',byteSize:3})
    const client={...mockClient(vi.fn()),composerAttachments:{prepare}} as unknown as ThreadClient
    const draft=await stageDraftAttachments(client,emptyLocalThreadComposerDraft('t'),[first,second])
    expect(prepare).toHaveBeenCalledTimes(2);expect(draft.attachments).toHaveLength(2)
    await stageDraftAttachments(client,draft,[first,second]);expect(prepare).toHaveBeenCalledTimes(2)
  })
})

describe('pending outbox transport boundary',()=>{
  it('enqueues transport uncertainty once with the frozen command and retains the draft',async()=>{
    const request=vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const client=mockClient(request);const enqueue=vi.fn()
    await expect(sendThreadMessage(client,{threadId:'outbox-transport',text:'keep me',files:[]},enqueue)).rejects.toThrow('Failed to fetch')
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({threadId:'outbox-transport',text:'keep me',state:'unconfirmed'})
  })
  it('never queues explicit Core rejection or local empty input',async()=>{
    const request=vi.fn().mockResolvedValue({commandResult:{...applied,status:'rejected'}})
    const client=mockClient(request);const enqueue=vi.fn()
    await expect(sendThreadMessage(client,{threadId:'outbox-reject',text:'rejected',files:[]},enqueue)).rejects.toThrow()
    await expect(sendThreadMessage(client,{threadId:'outbox-empty',text:'',files:[]},enqueue)).rejects.toThrow()
    expect(enqueue).not.toHaveBeenCalled()
  })
})

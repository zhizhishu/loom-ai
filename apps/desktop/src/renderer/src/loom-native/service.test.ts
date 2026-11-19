import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile, LoomControlSnapshot, LoomStageReview, MissionRecord, NavigationSnapshot, ThreadOpenProjection } from '@contracts'
import type { ThreadClient } from '../camp-client'
import { emptyLocalThreadComposerDraft, loadLocalThreadComposerDraft, saveLocalThreadComposerDraft } from '../camp-composer-local-store'
import { bootstrapSelection, conversationItems, createThreadForAgent, latestStageReview, prepareSendDraft, readThreadSnapshot, readWorkBundle, readWorkBundles, readWorkBundlesFast, sendThreadMessage, stageDraftAttachments, stageReviewFacts, threadMessageSendParams, workControl } from './service'
import type { WorkBundle } from './types'

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
  it('never turns an absent batch control projection into a conclusion',async()=>{
    const many={bundles:[{missionId:'m',plan:null,tasks:[],candidates:[],reviews:[],verifications:[],artifacts:{artifacts:[]}}]}
    const batched=await readWorkBundlesFast(host({many}),[mission])
    expect(batched.bundles).toHaveLength(1)
    expect(workControl(batched.bundles[0])).toMatchObject({status:'unknown',reason:'batch_projection'})
    expect(stageReviewFacts(batched.bundles[0]).status).toBe('unknown')
  })
  it('applies the same control classification to a batch row that carries it',async()=>{
    const many={bundles:[{missionId:'m',plan:null,tasks:[],candidates:[],reviews:[],verifications:[],artifacts:{artifacts:[]},control:snapshot()}]}
    const batched=await readWorkBundlesFast(host({many}),[mission])
    expect(workControl(batched.bundles[0]).status).toBe('observed')
    const wrong={bundles:[{missionId:'m',plan:null,tasks:[],candidates:[],reviews:[],verifications:[],artifacts:{artifacts:[]},control:snapshot({missionId:'other'})}]}
    const other=await readWorkBundlesFast(host({many:wrong}),[mission])
    expect(workControl(other.bundles[0])).toMatchObject({status:'unknown',reason:'invalid'})
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
    expect(recovered.bundles[0].control?.status).toBe('observed')
  })
})

describe('native sender preservation and replay',()=>{
  it('does not overwrite unseen existing user input',()=>{
    const old={...emptyLocalThreadComposerDraft('t'),body:'old',content:{version:2 as const,segments:[{kind:'text' as const,text:'old'}]}}
    saveLocalThreadComposerDraft(old)
    expect(()=>prepareSendDraft('t','different')).toThrow('草稿')
    expect(loadLocalThreadComposerDraft('t')?.body).toBe('old')
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

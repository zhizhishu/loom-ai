import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile, MissionRecord, NavigationSnapshot, ThreadOpenProjection } from '@contracts'
import type { ThreadClient } from '../camp-client'
import { emptyLocalThreadComposerDraft, loadLocalThreadComposerDraft, saveLocalThreadComposerDraft } from '../camp-composer-local-store'
import { bootstrapSelection, conversationItems, createThreadForAgent, prepareSendDraft, readThreadSnapshot, sendThreadMessage, stageDraftAttachments, threadMessageSendParams } from './service'

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

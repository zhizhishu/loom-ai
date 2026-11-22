import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile, MemberRuntimeConfiguration } from '@contracts'
import type { BusinessEnvironment } from '../business-environment'
import type { CapabilityCatalog, CapabilityItem } from '../member-catalog-model'
import { finishAssistantSetup, newSetupAttempt, setupProblems, setupSignature, type AssistantSetupDraft } from './assistant-onboarding'

const mocks=vi.hoisted(()=>({create:vi.fn(),read:vi.fn(),readCatalog:vi.fn(),saveCatalog:vi.fn(),createRoom:vi.fn()}))
vi.mock('./assistant-service',()=>({createAssistant:mocks.create,readAssistant:mocks.read}))
vi.mock('./capability-service',()=>({createCapabilityPort:()=>({read:mocks.readCatalog,save:mocks.saveCatalog})}))
vi.mock('./room-service',()=>({roomPort:()=>({}),emptyRoomDraft:()=>({name:null,memberAgentIds:[],leadAgentId:'',workspace:null,collaborationMode:'peer'}),createRoom:mocks.createRoom}))

const agent={agentId:'new-1',displayName:'Hanzi',version:3,presence:'present',removedAt:null} as AgentProfile
const runtime={adapterKind:'pi',model:{mode:'runtime_default'},permissions:{adapterKind:'pi',schemaVersion:1,values:{}}} as MemberRuntimeConfiguration
function draft():AssistantSetupDraft{return {identity:{name:'Hanzi',role:'实现',purpose:'做成可验证的结果',style:[]},avatarRef:null,runtime:null,capabilityKeys:[],workspace:null,openConversation:false}}
function item(id:string,selected=false,source='能力库'):CapabilityItem{return {id,kind:'skill',name:id,note:'',source,scope:'cloud',selected,origin:'explicit',toolNames:[],risk:null}}
function catalog(items:CapabilityItem[]=[]):CapabilityCatalog{return {agentId:'new-1',displayName:'Hanzi',teamRole:'实现',runtime:'pi',revision:'revision-5',identity:{displayName:'Hanzi',teamRole:'实现',professionalResponsibilities:'做成可验证的结果',personalityTraits:[],workingPrinciples:'真实验证',growthTopic:''},items}}
function environment(){return {client:{request:vi.fn().mockResolvedValue({status:'applied',payload:{version:4}})}} as unknown as BusinessEnvironment}

beforeEach(()=>{
 vi.clearAllMocks()
 mocks.create.mockResolvedValue(agent);mocks.read.mockResolvedValue(agent);mocks.readCatalog.mockResolvedValue(catalog());mocks.saveCatalog.mockResolvedValue(catalog());mocks.createRoom.mockResolvedValue({threadId:'room-1',registrationWarning:null})
})
describe('assistant setup is one resumable user operation',()=>{
 it('normalizes selection ordering for replay but preserves content changes',()=>{
  const a=draft();a.capabilityKeys=['skill:b','skill:a'];const b={...a,capabilityKeys:['skill:a','skill:b']}
  expect(setupSignature(a)).toBe(setupSignature(b));expect(setupSignature({...a,identity:{...a.identity,name:'Yezi'}})).not.toBe(setupSignature(a))
 })
 it('validates before any Core write',async()=>{
  const value=draft();value.identity.name=' '
  expect(setupProblems(value)).toContain('给助手起一个名字。')
  await expect(finishAssistantSetup(environment(),value,newSetupAttempt(value))).rejects.toThrow('名字')
  expect(mocks.create).not.toHaveBeenCalled()
 })
 it('never grants a Hook before there is a concrete runtime scope',()=>{
  const value=draft();value.capabilityKeys=['hook:cleanup']
  expect(setupProblems(value)).toContain('选择运行端之后才能确认 Hook 的执行范围。')
 })
 it('creates an identity without starting a model or opening a room',async()=>{
  const value=draft(),env=environment(),attempt=newSetupAttempt(value)
  const result=await finishAssistantSetup(env,value,attempt)
  expect(result).toEqual({status:'complete',agent,threadId:null,warning:null})
  expect(mocks.create).toHaveBeenCalledTimes(1);expect(mocks.createRoom).not.toHaveBeenCalled();expect(env.client.request).not.toHaveBeenCalled()
 })
 it('reuses the exact runtime command and expected version after an unknown response',async()=>{
  const value={...draft(),runtime},env=environment(),attempt=newSetupAttempt(value)
  vi.mocked(env.client.request).mockRejectedValueOnce(new Error('connection dropped')).mockResolvedValueOnce({status:'applied',payload:{version:4}})
  await expect(finishAssistantSetup(env,value,attempt)).rejects.toThrow('connection dropped')
  const first=vi.mocked(env.client.request).mock.calls[0]
  mocks.read.mockResolvedValue({...agent,version:4})
  await finishAssistantSetup(env,value,attempt)
  expect(mocks.create).toHaveBeenCalledTimes(1)
  expect(vi.mocked(env.client.request).mock.calls[1]).toEqual(first)
  expect(first[0]).toBe('members.runtime.set')
 })
 it('carries the Pi persona in the one Runtime document and refuses an empty Append',async()=>{
  const piRuntime={...runtime,piPurge:{mode:'append' as const,persona:'Be concise and cite evidence.'}}
  const value={...draft(),runtime:piRuntime}
  expect(setupProblems(value)).toEqual([])
  const env=environment()
  await finishAssistantSetup(env,value,newSetupAttempt(value))
  const call=vi.mocked(env.client.request).mock.calls[0] as unknown as [string,{command:Record<string,unknown>}]
  expect(call[0]).toBe('members.runtime.set')
  expect(call[1].command.piPurge).toEqual({mode:'append',persona:'Be concise and cite evidence.'})
  expect(call[1].command.permissions).toEqual(piRuntime.permissions)
  const empty={...draft(),runtime:{...runtime,piPurge:{mode:'append' as const,persona:'  '}}}
  expect(setupProblems(empty)).toContain('追加人格（Append）需要填写助手设定。')
  await expect(finishAssistantSetup(environment(),empty,newSetupAttempt(empty))).rejects.toThrow('Append')
 })
 it('does not accept edits to a definition whose command may already be running',async()=>{
  const value=draft(),attempt=newSetupAttempt(value)
  await expect(finishAssistantSetup(environment(),{...value,identity:{...value.identity,name:'Other'}},attempt)).rejects.toThrow('原配置')
  expect(mocks.create).not.toHaveBeenCalled()
 })
 it('preserves hidden internal tooling and changes only user capability selections',async()=>{
  const hidden=item('platform',true,'工具箱'),selected=item('design',false)
  mocks.readCatalog.mockResolvedValue(catalog([hidden,selected]))
  const value=draft();value.capabilityKeys=['skill:design']
  await finishAssistantSetup(environment(),value,newSetupAttempt(value))
  const saved=mocks.saveCatalog.mock.calls[0][1] as CapabilityItem[]
  expect(saved.find(row=>row.id==='platform')?.selected).toBe(true)
  expect(saved.find(row=>row.id==='design')?.selected).toBe(true)
 })
 it('stops at review rather than automatically approving a high-risk capability',async()=>{
  const risky={...item('write-system'),risk:'high' as const}
  mocks.readCatalog.mockResolvedValue(catalog([risky]))
  const value=draft();value.capabilityKeys=['skill:write-system'];const attempt=newSetupAttempt(value),env=environment()
  const result=await finishAssistantSetup(env,value,attempt)
  expect(result.status).toBe('review');expect(mocks.saveCatalog).not.toHaveBeenCalled()
  if(result.status!=='review')throw new Error('expected review')
  expect(result.review.agentId).toBe(agent.agentId)
  await finishAssistantSetup(env,value,attempt,result.review)
  expect(mocks.create).toHaveBeenCalledTimes(1)
  expect(mocks.saveCatalog).toHaveBeenCalledTimes(1)
  expect(mocks.saveCatalog.mock.calls[0][2]).toBe(result.review)
 })
 it('keeps a created identity when a resource disappears instead of duplicating it',async()=>{
  const value=draft();value.capabilityKeys=['skill:missing'];const attempt=newSetupAttempt(value)
  await expect(finishAssistantSetup(environment(),value,attempt)).rejects.toThrow('不可用')
  expect(attempt.agentId).toBe(agent.agentId);expect(mocks.saveCatalog).not.toHaveBeenCalled()
 })
 it('replays the same room id after a lost response and never sends a message',async()=>{
  const value={...draft(),openConversation:true,workspace:{name:'test',projectPath:'/owned/work'}},attempt=newSetupAttempt(value),env=environment()
  mocks.createRoom.mockRejectedValueOnce(new Error('unknown room result')).mockResolvedValueOnce({threadId:'room-1',registrationWarning:null})
  await expect(finishAssistantSetup(env,value,attempt)).rejects.toThrow('unknown room result')
  const first=mocks.createRoom.mock.calls[0]
  const result=await finishAssistantSetup(env,value,attempt)
  expect(mocks.createRoom.mock.calls[1][3]).toBe(first[3]);expect(mocks.create).toHaveBeenCalledTimes(1)
  expect(result.status).toBe('complete');expect(env.client.request).not.toHaveBeenCalled()
  expect(first[1].workspace).toEqual(value.workspace)
 })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BusinessEnvironment } from '../business-environment'
import type { NativeCapability } from './host-services'
import { inspectNativeImport, commitNativeImport, type NativeImportReview } from './native-import-service'
const mock=vi.hoisted(()=>({inspect:vi.fn(),commit:vi.fn(),register:vi.fn(),putRule:vi.fn(),putHook:vi.fn(),readMcp:vi.fn()}))
vi.mock('./capability-service',()=>({createCapabilityPort:()=>({inspectSkill:mock.inspect,commitSkill:mock.commit,registerSkill:mock.register,putRule:mock.putRule,putHook:mock.putHook})}))
vi.mock('./mcp-service',()=>({readMcpConnections:mock.readMcp}))
const source:NativeCapability={sourceId:'native-1',kind:'skill',name:'Design',runtime:'pi',sourceScope:'user',sourcePath:'C:\\owned\\skills\\design\\SKILL.md',digest:'sha256:abc',importable:true}
function env(){return {client:{request:vi.fn()},workbench:{preview:vi.fn(),importMcp:vi.fn()}} as unknown as BusinessEnvironment}
beforeEach(()=>{vi.clearAllMocks();mock.inspect.mockResolvedValue({candidates:[{name:'Design',contentDigest:'sha256:abc',importAction:'add',existingSkillVersion:null}],rejectedCandidates:[]});mock.commit.mockResolvedValue({status:'applied',skillId:'skill-1'});mock.register.mockResolvedValue({kind:'skill',id:'skill-1'});mock.readMcp.mockResolvedValue({status:'ready',configDigest:'config-v1'});mock.putRule.mockResolvedValue({id:'rule-1'});mock.putHook.mockResolvedValue({id:'hook-1'})})
describe('explicit native capability import',()=>{
 it('strips only the SKILL.md file suffix when inspecting a native Skill',async()=>{
  await inspectNativeImport(env(),source)
  expect(mock.inspect).toHaveBeenCalledWith('C:\\owned\\skills\\design')
  expect(mock.commit).not.toHaveBeenCalled()
 })
 it('requires a native Host port instead of pretending an empty directory was found',async()=>{
  await expect(inspectNativeImport({client:{}} as BusinessEnvironment,source)).rejects.toThrow('未提供')
 })
 it('retries registration without reimporting a skill after the first write succeeded',async()=>{
  const environment=env(),review=await inspectNativeImport(environment,source)
  mock.register.mockRejectedValueOnce(new Error('register unavailable')).mockResolvedValueOnce({kind:'skill',id:'skill-1'})
  await expect(commitNativeImport(environment,review,'Design')).rejects.toThrow('register unavailable')
  expect(review.committedSkillId).toBe('skill-1')
  expect(await commitNativeImport(environment,review,'Design')).toMatchObject({selectionKey:'skill:skill-1'})
  expect(mock.commit).toHaveBeenCalledTimes(1)
  expect(mock.register).toHaveBeenCalledTimes(2)
 })
 it('does not import a candidate that was not in the reviewed inspection',async()=>{
  const environment=env(),review=await inspectNativeImport(environment,source)
  await expect(commitNativeImport(environment,review,'Other')).rejects.toThrow('不属于')
  expect(mock.commit).not.toHaveBeenCalled()
 })
 it('imports MCP with exact source/config versions and leaves it disabled and unassigned',async()=>{
  const environment=env(),item={...source,kind:'mcp' as const}
  vi.mocked(environment.workbench!.importMcp).mockResolvedValue({status:'ok',serverId:'mcp-1',enabled:false,assignedAgentIds:[]})
  const review=await inspectNativeImport(environment,item,'thread-1')
  const result=await commitNativeImport(environment,review,undefined,'thread-1')
  expect(environment.workbench!.importMcp).toHaveBeenCalledWith('native-1','sha256:abc','config-v1','thread-1')
  expect(result.selectionKey).toBeNull()
  expect(environment.client.request).not.toHaveBeenCalled()
 })
 it('refuses a misleading MCP result that enabled or assigned the imported connection',async()=>{
  const environment=env();vi.mocked(environment.workbench!.importMcp).mockResolvedValue({status:'ok',serverId:'mcp-1',enabled:true,assignedAgentIds:['agent-1']})
  const review=await inspectNativeImport(environment,{...source,kind:'mcp'})
  await expect(commitNativeImport(environment,review)).rejects.toThrow('未确认')
 })
 it('refuses truncated rule or Hook previews',async()=>{
  const environment=env();vi.mocked(environment.workbench!.preview).mockResolvedValue({protocolVersion:1,sourceId:'native-1',digest:'sha256:abc',kind:'hook',available:true,truncated:true,content:{format:'json',text:'{"hooks":'}})
  await expect(inspectNativeImport(environment,{...source,kind:'hook'})).rejects.toThrow('完整正文')
  expect(mock.putHook).not.toHaveBeenCalled()
 })
 it('registers a rule but does not grant it or execute any command',async()=>{
  const environment=env();const review:NativeImportReview={candidate:{...source,kind:'rule'},commandId:'stable-1',preview:{protocolVersion:1,sourceId:'native-1',digest:'sha256:abc',kind:'rule',available:true,truncated:false,content:{format:'markdown',text:'Use pnpm.'}}}
  expect(await commitNativeImport(environment,review)).toMatchObject({selectionKey:'rule:rule-1'})
  expect(mock.putRule).toHaveBeenCalledWith(expect.objectContaining({id:'native-stable-1',body:'Use pnpm.'}))
  expect(environment.client.request).not.toHaveBeenCalled()
 })
})

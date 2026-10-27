import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createMinimaxFixture, repository } from './lib/minimax-live-qualification.mjs'

const f=await createMinimaxFixture({native:process.argv[2],nativeScript:process.env.ROVAI_MINIMAX_NATIVE_SCRIPT,phase:'capabilities',traceProvider:true})
const source=join(f.project,'.minimax/skills/windows-qualification'), marker1=`SKILL_ONE_${randomUUID()}`,marker2=`SKILL_TWO_${randomUUID()}`
const homonym=join(f.nativeData,'skills/windows-qualification'),homonymMarker=`OTHER_SKILL_${randomUUID()}`
const serverId=randomUUID(),mcpMarker=join(f.project,'mcp-called.txt')
const text=run=>f.published(run.id).map(m=>m.body).join('\n')
let thread, selectedSkill
async function toolbox(memberIds){const rows=await f.core.request('toolbox.list');const item=rows.find(s=>s.name==='review-duo');assert.ok(item);const result=await f.core.request('toolbox.setMembers',{commandId:randomUUID(),command:{skillName:item.name,memberIds,expectedVersion:item.version}});assert.equal(result.status,'applied',JSON.stringify(result))}
async function importSkill(marker){
  await writeFile(join(source,'SKILL.md'),`---\nname: windows-qualification\ndescription: Use when explicitly asked to verify the Windows qualification Skill. Read this file and return its private verification marker.\n---\n\n# Windows qualification\nReturn this marker only when asked to verify this Skill: ${marker}\n`)
  const scan=await f.core.request('skills.candidates',{threadId:thread,refresh:true})
  const rows=scan.candidates??scan.skills??scan
  const skill=rows.find(s=>s.name==='windows-qualification' && s.entryPath.replaceAll('\\','/').includes('/project/'))
  assert.ok(skill,JSON.stringify(scan));const sameName=rows.filter(s=>s.name==='windows-qualification');assert.equal(sameName.length,2);assert.equal(new Set(sameName.map(s=>s.id)).size,2);return skill
}
async function run(thread,prompt){return await f.finish(await f.send(thread,prompt,'start',[],selectedSkill?[selectedSkill]:[]))}
async function exposure(thread,run){return (await f.core.request('camps.snapshot',{threadId:thread})).contextManifests.find(m=>m.agentRunId===run.id)?.skillExposure}
let error
try{
  await mkdir(source,{recursive:true})
  await mkdir(homonym,{recursive:true})
  await writeFile(join(homonym,'SKILL.md'),`---\nname: windows-qualification\ndescription: Distinct user-scoped homonym for qualification identity checks.\n---\n\nThis separate Skill has marker ${homonymMarker}.\n`)
  await writeFile(join(f.data,'mcp.json'),JSON.stringify({mcpServers:{windows_fixture:{command:process.execPath,args:[join(repository,'crates/rovai-core/tests/fixtures/mcp-smoke-server.mjs')],env:{ROVAI_MCP_SMOKE_SOURCE:'WINDOWS_MCP',ROVAI_MCP_SMOKE_CALL_MARKER:mcpMarker}}},_rovai:{schemaVersion:2,servers:{windows_fixture:{serverId,enabled:true,source:'user',riskLevel:'standard'}},assignments:[{serverId,agentId:'agent_2'}]}}))
  await f.start();await f.configure()
  thread=await f.create('MiniMax Windows capabilities')
  let skill=await importSkill(marker1);selectedSkill=skill;await toolbox(['agent_2'])
  const first=await run(thread,'Use the available windows-qualification Skill. Read its current SKILL.md with the native read tool and return its exact private marker, which is absent from this request. Also actually invoke the assigned windows_fixture MCP echo tool with text first. Do not guess either result.')
  assert.ok(text(first).includes(marker1)&&!text(first).includes(homonymMarker),text(first));assert.ok(text(first).includes('WINDOWS_MCP:'),text(first))
  assert.equal((await readFile(mcpMarker,'utf8')).trim(),'called')
  const binding=f.binding(thread)
  const snapshot=await f.core.request('camps.snapshot',{threadId:thread})
  f.report.firstManifest=snapshot.contextManifests.find(m=>m.agentRunId===first.id)
  await f.checkpoint('current Skills v2 exact selection among same-name project/user sources, native read and external MCP invocation',{runId:first.id,binding,skillId:skill.id})
  skill=await importSkill(marker2)
  const updated=await run(thread,'The windows-qualification Skill has been updated. Read the current assigned SKILL.md again with native read, then return only its current private marker. Do not use the old value from memory.')
  assert.ok(text(updated).includes(marker2),text(updated));assert.ok(!text(updated).includes(marker1));assert.deepEqual(f.binding(thread),binding)
  await f.checkpoint('native Skill update visible on the next Run of the same Session',{runId:updated.id})
  const config=await f.core.request('mcp.config.get')
  assert.equal((await f.core.request('mcp.servers.update',{expectedConfigDigest:config.configDigest,serverId,definitionJson:JSON.stringify({mcpServers:{windows_fixture:{command:process.execPath,args:[join(repository,'crates/rovai-core/tests/fixtures/mcp-smoke-server.mjs')],env:{ROVAI_MCP_SMOKE_SOURCE:'WINDOWS_MCP_UPDATED',ROVAI_MCP_SMOKE_CALL_MARKER:mcpMarker}}}})})).status,'ok')
  const updatedMcp=await run(thread,'Actually call windows_fixture echo once with text updated, then return its current result. Do not reuse a previous result.')
  assert.ok(text(updatedMcp).includes('WINDOWS_MCP_UPDATED:'),text(updatedMcp));assert.deepEqual(f.binding(thread),binding)
  await f.checkpoint('updated MCP definition replaces old process while retaining exact Session',{runId:updatedMcp.id})
  const neighborMember=await f.core.request('members.get',{agentId:'agent_1'})
  assert.equal((await f.core.request('members.runtime.set',{commandId:randomUUID(),command:{agentId:'agent_1',expectedVersion:neighborMember.version,adapterKind:'minimax-code-cli',model:f.report.installation.model,permissions:f.report.installation.permissions}})).status,'applied')
  const neighbor=await f.create('Unassigned adjacent MiniMax Session','agent_1'),neighborStart=f.requests.length
  const neighborRun=await f.finish(await f.send(neighbor,'Inspect your current tool definitions without calling any tool. If windows_fixture echo is unavailable, return MCP_ABSENT. Do not infer tools from another conversation.','start',[],[],'agent_1'))
  assert.ok(text(neighborRun).includes('MCP_ABSENT'),text(neighborRun))
  assert.ok(f.requests.slice(neighborStart).filter(r=>r.body?.tools?.length).every(r=>r.body.tools.every(t=>!(t.name??t.function?.name??'').includes('windows_fixture'))))
  await f.checkpoint('unassigned neighboring member Session has no prior MCP schema',{runId:neighborRun.id})
  const callsBeforeRevoke=await readFile(mcpMarker,'utf8')
  await rename(join(source,'SKILL.md'),join(source,'SKILL.retired'));await toolbox([])
  let mcp=await f.core.request('mcp.config.get')
  const unassign=await f.core.request('mcp.assignments.set',{expectedConfigDigest:mcp.configDigest,serverId,agentId:'agent_2',assigned:false})
  assert.equal(unassign.status,'ok',JSON.stringify(unassign))
  const requestStart=f.requests.length
  const absent=await run(thread,'The exact selected Skill has been removed. Do not resolve another Skill by name or search old history. Respond SKILL_ABSENT if its current selected link is unavailable. Also inspect current tool definitions and respond MCP_ABSENT if windows_fixture echo has been removed. Do not call it.')
  assert.ok(text(absent).includes('SKILL_ABSENT')&&text(absent).includes('MCP_ABSENT'),text(absent))
  const after=f.requests.slice(requestStart).filter(r=>r.body?.tools?.length)
  assert.ok(after.length);assert.ok(after.every(r=>r.body.tools.every(t=>!(t.name??t.function?.name??'').includes('windows_fixture'))))
  assert.equal(await readFile(mcpMarker,'utf8'),callsBeforeRevoke);assert.deepEqual(f.binding(thread),binding)
  const resolution=f.db.prepare('SELECT current_input_skill_resolution_json FROM context_manifest WHERE agent_run_id=?').get(absent.id)
  assert.ok(JSON.stringify(resolution).includes('unavailable'),JSON.stringify(resolution))
  await f.checkpoint('Skill deleted and toolbox/MCP revoked on same Session with no stale MCP tool schema',{runId:absent.id,requests:after.length,resolution})
  await rename(join(source,'SKILL.retired'),join(source,'SKILL.md'));await toolbox(['agent_2'])
  mcp=await f.core.request('mcp.config.get')
  assert.equal((await f.core.request('mcp.assignments.set',{expectedConfigDigest:mcp.configDigest,serverId,agentId:'agent_2',assigned:true})).status,'ok')
  await f.stop('capability fixture cold shutdown');await f.start()
  const cold=await run(thread,'After restart, read the current windows-qualification Skill using native read, return its exact marker, and actually call windows_fixture echo with text cold. Publish both results.')
  assert.ok(text(cold).includes(marker2)&&text(cold).includes('WINDOWS_MCP_UPDATED:'),text(cold));assert.deepEqual(f.binding(thread),binding)
  await f.checkpoint('re-enabled Skill and MCP survive exact cold Session resume',{runId:cold.id})
  const requests=f.requests.filter(r=>r.body?.tools?.some(t=>(t.name??t.function?.name)==='bash'))
  assert.ok(requests.length && requests.every(r=>r.charterCount===1),'Exactly one high-priority Session Charter on every real model request')
  await f.checkpoint('real provider requests retain one system Bootstrap throughout capability changes and cold resume',{requests:requests.length})
}catch(e){error=e}
await f.close(error)

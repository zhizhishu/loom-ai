import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMinimaxFixture, repository, delay } from './lib/minimax-live-qualification.mjs'
import { processTable, waitForProcessIdentitiesToExit } from './lib/qualification-core.mjs'

const f=await createMinimaxFixture({native:process.argv[2],nativeScript:process.env.ROVAI_MINIMAX_NATIVE_SCRIPT,phase:'context-capabilities',traceProvider:true,contextLimit:65536})
const serverId=randomUUID(),marker=`SKILL_${randomUUID()}`,ready=join(f.project,'mcp-hold.ready'),late=join(f.project,'mcp-late.txt')
const text=run=>f.published(run.id).map(m=>m.body).join('\n')
const exists=path=>access(path).then(()=>true,()=>false)
let error
try{
  const source=join(f.project,'.minimax/skills/continuity-fixture');await mkdir(source,{recursive:true})
  await writeFile(join(source,'SKILL.md'),`---\nname: continuity-fixture\ndescription: Read the exact synthetic context qualification marker when asked.\n---\nMarker: ${marker}\n`)
  const fixture=await readFile(join(repository,'crates/rovai-core/tests/fixtures/mcp-smoke-server.mjs'),'utf8')
  const slow=fixture.replace("if (message.method === 'tools/call') {",`if (message.method === 'tools/call') {\n    if(message.params?.arguments?.text==='hold'){writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>{writeFileSync(${JSON.stringify(late)},'LATE_EFFECT');reply(message.id,{content:[{type:'text',text:'LATE_EFFECT'}]})},20000);return}`)
  const server=join(f.project,'context-mcp.mjs');await writeFile(server,slow)
  await writeFile(join(f.data,'mcp.json'),JSON.stringify({mcpServers:{context_fixture:{command:process.execPath,args:[server],env:{ROVAI_MCP_SMOKE_SOURCE:'CONTEXT_MCP'}}},_rovai:{schemaVersion:2,servers:{context_fixture:{serverId,enabled:true,source:'user',riskLevel:'standard'}},assignments:[{serverId,agentId:'agent_2'}]}}))
  await f.start();await f.configure();const thread=await f.create('Compaction preserves capabilities')
  const candidates=await f.core.request('skills.candidates',{threadId:thread,refresh:true}),skill=candidates.skills.find(s=>s.name==='continuity-fixture');assert.ok(skill)
  const first=await f.finish(await f.send(thread,'Read the selected continuity-fixture Skill with native read and return its marker. Actually call context_fixture echo with text seed and report its result.','start',[],[skill]))
  assert.ok(text(first).includes(marker)&&text(first).includes('CONTEXT_MCP:'),text(first))
  assert.ok(!JSON.stringify(f.events).includes('UNC paths are not allowed'),'Skill paths must work without model path repair')
  const binding=f.binding(thread),start=f.requests.length
  const summarized=()=>f.requests.slice(start).some(r=>JSON.stringify(r.body?.input??[]).includes('Checkpoint control: summarize'))
  for(let i=0;i<8&&!summarized();i++)await f.finish(await f.send(thread,`Reply ACK without tools. Discard the following inert padding from any summary.\n<padding>${randomBytes(12000).toString('hex')}</padding>`))
  assert.ok(summarized(),'A native threshold summary must occur')
  const member=await f.core.request('members.get',{agentId:'agent_2'})
  assert.equal((await f.core.request('members.runtime.set',{commandId:randomUUID(),command:{agentId:'agent_2',expectedVersion:member.version,adapterKind:'minimax-code-cli',model:member.runtimeConfiguration.model,permissions:{...member.runtimeConfiguration.permissions,values:{permission_mode:'default',mode:'default'}}}})).status,'applied')
  let approvals=0
  const after=await f.finish(await f.send(thread,'After compaction, read the selected continuity-fixture SKILL.md with native read and report its exact marker. Actually call context_fixture echo with text after. Then run a native PowerShell command that writes APPROVED to post-compact.txt; this synthetic write is authorized and I will approve its native permission request. Report the observed results.','start',[],[skill]),{onTick:async()=>{
    const snapshot=await f.core.request('camps.snapshot',{threadId:thread})
    for(const approval of snapshot.approvals.filter(a=>a.status==='pending')){
      const option=approval.options.find(o=>o.kind==='allow_once');assert.ok(option)
      assert.notEqual((await f.core.request('action.approvals.resolve',{commandId:randomUUID(),threadId:thread,approvalId:approval.id,expectedVersion:approval.version,optionId:option.optionId,reason:'Authorized synthetic post-compaction operation'})).status,'rejected');approvals++
    }
  }})
  assert.ok(text(after).includes(marker)&&text(after).includes('CONTEXT_MCP:'),text(after));assert.equal((await readFile(join(f.project,'post-compact.txt'),'utf8')).replace(/^\uFEFF/,'').trim(),'APPROVED');assert.ok(approvals>0);assert.deepEqual(f.binding(thread),binding)
  await f.checkpoint('Skills, MCP and native Approval remain effective after real threshold compaction',{runId:after.id,approvals})
  const current=await f.core.request('members.get',{agentId:'agent_2'})
  assert.equal((await f.core.request('members.runtime.set',{commandId:randomUUID(),command:{agentId:'agent_2',expectedVersion:current.version,adapterKind:'minimax-code-cli',model:current.runtimeConfiguration.model,permissions:{...current.runtimeConfiguration.permissions,values:{permission_mode:'bypassPermissions',mode:'default'}}}})).status,'applied')
  await f.send(thread,'Actually invoke context_fixture echo with the exact text hold. Wait for its result. Do not call any other tool.')
  await f.wait(()=>exists(ready),'held MCP invocation')
  const pid=Number(await readFile(ready,'utf8')),owned=(await processTable()).filter(p=>p.pid===pid);assert.equal(owned.length,1)
  const active=f.runs(thread).at(-1)
  assert.notEqual((await f.core.request('agentRuns.cancel',{commandId:randomUUID(),command:{threadId:thread,agentRunId:active.id,expectedVersion:active.version}})).status,'rejected')
  await f.wait(()=>f.runs(thread).at(-1).status==='cancelled','MCP Run cancellation')
  assert.deepEqual(await waitForProcessIdentitiesToExit(owned,15000),[])
  await delay(21000);assert.equal(await exists(late),false)
  assert.equal(f.published(active.id).length,0)
  await f.checkpoint('cancelled MCP invocation reaps its exact server process and prevents delayed effects',{runId:active.id,graceObservationMs:21000})
}catch(e){error=e}
await f.close(error)

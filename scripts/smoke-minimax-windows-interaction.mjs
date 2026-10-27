import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMinimaxFixture, repository, shellQuote } from './lib/minimax-live-qualification.mjs'

const f=await createMinimaxFixture({native:process.argv[2],nativeScript:process.env.ROVAI_MINIMAX_NATIVE_SCRIPT,phase:'interaction',traceProvider:true})
const text=run=>f.published(run.id).map(m=>m.body).join('\n')
const exists=path=>access(path).then(()=>true,()=>false)
let error
try{
  await f.start();await f.configure()
  const chosen=f.report.catalog.models.find(m=>m.id.includes('custom_provider%3Awindows-qualification'))
  assert.ok(chosen)
  async function settings(permission_mode,mode){
    const member=await f.core.request('members.get',{agentId:'agent_2'})
    const result=await f.core.request('members.runtime.set',{commandId:randomUUID(),command:{agentId:'agent_2',expectedVersion:member.version,adapterKind:'minimax-code-cli',model:{mode:'explicit',modelId:chosen.id,options:{}},permissions:{adapterKind:'minimax-code-cli',schemaVersion:1,values:{permission_mode,mode}}}})
    assert.equal(result.status,'applied',JSON.stringify(result))
  }
  await settings('bypassPermissions','default')
  const thread=await f.create('MiniMax explicit model and image Steer')
  let binding
  if(process.argv.includes('--modes-only')){
    const selected=await f.finish(await f.send(thread,'Return MODEL_OK without tools.'))
    assert.ok(text(selected).includes('MODEL_OK'));binding=f.binding(thread)
    await f.checkpoint('explicit native catalog model accepted',{runId:selected.id,modelId:chosen.id})
  }else{
  await writeFile(join(f.project,'wait.mjs'),"import{writeFile,access}from'node:fs/promises';await writeFile('wait.ready',String(process.pid));while(true){try{await access('wait.release');break}catch{await new Promise(r=>setTimeout(r,100))}}console.log('RELEASED');\n")
  const sent=await f.send(thread,`Run the native bash tool once: node ${shellQuote(join(f.project,'wait.mjs'))}. This is a synthetic waiting fixture. Stay in this Run until it completes; I will supply a follow-up. Do not delegate.`)
  await f.wait(()=>exists(join(f.project,'wait.ready')),'native waiting tool')
  const active=f.runs(thread).at(-1);binding=f.binding(thread)
  const png=await readFile(join(repository,'apps/desktop/src/renderer/src/assets/characters/muwa/icon-192.png')),image=join(f.project,'attachment.png')
  await writeFile(image,png)
  await f.send(thread,'After the waiting command exits, use the native read tool on the attached image path. Describe the animal and what it is wearing or carrying. Base this on the image pixels. Do not delegate or use an external service.','steer',[{id:randomUUID(),sourcePath:image,displayName:'attachment.png',kind:'file',mediaType:'image/png',observedByteSize:png.length}])
  await f.wait(()=>f.db.prepare("SELECT COUNT(*) AS n FROM runtime_input_delivery WHERE agent_run_id=? AND input_kind='steer' AND status='accepted'").get(active.id).n===1,'native Steer acknowledgement')
  await writeFile(join(f.project,'wait.release'),'release')
  const steered=await f.finish(sent)
  assert.equal(steered.id,active.id);assert.equal(steered.execution_epoch,active.execution_epoch)
  assert.match(text(steered),/雪豹|snow leopard|leopard/i)
  assert.match(text(steered),/背包|backpack|披风|斗篷|cloak|cape|scarf/i)
  assert.ok(f.requests.some(r=>/"type":"(?:input_image|image_url)"/.test(JSON.stringify(r.body))))
  assert.ok(f.requests.filter(r=>r.body?.tools?.length).every(r=>r.body.model===process.env.ROVAI_MINIMAX_LIVE_MODEL))
  await f.checkpoint('explicit native catalog selection and real-model image Steer stay in original Run/epoch',{runId:steered.id,binding,modelId:chosen.id,answer:text(steered)})
  }
  await settings('auto','default')
  const auto=await f.finish(await f.send(thread,'Use native bash once to print AUTO_PERMISSION_OK, then return that output.'),{onTick:async()=>{
    const snapshot=await f.core.request('camps.snapshot',{threadId:thread})
    for(const approval of snapshot.approvals.filter(a=>a.status==='pending')){
      const option=approval.options.find(o=>o.kind==='allow_once');assert.ok(option)
      const result=await f.core.request('action.approvals.resolve',{commandId:randomUUID(),threadId:thread,approvalId:approval.id,expectedVersion:approval.version,optionId:option.optionId,reason:'Authorized synthetic print command'})
      assert.notEqual(result.status,'rejected')
    }
  }})
  assert.ok(text(auto).includes('AUTO_PERMISSION_OK'),text(auto));assert.deepEqual(f.binding(thread),binding)
  await f.checkpoint('native auto permission option executes a tool after Host compatibility change',{runId:auto.id})
  await settings('default','plan')
  const plan=await f.finish(await f.send(thread,'This is a planning-only check. Do not call tools or change any file. Reply PLAN_MODE_OK.'))
  assert.ok(text(plan).includes('PLAN_MODE_OK'),text(plan));assert.deepEqual(f.binding(thread),binding)
  await f.checkpoint('native plan Session mode and default process permission accepted on exact Session',{runId:plan.id})
}catch(e){error=e}
await writeFile(join(f.project,'wait.release'),'release')
await f.close(error)

// Windows target-host evidence using the official mcode package and a real BYOK
// model. Credentials come only from explicit environment variables and are
// removed from the isolated native profile when the fixture closes.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createMinimaxFixture, delay, shellQuote } from './lib/minimax-live-qualification.mjs'

const phase = process.argv.includes('--idle') ? 'idle' : 'fleet'
const f = await createMinimaxFixture({native:process.argv[2], nativeScript:process.env.ROVAI_MINIMAX_NATIVE_SCRIPT, phase})
const text = run => f.published(run.id).map(message=>message.body).join('\n')
const start = run => f.events.find(event=>event.params?.agentRunId===run.id && event.params?.hostInstanceId && event.params?.nativeThreadId)?.params
const actions = run => f.events.filter(event=>event.method==='runtime.action' && event.params?.agentRunId===run.id)
const exists = async path => {try{await access(path);return true}catch{return false}}
async function turn(thread, prompt) { return f.finish(await f.send(thread,prompt)) }
async function memory(thread, token, excluded) {
  const run = await turn(thread,'Return exactly the private marker from your earlier turn in this conversation. Do not call tools, read files or include other markers.')
  assert.ok(text(run).includes(token),text(run));if(excluded)assert.ok(!text(run).includes(excluded))
  assert.equal(actions(run).length,0,'Memory must come from the exact native Session, without filesystem or tool reconstruction')
  return run
}
let error
try {
  await f.start();await f.configure()
  if(phase==='idle') {
    const thread=await f.create('Windows MiniMax production LRU')
    const marker=`IDLE_${randomUUID()}`
    const first=await turn(thread,`Remember this private marker only in this conversation: ${marker}. Do not write it to a file. Reply READY without tools.`)
    const original=f.binding(thread), host=start(first), owned=await f.owned()
    assert.ok(host?.hostInstanceId);assert.ok(owned.length)
    const began=Date.now()
    await f.checkpoint('resident Host entered the production idle window',{binding:original,host:host.hostInstanceId,owned:owned.map(({pid,startedAt})=>({pid,startedAt}))})
    await f.wait(async()=> (await f.owned()).length===0,'production 30-minute idle eviction',32*60*1000)
    const elapsedMs=Date.now()-began
    assert.ok(elapsedMs>=29*60*1000,'Production Fleet TTL must not be shortened for this test')
    await f.checkpoint('production idle eviction reaped the Runtime process tree',{elapsedMs})
    const resumed=await memory(thread,marker)
    assert.deepEqual(f.binding(thread),original);assert.notEqual(start(resumed)?.hostInstanceId,host.hostInstanceId)
    await f.checkpoint('post-eviction exact Session resume',{runId:resumed.id,binding:original})
  } else {
    const threadA=await f.create('Windows MiniMax Fleet A'), threadB=await f.create('Windows MiniMax Fleet B')
    const a=`FLEET_A_${randomUUID()}`,b=`FLEET_B_${randomUUID()}`
    await writeFile(join(f.project,'hold.mjs'),"import{writeFile,access}from'node:fs/promises';const n=process.argv[2];await writeFile(n+'.ready',String(process.pid));while(true){try{await access(n+'.release');break}catch{await new Promise(r=>setTimeout(r,100))}}console.log('HELD_TOOL_DONE');\n")
    const hold=(name,token)=>`Remember private marker ${token} in this conversation only. Use the bash tool once to run node ${shellQuote(join(f.project,'hold.mjs'))} ${name}. This is an authorized synthetic waiting fixture; let it finish. After it finishes, reply READY. Do not write the marker to files or publish it.`
    const sentA=await f.send(threadA,hold('a',a));await f.wait(()=>exists(join(f.project,'a.ready')),'A native waiting tool')
    const sentB=await f.send(threadB,hold('b',b));await f.wait(()=>exists(join(f.project,'b.ready')),'B native waiting tool')
    assert.equal(f.runs(threadA).at(-1).status,'running');assert.equal(f.runs(threadB).at(-1).status,'running')
    await writeFile(join(f.project,'a.release'),'release');await writeFile(join(f.project,'b.release'),'release')
    const [firstA,firstB]=await Promise.all([f.finish(sentA),f.finish(sentB)])
    const bindingA=f.binding(threadA),bindingB=f.binding(threadB),hostA=start(firstA),hostB=start(firstB)
    assert.ok(hostA?.hostInstanceId && hostB?.hostInstanceId,JSON.stringify({hostA,hostB}))
    assert.notEqual(hostA.hostInstanceId,hostB.hostInstanceId);assert.notEqual(bindingA.native_session_id,bindingB.native_session_id)
    await f.checkpoint('concurrent real native tools use distinct Hosts and Sessions',{runA:firstA.id,runB:firstB.id,hostA:hostA.hostInstanceId,hostB:hostB.hostInstanceId,bindingA,bindingB})
    const backA=await memory(threadA,a,b);const backB=await memory(threadB,b,a)
    assert.deepEqual(f.binding(threadA),bindingA);assert.deepEqual(f.binding(threadB),bindingB)
    await f.checkpoint('A/B/A/B exact continuation without cross-session marker leakage',{runA:backA.id,runB:backB.id,hostA:start(backA)?.hostInstanceId,hostB:start(backB)?.hostInstanceId})
    await f.stop('Core crash reaps every owned Runtime',true);await f.start()
    const coldA=await memory(threadA,a,b);assert.deepEqual(f.binding(threadA),bindingA)
    assert.notEqual(start(coldA)?.hostInstanceId,hostA.hostInstanceId)
    await f.checkpoint('Core crash followed by cold exact Session resume',{runId:coldA.id,binding:bindingA})
    await writeFile(join(f.project,'calc.mjs'),'export const clamp=(x,min,max)=>Math.max(max,Math.min(min,x));\n')
    await writeFile(join(f.project,'calc.test.mjs'),"import{strict as a}from'node:assert';import{clamp}from'./calc.mjs';a.equal(clamp(-2,0,10),0);a.equal(clamp(5,0,10),5);a.equal(clamp(12,0,10),10);a.equal(clamp(3,3,3),3);console.log('REAL_TESTS_PASSED');\n")
    const testBefore=await readFile(join(f.project,'calc.test.mjs'),'utf8')
    const coding=await turn(threadA,'Read calc.mjs and calc.test.mjs with native read. Run node calc.test.mjs to observe the failing test. Fix only calc.mjs using native edit or write, rerun the tests, and report the result. Keep the tests unchanged. Use the bundled rovai send command to publish your verified result exactly once.')
    assert.equal(await readFile(join(f.project,'calc.test.mjs'),'utf8'),testBefore)
    const observed=JSON.stringify(actions(coding));assert.ok(observed.includes('REAL_TESTS_PASSED'))
    assert.equal(f.published(coding.id).length,1)
    await f.checkpoint('real-model read/edit, red-to-green native command and one bundled CLI publication',{runId:coding.id,toolEvents:actions(coding).length})
    await f.stop('normal Core shutdown reaps resident Runtime tree')
  }
} catch(e) { error=e }
await f.close(error)

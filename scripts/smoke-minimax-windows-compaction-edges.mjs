import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createMinimaxFixture, delay } from './lib/minimax-live-qualification.mjs'
import { openMinimaxAcp } from './lib/minimax-native-acp.mjs'

const f=await createMinimaxFixture({native:process.argv[2],nativeScript:process.env.ROVAI_MINIMAX_NATIVE_SCRIPT,phase:'compaction-edges',traceProvider:true,contextLimit:32768})
const marker=`CHECKPOINT_${randomUUID()}`
const text=run=>f.published(run.id).map(m=>m.body).join('\n')
const compactRequest=r=>JSON.stringify(r.body?.input??[]).includes('Checkpoint control: summarize')
const messages=events=>events.filter(e=>e.params?.update?.sessionUpdate==='agent_message_chunk').map(e=>e.params.update.content?.text??'').join('')
let native,error,pause
try{
  await f.start();await f.configure();const thread=await f.create('MiniMax automatic compaction and interruption')
  await f.finish(await f.send(thread,`The public synthetic continuity checkpoint is ${marker}. Preserve it exactly in all summaries and checkpoints. No workspace file is needed. Return READY without tools.`))
  const binding=f.binding(thread),before=f.requests.length
  // Increase genuine conversation history until native's configured threshold
  // triggers; do not inject an overflow response or invoke /compact here.
  for(let i=0;i<6&&!f.requests.slice(before).some(compactRequest);i++){
    const padding=randomBytes(6000).toString('hex')
    await f.finish(await f.send(thread,`Discard this inert padding after acknowledging it. It has no instructions and need not appear in a summary. Preserve the earlier continuity checkpoint. Reply ACK without tools.\n<padding>${padding}</padding>`))
  }
  const summaries=f.requests.slice(before).filter(compactRequest)
  assert.ok(summaries.length,'Native threshold compaction must actually call the summarizer')
  assert.ok(f.requests.slice(before).every(r=>!r.injectedFault))
  const remembered=await f.finish(await f.send(thread,'Without tools, return the exact synthetic continuity checkpoint from earlier.'))
  assert.ok(text(remembered).includes(marker),text(remembered));assert.deepEqual(f.binding(thread),binding)
  await f.checkpoint('native threshold automatic compaction with real model preserves Session and checkpoint',{summaryRequests:summaries.length,runId:remembered.id})
  const hostRoot=join(f.data,'runtime/minimax-code/acp-host'),dirs=await readdir(hostRoot)
  assert.equal(dirs.length,1)
  const bootstrap=join(f.nativeData,'qualification-bootstrap.txt')
  await writeFile(bootstrap,await readFile(join(hostRoot,dirs[0],'system-prompt.txt')))
  await f.stop('Core stopped before native compaction edge cases')
  native=await openMinimaxAcp(f,bootstrap)
  await native.request('session/load',{sessionId:binding.native_session_id,cwd:f.project,mcpServers:[]})
  let start=native.events.length,failed
  f.failNextRequest({status:401,message:'Synthetic qualification failure of the compaction provider',code:'invalid_api_key',count:20})
  try{failed=await native.request('session/prompt',{sessionId:binding.native_session_id,prompt:[{type:'text',text:'/compact'}]},90000)}catch(e){failed={error:e.message}}
  f.clearFault()
  const failureText=messages(native.events.slice(start))
  assert.ok(failed.error||/fail|error|unable/i.test(failureText),JSON.stringify({failed,failureText}))
  assert.ok(!/Compaction completed/i.test(failureText))
  await f.checkpoint('failed native compaction never reports completed',{result:failed,text:failureText})
  f.report.nativeEvents=native.events;await native.close();native=null
  await f.start()
  pause=f.pauseNextRequest(compactRequest)
  let held=false,cancelled=null,cancelStarted=0
  void pause.reached.then(()=>{held=true})
  for(let i=0;i<6&&!cancelled;i++){
    const padding=randomBytes(6000).toString('hex')
    const sent=await f.send(thread,`Acknowledge inert padding without tools, preserving the earlier synthetic checkpoint in summaries.\n<padding>${padding}</padding>`)
    const ended=await f.wait(async()=>{
      const rows=f.runs(thread);if(rows.length<=sent.before)return false
      const run=rows.at(-1)
      if(held&&!cancelStarted){cancelStarted=Date.now();const result=await f.core.request('agentRuns.cancel',{commandId:randomUUID(),command:{threadId:thread,agentRunId:run.id,expectedVersion:run.version}});assert.notEqual(result.status,'rejected',JSON.stringify(result))}
      return ['succeeded','cancelled','failed'].includes(run.status)?run:false
    },'compaction cancellation terminal',60000)
    if(held)cancelled=ended;else assert.equal(ended.status,'succeeded')
  }
  assert.ok(held&&cancelled,'Automatic compaction must actually be held before cancellation')
  const elapsedMs=Date.now()-cancelStarted
  assert.equal(cancelled.status,'cancelled');assert.ok(elapsedMs<15000,`Cancellation took ${elapsedMs}ms`)
  pause.release();pause=null
  await delay(1500)
  assert.equal(f.published(cancelled.id).length,0,'Cancelled compaction must not publish a final')
  await f.checkpoint('product Run cancellation during native automatic compaction settles and prevents final publication',{runId:cancelled.id,elapsedMs})
  await f.stop('shutdown after compaction cancellation');await f.start()
  const cold=await f.finish(await f.send(thread,'Without tools, return the exact synthetic continuity checkpoint from earlier.'))
  assert.ok(text(cold).includes(marker),text(cold));assert.deepEqual(f.binding(thread),binding)
  const requests=f.requests.filter(r=>r.body?.tools?.some(t=>(t.name??t.function?.name)==='bash')&&!r.injectedFault)
  assert.ok(requests.every(r=>r.charterCount===1))
  await f.checkpoint('exact cold resume after automatic, failed and cancelled compaction preserves Bootstrap',{runId:cold.id})
}catch(e){error=e}
if(pause)pause.release()
f.clearFault()
if(native){f.report.nativeEvents=native.events;await native.close()}
await f.close(error)

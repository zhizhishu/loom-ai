import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createMinimaxFixture, digest } from './lib/minimax-live-qualification.mjs'
import { openMinimaxAcp } from './lib/minimax-native-acp.mjs'

const f=await createMinimaxFixture({native:process.argv[2],nativeScript:process.env.ROVAI_MINIMAX_NATIVE_SCRIPT,phase:'compaction',traceProvider:true,contextLimit:32768})
const marker=`COMPACT_${randomUUID()}`
const text=run=>f.published(run.id).map(m=>m.body).join('\n')
let native,error
try{
  await f.start();await f.configure();const thread=await f.create('MiniMax Windows compaction continuity')
  const seed=await f.finish(await f.send(thread,`The synthetic continuity checkpoint is ${marker}. This is public test data, not a secret. Preserve its exact value in all conversation summaries and checkpoints. Do not create workspace files for it. Run a short native command that prints READY and report READY. Do not delegate.`))
  const binding=f.binding(thread)
  const hostRoot=join(f.data,'runtime/minimax-code/acp-host'),dirs=await readdir(hostRoot)
  assert.equal(dirs.length,1)
  const bootstrap=await readFile(join(hostRoot,dirs[0],'system-prompt.txt'),'utf8'),bootstrapFile=join(f.nativeData,'qualification-bootstrap.txt')
  await writeFile(bootstrapFile,bootstrap)
  await f.stop('Core stopped before native manual compaction')
  native=await openMinimaxAcp(f,bootstrapFile)
  await native.request('session/load',{sessionId:binding.native_session_id,cwd:f.project,mcpServers:[]})
  const baseline=native.events.length
  const compact=await native.request('session/prompt',{sessionId:binding.native_session_id,prompt:[{type:'text',text:'/compact'}]})
  const summary=native.events.slice(baseline).filter(e=>e.params?.update?.sessionUpdate==='agent_message_chunk').map(e=>e.params.update.content?.text??'').join('')
  assert.equal(compact.stopReason,'end_turn');assert.match(summary,/Compaction completed/i)
  await f.checkpoint('official native manual compaction completed on the exact product Session',{nativeSummary:summary,binding,bootstrapSha256:digest(bootstrap)})
  f.report.nativeEvents=native.events;await native.close();native=null
  await f.start()
  const resumed=await f.finish(await f.send(thread,'Without tools, return the synthetic continuity checkpoint you were asked to remember earlier in this conversation.'))
  assert.ok(text(resumed).includes(marker),text(resumed));assert.deepEqual(f.binding(thread),binding)
  const last=f.requests.filter(r=>r.body?.tools?.length).at(-1);assert.equal(last.charterCount,1)
  await f.checkpoint('manual compaction followed by cold exact resume preserves memory and system Bootstrap',{runId:resumed.id})
  // A real gateway rejection, injected once without changing the model or its
  // runtime, must take native overflow recovery rather than replaying side effects.
  const before=f.requests.length
  f.failNextRequest({status:400,message:'maximum context length exceeded: input tokens exceed the model context window',code:'context_length_exceeded'})
  const overflow=await f.finish(await f.send(thread,'Return the same synthetic continuity checkpoint again without tools. This is a continuity check.'))
  assert.ok(text(overflow).includes(marker),text(overflow));assert.deepEqual(f.binding(thread),binding)
  const attempts=f.requests.slice(before)
  assert.equal(attempts.filter(r=>r.injectedFault).length,1);assert.ok(attempts.length>=3,'Expected rejection, real summary request and recovered model request')
  assert.equal(attempts.filter(r=>r.body?.tools?.length).at(-1).charterCount,1)
  await f.checkpoint('native overflow compaction and automatic retry preserve exact Session and Bootstrap',{runId:overflow.id,requests:attempts.length})
}catch(e){error=e}
if(native){f.report.nativeEvents=native.events;await native.close()}
await f.close(error)

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMinimaxFixture } from './lib/minimax-live-qualification.mjs'

const f=await createMinimaxFixture({native:process.argv[2],nativeScript:process.env.ROVAI_MINIMAX_NATIVE_SCRIPT,phase:'native-refresh',traceProvider:true})
const text=run=>f.published(run.id).map(m=>m.body).join('\n')
const marker=`REFRESH_${randomUUID()}`
let error,original
try{
  await f.start();await f.configure();const thread=await f.create('Native provider refresh')
  await f.finish(await f.send(thread,`Remember public synthetic checkpoint ${marker} in conversation only. Reply READY without tools.`))
  const binding=f.binding(thread),config=join(f.nativeData,'config.yaml')
  original=await readFile(config,'utf8');assert.ok(original.includes(f.providerURL))
  const redirected=original.replaceAll(f.providerURL,process.env.ROVAI_MINIMAX_LIVE_BASE_URL)
  await writeFile(config,redirected)
  const before=f.requests.length
  const refreshed=await f.finish(await f.send(thread,'Without tools, return the exact public synthetic checkpoint from the preceding message.'))
  assert.ok(text(refreshed).includes(marker),text(refreshed));assert.deepEqual(f.binding(thread),binding)
  const stale=f.requests.slice(before).filter(r=>r.body?.tools?.some(t=>(t.name??t.function?.name)==='bash'))
  assert.equal(stale.length,0,'New Run must use updated native endpoint, not the old proxy')
  await f.checkpoint('external native endpoint change takes effect on next exact Session Run',{runId:refreshed.id})
  const key=process.env.ROVAI_MINIMAX_LIVE_API_KEY
  assert.ok(redirected.includes(key))
  await writeFile(config,redirected.replaceAll(key,'qualification-invalid-key'))
  const rejected=await f.finish(await f.send(thread,'Reply AUTH_CHECK without tools.'),{allowFailure:true})
  assert.equal(rejected.status,'failed');assert.equal(f.published(rejected.id).length,0)
  await f.checkpoint('external native key change rejects authentication instead of reusing old credential',{runId:rejected.id,errorCode:rejected.last_error_code})
  await writeFile(config,redirected)
  const recovered=await f.finish(await f.send(thread,'Without tools, return the exact original synthetic checkpoint.'))
  assert.ok(text(recovered).includes(marker),text(recovered));assert.deepEqual(f.binding(thread),binding)
  await f.checkpoint('restored native credential resumes exact original Session without replay',{runId:recovered.id})
}catch(e){error=e}
if(original)await writeFile(join(f.nativeData,'config.yaml'),original)
await f.close(error)

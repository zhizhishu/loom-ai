import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createMinimaxFixture, repository, digest } from './lib/minimax-live-qualification.mjs'

const f=await createMinimaxFixture({native:process.argv[2],nativeScript:process.env.ROVAI_MINIMAX_NATIVE_SCRIPT,phase:'packaged-app'})
const app=process.argv[3]
assert.ok(app && existsSync(app),'Pass the isolated copy of the packaged Windows App')
let error
try {
  // The helper Core only prepares the private Native profile. The App launches
  // its own bundled sidecar, whose fingerprint is the relevant execution proof.
  f.report.appCoreSha256=digest(await readFile(join(dirname(app),'resources/bin/rovai-core.exe')))
  f.report.appAsarSha256=digest(await readFile(join(dirname(app),'resources/app.asar')))
  const fixture=join(f.root,'shutdown'),output=join(f.root,'captures')
  // The production default asks before closing. Set only this fixture's explicit
  // exit preference before the acceptance script launches its prepared profile.
  const preferences=['user-data','feedback-user-data'].map(name=>join(fixture,name,'Electron/User Data/window-close.json'))
  const timer=setInterval(()=>{for(const path of preferences)if(existsSync(join(path,'..'))&&!existsSync(path))void writeFile(path,JSON.stringify({schemaVersion:1,behavior:'exit'}))},50)
  const child=spawn(process.execPath,[join(repository,'scripts/accept-planned-shutdown.mjs'),app],{cwd:repository,windowsHide:true,
    env:{...f.environment,ROVAI_PLANNED_SHUTDOWN_ACCEPT_FIXTURE_ROOT:fixture,ROVAI_PLANNED_SHUTDOWN_ACCEPT_OUTPUT_DIR:output,ROVAI_PLANNED_SHUTDOWN_RUNTIME_KIND:'minimax-code-cli',ROVAI_KEEP_PLANNED_SHUTDOWN_FIXTURE:'1',ROVAI_PLANNED_SHUTDOWN_ACCEPT_TRACE:'1',ROVAI_EXECUTION_TEXT_ACCEPT:'partial-only'},stdio:['ignore','pipe','pipe']})
  let stdout='',stderr=''
  child.stdout.on('data',x=>{stdout+=x});child.stderr.on('data',x=>{stderr+=x})
  const code=await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject)}).finally(()=>clearInterval(timer))
  const redact=value=>value.replaceAll(process.env.ROVAI_MINIMAX_LIVE_API_KEY,'[REDACTED]')
  await writeFile(join(f.root,'app-stdout.log'),redact(stdout));await writeFile(join(f.root,'app-stderr.log'),redact(stderr))
  assert.equal(code,0,redact(stderr.slice(-5000)))
  f.report.app=JSON.parse(await readFile(join(output,'planned-shutdown-acceptance.json'),'utf8'))
  await f.checkpoint('packaged App real MiniMax run, planned shutdown, draft preservation and cold recovery',{exitCode:code,app})
}catch(e){error=e}
await f.close(error)

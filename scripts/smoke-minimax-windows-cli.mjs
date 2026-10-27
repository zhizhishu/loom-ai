import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createMinimaxFixture, repository } from './lib/minimax-live-qualification.mjs'

const f=await createMinimaxFixture({native:process.argv[2],nativeScript:process.env.ROVAI_MINIMAX_NATIVE_SCRIPT,phase:'builtin-cli'})
let error
try {
  const child=spawn(process.execPath,[join(repository,'scripts/smoke-builtin-cli.mjs')],{cwd:repository,windowsHide:true,
    env:{...f.environment,ROVAI_BUILTIN_CLI_CORE_EXECUTABLE:f.coreExecutable,ROVAI_BUILTIN_CLI_EXECUTABLE:join(dirname(f.coreExecutable),'rovai.exe'),ROVAI_BUILTIN_CLI_ADAPTERS:'minimax-code-cli',ROVAI_KEEP_BUILTIN_CLI_FIXTURE:'1'},stdio:['ignore','pipe','pipe']})
  let stdout='',stderr=''
  child.stdout.on('data',x=>{stdout+=x});child.stderr.on('data',x=>{stderr+=x})
  const code=await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject)})
  const redact=value=>value.replaceAll(process.env.ROVAI_MINIMAX_LIVE_API_KEY,'[REDACTED]')
  await writeFile(join(f.root,'cli-stdout.log'),redact(stdout));await writeFile(join(f.root,'cli-stderr.log'),redact(stderr))
  assert.equal(code,0,redact(stderr.slice(-6000)))
  await f.checkpoint('all 29 current built-in CLI operations and successor lease fencing',{exitCode:code})
}catch(e){error=e}
await f.close(error)

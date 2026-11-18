// Actual Windows confinement through the packaged per-Run executor; no model calls.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
const source=resolve(import.meta.dirname,'..')
const options=new Map()
for(let i=2;i<process.argv.length;i+=2) {
 if(!['--bundle','--output','--node'].includes(process.argv[i])||!process.argv[i+1])throw new Error('Use --bundle <directory> --output <json> [--node <binary>]')
 options.set(process.argv[i],process.argv[i+1])
}
assert.equal(process.platform,'win32','This acceptance must execute on Windows')
assert(options.get('--output'),'An explicit evidence output is required')
const output=resolve(options.get('--output'))

const { runPrivateExecutor }=await import(pathToFileURL(join(source,'crates/rovai-core/src/dsh/local-hook-executor.mjs')))
const root=mkdtempSync(join(homedir(),'.loom-hook-ipc-')), workspace=join(root,'workspace')
mkdirSync(workspace)
const bundle=resolve(options.get('--bundle')??join(source,'resources/runtime/dsh-hook-executor'))
const hash=value=>createHash('sha256').update(value).digest('hex')
const quote=value=>"'"+value.replaceAll("'","''")+"'"
const write=(path,text)=>'Set-Content -LiteralPath '+quote(path)+' -Value '+quote(text)+' -NoNewline -ErrorAction Stop'
const proof={schemaVersion:1,status:'RUNNING',fixtureRoot:root,modelCalls:0,globalRuntimeModified:false,checks:[]}
async function entry(command,operation,mode='workspace-write') {
 const runId=randomUUID(),launchPath=join(root,runId+'.json')
 const launch={schemaVersion:1,agentRunId:runId,executionEpoch:0,snapshotDigest:hash(command),
  hookId:'owned-reviewed-fixture',workspaceRoot:workspace,sandboxMode:mode,model:'none',
  settings:{hooks:{PostToolUse:[{matcher:'^read$',hooks:[{type:'command',command,timeout:5}]}]}}}
 writeFileSync(launchPath,JSON.stringify(launch))
 const config={schemaVersion:1,node:resolve(options.get('--node')??process.execPath),root:bundle,launchPath,
  launchDigest:hash(readFileSync(launchPath)),manifestDigest:hash(readFileSync(join(bundle,'hook-executor-bundle.json')))}
 const invoke={sessionId:'owned-native-session',turn:1,handlerId:'owned-invocation',payload:{
  session_id:'owned-native-session',hook_event_name:'PostToolUse',tool_name:'read',turn_id:'1',cwd:workspace,
  tool_input:{},tool_response:'owned fixture'}}
 return operation({launch,config,invoke})
}
try {
 process.env.LOOM_PROVIDER_TEST_SECRET='must-not-reach-hook'
 const inside=join(workspace,'inside.txt')
 await entry('if ($env:LOOM_PROVIDER_TEST_SECRET) { exit 19 }; '+write(inside,'OWNED'),async f=>{
  const ready=await runPrivateExecutor(f.config,f.launch,'verify')
  assert.equal(ready.chain,'private-pinned')
  const result=await runPrivateExecutor(f.config,f.launch,'invoke',f.invoke)
  assert.equal(result.output.exitCode,0);assert.equal(readFileSync(inside,'utf8'),'OWNED')
  assert.equal(result.facts.sandboxEnforcement,'partial')
  proof.checks.push({name:'private_entry_inside_write_without_provider_environment',status:'PASS',facts:result.facts,exitCode:0})
 })
 const outside=join(root,'outside.txt')
 await entry(write(outside,'MUST_NOT_EXIST'),async f=>{
  const result=await runPrivateExecutor(f.config,f.launch,'invoke',f.invoke)
  assert.equal(existsSync(outside),false);assert.equal(result.facts.sandboxDenied,true)
  assert.notEqual(result.output.exitCode,0)
  proof.checks.push({name:'private_entry_outside_write_denied',status:'PASS',facts:result.facts,exitCode:result.output.exitCode})
 })
 const readonly=join(workspace,'readonly-denied.txt')
 await entry(write(readonly,'MUST_NOT_EXIST'),async f=>{
  const result=await runPrivateExecutor(f.config,f.launch,'invoke',f.invoke)
  assert.equal(existsSync(readonly),false);assert.equal(result.facts.sandboxDenied,true)
  assert.notEqual(result.output.exitCode,0);assert.equal(result.liveManagedHandles,0)
  proof.checks.push({name:'private_entry_read_only_write_denied',status:'PASS',facts:result.facts,exitCode:result.output.exitCode})
 },'read-only')
 const started=join(workspace,'started.txt'),late=join(workspace,'late.txt')
 await entry(write(started,'STARTED')+'; Start-Sleep -Seconds 4; '+write(late,'MUST_NOT_EXIST'),async f=>{
  const controller=new AbortController()
  const pending=runPrivateExecutor(f.config,f.launch,'invoke',f.invoke,controller.signal)
  const deadline=Date.now()+15000
  while(!existsSync(started)&&Date.now()<deadline)await pause(25)
  assert(existsSync(started),'command must actually start')
  controller.abort()
  const result=await pending
  assert.equal(result.facts.aborted,true)
  await pause(4300);assert.equal(existsSync(late),false)
  assert.equal(result.liveManagedHandles,0)
  proof.checks.push({name:'private_ipc_cancel_drains_started_command',status:'PASS',facts:result.facts,liveManagedHandles:0})
 })
 await entry(write(join(workspace,'tampered.txt'),'MUST_NOT_EXIST'),async f=>{
  writeFileSync(f.config.launchPath,JSON.stringify({...f.launch,sandboxMode:'read-only'}))
  await assert.rejects(runPrivateExecutor(f.config,f.launch,'invoke',f.invoke),/local_hook_launch_changed/)
  assert.equal(existsSync(join(workspace,'tampered.txt')),false)
  proof.checks.push({name:'changed_frozen_launch_refused',status:'PASS'})
 })
 proof.status='PASS_PRIVATE_EXECUTOR_ONLY'
} catch(error) { proof.status='FAIL';proof.failure=String(error?.message??error).slice(0,1500);process.exitCode=1 }
finally { writeFileSync(output,JSON.stringify(proof,null,2));console.log(JSON.stringify(proof)) }

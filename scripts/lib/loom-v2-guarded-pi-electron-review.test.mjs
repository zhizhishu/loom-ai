// E3-only: ONE disposable Windows Core SQLite, TWO actual guarded Pi 0.85.1
// write ToolCalls (loopback scripted fake Provider), then REAL Electron mouse
// input through production React ArtifactView to ONE persistent Owner Review.
// Uses a nonce-gated QA transport, NOT the shipping Host or a human click.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import electron from 'electron'
import react from '@vitejs/plugin-react'
import { build } from 'vite'
import { defaultCoreBinaryPath, verifyCachedCoreBinary, startIsolatedCore, stopCoreOrFail } from '../loom-v2-core-pi-integration.mjs'
import { runAuthorizedExecution } from '../loom-v2-runtime-execution.mjs'
import { submitGuardedCandidateToCore } from '../loom-v2-core-authorized-receipt.mjs'
import { DUMMY_API_KEY, MOCK_MODEL_ID } from '../loom-v2-pi-loopback-provider.mjs'
import { startQaGuardedWriteProvider } from './loom-v2-qa-scripted-pi-provider.mjs'
import { removeEphemeralRuntimeCampFilesRoot } from './runtime-camp-files-root.mjs'
import { admitElectronIntegrationTest } from './electron-sandbox-capability.mjs'

const root=resolve(import.meta.dirname,'../..')
const source=join(root,'scripts/fixtures/loom-real-core-review')
const hash=text=>createHash('sha256').update(text).digest('hex')
const key='LOOM_BRIDGE_MOCK_ONLY'
const criterion='archive-inspected'
const criterionVersion='isolated-real-pi-electron-v1'
const specs=[
 {taskId:'guarded-pi-electron-a',botId:'qa-bot-a',relativePath:'guarded-pi-a.md',
  text:'# Guarded Pi output A\n\nActual Pi file-tool A. Explicit owner review required.\n'},
 {taskId:'guarded-pi-electron-b',botId:'qa-bot-b',relativePath:'guarded-pi-b.md',
  text:'# Guarded Pi output B\n\nActual Pi file-tool B. Must remain pending.\n'}
]

test('TWO real guarded Pi writes -> ONE isolated Core SQLite -> REAL Electron pointer -> ONE explicit review', {
 timeout:420_000
},async t=>{
 if(!admitElectronIntegrationTest(t))return
 const fixture=mkdtempSync(join(tmpdir(),'loom-real-pi-electron-'))
 const home=join(fixture,'home'),temp=join(fixture,'tmp'),runtime=join(fixture,'runtime-dir')
 for(const dir of [home,temp,runtime])mkdirSync(dir)
 const environment={
  HOME:home,USERPROFILE:home,TMP:temp,TEMP:temp,TMPDIR:temp,
  XDG_CACHE_HOME:join(home,'.cache'),XDG_CONFIG_HOME:join(home,'.config'),
  XDG_DATA_HOME:join(home,'.local','share'),XDG_STATE_HOME:join(home,'.local','state'),
  XDG_RUNTIME_DIR:runtime,APPDATA:join(fixture,'appdata'),LOCALAPPDATA:join(fixture,'localappdata')
 }
 const contained=p=>{const rel=relative(fixture,p);return rel!==''&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel)}
 let core=null,child=null,closed=null,proxy=null,dataDir=null,preserve=false
 const oldKey=process.env[key],providers=[]
 try{
  const binary=defaultCoreBinaryPath()
  const binaryInfo=await verifyCachedCoreBinary(binary)
  const prepared=JSON.parse(execFileSync(binary,['--prepare-windows-data-root',join(fixture,'formal')],{
   encoding:'utf8',env:{...process.env,...environment}
  }))
  dataDir=prepared.core
  assert.ok(contained(dataDir))
  const skillRoot=join(dataDir,'managed-skill-library'),mcpPath=join(dataDir,'mcp.json')
  assert.ok(contained(skillRoot)&&contained(mcpPath))
  core=startIsolatedCore({dataDir,skillRoot,mcpPath,binaryPath:binary,environment})
  await core.ready;await core.settled()
  const agent=(await core.request('members.list')).find(m=>m.presence==='present')
  assert.ok(agent,'isolated Core requires fixture member')
  const missionId=(await core.request('missions.create',{commandId:randomUUID(),command:{
   title:'Real guarded Pi to Electron review isolated proof',
   description:'No commercial provider; disposable protected Core and QA React pointer',
   projectPath:'',projectBindingKind:'quick_chat',memberAgentIds:[agent.agentId],
   defaultLeadAgentId:agent.agentId,tags:['isolated-pi-electron-e3']
  }})).payload?.missionId
  assert.ok(missionId)
  await core.request('loom.plan.import',{missionId,
   goal:'Two REAL guarded Pi write receipts; only explicit Electron owner intent approves A',
   acceptanceCriteriaVersion:criterionVersion,
   criteria:[{criterionId:criterion,text:'Read the exact archived Core Pi artifact before acceptance'}],
   tasks:specs.map(w=>({taskId:w.taskId,title:w.botId,description:'Independent guarded Pi tool run'})),
   dependencies:[]})
  const workspaceRoot=join(dataDir,'quick-chat')
  mkdirSync(workspaceRoot,{recursive:true})
  const preparedRuns=[]
  process.env[key]=DUMMY_API_KEY
  for(const worker of specs){
   await core.request('loom.task.release',{missionId,taskId:worker.taskId})
   const agentRunId=randomUUID()
   const claim=await core.request('loom.claim.acquire',{
    missionId,taskId:worker.taskId,agentRunId,commandId:randomUUID(),leaseSeconds:1800})
   assert.equal(claim.agentRunId,agentRunId)
   const provider=await startQaGuardedWriteProvider(worker)
   providers.push(provider)
   const grant={runId:agentRunId,botId:worker.botId,workspaceRoot,allowedTools:['write'],
    isolatedSelfOwnedWorkspace:true,expiresAt:Date.now()+600_000}
   const model={providerId:'loom-mock',baseUrl:'http://127.0.0.1:'+provider.port+'/v1',
    modelId:MOCK_MODEL_ID,api:'openai-completions',apiKeyEnvVar:key}
   preparedRuns.push({worker,agentRunId,claim,grant,model,provider})
  }
  const runs=await Promise.all(preparedRuns.map(async run=>({
   ...run,receipt:await runAuthorizedExecution({grant:run.grant,model:run.model,
    prompt:'Write only the isolated test file instructed by the loopback provider. Never access user data.',
    expectedArtifactPaths:[run.worker.relativePath],promptTimeoutMs:180_000})
  })))
  assert.equal(runs.length,2)
  assert.notEqual(runs[0].receipt.launch.sessionId,runs[1].receipt.launch.sessionId)
  assert.notEqual(runs[0].provider.port,runs[1].provider.port)
  for(const run of runs){
   assert.equal(run.receipt.status,'settled')
   assert.equal(run.receipt.mockProvider,true)
   assert.equal(run.receipt.guard.unguardedExecutions,0)
   assert.equal(run.receipt.tools.executedCount,1)
   assert.equal(run.receipt.tools.executions[0].toolName,'write')
   assert.deepEqual(run.provider.requests[0].tools,['write'])
   assert.equal(run.provider.requests.length,2)
   assert.equal(run.receipt.artifacts[0].sha256,hash(run.worker.text))
   assert.equal(readFileSync(join(workspaceRoot,run.worker.relativePath),'utf8'),run.worker.text)
  }
  const receipts=await Promise.all(runs.map(run=>submitGuardedCandidateToCore({
   core,missionId,taskId:run.worker.taskId,agentRunId:run.agentRunId,
   botId:run.worker.botId,claim:run.claim,grant:run.grant,receipt:run.receipt,
   workspaceRoot,artifactRelativePath:run.worker.relativePath,
   acceptanceCriteriaVersion:criterionVersion,commandId:randomUUID()
  })))
  assert.equal(receipts.length,2)
  assert.ok(receipts.every(r=>r.coreIntegrated&&r.coreArtifactHashVerified
   &&r.artifactAuthorshipLinkedToToolCall&&r.candidatePending&&!r.ownerReviewRecorded))
  const artifacts=(await core.request('loom.artifacts.list',{missionId})).artifacts
  const candidates=await core.request('loom.candidates.list',{missionId})
  assert.equal(artifacts.length,2)
  assert.equal(candidates.length,2)
  assert.ok(candidates.every(c=>c.acceptanceStatus==='pending'&&c.verificationStatus==='unverified'))
  assert.deepEqual(await core.request('loom.reviews.list',{missionId}),[],
   'Core must contain ZERO Owner Reviews before the user-facing pointer action')
  for(const run of runs){
   const artifact=artifacts.find(a=>a.taskId===run.worker.taskId)
   assert.equal(artifact?.sha256,hash(run.worker.text))
   assert.equal((await core.request('loom.artifact.preview',{missionId,
    artifactId:artifact.artifactId})).text,run.worker.text)
  }

  // The renderer is the real production ArtifactView with a temporary QA-only
  // transport that exposes ONLY the current Mission and a nonce, never daily Core.
  const built=join(fixture,'renderer')
  await build({configFile:false,root:source,base:'./',logLevel:'error',plugins:[react()],
   resolve:{alias:{'@contracts':join(root,'packages/contracts/src/index.ts')}},
   build:{outDir:built,minify:false}})
  const userData=prepared.electronUserData&&contained(prepared.electronUserData)
   ?prepared.electronUserData:join(fixture,'electron-user-data')
  assert.ok(contained(userData))
  const output=join(fixture,'electron-evidence')
  mkdirSync(userData,{recursive:true});mkdirSync(output,{recursive:true})
  let outputText='',stderr='',rpcCount=0,realReviewWrites=0
  const rpcTrace=[]
  const nonce=randomUUID()
  const allowed=new Set(['preferences.tasks.get','loom.tasks.list','loom.candidates.list',
   'loom.artifacts.list','loom.reviews.list','loom.artifact.preview','loom.review.record'])
  proxy=createServer((req,res)=>{
   const send=(status,data)=>{
    if(res.writableEnded)return
    res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'})
    res.end(JSON.stringify(data))
   }
   if(req.method!=='POST'||req.headers['x-loom-qa-token']!==nonce){
    send(403,{ok:false,error:{code:'FIXTURE_TRANSPORT_DENIED'}});return
   }
   let parts=[],bytes=0
   req.on('data',chunk=>{bytes+=chunk.length;if(bytes<=131072)parts.push(chunk)})
   req.on('end',()=>{
    if(bytes>131072){send(413,{ok:false,error:{code:'FIXTURE_REQUEST_TOO_LARGE'}});return}
    let call
    try{call=JSON.parse(Buffer.concat(parts).toString('utf8'))}
    catch{send(400,{ok:false,error:{code:'FIXTURE_JSON_INVALID'}});return}
    if(!allowed.has(call.method)||
     (call.method!=='preferences.tasks.get'&&call.params?.missionId!==missionId)){
     send(403,{ok:false,error:{code:'FIXTURE_CORE_SCOPE_DENIED'}});return
    }
    rpcCount++
    if(call.method==='loom.review.record')realReviewWrites++
    void core.request(call.method,call.params).then(result=>{
     rpcTrace.push({method:call.method,result:'ok'})
     send(200,{ok:true,result})
    },error=>{
     rpcTrace.push({method:call.method,result:error?.code||'error'})
     send(200,{ok:false,error:{kind:error.kind,code:error.code,message:error.message}})
    })
   })
  })
  await new Promise((ok,fail)=>{proxy.once('error',fail);proxy.listen(0,'127.0.0.1',ok)})
  const port=proxy.address().port
  // Negative transport gates: a spoofed token, other Mission, and unlisted
  // Core method must fail BEFORE any persistent review mutation.
  const probe=(token,method,params)=>fetch('http://127.0.0.1:'+port+'/',{
   method:'POST',headers:{'content-type':'application/json','x-loom-qa-token':token},
   body:JSON.stringify({method,params}),signal:AbortSignal.timeout(5000)
  })
  assert.equal((await probe('wrong-token','loom.reviews.list',{missionId})).status,403)
  assert.equal((await probe(nonce,'loom.reviews.list',{missionId:randomUUID()})).status,403)
  assert.equal((await probe(nonce,'loom.review.delete',{missionId})).status,403)
  assert.deepEqual(await core.request('loom.reviews.list',{missionId}),[],
   'Rejected QA transport attempts must have zero Owner Review side effects')
  const env={...process.env,...environment,ROVAI_ALLOW_ISOLATED_INSTANCE:'1',
   ELECTRON_DISABLE_SECURITY_WARNINGS:'true',LOOM_QA_TOKEN:nonce}
  delete env.ELECTRON_RUN_AS_NODE
  const firstArtifact=artifacts.find(a=>a.taskId===specs[0].taskId)
  child=spawn(electron,[join(source,'main.cjs'),join(built,'index.html'),
   userData,output,missionId,firstArtifact.artifactId,String(port)],{
   env,stdio:['ignore','pipe','pipe']})
  closed=once(child,'close')
  child.stdout.on('data',part=>{outputText+=part.toString('utf8')})
  child.stderr.on('data',part=>{stderr+=part.toString('utf8')})
  const timer=setTimeout(()=>child.kill(),120_000)
  let exitCode
  try{[exitCode]=await closed}finally{clearTimeout(timer)}
  assert.equal(exitCode,0,'Electron fixture failed: '+stderr.slice(-2000)+'\n'+outputText.slice(-2000)
   +'\n'+JSON.stringify(rpcTrace))
  const report=JSON.parse(readFileSync(join(output,'report.json'),'utf8'))
  assert.equal(report.ok,true)
  assert.equal(report.realCore,true)
  assert.equal(report.actualElectronPointerInput,true)
  assert.equal(report.actualHumanUserClick,false)
  // The child Electron PROCESS did not launch the workers; the parent harness
  // did so above with two observed guarded Pi ToolCalls in the SAME Core mission.
  assert.equal(report.realPiExecutedInThisScenario,false)
  assert.equal(realReviewWrites,1)
  assert.ok(rpcCount>=8)
  proxy.closeAllConnections();await new Promise(ok=>proxy.close(ok));proxy=null
  const reviews=await core.request('loom.reviews.list',{missionId})
  assert.equal(reviews.length,1)
  assert.equal(reviews[0].reviewerId,'local_user')
  assert.equal(reviews[0].verdict,'accepted')
  const after=await core.request('loom.candidates.list',{missionId})
  assert.equal(after.find(c=>c.taskId===specs[0].taskId).acceptanceStatus,'accepted')
  assert.equal(after.find(c=>c.taskId===specs[1].taskId).acceptanceStatus,'pending')
  for(const run of runs){
   const artifact=artifacts.find(a=>a.taskId===run.worker.taskId)
   assert.equal((await core.request('loom.artifact.preview',{missionId,
    artifactId:artifact.artifactId})).text,run.worker.text)
  }
  await stopCoreOrFail(core,'before guarded Pi-electron SQLite recovery');core=null
  core=startIsolatedCore({dataDir,skillRoot,mcpPath,binaryPath:binary,environment})
  await core.ready;await core.settled()
  assert.equal((await core.request('loom.reviews.list',{missionId})).length,1)
  const restored=await core.request('loom.candidates.list',{missionId})
  assert.equal(restored.find(c=>c.taskId===specs[0].taskId).acceptanceStatus,'accepted')
  assert.equal(restored.find(c=>c.taskId===specs[1].taskId).acceptanceStatus,'pending')
  const evidence=join(root,'_artifacts/loom-v2-automation-20261116/guarded-pi-electron-'+randomUUID())
  mkdirSync(evidence,{recursive:true})
  copyFileSync(join(output,'report.json'),join(evidence,'report.json'))
  if(report.screenshotCaptured){
   assert.ok(existsSync(join(output,'real-core-after-review.png')))
   copyFileSync(join(output,'real-core-after-review.png'),join(evidence,'real-core-after-review.png'))
  }else{
   assert.equal(report.screenshotFailure,'display_capture_unavailable',
    'Missing Windows capture must remain explicit in the test evidence')
  }
  const result={
   scope:'E3-sandbox-only-one-Core-two-real-Pi-one-Electron-pointer',
   binarySha256:binaryInfo.sha256,model:'SCRIPTED_LOOPBACK_ONLY',mockProvider:true,
   realExternalProvider:false,actualHumanUserClick:false,actualElectronPointerInput:true,
   verifiedGuardedPiToolCalls:2,hostHashedArtifacts:2,pendingBeforeUserInterface:2,
   reviewsBeforeInterface:0,reviewsAfterInterface:1,accepted:1,pending:1,
   screenshotCaptured:report.screenshotCaptured,
   screenshotFailure:report.screenshotFailure,
   sameCoreSqliteRestart:true,fixtureProxyNotProductionHost:true,
   userDailyDatabaseTouched:false,port64851Touched:false,
   E4:'NOT_VERIFIED',E5:'NOT_RUN',E6:'NOT_VERIFIED',E7:'NOT_RUN'
  }
  writeFileSync(join(evidence,'e3-manifest.json'),JSON.stringify(result,null,2))
  console.log(JSON.stringify({...result,evidence:relative(root,evidence)}))
 }finally{
  if(proxy){proxy.closeAllConnections();await new Promise(ok=>proxy.close(ok));proxy=null}
  if(child&&child.exitCode===null&&child.signalCode===null){
   child.kill();if(closed)await closed
  }
  await Promise.all(providers.map(p=>p.close()))
  if(oldKey===undefined)delete process.env[key];else process.env[key]=oldKey
  if(core){try{await stopCoreOrFail(core,'after guarded Pi-Electron review')}
   catch(error){preserve=true;throw error}}
  if(!preserve){
   if(dataDir)await removeEphemeralRuntimeCampFilesRoot(dataDir,{
    temporaryDirectory:fixture,homeDirectory:home})
   await rm(fixture,{recursive:true,force:true,maxRetries:3,retryDelay:120})
  }
 }
})

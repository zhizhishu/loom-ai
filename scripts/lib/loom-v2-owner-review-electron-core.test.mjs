// E3 qualification: real pointer clicks through production React ArtifactView to a
// REAL isolated Core SQLite. Artifacts are synthetic fixture files, NOT Pi writes here.
// Never use daily Core userData, 64851, external Provider, or user credentials.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import electron from 'electron'
import react from '@vitejs/plugin-react'
import { build } from 'vite'
import { defaultCoreBinaryPath, verifyCachedCoreBinary, startIsolatedCore, stopCoreOrFail } from '../loom-v2-core-pi-integration.mjs'
import { removeEphemeralRuntimeCampFilesRoot } from './runtime-camp-files-root.mjs'
import { admitElectronIntegrationTest } from './electron-sandbox-capability.mjs'

const root=resolve(import.meta.dirname,'../..')
const source=join(root,'scripts/fixtures/loom-real-core-review')
const hash=text=>createHash('sha256').update(text).digest('hex')
const ids=['ui-real-core-a','ui-real-core-b']
const criterion='archive-inspected'
const criterionVersion='isolated-electron-real-core-v1'

test('real Electron pointer Approve -> production ArtifactView -> ONE genuine Core Review and one pending candidate', {
 timeout:270_000
},async t=>{
 if(!admitElectronIntegrationTest(t))return
 const fixture=mkdtempSync(join(tmpdir(),'loom-real-core-electron-'))
 const home=join(fixture,'home'),temp=join(fixture,'tmp'),runtime=join(fixture,'runtime-dir')
 for(const p of [home,temp,runtime])mkdirSync(p)
 const environment={
  HOME:home,USERPROFILE:home,TMP:temp,TEMP:temp,TMPDIR:temp,
  XDG_CACHE_HOME:join(home,'.cache'),XDG_CONFIG_HOME:join(home,'.config'),
  XDG_DATA_HOME:join(home,'.local','share'),XDG_STATE_HOME:join(home,'.local','state'),
  XDG_RUNTIME_DIR:runtime,APPDATA:join(fixture,'appdata'),LOCALAPPDATA:join(fixture,'localappdata')
 }
 const contained=p=>{const rel=relative(fixture,p);return rel!==''&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel)}
 let core=null,child=null,dataDir=null,closed=null,proxy=null,preserve=false
 try{
  const binary=defaultCoreBinaryPath()
  const binaryInfo=await verifyCachedCoreBinary(binary)
  const prepared=JSON.parse(execFileSync(binary,['--prepare-windows-data-root',join(fixture,'formal')],{
   encoding:'utf8',env:{...process.env,...environment}
  }))
  dataDir=prepared.core
  assert.ok(contained(dataDir),'Core root must be inside the disposable fixture')
  const skillRoot=join(dataDir,'managed-skill-library'),mcpPath=join(dataDir,'mcp.json')
  assert.ok(contained(skillRoot)&&contained(mcpPath))
  core=startIsolatedCore({dataDir,skillRoot,mcpPath,binaryPath:binary,environment})
  await core.ready;await core.settled()
  const member=(await core.request('members.list')).find(row=>row.presence==='present')
  assert.ok(member)
  const missionId=(await core.request('missions.create',{commandId:randomUUID(),command:{
   title:'Real Electron owner-review integration sandbox',
   description:'Only synthetic fixture files and real isolated Core RPC; no external Provider',
   projectPath:'',projectBindingKind:'quick_chat',
   memberAgentIds:[member.agentId],defaultLeadAgentId:member.agentId,tags:['isolated-real-electron']
  }})).payload?.missionId
  assert.ok(missionId)
  await core.request('loom.plan.import',{missionId,
   goal:'Two pending archived fixture files, explicit UI pointer accepts exactly one',
   acceptanceCriteriaVersion:criterionVersion,
   criteria:[{criterionId:criterion,text:'Read the real Core archive before accepting'}],
   tasks:ids.map(taskId=>({taskId,title:taskId,description:'Isolated fixture task'})),
   dependencies:[]})
  const workspace=join(dataDir,'quick-chat')
  mkdirSync(workspace,{recursive:true})
  const records=[]
  for(const [index,taskId] of ids.entries()){
   await core.request('loom.task.release',{missionId,taskId})
   const agentRunId=randomUUID()
   const claim=await core.request('loom.claim.acquire',{
    missionId,taskId,agentRunId,commandId:randomUUID(),leaseSeconds:1800})
   const text=index===0?'# Core isolated artifact A\n\nCore isolated artifact A: archived and waiting for review.\n':
      '# Core isolated artifact B\n\nCore isolated artifact B: must remain pending.\n'
   const relativePath='isolated-owner-'+index+'.md'
   writeFileSync(join(workspace,relativePath),text)
   const registered=await core.request('loom.artifact.register',{missionId,taskId,agentRunId,relativePath})
   const artifact=registered.artifact
   assert.equal(artifact.sha256,hash(text))
   const candidate=await core.request('loom.candidate.record',{
    missionId,taskId,agentRunId,claimId:claim.claimId,fenceGeneration:claim.fenceGeneration,
    commandId:randomUUID(),contentHash:artifact.sha256,evidenceIds:[artifact.artifactId],
    acceptanceCriteriaVersion:criterionVersion
   })
   assert.equal(candidate.acceptanceStatus,'pending')
   records.push({taskId,artifact,candidate,text})
  }
  assert.deepEqual(await core.request('loom.reviews.list',{missionId}),[])
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
  // Electron main's stdin is not a reliable RPC channel on this Windows host.
  // Use a nonce-gated, loopback-only and bounded test proxy instead. NEVER expose Core
  // or any user database to the network; this Core is disposable and isolated.
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
    send(403,{ok:false,error:{code:'FIXTURE_TRANSPORT_DENIED',message:'Isolated nonce required'}})
    return
   }
   let chunks=[],bytes=0
   req.on('data',part=>{bytes+=part.length;if(bytes<=131072)chunks.push(part)})
   req.on('end',()=>{
    if(bytes>131072){send(413,{ok:false,error:{code:'FIXTURE_REQUEST_TOO_LARGE'}});return}
    let call
    try{call=JSON.parse(Buffer.concat(chunks).toString('utf8'))}
    catch{send(400,{ok:false,error:{code:'FIXTURE_JSON_INVALID'}});return}
    if(!allowed.has(call.method)
      ||(call.method!=='preferences.tasks.get'&&call.params?.missionId!==missionId)){
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
  const env={...process.env,...environment,ROVAI_ALLOW_ISOLATED_INSTANCE:'1',
   ELECTRON_DISABLE_SECURITY_WARNINGS:'true',LOOM_QA_TOKEN:nonce}
  delete env.ELECTRON_RUN_AS_NODE
  child=spawn(electron,[join(source,'main.cjs'),join(built,'index.html'),
    userData,output,missionId,records[0].artifact.artifactId,String(port)],{
    env,stdio:['ignore','pipe','pipe']})
  closed=once(child,'close')
  child.stdout.on('data',chunk=>{outputText+=chunk.toString('utf8')})
  child.stderr.on('data',chunk=>{stderr+=chunk.toString('utf8')})
  const timer=setTimeout(()=>child.kill(),120_000)
  let exitCode
  try{[exitCode]=await closed}finally{clearTimeout(timer)}
  assert.equal(exitCode,0,'Electron fixture exited non-zero: '+stderr.slice(-2500)+'\n'+outputText.slice(-2500)+'\n'+JSON.stringify(rpcTrace))
  const report=JSON.parse(readFileSync(join(output,'report.json'),'utf8'))
  assert.equal(report.ok,true)
  assert.equal(report.realCore,true)
  assert.equal(report.actualElectronPointerInput,true)
  assert.equal(report.actualHumanUserClick,false)
  assert.equal(report.realPiExecutedInThisScenario,false)
  assert.equal(realReviewWrites,1,'renderer must issue exactly ONE acceptance command')
  assert.ok(rpcCount>=8)
  proxy.closeAllConnections();await new Promise(ok=>proxy.close(ok));proxy=null
  const stored=await core.request('loom.reviews.list',{missionId})
  assert.equal(stored.length,1)
  assert.equal(stored[0].reviewerId,'local_user')
  const candidates=await core.request('loom.candidates.list',{missionId})
  assert.equal(candidates.find(x=>x.taskId===ids[0]).acceptanceStatus,'accepted')
  assert.equal(candidates.find(x=>x.taskId===ids[1]).acceptanceStatus,'pending')
  await stopCoreOrFail(core,'before Electron Review same SQLite recovery');core=null
  core=startIsolatedCore({dataDir,skillRoot,mcpPath,binaryPath:binary,environment})
  await core.ready;await core.settled()
  assert.equal((await core.request('loom.reviews.list',{missionId})).length,1)
  const restored=await core.request('loom.candidates.list',{missionId})
  assert.equal(restored.find(x=>x.taskId===ids[0]).acceptanceStatus,'accepted')
  assert.equal(restored.find(x=>x.taskId===ids[1]).acceptanceStatus,'pending')
  const evidence=join(root,'_artifacts/loom-v2-automation-20261116/electron-real-core-'+randomUUID())
  mkdirSync(evidence,{recursive:true})
  copyFileSync(join(output,'report.json'),join(evidence,'report.json'))
  if(report.screenshotCaptured){
   assert.ok(existsSync(join(output,'real-core-after-review.png')))
   copyFileSync(join(output,'real-core-after-review.png'),join(evidence,'real-core-after-review.png'))
  }else{
   assert.equal(report.screenshotFailure,'display_capture_unavailable',
    'Missing Windows capture must remain explicit in the test evidence')
  }
  console.log(JSON.stringify({scope:'E3-isolated-Electron-pointer-real-Core',
   binarySha256:binaryInfo.sha256,readOnlyPreview:true,fixtureReviewWriteRequests:realReviewWrites,
   reviewerId:'local_user',accepted:1,pending:1,
   actualElectronPointerInput:true,actualHumanUserClick:false,
   realPiExecutedInThisScenario:false,provider:'NONE',E4:'NOT_VERIFIED',
   E5:'NOT_RUN',E6:'NOT_VERIFIED',E7:'NOT_RUN',
   screenshotCaptured:report.screenshotCaptured,screenshotFailure:report.screenshotFailure,
   evidence:relative(root,evidence)}))
 }finally{
  if(proxy){proxy.closeAllConnections();await new Promise(ok=>proxy.close(ok));proxy=null}
  if(child&&child.exitCode===null&&child.signalCode===null){
   child.kill();if(closed)await closed
  }
  if(core){try{await stopCoreOrFail(core,'after real Electron Core Review')}catch(error){preserve=true;throw error}}
  if(!preserve){if(dataDir)await removeEphemeralRuntimeCampFilesRoot(dataDir,{
   temporaryDirectory:fixture,homeDirectory:home})
   await rm(fixture,{recursive:true,force:true,maxRetries:3,retryDelay:120})}
 }
})

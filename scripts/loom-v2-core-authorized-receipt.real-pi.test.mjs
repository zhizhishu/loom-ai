// Two guarded Pi 0.85.1 workers against loopback scripted Providers. The first test
// uses a mock Core; the second uses ONE real isolated Core SQLite and then exercises
// the production Mikka review data service with an explicit fixture-only verdict.
// Neither test represents a human UI click or qualifies E4/E5/E6/E7.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { runAuthorizedExecution } from './loom-v2-runtime-execution.mjs'
import { defaultCoreBinaryPath, startIsolatedCore, stopCoreOrFail } from './loom-v2-core-pi-integration.mjs'
import { removeEphemeralRuntimeCampFilesRoot } from './lib/runtime-camp-files-root.mjs'
import { submitGuardedCandidateToCore } from './loom-v2-core-authorized-receipt.mjs'
import { DUMMY_API_KEY, MOCK_MODEL_ID } from './loom-v2-pi-loopback-provider.mjs'

const hash = data => createHash('sha256').update(data).digest('hex')
const WORKER_KEY = 'LOOM_BRIDGE_MOCK_ONLY'
const workers = [{ botId:'bot_worker_a', taskId:'worker-task-a', runId:'authorized-run-a', text:'worker A actual tool output\n' },
  { botId:'bot_worker_b', taskId:'worker-task-b', runId:'authorized-run-b', text:'worker B actual tool output\n' }]

async function scriptedProvider(worker) {
  const sockets = new Set()
  const requests = []
  let index = 0
  const server = createServer((req, res) => {
    const parts = []
    req.on('data', part => parts.push(part))
    req.on('end', () => {
      let body
      try { body = JSON.parse(Buffer.concat(parts).toString('utf8')) }
      catch { res.writeHead(400).end('{}'); return }
      requests.push({ tools: (body.tools ?? []).map(tool=>tool?.function?.name ?? tool?.name) })
      res.writeHead(200, { 'content-type':'text/event-stream; charset=utf-8', 'cache-control':'no-store' })
      const base = { id:'chatcmpl-bridge-'+index, object:'chat.completion.chunk', created:1, model:body.model }
      const emit = payload => res.write('data: '+JSON.stringify(payload)+'\n\n')
      if (index++ === 0) {
        emit({...base,choices:[{index:0,delta:{role:'assistant',tool_calls:[{
          index:0,id:'write-'+worker.botId,type:'function',
          function:{name:'write',arguments:JSON.stringify({path:worker.relativePath ?? 'out.txt',content:worker.text})}
        }]},finish_reason:null}]})
        emit({...base,choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:8,completion_tokens:4,total_tokens:12}})
      } else {
        emit({...base,choices:[{index:0,delta:{role:'assistant',content:'scripted completion'},finish_reason:null}]})
        emit({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:8,completion_tokens:4,total_tokens:12}})
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  server.on('connection', socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket))})
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok)})
  return {port:server.address().port,requests,close:async()=>{
    for(const socket of sockets) socket.destroy()
    await new Promise(done=>server.close(()=>done()))
  }}
}

test('two REAL guarded Pi workers -> linked artifact receipts -> pending mock-Core candidates (E3-only)', {
  timeout:420_000, skip:process.platform!=='win32' && 'pinned Pi launcher is Windows'
},async()=>{
  const root=mkdtempSync(join(tmpdir(),'loom-guarded-bridge-realpi-'))
  const oldKey=process.env[WORKER_KEY]
  process.env[WORKER_KEY]=DUMMY_API_KEY
  const providers=[]
  try {
    const prepared=await Promise.all(workers.map(async worker=>{
      const workspaceRoot=join(root,worker.botId)
      mkdirSync(workspaceRoot)
      const provider=await scriptedProvider(worker)
      providers.push(provider)
      const claim={claimId:'claim-'+worker.botId,taskId:worker.taskId,agentRunId:worker.runId,
        fenceGeneration:1,leaseExpiresAt:new Date(Date.now()+3600_000).toISOString(),expired:false,releasedAt:null}
      const grant={runId:worker.runId,botId:worker.botId,workspaceRoot,
        allowedTools:['write'],isolatedSelfOwnedWorkspace:true,expiresAt:Date.now()+300_000}
      const model={providerId:'loom-mock',baseUrl:'http://127.0.0.1:'+provider.port+'/v1',
        modelId:MOCK_MODEL_ID,api:'openai-completions',apiKeyEnvVar:WORKER_KEY}
      return {worker,workspaceRoot,provider,claim,grant,model}
    }))
    const runtime=await Promise.all(prepared.map(async item=>({
      ...item,
      receipt:await runAuthorizedExecution({grant:item.grant,model:item.model,
        prompt:'Use the granted write tool to write out.txt as instructed by the fixture; no external work.',
        expectedArtifactPaths:['out.txt'],promptTimeoutMs:180_000})
    })))
    for(const item of runtime) {
      assert.equal(item.receipt.status,'settled')
      assert.equal(item.receipt.mockProvider,true)
      assert.equal(item.receipt.guard.loaded,true)
      assert.equal(item.receipt.guard.unguardedExecutions,0)
      assert.equal(item.receipt.tools.executedCount,1)
      assert.equal(item.receipt.tools.deniedAttempts.length,0)
      assert.equal(item.receipt.tools.executions[0].toolName,'write')
      assert.equal(readFileSync(join(item.workspaceRoot,'out.txt'),'utf8'),item.worker.text)
      assert.equal(item.receipt.artifacts[0].sha256,hash(item.worker.text))
      assert.equal(item.provider.requests.length,2)
      assert.deepEqual(item.provider.requests[0].tools,['write'])
      assert.equal(existsSync(item.receipt.isolation.tempRootReal),false)
    }
    assert.notEqual(runtime[0].receipt.launch.sessionId,runtime[1].receipt.launch.sessionId)
    assert.notEqual(runtime[0].provider.port,runtime[1].provider.port)
    const coreCalls=[]
    const core={async request(method, params) {
      coreCalls.push({method,params})
      if(method==='loom.claims.list')return {evaluatedAt:new Date().toISOString(),claims:prepared.map(x=>x.claim)}
      const item=prepared.find(x=>x.worker.taskId===params.taskId)
      if(!item)throw new Error('mock_core_bad_task')
      if(method==='loom.artifact.register'){
        const bytes=readFileSync(join(item.workspaceRoot,params.relativePath))
        return {artifact:{artifactId:'artifact-'+item.worker.botId,taskId:params.taskId,
          relativePath:params.relativePath,sha256:hash(bytes),sizeBytes:bytes.length}}
      }
      if(method==='loom.candidate.record')return {candidateId:'candidate-'+item.worker.botId,
        taskId:params.taskId,agentRunId:params.agentRunId,contentHash:params.contentHash,
        evidenceIds:params.evidenceIds,verificationStatus:'unverified',acceptanceStatus:'pending'}
      throw new Error('forbidden_core_method:'+method)
    }}
    const submitted=await Promise.all(runtime.map(item=>submitGuardedCandidateToCore({
      core,missionId:'mock-mission',taskId:item.worker.taskId,agentRunId:item.worker.runId,
      botId:item.worker.botId,claim:item.claim,grant:item.grant,receipt:item.receipt,
      workspaceRoot:item.workspaceRoot,artifactRelativePath:'out.txt',
      acceptanceCriteriaVersion:'mock-criteria-v1',commandId:'candidate-'+item.worker.runId
    })))
    assert.equal(submitted.length,2)
    for(const output of submitted) {
      assert.equal(output.artifactAuthorshipLinkedToToolCall,true)
      assert.equal(output.coreArtifactHashVerified,true)
      assert.equal(output.ownerReviewRecorded,false)
      assert.equal(output.scope,'E3-sandbox-only')
    }
    assert.equal(coreCalls.filter(x=>x.method==='loom.artifact.register').length,2)
    assert.equal(coreCalls.filter(x=>x.method==='loom.candidate.record').length,2)
    assert.equal(coreCalls.some(x=>x.method==='loom.review.record'||x.method==='loom.verification.record'),false)
  } finally {
    await Promise.all(providers.map(p=>p.close()))
    if(oldKey===undefined)delete process.env[WORKER_KEY];else process.env[WORKER_KEY]=oldKey
    await rm(root,{recursive:true,force:true})
  }
})

// One protected Core SQLite, two real guarded Pi file-tool outputs, then explicit
// production Mikka service review. Provider is scripted loopback, and the
// accepting intent is only a fixture action: NO human clicked the Electron UI.
test('ONE real Core SQLite -> two guarded Pi files -> pending artifacts -> explicit Mikka service fixture review', {
  timeout:420_000, skip:process.platform!=='win32' && 'Windows protected Core root required'
},async()=>{
  const fixture=mkdtempSync(join(tmpdir(),'loom-core-guarded-two-'))
  const home=join(fixture,'home')
  const temporary=join(fixture,'tmp')
  const runtimeDir=join(fixture,'runtime-dir')
  for(const folder of [home,temporary,runtimeDir])mkdirSync(folder)
  const env={
    HOME:home,USERPROFILE:home,TMP:temporary,TEMP:temporary,TMPDIR:temporary,
    XDG_CACHE_HOME:join(home,'.cache'),XDG_CONFIG_HOME:join(home,'.config'),
    XDG_DATA_HOME:join(home,'.local','share'),XDG_STATE_HOME:join(home,'.local','state'),
    XDG_RUNTIME_DIR:runtimeDir,APPDATA:join(fixture,'appdata'),
    LOCALAPPDATA:join(fixture,'localappdata')
  }
  const oldKey=process.env[WORKER_KEY]
  process.env[WORKER_KEY]=DUMMY_API_KEY
  let core=null
  let dataDir=null
  let preserve=false
  const providers=[]
  try{
    const binary=defaultCoreBinaryPath()
    const prepared=JSON.parse(execFileSync(binary,['--prepare-windows-data-root',join(fixture,'formal')],
      {encoding:'utf8',env:{...process.env,...env}}))
    dataDir=prepared.core
    assert.equal(typeof dataDir,'string')
    assert.ok(dataDir.startsWith(fixture),'protected Core data root must be inside fixture')
    const skillRoot=join(dataDir,'managed-skill-library')
    const mcpPath=join(dataDir,'mcp.json')
    core=startIsolatedCore({dataDir,skillRoot,mcpPath,binaryPath:binary,environment:env})
    await core.ready
    await core.settled()
    const members=await core.request('members.list')
    const agent=members.find(member=>member.presence==='present')
    assert.ok(agent,'isolated Core must expose present fixture member')
    const missionId=(await core.request('missions.create',{commandId:randomUUID(),command:{
      title:'isolated authorized two Pi tool delivery',description:'Only mock provider and ephemeral workspace',
      projectPath:'',projectBindingKind:'quick_chat',memberAgentIds:[agent.agentId],
      defaultLeadAgentId:agent.agentId,tags:['loom-guarded-e3']
    }})).payload?.missionId
    assert.equal(typeof missionId,'string')
    const criterionVersion='loom-guarded-e3-v1'
    const imported=await core.request('loom.plan.import',{
      missionId,goal:'Two guarded Pi tool writes become two owner-pending candidates',
      acceptanceCriteriaVersion:criterionVersion,
      criteria:[{criterionId:'a',text:'A guarded tool wrote A artifact'},{criterionId:'b',text:'B guarded tool wrote B artifact'}],
      tasks:workers.map(worker=>({taskId:worker.taskId,title:worker.botId,description:'independent tool delivery'})),
      dependencies:[]
    })
    assert.equal(imported.missionId,missionId)
    for(const worker of workers){
      const released=await core.request('loom.task.release',{missionId,taskId:worker.taskId})
      assert.equal(released.task.status,'ready')
    }
    const workspaceRoot=join(dataDir,'quick-chat')
    mkdirSync(workspaceRoot,{recursive:true})
    const preparedWorkers=await Promise.all(workers.map(async worker=>{
      const agentRunId=randomUUID()
      const claim=await core.request('loom.claim.acquire',{
        missionId,taskId:worker.taskId,agentRunId,commandId:randomUUID(),leaseSeconds:1800
      })
      assert.equal(claim.agentRunId,agentRunId)
      const configured={...worker,relativePath:worker.botId+'.txt'}
      const provider=await scriptedProvider(configured)
      providers.push(provider)
      const grant={runId:agentRunId,botId:worker.botId,workspaceRoot,
        allowedTools:['write'],isolatedSelfOwnedWorkspace:true,expiresAt:Date.now()+600_000}
      const model={providerId:'loom-mock',baseUrl:'http://127.0.0.1:'+provider.port+'/v1',
        modelId:MOCK_MODEL_ID,api:'openai-completions',apiKeyEnvVar:WORKER_KEY}
      return {worker:configured,agentRunId,claim,grant,model,provider}
    }))
    const runtime=await Promise.all(preparedWorkers.map(async item=>({
      ...item,receipt:await runAuthorizedExecution({
        grant:item.grant,model:item.model,
        prompt:'Only write the fixture file instructed by the scripted local test. Never access user files.',
        expectedArtifactPaths:[item.worker.relativePath],promptTimeoutMs:180_000
      })
    })))
    for(const item of runtime){
      assert.equal(item.receipt.status,'settled')
      assert.equal(item.receipt.mockProvider,true)
      assert.equal(item.receipt.tools.executedCount,1)
      assert.equal(item.receipt.guard.unguardedExecutions,0)
      assert.equal(item.receipt.artifacts[0].sha256,hash(item.worker.text))
      assert.equal(readFileSync(join(workspaceRoot,item.worker.relativePath),'utf8'),item.worker.text)
    }
    assert.notEqual(runtime[0].receipt.launch.sessionId,runtime[1].receipt.launch.sessionId)
    // Genuine Core read-back must reject the wrong generation even with a valid real Pi receipt.
    const first=runtime[0]
    await assert.rejects(()=>submitGuardedCandidateToCore({
      core,missionId,taskId:first.worker.taskId,agentRunId:first.agentRunId,
      botId:first.worker.botId,claim:{...first.claim,fenceGeneration:first.claim.fenceGeneration+1},
      grant:first.grant,receipt:first.receipt,workspaceRoot,
      artifactRelativePath:first.worker.relativePath,
      acceptanceCriteriaVersion:criterionVersion,commandId:randomUUID()
    }),/core_claim_lost_or_stale/)
    assert.deepEqual(await core.request('loom.candidates.list',{missionId}),[],
      'wrong fence must not insert any candidate')
    const outcomes=await Promise.all(runtime.map(item=>submitGuardedCandidateToCore({
      core,missionId,taskId:item.worker.taskId,agentRunId:item.agentRunId,
      botId:item.worker.botId,claim:item.claim,grant:item.grant,receipt:item.receipt,
      workspaceRoot,artifactRelativePath:item.worker.relativePath,
      acceptanceCriteriaVersion:criterionVersion,commandId:randomUUID()
    })))
    assert.equal(outcomes.length,2)
    assert.ok(outcomes.every(o=>o.coreIntegrated && o.coreArtifactHashVerified
      && o.artifactAuthorshipLinkedToToolCall && o.candidatePending && !o.ownerReviewRecorded))
    const candidates=await core.request('loom.candidates.list',{missionId})
    const artifacts=(await core.request('loom.artifacts.list',{missionId})).artifacts
    const held=(await core.request('loom.claims.list',{missionId})).claims
    const reviews=await core.request('loom.reviews.list',{missionId})
    assert.equal(candidates.length,2)
    assert.equal(artifacts.length,2)
    assert.equal(held.length,2)
    assert.deepEqual(reviews,[],'no automated review or owner approval')
    assert.ok(candidates.every(c=>c.verificationStatus==='unverified' && c.acceptanceStatus==='pending'))
    assert.deepEqual(artifacts.map(a=>a.sha256).sort(),runtime.map(item=>hash(item.worker.text)).sort())
    // Real Core does not merely list an artifact: its immutable blob archive must be
    // readable for Owner inspection before any acceptance/review is recorded.
    for(const artifact of artifacts){
      const item=runtime.find(row=>row.worker.taskId===artifact.taskId)
      assert.ok(item)
      const preview=await core.request('loom.artifact.preview',{missionId,artifactId:artifact.artifactId})
      assert.equal(preview.artifactId,artifact.artifactId)
      assert.equal(preview.sha256,hash(item.worker.text))
      assert.equal(preview.text,item.worker.text,'Core archive must return exact tool-written bytes')
      assert.equal(preview.unavailableReason,null)
    }
    assert.deepEqual((await core.request('loom.tasks.list',{missionId}))
      .map(t=>t.status),['in_review','in_review'])
    // The same protected Core SQLite must survive a REAL process stop/restart, not a new mock.
    await stopCoreOrFail(core,'before same-SQLite restart')
    core=null
    core=startIsolatedCore({
      dataDir,skillRoot,mcpPath,binaryPath:binary,environment:env
    })
    await core.ready
    await core.settled()
    const restoredCandidates=await core.request('loom.candidates.list',{missionId})
    const restoredArtifacts=(await core.request('loom.artifacts.list',{missionId})).artifacts
    const restoredClaims=(await core.request('loom.claims.list',{missionId})).claims
    const restoredReviews=await core.request('loom.reviews.list',{missionId})
    assert.equal(restoredClaims.length,2,'Core must restore both fences from one SQLite')
    assert.equal(restoredArtifacts.length,2,'Core must restore both actual tool artifacts')
    assert.equal(restoredCandidates.length,2,'Core must restore two pending candidates')
    assert.deepEqual(restoredReviews,[],'restart must not create fake Owner Review')
    assert.ok(restoredCandidates.every(c=>c.verificationStatus==='unverified'&&c.acceptanceStatus==='pending'))
    assert.deepEqual(restoredArtifacts.map(a=>a.sha256).sort(),artifacts.map(a=>a.sha256).sort(),
      'Core restart must retain Host-computed artifact digests')
    for(const artifact of restoredArtifacts){
      const item=runtime.find(row=>row.worker.taskId===artifact.taskId)
      assert.ok(item)
      const preview=await core.request('loom.artifact.preview',{missionId,artifactId:artifact.artifactId})
      assert.equal(preview.text,item.worker.text,'Core restart must preserve readable immutable artifact bytes')
      assert.equal(preview.sha256,artifact.sha256)
      assert.equal(preview.unavailableReason,null)
    }
    // Reuse production renderer data-layer functions against the SAME recovered Core
    // and the SAME actual Pi file-tool artifacts; synthetic review fixtures alone do
    // not establish that the guarded Pi outputs reach Mikka's real approval service.
    const productionService = await build({
      entryPoints: [resolve(import.meta.dirname, '../apps/desktop/src/renderer/src/loom-native/artifact-service.ts')],
      bundle: true, platform: 'node', format: 'esm', target: 'es2022',
      write: false, logLevel: 'silent'
    })
    assert.equal(productionService.outputFiles.length, 1)
    const serviceBundle = join(fixture, 'production-artifact-service.mjs')
    writeFileSync(serviceBundle, productionService.outputFiles[0].contents)
    const ui = await import(pathToFileURL(serviceBundle).href)
    const firstArtifact = restoredArtifacts.find(a => a.taskId === workers[0].taskId)
    const secondArtifact = restoredArtifacts.find(a => a.taskId === workers[1].taskId)
    const firstCandidate = restoredCandidates.find(c => c.taskId === workers[0].taskId)
    assert.ok(firstArtifact && secondArtifact && firstCandidate)
    const firstPreview = await ui.readArtifactPreview(core, missionId, firstArtifact.artifactId)
    const secondPreview = await ui.readArtifactPreview(core, missionId, secondArtifact.artifactId)
    assert.deepEqual(firstPreview, { status: 'ready', text: workers[0].text })
    assert.deepEqual(secondPreview, { status: 'ready', text: workers[1].text })
    assert.deepEqual(await core.request('loom.reviews.list', { missionId }), [],
      'Mikka reading real Pi artifact previews must never approve them')
    const workBundle = {
      mission: { missionId },
      tasks: await core.request('loom.tasks.list', { missionId }),
      candidates: restoredCandidates,
      artifacts: restoredArtifacts,
      reviews: [],
      verifications: []
    }
    const facts = ui.artifactCandidateFacts(workBundle, firstArtifact, firstCandidate)
    assert.equal(facts.reviewable, true)
    assert.equal(facts.criteriaVersion, criterionVersion)
    assert.deepEqual(facts.criteria.map(c => c.criterionId), ['a', 'b'])
    // A and B really wrote both outputs and both archives were explicitly inspected.
    // This is a FIXTURE-specified Owner intent, NOT an actual human UI action.
    assert.throws(() => ui.prepareArtifactReviewAttempt(missionId, facts, {
      candidateId: firstCandidate.candidateId, verdict: 'accepted',
      reason: 'Explicit isolated fixture review', satisfied: []
    }), /验收标准/)
    const attempt = ui.prepareArtifactReviewAttempt(missionId, facts, {
      candidateId: firstCandidate.candidateId, verdict: 'accepted',
      reason: 'Fixture explicitly inspected both real Pi tool outputs',
      satisfied: ['a', 'b']
    })
    assert.equal(Object.hasOwn(attempt.payload, 'reviewerId'), false)
    assert.ok(Object.isFrozen(attempt.payload.criteriaResults))
    assert.deepEqual(await core.request('loom.reviews.list', { missionId }), [],
      'building a frozen review attempt cannot silently write a Core Review')
    const outcome = await ui.sendArtifactReviewAttempt(core, attempt)
    assert.equal(outcome.state, 'completed', JSON.stringify(outcome))
    assert.equal(outcome.receipt.replayed, false)
    assert.equal(outcome.receipt.review.reviewerId, 'local_user',
      'Core must derive reviewer identity rather than trusting an injected UI field')
    assert.equal(outcome.receipt.candidateAcceptanceStatus, 'accepted')
    const replay = await ui.sendArtifactReviewAttempt(core, attempt)
    assert.equal(replay.state, 'completed')
    assert.equal(replay.receipt.replayed, true,
      'repeating a frozen attempt must replay, not create a second Owner Review')
    const after = await core.request('loom.candidates.list', { missionId })
    const reviewsAfter = await core.request('loom.reviews.list', { missionId })
    assert.equal(reviewsAfter.length, 1)
    assert.equal(after.find(c => c.taskId === workers[0].taskId).acceptanceStatus, 'accepted')
    assert.equal(after.find(c => c.taskId === workers[1].taskId).acceptanceStatus, 'pending')
    const reviewedBundle = { ...workBundle, candidates: after, reviews: reviewsAfter }
    assert.equal(ui.artifactCandidateFacts(reviewedBundle, firstArtifact, firstCandidate).reviewable, false)
    assert.equal((await core.request('loom.tasks.list', { missionId }))
      .find(t => t.taskId === workers[1].taskId).status, 'in_review')
    await stopCoreOrFail(core, 'after explicit fixture review, before second Core recovery')
    core = null
    core = startIsolatedCore({ dataDir, skillRoot, mcpPath, binaryPath: binary, environment: env })
    await core.ready
    await core.settled()
    assert.equal((await core.request('loom.reviews.list', { missionId })).length, 1)
    const persisted = await core.request('loom.candidates.list', { missionId })
    assert.equal(persisted.find(c => c.taskId === workers[0].taskId).acceptanceStatus, 'accepted')
    assert.equal(persisted.find(c => c.taskId === workers[1].taskId).acceptanceStatus, 'pending')
    assert.deepEqual(await ui.readArtifactPreview(core, missionId, firstArtifact.artifactId),
      { status: 'ready', text: workers[0].text })
    assert.deepEqual(await ui.readArtifactPreview(core, missionId, secondArtifact.artifactId),
      { status: 'ready', text: workers[1].text })
    console.log(JSON.stringify({
      scope: 'E3-one-Core-two-real-guarded-Pi-and-production-Mikka-review-service',
      mockProvider: true, realExternalProvider: false, humanClickedUi: false,
      realPiToolWrites: 2, coreArtifactHashesVerified: 2,
      explicitFixtureReview: true, hostReviewerId: 'local_user',
      reviewRowsAfterSameCommandReplay: 1, accepted: 1, pending: 1,
      sameSqliteRecoveredAfterReview: true, E4: 'NOT_VERIFIED',
      E5: 'NOT_RUN', E6: 'NOT_VERIFIED', E7: 'NOT_RUN'
    }))
  }finally{
    await Promise.all(providers.map(p=>p.close()))
    if(oldKey===undefined)delete process.env[WORKER_KEY];else process.env[WORKER_KEY]=oldKey
    if(core){
      try { await stopCoreOrFail(core,'after guarded two-worker E3') }
      catch(error){preserve=true;throw error}
    }
    if(!preserve){
      if(dataDir)await removeEphemeralRuntimeCampFilesRoot(dataDir,{temporaryDirectory:fixture,homeDirectory:home})
      await rm(fixture,{recursive:true,force:true})
    }
  }
})

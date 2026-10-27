import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { startQualificationCore, processTable, descendantsOf, waitForProcessIdentitiesToExit } from './qualification-core.mjs'
import { composerDocumentForAddress } from './create-configured-camp.mjs'

export const repository = resolve(import.meta.dirname, '../..')
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
export const digest = data => createHash('sha256').update(data).digest('hex')
export const shellQuote = text => `'${text.replaceAll('\\', '/').replaceAll("'", "''")}'`

export async function createMinimaxFixture({ native, nativeScript, phase, traceProvider=false, contextLimit }) {
  assert.equal(process.platform, 'win32', 'This records Windows target-host evidence only')
  for (const path of [native, nativeScript]) assert.ok(path && isAbsolute(path))
  const coreExecutable = process.env.ROVAI_QUALIFICATION_CORE_BIN ?? join(repository, 'target/debug/rovai-core.exe')
  const apiKey = process.env.ROVAI_MINIMAX_LIVE_API_KEY
  const baseURL = process.env.ROVAI_MINIMAX_LIVE_BASE_URL
  const model = process.env.ROVAI_MINIMAX_LIVE_MODEL
  assert.ok(apiKey && baseURL && model, 'Supply explicit isolated BYOK endpoint, model and API key environment')
  const root = await mkdtemp(join(tmpdir(), `rovai-minimax-win-${phase}-`))
  const formal = JSON.parse(execFileSync(coreExecutable, ['--prepare-windows-data-root', join(root, 'formal')], { encoding: 'utf8', windowsHide: true }))
  const data = formal.core, nativeData = join(formal.root, 'Native'), project = join(root, 'project')
  await mkdir(nativeData); await mkdir(project)
  await writeFile(join(project, 'README.md'), '# Isolated MiniMax Windows acceptance\n')
  execFileSync('git', ['init', '-b', 'main'], { cwd: project, stdio: 'ignore', windowsHide: true })
  execFileSync('git', ['-c', 'user.name=Runtime acceptance', '-c', 'user.email=runtime@rovai.local', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: project, stdio: 'ignore', windowsHide: true })
  const safe = value => JSON.stringify(value, null, 2).replaceAll(apiKey, '[REDACTED]')
  const environment = { ...process.env, MINIMAX_DATA_DIR: nativeData, MAVIS_DATA_DIR: nativeData, ROVAI_MINIMAX_CODE_BIN: native }
  for (const key of Object.keys(environment)) if (/API_KEY|AUTH_TOKEN|ACCESS_TOKEN/.test(key)) delete environment[key]
  const report = { schemaVersion: 1, evidenceKind: 'real-model-production-core', phase, startedAt: new Date().toISOString(), platform: 'windows-x64', root,
    coreSha256: digest(await readFile(coreExecutable)), nativeScriptSha256: digest(await readFile(nativeScript)), baseURL, model, cases: [], status: 'running' }
  let proxy=null, providerFault=null, providerPause=null
  const requests=[]
  let providerURL=baseURL
  if(traceProvider){
    proxy=createServer(async(req,res)=>{
      try{
        let raw='';for await(const part of req)raw+=part
        const body=raw?JSON.parse(raw):null
        const messages=body?.input??body?.messages??[]
        const system=[body?.instructions??'',...(Array.isArray(messages)?messages.filter(m=>['system','developer'].includes(m.role)).map(m=>JSON.stringify(m.content)):[])].join('\n')
        const entry={at:new Date().toISOString(),body,systemDigest:digest(system),charterCount:system.split('[SESSION_CHARTER]').length-1}
        requests.push(entry)
        if(providerPause?.predicate(entry)){const pause=providerPause;providerPause=null;entry.held=true;pause.entered(entry);res.once('close',pause.release);await pause.wait;if(res.destroyed)return}
        if(providerFault){const fault={...providerFault};if(--providerFault.remaining<=0)providerFault=null;entry.injectedFault=fault;res.writeHead(fault.status,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:fault.message,type:fault.type??'invalid_request_error',code:fault.code}}));return}
        const upstream=await fetch(baseURL.replace(/\/$/,'')+(req.url??'').replace(/^\/v1/,''),{method:req.method,headers:{'content-type':'application/json',authorization:`Bearer ${apiKey}`,'accept-encoding':'identity'},...(raw?{body:raw}:{})})
        entry.status=upstream.status
        res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'})
        for await(const chunk of upstream.body)res.write(chunk)
        res.end()
      }catch(e){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Qualification proxy transport failure'}}));report.proxyError=e.message}
    })
    await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));providerURL=`http://127.0.0.1:${proxy.address().port}/v1`
  }
  let core = null, db = null, events = []
  async function nativeCommand(args, auth = false) {
    const child = spawn(process.execPath, [nativeScript, ...args], { cwd: project, env: { ...environment, ...(auth ? { MCODE_ACCEPTANCE_KEY: apiKey } : {}) }, windowsHide: true, stdio: ['ignore','pipe','pipe'] })
    let output = ''; child.stdout.on('data', x => { output += x }); child.stderr.on('data', x => { output += x })
    const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
    assert.equal(code, 0, output.replaceAll(apiKey, '[REDACTED]').slice(-3000)); return output
  }
  report.nativeVersion = (await nativeCommand(['--version'])).trim()
  await nativeCommand(['provider','add','--name','windows-qualification','--base-url',providerURL,'--api-format','openai-responses','--model',model,'--support-image',...(contextLimit?['--context-limit',String(contextLimit)]:[]),'--api-key-env','MCODE_ACCEPTANCE_KEY','--use'], true)
  console.error(JSON.stringify({ phase, channel: 'automatic acceptance', root, data, skills: join(data,'managed-skill-library'), nativeData, project }))
  const fixture = { root, data, project, nativeData, environment, report, coreExecutable, nativeCommand, providerURL,
    requests, failNextRequest(fault){providerFault={...fault,remaining:fault.count??1}},clearFault(){providerFault=null},
    pauseNextRequest(predicate=()=>true){let entered,release;const reached=new Promise(r=>{entered=r}),wait=new Promise(r=>{release=r});providerPause={entered,release,wait,predicate};return{reached,release}},
    get core() { return core }, get db() { return db }, get events() { return events },
    async checkpoint(name, detail = {}) { report.cases.push({ name, status:'passed', ...detail }); await writeFile(join(root,'report.json'), safe(report)); console.error('PASS', name) },
    async start() {
      core = startQualificationCore({ coreExecutable, dataDirectory:data, workingDirectory:project, runtimeCacheDirectory:join(root,'cache'), mcpConfigPath:join(data,'mcp.json'), environmentOverrides:environment, onNotification:event=>events.push(event) })
      await core.request('health.check')
      if (!db) db = new DatabaseSync(join(data,'rovai.sqlite'), { readOnly: true })
      return core
    },
    async configure() {
      const startup = await core.request('runtime.startup.get', {runtimeKind:'minimax-code-cli'})
      await core.request('runtime.startup.save', {runtimeKind:'minimax-code-cli',expectedRevision:startup.revision,configuration:{programPath:native,environment:[]}})
      report.catalog = await core.request('runtime.modelCatalog.open', {runtimeKind:'minimax-code-cli',waitForRefresh:true},120000)
      const installation = (await core.request('runtime.installations.list')).find(i=>i.adapterKind==='minimax-code-cli')
      assert.equal(installation?.snapshot?.probeStatus,'ready',JSON.stringify(installation))
      assert.ok(installation.memberRuntimeDefaults)
      const member=await core.request('members.get',{agentId:'agent_2'})
      const result=await core.request('members.runtime.set',{commandId:randomUUID(),command:{agentId:'agent_2',expectedVersion:member.version,adapterKind:'minimax-code-cli',...installation.memberRuntimeDefaults}})
      assert.equal(result.status,'applied',JSON.stringify(result)); report.installation={version:installation.snapshot.reportedVersion,model:installation.memberRuntimeDefaults.model,permissions:installation.memberRuntimeDefaults.permissions}
      await fixture.checkpoint('native model catalog and member configuration')
    },
    async create(name,agentId='agent_2') {
      const result=await core.request('threads.create',{commandId:randomUUID(),name,workspace:{projectPath:project},memberAgentIds:[agentId],defaultLeadAgentId:agentId,collaborationMode:'peer'})
      assert.equal(result.status,'applied',JSON.stringify(result));return result.payload.threadId
    },
    runs(threadId) { return db.prepare('SELECT id,status,version,execution_epoch,last_error_code,public_runtime_failure_json FROM agent_run WHERE camp_id=? ORDER BY created_at,id').all(threadId) },
    binding(threadId) { return db.prepare('SELECT native_binding_id,native_session_id FROM conversation WHERE camp_id=? AND agent_id=?').get(threadId,'agent_2') },
    published(runId) { return db.prepare("SELECT id,body FROM camp_message WHERE source_agent_run_id=? AND author_type='agent' ORDER BY created_at").all(runId) },
    async send(threadId, text, mode='start', attachments=[], skills=[],agentId='agent_2') {
      const before=fixture.runs(threadId).length
      const content=composerDocumentForAddress({mode:'explicit',agentIds:[agentId]},text)
      content.segments.push(...skills.map(s=>({kind:'atom',atom:{type:'skill',skillId:s.id,nameAtSend:s.name}})))
      const result=await core.request('thread.messages.send',{commandId:randomUUID(),threadId,content,sourceAttachments:attachments,quotes:[],replyToThreadMessageId:null,deliveryMode:mode,steerTargets:fixture.runs(threadId).filter(r=>r.status==='running').map(r=>({agentRunId:r.id,executionEpoch:r.execution_epoch})),execution:{taskId:null,purpose:'Isolated Windows MiniMax qualification',completionRole:'required'}})
      assert.equal(result.commandResult.status,'accepted',JSON.stringify(result));return {threadId,before,messageId:result.commandResult.payload.threadMessageId}
    },
    async wait(predicate, label, timeout=240000) {
      const deadline=Date.now()+timeout
      while(Date.now()<deadline){const value=await predicate();if(value)return value;await delay(200)}
      throw new Error('Timeout: '+label)
    },
    async finish(sent, {allowFailure=false,onTick}={}) {
      return await fixture.wait(async()=>{
        if(onTick)await onTick()
        const runs=fixture.runs(sent.threadId);if(runs.length<=sent.before)return false
        const run=runs.at(-1);if(!['succeeded','failed','cancelled'].includes(run.status))return false
        if(!allowFailure)assert.equal(run.status,'succeeded',JSON.stringify(run));return run
      },'terminal Run')
    },
    async owned() { const table=await processTable();const ids=new Set(descendantsOf(table,core.pid));return table.filter(p=>ids.has(p.pid)) },
    async stop(label='Core stop', crash=false) {
      if(!core)return
      const owned=await fixture.owned(); const current=core; core=null
      if(crash)process.kill(current.pid,'SIGKILL')
      const exit=await current.stop()
      const remaining=await waitForProcessIdentitiesToExit(owned,30000)
      assert.deepEqual(remaining,[],label+': remaining Runtime descendants')
      report.cases.push({name:label,status:'passed',corePid:current.pid,descendantsReaped:owned.length,exit})
    },
    async close(error) {
      report.status=error?'failed':'passed'; if(error)report.error=error.stack??String(error)
      try{await fixture.stop()}catch(stopError){report.status='failed';report.cleanupError=stopError.message}
      if(db){db.close();db=null}
      try{await nativeCommand(['provider','remove','custom_provider:windows-qualification','--yes']);report.temporaryCredentialRemoved=true}catch(e){report.temporaryCredentialRemoved=false;report.cleanupError=e.message}
      if(proxy)await new Promise(resolve=>proxy.close(resolve))
      if(traceProvider)await writeFile(join(root,'model-requests.json'),safe(requests))
      await writeFile(join(root,'events.json'),safe(events));await writeFile(join(root,'report.json'),safe(report))
      console.log(safe({root,status:report.status,cases:report.cases.map(({exit,...rest})=>rest),error:report.error,cleanupError:report.cleanupError}))
      if(report.status!=='passed')process.exitCode=1
    }
  }
  return fixture
}

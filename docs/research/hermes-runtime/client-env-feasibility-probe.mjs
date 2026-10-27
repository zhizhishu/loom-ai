// Disposable feasibility probe. Patched native/Core sources, not release qualification.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
// Usage: node <script> <prepared-sandbox-root> <Rovai-source> <dependency-Home>
const [sandbox, source, dependencyHome] = process.argv.slice(2)
assert([sandbox,source,dependencyHome].every(p=>p&&isAbsolute(p)))
const root=resolve(sandbox), repository=resolve(source)
const {startQualificationCore}=await import(pathToFileURL(join(repository,'scripts/lib/qualification-core.mjs')))
const {createConfiguredCampAndSend,composerDocumentForAddress}=await import(pathToFileURL(join(repository,'scripts/lib/create-configured-camp.mjs')))
const fixture=join(root,'case-'+Date.now()), nativeHome=join(fixture,'.hermes'), project=join(fixture,'project'), data=join(fixture,'data')
await mkdir(nativeHome,{recursive:true,mode:0o700});await mkdir(project)
await symlink(join(dependencyHome,'installs'),join(nativeHome,'installs'))
await writeFile(join(fixture,'mcp.json'),'{}')
const sh=s=>"'"+s.replaceAll("'","'\\''")+"'", wire=[], calls=new Map(), reports=[]
let core,gateway,database,wireError,gatewayStderr=''
const message=text=>({id:crypto.randomUUID(),type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]})
const server=createServer(async(req,res)=>{
 try{
  if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({object:'list',data:[{id:'env-probe',object:'model'}]}));return}
  const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString());wire.push(body)
  if(!Array.isArray(body.input)){res.writeHead(200,{'content-type':'application/json'});res.end('{}');return}
  const label=[...JSON.stringify(body.input).matchAll(/ENV_PROBE:([AB][01])/g)].at(-1)?.[1]
  const n=(calls.get(label)??0)+1;calls.set(label,n)
  let item=message('Completed.')
  if(label&&n===1){
   let command=`rovai --version > ${sh(join(fixture,label+'.version'))}; printf '%s' "$ROVAI_CLI_CONTEXT" > ${sh(join(fixture,label+'.path'))}; cp "$ROVAI_CLI_CONTEXT" ${sh(join(fixture,label+'.saved.json'))}; rovai send --public-only --body ENV_OK_${label}`
   if(label==='A0')command+=`; python3 -c ${sh(`import subprocess; subprocess.Popen(['python3',${JSON.stringify(join(fixture,'late.py'))}],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)` )}`
   if(label==='A1')command+=`; touch ${sh(join(fixture,'release-old'))}; python3 -c ${sh(`import pathlib,time; p=pathlib.Path(${JSON.stringify(join(fixture,'late.json'))}); end=time.time()+15\nwhile not p.exists() and time.time()<end: time.sleep(.05)\nassert p.exists()` )}`
   item={id:crypto.randomUUID(),type:'function_call',call_id:crypto.randomUUID(),name:'terminal',arguments:JSON.stringify({command}),status:'completed'}
  }
  const id='response-'+crypto.randomUUID(),output={id,object:'response',status:'completed',output:[item],usage:{input_tokens:100,output_tokens:10,total_tokens:110}}
  if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(output));return}
  res.writeHead(200,{'content-type':'text/event-stream'});let sequence=0;const emit=e=>res.write('data: '+JSON.stringify({...e,sequence_number:sequence++})+'\n\n')
  emit({type:'response.created',response:{id,status:'in_progress',output:[]}});emit({type:'response.output_item.added',output_index:0,item})
  if(item.type==='message')emit({type:'response.output_text.delta',output_index:0,content_index:0,item_id:item.id,delta:item.content[0].text})
  emit({type:'response.output_item.done',output_index:0,item});emit({type:'response.completed',response:output});res.end()
 }catch(e){wireError=e;res.writeHead(500);res.end()}
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const config={model:{provider:'fixture',default:'env-probe'},providers:{fixture:{base_url:`http://127.0.0.1:${server.address().port}/v1`,api_key_env:'HERMES_NATIVE_PROBE_KEY',transport:'codex_responses',models:['env-probe']}},updates:{check:false},platform_toolsets:{acp:['terminal','no_mcp']},agent:{max_turns:5},session_title:{enabled:false},compression:{enabled:false}}
await writeFile(join(nativeHome,'config.yaml'),JSON.stringify(config));await writeFile(join(nativeHome,'.env'),'PROBE_CONFIG_SENTINEL=unchanged\n')
await writeFile(join(fixture,'late.py'),`import pathlib,time,os,json,subprocess\np=pathlib.Path(${JSON.stringify(fixture)})\nend=time.time()+240\nwhile not (p/'release-old').exists() and time.time()<end: time.sleep(.05)\nif not (p/'release-old').exists(): raise SystemExit(2)\nresults=[]\nfor path in [os.environ.get('ROVAI_CLI_CONTEXT'),str(p/'A0.saved.json')]:\n env=dict(os.environ,ROVAI_CLI_CONTEXT=path)\n r=subprocess.run(['rovai','send','--public-only','--body','STALE_SHOULD_NOT_SEND'],env=env,capture_output=True,text=True)\n results.append(dict(code=r.returncode,output=r.stdout,stderr=r.stderr,context=path))\n(p/'late.json').write_text(json.dumps(results))\n`)
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex'), before={config:await hash(join(nativeHome,'config.yaml')),dotenv:await hash(join(nativeHome,'.env'))}
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('ROVAI_')&&!k.startsWith('HERMES_')))
Object.assign(env,{HERMES_HOME:nativeHome,HERMES_DISABLE_LAZY_INSTALLS:'1',HERMES_NATIVE_PROBE_KEY:'loopback-only',PATH:'/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'})
async function until(fn,ms=120000){const end=Date.now()+ms;while(Date.now()<end){if(wireError)throw wireError;const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,100))}throw Error('Probe timeout')}
const sql=(q,...a)=>database.prepare(q).get(...a), exists=async p=>{try{await readFile(p);return true}catch{return false}}
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}}
console.log(JSON.stringify({fixture,data,skillLibrary:join(data,'managed-skill-library'),nativeHome,project}))
try{
 gateway=spawn(join(root,'hermes-dev'),['--profile','default','gateway','run','--quiet'],{cwd:project,env,detached:true,stdio:['ignore','pipe','pipe']});gateway.stderr.on('data',d=>gatewayStderr+=d)
 gateway.stdout.on('data',()=>{})
 await until(()=>{if(gateway.exitCode!==null)throw Error(gatewayStderr);return exists(join(nativeHome,'gateway.lock'))})
 core=startQualificationCore({coreExecutable:join(root,'rovai-core'),dataDirectory:data,workingDirectory:repository,runtimeCacheDirectory:join(fixture,'cache'),mcpConfigPath:join(fixture,'mcp.json'),environmentOverrides:{...Object.fromEntries(Object.keys(process.env).filter(k=>k.startsWith('ROVAI_')||k.startsWith('HERMES_')).map(k=>[k,undefined])),...env,ROVAI_HERMES_BIN:join(root,'hermes-dev'),ROVAI_CLI_BIN:join(root,'rovai')}})
 await core.request('health.check')
 await until(async()=>!(await core.request('runtime.status.get')).runtimeAvailability.some(r=>r.runtimeKind==='hermes-cli'&&r.discovery.discoveryStatus==='detecting'))
 await core.request('runtime.startup.save',{runtimeKind:'hermes-cli',configuration:{programPath:join(root,'hermes-dev'),environment:[]},expectedRevision:0})
 const check=await core.request('runtime.product.check',{runtimeKind:'hermes-cli'});assert(check.ready,JSON.stringify(check))
 const installation=await until(async()=>{const r=(await core.request('runtime.installations.list')).find(r=>r.adapterKind==='hermes-cli'&&r.installationClass==='managed_default');if(['probe_failed','missing_capabilities'].includes(r?.snapshot?.probeStatus))throw Error(JSON.stringify(r.snapshot));return r?.snapshot?.probeStatus==='ready'&&r})
 for(const agentId of ['agent_2','agent_3']){const member=await core.request('members.get',{agentId});assert.equal((await core.request('members.runtime.set',{commandId:crypto.randomUUID(),command:{agentId,expectedVersion:member.version,adapterKind:'hermes-cli',model:installation.memberRuntimeDefaults.model,permissions:installation.memberRuntimeDefaults.permissions}})).status,'applied')}
 database=new DatabaseSync(join(data,'rovai.sqlite'),{readOnly:true})
 const threads={},sessions={}
 for(const round of [0,1]){
  await Promise.all(['A','B'].map(async name=>{
   const agentId=name==='A'?'agent_2':'agent_3',label=name+round,body=`ENV_PROBE:${label} Execute the controlled fixture task.`
   if(round===0){const sent=await createConfiguredCampAndSend(core.request,{commandId:crypto.randomUUID(),name:'Environment identity '+name,purpose:'Isolated native environment feasibility',body,memberAgentIds:[agentId],defaultLeadAgentId:agentId,workspace:{projectPath:project}});threads[name]=sent.payload.threadId}
   else await core.request('thread.messages.send',{commandId:crypto.randomUUID(),threadId:threads[name],content:composerDocumentForAddress({mode:'explicit',agentIds:[agentId]},body),sourceAttachments:[],quotes:[],replyToThreadMessageId:null,deliveryMode:'start',execution:{taskId:null,purpose:'Lease rotation',completionRole:'required'}})
   const run=await until(async()=>{const r=sql('SELECT id,status,public_runtime_failure_json AS failure FROM agent_run WHERE camp_id=? ORDER BY rowid DESC LIMIT 1',threads[name]);if(r?.status==='waiting'){const snapshot=await core.request('threads.snapshot',{threadId:threads[name]});for(const a of snapshot.approvals.filter(v=>v.status==='pending')){const option=a.options.find(v=>v.kind==='allow_once');assert(option);await core.request('action.approvals.resolve',{commandId:crypto.randomUUID(),threadId:threads[name],approvalId:a.id,expectedVersion:a.version,optionId:option.optionId,reason:'Isolated controlled environment probe'})}}return r&&['succeeded','failed','cancelled'].includes(r.status)&&!reports.some(v=>v.run===r.id)&&r})
   if(run.status!=='succeeded')throw Error(JSON.stringify({label,run}))
   const publication=sql("SELECT * FROM camp_message WHERE camp_id=? AND author_type='agent' AND body=?",threads[name],'ENV_OK_'+label)
   assert(publication,`${label} missing public send`);assert.equal(publication.author_id,agentId);assert.equal(publication.source_agent_run_id,run.id)
   const native=sql('SELECT native_session_id FROM conversation WHERE camp_id=? AND agent_id=?',threads[name],agentId).native_session_id
   if(round===0)sessions[name]=native;else assert.equal(native,sessions[name])
   reports.push({label,run:run.id,agentId,thread:threads[name],nativeSessionId:native,messageId:publication.id,version:(await readFile(join(fixture,label+'.version'),'utf8')).trim(),contextPath:await readFile(join(fixture,label+'.path'),'utf8')})
  }))
 }
 assert.notEqual(sessions.A,sessions.B)
 assert.notEqual(reports.find(r=>r.label==='A0').contextPath,reports.find(r=>r.label==='A1').contextPath)
 const late=JSON.parse(await readFile(join(fixture,'late.json'),'utf8'));assert(late.every(v=>v.code!==0&&v.output.includes('builtin_tool.cli_error')))
 assert.equal(sql("SELECT COUNT(*) AS n FROM camp_message WHERE body='STALE_SHOULD_NOT_SEND'").n,0)
 assert.equal(before.config,await hash(join(nativeHome,'config.yaml')));assert.equal(before.dotenv,await hash(join(nativeHome,'.env')))
 assert(alive(gateway.pid));await core.stop();core=null;assert(alive(gateway.pid))
 await writeFile(join(fixture,'report.json'),JSON.stringify({reports,late,gatewaySurvivedCoreShutdown:true,configUnchanged:true,dotenvUnchanged:true},null,2))
 console.log(JSON.stringify({checks:'PASS',runs:reports.map(({contextPath,...r})=>r),oldExecutionDenied:late.map(v=>v.code),fixture},null,2))
}catch(e){await writeFile(join(fixture,'failure.json'),JSON.stringify({error:String(e),reports,gatewayStderr},null,2));throw e}
finally{if(core)await core.stop().catch(()=>{});database?.close();if(gateway&&alive(gateway.pid))gateway.kill('SIGTERM');server.closeAllConnections();await new Promise(r=>server.close(r));await writeFile(join(fixture,'wire.json'),JSON.stringify(wire));await writeFile(join(fixture,'gateway.log'),gatewayStderr);console.log('Evidence:',fixture)}

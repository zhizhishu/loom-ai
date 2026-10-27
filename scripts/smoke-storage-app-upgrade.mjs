// Uses the existing exact-evidence owner's synthetic schema-149 export and the
// existing CDP acceptance helper. Only the explicit temporary fixture is touched.
// Fixture: ROVAI_STORAGE_UPGRADE_FIXTURE=/absolute/temp/root cargo test -p rovai-core
// --features extended-tests --lib file_preview_authority::tests::run_activity_file_uses_the_exact_evidence_and_mission_worktree -- --exact
// Run: node scripts/smoke-storage-app-upgrade.mjs /absolute/temp/root /absolute/Rovai\ AI.app
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir,readFile,writeFile,chmod,copyFile,readdir } from 'node:fs/promises'
import { isAbsolute,join,resolve,relative } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { launchAcceptanceBrowser } from './lib/host-web-browser.mjs'
import { assertUserDataIsIsolated,seedCompletedOnboardingForAcceptance } from './lib/dev-desktop.mjs'
import { composerDocumentForAddress } from './lib/create-configured-camp.mjs'

const root=resolve(process.argv[2]??'')
assert.ok(process.argv[2] && isAbsolute(process.argv[2]))
assert.ok(!relative('/private/tmp',root).startsWith('..') || !relative(tmpdir(),root).startsWith('..'),'fixture must be temporary')
const fixture=JSON.parse(await readFile(join(root,'fixture.json'),'utf8'))
const userData=assertUserDataIsIsolated(join(root,'user-data'))
const app=resolve(process.argv[3]??'dist/mac-arm64/Rovai AI.app')
const query=(sql,...args)=>{const c=new DatabaseSync(join(userData,'rovai.sqlite'),{readOnly:true});try{return c.prepare(sql).all(...args)}finally{c.close()}}
assert.equal(query('SELECT projection_schema_version AS version FROM rovai_data_contract')[0].version,149,'start from the exported old schema')
const oldDigest=()=>createHash('sha256').update(JSON.stringify(query(`SELECT id,payload_preview_json,input_preview_json,result_preview_json,content_blob_id,input_blob_id,result_blob_id FROM agent_run_execution_evidence WHERE agent_run_id=? ORDER BY id`,fixture.runId))).digest('hex')
const beforeDigest=oldDigest()
await copyFile(join(userData,'rovai.sqlite'),join(root,'source-schema149.sqlite'))
seedCompletedOnboardingForAcceptance(userData)
await mkdir(join(userData,'managed-skill-library'),{recursive:true})
await writeFile(join(userData,'mcp.json'),'{}')
const stub=join(root,'synthetic-codex')
await writeFile(stub,`#!/usr/bin/python3
import json, sys, uuid, os
if '--version' in sys.argv:
 print('codex-cli 0.141.0');sys.exit(0)
def emit(x): print(json.dumps(x),flush=True)
sid=str(uuid.uuid4())
for line in sys.stdin:
 q=json.loads(line)
 if 'id' not in q: continue
 m=q['method'];r={}
 if m=='account/read':r={'account':None,'requiresOpenaiAuth':False}
 elif m=='config/read':r={'config':{'mcp_servers':{}}}
 elif m in ('thread/start','thread/resume'):
  sid=q.get('params',{}).get('threadId',sid);r={'thread':{'id':sid}}
 elif m=='turn/start':r={'turn':{'id':str(uuid.uuid4())}}
 emit({'id':q['id'],'result':r})
 if m=='turn/start':
  tid=r['turn']['id'];op=str(uuid.uuid4())
  with open(${JSON.stringify(join(root,'synthetic-inputs.jsonl'))},'a') as f:f.write(json.dumps(q)+'\\n')
  cmd={'id':op,'type':'commandExecution','command':'fixture storage output','status':'inProgress','aggregatedOutput':''}
  emit({'method':'item/started','params':{'threadId':sid,'turnId':tid,'item':cmd}})
  for n in range(40):
   emit({'method':'item/commandExecution/outputDelta','params':{'threadId':sid,'turnId':tid,'itemId':op,'delta':'x'*512}})
  cmd.update(status='completed',exitCode=0,aggregatedOutput='x'*20480+'DROPPED_STORAGE_SUFFIX')
  emit({'method':'item/completed','params':{'threadId':sid,'turnId':tid,'item':cmd}})
  path=os.path.join(os.getcwd(),'new-storage-file.txt')
  with open(path,'w') as f:f.write('new storage file\\n')
  change={'id':str(uuid.uuid4()),'type':'fileChange','status':'completed','changes':[{'path':path,'kind':{'type':'add'},'diff':'new storage file\\n'}]}
  emit({'method':'item/completed','params':{'threadId':sid,'turnId':tid,'item':change}})
  emit({'method':'turn/completed','params':{'threadId':sid,'turn':{'id':tid,'status':'completed','items':[{'type':'agentMessage','text':'storage upgrade fixture complete'}]}}})
`)
await chmod(stub,0o700)
async function assertNoStoredSuffix(directory) {
 let count=0
 for (const entry of await readdir(directory,{withFileTypes:true})) {
  const path=join(directory,entry.name)
  if(entry.isDirectory()) count+=await assertNoStoredSuffix(path)
  else if(entry.isFile()) {assert.ok(!(await readFile(path)).includes(Buffer.from('DROPPED_STORAGE_SUFFIX')),`clipped output persisted in ${entry.name}`);count++}
 }
 return count
}
const evidence=[]
let browser
const start=async()=>{
 console.error(`隔离打包验收：userData=${userData}; Skill Library=${join(userData,'managed-skill-library')}; App=${app}`)
 const began=performance.now()
 browser=await launchAcceptanceBrowser({executable:join(app,'Contents/MacOS/Rovai AI'),args:['--remote-debugging-port=0',`--user-data-dir=${userData}`],env:{...process.env,ROVAI_ALLOW_ISOLATED_INSTANCE:'1',ROVAI_DISABLE_AUTO_UPDATE_CHECKS:'1',ROVAI_CODEX_BIN:stub}})
 // This fixture sends one input through the real bridge. Ignore physical input
 // in this acceptance page so typing in another task cannot add an unrelated Run.
 await browser.send('Input.setIgnoreInputEvents',{ignore:true})
 await browser.wait(`Boolean(window.rovai && document.querySelector('.app-shell'))`,45000)
 await browser.wait(`window.rovai.request('health.check',{}).then(x=>Boolean(x)).catch(()=>false)`,45000)
 console.error('Core ready; checking upgraded history')
 evidence.push({stage:'startup',ms:performance.now()-began,schema:query('SELECT projection_schema_version AS version FROM rovai_data_contract')[0].version})
 assert.equal(evidence.at(-1).schema,154)
 const selector=`document.querySelector('[data-sidebar-menu-target="thread:${fixture.campId}"]')?.closest('.camp-nav-row')?.querySelector('.camp-nav-open')`
 await browser.wait(`Boolean(${selector})`,30000)
 // The sidebar can paint before startup finishes restoring its route. Core health
 // alone is not the interaction-ready boundary; wait for navigation to be enabled.
 await browser.wait(`Boolean(document.querySelector('.navigation-collapse-button:not(:disabled)')) && !document.querySelector('[data-startup-status]')`,45000)
 // This smoke owns storage/UI routing, not native Electron/CDP pointer coordinates.
 // Invoke the exact Renderer button so title-bar/device-metric offsets cannot select a neighbour.
 await browser.evaluate(`(${selector}).click()`)
 await browser.wait(`Boolean(document.querySelector('.camp-workspace'))`,30000)
 await browser.wait(`document.body.innerText.includes('Old message 59')`,30000)
}
const request=(method,params={})=>browser.evaluate(`window.rovai.request(${JSON.stringify(method)},${JSON.stringify(params)}).catch(e=>{throw new Error(JSON.stringify(e))})`)
const openFile=async(runId,id,path,expected,epoch=1)=>{
 await browser.evaluate(`window.rovai.filePreview.bindThread(${JSON.stringify(fixture.campId)})`)
 const opened=await browser.evaluate(`window.rovai.filePreview.open(${JSON.stringify({kind:'run_activity_file',threadId:fixture.campId,agentRunId:runId,executionEpoch:epoch,evidenceId:id,rawReference:path})})`)
 assert.equal(opened.ok,true,JSON.stringify(opened));assert.equal(opened.value.kind,'file_preview')
 const file=opened.value.file
 const text=await browser.evaluate(`window.rovai.filePreview.readText(${JSON.stringify({handleId:file.handleId,expectedGeneration:file.contentGeneration})})`)
 assert.equal(text.ok,true);assert.equal(text.value.text,expected)
 evidence.push({stage:'file-preview',runId,path,displayPath:file.displayPath})
}
const checkOld=async()=>{
 assert.equal(oldDigest(),beforeDigest,'old operation bodies/Blob identities must remain byte-identical')
 const page=await request('agentRunExecution.page',{threadId:fixture.campId,agentRunId:fixture.runId,limit:12})
 assert.equal(page.evidence.length,12);assert.equal(page.hasMore,true)
 const next=await request('agentRunExecution.page',{threadId:fixture.campId,agentRunId:fixture.runId,limit:12,beforeSequence:page.nextBeforeSequence})
 assert.equal(next.evidence.length,12);assert.ok(!next.evidence.some(e=>page.evidence.some(p=>p.id===e.id)))
 const blocks=await request('agentRunExecution.page',{threadId:fixture.campId,agentRunId:fixture.runId,projection:'blocks',limit:12})
 const group=blocks.blocks.find(b=>b.kind==='toolGroup')
 assert.ok(group,JSON.stringify(blocks).slice(0,1000));assert.equal(group.toolCount,512)
 const expanded=await request('agentRunExecution.page',{threadId:fixture.campId,agentRunId:fixture.runId,groupSequence:group.sequence,limit:12})
 assert.equal(expanded.evidence.length,12);assert.equal(expanded.hasMore,true)
 const full=await request('agentRunEvidence.getContent',{threadId:fixture.campId,evidenceId:fixture.evidenceId})
 assert.ok(JSON.stringify(full).length>60000)
 await openFile(fixture.runId,fixture.evidenceId,fixture.filePath,'selected file\n')
 console.error('Old operation pages, group and file passed')
 evidence.push({stage:'old-history',rows:512,pages:[page.evidence.length,next.evidence.length],groupCount:group.toolCount})
}
try {
 await start();await checkOld();await browser.capture(join(root,'upgraded-old-history.png'))
 // Explicit product configuration wins over discovery and inherited Host env.
 // Assert the selected executable before sending any business input.
 const startup=await request('runtime.startup.get',{runtimeKind:'codex-cli'})
 await request('runtime.startup.save',{runtimeKind:'codex-cli',expectedRevision:startup.revision,configuration:{programPath:stub,environment:[]}})
 await request('runtime.discovery.rescan',{interactiveShell:false})
 await request('runtime.product.check',{runtimeKind:'codex-cli'})
 assert.equal(query("SELECT executable_path FROM adapter_installation WHERE adapter_kind='codex-cli' AND auth_scope='default' AND enabled=1 ORDER BY updated_at DESC LIMIT 1")[0]?.executable_path,stub,'never submit input to a discovered real model')
 const member=await request('members.get',{agentId:'agent_1'})
 const configured=await request('members.runtime.set',{commandId:crypto.randomUUID(),command:{agentId:'agent_1',expectedVersion:member.version,adapterKind:'codex-cli',model:{mode:'runtime_default'},permissions:{adapterKind:'codex-cli',schemaVersion:1,values:{sandbox_mode:'danger-full-access',approval_policy:'never'}}}})
 assert.equal(configured.status,'applied',JSON.stringify(configured))
 console.error('Old history/file checks passed; sending synthetic Run')
 const send=await request('thread.messages.send',{commandId:crypto.randomUUID(),threadId:fixture.campId,content:composerDocumentForAddress({mode:'default'},'STORAGE_UPGRADE_NEW_RUN'),sourceAttachments:[],quotes:[],replyToThreadMessageId:null,execution:{taskId:null,purpose:'Synthetic storage upgrade',completionRole:'required'}})
 assert.equal(send.commandResult.status,'accepted',JSON.stringify(send))
 const deadline=Date.now()+45000
 let run
 while(Date.now()<deadline){run=query("SELECT id,status,last_error_code,execution_epoch FROM agent_run WHERE id<>? AND COALESCE(camp_id,(SELECT camp_id FROM camp_turn WHERE camp_turn.id=agent_run.camp_turn_id))=? ORDER BY created_at DESC LIMIT 1",fixture.runId,fixture.campId)[0];if(run&&['succeeded','failed','cancelled'].includes(run.status))break;await new Promise(r=>setTimeout(r,100))}
 assert.equal(run?.status,'succeeded',JSON.stringify(run))
 const rows=query('SELECT id,storage_version,operation_id,phase,output_truncated,payload_preview_json,input_preview_json,result_preview_json,activity_meta_json,result_digest FROM agent_run_execution_evidence WHERE agent_run_id=?',run.id)
 const ops=rows.filter(row=>row.operation_id)
 assert.ok(ops.length>=2);assert.ok(ops.every(row=>row.storage_version===4 && row.payload_preview_json==='{}'))
 assert.equal(query('SELECT count(*) AS n FROM canonical_runtime_activity WHERE agent_run_id=?',run.id)[0].n,0)
 assert.equal(query('SELECT count(*) AS n FROM context_manifest_history_camp h JOIN context_manifest m ON m.id=h.context_manifest_id WHERE m.agent_run_id=?',run.id)[0].n,0)
 assert.ok(ops.some(row=>row.output_truncated===1))
 const command=ops.find(row=>JSON.parse(row.input_preview_json)?.item?.type==='commandExecution')
 assert.ok(command,'ordinary command must use the lifecycle record')
 assert.equal(ops.filter(row=>JSON.parse(row.input_preview_json)?.item?.type==='commandExecution').length,1,'40 progress events must maintain one command record')
 assert.equal(command.phase,'completed')
 const output=JSON.parse(command.result_preview_json)?.item?.aggregatedOutput
 assert.equal(typeof output,'string');assert.equal(Buffer.byteLength(output,'utf8'),7680)
 const scannedFiles=await assertNoStoredSuffix(userData)
 evidence.push({stage:'output-budget',savedOutputBytes:Buffer.byteLength(output,'utf8'),clippedSuffixFilesChecked:scannedFiles,clippedSuffixFound:false})
 const fileOp=ops.find(row=>JSON.parse(row.activity_meta_json).diffProjection?.status==='available')
 assert.ok(fileOp)
 assert.equal(JSON.parse(fileOp.result_preview_json)?.item?.changes?.[0]?.diff,undefined,'native diff body is represented once by runtimeDiff')
 const completeFile=await request('agentRunEvidence.getContent',{threadId:fixture.campId,evidenceId:fileOp.id})
 assert.ok(JSON.stringify(completeFile).includes('new storage file'))
 assert.equal(typeof command.result_digest,'string')
 assert.equal(JSON.parse(command.result_preview_json).resultDigest,undefined)
 const file=JSON.parse(fileOp.activity_meta_json).diffProjection.entries[0].path
 await openFile(run.id,fileOp.id,file,'new storage file\n',run.execution_epoch)
 await checkOld()
 evidence.push({stage:'new-write',runId:run.id,operations:ops.length,activityCopies:0,directoryCopies:0,truncated:true})
 await browser.capture(join(root,'mixed-history.png'))
 await browser.close();browser=null
 await start();await checkOld();await openFile(run.id,fileOp.id,file,'new storage file\n',run.execution_epoch)
 await browser.capture(join(root,'restarted-history.png'))
 assert.equal(oldDigest(),beforeDigest)
 assert.equal((await readFile(join(root,'synthetic-inputs.jsonl'),'utf8')).trim().split('\n').length,1,'restart must not replay received input')
 evidence.push({stage:'restart',oldBodyHashUnchanged:true,newOperationReadable:true,inputSubmissions:1})
 await writeFile(join(root,'app-upgrade-report.json'),JSON.stringify({ok:true,fixtureSchema:149,candidateSchema:154,oldBodyDigest:beforeDigest,evidence},null,2))
 console.log(JSON.stringify({ok:true,root,evidence}))
} catch(error) {
 if(browser) {
  await browser.capture(join(root,'failure.png')).catch(()=>{})
  console.error(await browser.evaluate('document.body.innerText').catch(()=>''))
 }
 throw error
} finally {await browser?.close()}

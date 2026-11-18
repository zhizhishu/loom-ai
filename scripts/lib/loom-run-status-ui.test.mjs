import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import test from 'node:test'
import react from '@vitejs/plugin-react'
import electron from 'electron'
import { build } from 'vite'
import { admitElectronIntegrationTest } from './electron-sandbox-capability.mjs'

test('LOOM native run surface has honest context and recoverable interactions',{timeout:150_000},async t=>{
 if(!admitElectronIntegrationTest(t))return
 const root=resolve(import.meta.dirname,'../..'),source=join(root,'scripts/fixtures/loom-run-status')
 const base=join(root,'_artifacts/loom-v2-user-authorized-20261115/ui');await mkdir(base,{recursive:true})
 const fixture=await mkdtemp(join(base,'run-'));const userData=join(fixture,'user-data'),output=join(fixture,'screenshots')
 let child,closed;let passed=false
 try{
  await mkdir(join(userData,'managed-skill-library'),{recursive:true})
  await build({configFile:false,root:source,base:'./',logLevel:'error',plugins:[react()],resolve:{alias:{'@contracts':join(root,'packages/contracts/src/index.ts')}},build:{outDir:join(fixture,'renderer'),minify:false}})
  const env={...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'};delete env.ELECTRON_RUN_AS_NODE
  child=spawn(electron,[join(source,'main.cjs'),join(fixture,'renderer/index.html'),userData,output,...(process.platform==='linux'?['--no-sandbox']:[])],{env,stdio:['ignore','pipe','pipe']});closed=once(child,'close')
  let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x)
  const timer=setTimeout(()=>child.kill(),120_000);let code;try{[code]=await closed}finally{clearTimeout(timer)}
  assert.equal(code,0,stdout+'\n'+stderr)
  const report=JSON.parse(await readFile(join(output,'report.json'),'utf8'));assert.equal(report.ok,true);assert.equal(report.cases.length,29);assert.equal(report.shots.length,10)
  assert.ok(report.cases.includes('completed file snapshots stay visible during continuous same-work updates'))
  // Added with the automatic-relay range entry: the synthetic surface renders the production control
  // panel, so it must declare the real read and pass real member profiles, and must never fake a write.
  const fixtureSource=await readFile(join(source,'renderer.tsx'),'utf8')
  assert.match(fixtureSource,/loom\.control\.get/, 'the run surface must declare the control read it renders')
  assert.match(fixtureSource,/agents=\{controlAgents\}/, 'the run surface must pass real member profiles into the dialog')
  assert.ok(!/loom\.control\.(configure|pause)/.test(fixtureSource), 'the synthetic surface must not fake a control write')
  assert.match(fixtureSource,/policy:null/, 'an unapproved mission stays visibly unapproved instead of inventing a policy')
  console.log(JSON.stringify({output,cases:report.cases,realCore:false,realModel:false}));passed=true
 }finally{
  if(child&&child.exitCode===null&&child.signalCode===null){child.kill();await closed}
  // Keep synthetic screenshots and report for Root visual review; no user data included.
  if(passed)await rm(userData,{recursive:true,force:true,maxRetries:3,retryDelay:100})
  console.log('Isolated run-surface evidence: '+fixture)
 }
})

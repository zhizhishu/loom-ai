import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import react from '@vitejs/plugin-react'
import electron from 'electron'
import { build } from 'vite'
import { admitElectronIntegrationTest } from './electron-sandbox-capability.mjs'

test('production navigation shell preserves drafts and supports complete collapse through native input', {timeout:120000}, async t => {
  if (!admitElectronIntegrationTest(t)) return
  const root=resolve(import.meta.dirname,'../..'), source=join(root,'scripts/fixtures/navigation-shell')
  const temporaryRoot=await realpath(tmpdir())
  const fixture=await mkdtemp(join(temporaryRoot,'rovai-navigation-shell-'))
  let child, closed
  try {
    await build({configFile:false,root:source,base:'./',logLevel:'error',plugins:[react()],resolve:{alias:{'@contracts':join(root,'packages/contracts/src/index.ts')}},build:{outDir:join(fixture,'renderer'),minify:false}})
    const env={...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'};delete env.ELECTRON_RUN_AS_NODE
    const skillLibraryRoot=join(fixture,'user-data','managed-skill-library')
    await mkdir(skillLibraryRoot,{recursive:true})
    process.stdout.write(`Isolated navigation userData: ${join(fixture,'user-data')}; Skill Library: ${skillLibraryRoot} (no Core/Runtime)\n`)
    child=spawn(electron,[join(source,'main.cjs'),join(fixture,'renderer/index.html'),join(fixture,'user-data'),...(process.platform==='linux'?['--no-sandbox']:[])],{env,windowsHide:true,stdio:['ignore','pipe','pipe']})
    closed=once(child,'close');let output=''
    child.stdout.on('data',chunk=>{output+=chunk.toString()});child.stderr.on('data',chunk=>{output+=chunk.toString()})
    const timer=setTimeout(()=>child.kill('SIGKILL'),100000)
    let code;try{[code]=await closed}finally{clearTimeout(timer)}
    assert.equal(code,0,output)
    assert.equal(JSON.parse(output.split('\n').find(line=>line.startsWith('{'))).ok,true)
  } finally {
    if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed}
    if(process.env.ROVAI_KEEP_NAVIGATION_FIXTURE==='1')process.stdout.write(`Navigation fixture: ${fixture}\n`)
    else {
      const target=await realpath(fixture)
      assert.equal(dirname(target),temporaryRoot)
      assert(basename(target).startsWith('rovai-navigation-shell-'))
      await rm(target,{recursive:true,force:true})
    }
  }
})

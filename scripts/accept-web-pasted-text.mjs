import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchHost, within } from './lib/host-test-client.mjs'
import { coreDataDirectoryArguments, removeEphemeralRuntimeCampFilesRoot } from './lib/runtime-camp-files-root.mjs'
import { launchAcceptanceBrowser, pause } from './lib/host-web-browser.mjs'

const repository = resolve(import.meta.dirname, '..')
const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-web-paste-ui-')))
const dataDir = join(fixture, 'data'), skills = join(fixture, 'skills'), profile = join(fixture, 'chrome')
const output = process.env.ROVAI_WEB_PASTE_OUTPUT ?? join(fixture, 'evidence')
await mkdir(output, { recursive: true })
console.log(JSON.stringify({ channel: 'automatic_acceptance', dataDir, skillLibraryRoot: skills, browserProfile: profile, runtime: false }))
const host = launchHost(join(repository, 'target/debug/rovai-host'), [
  ...coreDataDirectoryArguments(dataDir), '--skill-library-root', skills, '--mcp-config-path', join(dataDir, 'mcp.json')
], { cwd: repository })
let browser
const evidence = { cases: [], runtime: false, browserTransport: 'real Chromium + HTTP + Host/Core', input: 'ClipboardEvent with plain-text DataTransfer' }
try {
  await within(host.ready)
  const profiles = await host.request('members.list')
  const threads = []
  for (const activationState of ['active']) {
    const created = await host.request('threads.create', { commandId: crypto.randomUUID(), name: `Web paste ${activationState}`, workspace: null,
      memberAgentIds: [profiles[0].agentId], defaultLeadAgentId: profiles[0].agentId, collaborationMode: 'peer', activationState })
    assert.equal(created.status, 'applied')
    const threadId = created.payload.threadId
    if (activationState === 'pending') await host.request('threads.pendingDraft.setPresence', { threadId, present: true })
    threads.push({ threadId, activationState, root: await host.request('host.thread.attachmentOutputRoot', { threadId }) })
  }
  const web = await host.request('host.web.start', { listen: '127.0.0.1:0', uiDirectory: join(repository, 'out/web') })
  browser = await launchAcceptanceBrowser({ executable: process.env.ROVAI_REVIEW_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'] })
  await browser.send('Page.navigate', { url: web.origin })
  await browser.wait(`document.querySelector('#administrator-token') !== null`)
  await browser.click(`document.querySelector('#administrator-token')`)
  await browser.send('Input.insertText', { text: web.administratorToken })
  await browser.click(`document.querySelector('.web-login button[type=submit]')`)
  await browser.wait(`document.querySelector('.unified-sidebar') !== null`)
  const editor = `document.querySelector('[contenteditable=true]')`
  const choose = async state => {
    await browser.wait(`[...document.querySelectorAll('button')].some(e=>e.textContent.includes('Web paste ${state}'))`)
    await browser.click(`[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Web paste ${state}'))`)
    await browser.wait(`${editor} !== null`)
  }
  const paste = async text => browser.evaluate(`(()=>{const e=${editor};e.focus();const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(text)});e.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));})()`)
  const clear = async () => {
    await browser.click(editor)
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  }
  const card = `document.querySelector('.composer-attachment-strip .attachment-card')`
  const remove = `document.querySelector('.composer-attachment-strip .attachment-remove')`
  const waitFiles = async (root, count) => {
    for (let i=0;i<100;i++) { const files=await readdir(root); if(files.length===count)return files; await pause(50) }
    throw Error('Unexpected file count: '+JSON.stringify(await readdir(root)))
  }
  for (const state of ['active', 'pending']) {
    if (state === 'pending') {
      const created = await host.request('threads.create', { commandId: crypto.randomUUID(), name: 'Web paste pending', workspace: null,
        memberAgentIds: [profiles[0].agentId], defaultLeadAgentId: profiles[0].agentId, collaborationMode: 'peer', activationState: 'pending' })
      const threadId=created.payload.threadId
      await browser.evaluate(`fetch('/api/v1/request',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+JSON.parse(sessionStorage.getItem('rovai.web.auth.v1')).token},body:JSON.stringify({operation:'threads.pendingDraft.setPresence',params:{threadId:${JSON.stringify(threadId)},present:true}})}).then(r=>r.json())`)
      threads.push({threadId,activationState:'pending',root:await host.request('host.thread.attachmentOutputRoot',{threadId})})
    }
    const thread=threads.find(item=>item.activationState===state)
    await choose(thread.activationState)
    if(thread.activationState==='active') {
      const short='😀'.repeat(10_000)
      await paste(short)
      await browser.wait(`Array.from(${editor}.innerText).filter(c=>c==='😀').length===10000`)
      assert.deepEqual(await readdir(thread.root), [])
      await clear()
      await browser.wait(`${editor}.innerText.trim()===''`)
    }
    const body=thread.activationState==='active' ? 'Existing body stays here.' : ''
    if(body) { await paste(body); await browser.wait(`${editor}.innerText.trim()===${JSON.stringify(body)}`) }
    const text='  Remote paste 😀\r\n\t'+'内容 line  '.repeat(1400)+'\n '
    await paste(text)
    await browser.wait(`${card} !== null && ${remove} !== null`)
    await browser.wait(`${editor}.innerText.trim()===${JSON.stringify(body)}`)
    const [name]=await waitFiles(thread.root,1), path=join(thread.root,name)
    assert.equal(await readFile(path,'utf8'), text)
    await browser.capture(join(output, `${thread.activationState}-prepared.png`))
    // Browser reload must recover identity, preview and the same Host file.
    await browser.send('Page.reload')
    await browser.wait(`document.querySelector('.unified-sidebar')!==null`)
    await choose(thread.activationState)
    await browser.wait(`${card} !== null && ${remove} !== null`)
    assert.equal(await browser.evaluate(`${editor}.innerText.trim()`), body)
    assert.equal(await readFile(path,'utf8'), text)
    // Real click on the existing attachment card opens the shared file preview.
    await browser.click(`${card}.querySelector('button')`)
    await pause(500)
    await browser.capture(join(output, `${thread.activationState}-preview.png`))
    const start=Date.now()
    await browser.click(remove)
    await browser.wait(`${card} === null`)
    await waitFiles(thread.root,0)
    assert.equal(await browser.evaluate(`${editor}.innerText.trim()`), body)
    evidence.cases.push({ activationState:thread.activationState, path, codePoints:Array.from(text).length, bytes:Buffer.byteLength(text), reload:true, deletion:true, elapsedMs:Date.now()-start })
    await browser.capture(join(output, `${thread.activationState}-removed.png`))
    if(body) await clear()
  }
  await choose('active')
  for(let i=0;i<80;i++) {
    const nav=await host.request('navigation.snapshot')
    if(!JSON.stringify(nav).includes(threads[1].threadId))break
    await pause(50)
  }
  await assert.rejects(readdir(threads[1].root),{code:'ENOENT'})
  assert.deepEqual(await readdir(threads[0].root),[])
  evidence.pendingDeletedOnLeave=true; evidence.activePreserved=true
  // Use the actual browser submit path, including verified editor authorization
  // and successful local-draft cleanup. Built-in fixture members have no Runtime
  // configured: publication is real, while no external model can be invoked.
  const sentThread = threads[0]
  const sentText = 'Browser attachment-only publication 😀\r\n' + '完整内容 '.repeat(2400)
  await paste(sentText)
  await browser.wait(`${card} !== null && ${remove} !== null`)
  assert.equal(await browser.evaluate(`${editor}.innerText.trim()`), '')
  const [sentName] = await waitFiles(sentThread.root, 1)
  const sentPath = join(sentThread.root, sentName)
  const sendButton = `[...document.querySelectorAll('.composer-primary-action.is-send')].find(e => e.getClientRects().length > 0)`
  await browser.wait(`${sendButton} !== undefined && !${sendButton}.disabled`)
  await browser.click(sendButton)
  await browser.wait(`${card} === null && document.querySelector('[data-message-id] .attachment-card') !== null`)
  const snapshot = await host.request('camps.open', { traceId: crypto.randomUUID(), threadId: sentThread.threadId })
  const message = snapshot.messages.find(item => item.authorType === 'user' && item.attachments.length === 1)
  assert.ok(message, 'browser submit must publish an attachment-only message')
  assert.equal(message.body, '')
  const download = () => browser.evaluate(`(async () => {
    const response = await fetch('/api/v1/attachments', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer '+JSON.parse(sessionStorage.getItem('rovai.web.auth.v1')).token },
      body: JSON.stringify(${JSON.stringify({ owner: 'message', threadId: sentThread.threadId, messageId: message.id, attachmentRefId: message.attachments[0].id })}) });
    return { status: response.status, text: await response.text() };
  })()`)
  assert.deepEqual(await download(), { status: 200, text: sentText })
  assert.equal(await readFile(sentPath, 'utf8'), sentText)
  await browser.send('Page.reload')
  await browser.wait(`document.querySelector('.unified-sidebar') !== null`)
  await choose('active')
  await browser.wait(`document.querySelector('[data-message-id] .attachment-card') !== null`)
  assert.equal(await browser.evaluate(`${card} === null && ${editor}.innerText.trim() === ''`), true,
    'successful send must not restore the old browser draft')
  assert.deepEqual(await download(), { status: 200, text: sentText })
  assert.equal(await readFile(sentPath, 'utf8'), sentText, 'send cleanup must preserve the published file')
  await browser.capture(join(output, 'attachment-only-sent-reloaded.png'))
  evidence.attachmentOnlySend = { browserSubmit: true, messageId: message.id, path: sentPath,
    downloadable: true, reloadDraftEmpty: true, fileRetained: true }
  assert.equal(browser.errors.length,0,browser.errors.join('\n'))
  await writeFile(join(output,'validation.json'),JSON.stringify(evidence,null,2)+'\n')
  console.log(JSON.stringify(evidence))
} catch(error) {
  if(browser) { await browser.capture(join(output,'failure.png')).catch(()=>{}); console.error(await browser.evaluate('document.body.innerText.slice(-5000)').catch(()=>'')) }
  console.error(host.stderr()); throw error
} finally {
  await browser?.close(); await host.close()
  await removeEphemeralRuntimeCampFilesRoot(dataDir,{temporaryDirectory:fixture})
  if (!output.startsWith(fixture)) await rm(fixture,{recursive:true,force:true})
}

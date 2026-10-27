import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, realpath, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { launchHost, within } from './host-test-client.mjs'
import { launchAcceptanceBrowser, pause } from './host-web-browser.mjs'
import { coreDataDirectoryArguments, removeEphemeralRuntimeCampFilesRoot } from './runtime-camp-files-root.mjs'

const repository = resolve(import.meta.dirname, '../..')
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Owns actual tab close/reopen + durable browser auth + Host capacity. Lower
// layers cannot prove that production pages release their SSE/request ownership.
test('closing and reopening more than 32 browser tabs preserves online sessions and separate drafts', { timeout: 180_000 }, async t => {
  if (process.platform !== 'darwin' || !await access(chrome).then(() => true, () => false)) { t.skip('Requires macOS Chrome'); return }
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-session-tabs-')))
  const data = join(fixture, 'core'), profile = join(fixture, 'chrome')
  const output = process.env.ROVAI_SESSION_OUTPUT ?? join(fixture, 'evidence')
  await mkdir(output, { recursive: true })
  console.log(JSON.stringify({ channel: 'automatic_acceptance', dataDir: data, skillLibraryRoot: join(data, 'skills'), mcpConfigPath: join(data, 'mcp.json'), profile, runtime: false }))
  const host = launchHost(process.env.ROVAI_HOST_BIN ?? join(repository, 'target/debug/rovai-host'), [
    ...coreDataDirectoryArguments(data), '--skill-library-root', join(data, 'skills'), '--mcp-config-path', join(data, 'mcp.json')
  ], { cwd: repository })
  const launch = () => launchAcceptanceBrowser({ executable: chrome, args: ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'] })
  const ready = `document.querySelector('.camp-nav-open') && !document.querySelector('.web-login-overlay')`
  const identity = `JSON.parse(sessionStorage.getItem('rovai.web.session.v1')).editor.clientId`
  const composer = `document.querySelector('#camp-message')`
  const openCamp = async page => {
    await page.evaluate(`document.querySelector('.camp-nav-open').click()`)
    await page.wait(`${composer}?.getAttribute('contenteditable')==='true'`)
  }
  let browser, second
  try {
    await within(host.ready)
    const [member] = await host.request('members.list')
    await host.request('camps.create', { commandId: crypto.randomUUID(), name: 'Session capacity', workspace: null, memberAgentIds: [member.agentId], defaultLeadAgentId: member.agentId, collaborationMode: 'peer' })
    const web = await host.request('host.web.start', { listen: '127.0.0.1:0', uiDirectory: process.env.ROVAI_WEB_UI ?? join(repository, 'out/web') })
    browser = await launch()
    await browser.send('Page.navigate', { url: web.origin })
    await browser.wait(`document.querySelector('#administrator-token')!==null`)
    await browser.click(`document.querySelector('#administrator-token')`)
    await browser.send('Input.insertText', { text: web.administratorToken })
    await browser.click(`document.querySelector('.web-login button[type=submit]')`)
    await browser.wait(ready)
    await openCamp(browser)
    const firstId = await browser.evaluate(identity)
    await browser.click(composer); await browser.send('Input.insertText', { text: '常驻标签 A 的草稿' })
    const port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
    const newPage = async () => {
      const { targetId } = await browser.send('Target.createTarget', { url: web.origin, background: true })
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const target = targets.find(item => item.id === targetId)
      assert.ok(target)
      return connectPage(target.webSocketDebuggerUrl, () => browser.send('Target.closeTarget', { targetId }))
    }
    second = await newPage(); await second.wait(ready); await openCamp(second)
    const secondId = await second.evaluate(identity)
    assert.notEqual(secondId, firstId)
    assert.equal(await second.evaluate(`${composer}.textContent`), '')
    await second.evaluate(`${composer}.focus()`); await second.send('Input.insertText', { text: '常驻标签 B 的草稿' })
    const seen = new Set([firstId, secondId])
    for (let index = 0; index < 40; index++) {
      const page = await newPage()
      try {
        await page.wait(ready); await openCamp(page)
        const id = await page.evaluate(identity)
        assert.equal(seen.has(id), false, `reopen ${index}: fresh editor`); seen.add(id)
        assert.equal(await page.evaluate(`${composer}.textContent`), '', `reopen ${index}: no inherited draft`)
        assert.ok((await host.request('host.web.status')).sessions <= 32)
      } finally { await page.close() }
    }
    for (const [page, id, draft] of [[browser, firstId, '常驻标签 A 的草稿'], [second, secondId, '常驻标签 B 的草稿']]) {
      await page.send('Page.reload')
      await page.wait(`(${ready}) && ${composer}?.textContent===${JSON.stringify(draft)}`)
      assert.equal(await page.evaluate(identity), id)
    }
    await browser.capture(join(output, 'active-tab-after-40-reopens.png'))
    await second.close(); second = undefined
    await browser.close(); browser = await launch()
    await browser.send('Page.navigate', { url: web.origin })
    await browser.wait(ready); await openCamp(browser)
    assert.equal(await browser.evaluate(`${composer}.textContent`), '')
    assert.equal(browser.responses.some(response => response.path === '/api/v1/login'), false)
    const count = (await host.request('host.web.status')).sessions
    assert.equal(count, 32)
    assert.deepEqual(browser.errors, [])
    await writeFile(join(output, 'validation.json'), JSON.stringify({ passed: true, sequentialTabClosesAndReopens: 40, persistentBrowserReopen: true, activeTabsRetainSessionsAndDrafts: 2, freshEditorsWithoutInheritedDrafts: true, finalSessionCount: count, runtime: false, platform: 'macOS Chrome', fixture }, null, 2) + '\n')
  } finally {
    await second?.close(); await browser?.close(); await host.close()
    await removeEphemeralRuntimeCampFilesRoot(data, { temporaryDirectory: fixture })
  }
})

// Connect only to targets created by this test in its own browser profile.
async function connectPage(url, closeTarget) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const pending = new Map(); let id = 0
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) waiter.reject(Error(message.error.message)); else waiter.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error('Acceptance tab closed')) }
    pending.clear()
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`CDP timed out: ${method}`)) }, 20_000)
    pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw Error(result.exceptionDetails.text)
    return result.result.value
  }
  return { send, evaluate, async wait(expression) {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await pause(50) }
    throw Error(`Page did not reach the expected state: ${expression}`)
  }, async close() { try { await closeTarget() } finally { socket.close() } } }
}

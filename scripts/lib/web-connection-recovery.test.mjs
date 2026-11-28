import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, extname } from 'node:path'
import test from 'node:test'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { launchAcceptanceBrowser, pause } from './host-web-browser.mjs'

// Owns real fetch/SSE + the production reconnect bar in a browser. It
// intentionally uses a fault-injection HTTP fixture that numbers its
// invalidations, so Last-Event-ID resume is observable end to end. Core command
// idempotency is not claimed: recorded receipts come from the fixture.
test('Web reconnect bar keeps the page interactive and resumes from the last event id without resending receipts', { timeout: 180_000 }, async t => {
  const chrome = process.env.ROVAI_REVIEW_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  try { await access(chrome) } catch { t.skip('Requires a local Chrome binary'); return }
  const root = resolve(import.meta.dirname, '../..')
  const fixture = await mkdtemp(join(tmpdir(), 'rovai-web-recovery-'))
  const output = process.env.ROVAI_WEB_RECOVERY_OUTPUT ?? join(fixture, 'evidence')
  await mkdir(output, { recursive: true })
  let browser, server
  const streams = new Set()
  try {
    const dist = join(fixture, 'dist')
    await build({ configFile: false, root: join(root, 'scripts/fixtures/web-connection-recovery'), plugins: [react()],
      resolve: { alias: { '@contracts': join(root, 'packages/contracts/src/index.ts') } },
      logLevel: 'error', build: { outDir: dist, emptyOutDir: true } })
    let online = true, loss = null, rejectRetry = false, holdProbe = false, holdEvents = false, releaseProbe
    const dispatches = [], receipts = new Map()
    // Server-side event log: the fixture assigns process-wide ids and replays
    // exactly the invalidations a reconnecting Last-Event-ID asks for.
    const events = [], eventHeaders = []
    let seq = 0, resyncs = 0
    const frame = entry => `id: ${entry.id}\nevent: invalidate\ndata: ${JSON.stringify(entry.payload)}\n\n`
    const emit = payload => {
      const entry = { id: ++seq, payload }
      events.push(entry)
      for (const stream of streams) stream.write(frame(entry))
    }
    const identity = { protocolVersion: 5, token: 'a'.repeat(64), clientId: 'b'.repeat(64), editorProof: 'c'.repeat(64), ownerId: 'fixture' }
    server = createServer(async (request, response) => {
      const path = new URL(request.url, 'http://fixture').pathname
      const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
      if (!path.startsWith('/api/')) {
        try {
          const file = resolve(dist, `.${path === '/' ? '/index.html' : path}`)
          if (!file.startsWith(`${dist}/`)) return json({}, 404)
          response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(file)] ?? 'application/octet-stream')
          response.end(await readFile(file))
        } catch { json({}, 404) }
        return
      }
      if (!online) return json({ error: { code: 'core_unavailable' } }, 503)
      if (path.endsWith('/events')) {
        if (holdEvents) return json({ error: { code: 'connection_unavailable' } }, 503)
        const header = request.headers['last-event-id'] ?? null
        eventHeaders.push(header)
        const last = Number(header)
        const oldest = events[0]?.id ?? null
        const resumable = header !== null && Number.isSafeInteger(last) && last > 0 && last <= seq
          && (oldest === null || last + 1 >= oldest)
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        if (resumable) {
          response.write(':connected\n\n')
          for (const entry of events.filter(item => item.id > last)) response.write(frame(entry))
        } else {
          resyncs++
          response.write('event: resync\ndata: {"epoch":"fixture","revision":0}\n\n')
        }
        streams.add(response); request.on('close', () => streams.delete(response)); return
      }
      if (path.endsWith('/login') || path.endsWith('/session')) return json(identity)
      let data = ''
      for await (const chunk of request) data += chunk
      const body = JSON.parse(data)
      if (body.operation === 'app.info') {
        const finish = () => { holdEvents = false; json({ result: { name: 'fixture' } }) }
        if (holdProbe) { releaseProbe = finish; return }
        return finish()
      }
      if (body.operation === 'commands.reconcile') return json({ result: receipts.has(body.params.params.commandId)
        ? { state: 'recorded', result: receipts.get(body.params.params.commandId) } : { state: 'unknown' } })
      dispatches.push(body)
      const result = { id: body.params.commandId }
      if (loss) {
        if (loss === 'after') receipts.set(body.params.commandId, result)
        loss = null
        // Send headers before losing the body. A bare reset on a reused socket
        // lets Chrome transparently repeat even a POST below the fetch API.
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000', Connection: 'close' })
        response.end('{"result":'); return
      }
      if (rejectRetry) { rejectRetry = false; return json({ error: { code: 'draft_changed', message: '草稿已变化，请重试' } }) }
      receipts.set(body.params.commandId, result)
      json({ result })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/`
    browser = await launchAcceptanceBrowser({ executable: chrome, args: ['--headless=new', `--user-data-dir=${join(fixture, 'profile')}`, '--remote-debugging-port=0', '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check', 'about:blank'] })
    await browser.send('Page.navigate', { url })
    await browser.wait(`document.querySelector('#draft') && connectionFixture.transport.connectionState === 'live'`)
    const mounts = await browser.evaluate('connectionFixture.observations.mounts')
    const getDraft = () => browser.evaluate(`document.querySelector('#draft').value`)
    const bar = () => browser.evaluate(`(() => { const node = document.querySelector('.web-live-bar'); return node ? { variant: node.dataset.variant, title: node.querySelector('.web-live-bar-title').textContent, description: node.querySelector('.web-live-bar-description').textContent } : null })()`)
    const retry = () => browser.click(`document.querySelector('.web-live-bar-retry')`)
    const stop = () => { online = false; holdEvents = true; for (const stream of streams) stream.end(); streams.clear() }
    const closed = () => browser.wait(`document.querySelector('.web-live-bar') === null`)
    const setDraft = async text => {
      await browser.click(`document.querySelector('#draft')`)
      await browser.evaluate(`document.querySelector('#draft').select()`)
      await browser.send('Input.insertText', { text })
    }

    // The initial connection has no cursor, so it starts with one resync; the
    // numbered invalidations after it become the resume point.
    assert.deepEqual(eventHeaders, [null])
    assert.equal(resyncs, 1)
    emit({ tasksChanged: true })
    await browser.wait(`connectionFixture.observations.changes.some(change => change.tasksChanged === true)`)
    emit({ referencesChanged: true })
    await browser.wait(`connectionFixture.observations.changes.some(change => change.referencesChanged === true)`)

    // Disconnect: the bar appears, yet the business page, its open dialog and
    // its draft stay mounted and editable. No modal, no shortcut capture.
    await browser.click(`document.querySelector('#create')`)
    await browser.wait(`document.querySelector('#dialog-title') !== null`)
    const dispatchesBefore = dispatches.length
    stop()
    await browser.wait(`document.querySelector('.web-live-bar')?.dataset.variant === 'reconnecting'`)
    await browser.click(`document.querySelector('#dialog-title')`)
    await browser.evaluate(`document.querySelector('#dialog-title').select()`)
    await browser.send('Input.insertText', { text: '断线期间仍可输入' })
    await browser.wait(`document.querySelector('#dialog-title').value === '断线期间仍可输入'`)
    await browser.key('Escape'); await browser.wait(`document.querySelector('#dialog-title') === null`)
    await browser.key('F2')
    assert.equal(await browser.evaluate('connectionFixture.observations.shortcuts'), 2, 'the bar no longer captures page shortcuts')
    await setDraft('断线期间保留的草稿')
    assert.equal(await getDraft(), '断线期间保留的草稿')
    assert.equal(await browser.evaluate(`document.querySelector('#send').disabled`), false)

    assert.match((await bar()).title, /正在重新连接/)
    assert.match((await bar()).description, /网络恢复后会自动续传/)
    await browser.evaluate(`connectionFixture.language('en')`)
    await browser.wait(`document.querySelector('.web-live-bar-title').textContent === 'Reconnecting'`)
    assert.match(await browser.evaluate(`document.querySelector('.web-live-bar-description').textContent`), /Transfer resumes automatically/)
    await browser.evaluate(`connectionFixture.language('zh-CN')`)

    // × only hides the notice; the page and recovery transaction are untouched.
    await browser.click(`document.querySelector('.web-live-bar-dismiss')`)
    await closed()
    assert.equal(await getDraft(), '断线期间保留的草稿')

    // Changes recorded while the page was disconnected are buffered server-side.
    emit({ notificationsChanged: true })
    emit({ teamsChanged: true })
    online = true; holdEvents = false
    await browser.evaluate('connectionFixture.transport.wakeLive()')
    await browser.wait(`connectionFixture.transport.connectionState === 'live'`, 20_000)
    await browser.wait(`connectionFixture.observations.changes.some(change => change.notificationsChanged === true)`
      + ` && connectionFixture.observations.changes.some(change => change.teamsChanged === true)`)
    assert.equal(resyncs, 1, 'a resumed stream never asks for resync')
    assert.deepEqual(eventHeaders, [null, '2'], 'reconnect carries the last framed id, and a legacy server header stays absent')
    assert.equal(dispatches.length, dispatchesBefore, 'unsent draft never auto-submits')
    assert.equal(await getDraft(), '断线期间保留的草稿')

    // Unknown admission: the frozen command id and payload are reused once.
    await setDraft('丢失准入后重试')
    loss = 'before'
    await browser.click(`document.querySelector('#send')`)
    await browser.wait(`document.querySelector('.web-live-bar-retry') !== null && connectionFixture.transport.pendingCommandCount === 1`)
    assert.match((await bar()).title, /有 1 个操作等待核对/)
    assert.match((await bar()).description, /不会重复发送/)
    const original = structuredClone(dispatches.at(-1))
    await retry(); await closed()
    assert.deepEqual(dispatches.slice(-2), [original, original], 'same frozen ID and payload after lost admission')
    assert.equal(await getDraft(), '')
    assert.equal(await browser.evaluate('connectionFixture.observations.results.length'), 1)

    // A recorded receipt settles the frozen submission without a second send:
    // the automatic read-only lookup resolves the original promise and clears
    // the pending gate, so the bar falls back to the plain reconnect notice.
    await setDraft('响应丢失但服务已提交')
    loss = 'after'
    const before = dispatches.length
    await browser.click(`document.querySelector('#send')`)
    await browser.wait(`connectionFixture.transport.pendingCommandCount === 0`)
    assert.equal(dispatches.length, before + 1, 'recorded receipt is never sent again')
    assert.equal(await browser.evaluate('connectionFixture.observations.results.length'), 2)
    assert.equal(await getDraft(), '')
    for (const stream of streams) stream.end()
    streams.clear()
    await browser.wait(`connectionFixture.transport.connectionState === 'live'`)
    await closed()

    // A definitive business rejection releases the gate and keeps the draft.
    await setDraft('业务拒绝后继续保留')
    loss = 'before'; rejectRetry = true
    await browser.click(`document.querySelector('#send')`)
    await browser.wait(`document.querySelector('.web-live-bar-retry') !== null`)
    await retry(); await closed()
    assert.equal(await getDraft(), '业务拒绝后继续保留')
    assert.equal(await browser.evaluate('connectionFixture.transport.pendingCommandCount'), 0)
    assert.equal(await browser.evaluate(`document.querySelector('#send').disabled`), false)

    // Failed recovery keeps the notice (and the pending command) visible.
    await setDraft('恢复失败后仍可重试')
    loss = 'before'
    await browser.click(`document.querySelector('#send')`)
    await browser.wait(`document.querySelector('.web-live-bar-retry') !== null`)
    stop()
    await retry()
    await browser.wait(`document.querySelector('.web-live-bar')?.dataset.variant === 'failed'`)
    assert.equal((await bar()).title, '仍无法连接服务')
    assert.match((await bar()).description, /请确认服务已启动/)
    await browser.evaluate(`connectionFixture.language('en')`)
    await browser.wait(`document.querySelector('.web-live-bar-title').textContent === 'Still unable to connect'`)
    assert.match(await browser.evaluate(`document.querySelector('.web-live-bar-description').textContent`), /Make sure the service is running/)
    await browser.evaluate(`connectionFixture.language('zh-CN')`)

    for (const [theme, width, height] of [['day', 1440, 920], ['night', 1440, 920], ['day', 390, 844], ['night', 390, 844]]) {
      await browser.evaluate(`document.documentElement.dataset.theme = '${theme}'`)
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 })
      await pause(200)
      const geometry = await browser.evaluate(`(() => { const node = document.querySelector('.web-live-bar'); const button = document.querySelector('.web-live-bar-retry'); const style = getComputedStyle(button); const rect = node.getBoundingClientRect(); return { background: style.backgroundColor, overflow: document.documentElement.scrollWidth > innerWidth, fits: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight } })()`)
      assert.equal(geometry.background, theme === 'day' ? 'rgb(43, 43, 44)' : 'rgb(229, 229, 231)')
      assert.equal(geometry.overflow, false); assert.equal(geometry.fits, true)
      await browser.capture(join(output, `reconnect-bar-${theme}-${width}.png`))
    }
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 920, deviceScaleFactor: 1, mobile: false })

    // Busy state: the retry button stays reachable but disabled and spinning.
    online = true; holdEvents = false; holdProbe = true
    await retry()
    await browser.wait(`document.querySelector('.web-live-bar')?.dataset.variant === 'recovering'`)
    assert.equal(await browser.evaluate(`document.querySelector('.web-live-bar-retry').disabled`), true)
    await browser.evaluate(`connectionFixture.language('en')`)
    await browser.wait(`document.querySelector('.web-live-bar-title').textContent === 'Restoring connection…'`)
    await browser.evaluate(`document.documentElement.dataset.motionPreference = 'reduce'`)
    assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('.web-live-bar-retry .web-login-spinner')).animationName`), 'none')
    await browser.capture(join(output, 'reconnect-bar-recovering.png'))
    await browser.evaluate(`connectionFixture.language('zh-CN')`)
    holdProbe = false; releaseProbe(); await closed()
    assert.equal(await getDraft(), '')

    assert.equal(await browser.evaluate('connectionFixture.observations.mounts'), mounts)
    assert.deepEqual(JSON.parse(await browser.evaluate(`sessionStorage.getItem('rovai.web.session.v1')`)).pending, [])
    assert.deepEqual(browser.errors, [])
    await writeFile(join(output, 'verification.json'), JSON.stringify({ fixture: 'fault-injection HTTP + production ConsoleClient/WebConnectionRecovery', coreExecutionVerified: false,
      checks: ['initial resync', 'SSE disconnect', 'interactive page and draft', 'open dialog retained', 'shortcut capture removed', 'dismiss notice', 'wakeLive resume', 'Last-Event-ID header', 'replay without resync', 'no lost replayed events', 'unsent draft not submitted', 'unknown exact retry', 'recorded no resend', 'definitive rejection releases lock', 'failed copy', 'neutral day/night colors', 'mobile fit', 'busy disabled spinner', 'reduced motion', 'no remount', 'pending storage cleared'], dispatches: dispatches.length, events: seq, eventHeaders, resyncs }, null, 2))
    console.log(`Recovery UI evidence: ${output}`)
  } finally {
    await browser?.close()
    for (const stream of streams) stream.end()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

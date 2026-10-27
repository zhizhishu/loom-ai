const assert = require('node:assert/strict')
const { mkdirSync } = require('node:fs')
const { isAbsolute, join } = require('node:path')
const { app, BrowserWindow } = require('electron')
const [renderer, userData] = process.argv.slice(2)
assert.ok(isAbsolute(renderer) && isAbsolute(userData))
mkdirSync(join(userData, 'managed-skill-library'), { recursive: true })
app.setPath('userData', userData)
app.setPath('sessionData', join(userData, 'session'))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1040, height: 700,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  window.webContents.on('console-message', event => console.error(event.message))
  const run = code => window.webContents.executeJavaScript(code, true)
  const state = () => run('window.interruptionTest.state()')
  const until = async (condition, message) => {
    for (let n = 0; n < 150; n++) { const current = await state(); if (condition(current)) return current; await wait(20) }
    throw new Error(`${message}: ${JSON.stringify(await state())}`)
  }
  try {
    await window.loadFile(renderer)
    window.webContents.focus()
    await window.webContents.capturePage()
    await run("document.querySelector('#focus').focus()")
    await until(s => s.ready && s.dot, 'Restart must restore the unread exit reminder')
    await wait(120)
    assert.equal((await state()).facts[0].read, false, 'Cached/failed content cannot acknowledge')
    assert.match((await state()).label, /执行中断/)

    // A fully displayed Thread acknowledges the observed exit reminder even if
    // the interrupted run produced no message, command row or visible Run ID.
    await run('window.interruptionTest.sidebar(false); window.interruptionTest.ready(true)')
    await until(s => !s.dot && s.facts[0].read, 'Successful Thread display acknowledges without locating a Run')
    await run('window.interruptionTest.sidebar(true)')
    await wait(120)
    assert.equal((await state()).headsUp, 0)
    const before = (await state()).requests.length
    for (let n = 0; n < 30; n++) { await run('window.interruptionTest.advance()'); await wait(20) }
    const progressRequests = (await state()).requests.slice(before)
    assert.deepEqual(progressRequests, [], 'Command progress, snapshot sequence and ordinary invalidation cannot trigger notification RPCs')
    await run('window.interruptionTest.manualStop()')
    await wait(100)
    assert.equal((await state()).dot, false, 'Manual stop has no pulse or unread reminder')
    assert.equal((await state()).requests.length, before, 'Manual stop does not query notifications')

    await run("window.interruptionTest.ready(false); window.interruptionTest.admitWeb('next-exit')")
    await until(s => s.dot, 'Web notification invalidation refreshes unopened exit')
    const beforeEmpty = (await state()).requests.filter(r => r.method === 'notifications.threadInterruptions').length
    await run('window.interruptionTest.poll()'); await wait(120)
    assert.equal((await state()).requests.filter(r => r.method === 'notifications.threadInterruptions').length, beforeEmpty,
      'Empty notification batch cannot refresh interruption projection')
    await run('window.interruptionTest.attentive(false); window.interruptionTest.ready(true)')
    await wait(80)
    assert.equal((await state()).dot, true, 'Background content cannot acknowledge')
    await run('window.interruptionTest.attentive(true)')
    await until(s => !s.dot, 'Focus confirms the displayed Thread')

    await run("window.interruptionTest.ready(false); window.interruptionTest.admit('first')")
    await until(s => s.unread, 'Observed boundary')
    await run("window.savedRead=window.interruptionTest.capture(); window.interruptionTest.admit('later'); window.interruptionTest.failAck(); window.interruptionTest.markRead(window.savedRead)")
    await wait(120)
    await run('window.interruptionTest.manual(true); window.interruptionTest.recover()')
    let current = await until(s => s.facts.find(f => f.runId === 'first')?.read, 'Frozen acknowledgement retries')
    assert.equal(current.facts.find(f => f.runId === 'later').read, false, 'Concurrent exit survives the frozen boundary')
    assert.equal(current.localWrites, 1, 'Core retry cannot clear a later manual reminder')
    const saved = await run('window.savedRead')
    const exact = current.requests.filter(r => r.method === 'notifications.acknowledgeThreadInterruptions' && r.request.commandId === saved.commandId)
    assert.ok(exact.length >= 2); assert.deepEqual(exact[0].request, exact[1].request)
    await run('window.interruptionTest.manual(false); window.interruptionTest.ready(true)')
    await until(s => !s.unread, 'New visit acknowledges the later reminder')

    await run("window.interruptionTest.ready(false); window.interruptionTest.admit('stale')")
    await until(s => s.unread, 'Prepare delayed projection')
    await run('window.interruptionTest.hold()')
    await until(s => s.held > 0, 'Projection is pending')
    await run('window.interruptionTest.ready(true)')
    await until(s => s.facts.find(f => f.runId === 'stale')?.read, 'Displayed Thread acknowledges while read is pending')
    await run('window.interruptionTest.release()')
    await until(s => !s.dot, 'Late read cannot resurrect acknowledged attention')

    await run("window.interruptionTest.ready(false); window.interruptionTest.admit('reset-exit')")
    await until(s => s.unread, 'Prepare reset baseline')
    await run('window.interruptionTest.hold(); window.interruptionTest.reset(); window.interruptionTest.ready(true)')
    await until(s => s.held >= 2, 'Replacement baseline is pending')
    await wait(80)
    assert.equal((await state()).facts.find(f => f.runId === 'reset-exit').read, false,
      'Retained old generation cannot authorize a new automatic read')
    await run('window.interruptionTest.release()')
    await until(s => !s.dot, 'Fresh reset baseline confirms the displayed Thread')

    // Opening queued an automatic read against false; reset then retained that
    // old snapshot while the already-existing interruption loaded in a new generation.
    await run('window.interruptionTest.ready(false)')
    await wait(120)
    await run("window.interruptionTest.silentAdmit('queued-reset-exit'); window.interruptionTest.holdFrames(); window.interruptionTest.ready(true)")
    await until(s => s.heldFrames > 0, 'Automatic confirmation frame is queued')
    await run('window.interruptionTest.hold(); window.interruptionTest.reset(); window.interruptionTest.releaseFrames()')
    await until(s => s.held >= 2, 'New reset baseline is still pending after the old frame ran')
    assert.equal((await state()).facts.find(f => f.runId === 'queued-reset-exit').read, false)
    await run('window.interruptionTest.release()')
    await until(s => !s.dot && s.facts.find(f => f.runId === 'queued-reset-exit').read,
      'The old frame cannot consume the visit before the new baseline arrives')

    await run("window.interruptionTest.ready(false); window.interruptionTest.holdChanges(); window.interruptionTest.admit('poll-first')")
    await until(s => s.heldChanges === 1, 'First notification response is held')
    const heldPollCount = (await state()).requests.filter(r => r.method === 'notifications.changesSince').length
    await run("window.interruptionTest.admit('poll-second'); window.interruptionTest.admitWeb('poll-third')")
    await wait(160)
    assert.equal((await state()).requests.filter(r => r.method === 'notifications.changesSince').length, heldPollCount)
    await run('window.interruptionTest.releaseChanges()')
    current = await until(s => s.servedChangeSequence === s.sequence, 'An in-flight signal triggers a follow-up read without waiting for recovery')
    assert.equal(current.requests.filter(r => r.method === 'notifications.changesSince').length, heldPollCount + 1,
      'Concurrent Desktop/Web signals coalesce into one follow-up')

    await run('window.interruptionTest.holdChanges(); window.interruptionTest.poll()')
    await until(s => s.heldChanges === 1, 'Empty notification read is held')
    const beforeRecovery = (await state()).requests.filter(r => r.method === 'notifications.threadInterruptions').length
    await run('window.interruptionTest.attentive(false)')
    await wait(40)
    await run('window.interruptionTest.attentive(true)')
    await wait(40)
    await run('window.interruptionTest.releaseChanges()')
    await until(s => s.requests.filter(r => r.method === 'notifications.threadInterruptions').length > beforeRecovery,
      'A coalesced focus recovery still refreshes interruption projections')

    await run('window.interruptionTest.holdChanges(); window.interruptionTest.poll()')
    await until(s => s.heldChanges === 1, 'Prepare failed in-flight read')
    await run("window.interruptionTest.admit('poll-retry')")
    await wait(160)
    const beforeFailure = (await state()).requests.filter(r => r.method === 'notifications.changesSince').length
    await run('window.interruptionTest.releaseChanges(true)')
    await wait(160)
    assert.equal((await state()).requests.filter(r => r.method === 'notifications.changesSince').length, beforeFailure,
      'A queued signal cannot bypass failure backoff or create a retry loop')
    await run('window.interruptionTest.passBackoff(); window.interruptionTest.poll()')
    await until(s => s.servedChangeSequence === s.sequence, 'The existing retry entry resumes after backoff')
    await run('window.interruptionTest.ready(true)')
    await until(s => !s.dot, 'Finish delayed notification confirmations')

    await run('window.interruptionTest.ready(false); window.interruptionTest.batches()')
    await until(s => s.projectionCount === 201 && s.secondary?.unread, 'Two bounded batches loaded')
    await run("window.interruptionTest.batchMode('fail'); window.interruptionTest.batchUnread(false); window.interruptionTest.recover(); window.interruptionTest.admit('batch-failure')")
    current = await until(s => s.dot && s.batchFailures > 0, 'First batch applies despite second failure')
    assert.equal(current.secondary.unread, true)
    await run("window.interruptionTest.batchMode('success'); window.interruptionTest.recover(); window.interruptionTest.ready(true)")
    await until(s => !s.dot && !s.secondary.unread, 'Existing recovery converges both batches')

    await run("window.interruptionTest.ready(false); window.interruptionTest.batchMode('hold'); window.interruptionTest.batchUnread(true); window.interruptionTest.recover(); window.interruptionTest.admit('batch-delay')")
    await until(s => s.dot && s.heldBatches > 0, 'Fast batch updates while second remains pending')
    await run('void window.interruptionTest.confirmBatch()')
    await wait(60)
    const failures = (await state()).batchFailures
    await run('window.interruptionTest.releaseBatch(); window.interruptionTest.recover()')
    current = await until(s => s.heldBatches === 0 && s.batchFailures > failures, 'Late response plus failed refresh')
    assert.equal(current.secondary.unread, false, 'Late true cannot overwrite the newer acknowledgement')
    await run("window.interruptionTest.batchMode('success'); window.interruptionTest.ready(true); window.interruptionTest.recover()")
    await until(s => !s.dot, 'Finish exact reads')
    assert.equal(await run("document.querySelector('#focus').value"), '保留的草稿')
    console.log(JSON.stringify({ ok: true, progressUpdates: 30, progressNotificationRequests: progressRequests.length,
      cases: ['restart', 'cached-content', 'empty-output', 'hidden-sidebar', 'ordinary-progress', 'manual-stop', 'web-notification', 'empty-batch', 'background', 'frozen-read-retry', 'stale-read', 'reset-baseline', 'queued-frame-reset', 'in-flight-signals', 'in-flight-recovery', 'in-flight-backoff', 'batch-failure', 'batch-delay'] }))
    app.exit(0)
  } catch (error) { console.error(error.stack ?? error); app.exit(1) }
})

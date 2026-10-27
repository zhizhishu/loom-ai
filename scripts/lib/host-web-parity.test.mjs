import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import electron from 'electron'
import { buildHostWebParity } from '../review-host-web-parity.mjs'
import { admitElectronIntegrationTest } from './electron-sandbox-capability.mjs'

const root = resolve(import.meta.dirname, '../..')
const chrome = process.env.ROVAI_REVIEW_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

test('production Camp components run in Chrome and Electron without a fake native bridge', { timeout: 240_000 }, async t => {
  try { await access(chrome) } catch { t.skip('This visual seam requires an explicit local Chrome binary; no native/browser qualification claimed.'); return }
  if (!admitElectronIntegrationTest(t)) return
  const fixture = await mkdtemp(join(tmpdir(), 'rovai-host-web-parity-'))
  const output = process.env.ROVAI_PARITY_OUTPUT ?? join(fixture, 'review')
  const artifact = process.env.ROVAI_PARITY_ARTIFACT_ROOT
    ? { productPath: join(process.env.ROVAI_PARITY_ARTIFACT_ROOT, 'production-components.html'),
      viewerPath: join(process.env.ROVAI_PARITY_ARTIFACT_ROOT, 'rovai-desktop-web-parity.html') }
    : await buildHostWebParity(join(fixture, 'artifact'))
  await mkdir(output, { recursive: true })
  process.stdout.write(`Isolated UI fixtures: ${fixture}; no Core, Runtime, daily profile or workspace access.\n`)
  const evidence = { simulation: true, hostExecutionVerified: false, viewport: { width: 1440, height: 920 }, checks: [] }
  try {
    for (const surface of ['desktop', 'web']) {
      const profile = join(fixture, surface, 'profile'); await mkdir(profile, { recursive: true })
      const driver = await launch(surface, profile)
      try {
        for (const theme of ['day', 'night']) for (const scenario of ['camp', 'new', 'running', 'mobile-running', 'approval', 'file', 'member']) {
          const url = pathToFileURL(artifact.productPath); url.search = new URLSearchParams({ surface, theme, scenario }).toString()
          await driver.send('Page.navigate', { url: url.href })
          await driver.wait(`location.href === ${JSON.stringify(url.href)} && document.querySelector('.app-shell') !== null`)
          await pause(400)
          const state = await driver.evaluate(`(() => ({ nativeBridge: typeof window.rovai, require: typeof window.require,
            viewport: [innerWidth, innerHeight], rail: document.querySelector('.unified-sidebar')?.getBoundingClientRect().width,
            topbar: document.querySelector('.camp-topbar')?.getBoundingClientRect().height,
            overflow: document.documentElement.scrollWidth > innerWidth,
            text: document.body.innerText.slice(0, 10000), composer: !!document.querySelector('[contenteditable="true"]'),
            dialog: !!document.querySelector('[role="dialog"]') }))()`)
          await driver.capture(join(output, `${surface}-${scenario}-${theme}.png`))
          assert.equal(state.rail, 270, 'production navigation width')
          assert.equal(state.nativeBridge, 'undefined', `${surface}/${scenario}: no window.rovai substitute`)
          assert.equal(state.require, 'undefined')
          assert.deepEqual(state.viewport, [1440, 920])
          assert.equal(state.overflow, false, `${surface}/${theme}/${scenario}: no product overflow`)
          if (scenario !== 'member') assert.ok(state.topbar > 0, 'production header rendered; geometry is compared between both entry points')
          if (scenario === 'camp') { assert.ok(state.composer); assert.match(state.text, /继续核对审批/) }
          if (scenario === 'new') assert.equal(state.dialog, true)
          if (scenario === 'file') assert.match(state.text, /固定示例|本次检查/)
          if (scenario === 'member') {
            assert.match(state.text, /运行配置|运行时/)
            const layout = await driver.evaluate(`(() => {
              const rail = document.querySelector('.member-editor-roster-shell').getBoundingClientRect();
              const editor = document.querySelector('.member-editor-view').getBoundingClientRect();
              return { railRight: rail.right, editorLeft: editor.left, topDifference: Math.abs(rail.top - editor.top) }
            })()`)
            assert.ok(layout.railRight <= layout.editorLeft, 'production member roster stays beside the form')
            assert.equal(layout.topDifference, 0)
          }
          const actions = await exerciseScenario(driver, scenario, surface, join(fixture, 'downloads'), theme)
          if (scenario === 'approval') {
            const buttons = await driver.evaluate(`Array.from(document.querySelectorAll('button')).map(b=>({text:b.textContent.trim(),label:b.getAttribute('aria-label')}))`)
            assert.ok(buttons.some(b => b.text === 'Allow once'), 'native option label from approval fixture')
            await driver.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Allow once').click()`)
            assert.equal(await driver.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Allow once')?.disabled`), true, 'approval submission disables repeated input')
            await driver.capture(join(output, `${surface}-approval-submitting-${theme}.png`))
            await driver.wait(`!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Allow once')`)
            assert.equal(await driver.evaluate(`document.querySelector('.approval-badge') !== null`), false, 'resolved fixture removes the pending indicator')
            await driver.capture(join(output, `${surface}-approval-resolved-${theme}.png`))
            evidence.checks.push({ surface, theme, scenario, state, actions, buttons, simulatedResolution: 'native-once' })
          } else evidence.checks.push({ surface, theme, scenario, state, actions })
          if (actions.length) await driver.capture(join(output, `${surface}-${scenario}-interaction-${theme}.png`))
          assert.deepEqual(driver.errors.splice(0), [], `${surface}/${theme}/${scenario}: no runtime exceptions`)
        }
        if (surface === 'web') {
          await driver.send('Emulation.setDeviceMetricsOverride', { width: 1480, height: 1100, deviceScaleFactor: 1, mobile: false })
          evidence.viewer = await exerciseViewer(driver, artifact.viewerPath)
          await driver.capture(join(output, 'reviewer-approval-night.png'))
        }
      } finally { await driver.close() }
    }
    for (const left of evidence.checks.filter(c => c.surface === 'desktop')) {
      const right = evidence.checks.find(c => c.surface === 'web' && c.theme === left.theme && c.scenario === left.scenario)
      assert.equal(right.state.topbar, left.state.topbar, 'same production header geometry')
      assert.equal(right.state.rail, left.state.rail, 'same production navigation geometry')
    }
    await writeFile(join(output, 'review.json'), JSON.stringify(evidence, null, 2))
    process.stdout.write(`Parity evidence: ${output}\n`)
  } finally { await rm(fixture, { recursive: true, force: true }) }
})

async function exerciseScenario(driver, scenario, surface, downloads, theme) {
  if (scenario === 'camp') {
    await driver.evaluate(`document.querySelector('[contenteditable="true"]').focus()`)
    await driver.key('Enter')
    await driver.wait(`document.querySelector('[contenteditable="true"]')?.textContent.trim() === ''`)
    assert.match(await driver.evaluate('document.body.innerText'), /继续核对审批和文件预览，保留现有交互。/)
    return ['simulated-send-appends-message-and-clears-this-draft']
  }
  if (scenario === 'new') {
    await driver.click(`document.querySelector('.new-camp-picker-trigger')`)
    await driver.wait(`document.querySelector('[role="menu"]') !== null`)
    await driver.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.trim()==='选择工作目录…')`)
    await driver.wait(`Array.from(document.querySelectorAll('[role="dialog"]')).some(e=>e.textContent.includes('固定示例目录'))`)
    await driver.click(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent.includes('rovai-workspace · /review/rovai-workspace'))`)
    await driver.wait(`document.querySelector('#new-camp-workspace-value')?.textContent === 'rovai-workspace'`)
    await driver.wait(`!document.querySelector('.new-camp-dialog')?.textContent.includes('正在确认工作区')`)
    assert.equal(await driver.evaluate(`document.querySelector('.new-camp-workspace-warning') !== null`), false)
    await driver.click(`document.querySelector('.member-trigger')`)
    await driver.wait(`document.querySelector('[role="menuitemcheckbox"]') !== null`)
    await driver.click(`Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find(e=>e.textContent.includes('木瓦'))`)
    await driver.key('Escape')
    await driver.wait(`document.querySelector('#new-camp-members-value')?.textContent === '1 位队员'`)
    await driver.click(`document.querySelector('[aria-controls="new-camp-optional-panel"]')`)
    await driver.evaluate(`document.querySelector('#new-camp-name').focus()`)
    await driver.send('Input.insertText', { text: '模拟新 Camp' })
    await driver.click(`document.querySelector('.new-camp-dialog button[type="submit"]')`)
    await driver.wait(`document.querySelector('.new-camp-dialog') === null && document.querySelector('.camp-topbar')?.textContent.includes('模拟新 Camp')`)
    assert.equal(await driver.evaluate(`document.querySelector('[contenteditable="true"]').textContent.trim()`), '')
    return ['simulated-authorized-workspace-picker', 'select-one-member', 'create-and-open-fresh-camp']
  }
  if (scenario === 'running' || scenario === 'mobile-running') {
    const entryActions = await exerciseExecutionEntry(driver, scenario === 'mobile-running' ? 10 : 1, surface)
    if (scenario === 'mobile-running') {
      const containment = surface === 'web' && theme === 'night'
        ? await exerciseCommandDiffContainment(driver, surface, [360, 375, 430])
        : []
      return [...entryActions, ...containment, ...await finishExecutionEntry(driver)]
    }
    assert.match(await driver.evaluate(`document.querySelector('.tool-group-current').textContent`), /pnpm test -- --run/)
    assert.equal(await driver.evaluate(`document.querySelector('.tool-group-summary > .tool-call-icon').dataset.iconDomain`), 'terminal')
    assert.equal(await driver.evaluate(`document.querySelector('.tool-group-disclosure') === null`), true)
    assert.equal(await driver.evaluate(`getComputedStyle(document.querySelector('.tool-group-summary .running-text-highlight')).animationDuration`), '2.4s')
    await driver.click(`document.querySelector('.tool-group-summary')`)
    await driver.wait(`document.querySelector('.tool-activity-group')?.open === true`)
    await driver.wait(`document.querySelector('.tool-group-summary').getAttribute('aria-expanded') === 'true'`)
    assert.equal(await driver.evaluate(`document.querySelector('.tool-group-summary .running-text-highlight') === null`), true)
    await driver.wait(`document.querySelector('summary.tool-call-summary') !== null`)
    const containment = theme === 'day'
      ? await exerciseCommandDiffContainment(driver, surface, surface === 'web' ? [768, 1440] : [1440])
      : []
    await driver.click(`document.querySelector('summary.tool-call-summary')`)
    await driver.wait(`document.body.innerText.includes('固定工具输出：已读取交互核对说明。')`)
    assert.match(await driver.evaluate('document.body.innerText'), /pnpm test -- --run/)
    assert.equal(await driver.evaluate(`document.querySelector('.execution-drawer-body').dataset.executionDisclosureAnchor`), 'true')
    const top = await driver.evaluate(`document.querySelector('summary.tool-call-summary').getBoundingClientRect().top`)
    await driver.evaluate(`document.querySelector('summary.tool-call-summary').click()`)
    await pause(150)
    const after = await driver.evaluate(`document.querySelector('summary.tool-call-summary').getBoundingClientRect().top`)
    assert.ok(Math.abs(after - top) < 2, `${surface}: collapsing a result retains the summary reading position`)
    await driver.send('Emulation.setTouchEmulationEnabled', { enabled: true })
    assert.ok(await driver.evaluate(`document.querySelector('.tool-call-summary').getBoundingClientRect().height >= 44`))
    await driver.wait(`getComputedStyle(document.querySelector('.command-expand-cue')).opacity === '1'`)
    await driver.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await driver.evaluate(`document.querySelector('.tool-group-summary').click()`)
    await driver.wait(`document.querySelector('.tool-group-summary .running-text-highlight') !== null`)
    await driver.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    assert.equal(await driver.evaluate(`getComputedStyle(document.querySelector('.running-text-highlight')).display`), 'none')
    assert.equal(await driver.evaluate(`getComputedStyle(document.querySelector('.camp-execution-orbits rect')).animationName`), 'none')
    await driver.send('Emulation.setEmulatedMedia', { features: [] })
    return [...entryActions, ...containment, 'production-current-command-and-icon', 'collapsed-running-highlight', 'expanded-static-result', 'collapse-retains-reading-anchor', 'touch-cue-and-44px-target', 'reduced-motion', ...await finishExecutionEntry(driver)]
  }
  if (scenario === 'file' && surface === 'web') {
    await mkdir(downloads, { recursive: true })
    await driver.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
    await driver.click(`document.querySelector('.attachment-card')`, 'right')
    await driver.wait(`document.querySelector('[role="menuitem"]') !== null`)
    const menu = await driver.evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).map(e=>e.textContent.trim())`)
    assert.ok(menu.includes('下载文件'))
    assert.ok(!menu.some(s=>s.includes('Finder') || s.includes('文件夹')))
    await driver.click(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.textContent.trim()==='下载文件')`)
    const path = join(downloads, 'interaction-review.md')
    let content
    for (let i = 0; i < 50; i++) { try { content = await readFile(path, 'utf8'); break } catch { await pause(100) } }
    assert.match(content ?? '', /本文件是宽屏对照稿中的固定示例/)
    await rm(path)
    return ['production-markdown-preview', 'explicit-download-adapter-saves-fixed-sample']
  }
  if (scenario === 'member') {
    await driver.click(`document.querySelector('.member-runtime-form button[aria-label^="文件系统访问，"]')`)
    await driver.wait(`document.querySelector('[role="menuitemradio"][data-state]') !== null`)
    await driver.click(`Array.from(document.querySelectorAll('[role="menuitemradio"]')).find(e=>e.textContent.trim()==='workspace-write')`)
    await driver.wait(`document.querySelector('[aria-label="保存运行配置"]')?.disabled === false`)
    await driver.click(`document.querySelector('[aria-label="保存运行配置"]')`)
    await driver.wait(`document.querySelector('.member-runtime-form .member-editor-save-status')?.textContent === '当前配置已保存'`)
    assert.equal(await driver.evaluate(`document.querySelector('.member-runtime-form button[aria-label^="文件系统访问，"]').getAttribute('aria-label')`), '文件系统访问，workspace-write')
    return ['production-runtime-form-saves-simulated-versioned-configuration']
  }
  return []
}

async function exerciseCommandDiffContainment(driver, surface, widths) {
  await driver.wait(`document.querySelector('.tool-activity-group') !== null`)
  if (!await driver.evaluate(`document.querySelector('.tool-activity-group')?.open === true`)) {
    await driver.evaluate(`document.querySelector('.tool-group-summary').click()`)
  }
  await driver.wait(`document.querySelector('.modified-file-row') !== null`)
  if (!await driver.evaluate(`document.querySelector('.modified-file-row')?.open === true`)) {
    await driver.evaluate(`document.querySelector('.modified-file-row > summary').click()`)
  }
  await driver.wait(`document.querySelector('.modified-file-row')?.open === true`)
  for (const width of widths) {
    await driver.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: width < 600 })
    await driver.wait(`innerWidth === ${width}`)
    const geometry = await driver.evaluate(`(() => {
      const virtualList = document.querySelector('.execution-virtual-list')
      const diff = document.querySelector('.modified-file-diff')
      const host = diff?.closest('.execution-drawer-body, .camp-detail-popover, .mobile-detail-panel') ?? diff?.parentElement
      if (!virtualList || !diff || !host) return null
      return {
        viewport: innerWidth,
        documentClient: document.documentElement.clientWidth,
        documentScroll: document.documentElement.scrollWidth,
        hostClient: host.clientWidth,
        hostScroll: host.scrollWidth,
        virtualClient: virtualList.clientWidth,
        virtualScroll: virtualList.scrollWidth,
        diffClient: diff.clientWidth,
        diffScroll: diff.scrollWidth
      }
    })()`)
    assert.ok(geometry, `${surface}/${width}: expanded Command diff exists`)
    assert.ok(geometry.documentScroll <= geometry.documentClient, `${surface}/${width}: Command diff does not widen the product`)
    assert.ok(geometry.virtualScroll <= geometry.virtualClient, `${surface}/${width}: virtual execution list stays inside its track`)
    assert.ok(geometry.hostScroll <= geometry.hostClient, `${surface}/${width}: execution host contains the Command view`)
    assert.ok(geometry.diffScroll > geometry.diffClient, `${surface}/${width}: wide code remains internally scrollable`)
  }
  await driver.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 920, deviceScaleFactor: 1, mobile: false })
  await driver.wait(`innerWidth === 1440`)
  return [`${surface}-command-diff-contained-at-${widths.join('-')}`]
}

async function finishExecutionEntry(driver) {
  await driver.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  assert.equal(await driver.evaluate(`getComputedStyle(document.querySelector('.camp-execution-orbits rect')).animationName`), 'none')
  await driver.send('Emulation.setEmulatedMedia', { features: [] })
  await driver.click(`document.querySelector('[aria-label="停止当前运行"]')`)
  await driver.wait(`document.querySelector('.camp-execution-entry')?.dataset.running === 'false'`)
  assert.equal(await driver.evaluate(`document.querySelector('.camp-execution-members, .camp-execution-orbits') === null`), true)
  assert.equal(await driver.evaluate(`document.querySelector('.camp-execution-entry').disabled`), false, 'history remains available after simulated stop')
  return ['entry-reduced-motion', 'simulated-stop-clears-entry-running-state']
}

async function exerciseExecutionEntry(driver, runningCount, surface) {
  const selector = '.camp-execution-entry'
  await driver.wait(`document.querySelector('${selector}')?.dataset.running === 'true'`)
  const state = await driver.evaluate(`(() => { const entry = document.querySelector('${selector}'); return {
    count: entry.querySelectorAll('.member-avatar').length, overflow: entry.querySelector('.camp-execution-overflow')?.textContent,
    label: entry.getAttribute('aria-label'), duration: getComputedStyle(entry.querySelector('rect')).animationDuration,
    strokes: [...entry.querySelectorAll('rect')].map(e => getComputedStyle(e).stroke)
  } })()`)
  assert.equal(state.count, Math.min(3, runningCount))
  assert.equal(state.overflow, runningCount > 3 ? `+${runningCount - 3}` : undefined)
  assert.match(state.label, new RegExp(`${runningCount} 位队员正在执行`))
  assert.equal(state.duration, '4.8s')
  assert.equal(new Set(state.strokes).size, 2, 'both theme token colors render')
  for (const width of surface === 'web' ? [768, 1040, 1440] : [1440]) {
    await driver.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: false })
    const bounds = await driver.evaluate(`(() => { const e = document.querySelector('${selector}'); const r = e.getBoundingClientRect(); const orbit = e.querySelector('svg.camp-execution-orbits').getBoundingClientRect(); return {
      contained: r.left >= 0 && r.right <= innerWidth && orbit.left >= r.left && orbit.right <= r.right && orbit.top >= r.top && orbit.bottom <= r.bottom,
      overflow: document.documentElement.scrollWidth > innerWidth,
      height: r.height
    } })()`)
    assert.equal(bounds.contained, true, `${surface}/${width}: orbit stays inside entry`)
    assert.equal(bounds.overflow, false, `${surface}/${width}: no horizontal overflow`)
    assert.equal(bounds.height, 28)
  }
  await driver.evaluate(`document.querySelector('${selector}').blur(); document.querySelector('${selector}').focus()`)
  await driver.wait(`document.querySelector('.camp-execution-tooltip') !== null`)
  assert.equal(await driver.evaluate(`document.querySelector('.camp-execution-tooltip').textContent`), state.label.replace('执行，', ''))
  await driver.key('Escape')
  await driver.wait(`document.querySelector('.camp-execution-tooltip') === null`)
  if (await driver.evaluate(`document.querySelector('${selector}').getAttribute('aria-expanded') === 'true'`)) await driver.click(`document.querySelector('${selector}')`)
  assert.equal(await driver.evaluate(`document.querySelector('.camp-execution-orbits') !== null`), true, 'collapsed execution retains orbit')
  await driver.click(`document.querySelector('${selector}')`)
  await driver.wait(`document.querySelector('.camp-detail-popover[data-detail="execution"]')?.hidden === false`)
  await driver.click(`document.querySelector('.run-pulse-chip')`)
  await driver.wait(`document.querySelector('.tool-group-current') !== null`)
  return ['shared-running-avatars-and-overflow', 'dual-orbit-browser-geometry', 'full-running-names-on-focus', 'collapsed-entry-retains-running-signal']
}

async function exerciseViewer(driver, path) {
  await driver.send('Page.navigate', { url: pathToFileURL(path).href })
  await driver.wait(`!!document.querySelector('#web')?.contentDocument?.querySelector('[contenteditable="true"]') && !!document.querySelector('#desktop')?.contentDocument?.querySelector('[contenteditable="true"]')`)
  assert.deepEqual(await driver.evaluate(`['desktop','web'].map(id=>{const f=document.getElementById(id); return [f.width || f.getBoundingClientRect().width, f.contentWindow.innerWidth, f.contentWindow.innerHeight, typeof f.contentWindow.rovai]})`),
    [[1440, 1440, 920, 'undefined'], [1440, 1440, 920, 'undefined']])
  await driver.evaluate(`document.querySelector('#offline').click()`)
  await driver.wait(`document.querySelector('#status').textContent.includes('模拟离线')`)
  await driver.evaluate(`document.querySelector('#surface').value='desktop'; document.querySelector('#surface').dispatchEvent(new Event('change'))`)
  assert.equal(await driver.evaluate(`document.querySelector('#offline').checked`), false, 'review surface switch preserves independent connection fixture state')
  await driver.evaluate(`document.querySelector('#theme').value='night'; document.querySelector('#theme').dispatchEvent(new Event('change')); document.querySelector('#scenario').value='approval'; document.querySelector('#scenario').dispatchEvent(new Event('change'))`)
  await driver.wait(`['desktop','web'].every(id=>{const d=document.getElementById(id).contentDocument; return d?.documentElement?.dataset.theme==='night' && Array.from(d.querySelectorAll('button')).some(e=>e.textContent.trim()==='Allow once')})`)
  await driver.wait(`scrollY === 0 && document.documentElement.scrollHeight <= 1150`)
  assert.deepEqual(driver.errors.splice(0), [], 'standalone reviewer loads srcdoc modules and controls without exceptions')
  return { simulation: true, file: 'rovai-desktop-web-parity.html', checks: ['two-production-frames', 'isolated-surface-state', 'theme-and-scenario-reset', 'inactive-frame-does-not-create-blank-scroll-page'] }
}

async function launch(surface, profile) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const args = surface === 'web'
    ? ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank']
    : [join(root, 'scripts/fixtures/host-web-parity/main.cjs'), profile]
  const child = spawn(surface === 'web' ? chrome : electron, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = new Promise(resolve => child.once('close', resolve))
  let log = ''; child.stdout.on('data', c => { log += c }); child.stderr.on('data', c => { log += c })
  let socket
  try {
    let port
    for (let i = 0; i < 150; i++) { port = log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1]; if (port) break; await pause(100) }
    assert.ok(port, log.slice(-2000))
    let target
    for (let i = 0; i < 100; i++) { target = (await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json())).find(t => t.type === 'page'); if (target) break; await pause(100) }
    assert.ok(target)
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    let id = 0; const pending = new Map(); const errors = []
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)); const p = pending.get(message.id)
      if (p) { pending.delete(message.id); message.error ? p.reject(message.error) : p.resolve(message.result) }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
    await send('Page.enable'); await send('Runtime.enable')
    // Headless Chrome can have DOM focus while its page is unfocused. Exercise
    // focus tooltips in the same foreground state as an active browser tab.
    if (surface === 'web') await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 920, deviceScaleFactor: 1, mobile: false })
    const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value }
    return { send, evaluate, errors,
      async key(key) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : 27 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : 27 }) },
      async click(expression, button = 'left') {
        const point = await evaluate(`(() => { const e = ${expression}; if (!e) throw Error('Click target missing: ' + ${JSON.stringify(expression)}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 } })()`)
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: 1 })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: 1 })
      },
      async wait(expression) { for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; if (errors.length) throw Error(errors.join('\n')); await pause(100) } throw Error(`Timed out: ${expression}\n${await evaluate('document.body.innerText.slice(-4000)')}`) },
      async capture(path) { const r = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(path, Buffer.from(r.data, 'base64')) },
      async close() { socket.close(); child.kill('SIGTERM'); await closed }
    }
  } catch (error) { socket?.close(); child.kill('SIGTERM'); await closed; throw error }
}

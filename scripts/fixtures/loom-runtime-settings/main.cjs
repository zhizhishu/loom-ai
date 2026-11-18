const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const [renderer, userData, output] = process.argv.slice(2)
for (const item of [renderer, userData, output]) assert(path.isAbsolute(item))
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', userData)
app.setPath('sessionData', path.join(userData, 'session'))
const cases = [], shots = []
let stage = 'startup'
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 920, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  const js = async expression => {
    const result = await win.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await (${expression})}}catch(error){return {ok:false,error:String(error)}}})()`, true)
    if (!result.ok) throw new Error(result.error + ' while evaluating ' + expression.slice(0, 180))
    return result.value
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const wait = async expression => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) { if (await js(expression)) return; await sleep(40) }
    throw new Error('Timeout: ' + expression)
  }
  const click = async selector => {
    // Opening dialogs animate; wait for the actual pointer target, not just an early DOM node.
    await wait(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)})
      if (!e || e.disabled) return false
      e.scrollIntoView({ block: 'center' })
      const r = e.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2)
      const hit = document.elementFromPoint(x, y)
      return r.width > 0 && r.height > 0 && (hit === e || e.contains(hit))
    })()`)
    const point = await js(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)})
      if (!e || e.disabled) throw new Error('Target missing or disabled')
      e.scrollIntoView({ block: 'center' })
      const r = e.getBoundingClientRect(), x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2)
      const hit = document.elementFromPoint(x, y)
      if (hit !== e && !e.contains(hit)) throw new Error('Target covered')
      return { x, y }
    })()`)
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    await sleep(70)
  }
  const fill = async (selector, value) => {
    await click(selector)
    win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] })
    await win.webContents.insertText(value)
    await wait(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`)
  }
  // The hidden compositor can emit a cached frame after a resize/theme update.
  // Observe a temporary fixture-only corner marker, then its removal, so the
  // saved image is a newly painted production UI with no test marker in it.
  const captureFrame = async () => {
    const size = await js('({ width: Math.round(innerWidth * devicePixelRatio), height: Math.round(innerHeight * devicePixelRatio) })')
    const frame = marked => new Promise((resolve, reject) => {
      const finish = (error, image) => {
        clearTimeout(timer)
        win.webContents.off('paint', onPaint)
        if (error) reject(error); else resolve(image)
      }
      const onPaint = (_event, _dirty, image) => {
        const actual = image.getSize()
        if (actual.width !== size.width || actual.height !== size.height || image.isEmpty()) return
        const pixel = ((size.height - 2) * size.width + size.width - 2) * 4
        const bitmap = image.getBitmap()
        const hasMarker = bitmap[pixel] === 93 && bitmap[pixel + 1] === 211 && bitmap[pixel + 2] === 17
        if (hasMarker === marked) finish(null, image)
      }
      const timer = setTimeout(() => finish(new Error('No current offscreen frame at ' + JSON.stringify(size))), 10_000)
      win.webContents.on('paint', onPaint)
    })
    const marked = frame(true)
    await js(`(() => {
      const marker = document.createElement('div')
      marker.id = 'qa-paint-marker'
      marker.style.cssText = 'position:fixed;right:0;bottom:0;width:4px;height:4px;background:rgb(17,211,93);z-index:2147483647;pointer-events:none'
      document.body.appendChild(marker)
    })()`)
    win.webContents.invalidate()
    await marked
    const clean = frame(false)
    await js("document.getElementById('qa-paint-marker').remove()")
    win.webContents.invalidate()
    return clean
  }
  const close = '.ln-runtime-settings > .ln-surface-title [aria-label="关闭窗口"]'
  const edit = '.ln-runtime-settings textarea'
  const save = '.ln-runtime-settings button[type=submit]'
  const openCodex = async (advanced = true) => {
    await click('[aria-label="Codex 连接设置"]')
    await wait("!!document.querySelector('.ln-runtime-settings input[aria-label=\"设置值 1\"]:not(:disabled)')")
    if (advanced) {
      await click('.common-environment-field-actions button:last-child')
      await wait("!!document.querySelector('.ln-runtime-settings textarea:not(:disabled)')")
    }
  }
  const report = (ok, extra = {}) => {
    const value = { ok, scope: 'production-react-with-in-memory-transport', realCore: false, realRuntime: false,
      visibleWindow: win.isVisible(), cases, shots, ...extra }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(value, null, 2))
    console.log(JSON.stringify(value))
    return value
  }
  try {
    await win.loadFile(renderer)
    await wait('!!window.runtimeSettingsQA')
    win.webContents.focus()
    await click('#open-setup')
    await wait("document.querySelectorAll('.ln-runtime-card').length === 4")
    for (const [label, kind] of [['Claude Code', 'claude-code-cli'], ['Codex', 'codex-cli'], ['DSH', 'deepseek-harness'], ['Pi', 'pi']]) {
      stage = 'open ' + kind
      await click('[aria-label="' + label + ' 连接设置"]')
      await wait("!!document.querySelector('.ln-runtime-settings input[aria-label=\"设置值 1\"]:not(:disabled)')")
      assert(await js(`document.querySelector('.ln-runtime-settings').innerText.includes(${JSON.stringify((kind === 'codex-cli' ? 'Codex CLI' : label) + ' 连接设置')})`))
      assert(await js(`runtimeSettingsQA.calls.some(row => row.method === 'runtime.startup.get' && row.params.runtimeKind === '${kind}')`))
      await click(close)
      await wait("!document.querySelector('.ln-runtime-settings')")
    }
    cases.push('four production runtime cards open their own saved settings')
    assert.equal(await js('runtimeSettingsQA.writes.length'), 0)

    stage = 'save and read back'
    await openCodex(false)
    const firstValue = '.ln-runtime-settings input[aria-label="设置值 1"]'
    assert.equal(await js(`document.querySelector('${firstValue}').value`), 'initial fixture value')
    assert.equal(await js(`document.querySelector('${firstValue}').type`), 'password')
    assert.equal(await js(`!!document.querySelector('${edit}')`), false)
    await fill(firstValue, 'saved via production editor')
    await click(save)
    await wait("document.querySelector('.member-editor-save-status')?.textContent.includes('已保存')")
    const firstWrite = await js('runtimeSettingsQA.writes[0]')
    assert.equal(firstWrite.runtimeKind, 'codex-cli')
    assert.deepEqual(firstWrite.edits, [])
    assert.equal(firstWrite.commonEnvironment.expectedRevision, 7)
    assert.deepEqual(JSON.parse(firstWrite.commonEnvironment.json), { LOOM_QA_NOTE: 'saved via production editor' })
    await click(close); await wait("!document.querySelector('.ln-runtime-settings')")
    await openCodex(false)
    assert.equal(await js(`document.querySelector('${firstValue}').value`), 'saved via production editor')
    cases.push('ordinary fields save through runtime.startup.save and reopen without editing JSON')

    stage = 'field values and invalid draft names'
    await click('[aria-label="显示设置值 1"]')
    assert.equal(await js(`document.querySelector('${firstValue}').type`), 'text')
    assert.equal(await js(`document.querySelector('${save}').disabled`), true)
    await click('[aria-label="隐藏设置值 1"]')
    assert.equal(await js(`document.querySelector('${firstValue}').type`), 'password')
    cases.push('values are hidden by default and revealing them neither saves nor dirties settings')
    await click('.common-environment-field-actions button:first-child')
    await fill('[aria-label="设置名称 2"]', 'LOOM_QA_NOTE')
    await fill('[aria-label="设置值 2"]', 'duplicate draft is retained')
    await click(save)
    await wait("document.querySelector('.environment-error')?.textContent.includes('变量名重复')")
    assert.equal(await js('runtimeSettingsQA.writes.length'), 1)
    assert.equal(await js("document.querySelector('[aria-label=\"设置值 2\"]').value"), 'duplicate draft is retained')
    await fill('[aria-label="设置名称 2"]', '')
    await click(save)
    await wait("document.querySelector('.environment-error')?.textContent.includes('变量名只能')")
    assert.equal(await js('runtimeSettingsQA.writes.length'), 1)
    await click('[aria-label="删除设置 2"]')
    await wait(`document.querySelector('${save}').disabled`)
    assert.equal(await js('document.querySelectorAll(".common-environment-row").length'), 1)
    assert.equal(await js('runtimeSettingsQA.writes.length'), 1)
    cases.push('duplicate and incomplete field names cannot save or discard a draft value; removing a new row restores the saved state')
    await click('.common-environment-field-actions button:last-child')
    await wait(`!!document.querySelector('${edit}')`)

    stage = 'draft leave guard'
    const draft = JSON.stringify({ LOOM_QA_NOTE: 'unsaved draft stays here' }, null, 2)
    await fill(edit, draft)
    await click('.runtime-startup-back')
    await wait("document.querySelector('.ln-room-dialog')?.innerText.includes('放弃更改？')")
    assert.equal(await js('runtimeSettingsQA.writes.length'), 1)
    await click('.ln-room-dialog .ln-form-actions button:first-child')
    await wait("!document.querySelector('.ln-room-dialog')")
    assert.equal(await js(`document.querySelector('${edit}').value`), draft)
    assert.equal(await js('runtimeSettingsQA.writes.length'), 1)
    cases.push('cancel leaving preserves unsaved JSON without a write')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await wait("!!document.querySelector('.ln-room-dialog')")
    await click('.ln-room-dialog > .ln-surface-title [aria-label="关闭窗口"]')
    await wait("!document.querySelector('.ln-room-dialog')")
    assert.equal(await js(`document.querySelector('${edit}').value`), draft)
    cases.push('Escape and confirmation close retain the same draft')
    await click('.runtime-startup-back')
    await wait("!!document.querySelector('.ln-room-dialog')")
    await click('.ln-room-dialog .ln-form-actions button:last-child')
    await wait("!document.querySelector('.ln-runtime-settings')")
    await openCodex()
    assert.equal(await js(`JSON.parse(document.querySelector('${edit}').value).LOOM_QA_NOTE`), 'saved via production editor')
    assert.equal(await js('runtimeSettingsQA.writes.length'), 1)
    cases.push('explicit discard returns to the saved configuration without a write')

    stage = 'conflict rebase'
    await fill('.runtime-startup-path input', 'C:/LOOM-QA/local-codex.exe')
    await js('runtimeSettingsQA.conflictOnce()')
    await click(save)
    await wait("!!document.querySelector('.runtime-save-conflict')")
    assert(await js(`document.querySelector('${save}').disabled`))
    assert.equal(await js("document.querySelector('.runtime-startup-path input').value"), 'C:/LOOM-QA/local-codex.exe')
    await click('.runtime-conflict-use-mine')
    await click(save)
    await wait("document.querySelector('.member-editor-save-status')?.textContent.includes('已保存')")
    const rebased = await js('runtimeSettingsQA.writes[2]')
    assert.equal(rebased.edits[0].before, 'C:/LOOM-QA/external-codex.exe')
    assert.equal(rebased.edits[0].after, 'C:/LOOM-QA/local-codex.exe')
    assert.equal(await js("runtimeSettingsQA.stored('codex-cli').configuration.programPath"), 'C:/LOOM-QA/local-codex.exe')
    cases.push('version conflict retains edits and explicit resolution uses the updated baseline')

    stage = 'responsive themes'
    await click('.common-environment-field-actions button:last-child')
    await wait(`!document.querySelector('${edit}')`)
    for (const [width, height] of [[1440, 920], [390, 844]]) for (const theme of ['day', 'night']) {
      win.setContentSize(width, height)
      await js(`runtimeSettingsQA.setTheme('${theme}')`)
      await sleep(160)
      const geometry = await js(`(() => {
        const e = document.querySelector('.ln-runtime-settings'), r = e.getBoundingClientRect()
        const parts = [e, ...e.querySelectorAll('.ln-room-content,.runtime-startup-form,.runtime-startup-actions,.common-environment-section')]
        return { left: r.left, right: r.right, viewport: innerWidth,
          overflow: parts.filter(x => x.scrollWidth > x.clientWidth + 1).map(x => x.className),
          theme: e.closest('.ln-portal').dataset.theme, scheme: getComputedStyle(e).colorScheme,
          background: getComputedStyle(e).backgroundColor, text: getComputedStyle(e).color }
      })()`)
      assert(geometry.left >= -1 && geometry.right <= geometry.viewport + 1, JSON.stringify(geometry))
      assert.deepEqual(geometry.overflow, [], JSON.stringify(geometry))
      assert.equal(geometry.theme, theme)
      assert.equal(geometry.scheme, theme === 'night' ? 'dark' : 'light')
      const file = path.join(output, width + '-' + theme + '.png')
      fs.writeFileSync(file, (await captureFrame()).toPNG())
      shots.push({ width, height, theme, path: file, geometry })
    }
    cases.push('desktop and mobile day and night dialogs stay within their viewport')
    assert.equal(win.isVisible(), false)
    assert.equal(await js("runtimeSettingsQA.calls.some(row => /runtime\\.(product|discovery|modelCatalog|startup\\.check)/.test(row.method))"), false)
    cases.push('opening and editing never launches a runtime or calls discovery')
    report(true)
    win.destroy(); app.exit(0)
  } catch (error) {
    try { fs.writeFileSync(path.join(output, 'failure.png'), (await captureFrame()).toPNG()) } catch {}
    report(false, { stage, error: String(error), stack: error.stack })
    win.destroy(); app.exit(1)
  }
})

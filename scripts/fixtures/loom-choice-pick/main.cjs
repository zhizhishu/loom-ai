const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const [renderer, userData, reportPath, helperPath] = process.argv.slice(2)
for (const item of [renderer, userData, reportPath, helperPath]) assert(path.isAbsolute(item))
fs.mkdirSync(userData, { recursive: true })
app.setPath('userData', userData)
app.setPath('sessionData', path.join(userData, 'session'))
app.whenReady().then(async () => {
  const { radioChoiceSelector } = await import(pathToFileURL(helperPath).href)
  const win = new BrowserWindow({ show: false, width: 960, height: 700, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  const js = expression => win.webContents.executeJavaScript(expression, true)
  const wait = async expression => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) { if (await js(expression)) return; await new Promise(done => setTimeout(done, 30)) }
    throw new Error('choice fixture wait timed out')
  }
  const locate = selector => selector.startsWith('xpath=')
    ? 'document.evaluate(' + JSON.stringify(selector.slice(6)) + ',document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null)'
    : null
  const count = selector => locate(selector) + '.snapshotLength'
  const element = selector => selector.startsWith('xpath=') ? locate(selector) + '.snapshotItem(0)' : 'document.querySelector(' + JSON.stringify(selector) + ')'
  const pointer = async selector => {
    const point = await js('(() => { const e=' + element(selector) + '; if(!e||e.disabled)throw new Error("missing or disabled"); const r=e.getBoundingClientRect(); const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2); const hit=document.elementFromPoint(x,y); if(hit!==e&&!e.contains(hit))throw new Error("covered"); return {x,y} })()')
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  }
  const cases = []
  try {
    await win.loadFile(renderer)
    await wait('!!window.choiceQA')
    assert.equal(await js('document.querySelector(\'[aria-label="Pi Purge 模式"]\').disabled'), true)
    await js('window.choiceQA.enable()')
    win.webContents.focus()
    for (const [kind, title, label] of [['purge','Pi Purge 模式','追加助手设定'], ['access','文件与任务权限','读写文件并处理任务']]) {
      const trigger = '.ln-studio button[aria-label="' + title + '"]'
      const option = radioChoiceSelector(label)
      await wait('(() => {const e=' + element(trigger) + ';return !!e&&!e.disabled&&e.getAttribute("aria-disabled")!=="true"})()')
      assert.equal(await js(count(option)), 0, 'the option selector must be usable before the portal exists')
      await pointer(trigger)
      await wait(count(option) + '===1')
      assert.equal(await js(element(option) + '.getAttribute("role")'), 'menuitemradio')
      await pointer(option)
      await wait(element(trigger) + '.querySelector(":scope > span").textContent.trim()===' + JSON.stringify(label))
      await wait(count(option) + '===0')
      assert.equal(await js('choiceQA.changes.' + kind), 1)
      await pointer(trigger)
      await wait(count(option) + '===1')
      assert.equal(await js(element(option) + '.getAttribute("aria-checked")'), 'true', 'idempotent picker can observe the selected state')
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await wait(count(option) + '===0')
      assert.equal(await js('choiceQA.changes.' + kind), 1)
      cases.push({ kind, uniqueRoleTarget: true, controlledValueConfirmed: true, selectedStateObservable: true })
    }
    assert(await js('choiceQA.trustedPointers>=4'))
    assert.equal(win.isVisible(), false)
    const report = { ok: true, realCore: false, realModel: false, realBrowserDoor: false,
      visibleWindow: false, productionChoiceMenu: true, disabledGateVerified: true, cases }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
    win.destroy(); app.exit(0)
  } catch(error) {
    fs.writeFileSync(reportPath, JSON.stringify({ ok: false, error: String(error), cases }, null, 2))
    win.destroy(); app.exit(1)
  }
}).catch(error => {
  fs.writeFileSync(reportPath, JSON.stringify({ ok: false, stage: 'fixture_startup', error: String(error) }, null, 2))
  console.error(error)
  app.exit(1)
})


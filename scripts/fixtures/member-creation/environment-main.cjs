const assert = require('node:assert/strict')
const { mkdirSync } = require('node:fs')
const { isAbsolute, join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow } = require('electron')
const [renderer, userData] = process.argv.slice(2)
assert(isAbsolute(renderer) && isAbsolute(userData))
mkdirSync(join(userData, 'managed-skill-library'), { recursive: true })
app.setPath('userData', userData)
app.setPath('sessionData', join(userData, 'session'))
let window
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: process.platform === 'linux', width: 1440, height: 920, useContentSize: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const run = async expression => {
    try { return await window.webContents.executeJavaScript(expression, true) }
    catch (error) { throw new Error(`Renderer expression failed: ${expression}`, { cause: error }) }
  }
  const wait = async expression => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await run(expression)) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(`Timed out: ${expression}`)
  }
  const settle = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const click = async (selector, text) => {
    await run(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.checkVisibility() ${text ? `&& node.textContent.trim() === ${JSON.stringify(text)}` : ''})?.scrollIntoView({ block: 'nearest' })`)
    await settle()
    const point = await run(`(() => {
      const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.checkVisibility() ${text ? `&& node.textContent.trim() === ${JSON.stringify(text)}` : ''});
      if (!node) throw new Error('Missing ' + ${JSON.stringify(selector + ':' + (text ?? ''))});
      node.scrollIntoView({ block: 'nearest' }); const box = node.getBoundingClientRect();
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    })()`)
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    await settle()
  }
  const fill = async (selector, text) => {
    await wait(`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`)
    await click(selector)
    await run('document.activeElement.select()')
    await window.webContents.insertText(text)
    await settle()
  }
  await window.loadURL(pathToFileURL(renderer).href + '?flow=environment')
  await run('window.memberCreationQA.language("zh-CN")')
  await settle()
  const member = '.member-editor-page:not([hidden]) '
  const common = '.common-environment-section textarea'
  const draft = '{"API_TIMEOUT_MS":"90000"}'
  await wait(`document.querySelector('${member}.member-environment-entry')`)
  await click(member + '.member-environment-entry')
  await wait(`document.querySelector('${member}.environment-inherit-row')`)
  await fill(member + '.member-environment-json', '{"LOCAL":"member-draft"}')
  const openCommon = async () => {
    await click(member + '.environment-text-link', '编辑通用配置')
    await wait(`document.querySelector('${common}') && !document.querySelector('${common}').disabled`)
  }
  await openCommon()
  await fill(common, draft)
  await click('.settings-sidebar-back')
  await wait('!!document.querySelector("[role=dialog]")')
  await click('[role=dialog] button', '继续编辑')
  assert.equal(await run(`document.querySelector('${common}').value`), draft)
  await click('.settings-sidebar-back')
  await wait('!!document.querySelector("[role=dialog]")')
  await click('[role=dialog] button', '放弃更改')
  await wait('!document.querySelector(".runtime-startup-page")')
  assert.equal(await run(`document.querySelector('${member}.member-environment-json').value`), '{"LOCAL":"member-draft"}')
  await openCommon()
  assert.equal(await run(`JSON.parse(document.querySelector('${common}').value).API_TIMEOUT_MS`), '60000')
  await fill(common, draft)
  await click('.settings-sidebar-menu button', '外观')
  await wait('document.querySelector(".appearance-settings-page")?.checkVisibility()')
  await click('.settings-sidebar-back')
  await wait('!!document.querySelector("[role=dialog]")')
  await click('[role=dialog] button', '继续编辑')
  assert.equal(await run('document.querySelector(".appearance-settings-page").checkVisibility()'), true)
  await click('.settings-sidebar-menu button', '智能体')
  await wait(`document.querySelector('${common}').checkVisibility()`)
  assert.equal(await run(`document.querySelector('${common}').value`), draft)
  await click('.runtime-startup-back')
  await wait('!!document.querySelector("[role=dialog]")')
  await click('[role=dialog] button', '放弃更改')
  await wait('!document.querySelector(".runtime-startup-page")')
  assert.equal(await run('!!document.querySelector("[role=dialog]")'), false)
  await openCommon()
  await click('.settings-sidebar-back')
  await wait('!document.querySelector(".runtime-startup-page")')
  assert.equal(await run('!!document.querySelector("[role=dialog]")'), false)
  assert.deepEqual(await run('window.memberCreationQA.errors'), [])
  console.log(JSON.stringify({ ok: true, cases: ['global return cancels without losing common draft', 'discard returns with member draft intact', 'category switch retains draft and leave guard', 'local return confirms once', 'clean global return needs no confirmation'] }))
  window.destroy()
  app.exit(0)
}).catch(async error => {
  console.error(error)
  if (window) console.error(await window.webContents.executeJavaScript('({body:document.body.innerText, errors:window.memberCreationQA?.errors})'))
  window?.destroy()
  app.exit(1)
})

const assert = require('node:assert/strict')
module.exports = async ({ window, run, settle, platform, defaults }) => {
  await run(`window.shortcutTest.save(${JSON.stringify(defaults)}); window.shortcutTest.openFile('docs/shortcut.html')`)
  await settle()
  window.webContents.debugger.attach('1.3')
  const key = async (key, modifiers = []) => {
    const input = { key: key.length === 1 ? key.toLowerCase() : key, code: key.length === 1 ? `Key${key}` : key,
      windowsVirtualKeyCode: key === 'Escape' ? 27 : key.charCodeAt(0),
      modifiers: modifiers.reduce((mask, modifier) => mask | ({ alt: 1, control: 2, meta: 4, shift: 8 }[modifier]), 0) }
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...input })
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...input }); await settle()
  }
  const stage = '.file-preview-tab-panel:not([hidden]) .file-preview-html-stage'
  for (let n = 0; n < 100 && !await run(`document.querySelector('${stage}')?.dataset.channelState === 'connected'`); n++) await settle()
  assert(await run(`document.querySelector('${stage}')?.dataset.channelState === 'connected'`))
  const frame = () => window.webContents.mainFrame.framesInSubtree.find(frame => frame.url.includes('/docs/shortcut.html'))
  const inside = async (nested = false) => {
    const target = nested ? frame().frames.find(child => child.url.includes('/docs/child.html')) : frame()
    assert(target, 'The requested preview document has loaded')
    await target.executeJavaScript(`window.shortcutPointer = null; document.addEventListener('pointerdown', event => { window.shortcutPointer = { trusted: event.isTrusted, target: event.target.id } }, { once: true })`)
    const rect = await target.executeJavaScript('document.querySelector("#inside").getBoundingClientRect().toJSON()')
    const outer = await run(`document.querySelector('${stage} iframe').getBoundingClientRect().toJSON()`)
    const offset = nested ? await frame().executeJavaScript(`(() => { const iframe = document.querySelector('iframe'), rect = iframe.getBoundingClientRect(); return { x: rect.x + iframe.clientLeft, y: rect.y + iframe.clientTop } })()`) : { x: 0, y: 0 }
    const x = Math.round(outer.x + offset.x + rect.x + rect.width / 2), y = Math.round(outer.y + offset.y + rect.y + rect.height / 2)
    // An authenticated iframe can precede its first compositor hit-test surface.
    // Establish a real pointer target before testing keys; shortcut attempts are never retried.
    for (let attempt = 0; attempt < 20; attempt++) {
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); await settle()
      if (await target.executeJavaScript('window.shortcutPointer !== null')) break
    }
    assert.deepEqual(await target.executeJavaScript('window.shortcutPointer'), { trusted: true, target: 'inside' }, 'A trusted pointer reaches the actual HTML control')
    assert(await run(`document.activeElement === document.querySelector('${stage} iframe')`))
  }
  const opened = () => run('!!document.querySelector(".file-find-surface")')
  await run(`window.shortcutHtmlMessages = []; window.addEventListener('message', event => { if (event.data?.type === 'find-open') window.shortcutHtmlMessages.push(event.data) })`)
  const primary = platform === 'darwin' ? 'meta' : 'control'
  await inside(); await key('F', [primary]); assert(await opened(), 'Default find works inside HTML')
  await key('Escape')
  const changed = structuredClone(defaults); changed.bindings.find = 'Alt+F'
  await run(`window.shortcutTest.save(${JSON.stringify(changed)})`); await settle()
  await inside(); await key('F', [primary]); assert(!await opened(), 'Old HTML find key stops working after live remapping')
  await key('F', ['alt']); assert(await opened(), 'New HTML find key works after live remapping')
  await key('Escape')
  await inside(true); await key('F', [primary]); assert(!await opened(), 'Nested documents drop the old binding too')
  await key('F', ['alt']); assert(await opened(), 'Nested documents receive the live binding')
  await key('Escape')
  await frame().executeJavaScript(`document.querySelector('iframe').src = './child.html?reconnected=1'`)
  for (let n = 0; n < 100 && !frame().frames.some(child => child.url.includes('reconnected=1')); n++) await settle()
  await settle(); await inside(true); await key('F', ['alt']); assert(await opened(), 'A new child connection receives the saved binding')
  await key('Escape')
  changed.bindings.find = null
  await run(`window.shortcutTest.save(${JSON.stringify(changed)})`); await settle()
  await inside(); await key('F', [primary]); assert(!await opened(), 'Clearing disables the former default')
  await key('F', ['alt']); assert(!await opened(), 'Clearing disables the former custom binding')
  await inside(true); await key('F', ['alt']); assert(!await opened(), 'Clearing also reaches the nested document')
  await inside()
  const stale = await run('window.shortcutHtmlMessages.at(-1)')
  await frame().executeJavaScript(`parent.postMessage(${JSON.stringify(stale)}, '*')`); await settle()
  assert(!await opened(), 'The host rejects an in-flight find request from a cleared binding')
  await frame().executeJavaScript('location.reload()').catch(() => {})
  await settle()
  for (let n = 0; n < 100 && !await run(`document.querySelector('${stage}')?.dataset.channelState === 'connected'`); n++) await settle()
  await inside(); await key('F', [primary]); assert(!await opened(), 'Reload keeps an unbound shortcut unbound')
  changed.bindings.find = platform === 'darwin' ? 'Ctrl+F' : 'Mod+Alt+Shift+F'
  await run(`window.shortcutTest.save(${JSON.stringify(changed)})`); await settle()
  await inside(); await key('F', [primary]); assert(!await opened(), 'Only the exact configured modifiers match')
  const exact = platform === 'darwin' ? ['control'] : ['control', 'alt', 'shift']
  await key('F', exact); assert(await opened(), 'Control and Command remain distinct in the iframe')
  await key('Escape'); await inside()
  await run(`const modal = document.createElement('div'); modal.className = 'app-dialog'; modal.id = 'html-shortcut-modal'; document.body.appendChild(modal)`)
  await key('F', exact); assert(!await opened(), 'HTML requests obey the shared modal guard')
  await run(`document.querySelector('#html-shortcut-modal').remove()`)
  await key('F', exact); assert(await opened(), 'Dispatch resumes once the modal closes')
  await key('Escape')
  await run(`window.shortcutTest.save(${JSON.stringify(defaults)})`); await settle()
  await inside(); await key('F', [primary]); assert(await opened(), 'Restoring defaults updates the existing iframe')
  await key('Escape')
  window.webContents.debugger.detach()
  console.log(`HTML find (${platform}): actual iframe pointer/keyboard input honors live remapping, clearing, nested/reloaded documents, exact modifiers and modal guards`)
}

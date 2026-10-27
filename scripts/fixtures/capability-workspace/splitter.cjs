const assert = require('node:assert/strict')

module.exports = async ({ run, click, key, settle, window }) => {
  const state = () => run(`(() => {
    const h = [...document.querySelectorAll('.capability-divider')].find(n => n.getBoundingClientRect().width > 0)
    const root = h.closest('[style*="--capability-list-width"]'), r = h.getBoundingClientRect()
    return { width: Number(h.getAttribute('aria-valuenow')), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 80),
      scale: root.getBoundingClientRect().width / root.offsetWidth, active: root.hasAttribute('data-resizing') }
  })()`)
  const mouse = (type, p) => window.webContents.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1,
    modifiers: type === 'mouseUp' ? [] : ['leftButtonDown'] })
  const begin = async () => {
    const p = await state(); mouse('mouseMove', p); mouse('mouseDown', p); await settle(); return p
  }
  const storage = key => run(`localStorage.getItem(${JSON.stringify(key)})`)
  const pages = [
    ['Skills', 'rovai.native-skills-list-width.v1', 368],
    ['工具箱', 'rovai.toolbox-list-width.v1', 392],
    ['MCP', 'rovai.capability-list-width.v1', 416]
  ]
  for (const [label, storageKey, width] of pages) {
    await click(label)
    assert.equal((await state()).width, 320)
    const p = await begin()
    // Deliberately omit pointermove: release must provide the final coordinate itself.
    mouse('mouseUp', { ...p, x: p.x + width - p.width }); await settle()
    assert.equal((await state()).width, width, label + ': fast release keeps the final width')
    assert.equal(await storage(storageKey), String(width))
    const cancel = await begin()
    mouse('mouseMove', { ...cancel, x: cancel.x - 100 }); await settle()
    await key('Escape')
    mouse('mouseUp', { ...cancel, x: cancel.x - 100 }); await settle()
    assert.equal((await state()).width, width, label + ': Escape restores the stable width')
    assert.equal(await storage(storageKey), String(width))
  }
  for (const [label, , width] of pages) {
    await click(label)
    assert.equal((await state()).width, width, label + ': independent page preference survives navigation')
  }
  await run('document.documentElement.style.zoom = "0.8"'); await settle()
  let p = await begin()
  mouse('mouseUp', { ...p, x: Math.round(p.x + (480 - p.width) * p.scale) }); await settle()
  assert.equal((await state()).width, 480, 'CSS zoom converts screen distance to logical width')
  assert.equal(await storage(pages[2][1]), '480')
  await run('document.documentElement.style.zoom = ""'); await settle()
  p = await begin()
  mouse('mouseMove', { ...p, x: p.x - 60 }); await settle()
  await run(`document.querySelector('[data-resizing][style*="--capability-list-width"]').style.height = '600px'`)
  await settle()
  assert.equal((await state()).width, 420, 'Height-only observation never resets the live width')
  await run('window.dispatchEvent(new Event("blur"))'); await settle()
  mouse('mouseUp', { ...p, x: p.x - 60 }); await settle()
  assert.equal((await state()).width, 420, 'Blur settles the last observed width instead of restoring the old width')
  assert.equal(await storage(pages[2][1]), '420')
  await run(`document.querySelectorAll('[style*="--capability-list-width"]').forEach(n => n.style.height = '')`)
  p = await begin()
  mouse('mouseUp', { ...p, x: p.x - 400 }); await settle()
  assert.equal((await state()).width, 240, 'Resize-only lists retain their minimum even beyond the fold distance')
  assert.equal((await state()).active, false)
  for (const [label, storageKey] of pages) {
    await click(label)
    await run(`[...document.querySelectorAll('.capability-divider')].find(n => n.getBoundingClientRect().width > 0).focus()`)
    await key('Enter')
    assert.equal((await state()).width, 320)
    assert.equal(await storage(storageKey), null)
  }
  await click('Skills')
}

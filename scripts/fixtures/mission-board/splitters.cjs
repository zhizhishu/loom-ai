const assert = require('node:assert/strict')

module.exports = async ({ window, waitFor, click, settle }) => {
  const run = code => window.webContents.executeJavaScript(code, true)
  const frame = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const mouse = (type, p, clickCount = 1) => window.webContents.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount,
    modifiers: type === 'mouseUp' ? [] : ['leftButtonDown'] })
  const geometry = selector => run(`(() => { const h = document.querySelector(${JSON.stringify(selector)}), r = h.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(80, r.height / 2)), width: Number(h.getAttribute('aria-valuenow')) }; })()`)
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 2, `${actual} != ${expected}`)
  const exercise = async (selector, direction) => {
    let start = await geometry(selector)
    mouse('mouseMove', start); mouse('mouseDown', start); await frame()
    let end = { ...start, x: start.x + 40 * direction }
    mouse('mouseUp', end); await frame()
    near((await geometry(selector)).width, start.width + 40)
    start = await geometry(selector)
    mouse('mouseMove', start); mouse('mouseDown', start); await frame()
    end = { ...start, x: start.x - 60 * direction }
    mouse('mouseMove', end); await frame()
    await run('window.dispatchEvent(new Event("blur"))'); await frame()
    mouse('mouseUp', end); await frame()
    near((await geometry(selector)).width, start.width - 60)
    // The stationary second click after a drag must not reset/expand the pane.
    const after = await geometry(selector)
    mouse('mouseMove', after); mouse('mouseDown', after, 2); mouse('mouseUp', after, 2); await frame()
    near((await geometry(selector)).width, after.width)
    start = await geometry(selector)
    mouse('mouseMove', start); mouse('mouseDown', start); await frame()
    end = { ...start, x: start.x + 30 * direction }
    mouse('mouseMove', end); await frame()
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await frame()
    mouse('mouseUp', end); await frame()
    near((await geometry(selector)).width, start.width)
  }
  await waitFor('!!document.querySelector(".mission-board-card")', 'Mission board did not load')
  await click('.mission-board-card')
  await waitFor('!!document.querySelector(".mission-drawer-resize-handle")', 'Mission drawer did not open')
  await waitFor('!!document.querySelector(".file-preview-expand-toggle")', 'Preview expand control did not appear')
  await click('.file-preview-expand-toggle')
  await waitFor('!!document.querySelector(".workspace-grid.file-preview-expanded")', 'Mission preview did not expand')
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await frame()
  assert.equal(await run('!!document.querySelector(".mission-drawer") && !document.querySelector(".workspace-grid.file-preview-expanded")'), true,
    'Escape restores the preview split before closing its Mission drawer')
  await exercise('.mission-drawer-resize-handle', -1)
  if (!await run('document.querySelector(".mission-activity-entry")?.getAttribute("aria-pressed") === "true"')) await click('.mission-activity-entry')
  await frame()
  await waitFor('!!document.querySelector(".mission-changes-disclosure")', 'Activity did not open')
  await click('.mission-changes-disclosure')
  await waitFor('!!document.querySelector("#mission-detail-tree [data-file-id]")', 'Changed files did not load')
  // Opening a file is setup; native pointer input below exercises the production divider.
  await run('document.querySelector("#mission-detail-tree [data-file-id]").click()')
  await waitFor('!!document.querySelector(".diff-resize-handle")', 'Diff did not open')
  await settle()
  await exercise('.diff-resize-handle', 1)
  assert.equal(await run('!!document.querySelector(".mission-diff-dialog")'), true, 'Escape cancels only the resize')
}

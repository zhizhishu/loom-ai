const assert = require('node:assert/strict')

// Exercise the native pressed state, including the guarded corner beside the circle.
module.exports = async function assertReturnToLatest(window, run, scope) {
  const selector = JSON.stringify(`[data-return-scope="${scope}"]`)
  const before = await run(`(() => {
    const button = document.querySelector(${selector})
    const rect = button.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })()`)
  assert.equal(before.width, 44)
  assert.equal(before.height, 44)
  const point = { x: Math.round(before.x + 7), y: Math.round(before.y + 7) }
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  const pressed = await run(`(() => {
    const button = document.querySelector(${selector})
    const rect = button.getBoundingClientRect()
    return { x: rect.x, y: rect.y, hit: document.elementFromPoint(${point.x}, ${point.y}) === button }
  })()`)
  assert.equal(pressed.x, before.x, `${scope}: pressing never moves the target horizontally`)
  assert.equal(pressed.y, before.y, `${scope}: pressing never moves the target vertically`)
  assert.equal(pressed.hit, true, `${scope}: the padded corner belongs to the return control`)
  window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
}

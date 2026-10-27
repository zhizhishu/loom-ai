import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import ts from 'typescript'

// Exercise the production gesture hook with controlled animation frames.
// Deliberately do not paint pointermove before pointerup: release must stand alone.
const source = ts.transpileModule(readFileSync(new URL('../../apps/desktop/src/renderer/src/useCollapsibleSplitter.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
function fixture(collapsed = false, reduced = true, extra = {}) {
  const calls = [], frames = new Map(), listeners = new Map(); let nextFrame = 0, now = 0
  const react = { useRef: value => ({ current: value }), useState: value => [value, () => {}],
    useCallback: fn => fn, useEffect: fn => fn(), useLayoutEffect: fn => fn() }
  const exports = {}
  vm.runInNewContext(source, { exports, require: name => name === 'react' ? react : { prefersReducedMotion: () => reduced },
    window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener() {} },
    performance: { now: () => now }, requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame },
    cancelAnimationFrame: id => frames.delete(id) })
  let captured = false
  const target = { dataset: {}, focus() {}, setPointerCapture() { captured = true },
    hasPointerCapture: () => captured, releasePointerCapture() { captured = false } }
  const hook = exports.useCollapsibleSplitter({ size: collapsed ? 0 : 696, collapsed,
    minimum: collapsed ? 64 : 420, maximum: collapsed ? 1242 : 822, expandAt: 64,
    direction: collapsed ? 1 : -1, capture: () => 'before', onPreview: width => calls.push(['preview', width]),
    onCommit: width => calls.push(['commit', width]), onCancel: () => calls.push(['cancel']),
    onFoldPreview: edge => calls.push(['fold-preview', edge]),
    ...(collapsed ? {} : { onCollapse: () => calls.push(['preview-closed']),
      onCollapseMaximum: () => calls.push(['conversation-closed']), maximumCollapsedSize: 1242 }), ...extra })
  const event = x => ({ button: 0, isPrimary: true, pointerId: 1, clientX: x, clientY: 0,
    currentTarget: target, preventDefault() {} })
  const paint = (elapsed = 16) => { now += elapsed; const batch = [...frames.values()]; frames.clear(); batch.forEach(fn => fn(now)) }
  return { calls, down: x => hook.handlers.onPointerDown(event(x)), move: x => hook.handlers.onPointerMove(event(x)),
    up: x => hook.handlers.onPointerUp(event(x)), paint, finish: async () => { await Promise.resolve(); paint(200) },
    captured: () => captured, phase: () => target.dataset.foldState,
    escape: () => listeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} }),
    blur: () => listeners.get('blur')(), pointerCancel: () => hook.handlers.onPointerCancel(event(0)),
    lost: () => hook.handlers.onLostPointerCapture(event(0)),
    lostReleased: () => hook.handlers.onLostPointerCapture({ ...event(0), buttons: 0 }),
    nativeUp: x => listeners.get('pointerup')?.(event(x)),
    click: (detail, double = false) => {
      let prevented = false
      const e = { detail, preventDefault() { prevented = true }, stopPropagation() {} }
      hook.handlers[double ? 'onDoubleClickCapture' : 'onClickCapture']?.(e)
      return prevented
    } }
}
let checked = 0
for (const [end, expected] of [[600, 'conversation-closed'], [1180, 'preview-closed']]) {
  const f = fixture(); f.down(816); f.up(end); await f.finish()
  assert.ok(f.calls.some(([kind]) => kind === expected), expected); checked++
}
{
  const f = fixture(); f.down(816); f.up(690); await f.finish()
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'commit'), [['commit', 822]])
  assert.ok(!f.calls.some(([kind]) => kind.endsWith('-closed'))); checked++
}
{
  const f = fixture(); f.down(816); f.move(590); f.paint(); f.up(730); await f.finish()
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'commit'), [['commit', 782]])
  assert.ok(!f.calls.some(([kind]) => kind.endsWith('-closed'))); checked++
}
for (const [end, shouldRestore] of [[368, true], [298, false]]) {
  const f = fixture(true); f.down(278); f.up(end); await f.finish()
  assert.equal(f.calls.some(([kind]) => kind === 'commit'), shouldRestore); checked++
}
{
  const f = fixture(true); f.down(278); f.move(368); f.paint(); f.up(298); await f.finish()
  assert.equal(f.calls.some(([kind]) => kind === 'commit'), false); checked++
}
// A pause at either stop (or within the 64px detent) must never collapse on its own.
for (const end of [690, 627, 1092, 1155]) {
  const f = fixture(); f.down(816); f.move(end); f.paint(); await f.finish(); f.paint(5000)
  assert.equal(f.phase(), 'detent'); assert.equal(f.captured(), true)
  assert.ok(!f.calls.some(([kind, value]) => kind === 'fold-preview' && value)); checked++
}
// Fully fold BEFORE pointerup, with real 160ms animation and reduced motion alike.
for (const reduced of [false, true]) for (const [end, edge, closed] of [[626, 'maximum', 'conversation-closed'], [1156, 'minimum', 'preview-closed']]) {
  const f = fixture(false, reduced); f.down(816); f.move(end); f.paint(); await f.finish()
  assert.equal(f.phase(), 'collapsed'); assert.equal(f.captured(), true)
  assert.ok(f.calls.some(([kind, value]) => kind === 'fold-preview' && value === edge))
  assert.ok(!f.calls.some(([kind]) => kind.endsWith('-closed')))
  f.up(end); await f.finish()
  assert.equal(f.calls.filter(([kind]) => kind === closed).length, 1)
  assert.equal(f.captured(), false); checked++
}
// Continuing to push while animation runs must not cancel its next frame.
{
  const f = fixture(false, false); f.down(816); f.move(600); f.paint(); await Promise.resolve()
  f.move(570); f.paint(80)
  assert.equal(f.phase(), 'closing')
  assert.ok(f.calls.some(([kind, size]) => kind === 'preview' && size > 822 && size < 1242))
  f.move(540); f.paint(100)
  assert.equal(f.phase(), 'collapsed'); assert.equal(f.captured(), true); checked++
}
// Hysteresis ignores small jitter; a deliberate reversal reopens and keeps resizing.
for (const [end, jitter, reversed, continued, expected] of [[600, 620, 630, 680, 772], [1180, 1160, 1150, 1100, 470]]) {
  const f = fixture(); f.down(816); f.move(end); f.paint(); await f.finish()
  f.move(jitter); assert.equal(f.phase(), 'collapsed')
  f.move(reversed); assert.equal(f.phase(), 'detent'); assert.equal(f.captured(), true)
  f.move(continued); f.paint(); f.up(continued)
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'commit'), [['commit', expected]])
  assert.ok(!f.calls.some(([kind]) => kind.endsWith('-closed'))); checked++
}
// Only explicit Escape restores the original layout after a held fold.
for (const method of ['escape']) {
  const f = fixture(); f.down(816); f.move(600); f.paint(); await f.finish(); f[method]()
  assert.ok(f.calls.some(([kind]) => kind === 'cancel'))
  assert.equal(f.captured(), false)
  assert.ok(!f.calls.some(([kind]) => kind.endsWith('-closed'))); checked++
}
// Native interruption ends at the last pointer position, it never acts as Undo.
for (const method of ['blur', 'pointerCancel', 'lost']) {
  const f = fixture(); f.down(816); f.move(600); f.paint(); await f.finish(); f[method](); await f.finish()
  assert.ok(!f.calls.some(([kind]) => kind === 'cancel'))
  assert.equal(f.calls.filter(([kind]) => kind === 'conversation-closed').length, 1)
  assert.equal(f.captured(), false); checked++
}
// Release coordinates still decide a reversal when no final pointermove painted.
{
  const f = fixture(); f.down(816); f.move(600); f.paint(); await f.finish(); f.up(730)
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'commit'), [['commit', 782]])
  assert.ok(!f.calls.some(([kind]) => kind.endsWith('-closed'))); checked++
}
// A delayed preparation result cannot resurrect a canceled gesture.
{
  let resolve; const pending = new Promise(done => { resolve = done })
  const f = fixture(false, true, { prepareCollapse: () => pending }); f.down(816); f.move(600); f.paint()
  f.escape(); resolve(true); await f.finish()
  assert.ok(!f.calls.some(([kind, value]) => kind === 'fold-preview' && value)); checked++
}
// Releasing commits intent; late native cleanup cannot roll that result back.
for (const method of ['blur', 'pointerCancel', 'lost']) for (const [end, closed] of [[600, 'conversation-closed'], [1180, 'preview-closed']]) {
  const f = fixture(false, false); f.down(816); f.up(end); f[method](); await f.finish()
  assert.ok(!f.calls.some(([kind]) => kind === 'cancel'), `released ${method} must not roll back`)
  assert.equal(f.calls.filter(([kind]) => kind === closed).length, 1); checked++
}
// A real pointerup captured above the React tree settles even if the divider
// missed its own event. A later duplicate event is inert.
{
  const f = fixture(); f.down(816); f.move(750); f.nativeUp(730); f.up(730); f.paint()
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'commit'), [['commit', 782]]); checked++
}
// A drag must never become the first/second click of a reset gesture.
{
  const f = fixture(); f.down(816); f.up(760)
  assert.equal(f.click(1), true)
  f.down(760); f.up(760)
  assert.equal(f.click(2), true); assert.equal(f.click(2, true), true)
  // A fresh, stationary double-click sequence still resets normally.
  f.down(760); f.up(760); assert.equal(f.click(1), false)
  f.down(760); f.up(760); assert.equal(f.click(2), false); assert.equal(f.click(2, true), false); checked++
}
// The sidebar uses the same hook with the opposite direction and 200px minimum.
const sidebar = { size: 270, minimum: 200, maximum: 420, direction: 1, onCollapseMaximum: undefined }
for (const method of ['blur', 'pointerCancel', 'lost']) for (const [extra, start, end, expected] of [[{}, 816, 760, 752], [sidebar, 270, 220, 220]]) {
  const f = fixture(false, false, extra); f.down(start); f.move(end); f[method](); f.paint()
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'commit'), [['commit', expected]])
  assert.ok(!f.calls.some(([kind]) => kind === 'cancel')); checked++
}
// Capture can be lost at release before a React pointerup reaches the divider.
// Its retargeted zero coordinate must not undo the last observed movement.
for (const [extra, start, end, expected] of [[{}, 816, 760, 752], [sidebar, 270, 220, 220]]) {
  const f = fixture(false, false, extra); f.down(start); f.move(end); f.lostReleased(); f.paint()
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'commit'), [['commit', expected]])
  assert.ok(!f.calls.some(([kind]) => kind === 'cancel')); checked++
}
for (const [extra, start, end, closed] of [[{}, 816, 600, 'conversation-closed'], [{}, 816, 1180, 'preview-closed'], [sidebar, 270, 100, 'preview-closed']]) {
  const f = fixture(false, false, extra); f.down(start); f.move(end); f.lostReleased(); await f.finish()
  assert.equal(f.calls.filter(([kind]) => kind === closed).length, 1)
  assert.ok(!f.calls.some(([kind]) => kind === 'cancel')); checked++
}
for (const [end, width] of [[210, 210], [180, 200]]) {
  const f = fixture(false, false, sidebar); f.down(270); f.nativeUp(end); f.paint()
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'commit'), [['commit', width]]); checked++
}
for (const method of ['blur', 'pointerCancel', 'lost']) {
  const f = fixture(false, false, sidebar); f.down(270); f.nativeUp(100); f[method](); await f.finish()
  assert.ok(!f.calls.some(([kind]) => kind === 'cancel'))
  assert.equal(f.calls.filter(([kind]) => kind === 'preview-closed').length, 1); checked++
}
{
  const f = fixture(false, false, sidebar); f.down(270); f.move(100); f.paint(); await f.finish()
  assert.equal(f.phase(), 'collapsed'); assert.equal(f.captured(), true)
  f.move(124); f.move(160); f.paint(); f.nativeUp(160)
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'commit'), [['commit', 236]])
  assert.ok(!f.calls.some(([kind]) => kind === 'preview-closed')); checked++
}
console.log(JSON.stringify({ passed: checked, checks: 'shared sidebar/preview gesture; held fold at both edges; no dwell; no-frame release; final release coordinate; late cleanup after release; drag/click isolation; reversal; cancellation; reduced motion; stale async result' }))

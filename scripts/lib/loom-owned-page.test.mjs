import test from 'node:test'
import assert from 'node:assert/strict'
import { confirmOwnedPage } from './loom-owned-page.mjs'

const URL = 'http://127.0.0.1:43871/'
const success = href => ({ ok: true, valueReason: null, value: { href, readyState: 'interactive' } })
function fake(reads, ready = { ok: true, tab: 'unrelated-probe' }) {
  const calls = []
  return { calls, browser: {
    abEval: async (tab, expression) => { calls.push(['read', tab]); assert.match(expression, /location.href/u); return reads.shift() },
    abReady: () => { calls.push(['ready']); return ready }
  } }
}

test('owned page requires its exact URL before any page input', async () => {
  const f = fake([success(URL)])
  assert.deepEqual(await confirmOwnedPage('owned-17', URL, f), { tabId: 'owned-17', href: URL, readyState: 'interactive', recoveredStaleTab: false })
  assert.deepEqual(f.calls, [['read', 'owned-17']])
})
test('a newly opened stale session recovers once and keeps its original tab', async () => {
  const f = fake([{ ok: false, reason: 'STALE_TAB' }, success(URL)])
  assert.equal((await confirmOwnedPage('owned-17', URL, f)).recoveredStaleTab, true)
  assert.deepEqual(f.calls, [['read', 'owned-17'], ['ready'], ['read', 'owned-17']])
})
test('ready does not authorize a different page or unresolved tab', async () => {
  for (const result of [success('http://127.0.0.1:9999/'), { ok: false, reason: 'STALE_TAB' }]) {
    const f = fake([{ ok: false, reason: 'STALE_TAB' }, result])
    await assert.rejects(confirmOwnedPage('owned-17', URL, f), /owned page/u)
    assert.deepEqual(f.calls, [['read', 'owned-17'], ['ready'], ['read', 'owned-17']])
  }
})
test('unknown page reads are not retried or converted to a successful ready probe', async () => {
  const f = fake([{ ok: false, reason: 'TIMEOUT_UNCONFIRMED' }])
  await assert.rejects(confirmOwnedPage('owned-17', URL, f), /TIMEOUT_UNCONFIRMED/u)
  assert.deepEqual(f.calls, [['read', 'owned-17']])
})
test('unconfirmed recovery and truncated identity both stop before input', async () => {
  const blocked = fake([{ ok: false, reason: 'STALE_TAB' }], { ok: false, reason: 'EXTENSION_DISCONNECTED' })
  await assert.rejects(confirmOwnedPage('owned-17', URL, blocked), /EXTENSION_DISCONNECTED/u)
  assert.deepEqual(blocked.calls, [['read', 'owned-17'], ['ready']])
  const truncated = fake([{ ...success(URL), valueReason: 'ARTIFACT_MISSING' }])
  await assert.rejects(confirmOwnedPage('owned-17', URL, truncated), /fully read/u)
})

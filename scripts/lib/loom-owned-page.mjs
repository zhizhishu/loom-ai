// A newly created Chrome tab can be visible before its extension session attaches.
// Recover only that read once, then prove the original tab still has the intended URL.
// Never adopt a ready probe, tab-list entry, or another page as the business tab.
import assert from 'node:assert/strict'
import * as ab from './ab-browser.mjs'

export function pageScript(expression) {
  return /^\s*return\b/u.test(expression) ? expression : 'return (' + expression + ')'
}

// Radix renders ChoiceMenu items as menuitemradio divs. A semantic target can
// be supplied before the portal exists, so one idempotent pick owns opening it.
export function radioChoiceSelector(label) {
  assert.equal(typeof label, 'string')
  const value = label.replace(/\s+/gu, ' ').trim()
  assert.ok(value.length > 0 && value.length <= 200)
  const literal = value.includes("'")
    ? 'concat(' + value.split("'").map(part => "'" + part + "'").join(', "\'", ') + ')'
    : "'" + value + "'"
  return 'xpath=//*[@role="menuitemradio" and contains(concat(" ", normalize-space(@class), " "), " ln-choice-item ") and .//strong[normalize-space(.)=' + literal + ']]'
}

export async function confirmOwnedPage(tabId, url, { browser = ab, env = process.env } = {}) {
  const expected = new URL(url)
  const expression = 'return { href: location.href, readyState: document.readyState }'
  let result = await browser.abEval(tabId, expression, { env })
  let recoveredStaleTab = false
  if (!result.ok && result.reason === 'STALE_TAB') {
    const ready = browser.abReady({ env })
    assert.equal(ready.ok, true, 'owned page recovery unconfirmed: ' + ready.reason)
    // `ready` may use another tab as its probe. Its tab field is deliberately ignored.
    recoveredStaleTab = true
    result = await browser.abEval(tabId, expression, { env })
  }
  assert.equal(result.ok, true, 'owned page read unconfirmed: ' + result.reason)
  assert.equal(result.valueReason ?? null, null, 'owned page identity was not fully read')
  assert.equal(typeof result.value?.href, 'string', 'owned page URL missing')
  assert.equal(new URL(result.value.href).href, expected.href, 'owned page URL changed')
  assert.ok(['loading', 'interactive', 'complete'].includes(result.value.readyState), 'owned page document missing')
  return { tabId, href: expected.href, readyState: result.value.readyState, recoveredStaleTab }
}

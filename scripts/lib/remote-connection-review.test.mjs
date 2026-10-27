import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import jsQR from 'jsqr'
import { buildRemoteConnectionReview } from '../review-remote-connection.mjs'
import { launchAcceptanceBrowser, pause } from './host-web-browser.mjs'

const root = resolve(import.meta.dirname, '../..')
const chrome = process.env.ROVAI_REVIEW_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
test('remote connection design preserves production settings geometry, keyboard validation and reversible decisions', { timeout: 120_000 }, async t => {
  try { await access(chrome) } catch { t.skip('A local Chrome binary is required; no visual verification claimed.'); return }
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-remote-connection-review-')))
  const output = process.env.ROVAI_REMOTE_REVIEW_OUTPUT ?? join(fixture, 'screenshots')
  const artifact = process.env.ROVAI_REMOTE_REVIEW_ROOT
    ? { productPath: join(process.env.ROVAI_REMOTE_REVIEW_ROOT, 'remote-connection.html'), viewerPath: join(process.env.ROVAI_REMOTE_REVIEW_ROOT, 'remote-connection-review.html') }
    : await buildRemoteConnectionReview(join(fixture, 'artifact'))
  await mkdir(output, { recursive: true })
  console.log(JSON.stringify({ channel: 'automatic_acceptance', userData: join(fixture, 'chrome-profile'), core: false, runtime: false }))
  let browser
  const evidence = { simulation: true, realHost: false, styleSource: 'production SettingsSidebarNavigation, SettingsPageHeader, GeneralSettings, AppearanceSettings and theme.css', views: [], checks: [] }
  try {
    browser = await launchAcceptanceBrowser({ executable: chrome, args: ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${join(fixture, 'chrome-profile')}`, 'about:blank'] })
    const open = async (surface, theme, state = 'enabled', page = 'remote') => {
      const url = pathToFileURL(artifact.productPath)
      url.search = new URLSearchParams({ surface, theme, state, page }).toString()
      await browser.send('Page.navigate', { url: url.href })
      await browser.wait(`location.href===${JSON.stringify(url.href)} && document.querySelector('.settings-page-heading h1') !== null`)
      await pause(120)
    }
    const dialogReady = () => browser.wait(`Boolean(document.querySelector('[role="dialog"]')) && document.querySelector('[role="dialog"]').getAnimations().every(a=>a.playState!=='running')`)
    const button = text => `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)})`
    const input = async (selector, value) => {
      await browser.click(`document.querySelector(${JSON.stringify(selector)})`)
      await browser.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.select()})()`)
      await browser.send('Input.insertText', { text: value })
    }
    const addressValue = label => `document.querySelector('.remote-connection-address[aria-label="${label}"]').dataset.address`
    const icon = label => `document.querySelector('button[aria-label="${label}"]')`
    const checkQr = async (theme, label = '远程地址') => {
      const selected = await browser.evaluate(addressValue(label))
      await browser.click(icon(`${label}二维码`))
      await dialogReady()
      await browser.wait(`document.querySelector('.remote-qr svg')!==null`)
      const pixels = await browser.evaluate(`(async()=>{
        const svg = document.querySelector('.remote-qr svg')
        const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], {type:'image/svg+xml'}))
        try {
          const image = new Image(); image.src = url; await image.decode()
          const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
          const context = canvas.getContext('2d'); context.drawImage(image,0,0)
          return {width:canvas.width,height:canvas.height,data:Array.from(context.getImageData(0,0,canvas.width,canvas.height).data)}
        } finally { URL.revokeObjectURL(url) }
      })()`)
      const decoded = new URL(jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data)
      assert.equal(decoded.origin, selected)
      assert.equal(decoded.hash, '#login-ticket=' + 'a'.repeat(64), 'explicit scan uses the short-lived fixture ticket, never the manager token')
      assert.equal(await browser.evaluate(`document.querySelector('.remote-qr code').textContent`), selected)
      await browser.capture(join(output, `desktop-qr-${theme}-${label === '本机地址' ? 'local' : 'remote'}.png`))
      await browser.key('Escape')
      await browser.wait(`document.querySelector('[role="dialog"]')===null`)
      await browser.wait(`document.activeElement.getAttribute('aria-label')===${JSON.stringify(label+'二维码')}`)
    }
    const geometry = () => browser.evaluate(`(()=>{const rail=document.querySelector('.unified-sidebar'),header=document.querySelector('.settings-page-heading'), title=header.querySelector('h1');return {rail:rail.getBoundingClientRect().width,top:document.querySelector('.window-drag-strip').getBoundingClientRect().height,titleSize:getComputedStyle(title).fontSize,titleWeight:getComputedStyle(title).fontWeight,titleX:title.getBoundingClientRect().x,titleY:title.getBoundingClientRect().y,railColor:getComputedStyle(rail).backgroundColor,canvas:getComputedStyle(document.querySelector('.settings-panel')).backgroundColor,overflow:document.documentElement.scrollWidth>innerWidth||[...document.querySelectorAll('.settings-panel')].some(e=>e.scrollWidth>e.clientWidth+1),nativeBridge:typeof window.rovai}})()`)
    for (const theme of ['day', 'night']) {
      await open('desktop', theme, 'enabled', 'general')
      const baseline = await geometry()
      await browser.capture(join(output, `baseline-general-${theme}.png`))
      for (const [surface, state] of [['desktop', 'enabled'], ['desktop', 'off'], ['desktop', 'error'], ['desktop', 'loading'], ['web', 'enabled'], ['web', 'offline'], ['web', 'expired']]) {
        await open(surface, theme, state)
        const actual = await geometry()
        assert.deepEqual(actual, baseline, `${surface}/${theme}/${state}: same settings structure and theme as production General`)
        assert.equal(actual.rail, 270); assert.equal(actual.top, 50); assert.equal(actual.titleSize, '24px'); assert.equal(actual.nativeBridge, 'undefined'); assert.equal(actual.overflow, false)
        assert.equal(await browser.evaluate(`document.querySelector('[aria-current="page"]')?.textContent`), '远程连接')
        await browser.capture(join(output, `${surface}-${state}-${theme}.png`))
        evidence.views.push({ surface, theme, state, geometry: actual })
        if (surface === 'desktop' && state === 'off') assert.equal(await browser.evaluate(`document.querySelector('#remote-port').value`), '8766', 'fresh Desktop defaults to its own Web port')
        if (surface === 'desktop' && state === 'enabled') {
          assert.equal(await browser.evaluate(`document.querySelectorAll('.remote-connection-page h2, .remote-service-icon').length`), 0)
          for (const label of ['本机地址', '远程地址']) {
            assert.equal(await browser.evaluate(`document.querySelector('[aria-label="${label}"] .remote-address-value a').getAttribute('href')`), await browser.evaluate(addressValue(label)))
          }
          assert.equal(await browser.evaluate(`document.querySelector('label[for=remote-token]').textContent`), '登录 Token')
          assert.equal(await browser.evaluate(`document.querySelector('#remote-address').textContent.includes('198.18.')`), false)
          await browser.evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.reviewCopiedValue=value}}})`)
          const beforeCopy = await geometry()
          for (const label of ['复制本机地址', '复制远程地址', '复制登录 Token']) {
            await browser.click(icon(label))
            await browser.wait(`${icon(label)}.title==='已复制'`)
            const expected = label === '复制登录 Token' ? `document.querySelector('#remote-token').value` : addressValue(label.slice(2))
            assert.equal(await browser.evaluate('window.reviewCopiedValue'), await browser.evaluate(expected))
            assert.equal(await browser.evaluate(`document.querySelector('.remote-feedback')===null`), true, 'copy success stays in the icon, without a page notice')
          }
          assert.deepEqual(await geometry(), beforeCopy, 'copy feedback does not move the page')
          await browser.capture(join(output, `desktop-token-copied-${theme}.png`))
          await browser.wait(`${icon('复制登录 Token')}.title==='复制登录 Token'`)
          await browser.click(icon('显示登录 Token'))
          assert.equal(await browser.evaluate(`document.querySelector('#remote-token').type`), 'text')
          assert.equal(await browser.evaluate(`${icon('隐藏登录 Token')}.getAttribute('aria-pressed')`), 'true')
          await browser.click(icon('隐藏登录 Token'))
          assert.equal(await browser.evaluate(`document.querySelector('#remote-token').type`), 'password')
          assert.equal(await browser.evaluate(`Array.from(document.querySelectorAll('.remote-token-actions button')).every(e=>e.textContent==='' && e.querySelector('svg[aria-hidden=true]'))`), true)
          await checkQr(theme)
          await checkQr(theme, '本机地址')
          assert.match(await browser.evaluate(addressValue('本机地址')), /127\.0\.0\.1/)
          assert.equal(await browser.evaluate(`document.querySelector('#remote-access')===null && document.querySelector('#remote-port')!==null`), true)
        }
      }
    }
    await open('desktop', 'day', 'off')
    await browser.wait(`document.querySelector('#remote-token')?.value.length>0`)
    assert.equal(await browser.evaluate(`document.querySelector('.remote-addresses')===null && !document.querySelector('button[aria-label="复制登录 Token"]').disabled`), true, 'token is available before starting')
    await input('#remote-port', '70000')
    await browser.click(`document.querySelector('[aria-label="远程访问"]')`)
    await browser.wait(`document.activeElement.id === 'remote-port'`)
    assert.equal(await browser.evaluate(`document.querySelector('[aria-label="远程访问"]').checked`), false)
    assert.match(await browser.evaluate('document.body.innerText'), /1–65535/)
    await input('#remote-port', '4321')
    await browser.click(`document.querySelector('[aria-label="远程访问"]')`)
    assert.equal(await browser.evaluate(`document.querySelector('[aria-label="远程访问"]').disabled`), true)
    await browser.wait(`document.querySelector('#remote-enabled').checked && !document.querySelector('#remote-enabled').disabled`)
    assert.equal(await browser.evaluate(`document.querySelector('#remote-token').type`), 'password')
    assert.match(await browser.evaluate(`document.querySelector('#remote-address').value`), /192.168.1.12:4321/)
    assert.equal(await browser.evaluate(`document.querySelector('.remote-feedback') === null`), true, 'enabling needs no success notice')
    await browser.capture(join(output, 'desktop-first-enable-day.png'))
    const originalToken = await browser.evaluate(`document.querySelector('#remote-token').value`)
    assert.equal(await browser.evaluate(`document.querySelectorAll('.remote-token-actions button').length`), 2, 'token row contains only visibility and copy')
    await input('#remote-port', '4322')
    assert.equal(await browser.evaluate(`document.querySelector('#remote-enabled').checked`), true)
    assert.match(await browser.evaluate(addressValue('远程地址')), /:4321$/)
    await browser.click(button('外观'))
    await browser.wait(`document.querySelector('.appearance-settings-page')!==null`)
    await browser.click(button('远程连接'))
    await browser.wait(`document.querySelector('#remote-token')?.value.length > 0`)
    assert.equal(await browser.evaluate(`document.querySelector('#remote-port').value`), '4322', 'unapplied port survives settings navigation')
    const resumedToken = await browser.evaluate(`document.querySelector('#remote-token').value`)
    assert.equal(resumedToken, originalToken, 'returning to settings rereads the same Host token')
    await browser.evaluate(`(()=>{const e=document.querySelector('#remote-address');e.value=[...e.options].find(o=>o.value.includes('192.168.2.')).value;e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    assert.equal(await browser.evaluate(`document.querySelector('#remote-token').value`), resumedToken)
    assert.match(await browser.evaluate(`document.querySelector('#remote-address').value`), /192\.168\.2\./)
    await checkQr('changed-address')
    await browser.evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('clipboard unavailable')}}})`)
    await browser.click(icon('复制远程地址'))
    assert.match(await browser.evaluate(`document.querySelector('.remote-feedback').textContent`), /http:\/\/192\.168\.2\.12:4321/)
    assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('.remote-feedback')).userSelect`), 'text', 'the fallback address remains manually selectable')
    await browser.click(icon('复制登录 Token'))
    assert.equal(await browser.evaluate(`${icon('复制登录 Token')}.title`), '复制登录 Token', 'failed copy must not show success')
    assert.equal(await browser.evaluate(`document.querySelector('.remote-feedback').textContent.includes(document.querySelector('#remote-token').value)`), false, 'copy failure must not expose a masked token')
    await browser.click(`document.querySelector('[aria-label="远程访问"]')`)
    assert.equal(await browser.evaluate(`document.querySelector('[role="dialog"]')===null`), true, 'stop has no second confirmation')
    await browser.wait(`!document.querySelector('#remote-enabled').checked && !document.querySelector('#remote-enabled').disabled`)
    assert.equal(await browser.evaluate(`document.querySelector('#remote-token').value`), originalToken)
    await browser.click(button('外观')); await browser.wait(`document.querySelector('.appearance-settings-page')!==null`)
    await browser.click(button('远程连接')); await browser.wait(`document.querySelector('#remote-token')?.value.length>0`)
    assert.equal(await browser.evaluate(`document.querySelector('#remote-token').value`), originalToken, 'token survives navigation while stopped')
    await browser.click(icon('显示登录 Token'))
    assert.equal(await browser.evaluate(`document.querySelector('#remote-token').type`), 'text')
    await browser.click(icon('隐藏登录 Token'))
    assert.equal(await browser.evaluate(`document.querySelector('#remote-port').value`), '4322')
    await browser.capture(join(output, 'desktop-stopped-day.png'))
    await browser.click(`document.querySelector('[aria-label="远程访问"]')`)
    await browser.wait(`document.querySelector('#remote-enabled').checked && !document.querySelector('#remote-enabled').disabled`)
    assert.match(await browser.evaluate(addressValue('远程地址')), /:4322$/)
    assert.match(await browser.evaluate(addressValue('本机地址')), /:4322$/)
    evidence.checks.push('icon-copy-success-without-page-notice-and-resets', 'token-show-hide-copy-only-icon-controls', 'field-validation-focus-and-edit-retention', 'one-switch-start-with-cleartext-notice', 'submitting-disables-repeat', 'token-masked-and-readable-after-navigation', 'interface-selection-preserves-token', 'token-readable-before-start-and-after-stop-and-navigation', 'stop-without-confirmation', 'pending-port-survives-navigation-and-applies-only-on-next-start')
    await open('desktop', 'day', 'empty')
    await browser.wait(`document.querySelector('.remote-addresses') !== null`)
    for (const label of ['本机地址','远程地址']) {
      assert.equal(await browser.evaluate(`${icon('复制'+label)}.disabled && ${icon(label+'二维码')}.disabled`), true)
      assert.equal(await browser.evaluate(addressValue(label)), '')
    }
    evidence.checks.push('login-QR-uses-selected-origin-and-one-time-fragment-in-both-themes', 'QR-Escape-restores-focus', 'empty-discovery-disables-copy-and-QR', 'copy-failure-allows-manual-address-copy-without-exposing-token', 'compact-switch-without-duplicate-headings-or-start-success-notice')
    await open('web', 'night', 'expired')
    assert.equal(await browser.evaluate(`document.querySelector('[aria-label="远程访问"]')===null`), true)
    await browser.click(button('重新登录'))
    await dialogReady()
    await input('[role="dialog"] input[type=password]', 'review-only-example')
    await browser.click(button('登录'))
    await browser.wait(`document.querySelector('[role="dialog"]')===null && document.body.innerText.includes('已连接')`)
    assert.equal(await browser.evaluate(`document.body.innerText.includes('更换令牌')`), false)
    evidence.checks.push('browser-relogin-form-without-host-administration')
    for (const [width, height] of [[1040, 700], [2560, 1440], [720, 460]]) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      for (const state of ['off', 'enabled']) {
        await open('desktop', 'night', state)
        assert.equal((await geometry()).overflow, false, `${width}x${height}/${state} reduced motion layout`)
        assert.equal(await browser.evaluate(`(()=>{const a=document.querySelector('[for="remote-enabled"]').getBoundingClientRect(),b=document.querySelector('#remote-enabled').getBoundingClientRect();return Math.abs(a.y+a.height/2-b.y-b.height/2)<1})()`), true, 'remote access and its switch stay on one row')
        await browser.capture(join(output, `desktop-${state}-${width}-night.png`))
      }
      if (width === 720) await checkQr('720-night')
    }
    evidence.checks.push('1040x700-and-2560x1440', '720x460-layout-equivalent-to-200-percent-of-1440x920', 'reduced-motion')
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1480, height: 1100, deviceScaleFactor: 1, mobile: false })
    await browser.send('Page.navigate', { url: pathToFileURL(artifact.viewerPath).href })
    await browser.wait(`Boolean(document.querySelector('iframe')?.contentDocument?.querySelector('.remote-connection-page'))`)
    await browser.capture(join(output, 'review-overview.png'))
    assert.deepEqual(browser.errors, [])
    evidence.artifactSha256 = Object.fromEntries(await Promise.all([
      ['product', artifact.productPath], ['viewer', artifact.viewerPath]
    ].map(async ([name, path]) => [name, createHash('sha256').update(await readFile(path)).digest('hex')])))
    await writeFile(join(output, 'remote-connection-review.json'), JSON.stringify(evidence, null, 2) + '\n')
    console.log(JSON.stringify({ simulation: true, passed: true, views: evidence.views.length, checks: evidence.checks, output }))
  } catch (error) {
    if (browser) await browser.capture(join(output, 'failure.png')).catch(() => {})
    throw error
  } finally {
    if (browser) await browser.close()
    await rm(fixture, { recursive: true, force: true })
  }
})

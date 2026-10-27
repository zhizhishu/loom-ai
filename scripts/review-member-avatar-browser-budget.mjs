import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve, extname } from 'node:path'
import { launchAcceptanceBrowser } from './lib/host-web-browser.mjs'
import { measureAvatarBudget } from './lib/avatar-render-budget.mjs'

// Consumes the real Core's stress-seed from test:member-avatar-flow. Uses a
// separate Chrome profile and the same production editor/avatar/browser adapter.
const fixture = resolve(process.argv[2])
const seed = JSON.parse(await readFile(join(fixture, 'user-data/stress-seed.json'), 'utf8'))
const profile = join(fixture, 'chrome-profile')
await mkdir(profile, { recursive: true })
const server = createServer(async (req, res) => {
  const path = resolve(fixture, 'renderer', '.' + (req.url === '/' ? '/index.html' : req.url.split('?')[0]))
  if (!path.startsWith(join(fixture, 'renderer') + '/')) { res.writeHead(404).end(); return }
  try {
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[extname(path)]
    res.setHeader('Content-Type', mime ?? 'application/octet-stream'); res.end(await readFile(path))
  } catch { res.writeHead(404).end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await launchAcceptanceBrowser({ executable: process.env.ROVAI_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', 'about:blank'] })
try {
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const seed = ${JSON.stringify(seed)};
    localStorage.setItem('avatar', seed.refs[0]);
    window.avatarFixture = { request: async (method, params) => {
      if (method !== 'memberAvatars.read') throw Error('Read-only benchmark');
      return seed.renditions[params.avatarRef];
    }};
  ` })
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` })
  await browser.wait('!!window.showAvatarStress')
  await browser.evaluate(`window.showAvatarStress(${JSON.stringify(seed.refs)})`)
  await browser.wait("document.querySelectorAll('[data-stress] img').length === 12 && [...document.querySelectorAll('[data-stress] img')].every(img => img.naturalWidth)")
  const report = []
  for (const [width, height] of [[1440, 920], [375, 812]]) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    const metrics = await measureAvatarBudget(browser.evaluate, async () => (await browser.send('Page.captureScreenshot', { format: 'png' })).data)
    assert.equal(metrics.animated, 12)
    report.push({ width, height, ...metrics })
    await browser.capture(join(fixture, `stress-chrome-${width}.png`))
  }
  assert.deepEqual(browser.errors, [])
  await writeFile(join(fixture, 'stress-chrome.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }

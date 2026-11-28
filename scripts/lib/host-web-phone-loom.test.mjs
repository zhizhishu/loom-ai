// 手机网页（iPhone 390×844）真机仿真验收：真 Host + 生产 Web 入口 + 无头 Chrome 的
// 移动/触摸仿真，再用 CDP 覆盖 env(safe-area-inset-*) 检查刘海与 home bar 让位。
// 只驱动生产选择器（`.ln-rail` / `.ln-conversation-row` / `.ln-composer` / `.ln-send-button`），
// 不注入 fixture DOM，不改 Web 资源。
//
// 覆盖：登录 → 打开群 → 发一条指令 → 几何断言（无横向溢出、输入区在 home bar 之上、
// 侧栏浮层不越界）→ 截图。
// 批准卡与任务卡由组件断言覆盖（phone-layout.test.tsx、conversation-view.test.tsx）；
// 真实审批回执与附件读取需要 Runtime，本脚本不合成、不伪造通过。
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { launchHost, within } from './host-test-client.mjs'
import { launchAcceptanceBrowser } from './host-web-browser.mjs'
import { coreDataDirectoryArguments, removeEphemeralRuntimeCampFilesRoot } from './runtime-camp-files-root.mjs'

const repository = resolve(import.meta.dirname, '../..')
const PHONE = Object.freeze({ width: 390, height: 844, scale: 3, safeTop: 47, safeBottom: 34 })

async function reviewChrome() {
  const candidates = [
    process.env.ROVAI_REVIEW_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/home/ubuntu/.local/bin/google-chrome',
    '/usr/bin/google-chrome'
  ].filter(candidate => typeof candidate === 'string' && candidate !== '')
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) return candidate
  }
  return null
}

test('iPhone 390x844 keeps the phone flows in one column with the home bar respected', { timeout: 240_000 }, async t => {
  const binary = process.env.ROVAI_HOST_BIN ?? join(repository, 'target/debug/rovai-host')
  const uiDirectory = process.env.ROVAI_WEB_UI ?? join(repository, 'out/web')
  const executable = await reviewChrome()
  for (const [label, path] of [['Host', binary], ['production Web build', join(uiDirectory, 'index.html')], ['Chrome', executable]]) {
    if (path === null || !await access(path).then(() => true, () => false)) {
      t.skip(`Requires a built ${label}; run pnpm build:web + cargo build -p rovai-host and set ROVAI_REVIEW_CHROME`)
      return
    }
  }

  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-phone-loom-')))
  const dataDir = join(fixture, 'core')
  const output = process.env.ROVAI_PHONE_OUTPUT ?? join(fixture, 'evidence')
  await mkdir(output, { recursive: true })
  console.log(JSON.stringify({ channel: 'automatic_acceptance', scope: 'phone-390x844', dataDir, uiDirectory, chrome: executable, browserProfile: join(fixture, 'chrome'), evidence: output, runtime: false }))
  let host
  let browser
  let stage = 'startup'
  try {
    host = launchHost(binary, [
      ...coreDataDirectoryArguments(dataDir),
      '--skill-library-root', join(dataDir, 'skills'),
      '--mcp-config-path', join(dataDir, 'mcp.json')
    ], { cwd: repository })
    await within(host.ready)
    const profiles = await host.request('members.list')
    const member = profiles[0]
    const groupName = '手机验收群'
    const created = await host.request('camps.create', {
      commandId: crypto.randomUUID(), name: groupName, workspace: null,
      memberAgentIds: [member.agentId], defaultLeadAgentId: member.agentId, collaborationMode: 'peer'
    })
    assert.equal(created.status, 'applied')
    const service = await host.request('host.web.start', { listen: '127.0.0.1:0', uiDirectory })

    stage = 'browser'
    browser = await launchAcceptanceBrowser({
      executable,
      args: ['--headless=new', `--user-data-dir=${join(fixture, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', 'about:blank']
    })
    await browser.send('Emulation.setDeviceMetricsOverride', { width: PHONE.width, height: PHONE.height, deviceScaleFactor: PHONE.scale, mobile: true })
    await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await browser.send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      platform: 'iPhone'
    })

    stage = 'login'
    await browser.send('Page.navigate', { url: service.origin })
    await browser.wait(`document.querySelector('#administrator-token') !== null`)
    await browser.click(`document.querySelector('#administrator-token')`)
    await browser.send('Input.insertText', { text: service.administratorToken })
    await browser.click(`document.querySelector('.web-login button[type=submit]')`)
    await browser.wait(`document.querySelector('.web-login-overlay') === null && document.querySelector('.ln-app') !== null`)
    // PWA 入口由 index.html 声明；真正把它当 manifest 拉取是 rovai-web 路由/CSP 的事（工兵单 A），
    // 这里只钉生产构建里这个链接确实存在，不对未放行的路由做假通过。
    assert.equal(await browser.evaluate(`document.querySelector('link[rel=manifest]')?.getAttribute('href')`), './manifest.webmanifest')
    assert.equal(await browser.evaluate(`document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content`), 'yes')

    stage = 'open group from the phone rail'
    // 准备清单是真实 onboarding 覆盖层：先关掉它，截图才拍得到会话本身（不是 fixture 注入）。
    if (await browser.evaluate(`document.querySelector('.ln-setup-checklist [aria-label="关闭引导"]') !== null`)) {
      await browser.click(`document.querySelector('.ln-setup-checklist [aria-label="关闭引导"]')`)
      await browser.wait(`document.querySelector('.ln-setup-checklist') === null`)
    }
    await browser.wait(`document.querySelector('.ln-rail [aria-label="对话"]') !== null`)
    await browser.click(`document.querySelector('.ln-rail [aria-label="对话"]')`)
    await browser.wait(`[...document.querySelectorAll('.ln-sidebar .ln-conversation-row')].some(row => row.textContent.includes(${JSON.stringify(groupName)}))`)
    const sidebar = await browser.evaluate(`(() => { const r = document.querySelector('.ln-sidebar').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width } })()`)
    assert.ok(sidebar.left >= 0 && sidebar.right <= PHONE.width + 0.5, `sidebar overlay stays inside 390px: ${JSON.stringify(sidebar)}`)
    assert.ok(sidebar.top >= 0 && sidebar.bottom <= PHONE.height + 0.5, `sidebar overlay stays inside 844px: ${JSON.stringify(sidebar)}`)
    // 抽屉是覆盖显示：不盖住 44px 图标栏，也不盖住 38px 顶栏（只有内容区被它覆盖）。
    assert.ok(sidebar.left >= 44 - 0.5, `the drawer leaves the rail visible: ${JSON.stringify(sidebar)}`)
    assert.ok(sidebar.top >= 38 - 0.5, `the drawer starts below the top bar: ${JSON.stringify(sidebar)}`)
    await browser.capture(join(output, 'phone-390x844-groups.png'))
    await browser.click(`[...document.querySelectorAll('.ln-sidebar .ln-conversation-row')].find(row => row.textContent.includes(${JSON.stringify(groupName)}))`)
    await browser.wait(`document.querySelector('.ln-identity-pill')?.textContent.includes(${JSON.stringify(groupName)})`)

    stage = 'send an instruction'
    const instruction = '手机端 390x844 验收指令'
    await browser.click(`document.querySelector('.ln-composer textarea')`)
    await browser.send('Input.insertText', { text: instruction })
    await browser.wait(`document.querySelector('.ln-composer textarea').value === ${JSON.stringify(instruction)}`)
    await browser.wait(`document.querySelector('.ln-send-button')?.disabled === false`)
    await browser.click(`document.querySelector('.ln-send-button')`)
    await browser.wait(`document.querySelector('.ln-transcript')?.textContent.includes(${JSON.stringify(instruction)})`, 20_000)

    stage = 'geometry without insets'
    const layout = await browser.evaluate(`(() => {
      const rect = selector => { const node = document.querySelector(selector); if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
      const style = selector => { const node = document.querySelector(selector); return node ? getComputedStyle(node) : null }
      return {
        viewport: { width: innerWidth, height: innerHeight },
        overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        rail: rect('.ln-rail'), topbar: rect('.ln-topbar'), frame: rect('.ln-frame'),
        composerArea: rect('.ln-composer-area'), composer: rect('.ln-composer'), send: rect('.ln-send-button'),
        transcript: rect('.ln-transcript'),
        padding: [style('.ln-app').paddingTop, style('.ln-app').paddingRight, style('.ln-app').paddingBottom, style('.ln-app').paddingLeft],
        composerFont: style('.ln-composer textarea').fontSize
      }
    })()`)
    assert.equal(layout.viewport.width, PHONE.width)
    assert.equal(layout.viewport.height, PHONE.height)
    assert.ok(layout.overflow <= PHONE.width, `the phone page never scrolls sideways: ${layout.overflow} > ${PHONE.width}`)
    assert.equal(Math.round(layout.rail.width), 44, 'phone rail stays 44px so the reading column keeps its width')
    assert.equal(Math.round(layout.topbar.height), 38, 'phone top bar keeps the 38px row')
    assert.ok(layout.composer.width >= 300, `the composer keeps a usable width: ${layout.composer.width}`)
    assert.ok(layout.composer.right <= PHONE.width + 0.5 && layout.composer.left >= -0.5, `the composer stays inside the viewport: ${JSON.stringify(layout.composer)}`)
    assert.ok(layout.composer.bottom <= PHONE.height + 0.5, `the composer does not hang below the viewport: ${layout.composer.bottom}`)
    assert.ok(layout.send.right <= PHONE.width + 0.5 && layout.send.bottom <= layout.composer.bottom + 0.5, 'the send button stays inside the composer')
    assert.ok(layout.transcript.height > 120, `the transcript still reads at 390x844: ${layout.transcript.height}`)
    assert.equal(layout.composerFont, '14px', 'the composer keeps the 14px phone type size (no iOS focus zoom)')
    // 真实手机以外 env() 全为 0：padding 必须解析成合法的 0px，而不是被整条声明丢掉。
    assert.deepEqual(layout.padding, ['0px', '0px', '0px', '0px'])
    await browser.capture(join(output, 'phone-390x844-conversation.png'))

    stage = 'geometry with notch and home bar'
    const overridden = await browser.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { top: PHONE.safeTop, left: 0, bottom: PHONE.safeBottom, right: 0 }
    }).then(() => true, error => { console.log(JSON.stringify({ channel: 'automatic_acceptance', note: `safe-area override unavailable: ${error?.message ?? error}` })); return false })
    if (overridden) {
      const safe = await browser.evaluate(`(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom } }
        const style = getComputedStyle(document.querySelector('.ln-app'))
        return { paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, topbar: rect('.ln-topbar'), composer: rect('.ln-composer'), send: rect('.ln-send-button'), height: innerHeight }
      })()`)
      assert.equal(safe.paddingTop, `${PHONE.safeTop}px`, 'the shell gives the notch its 47px')
      assert.equal(safe.paddingBottom, `${PHONE.safeBottom}px`, 'the shell gives the home bar its 34px')
      assert.ok(safe.topbar.top >= PHONE.safeTop - 0.5, `the top bar starts below the notch: ${safe.topbar.top}`)
      assert.ok(safe.composer.bottom <= safe.height - PHONE.safeBottom + 0.5, `the composer sits above the home bar: ${safe.composer.bottom} > ${safe.height - PHONE.safeBottom}`)
      assert.ok(safe.send.bottom <= safe.height - PHONE.safeBottom + 0.5, 'the send button is reachable above the home bar')
      await browser.capture(join(output, 'phone-390x844-safe-area.png'))
      await browser.send('Emulation.setSafeAreaInsetsOverride', { insets: {} })
    }

    const frame = await browser.evaluate(`(() => { const r = selector => { const box = document.querySelector(selector)?.getBoundingClientRect(); return box ? { left: Math.round(box.left), right: Math.round(box.right), top: Math.round(box.top), bottom: Math.round(box.bottom), width: Math.round(box.width), height: Math.round(box.height) } : null }; return { rail: r('.ln-rail'), topbar: r('.ln-topbar'), frame: r('.ln-frame'), composer: r('.ln-composer'), sidebar: r('.ln-sidebar') } })()`)
    console.log(JSON.stringify({ channel: 'automatic_acceptance', scope: 'phone-390x844', stage: 'done', safeArea: overridden, layout: { viewport: layout.viewport, overflow: layout.overflow, composerFont: layout.composerFont, ...frame, drawer: sidebar }, evidence: [join(output, 'phone-390x844-groups.png'), join(output, 'phone-390x844-conversation.png')] }))
  } catch (error) {
    throw new Error(`phone-390x844 acceptance failed at "${stage}": ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await browser?.close().catch(() => {})
    await host?.close().catch(() => {})
    await removeEphemeralRuntimeCampFilesRoot(dataDir).catch(() => {})
    if (!process.env.ROVAI_PHONE_KEEP) await rm(fixture, { recursive: true, force: true }).catch(() => {})
    else console.log(JSON.stringify({ channel: 'automatic_acceptance', kept: fixture }))
  }
})

const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const { isAbsolute, join } = require('node:path')
const { app, BrowserWindow } = require('electron')

const [renderer, userData, output] = process.argv.slice(2)
let stage = 'startup'
assert(isAbsolute(renderer) && isAbsolute(userData) && isAbsolute(output),
  'LOOM workspace fixture requires absolute renderer, userData and output paths')
mkdirSync(userData, { recursive: true })
mkdirSync(output, { recursive: true })
app.setPath('userData', userData)
app.setPath('sessionData', join(userData, 'session'))
// In-memory Renderer projections only. No Core, SQLite, Skill Library or Runtime.

const cases = []
const shots = []
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: process.platform === 'linux', width: 1440, height: 920, useContentSize: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false }
  })
  const script = expression => window.webContents.executeJavaScript(expression, true)
  const settle = (milliseconds = 240) => script(`new Promise(resolve => setTimeout(() => resolve(true), ${milliseconds}))`)
  const waitFor = async (expression, message, timeout = 8000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await script(expression)) return
      await sleep(30)
    }
    throw new Error(message)
  }
  const pointFor = selector => script(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!element) return null
    const bounds = element.getClientRects()[0] ?? element.getBoundingClientRect()
    return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }
  })()`)
  const click = async selector => {
    const point = await pointFor(selector)
    assert(point, `No pointer target for ${selector}`)
    const zoom = window.webContents.getZoomFactor()
    point.x = Math.round(point.x * zoom)
    point.y = Math.round(point.y * zoom)
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const pressKey = keyCode => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode === 'Enter') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  }
  const pressed = () => script("[...document.querySelectorAll('.loom-section-tabs button')].map(button => button.getAttribute('aria-pressed'))")
  const expectPressed = async (index, message) => {
    await waitFor(`document.querySelectorAll('.loom-section-tabs button')[${index}]?.getAttribute('aria-pressed') === 'true'`, message)
    const state = await pressed()
    assert.deepEqual(state, [0, 1, 2].map(position => position === index ? 'true' : 'false'),
      `Unexpected LOOM section state ${JSON.stringify(state)}`)
  }
  const capture = async (section, theme, size, zoom) => {
    const name = `loom-workspace-${section}-${theme}-${size}${zoom === 100 ? '' : '-zoom' + zoom}.png`
    const path = join(output, name)
    writeFileSync(path, (await window.webContents.capturePage()).toPNG())
    shots.push({ section, theme, size, zoom, path })
  }

  await window.loadFile(renderer)

  stage = 'initial render'
  await waitFor("!!document.querySelector('.loom-workspace .mission-delivery-panel') && !!document.querySelector('.loom-workspace .mission-activity-panel')",
    'LOOM workspace did not mount the shared delivery and activity panels', 15000)
  await waitFor("!!document.querySelector('.mission-changes-unread')", 'collapsed workspace read state did not mount')
  const tabs = await script("[...document.querySelectorAll('.loom-section-tabs button')].map(button => button.textContent)")
  assert.deepEqual(tabs, ['活动', '编排', '交付'], `Unexpected LOOM section tabs ${JSON.stringify(tabs)}`)
  await expectPressed(0, 'LOOM workspace did not open on the activity section')
  const activityCopy = await script("document.querySelector('.mission-activity-panel')?.innerText ?? ''")
  assert(activityCopy.includes('创建了使命'), `Activity history lost its recorded creation row: ${activityCopy}`)
  assert(activityCopy.includes('将状态改为“进行中”'), `Activity history lost its recorded status row: ${activityCopy}`)
  const readStateCopy = await script("document.querySelector('.mission-changes-unread')?.innerText ?? ''")
  assert.equal(readStateCopy, '点击读取当前工作区变更', `Unexpected collapsed read state ${JSON.stringify(readStateCopy)}`)
  const mounted = await script(`(() => {
    const delivery = document.querySelector('.loom-workspace .mission-delivery-panel')
    const activity = document.querySelector('.loom-workspace .mission-activity-panel')
    const unread = document.querySelector('.mission-changes-unread')
    delivery.__loomStamp = 'delivery-a1'; activity.__loomStamp = 'activity-a1'; unread.__loomStamp = 'unread-a1'
    window.__loomNodes = { delivery, activity, unread, wrapper: document.querySelector('.loom-section-body > div:last-child') }
    return {
      wrapperClass: window.__loomNodes.wrapper?.className ?? null,
      wrapperHidden: window.__loomNodes.wrapper?.hidden ?? null,
      evidenceRows: document.querySelectorAll('.loom-workspace .mission-evidence-row').length
    }
  })()`)
  assert.equal(mounted.wrapperClass, 'mission-activity-document', 'Activity and delivery must share the mounted section container')
  assert.equal(mounted.wrapperHidden, false, 'Activity section container started hidden')
  assert.ok(mounted.evidenceRows >= 4, `Delivery evidence rows did not render: ${mounted.evidenceRows}`)
  const openingCounts = await script(`({
    activity: window.loomQA.countOf('missions.activity'),
    delivery: window.loomQA.countOf('missions.delivery'),
    tasks: window.loomQA.countOf('preferences.tasks.get')
  })`)
  assert.equal(openingCounts.activity, 1, `First LOOM render requested activity more than once: ${JSON.stringify(openingCounts)}`)
  assert.equal(openingCounts.delivery, 1, `First LOOM render requested delivery more than once: ${JSON.stringify(openingCounts)}`)
  assert.ok(openingCounts.tasks >= 1, `Task capability snapshot was never read: ${JSON.stringify(openingCounts)}`)
  cases.push('Activity section mounts the shared delivery panel, one recorded activity read and honest collapsed read state')

  stage = 'plan section by pointer'
  await click('.loom-section-tabs button:nth-of-type(2)')
  await expectPressed(1, 'Pointer activation did not open the 编排 section')
  await waitFor("document.querySelector('.loom-section-body > div:last-child').hidden === true", 'Plan section did not hide the shared activity container')
  await waitFor("!!document.querySelector('.loom-plan .loom-flow')", 'Plan section did not render the task dependency flow')
  await waitFor("!!document.querySelector('.loom-plan .loom-flow-edge')", 'Plan flow did not draw dependency edges')
  const plan = await script(`(() => {
    const nodes = [...document.querySelectorAll('.loom-plan .loom-flow-node')]
    const blocked = document.querySelector('.loom-plan .loom-flow-node.blocked')
    return {
      flow: !!document.querySelector('.loom-plan .loom-flow'),
      nodeCount: nodes.length,
      firstTitle: nodes[0]?.querySelector('.loom-flow-node-title')?.innerText ?? null,
      blockedCopy: blocked?.innerText ?? '',
      stats: document.querySelector('.loom-plan .loom-flow-stats')?.innerText ?? '',
      edgeCount: document.querySelectorAll('.loom-plan .loom-flow-edge').length,
      dashedCount: document.querySelectorAll('.loom-plan .loom-flow-edge-artifact-accepted').length,
      laneCount: document.querySelectorAll('.loom-plan .loom-flow-lane').length,
      legendItems: document.querySelectorAll('.loom-plan .loom-flow-legend-item').length,
      graphScrollWidth: document.querySelector('.loom-plan .loom-flow-graph')?.scrollWidth ?? -1,
      graphClientWidth: document.querySelector('.loom-plan .loom-flow-graph')?.clientWidth ?? -1,
      controls: document.querySelectorAll('.loom-plan input, .loom-plan button, .loom-plan textarea').length
    }
  })()`)
  assert.equal(plan.flow, true, `Plan section did not render the archify flow view: ${JSON.stringify(plan)}`)
  assert.equal(plan.nodeCount, 4, `Plan flow must render one node per task: ${JSON.stringify(plan.nodeCount)}`)
  assert(plan.firstTitle?.includes('设计恢复协议'), `Plan flow lost its first task title: ${JSON.stringify(plan.firstTitle)}`)
  assert(plan.blockedCopy.includes('等待恢复逻辑完成'), `Plan flow lost the real blocked reason: ${JSON.stringify(plan.blockedCopy)}`)
  assert(plan.stats.includes('总任务: 4'), `Plan flow stats no longer count the real tasks: ${JSON.stringify(plan.stats)}`)
  assert.equal(plan.edgeCount, 3, `Plan flow must draw one edge per mock dependency: ${JSON.stringify(plan.edgeCount)}`)
  assert(plan.dashedCount >= 1, `Plan flow lost the dashed artifact_accepted edge: ${JSON.stringify(plan.dashedCount)}`)
  assert(plan.laneCount >= 2, `Plan flow must layer the DAG into depth lanes: ${JSON.stringify(plan.laneCount)}`)
  assert(plan.graphScrollWidth >= 0 && plan.graphScrollWidth <= plan.graphClientWidth + 1,
    `Plan flow graph overflows its 1440px lane budget: ${plan.graphScrollWidth} > ${plan.graphClientWidth}`)
  assert.equal(plan.legendItems, 3, `Plan flow must explain all three edge kinds: ${JSON.stringify(plan.legendItems)}`)
  assert.equal(plan.controls, 0, 'Plan section must not offer controls for a read-only plan')
  cases.push('编排 section renders the real task dependency flow with four nodes, the blocked task reason, honest stats and no invented controls')

  stage = 'delivery section by keyboard Enter'
  await script("document.querySelectorAll('.loom-section-tabs button')[2].focus()")
  await waitFor("document.activeElement === document.querySelectorAll('.loom-section-tabs button')[2]", 'Delivery tab did not take DOM focus before key input')
  pressKey('Enter')
  await expectPressed(2, 'Enter did not activate the 交付 section')
  const review = await script(`({
    candidates: document.querySelectorAll('.loom-delivery-context .loom-candidate').length,
    verificationBadges: [...document.querySelectorAll('.loom-badge-verification')].map(node => node.getAttribute('data-state')),
    acceptanceBadges: [...document.querySelectorAll('.loom-badge-acceptance')].map(node => node.getAttribute('data-state')),
    reviewedCandidates: document.querySelectorAll('.loom-candidate-review').length,
    staleCriteria: document.querySelector('.loom-criteria') === null,
    placeholder: document.querySelector('.loom-review-state') === null,
    controls: document.querySelectorAll('.loom-delivery-actions button').length,
    actionLabels: [...document.querySelectorAll('.loom-delivery-actions button')].map(button => button.innerText),
    reviewForm: document.querySelector('.loom-review-form') === null,
    sharedDelivery: document.querySelector('.loom-workspace .mission-delivery-panel') === window.__loomNodes.delivery,
    sharedActivity: document.querySelector('.loom-workspace .mission-activity-panel') === window.__loomNodes.activity,
    evidenceRows: document.querySelectorAll('.loom-workspace .mission-evidence-row').length,
    wrapperClass: document.querySelector('.loom-section-body > div:last-child').className
  })`)
  assert.equal(review.candidates, 2, `Delivery section must list every recorded candidate: ${JSON.stringify(review.candidates)}`)
  assert.deepEqual(review.verificationBadges, ['verified', 'unverified'], `Verification axis is not read per candidate: ${JSON.stringify(review.verificationBadges)}`)
  assert.deepEqual(review.acceptanceBadges, ['accepted', 'pending'], `Acceptance axis is not read per candidate: ${JSON.stringify(review.acceptanceBadges)}`)
  assert.equal(review.reviewedCandidates, 1, `Only the reviewed candidate may show a verdict: ${JSON.stringify(review.reviewedCandidates)}`)
  assert.equal(review.staleCriteria, true, 'Delivery section kept the placeholder criteria block after real criteria arrived')
  assert.equal(review.placeholder, true, 'Delivery section still shows the old independent-acceptance placeholder')
  assert.ok(review.controls >= 2, `Delivery section must offer acceptance and verification actions: ${JSON.stringify(review.controls)}`)
  assert.deepEqual(review.actionLabels, ['接受', '驳回', '通过核验', '核验失败'],
    `Delivery actions do not match the two independent human axes: ${JSON.stringify(review.actionLabels)}`)
  assert.equal(review.reviewForm, true, 'Delivery section expanded the review form before any user intent')
  assert.equal(review.sharedDelivery, true, 'Delivery section remounted the shared delivery panel')
  assert.equal(review.sharedActivity, true, 'Delivery section remounted the activity panel')
  assert.ok(review.evidenceRows >= 4, `Shared delivery evidence rows disappeared: ${review.evidenceRows}`)
  assert.equal(review.wrapperClass, 'loom-delivery', `Delivery section reused the wrong container class: ${review.wrapperClass}`)
  cases.push('交付 section reads real candidates with two independent verdict badges, acceptance and verification actions, no pre-expanded review form, and keeps the shared delivery panel mounted')

  stage = 'plan section by keyboard Space'
  await script("document.querySelectorAll('.loom-section-tabs button')[1].focus()")
  await waitFor("document.activeElement === document.querySelectorAll('.loom-section-tabs button')[1]", 'Plan tab did not take DOM focus before key input')
  pressKey('Space')
  await expectPressed(1, 'Space did not activate the 编排 section')
  cases.push('Space activates a non-default section from native keyboard input')

  stage = 'activity section by keyboard Enter'
  await script("document.querySelectorAll('.loom-section-tabs button')[0].focus()")
  await waitFor("document.activeElement === document.querySelectorAll('.loom-section-tabs button')[0]", 'Activity tab did not take DOM focus before key input')
  pressKey('Enter')
  await expectPressed(0, 'Enter did not return to the 活动 section')
  const returned = await script(`({
    activity: window.loomQA.countOf('missions.activity'),
    delivery: window.loomQA.countOf('missions.delivery'),
    tasks: window.loomQA.countOf('preferences.tasks.get'),
    changes: window.loomQA.countOf('missions.changes'),
    errors: window.loomQA.errors.slice(),
    sharedDelivery: document.querySelector('.loom-workspace .mission-delivery-panel') === window.__loomNodes.delivery,
    sharedActivity: document.querySelector('.loom-workspace .mission-activity-panel') === window.__loomNodes.activity,
    sharedUnread: document.querySelector('.mission-changes-unread') === window.__loomNodes.unread,
    stamps: [window.__loomNodes.delivery.__loomStamp, window.__loomNodes.activity.__loomStamp, window.__loomNodes.unread.__loomStamp],
    unreadVisible: (document.querySelector('.mission-changes-unread')?.offsetParent ?? null) !== null,
    wrapperClass: document.querySelector('.loom-section-body > div:last-child').className,
    wrapperHidden: document.querySelector('.loom-section-body > div:last-child').hidden
  })`)
  assert.equal(returned.activity, 1, `Returning to 活动 repeated the activity read: ${JSON.stringify(returned)}`)
  assert.equal(returned.delivery, 1, `Returning to 活动 repeated the delivery read: ${JSON.stringify(returned)}`)
  assert.ok(returned.tasks >= 1, `Task capability snapshot was never read: ${JSON.stringify(returned)}`)
  assert.equal(returned.changes, 0, 'Collapsed read state requested missions.changes without user intent')
  assert.deepEqual(returned.errors, [], `LOOM fixture answered an unexpected request: ${JSON.stringify(returned.errors)}`)
  assert.equal(returned.sharedDelivery, true, 'Delivery panel node changed identity across section switches')
  assert.equal(returned.sharedActivity, true, 'Activity panel node changed identity across section switches')
  assert.equal(returned.sharedUnread, true, 'Reading state node changed identity across section switches')
  assert.deepEqual(returned.stamps, ['delivery-a1', 'activity-a1', 'unread-a1'], 'Mounted panels were recreated instead of retained')
  assert.equal(returned.unreadVisible, true, 'Reading state is not visible after returning to 活动')
  assert.equal(returned.wrapperClass, 'mission-activity-document', `Activity container did not return: ${returned.wrapperClass}`)
  assert.equal(returned.wrapperHidden, false, 'Activity container stayed hidden after returning')
  cases.push('Returning to 活动 performs no repeat missions.activity read and does not unmount the reading state')

  stage = 'section scroll retention and activity spacing'
  const scrolled = await script(`(() => {
    const node = document.querySelector('.mission-activity-document')
    node.scrollTop = 600
    const deliveryStyle = getComputedStyle(document.querySelector('.mission-activity-document > .mission-delivery-panel'))
    const historyStyle = getComputedStyle(document.querySelector('.mission-activity-document > div > .mission-activity-panel'))
    return { top: node.scrollTop, deliveryPadding: deliveryStyle.paddingTop, historyPadding: historyStyle.paddingTop }
  })()`)
  assert(scrolled.top > 100, `Activity history must be scrollable before testing restoration: ${JSON.stringify(scrolled)}`)
  assert.equal(scrolled.deliveryPadding, '0px', `Activity delivery gained extra padding: ${JSON.stringify(scrolled)}`)
  assert.equal(scrolled.historyPadding, '0px', `Activity history gained extra padding: ${JSON.stringify(scrolled)}`)
  await click('.loom-section-tabs button:nth-of-type(3)')
  await expectPressed(2, 'Delivery did not open after activity scroll')
  const deliveryScroll = await script("document.querySelector('.loom-delivery').scrollTop")
  assert.equal(deliveryScroll, 0, 'Delivery must start at its own reading position')
  await click('.loom-section-tabs button:nth-of-type(1)')
  await expectPressed(0, 'Activity did not reopen after delivery scroll test')
  await waitFor(`Math.abs(document.querySelector('.mission-activity-document').scrollTop - ${scrolled.top}) <= 1`, 'Activity scroll position was not restored after section switch')
  cases.push('Activity retains its scroll position and original panel spacing across delivery switches')

  stage = 'delivery scroll retention'
  await click('.loom-section-tabs button:nth-of-type(3)')
  await expectPressed(2, 'Delivery did not open for its own scroll test')
  const deliveryScrolled = await script(`(() => {
    const node = document.querySelector('.loom-delivery')
    node.scrollTop = 180
    return { top: node.scrollTop, overflow: getComputedStyle(node).overflowY, outer: document.querySelector('.loom-section-body').scrollTop }
  })()`)
  assert(deliveryScrolled.top > 100, `Delivery must own its scrollable reading position: ${JSON.stringify(deliveryScrolled)}`)
  assert.equal(deliveryScrolled.outer, 0, 'Outer section body must not own delivery scrolling')
  await click('.loom-section-tabs button:nth-of-type(2)')
  await expectPressed(1, 'Plan did not open from scrolled delivery')
  await click('.loom-section-tabs button:nth-of-type(3)')
  await expectPressed(2, 'Delivery did not reopen from plan')
  await waitFor(`Math.abs(document.querySelector('.loom-delivery').scrollTop - ${deliveryScrolled.top}) <= 1`, 'Delivery scroll position was not restored after visiting plan')
  cases.push('Delivery owns and restores its scroll position across the short plan section')

  stage = 'screenshots'
  for (const [width, height] of [[1440, 920], [1040, 700]]) {
    window.setContentSize(width, height)
    await waitFor(`window.innerWidth === ${width} && window.innerHeight === ${height}`, `LOOM fixture did not resize to ${width}x${height}`)
    for (const theme of ['day', 'night']) {
      await script(`window.loomQA.setTheme('${theme}')`)
      await settle()
      for (const [index, section] of [[0, 'activity'], [1, 'plan'], [2, 'delivery']]) {
        await click(`.loom-section-tabs button:nth-of-type(${index + 1})`)
        await expectPressed(index, `Section ${section} did not activate before its ${theme} ${width}x${height} screenshot`)
        await settle()
        await capture(section, theme, `${width}x${height}`, 100)
      }
    }
  }
  stage = 'zoom 200%'
  window.setContentSize(1440, 920)
  await waitFor('window.innerWidth === 1440 && window.innerHeight === 920', 'LOOM fixture did not restore 1440x920 for the zoom check')
  window.webContents.setZoomFactor(2)
  await settle(400)
  for (const theme of ['day', 'night']) {
    await script(`window.loomQA.setTheme('${theme}')`)
    await settle()
    await click('.loom-section-tabs button:nth-of-type(1)')
    await expectPressed(0, `Activity did not activate at 200% zoom for the ${theme} screenshot`)
    await settle()
    await capture('activity', theme, '1440x920', 200)
  }
  window.webContents.setZoomFactor(1)
  await settle(400)

  stage = 'post screenshot retention'
  const final = await script(`({
    activity: window.loomQA.countOf('missions.activity'),
    delivery: window.loomQA.countOf('missions.delivery'),
    tasks: window.loomQA.countOf('preferences.tasks.get'),
    changes: window.loomQA.countOf('missions.changes'),
    errors: window.loomQA.errors.slice(),
    retainedDelivery: document.querySelector('.loom-workspace .mission-delivery-panel') === window.__loomNodes.delivery,
    retainedActivity: document.querySelector('.loom-workspace .mission-activity-panel') === window.__loomNodes.activity,
    retainedUnread: document.querySelector('.mission-changes-unread') === window.__loomNodes.unread
  })`)
  assert.equal(final.activity, 1, `Repeated section switching repeated the activity read: ${JSON.stringify(final)}`)
  assert.equal(final.delivery, 1, `Repeated section switching repeated the delivery read: ${JSON.stringify(final)}`)
  assert.ok(final.tasks >= 1, `Task capability snapshot was never read: ${JSON.stringify(final)}`)
  assert.equal(final.changes, 0, `Section switching read workspace changes without user intent: ${JSON.stringify(final)}`)
  assert.deepEqual(final.errors, [], `Unexpected requests after the screenshot sweep: ${JSON.stringify(final.errors)}`)
  assert.equal(final.retainedDelivery && final.retainedActivity && final.retainedUnread, true,
    'Screenshot section switching recreated a previously visited panel')
  cases.push('Repeated section switching after the screenshot sweep keeps one delivery read, one activity read and the same mounted panels')

  console.log(JSON.stringify({ ok: true, cases, shots, counts: final, output }))
  app.exit(0)
}).catch(async error => {
  try {
    writeFileSync(join(output, `loom-workspace-failure-${Date.now()}.png`), (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG())
  } catch {}
  console.error(`LOOM workspace fixture failed during ${stage}:`, error)
  console.error(JSON.stringify({ ok: false, stage, cases, shots, output }))
  app.exit(1)
})

const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const { isAbsolute, join } = require('node:path')
const { app, BrowserWindow } = require('electron')

const [renderer, userData, output] = process.argv.slice(2)
let stage = 'startup'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
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
    // A visual-acceptance fixture that writes PNGs must actually paint. A hidden window
    // produces no compositor frames on Windows, so `capturePage()` hands back the previous
    // frame and every screenshot silently lags one section behind its filename.
    show: true, width: 1440, height: 920, useContentSize: true,
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
  const pointForExpression = expression => script(`(() => {
    const element = ${expression}
    if (!element) return null
    const bounds = element.getClientRects()[0] ?? element.getBoundingClientRect()
    return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }
  })()`)
  const pointFor = selector => pointForExpression(`document.querySelector(${JSON.stringify(selector)})`)
  const clickAt = async (point, label) => {
    assert(point, `No pointer target for ${label}`)
    const zoom = window.webContents.getZoomFactor()
    point.x = Math.round(point.x * zoom)
    point.y = Math.round(point.y * zoom)
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const click = async selector => clickAt(await pointFor(selector), selector)
  // 交付用例要在某张候选卡片内部点按钮，指针目标是一个表达式而不是全局 CSS 选择器。
  const clickElement = async expression => clickAt(await pointForExpression(expression), expression)
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
  // 交付验收：候选卡片按内容（内容 hash）定位，不依赖列表下标，也不共用别条候选的状态。
  const TARGET_CANDIDATE = 'sha256:restore-runtime'
  const cardFor = hash => `[...document.querySelectorAll('.loom-delivery-context .loom-candidate')].find(card => (card.querySelector('.loom-candidate-meta')?.innerText ?? '').includes(${JSON.stringify(hash)}))`
  const inCard = (hash, selector) => `${cardFor(hash)}?.querySelector(${JSON.stringify(selector)}) ?? null`
  const criterionBox = (hash, index) => `${cardFor(hash)}?.querySelectorAll('.loom-review-criterion input')[${index}] ?? null`
  const submitFor = hash => `${cardFor(hash)}?.querySelector('.loom-review-form button[type=submit]') ?? null`
  const cardState = hash => script(`(() => {
    const card = ${cardFor(hash)}
    if (!card) return null
    const verification = card.querySelector('.loom-badge-verification')
    const acceptance = card.querySelector('.loom-badge-acceptance')
    const submit = card.querySelector('.loom-review-form button[type=submit]')
    const actionRow = card.querySelector(':scope > .loom-delivery-actions')
    return {
      verificationState: verification?.getAttribute('data-state') ?? null,
      verificationCopy: verification?.innerText ?? '',
      acceptanceState: acceptance?.getAttribute('data-state') ?? null,
      acceptanceCopy: acceptance?.innerText ?? '',
      actionRow: [...(actionRow?.querySelectorAll('button') ?? [])].map(button => button.innerText),
      forms: card.querySelectorAll('.loom-review-form').length,
      criteriaLabels: [...card.querySelectorAll('.loom-review-criterion-id')].map(node => node.innerText),
      checkboxes: [...card.querySelectorAll('.loom-review-criterion input')].map(input => input.checked),
      reason: card.querySelector('.loom-review-reason')?.value ?? null,
      submit: submit === null ? null : { label: submit.innerText, disabled: submit.disabled },
      review: card.querySelector('.loom-candidate-review')?.innerText ?? null,
      verification: card.querySelector('.loom-candidate-verification')?.innerText ?? null,
      failure: card.querySelector('.loom-review-failure')?.innerText ?? null
    }
  })()`)
  // 写入后的状态只能从控制面回读得到，所以断言要等回读落地，而不是等固定时长。
  const waitCard = async (hash, predicate, message) => {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const state = await cardState(hash)
      if (state !== null && predicate(state)) return state
      await sleep(30)
    }
    throw new Error(`${message}: ${JSON.stringify(await cardState(hash))}`)
  }
  // 受控输入框只认原生 setter + input 事件：直接赋 value 不会触发 React 的 onChange。
  const fillReason = (hash, text) => script(`(() => {
    const area = ${cardFor(hash)}?.querySelector('.loom-review-form textarea.loom-review-reason')
    if (!area) return null
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(area, ${JSON.stringify(text)})
    area.dispatchEvent(new Event('input', { bubbles: true }))
    return area.value
  })()`)
  const writeLog = () => script('window.loomQA.writes')
  // 逐条结论按 criterionId 绑定：只认渲染出来的「cN · 满足 / 未满足」两行。
  const criterionVerdicts = reviewText => reviewText.split('\n').map(line => line.trim())
    .filter(line => / · (未)?满足$/.test(line))
    .map(line => ({ criterionId: line.split(' · ')[0], satisfied: line.endsWith('· 满足') }))
  // 每条点击用例都从同一个初始态开始：数据回基线，工作区按基线重挂载并重读六个投影。
  const resetLoom = async () => {
    await script("(() => { const node = document.querySelector('.loom-workspace'); if (node) node.__loomReset = 'stale'; return true })()")
    await script('window.loomQA.reset()')
    await waitFor("document.querySelector('.loom-workspace') !== null && document.querySelector('.loom-workspace').__loomReset === undefined",
      'LOOM workspace did not remount from the reset baseline')
  }
  const openDelivery = async () => {
    await expectPressed(0, 'Reset did not land back on the activity section')
    await click('.loom-section-tabs button:nth-of-type(3)')
    await expectPressed(2, 'Delivery did not open after resetting the fixture')
    await waitFor("document.querySelectorAll('.loom-delivery-context .loom-candidate').length === 2",
      'Delivery section did not relist the two recorded candidates after the reset')
    await waitFor(`!!(${cardFor(TARGET_CANDIDATE)})`, 'The target candidate card is missing after the reset')
    // 只挪交付面板自己的滚动位置，不动整个文档的滚动位置，否则后面的 tab 点击会落空。
    await script(`(() => {
      const card = ${cardFor(TARGET_CANDIDATE)}
      const pane = document.querySelector('.loom-delivery')
      if (!card || !pane) return false
      const cardBox = card.getBoundingClientRect()
      const paneBox = pane.getBoundingClientRect()
      if (cardBox.top < paneBox.top || cardBox.bottom > paneBox.bottom) pane.scrollTop += cardBox.top - paneBox.top - 24
      return true
    })()`)
    await settle(120)
  }
  const capture = async (section, theme, size, zoom) => {
    const name = `loom-workspace-${section}-${theme}-${size}${zoom === 100 ? '' : '-zoom' + zoom}.png`
    const path = join(output, name)
    // Scroll-retention cases leave the panes part-way down. Screenshots are read by a human
    // deciding whether the surface is finished, so each one starts at the top of its pane.
    await script(`(() => {
      for (const selector of ['.loom-delivery', '.mission-activity-document']) {
        const pane = document.querySelector(selector)
        if (pane) pane.scrollTop = 0
      }
      window.scrollTo(0, 0)
      return true
    })()`)
    await settle(120)
    // Burn one frame so a section that was switched microseconds ago cannot be captured
    // from the compositor's previous output; only the second frame is written.
    await window.webContents.capturePage()
    await settle(120)
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
  for (const [width, height] of [[1440, 920], [1040, 700], [390, 844]]) {
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

  stage = 'delivery acceptance chain'
  await resetLoom()
  await openDelivery()
  const acceptStart = await cardState(TARGET_CANDIDATE)
  assert.equal(acceptStart.acceptanceState, 'pending', `Target candidate acceptance badge did not start pending: ${JSON.stringify(acceptStart)}`)
  assert.equal(acceptStart.acceptanceCopy, '待验收', `Acceptance badge copy changed: ${JSON.stringify(acceptStart.acceptanceCopy)}`)
  assert.equal(acceptStart.verificationState, 'unverified', `Target candidate verification axis did not start unverified: ${JSON.stringify(acceptStart.verificationState)}`)
  assert.deepEqual(acceptStart.actionRow, ['接受', '驳回', '通过核验', '核验失败'],
    `Target candidate lost its two independent action axes: ${JSON.stringify(acceptStart.actionRow)}`)
  assert.equal(acceptStart.forms, 0, 'The review form was already open before any pointer click')

  await clickElement(inCard(TARGET_CANDIDATE, '.loom-btn-accept'))
  const acceptOpened = await waitCard(TARGET_CANDIDATE, state => state.forms === 1, 'Accept did not open the per-criterion review form')
  assert.equal(await script("document.querySelectorAll('.loom-review-form').length"), 1,
    'Accept must open exactly one review form, on the clicked candidate only')
  assert.deepEqual(acceptOpened.criteriaLabels, ['c1', 'c2'],
    `Review form must list every versioned criterion once: ${JSON.stringify(acceptOpened.criteriaLabels)}`)
  assert.deepEqual(acceptOpened.checkboxes, [false, false], `Review form started with boxes already checked: ${JSON.stringify(acceptOpened.checkboxes)}`)
  assert.deepEqual(acceptOpened.submit, { label: '确认接受', disabled: true },
    `Accept started submittable before any criterion was checked: ${JSON.stringify(acceptOpened.submit)}`)

  const reasonText = '  恢复路径已按计划实现，证据齐全  '
  const trimmedReason = reasonText.trim()
  assert.equal(await fillReason(TARGET_CANDIDATE, reasonText), reasonText, 'The reason textarea did not take the typed reason')
  await settle(120)
  const acceptMissing = await cardState(TARGET_CANDIDATE)
  assert.equal(acceptMissing.reason, reasonText, `Reason input lost the typed text: ${JSON.stringify(acceptMissing.reason)}`)
  assert.deepEqual(acceptMissing.checkboxes, [false, false], `Criterion boxes changed without a click: ${JSON.stringify(acceptMissing.checkboxes)}`)
  assert.equal(acceptMissing.submit.disabled, true, 'Accept must stay disabled until every criterion is checked')
  await clickElement(submitFor(TARGET_CANDIDATE))
  await settle(160)
  assert.equal(await script("window.loomQA.countOf('loom.review.record')"), 0, 'A blocked accept still sent loom.review.record')
  assert.equal((await cardState(TARGET_CANDIDATE)).forms, 1, 'A blocked accept closed the review form')

  await clickElement(criterionBox(TARGET_CANDIDATE, 0))
  await clickElement(criterionBox(TARGET_CANDIDATE, 1))
  await waitCard(TARGET_CANDIDATE, state => state.checkboxes.length === 2 && state.checkboxes.every(checked => checked === true),
    'Both criterion checkboxes did not toggle from pointer clicks')

  await fillReason(TARGET_CANDIDATE, '    ')
  await settle(120)
  const acceptBlank = await cardState(TARGET_CANDIDATE)
  assert.equal(acceptBlank.reason, '    ', `Whitespace reason input lost what was typed: ${JSON.stringify(acceptBlank.reason)}`)
  assert.deepEqual(acceptBlank.checkboxes, [true, true], `Criterion checkboxes lost their state: ${JSON.stringify(acceptBlank.checkboxes)}`)
  assert.equal(acceptBlank.submit.disabled, true, 'Accept must stay disabled when the reason is only whitespace')
  await clickElement(submitFor(TARGET_CANDIDATE))
  await settle(160)
  assert.equal(await script("window.loomQA.countOf('loom.review.record')"), 0, 'A whitespace-only accept reason still sent loom.review.record')

  await fillReason(TARGET_CANDIDATE, reasonText)
  await settle(120)
  const acceptReady = await cardState(TARGET_CANDIDATE)
  assert.deepEqual(acceptReady.submit, { label: '确认接受', disabled: false },
    `A fully checked accept with a reason did not become submittable: ${JSON.stringify(acceptReady.submit)}`)
  await clickElement(submitFor(TARGET_CANDIDATE))
  await waitFor("window.loomQA.countOf('loom.review.record') >= 1", 'Accept never sent loom.review.record')
  assert.equal(await script("window.loomQA.countOf('loom.review.record')"), 1, 'Accept must send exactly one loom.review.record')
  const accepted = await waitCard(TARGET_CANDIDATE, state => state.acceptanceState === 'accepted' && state.forms === 0,
    'The accepted verdict was never read back into the delivery section')
  assert.equal(accepted.acceptanceCopy, '已验收', `Accepted badge copy is not the recorded verdict: ${JSON.stringify(accepted.acceptanceCopy)}`)
  assert.deepEqual(accepted.actionRow, ['通过核验', '核验失败'],
    `Accept must remove its own buttons and keep the verification buttons: ${JSON.stringify(accepted.actionRow)}`)
  assert.equal(accepted.verificationState, 'unverified', 'Accepting a candidate must not move the verification axis')
  assert.deepEqual(accepted.criteriaLabels, [], 'The collapsed review form left its criteria behind')
  assert.equal(typeof accepted.review, 'string', `The accepted review was not rendered back: ${JSON.stringify(accepted.review)}`)
  const acceptedLines = accepted.review.split('\n').map(line => line.trim()).filter(line => line !== '')
  assert(acceptedLines.some(line => line.includes('验收结论：通过')), `The accepted verdict line is missing: ${JSON.stringify(accepted.review)}`)
  assert(acceptedLines.some(line => line.includes(trimmedReason)), `The written reason was not rendered back: ${JSON.stringify(accepted.review)}`)
  assert.equal(acceptedLines.filter(line => line.includes(reasonText)).length, 0, 'The acceptance reason was rendered untrimmed')
  assert.deepEqual(criterionVerdicts(accepted.review), [{ criterionId: 'c1', satisfied: true }, { criterionId: 'c2', satisfied: true }],
    `The accepted review must show two satisfied criteria: ${JSON.stringify(accepted.review)}`)

  const acceptedWrites = await writeLog()
  assert.equal(acceptedWrites.length, 1, `Accept must send exactly one write: ${JSON.stringify(acceptedWrites)}`)
  const reviewWrite = acceptedWrites[0]
  assert.equal(reviewWrite.method, 'loom.review.record', `Unexpected write method: ${JSON.stringify(reviewWrite.method)}`)
  const reviewPayload = reviewWrite.params
  assert.equal(reviewPayload.missionId, 'mission-loom-018', `Review payload lost the mission id: ${JSON.stringify(reviewPayload)}`)
  assert.equal(reviewPayload.candidateId, 'candidate-2', `Review payload must address the clicked candidate: ${JSON.stringify(reviewPayload.candidateId)}`)
  assert.equal(reviewPayload.taskId, 'task-3', `Review payload must address the clicked candidate task: ${JSON.stringify(reviewPayload.taskId)}`)
  assert.equal('reviewerId' in reviewPayload, false, 'Clients must not send reviewerId; Core injects it')
  assert.match(reviewPayload.commandId, UUID_PATTERN, `Review commandId is not a UUID: ${JSON.stringify(reviewPayload.commandId)}`)
  const acceptState = await script('window.loomQA.state()')
  const acceptTask = acceptState.tasks.find(task => task.taskId === 'task-3')
  assert.equal(reviewWrite.receipt.planId, acceptState.plan.planId, `Receipt plan does not match the plan projection: ${JSON.stringify(reviewWrite.receipt)}`)
  assert.equal(acceptTask.planId, acceptState.plan.planId, 'The task and the plan disagree about the plan id')
  assert.equal(reviewPayload.acceptanceCriteriaVersion, acceptState.plan.acceptanceCriteria.version,
    'The review must pin the plan criteria version')
  assert.equal(reviewPayload.verdict, 'accepted', `Review payload lost the verdict: ${JSON.stringify(reviewPayload.verdict)}`)
  assert.equal(reviewPayload.reason, trimmedReason, `The recorded reason must be trimmed: ${JSON.stringify(reviewPayload.reason)}`)
  assert.deepEqual(reviewPayload.criteriaResults, [
    { criterionId: 'c1', satisfied: true, evidenceIds: [], note: null },
    { criterionId: 'c2', satisfied: true, evidenceIds: [], note: null }
  ], `Review criteria results must cover every criterion once, follow the checks and invent no evidence: ${JSON.stringify(reviewPayload.criteriaResults)}`)
  assert.equal(reviewWrite.receipt.missionId, 'mission-loom-018', `Receipt lost the mission id: ${JSON.stringify(reviewWrite.receipt)}`)
  assert.equal(reviewWrite.receipt.taskId, 'task-3', `Receipt lost the task id: ${JSON.stringify(reviewWrite.receipt)}`)
  assert.equal(reviewWrite.receipt.taskStatus, 'done', `An accepted review must move the task to done: ${JSON.stringify(reviewWrite.receipt.taskStatus)}`)
  assert.equal(reviewWrite.receipt.candidateAcceptanceStatus, 'accepted', `Receipt acceptance status is wrong: ${JSON.stringify(reviewWrite.receipt.candidateAcceptanceStatus)}`)
  assert.deepEqual(reviewWrite.receipt.releasedDependencyIds, [], `Receipt released dependencies it never evaluated: ${JSON.stringify(reviewWrite.receipt.releasedDependencyIds)}`)
  assert.equal(reviewWrite.receipt.replayed, false, `A first acceptance must not claim replay: ${JSON.stringify(reviewWrite.receipt.replayed)}`)
  assert.equal(acceptTask.status, 'done', 'The read-back task status must follow the acceptance receipt')
  assert.equal(acceptState.candidates.find(candidate => candidate.candidateId === 'candidate-2').acceptanceStatus, 'accepted',
    'The read-back candidate must carry the accepted verdict')
  assert.equal(acceptState.reviews.filter(review => review.candidateId === 'candidate-2').length, 1, 'The review write must add exactly one row')
  assert.equal(await script("window.loomQA.countOf('loom.candidates.list')"), 2, 'The accepted verdict must be re-read exactly once after the write')
  cases.push('接受 stays blocked until every criterion is checked and the reason is non-blank, writes exactly one loom.review.record, reads accepted back and leaves the verification axis untouched')

  stage = 'delivery rejection chain'
  await resetLoom()
  await openDelivery()
  const rejectStart = await cardState(TARGET_CANDIDATE)
  assert.equal(rejectStart.acceptanceState, 'pending', `Reset did not restore the pending acceptance axis: ${JSON.stringify(rejectStart.acceptanceState)}`)
  assert.deepEqual(rejectStart.actionRow, ['接受', '驳回', '通过核验', '核验失败'],
    `Reset did not restore both action axes: ${JSON.stringify(rejectStart.actionRow)}`)

  await clickElement(inCard(TARGET_CANDIDATE, '.loom-btn-reject'))
  const rejectOpened = await waitCard(TARGET_CANDIDATE, state => state.forms === 1, 'Reject did not open the review form')
  assert.deepEqual(rejectOpened.submit, { label: '确认驳回', disabled: true },
    `Reject started submittable without a reason: ${JSON.stringify(rejectOpened.submit)}`)
  await clickElement(submitFor(TARGET_CANDIDATE))
  await settle(160)
  assert.equal(await script("window.loomQA.countOf('loom.review.record')"), 0, 'A reject without a reason still sent loom.review.record')

  const rejectReason = '  证据不足，证据链条缺一份恢复日志  '
  assert.equal(await fillReason(TARGET_CANDIDATE, rejectReason), rejectReason, 'The reject reason textarea did not take the typed reason')
  await settle(120)
  const rejectReady = await cardState(TARGET_CANDIDATE)
  assert.deepEqual(rejectReady.checkboxes, [false, false], `Reject must not demand criterion checks: ${JSON.stringify(rejectReady.checkboxes)}`)
  assert.deepEqual(rejectReady.submit, { label: '确认驳回', disabled: false },
    `A reject with a reason and no checks must be submittable: ${JSON.stringify(rejectReady.submit)}`)
  await clickElement(submitFor(TARGET_CANDIDATE))
  await waitFor("window.loomQA.countOf('loom.review.record') >= 1", 'Reject never sent loom.review.record')
  assert.equal(await script("window.loomQA.countOf('loom.review.record')"), 1, 'Reject must send exactly one loom.review.record')
  const rejected = await waitCard(TARGET_CANDIDATE, state => state.acceptanceState === 'rejected' && state.forms === 0,
    'The rejected verdict was never read back into the delivery section')
  assert.equal(rejected.acceptanceCopy, '已驳回', `Rejected badge copy is not the recorded verdict: ${JSON.stringify(rejected.acceptanceCopy)}`)
  assert.deepEqual(rejected.actionRow, ['通过核验', '核验失败'],
    `Reject must remove its own buttons and keep the verification buttons: ${JSON.stringify(rejected.actionRow)}`)
  assert.equal(rejected.verificationState, 'unverified', 'Rejecting a candidate must not move the verification axis')
  const rejectedLines = rejected.review.split('\n').map(line => line.trim()).filter(line => line !== '')
  assert(rejectedLines.some(line => line.includes('验收结论：驳回')), `The rejected verdict line is missing: ${JSON.stringify(rejected.review)}`)
  assert(rejectedLines.some(line => line.includes(rejectReason.trim())), `The written reject reason was not rendered back: ${JSON.stringify(rejected.review)}`)
  assert.deepEqual(criterionVerdicts(rejected.review), [{ criterionId: 'c1', satisfied: false }, { criterionId: 'c2', satisfied: false }],
    `A rejection that checked nothing must record every criterion as unsatisfied: ${JSON.stringify(rejected.review)}`)

  const rejectedWrites = await writeLog()
  assert.equal(rejectedWrites.length, 1, `Reject must send exactly one write: ${JSON.stringify(rejectedWrites)}`)
  const rejectWrite = rejectedWrites[0]
  assert.equal(rejectWrite.method, 'loom.review.record', `Unexpected reject write method: ${JSON.stringify(rejectWrite.method)}`)
  const rejectPayload = rejectWrite.params
  assert.equal(rejectPayload.candidateId, 'candidate-2', `Reject payload must address the clicked candidate: ${JSON.stringify(rejectPayload.candidateId)}`)
  assert.equal(rejectPayload.taskId, 'task-3', `Reject payload must address the clicked candidate task: ${JSON.stringify(rejectPayload.taskId)}`)
  assert.equal('reviewerId' in rejectPayload, false, 'Clients must not send reviewerId; Core injects it')
  assert.match(rejectPayload.commandId, UUID_PATTERN, `Reject commandId is not a UUID: ${JSON.stringify(rejectPayload.commandId)}`)
  const rejectState = await script('window.loomQA.state()')
  assert.equal(rejectWrite.receipt.planId, rejectState.plan.planId, `Reject receipt plan does not match the plan projection: ${JSON.stringify(rejectWrite.receipt)}`)
  assert.equal(rejectPayload.acceptanceCriteriaVersion, rejectState.plan.acceptanceCriteria.version, 'The rejection must pin the plan criteria version')
  assert.equal(rejectPayload.verdict, 'rejected', `Reject payload lost the verdict: ${JSON.stringify(rejectPayload.verdict)}`)
  assert.equal(rejectPayload.reason, rejectReason.trim(), `The recorded reject reason must be trimmed: ${JSON.stringify(rejectPayload.reason)}`)
  assert.deepEqual(rejectPayload.criteriaResults, [
    { criterionId: 'c1', satisfied: false, evidenceIds: [], note: null },
    { criterionId: 'c2', satisfied: false, evidenceIds: [], note: null }
  ], `Reject criteria results must cover every criterion once and invent no evidence: ${JSON.stringify(rejectPayload.criteriaResults)}`)
  assert.equal(rejectWrite.receipt.taskStatus, 'ready', `A rejected review must move the task back to ready: ${JSON.stringify(rejectWrite.receipt.taskStatus)}`)
  assert.equal(rejectWrite.receipt.candidateAcceptanceStatus, 'rejected', `Reject receipt acceptance status is wrong: ${JSON.stringify(rejectWrite.receipt.candidateAcceptanceStatus)}`)
  assert.deepEqual(rejectWrite.receipt.releasedDependencyIds, [], `Reject receipt released dependencies it never evaluated: ${JSON.stringify(rejectWrite.receipt.releasedDependencyIds)}`)
  assert.equal(rejectWrite.receipt.replayed, false, `A first rejection must not claim replay: ${JSON.stringify(rejectWrite.receipt.replayed)}`)
  assert.equal(rejectState.tasks.find(task => task.taskId === 'task-3').status, 'ready', 'The read-back task status must follow the rejection receipt')
  assert.equal(rejectState.candidates.find(candidate => candidate.candidateId === 'candidate-2').acceptanceStatus, 'rejected',
    'The read-back candidate must carry the rejected verdict')
  assert.equal(rejectState.reviews.filter(review => review.candidateId === 'candidate-2').length, 1, 'The rejection write must add exactly one row')
  cases.push('驳回 requires a reason but no criterion checks, writes exactly one loom.review.record, reads rejected back and leaves the verification axis untouched')

  stage = 'delivery verification passed'
  await resetLoom()
  await openDelivery()
  const verifyStart = await cardState(TARGET_CANDIDATE)
  assert.equal(verifyStart.verificationState, 'unverified', `Reset did not restore the unverified axis: ${JSON.stringify(verifyStart.verificationState)}`)
  assert.equal(verifyStart.acceptanceState, 'pending', `Reset did not restore the pending acceptance axis: ${JSON.stringify(verifyStart.acceptanceState)}`)
  assert.equal(verifyStart.forms, 0, 'The review form was open before any verification click')

  await clickElement(inCard(TARGET_CANDIDATE, '.loom-btn-verify'))
  await waitFor("window.loomQA.countOf('loom.verification.record') >= 1", 'Verify never sent loom.verification.record')
  assert.equal(await script("window.loomQA.countOf('loom.verification.record')"), 1, 'Verify must send exactly one loom.verification.record')
  const verified = await waitCard(TARGET_CANDIDATE, state => state.verificationState === 'verified',
    'The verified verdict was never read back into the delivery section')
  assert.equal(verified.verificationCopy, '已核验', `Verified badge copy is not the recorded verdict: ${JSON.stringify(verified.verificationCopy)}`)
  assert.deepEqual(verified.actionRow, ['接受', '驳回'],
    `Both verification buttons must disappear once a verification is recorded: ${JSON.stringify(verified.actionRow)}`)
  assert.equal(verified.acceptanceState, 'pending', 'Verification must not decide the acceptance axis')
  assert.equal(verified.acceptanceCopy, '待验收', `Verification moved the acceptance badge copy: ${JSON.stringify(verified.acceptanceCopy)}`)
  assert.equal(verified.forms, 0, 'Verification must not open the acceptance form')
  assert.equal(typeof verified.verification, 'string', `The verification was not rendered back: ${JSON.stringify(verified.verification)}`)
  assert(verified.verification.includes('通过'), `The verification result line is missing: ${JSON.stringify(verified.verification)}`)
  assert(verified.verification.includes('人工核验'), `The verification method is not the manual one: ${JSON.stringify(verified.verification)}`)

  const verifiedWrites = await writeLog()
  assert.equal(verifiedWrites.length, 1, `Verify must send exactly one write: ${JSON.stringify(verifiedWrites)}`)
  const verifiedWrite = verifiedWrites[0]
  assert.equal(verifiedWrite.method, 'loom.verification.record', `Unexpected verify write method: ${JSON.stringify(verifiedWrite.method)}`)
  const verifiedPayload = verifiedWrite.params
  assert.equal(verifiedPayload.missionId, 'mission-loom-018', `Verify payload lost the mission id: ${JSON.stringify(verifiedPayload)}`)
  assert.equal(verifiedPayload.candidateId, 'candidate-2', `Verify payload must address the clicked candidate: ${JSON.stringify(verifiedPayload.candidateId)}`)
  assert.equal(verifiedPayload.taskId, 'task-3', `Verify payload must address the clicked candidate task: ${JSON.stringify(verifiedPayload.taskId)}`)
  assert.equal('executorId' in verifiedPayload, false, 'Clients must not send executorId; Core injects it')
  assert.match(verifiedPayload.commandId, UUID_PATTERN, `Verify commandId is not a UUID: ${JSON.stringify(verifiedPayload.commandId)}`)
  assert.equal(verifiedPayload.method, 'manual', `The manual verify button must report the manual method: ${JSON.stringify(verifiedPayload.method)}`)
  assert.equal(verifiedPayload.result, 'passed', `The verify payload result does not match the clicked button: ${JSON.stringify(verifiedPayload.result)}`)
  const verifiedState = await script('window.loomQA.state()')
  assert.equal(verifiedWrite.receipt.planId, verifiedState.plan.planId, `Verify receipt plan does not match the plan projection: ${JSON.stringify(verifiedWrite.receipt)}`)
  assert.equal(verifiedWrite.receipt.taskId, 'task-3', `Verify receipt lost the task id: ${JSON.stringify(verifiedWrite.receipt)}`)
  assert.equal(verifiedWrite.receipt.candidateVerificationStatus, 'verified', `Verify receipt status is wrong: ${JSON.stringify(verifiedWrite.receipt.candidateVerificationStatus)}`)
  assert.deepEqual(verifiedWrite.receipt.releasedDependencyIds, [], `Verify receipt released dependencies it never evaluated: ${JSON.stringify(verifiedWrite.receipt.releasedDependencyIds)}`)
  assert.equal(verifiedWrite.receipt.replayed, false, `A first verification must not claim replay: ${JSON.stringify(verifiedWrite.receipt.replayed)}`)
  assert.equal(verifiedState.candidates.find(candidate => candidate.candidateId === 'candidate-2').verificationStatus, 'verified',
    'The read-back candidate must carry the verified status')
  assert.equal(verifiedState.candidates.find(candidate => candidate.candidateId === 'candidate-2').acceptanceStatus, 'pending',
    'Verifying must leave the acceptance axis pending')
  assert.equal(verifiedState.verifications.filter(verification => verification.candidateId === 'candidate-2').length, 1, 'The verification write must add exactly one row')
  assert.equal(await script("window.loomQA.countOf('loom.verifications.list')"), 2, 'The verified status must be re-read exactly once after the write')
  cases.push('通过核验 writes exactly one loom.verification.record with the manual method, reads verified back and keeps the acceptance axis pending with its buttons')

  stage = 'delivery verification failed'
  await resetLoom()
  await openDelivery()
  const failStart = await cardState(TARGET_CANDIDATE)
  assert.equal(failStart.verificationState, 'unverified', `Reset did not restore the unverified axis before the failed run: ${JSON.stringify(failStart.verificationState)}`)
  assert.equal(failStart.acceptanceState, 'pending', `The failed run did not start from a pending acceptance axis: ${JSON.stringify(failStart.acceptanceState)}`)

  await clickElement(inCard(TARGET_CANDIDATE, '.loom-btn-verify[data-result="failed"]'))
  await waitFor("window.loomQA.countOf('loom.verification.record') >= 1", '核验失败 never sent loom.verification.record')
  assert.equal(await script("window.loomQA.countOf('loom.verification.record')"), 1, '核验失败 must send exactly one loom.verification.record')
  const failed = await waitCard(TARGET_CANDIDATE, state => state.verificationState === 'failed',
    'The failed verdict was never read back into the delivery section')
  assert.equal(failed.verificationCopy, '核验失败', `Failed badge copy is not the recorded verdict: ${JSON.stringify(failed.verificationCopy)}`)
  assert.deepEqual(failed.actionRow, ['接受', '驳回'],
    `Both verification buttons must disappear after a failed verification: ${JSON.stringify(failed.actionRow)}`)
  assert.equal(failed.acceptanceState, 'pending', 'A failed verification must not decide the acceptance axis')
  assert.equal(failed.forms, 0, 'A failed verification must not open the acceptance form')
  assert.equal(typeof failed.verification, 'string', `The failed verification was not rendered back: ${JSON.stringify(failed.verification)}`)
  assert(failed.verification.includes('失败'), `The failed verification line is missing: ${JSON.stringify(failed.verification)}`)
  assert(failed.verification.includes('人工核验'), `The failed verification method is not the manual one: ${JSON.stringify(failed.verification)}`)

  const failedWrites = await writeLog()
  assert.equal(failedWrites.length, 1, `核验失败 must send exactly one write: ${JSON.stringify(failedWrites)}`)
  const failedWrite = failedWrites[0]
  assert.equal(failedWrite.method, 'loom.verification.record', `Unexpected failed write method: ${JSON.stringify(failedWrite.method)}`)
  const failedPayload = failedWrite.params
  assert.equal(failedPayload.candidateId, 'candidate-2', `Failed payload must address the clicked candidate: ${JSON.stringify(failedPayload.candidateId)}`)
  assert.equal(failedPayload.taskId, 'task-3', `Failed payload must address the clicked candidate task: ${JSON.stringify(failedPayload.taskId)}`)
  assert.equal('executorId' in failedPayload, false, 'Clients must not send executorId; Core injects it')
  assert.match(failedPayload.commandId, UUID_PATTERN, `Failed commandId is not a UUID: ${JSON.stringify(failedPayload.commandId)}`)
  assert.equal(failedPayload.method, 'manual', `The failed button must still report the manual method: ${JSON.stringify(failedPayload.method)}`)
  assert.equal(failedPayload.result, 'failed', `The failed payload result does not match the clicked button: ${JSON.stringify(failedPayload.result)}`)
  const failedState = await script('window.loomQA.state()')
  assert.equal(failedWrite.receipt.planId, failedState.plan.planId, `Failed receipt plan does not match the plan projection: ${JSON.stringify(failedWrite.receipt)}`)
  assert.equal(failedWrite.receipt.taskId, 'task-3', `Failed receipt lost the task id: ${JSON.stringify(failedWrite.receipt)}`)
  assert.equal(failedWrite.receipt.candidateVerificationStatus, 'failed', `Failed receipt status is wrong: ${JSON.stringify(failedWrite.receipt.candidateVerificationStatus)}`)
  assert.deepEqual(failedWrite.receipt.releasedDependencyIds, [], `Failed receipt released dependencies it never evaluated: ${JSON.stringify(failedWrite.receipt.releasedDependencyIds)}`)
  assert.equal(failedWrite.receipt.replayed, false, `A first failed verification must not claim replay: ${JSON.stringify(failedWrite.receipt.replayed)}`)
  assert.equal(failedState.candidates.find(candidate => candidate.candidateId === 'candidate-2').verificationStatus, 'failed',
    'The read-back candidate must carry the failed status')
  assert.equal(failedState.verifications.filter(verification => verification.candidateId === 'candidate-2').length, 1, 'The failed verification write must add exactly one row')
  cases.push('核验失败 writes exactly one loom.verification.record from its own initial state, reads the failed badge back and keeps the acceptance axis pending with its buttons')

  assert.deepEqual(await script('window.loomQA.errors'), [], 'The delivery write cases requested a method the fixture did not answer')

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

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
// 指针几何证据单独一栏：证明「真的滚出视区、滚回来之后才点得到」，不占 cases 名额。
const uiGeometry = {}
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
  // 目标可能滚在自己的滚动容器里（编排/交付面板都是），先滚进可视区再量；
  // 量完还要过一遍命中测试：坐标落在视窗外、或被别的元素盖住，都必须响亮地失败，
  // 而不是发一次打空的 sendInputEvent 让后面干等 8 秒。
  const pointForExpression = expression => script(`(() => {
    const element = ${expression}
    if (!element) return null
    element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
    const bounds = element.getClientRects()[0] ?? element.getBoundingClientRect()
    const x = Math.min(Math.max(Math.round(bounds.x + bounds.width / 2), 0), window.innerWidth - 1)
    const y = Math.min(Math.max(Math.round(bounds.y + bounds.height / 2), 0), window.innerHeight - 1)
    const hit = document.elementFromPoint(x, y)
    if (hit !== element && !element.contains(hit)) {
      const describe = node => node === null || node === undefined
        ? 'null'
        : node.tagName.toLowerCase() + (typeof node.className === 'string' && node.className !== ''
          ? '.' + node.className.trim().split(/\\s+/u).join('.')
          : '')
      const pane = document.querySelector('.loom-plan')
      throw new Error([
        'LOOM fixture pointer target is not clickable at its own centre.',
        'target=' + describe(element),
        'hit=' + describe(hit),
        'rect=' + JSON.stringify({
          x: Math.round(bounds.x), y: Math.round(bounds.y),
          width: Math.round(bounds.width), height: Math.round(bounds.height),
          top: Math.round(bounds.top), bottom: Math.round(bounds.bottom)
        }),
        'point=' + JSON.stringify({ x, y }),
        'innerSize=' + JSON.stringify({ width: window.innerWidth, height: window.innerHeight }),
        'planScrollTop=' + Math.round(pane?.scrollTop ?? -1)
      ].join(' '))
    }
    return { x, y }
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
  // Open real disclosure summaries using native pointer input before reaching a
  // deliberately collapsed control. The hit-test guard still applies to both.
  const revealControl = async expression => {
    const summary = `(() => {
      const element = ${expression}
      let closed = null
      for (let node = element?.parentElement; node; node = node.parentElement) {
        if (node.tagName === 'DETAILS' && !node.open) closed = node
      }
      return closed?.querySelector(':scope > summary') ?? null
    })()`
    for (let count = 0; count < 8; count++) {
      if (!await script(`Boolean(${summary})`)) return
      await clickAt(await pointForExpression(summary), 'Open control disclosure')
      await settle(80)
    }
    throw new Error('Control remained inside a closed disclosure')
  }
  const click = async selector => {
    await revealControl(`document.querySelector(${JSON.stringify(selector)})`)
    return clickAt(await pointFor(selector), selector)
  }
  const clickElement = async expression => {
    await revealControl(expression)
    return clickAt(await pointForExpression(expression), expression)
  }
  const pressKey = keyCode => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode === 'Enter') window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  }
  const pressed = () => script("[...document.querySelectorAll('.loom-section-tabs button')].map(button => button.getAttribute('aria-pressed'))")
  // 生产现在是四块（工作／流程／资产／电脑）：状态数组长度必须跟真实按钮数一致，且恰好一处
  // aria-pressed=true。长度写死 4，多一块或少一块都要响亮地失败。
  const SECTION_TABS = 4
  const expectPressed = async (index, message) => {
    await waitFor(`document.querySelectorAll('.loom-section-tabs button')[${index}]?.getAttribute('aria-pressed') === 'true'`, message)
    const state = await pressed()
    assert.equal(state.length, SECTION_TABS, `Unexpected LOOM section tab count ${JSON.stringify(state)}`)
    assert.deepEqual(state, Array.from({ length: SECTION_TABS }, (_, position) => position === index ? 'true' : 'false'),
      `Unexpected LOOM section state ${JSON.stringify(state)}`)
  }
  // 共享的交付／活动面板现在收在「活动与交付记录」折叠区里：要读它们的文案、可见性或高度
  // 必须先显式展开。默认折叠态就是生产默认态，截图也按默认态拍。
  const ACTIVITY_DETAILS = '.loom-workspace details[data-details="activity"]'
  const setActivityDetails = async open => {
    await script(`(() => {
      const details = document.querySelector(${JSON.stringify(ACTIVITY_DETAILS)})
      if (!details) return null
      details.open = ${open ? 'true' : 'false'}
      return details.open
    })()`)
    await settle(120)
  }
  const openActivityDetails = async message => {
    await waitFor(`!!document.querySelector(${JSON.stringify(ACTIVITY_DETAILS)})`, message, 15000)
    await setActivityDetails(true)
    await waitFor(`document.querySelector(${JSON.stringify(ACTIVITY_DETAILS)})?.open === true`, message)
  }
  const resizeTo = async (width, height, label) => {
    window.setContentSize(width, height)
    await waitFor(`window.innerWidth === ${width} && window.innerHeight === ${height}`,
      `LOOM fixture did not resize to ${width}x${height} for ${label}`)
    await settle(200)
  }
  // 候选卡里的折叠区（证据/详情）展开后是真实的阅读长度：只有量滚动的用例才需要它，
  // 其余时候保持默认折叠，截图也不改动。
  const setCandidateDetails = async open => {
    const count = await script(`(() => {
      const nodes = [...document.querySelectorAll('.loom-delivery-context .loom-candidate details')]
      for (const node of nodes) node.open = ${open ? 'true' : 'false'}
      return nodes.length
    })()`)
    await settle(120)
    return count
  }
  // 交付验收：候选卡片按内容（内容 hash）定位，不依赖列表下标，也不共用别条候选的状态。
  const TARGET_CANDIDATE = 'sha256:restore-runtime'
  const cardFor = hash => `[...document.querySelectorAll('.loom-delivery-context .loom-candidate')].find(card => (card.querySelector('.loom-candidate-meta')?.textContent ?? '').includes(${JSON.stringify(hash)}))`
  const inCard = (hash, selector) => `${cardFor(hash)}?.querySelector(${JSON.stringify(selector)}) ?? null`
  const criterionBox = (hash, index) => `${cardFor(hash)}?.querySelectorAll('.loom-review-criterion input')[${index}] ?? null`
  const submitFor = hash => `${cardFor(hash)}?.querySelector('.loom-review-form button[type=submit]') ?? null`
  const cardState = hash => script(`(() => {
    const card = ${cardFor(hash)}
    if (!card) return null
    const verification = card.querySelector('.loom-badge-verification')
    const acceptance = card.querySelector('.loom-badge-acceptance')
    const submit = card.querySelector('.loom-review-form button[type=submit]')
    const actionRow = card
    return {
      verificationState: verification?.getAttribute('data-state') ?? null,
      verificationCopy: verification?.innerText ?? '',
      acceptanceState: acceptance?.getAttribute('data-state') ?? null,
      acceptanceCopy: acceptance?.innerText ?? '',
      actionRow: [...(actionRow?.querySelectorAll('.loom-delivery-actions button') ?? [])].map(button => button.textContent.trim()),
      forms: card.querySelectorAll('.loom-review-form').length,
      criteriaLabels: [...card.querySelectorAll('.loom-review-criterion-id')].map(node => node.innerText),
      checkboxes: [...card.querySelectorAll('.loom-review-criterion input')].map(input => input.checked),
      reason: card.querySelector('.loom-review-reason')?.value ?? null,
      submit: submit === null ? null : { label: submit.innerText, disabled: submit.disabled },
      review: card.querySelector('.loom-candidate-review') ? [...card.querySelector('.loom-candidate-review').children].map(node => node.textContent).join('\\n') : null,
      verification: card.querySelector('.loom-candidate-verification')?.textContent ?? null,
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
  // 写后回读的精确预算：八个读方法各「挂载 1 次 + 写后刷新 1 次」，多一次少一次都 FAIL。
  // activity / delivery 沿用本文件既有计数规则（恒为 1）。任务能力快照不在这里验：各写用例都先
  // resetLoom() 再重挂载，而能力快照只在首屏挂载那条路径上读，故 preferences.tasks.get 只在
  // 首屏 / 回切 / 截图后三处断言，写用例里不断言它。
  const expectWriteReadback = async label => {
    const counts = await script(`({
      activity: window.loomQA.countOf('missions.activity'),
      delivery: window.loomQA.countOf('missions.delivery'),
      tasks: window.loomQA.countOf('preferences.tasks.get'),
      plan: window.loomQA.countOf('loom.plan.get'),
      tasksList: window.loomQA.countOf('loom.tasks.list'),
      dependencies: window.loomQA.countOf('loom.dependencies.list'),
      candidates: window.loomQA.countOf('loom.candidates.list'),
      reviews: window.loomQA.countOf('loom.reviews.list'),
      verifications: window.loomQA.countOf('loom.verifications.list'),
      claims: window.loomQA.countOf('loom.claims.list'),
      artifacts: window.loomQA.countOf('loom.artifacts.list')
    })`)
    assert.equal(counts.activity, 1, `${label} repeated the activity read: ${JSON.stringify(counts)}`)
    assert.equal(counts.delivery, 1, `${label} repeated the delivery read: ${JSON.stringify(counts)}`)
    for (const method of ['plan', 'tasksList', 'dependencies', 'candidates', 'reviews', 'verifications']) {
      assert.equal(counts[method], 3,
        `${label} must re-read ${method} exactly once after the write (1 mount + 1 explicit section switch + 1 write refresh): ${JSON.stringify(counts)}`)
    }
    // 第七个投影：写后刷新里删掉 loom.claims.list 的请求，认领区会停在旧租约上而其他六个投影照样新鲜，
    // 所以它必须同样精确计数（挂载 1 + 切区 1 + 写后 1），不许只靠「至少读过一次」。
    assert.equal(counts.claims, 3,
      `${label} must re-read the seventh projection (loom.claims.list) exactly once after the write (1 mount + 1 explicit section switch + 1 write refresh): ${JSON.stringify(counts)}`)
    // 第八个投影：产物读只影响候选卡的证据区，但同样是「挂载 1 + 切区 1 + 写后 1」，不能靠「至少读过一次」蒙过去。
    assert.equal(counts.artifacts, 3,
      `${label} must re-read the eighth projection (loom.artifacts.list) exactly once after the write (1 mount + 1 explicit section switch + 1 write refresh): ${JSON.stringify(counts)}`)
    return counts
  }
  // 回读不能只是夹具内存变了：切到「编排」tab 看任务节点是否真的被推进，再切回「交付」看徽章。
  // 节点没有 data-task-id，用夹具里唯一的任务标题定位。
  const TARGET_TASK_TITLE = '实现恢复逻辑'
  const flowNodeState = title => script(`(() => {
    const node = [...document.querySelectorAll('.loom-plan .loom-flow-node')]
      .find(entry => (entry.querySelector('.loom-flow-node-title')?.innerText ?? '') === ${JSON.stringify(title)})
    if (!node) return null
    return {
      status: node.querySelector('.loom-flow-node-dot')?.getAttribute('data-status') ?? null,
      copy: node.querySelector('.loom-flow-node-status')?.innerText ?? null,
      className: node.className
    }
  })()`)
  const openPlanTab = async label => {
    await click('.loom-section-tabs button:nth-of-type(2)')
    await expectPressed(1, `编排 did not open to check ${label}`)
    await waitFor("document.querySelectorAll('.loom-plan .loom-flow-node').length > 0",
      `编排 flow nodes did not render to check ${label}`)
  }
  const waitFlowNode = async (title, predicate, message) => {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const state = await flowNodeState(title)
      if (state !== null && predicate(state)) return state
      await sleep(30)
    }
    throw new Error(`${message}: ${JSON.stringify(await flowNodeState(title))}`)
  }
  const backToDelivery = async label => {
    await click('.loom-section-tabs button:nth-of-type(3)')
    await expectPressed(2, `Delivery did not reopen after checking ${label}`)
    await waitFor(`!!(${cardFor(TARGET_CANDIDATE)})`, `The target candidate card is missing after checking ${label}`)
  }
  // 认领回读：编排节点里的认领块是 loom.claims.list 的唯一呈现，所以断言直接读 DOM，
  // 不读夹具内存（读内存只能证明夹具自说自话）。文案统一折成单行，换行不该影响断言。
  const claimNodes = () => script(`(() => {
    const line = value => value === null || value === undefined ? null : value.replace(/\\s+/gu, ' ').trim()
    return [...document.querySelectorAll('.loom-plan .loom-flow-node')].map(node => {
      const block = node.querySelector('.loom-flow-claim') ?? null
      const owner = block === null ? null : block.querySelector('.loom-flow-claim-owner')
      const lease = block === null ? null : block.querySelector('.loom-flow-claim-lease')
      const fence = block === null ? null : block.querySelector('.loom-flow-claim-fence')
      return {
        title: line(node.querySelector('.loom-flow-node-title')?.innerText ?? null),
        rendered: block !== null,
        state: block?.getAttribute('data-claim-state') ?? null,
        status: block === null ? null : line(block.querySelector('.loom-flow-claim-status')?.innerText ?? null),
        owner: owner === null ? null : line(owner.innerText),
        ownerRendered: owner !== null,
        leaseDatetime: lease?.getAttribute('datetime') ?? null,
        leaseCopy: lease === null ? null : line(lease.innerText),
        leaseRendered: lease !== null,
        fence: fence === null ? null : line(fence.innerText),
        fenceRendered: fence !== null
      }
    })
  })()`)

  // 认领是一次独立请求，可能比任务节点晚落地：断言等状态，不读一次就下结论。
  const waitClaims = async (predicate, message) => {
    const deadline = Date.now() + 8000
    let seen = []
    while (Date.now() < deadline) {
      seen = await claimNodes()
      if (seen.length === 4 && predicate(seen)) return seen
      await sleep(30)
    }
    throw new Error(`${message}: ${JSON.stringify(seen)}`)
  }
  const claimOf = (nodes, title) => nodes.find(node => node.title === title) ?? null
  // 切回包 → 重挂载 → 开编排：挂载时读 / 进编排时读 / 写后重读，三种生产实现都会拿到新回包。
  const switchClaims = async (scenario, options = {}) => {
    await script("(() => { const node = document.querySelector('.loom-workspace'); if (node) node.__loomReset = 'stale'; return true })()")
    await script(`window.loomQA.setClaims(${JSON.stringify(scenario)}, ${JSON.stringify(options)})`)
    await waitFor("document.querySelector('.loom-workspace') !== null && document.querySelector('.loom-workspace').__loomReset === undefined",
      `LOOM workspace did not remount to read the ${scenario} claims projection`)
  }
  const openClaimsCase = async (scenario, options, label) => {
    await resetLoom()
    await switchClaims(scenario, options)
    await openPlanTab(label)
  }
  // 产物回读只有「读成功 / 读失败」两个开关；同样先切开关再重挂载，两种实现都会拿到新回包。
  const switchArtifacts = async (options = {}) => {
    await script("(() => { const node = document.querySelector('.loom-workspace'); if (node) node.__loomReset = 'stale'; return true })()")
    await script(`window.loomQA.setArtifacts(${JSON.stringify(options)})`)
    await waitFor("document.querySelector('.loom-workspace') !== null && document.querySelector('.loom-workspace').__loomReset === undefined",
      'LOOM workspace did not remount to read the artifacts projection')
  }
  // 候选卡的逐条证据区：只读已渲染的 DOM（不读夹具内存），一条证据一行。
  const evidenceRows = hash => script(`(() => {
    const card = ${cardFor(hash)}
    if (!card) return null
    return [...card.querySelectorAll('.loom-candidate-evidence .loom-evidence-row')].map(row => ({
      state: row.querySelector('.loom-evidence-state')?.getAttribute('data-artifact-state') ?? null,
      path: row.querySelector('.loom-evidence-path')?.innerText ?? null,
      pathTitle: row.querySelector('.loom-evidence-path')?.getAttribute('title') ?? null,
      hash: row.querySelector('.loom-evidence-hash')?.innerText ?? null,
      hashTitle: row.querySelector('.loom-evidence-hash')?.getAttribute('title') ?? null,
      size: row.querySelector('.loom-evidence-size')?.innerText ?? null,
      badge: row.querySelector('.loom-evidence-state')?.innerText ?? null
    }))
  })()`)
  // 产物投影与任务节点一样可能晚落地：断言等行数，不读一次就下结论。
  const waitEvidence = async (hash, count, message) => {
    const deadline = Date.now() + 8000
    let seen = null
    while (Date.now() < deadline) {
      seen = await evidenceRows(hash)
      if (seen !== null && seen.length === count) return seen
      await sleep(30)
    }
    throw new Error(`${message}: ${JSON.stringify(seen)}`)
  }
  // 认领块会改变节点高度，但不能改变图区宽度预算：1440 下仍然不许横向溢出。
  const expectPlanWidths = async label => {
    const widths = await script(`({
      scrollWidth: document.querySelector('.loom-plan .loom-flow-graph')?.scrollWidth ?? -1,
      clientWidth: document.querySelector('.loom-plan .loom-flow-graph')?.clientWidth ?? -1
    })`)
    assert(widths.scrollWidth >= 0 && widths.scrollWidth <= widths.clientWidth + 1,
      `Plan flow graph overflowed its 1440px lane budget with ${label}: ${JSON.stringify(widths)}`)
    return widths
  }
  // owner 里的 Run 是短 ID：不预设截断方向，只要求它是真实 agentRunId 的一段。
  const expectRunToken = (owner, fullRunId, label) => {
    assert.match(owner, /^认领者：.+ · \S+$/u, `${label} claim owner lost the 名 · Run shape: ${JSON.stringify(owner)}`)
    const token = owner.slice(owner.lastIndexOf(' · ') + 3)
    assert(token.length >= 4 && fullRunId.includes(token),
      `${label} claim owner did not name the real run: ${JSON.stringify(owner)} for ${fullRunId}`)
  }
  // 逐条结论按 criterionId 绑定：只认渲染出来的「cN · 满足 / 未满足」两行。
  const criterionVerdicts = reviewText => reviewText.split('\n').map(line => line.trim())
    .filter(line => / · (未)?满足$/.test(line))
    .map(line => ({ criterionId: line.split(' · ')[0], satisfied: line.endsWith('· 满足') }))
  // 每条点击用例都从同一个初始态开始：数据回基线，工作区按基线重挂载并重读八个投影。
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
    // Existing production semantics already refresh on explicit section selection.
    // Verify the two pre-write reads, then require exactly one write read-back.
    const beforeWrite = await script(`Object.fromEntries(['loom.plan.get','loom.tasks.list','loom.dependencies.list','loom.candidates.list','loom.reviews.list','loom.verifications.list','loom.claims.list','loom.artifacts.list'].map(method => [method, window.loomQA.countOf(method)]))`)
    for (const [method, count] of Object.entries(beforeWrite)) assert.equal(count, 2,
      `Before a write, ${method} must have exactly mount + explicit section-switch reads`)

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
      for (const selector of ['.loom-delivery', '.mission-activity-document', '.loom-plan']) {
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
  assert.deepEqual(tabs, ['工作', '流程', '资产', '电脑'], `Unexpected LOOM section tabs ${JSON.stringify(tabs)}`)
  await expectPressed(0, 'LOOM workspace did not open on the activity section')
  // 活动与交付记录默认折叠：读记录内容前显式展开（展开是用户真实可达的状态）。
  await openActivityDetails('The collapsed 活动与交付记录 block did not open')
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
      statusCopies: nodes.map(node => node.querySelector('.loom-flow-node-status')?.innerText ?? null),
      stats: document.querySelector('.loom-plan .loom-flow-stats')?.innerText ?? '',
      edgeCount: document.querySelectorAll('.loom-plan .loom-flow-edge').length,
      dashedCount: document.querySelectorAll('.loom-plan .loom-flow-edge-artifact-accepted').length,
      laneCount: document.querySelectorAll('.loom-plan .loom-flow-lane').length,
      legendItems: document.querySelectorAll('.loom-plan .loom-flow-legend-item').length,
      graphScrollWidth: document.querySelector('.loom-plan .loom-flow-graph')?.scrollWidth ?? -1,
      graphClientWidth: document.querySelector('.loom-plan .loom-flow-graph')?.clientWidth ?? -1,
      controls: document.querySelectorAll('.loom-plan input, .loom-plan button, .loom-plan textarea').length,
      flowControls: document.querySelectorAll('.loom-plan .loom-flow input, .loom-plan .loom-flow button, .loom-plan .loom-flow textarea').length
    }
  })()`)
  assert.equal(plan.flow, true, `Plan section did not render the archify flow view: ${JSON.stringify(plan)}`)
  assert.equal(plan.nodeCount, 4, `Plan flow must render one node per task: ${JSON.stringify(plan.nodeCount)}`)
  assert(plan.firstTitle?.includes('设计恢复协议'), `Plan flow lost its first task title: ${JSON.stringify(plan.firstTitle)}`)
  assert(plan.blockedCopy.includes('等待恢复逻辑完成'), `Plan flow lost the real blocked reason: ${JSON.stringify(plan.blockedCopy)}`)
  assert(plan.stats.includes('总任务: 4'), `Plan flow stats no longer count the real tasks: ${JSON.stringify(plan.stats)}`)
  // 依赖就绪 = 依赖已释放且任务处于可领取状态：基线里只有 task-3 可领取（in_review 仍算可领取），
  // 阻塞只数 blocked，所以两个计数不随 ready→in_review 的修正变化。
  assert(plan.stats.includes('依赖就绪: 1'), `Plan flow stats lost the one dependency-ready task: ${JSON.stringify(plan.stats)}`)
  assert(plan.stats.includes('阻塞: 1'), `Plan flow stats lost the one blocked task: ${JSON.stringify(plan.stats)}`)
  // 节点文案必须是指挥层真实状态机：task-3 的候选已提交，所以是「评审中」而不是「就绪」。
  assert.equal(plan.statusCopies.filter(copy => copy === '评审中').length, 1,
    `Plan flow lost the in-review task after the baseline fix: ${JSON.stringify(plan.statusCopies)}`)
  assert.equal(plan.statusCopies.filter(copy => copy === '就绪').length, 0,
    `Plan flow must not show a ready task while the reviewed one is in review: ${JSON.stringify(plan.statusCopies)}`)
  assert.equal(plan.statusCopies.filter(copy => copy === '已完成').length, 2,
    `Plan flow lost the two finished tasks: ${JSON.stringify(plan.statusCopies)}`)
  assert.equal(plan.statusCopies.filter(copy => copy === '阻塞').length, 1,
    `Plan flow lost the blocked task status copy: ${JSON.stringify(plan.statusCopies)}`)
  assert.equal(plan.edgeCount, 3, `Plan flow must draw one edge per mock dependency: ${JSON.stringify(plan.edgeCount)}`)
  assert(plan.dashedCount >= 1, `Plan flow lost the dashed artifact_accepted edge: ${JSON.stringify(plan.dashedCount)}`)
  assert(plan.laneCount >= 2, `Plan flow must layer the DAG into depth lanes: ${JSON.stringify(plan.laneCount)}`)
  assert(plan.graphScrollWidth >= 0 && plan.graphScrollWidth <= plan.graphClientWidth + 1,
    `Plan flow graph overflows its 1440px lane budget: ${plan.graphScrollWidth} > ${plan.graphClientWidth}`)
  assert.equal(plan.legendItems, 3, `Plan flow must explain all three edge kinds: ${JSON.stringify(plan.legendItems)}`)
  // 控制区已是真实的写入口（批准接力范围），但依赖图本身仍只读：只数图区里的控件。
  assert.equal(plan.flowControls, 0, 'The dependency flow must stay read-only; only the relay control region may offer actions')
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
    actionLabels: [...document.querySelectorAll('.loom-delivery-actions button')].map(button => button.textContent.trim()),
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
  assert.deepEqual(review.actionLabels, ['接受', '退回', '通过核验', '核验失败'],
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
  // 两个共享面板挂在折叠区里：折叠区自己负责 16px 上间距，面板本身不许添横向或额外内衬。
  const activityPanelPadding = () => script(`(() => {
    const read = selector => {
      const style = getComputedStyle(document.querySelector(selector))
      return [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]
    }
    return {
      delivery: read('.mission-activity-document .mission-delivery-panel'),
      history: read('.mission-activity-document .mission-activity-panel')
    }
  })()`)
  const scrolled = await script(`(() => {
    const node = document.querySelector('.mission-activity-document')
    node.scrollTop = 600
    return { top: node.scrollTop }
  })()`)
  assert(scrolled.top > 100, `Activity history must be scrollable before testing restoration: ${JSON.stringify(scrolled)}`)
  const activityPaddingBefore = await activityPanelPadding()
  assert.deepEqual(
    [activityPaddingBefore.delivery[1], activityPaddingBefore.delivery[3], activityPaddingBefore.history[1], activityPaddingBefore.history[3]],
    ['0px', '0px', '0px', '0px'],
    `Activity panels gained horizontal padding: ${JSON.stringify(activityPaddingBefore)}`)
  await click('.loom-section-tabs button:nth-of-type(3)')
  await expectPressed(2, 'Delivery did not open after activity scroll')
  const deliveryScroll = await script("document.querySelector('.loom-delivery').scrollTop")
  assert.equal(deliveryScroll, 0, 'Delivery must start at its own reading position')
  await click('.loom-section-tabs button:nth-of-type(1)')
  await expectPressed(0, 'Activity did not reopen after delivery scroll test')
  await waitFor(`Math.abs(document.querySelector('.mission-activity-document').scrollTop - ${scrolled.top}) <= 1`, 'Activity scroll position was not restored after section switch')
  const activityPaddingAfter = await activityPanelPadding()
  assert.deepEqual(activityPaddingAfter, activityPaddingBefore,
    `Activity panels changed their own padding across a delivery switch: ${JSON.stringify({ before: activityPaddingBefore, after: activityPaddingAfter })}`)
  cases.push('Activity retains its scroll position and original panel spacing across delivery switches')

  stage = 'delivery scroll retention'
  // 交付页不再包含共享的交付/活动面板（它们在工作页的折叠区里），可滚长度只能来自交付自己：
  // 1040x700 时两张候选卡上下排列，正好量「交付自己拥有并恢复阅读位置」。
  await resizeTo(1040, 700, 'the delivery scroll retention check')
  await click('.loom-section-tabs button:nth-of-type(3)')
  await expectPressed(2, 'Delivery did not open for its own scroll test')
  await setCandidateDetails(true)
  const deliveryScrolled = await script(`(() => {
    const node = document.querySelector('.loom-delivery')
    const max = node.scrollHeight - node.clientHeight
    node.scrollTop = Math.min(180, max)
    return { top: node.scrollTop, max, overflow: getComputedStyle(node).overflowY, outer: document.querySelector('.loom-section-body').scrollTop }
  })()`)
  assert(deliveryScrolled.max > 100, `Delivery must own more than 100px of scrollable reading position: ${JSON.stringify(deliveryScrolled)}`)
  assert(deliveryScrolled.top > 100, `Delivery must own its scrollable reading position: ${JSON.stringify(deliveryScrolled)}`)
  assert.equal(deliveryScrolled.outer, 0, 'Outer section body must not own delivery scrolling')
  await click('.loom-section-tabs button:nth-of-type(2)')
  await expectPressed(1, 'Plan did not open from scrolled delivery')
  await click('.loom-section-tabs button:nth-of-type(3)')
  await expectPressed(2, 'Delivery did not reopen from plan')
  await waitFor(`Math.abs(document.querySelector('.loom-delivery').scrollTop - ${deliveryScrolled.top}) <= 1`, 'Delivery scroll position was not restored after visiting plan')
  await setCandidateDetails(false)
  cases.push('Delivery owns and restores its scroll position across the short plan section')

  stage = 'wide layout density'
  // 右栏几何按当前生产的 1040px 自适应框量：宽屏不铺满，窄屏由容器查询收侧距，
  // 候选卡始终单列。本段不新增 cases 条目：EXPECTED_CASES 是既有预算。
  const openDensitySection = async (index, label) => {
    await click(`.loom-section-tabs button:nth-of-type(${index + 1})`)
    await expectPressed(index, label)
    await settle(160)
  }
  // 图区：占工作区的比例 + 自身横滚量；泳道宽度用来钉住「4×160 + 3×32 = 736」这条预算。
  const flowDensity = () => script(`(() => {
    const graph = document.querySelector('.loom-plan .loom-flow-graph')
    return {
      workspace: document.querySelector('.loom-workspace')?.clientWidth ?? -1,
      clientWidth: graph?.clientWidth ?? -1,
      scrollWidth: graph?.scrollWidth ?? -1,
      lanes: [...document.querySelectorAll('.loom-plan .loom-flow-lane')]
        .map(lane => Math.round(lane.getBoundingClientRect().width))
    }
  })()`)
  // 交付：占工作区的比例、侧距、以及每张候选卡片的矩形（top 相等 = 同一行，left 不同 = 并排）。
  const deliveryDensity = () => script(`(() => {
    const pane = document.querySelector('.loom-delivery')
    const context = document.querySelector('.loom-delivery-context')
    const style = pane === null ? null : getComputedStyle(pane)
    return {
      workspace: document.querySelector('.loom-workspace')?.clientWidth ?? -1,
      pane: pane?.clientWidth ?? -1,
      context: context?.clientWidth ?? -1,
      panePaddingLeft: style?.paddingLeft ?? null,
      panePaddingRight: style?.paddingRight ?? null,
      cards: [...document.querySelectorAll('.loom-delivery-context .loom-candidate')].map(card => {
        const box = card.getBoundingClientRect()
        return { top: Math.round(box.top), left: Math.round(box.left), width: Math.round(box.width) }
      }),
      pageScrollWidth: document.documentElement.scrollWidth,
      pageClientWidth: document.documentElement.clientWidth
    }
  })()`)

  // 当前生产的右栏几何：.loom-plan / .loom-delivery 都是 max-width:1040px 的自适应框
  // （loom-workspace.css:12），候选卡始终单列，390 下由容器查询把侧距收成 18px。
  // 这里量的就是这条真实几何，不再假设「宽屏两列等宽同排」。
  const paneFrame = selector => script(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node) return null
    const style = getComputedStyle(node)
    return {
      width: Math.round(node.getBoundingClientRect().width),
      clientWidth: node.clientWidth,
      maxWidth: style.maxWidth,
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      pageScrollWidth: document.documentElement.scrollWidth,
      pageClientWidth: document.documentElement.clientWidth
    }
  })()`)

  // 1440：右栏仍是 1040 框，编排图在自己的框里不溢出。
  await resizeTo(1440, 920, 'the 1440px density check')
  await openDensitySection(1, '编排 did not open for the 1440px density check')
  await waitFor("document.querySelectorAll('.loom-plan .loom-flow-lane').length >= 2",
    '编排 flow lanes did not render for the 1440px density check')
  const widePlanFrame = await paneFrame('.loom-plan')
  const widePlan = await flowDensity()
  assert(widePlan.workspace >= 1200,
    `The 1440px LOOM workspace must be at least 1200 wide before the wide layout check: ${JSON.stringify(widePlan)}`)
  assert.equal(widePlanFrame.maxWidth, '1040px',
    `The 编排 pane lost its 1040px frame: ${JSON.stringify(widePlanFrame)}`)
  assert.equal(widePlanFrame.width, 1040,
    `The 编排 pane must use the full 1040px frame at 1440: ${JSON.stringify(widePlanFrame)}`)
  assert(widePlan.scrollWidth <= widePlan.clientWidth + 1,
    `The 编排 flow graph must not overflow its own pane at 1440: ${JSON.stringify(widePlan)}`)
  assert.equal(widePlan.lanes.length, 4,
    `编排 must still layer the four-task DAG into four lanes: ${JSON.stringify(widePlan.lanes)}`)
  assert(widePlan.lanes.every(width => width >= 160),
    `编排 lanes must keep their 160px floor: ${JSON.stringify(widePlan.lanes)}`)
  assert(4 * 160 + 3 * 32 <= widePlan.clientWidth,
    `The lane width budget (4×160 + 3×32 = 736) must fit the real graph viewport: ${JSON.stringify(widePlan)}`)

  await openDensitySection(2, '交付 did not open for the 1440px density check')
  await waitFor("document.querySelectorAll('.loom-delivery-context .loom-candidate').length === 2",
    'Delivery section did not list both candidates for the 1440px density check')
  await script("(() => { const pane = document.querySelector('.loom-delivery'); if (pane) pane.scrollTop = 0; return true })()")
  await settle(120)
  const wideFrame = await paneFrame('.loom-delivery')
  const wideDelivery = await deliveryDensity()
  assert.equal(wideFrame.maxWidth, '1040px',
    `The 交付 pane lost its 1040px frame: ${JSON.stringify(wideFrame)}`)
  assert.equal(wideFrame.width, 1040,
    `The 交付 pane must use the full 1040px frame at 1440: ${JSON.stringify(wideFrame)}`)
  assert.equal(wideDelivery.context, wideFrame.clientWidth - 48,
    `The delivery list must fill the frame client area minus 24px side padding, excluding the native scrollbar: ${JSON.stringify({ frame: wideFrame, delivery: wideDelivery })}`)
  assert.equal(wideDelivery.cards.length, 2,
    `交付 must still list both recorded candidates at 1440: ${JSON.stringify(wideDelivery.cards)}`)
  assert.equal(wideDelivery.cards[0].left, wideDelivery.cards[1].left,
    `The 交付 cards must stack one per row inside the inspector pane: ${JSON.stringify(wideDelivery.cards)}`)
  assert.notEqual(wideDelivery.cards[0].top, wideDelivery.cards[1].top,
    `The two 交付 candidate cards must not share one row: ${JSON.stringify(wideDelivery.cards)}`)
  assert(wideFrame.pageScrollWidth <= wideFrame.pageClientWidth + 1,
    `The 1440px page itself must not scroll horizontally: ${JSON.stringify(wideFrame)}`)

  // 1040：框宽与单列保持不变，页宽刚好等于框宽。
  await resizeTo(1040, 700, 'the 1040px density check')
  const mediumFrame = await paneFrame('.loom-delivery')
  const mediumDelivery = await deliveryDensity()
  assert.equal(mediumFrame.width, mediumDelivery.workspace,
    `The 交付 pane must exactly fill a 1040px workspace: ${JSON.stringify({ frame: mediumFrame, pane: mediumDelivery.workspace })}`)
  assert(mediumDelivery.context <= 992,
    `The 交付 list must stay inside the 1040px frame minus gutters at 1040: ${JSON.stringify(mediumDelivery)}`)
  assert.equal(mediumDelivery.cards[0].left, mediumDelivery.cards[1].left,
    `交付 must stay one column at 1040 (shared left): ${JSON.stringify(mediumDelivery.cards)}`)
  assert.notEqual(mediumDelivery.cards[0].top, mediumDelivery.cards[1].top,
    `交付 must stay one column at 1040 (different top): ${JSON.stringify(mediumDelivery.cards)}`)

  // 390：容器查询把侧距收成 18px、单列、页面本身不横向溢出；编排仍只在自己的图区内横滚。
  await resizeTo(390, 844, 'the 390px density check')
  const mobileFrame = await paneFrame('.loom-delivery')
  const mobileDelivery = await deliveryDensity()
  assert.equal(mobileFrame.paddingLeft, '18px',
    `The 交付 pane must take the narrow container padding at 390: ${JSON.stringify(mobileFrame)}`)
  assert.equal(mobileFrame.paddingRight, '18px',
    `The 交付 pane must take the narrow container padding at 390: ${JSON.stringify(mobileFrame)}`)
  assert.equal(mobileDelivery.cards[0].left, mobileDelivery.cards[1].left,
    `交付 must stay one column at 390 (shared left): ${JSON.stringify(mobileDelivery.cards)}`)
  assert.notEqual(mobileDelivery.cards[0].top, mobileDelivery.cards[1].top,
    `交付 must stay one column at 390 (different top): ${JSON.stringify(mobileDelivery.cards)}`)
  assert(mobileFrame.pageScrollWidth <= mobileFrame.pageClientWidth + 1,
    `The 390px page itself must not scroll horizontally: ${JSON.stringify(mobileFrame)}`)
  await openDensitySection(1, '编排 did not open for the 390px density check')
  await waitFor("document.querySelectorAll('.loom-plan .loom-flow-lane').length >= 2",
    '编排 flow lanes did not render for the 390px density check')
  const mobilePlan = await flowDensity()
  assert(mobilePlan.workspace <= 390,
    `The 390px LOOM workspace must stay at the mobile width: ${JSON.stringify(mobilePlan)}`)
  assert(mobilePlan.scrollWidth > mobilePlan.clientWidth + 1,
    `编排 must still scroll the flow graph horizontally inside its own pane at 390: ${JSON.stringify(mobilePlan)}`)

  stage = 'screenshots'
  // 截图拍生产默认态：活动与交付记录是折叠的；展开只用于断言里面的内容。
  await setActivityDetails(false)
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
  assert.deepEqual(acceptStart.actionRow, ['接受', '退回', '通过核验', '核验失败'],
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
  // 回执里的身份是 Core 注入的，绝不回显客户端：CURRENT_USER_ID = local_user。
  assert.equal(reviewWrite.receipt.review.reviewerId, 'local_user',
    `The review receipt must carry the Core-owned current user identity: ${JSON.stringify(reviewWrite.receipt.review)}`)
  assert.equal(acceptTask.status, 'done', 'The read-back task status must follow the acceptance receipt')
  assert.equal(acceptState.candidates.find(candidate => candidate.candidateId === 'candidate-2').acceptanceStatus, 'accepted',
    'The read-back candidate must carry the accepted verdict')
  assert.equal(acceptState.reviews.filter(review => review.candidateId === 'candidate-2').length, 1, 'The review write must add exactly one row')
  await expectWriteReadback('Accept')
  // 回读得是 UI 真的换了：编排 tab 的任务节点已经随接受推到完成。
  await openPlanTab('the accepted review')
  const acceptedNode = await waitFlowNode(TARGET_TASK_TITLE, state => state.status === 'done',
    '编排 never showed the accepted task as done')
  assert.equal(acceptedNode.status, 'done',
    `An accepted review must show the task node data-status done: ${JSON.stringify(acceptedNode)}`)
  assert.equal(acceptedNode.copy, '已完成',
    `An accepted review must show the done status copy: ${JSON.stringify(acceptedNode)}`)
  assert.equal(acceptedNode.className.split(' ').includes('done'), true,
    `The accepted task node must carry the done status class: ${JSON.stringify(acceptedNode)}`)
  await backToDelivery('the accepted review')
  const acceptedStill = await cardState(TARGET_CANDIDATE)
  assert.equal(acceptedStill.acceptanceState, 'accepted',
    `The acceptance badge fell back to stale data after the section round trip: ${JSON.stringify(acceptedStill)}`)
  assert.equal(acceptedStill.acceptanceCopy, '已验收',
    `The acceptance badge copy fell back to stale data after the section round trip: ${JSON.stringify(acceptedStill)}`)
  cases.push('接受 stays blocked until every criterion is checked and the reason is non-blank, writes exactly one loom.review.record, reads accepted back and leaves the verification axis untouched')

  stage = 'delivery rejection chain'
  await resetLoom()
  await openDelivery()
  const rejectStart = await cardState(TARGET_CANDIDATE)
  assert.equal(rejectStart.acceptanceState, 'pending', `Reset did not restore the pending acceptance axis: ${JSON.stringify(rejectStart.acceptanceState)}`)
  assert.deepEqual(rejectStart.actionRow, ['接受', '退回', '通过核验', '核验失败'],
    `Reset did not restore both action axes: ${JSON.stringify(rejectStart.actionRow)}`)

  await clickElement(inCard(TARGET_CANDIDATE, '.loom-btn-reject'))
  const rejectOpened = await waitCard(TARGET_CANDIDATE, state => state.forms === 1, 'Reject did not open the review form')
  assert.deepEqual(rejectOpened.submit, { label: '确认退回', disabled: true },
    `Reject started submittable without a reason: ${JSON.stringify(rejectOpened.submit)}`)
  await clickElement(submitFor(TARGET_CANDIDATE))
  await settle(160)
  assert.equal(await script("window.loomQA.countOf('loom.review.record')"), 0, 'A reject without a reason still sent loom.review.record')

  const rejectReason = '  证据不足，证据链条缺一份恢复日志  '
  assert.equal(await fillReason(TARGET_CANDIDATE, rejectReason), rejectReason, 'The reject reason textarea did not take the typed reason')
  await settle(120)
  const rejectReady = await cardState(TARGET_CANDIDATE)
  assert.deepEqual(rejectReady.checkboxes, [false, false], `Reject must not demand criterion checks: ${JSON.stringify(rejectReady.checkboxes)}`)
  assert.deepEqual(rejectReady.submit, { label: '确认退回', disabled: false },
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
  assert(rejectedLines.some(line => line.includes('验收结论：退回')), `The rejected verdict line is missing: ${JSON.stringify(rejected.review)}`)
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
  assert.equal(rejectWrite.receipt.review.reviewerId, 'local_user',
    `The rejection receipt must carry the Core-owned current user identity: ${JSON.stringify(rejectWrite.receipt.review)}`)
  assert.equal(rejectState.tasks.find(task => task.taskId === 'task-3').status, 'ready', 'The read-back task status must follow the rejection receipt')
  assert.equal(rejectState.candidates.find(candidate => candidate.candidateId === 'candidate-2').acceptanceStatus, 'rejected',
    'The read-back candidate must carry the rejected verdict')
  assert.equal(rejectState.reviews.filter(review => review.candidateId === 'candidate-2').length, 1, 'The rejection write must add exactly one row')
  await expectWriteReadback('Reject')
  // 退回把任务送回 READY：编排 tab 的节点必须回到可执行（就绪），不是停在评审中。
  await openPlanTab('the rejected review')
  const rejectedNode = await waitFlowNode(TARGET_TASK_TITLE, state => state.status === 'ready',
    '编排 never showed the rejected task back in ready')
  assert.equal(rejectedNode.status, 'ready',
    `A rejected review must show the task node data-status ready: ${JSON.stringify(rejectedNode)}`)
  assert.equal(rejectedNode.copy, '就绪',
    `A rejected review must show the ready status copy: ${JSON.stringify(rejectedNode)}`)
  assert.equal(rejectedNode.className.split(' ').includes('ready'), true,
    `The rejected task node must be claimable again (ready): ${JSON.stringify(rejectedNode)}`)
  assert.equal(rejectedNode.className.split(' ').includes('in_review'), false,
    `The rejected task node must leave in_review: ${JSON.stringify(rejectedNode)}`)
  assert.equal(rejectedNode.className.split(' ').includes('done'), false,
    `A rejection must not leave the task node in done: ${JSON.stringify(rejectedNode)}`)
  await backToDelivery('the rejected review')
  const rejectedStill = await cardState(TARGET_CANDIDATE)
  assert.equal(rejectedStill.acceptanceState, 'rejected',
    `The rejection badge fell back to stale data after the section round trip: ${JSON.stringify(rejectedStill)}`)
  assert.equal(rejectedStill.acceptanceCopy, '已驳回',
    `The rejection badge copy fell back to stale data after the section round trip: ${JSON.stringify(rejectedStill)}`)
  cases.push('退回 requires a reason but no criterion checks, writes exactly one loom.review.record, reads rejected back and leaves the verification axis untouched')

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
  assert.deepEqual(verified.actionRow, ['接受', '退回'],
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
  assert.equal(verifiedWrite.receipt.verification.executorId, 'local_user',
    `The verification receipt must carry the Core-owned current user identity: ${JSON.stringify(verifiedWrite.receipt.verification)}`)
  assert.equal(verifiedState.candidates.find(candidate => candidate.candidateId === 'candidate-2').verificationStatus, 'verified',
    'The read-back candidate must carry the verified status')
  assert.equal(verifiedState.candidates.find(candidate => candidate.candidateId === 'candidate-2').acceptanceStatus, 'pending',
    'Verifying must leave the acceptance axis pending')
  assert.equal(verifiedState.verifications.filter(verification => verification.candidateId === 'candidate-2').length, 1, 'The verification write must add exactly one row')
  await expectWriteReadback('Verify')
  // 核验只动核验轴：编排 tab 的任务仍然停在 in_review，徽章在切回来之后仍是新状态。
  await openPlanTab('the passed verification')
  const verifiedNode = await waitFlowNode(TARGET_TASK_TITLE, state => state.status === 'in_review',
    '编排 never showed the verified task still in review')
  assert.equal(verifiedNode.copy, '评审中',
    `A verification must not move the task status copy: ${JSON.stringify(verifiedNode)}`)
  await backToDelivery('the passed verification')
  const verifiedStill = await cardState(TARGET_CANDIDATE)
  assert.equal(verifiedStill.verificationState, 'verified',
    `The verification badge fell back to stale data after the section round trip: ${JSON.stringify(verifiedStill)}`)
  assert.equal(verifiedStill.verificationCopy, '已核验',
    `The verification badge copy fell back to stale data after the section round trip: ${JSON.stringify(verifiedStill)}`)
  assert.equal(verifiedStill.acceptanceState, 'pending',
    `The acceptance axis must stay pending after the section round trip: ${JSON.stringify(verifiedStill)}`)
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
  assert.deepEqual(failed.actionRow, ['接受', '退回'],
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
  assert.equal(failedWrite.receipt.verification.executorId, 'local_user',
    `The failed verification receipt must carry the Core-owned current user identity: ${JSON.stringify(failedWrite.receipt.verification)}`)
  assert.equal(failedState.candidates.find(candidate => candidate.candidateId === 'candidate-2').verificationStatus, 'failed',
    'The read-back candidate must carry the failed status')
  assert.equal(failedState.verifications.filter(verification => verification.candidateId === 'candidate-2').length, 1, 'The failed verification write must add exactly one row')
  await expectWriteReadback('Failed verification')
  await openPlanTab('the failed verification')
  const failedNode = await waitFlowNode(TARGET_TASK_TITLE, state => state.status === 'in_review',
    '编排 never showed the failed verification task still in review')
  assert.equal(failedNode.copy, '评审中',
    `A failed verification must not move the task status copy: ${JSON.stringify(failedNode)}`)
  await backToDelivery('the failed verification')
  const failedStill = await cardState(TARGET_CANDIDATE)
  assert.equal(failedStill.verificationState, 'failed',
    `The failed badge fell back to stale data after the section round trip: ${JSON.stringify(failedStill)}`)
  assert.equal(failedStill.verificationCopy, '核验失败',
    `The failed badge copy fell back to stale data after the section round trip: ${JSON.stringify(failedStill)}`)
  assert.equal(failedStill.acceptanceState, 'pending',
    `A failed verification must leave the acceptance axis pending after the round trip: ${JSON.stringify(failedStill)}`)
  cases.push('核验失败 writes exactly one loom.verification.record from its own initial state, reads the failed badge back and keeps the acceptance axis pending with its buttons')

  assert.deepEqual(await script('window.loomQA.errors'), [], 'The delivery write cases requested a method the fixture did not answer')

  stage = 'claim projection: empty list'
  await openClaimsCase('empty', {}, 'the empty claims projection')
  const emptyClaims = await waitClaims(nodes => nodes.every(node => node.state === 'none'),
    'An empty loom.claims.list did not fall back to unclaimed nodes')
  assert.equal(emptyClaims.every(node => node.rendered), true,
    `Every flow node must render its claim block even when nothing is claimed: ${JSON.stringify(emptyClaims)}`)
  assert.equal(emptyClaims.filter(node => node.status === '未认领').length, 4,
    `An empty loom.claims.list must show 未认领 on all four nodes: ${JSON.stringify(emptyClaims.map(node => node.status))}`)
  assert.deepEqual(emptyClaims.filter(node => node.ownerRendered || node.leaseRendered || node.fenceRendered).map(node => node.title), [],
    `An unclaimed node rendered an owner, lease or fence line: ${JSON.stringify(emptyClaims)}`)
  assert.ok(await script("window.loomQA.countOf('loom.claims.list')") >= 1, '编排 never asked for the claims projection')
  await expectPlanWidths('an empty claim list')
  cases.push('编排 renders 未认领 on every node from an empty loom.claims.list with no owner, lease or fence line, and the flow graph still fits 1440 without horizontal overflow')

  stage = 'claim projection: held lease'
  await openClaimsCase('held', {}, 'the held claim')
  const heldClaims = await waitClaims(nodes => claimOf(nodes, '实现快照保存')?.state === 'held',
    'A held claim never reached its flow node')
  const heldNode = claimOf(heldClaims, '实现快照保存')
  assert.equal(heldNode.status, '已认领', `A held lease must read 已认领: ${JSON.stringify(heldNode)}`)
  assert(heldNode.owner.includes('认领者：') && heldNode.owner.includes('临舟'),
    `A held lease must name its claimant agent: ${JSON.stringify(heldNode.owner)}`)
  expectRunToken(heldNode.owner, 'run-8f3a2c11', 'Held')
  assert.equal(heldNode.fence, 'fence 第1代', `A held lease must show its fence generation: ${JSON.stringify(heldNode.fence)}`)
  assert.equal(heldNode.leaseDatetime, '2026-09-27T10:05:00.000Z',
    `The lease line must carry the real leaseExpiresAt in datetime: ${JSON.stringify(heldNode.leaseDatetime)}`)
  assert(heldNode.leaseCopy.startsWith('到期：') && heldNode.leaseCopy.replace('到期：', '').trim() !== '',
    `The lease line lost its human readable expiry: ${JSON.stringify(heldNode.leaseCopy)}`)
  assert.deepEqual(heldClaims.filter(node => node.state === 'none').map(node => node.title).sort(),
    ['实现恢复逻辑', '验收测试', '设计恢复协议'].sort(),
    `Only the claimed task may leave 未认领: ${JSON.stringify(heldClaims.map(node => [node.title, node.state]))}`)
  await expectPlanWidths('a held lease')
  cases.push('一个 held 租约在编排节点里显示已认领、认领者姓名与 Run 短 ID、到期时刻（datetime 即 leaseExpiresAt）以及 fence 代数，其余节点仍为未认领')

  stage = 'claim projection: multiple fence generations'
  await openClaimsCase('multiGeneration', {}, 'the multi-generation claim')
  const multiClaims = await waitClaims(nodes => claimOf(nodes, '实现恢复逻辑')?.state === 'held',
    'The higher fence generation of a multi-generation task never reached its node')
  const multiNode = claimOf(multiClaims, '实现恢复逻辑')
  assert.equal(multiNode.fence, 'fence 第2代',
    `The highest fence generation must win over the released one: ${JSON.stringify(multiNode)}`)
  assert.equal(multiNode.status, '已认领', `The fence 2 claim must read 已认领, not 已释放: ${JSON.stringify(multiNode.status)}`)
  assert(multiNode.owner.includes('临舟'), `The shown owner must be the fence 2 claimant: ${JSON.stringify(multiNode.owner)}`)
  expectRunToken(multiNode.owner, 'run-9c8d7e66', 'Multi-generation')
  assert.equal(multiClaims.some(node => node.state === 'released' || node.status === '已释放'), false,
    `The released fence 1 leaked into the node view: ${JSON.stringify(multiClaims)}`)
  assert.equal(multiClaims.filter(node => node.state === 'held').length, 1,
    `A multi-generation task must occupy exactly one node: ${JSON.stringify(multiClaims.map(node => [node.title, node.state]))}`)
  await expectPlanWidths('multiple fence generations')
  cases.push('同一任务多代认领只显示最大 fenceGeneration 的那一代：fence 1 的已释放不得盖住 fence 2 的已认领')

  stage = 'claim projection: expired lease'
  await openClaimsCase('expired', {}, 'the expired lease')
  const expiredClaims = await waitClaims(nodes => claimOf(nodes, '验收测试')?.state === 'expired',
    'An expired lease never reached its flow node')
  const expiredNode = claimOf(expiredClaims, '验收测试')
  assert.equal(expiredNode.status, '租约已过期',
    `expired=true 且未释放必须读成租约已过期: ${JSON.stringify(expiredNode)}`)
  assert(expiredNode.owner.includes('亚纪'), `An expired lease still has an owner: ${JSON.stringify(expiredNode.owner)}`)
  expectRunToken(expiredNode.owner, 'run-4a4a4a44', 'Expired')
  assert.equal(expiredNode.leaseDatetime, '2026-09-27T09:55:00.000Z',
    `An expired lease must show the very leaseExpiresAt it was judged on: ${JSON.stringify(expiredNode.leaseDatetime)}`)
  assert.equal(expiredNode.fence, 'fence 第1代', `An expired lease keeps its fence: ${JSON.stringify(expiredNode.fence)}`)
  await expectPlanWidths('an expired lease')
  cases.push('expired=true 且 releasedAt 为空时节点读成租约已过期，且仍展示认领者、Run 短 ID、到期时刻与 fence 代数')

  stage = 'claim projection: released beats expired'
  await openClaimsCase('released', {}, 'the released claim')
  const releasedClaims = await waitClaims(nodes => claimOf(nodes, '设计恢复协议')?.state === 'released',
    'A released claim never reached its flow node')
  const releasedNode = claimOf(releasedClaims, '设计恢复协议')
  assert.equal(releasedNode.status, '已释放',
    `releasedAt 非空时即使 expired 为 true 也必须读成已释放: ${JSON.stringify(releasedNode)}`)
  assert.notEqual(releasedNode.status, '租约已过期',
    `Release is a conclusion and must outrank expiry: ${JSON.stringify(releasedNode.status)}`)
  assert.equal(releasedClaims.some(node => node.state === 'expired' || node.status === '租约已过期'), false,
    `A released claim must not be reported as expired anywhere: ${JSON.stringify(releasedClaims.map(node => [node.title, node.state]))}`)
  expectRunToken(releasedNode.owner, 'run-2b2b2b22', 'Released')
  await expectPlanWidths('a released claim')
  cases.push('releasedAt 非空的认领即使 expired 也为 true，也必须显示已释放而不是租约已过期')

  stage = 'claim projection: claimant fallback'
  await openClaimsCase('anonymous', {}, 'the claim without a claimant agent')
  const anonymousClaims = await waitClaims(nodes => claimOf(nodes, '实现快照保存')?.state === 'held',
    'A claim without a claimant agent never reached its node')
  const anonymousNode = claimOf(anonymousClaims, '实现快照保存')
  assert.equal(anonymousNode.status, '已认领', `A run-only claim is still held: ${JSON.stringify(anonymousNode)}`)
  assert.match(anonymousNode.owner, /^认领者：/u, `The owner line lost its 认领者 prefix: ${JSON.stringify(anonymousNode.owner)}`)
  // 右侧本来就完整显示 Run ID，所以「整条含 run-7f7f7f7f」证明不了回退：名字必须精确落在 · 左侧。
  assert.equal(anonymousNode.owner.split(' · ')[0], '认领者：run-7f7f7f7f',
    `claimantAgentId 为空时 · 左侧（含前缀）必须回退成 agentRunId 原值，而不是别的名字: ${JSON.stringify(anonymousNode.owner)}`)
  expectRunToken(anonymousNode.owner, 'run-7f7f7f7f', 'Run-only claim')
  assert.equal(anonymousNode.owner.includes('null'), false,
    `An empty claimantAgentId must not leak a literal null: ${JSON.stringify(anonymousNode.owner)}`)
  assert.equal(anonymousNode.owner.includes('undefined'), false,
    `An empty claimantAgentId must not leak undefined: ${JSON.stringify(anonymousNode.owner)}`)
  assert.equal(anonymousNode.fence, 'fence 第1代',
    `A run-only claim must still show its fence: ${JSON.stringify(anonymousNode.fence)}`)
  await expectPlanWidths('a claim without a claimant agent')
  cases.push('claimantAgentId 为 null 的认领把 owner 文案回退成 agentRunId 原值，不渲染 null / undefined，也不丢 fence 与到期')

  stage = 'claim projection: read failure'
  await openClaimsCase('held', { fail: true }, 'the failing claims read')
  await waitFor("(document.querySelector('.loom-plan')?.innerText ?? '').includes('认领状态未知')",
    'A failing loom.claims.list did not surface 认领状态未知 in the 编排 section')
  // 未知态必须落在四个节点上，且不许冒充任何一种已知态——data-claim-state 一个都不能有
  // （含 none：「读不到」和「没人认领」是两件事）。
  const unknownClaims = await waitClaims(
    nodes => nodes.every(node => node.rendered && node.state === null && node.status === '认领状态未知'),
    'A failing loom.claims.list did not put all four flow nodes into 认领状态未知')
  assert.equal(unknownClaims.length, 4,
    `A failed claims read must keep all four flow nodes: ${JSON.stringify(unknownClaims.map(node => node.title))}`)
  assert.deepEqual(unknownClaims.filter(node => !node.rendered).map(node => node.title), [],
    `every flow node must still render .loom-flow-claim when the claims read fails: ${JSON.stringify(unknownClaims)}`)
  assert.deepEqual(unknownClaims.filter(node => node.state !== null).map(node => [node.title, node.state]), [],
    `A failed claims read still stamped a data-claim-state on a node: ${JSON.stringify(unknownClaims.map(node => [node.title, node.state]))}`)
  assert.deepEqual(unknownClaims.map(node => node.status), ['认领状态未知', '认领状态未知', '认领状态未知', '认领状态未知'],
    `all four nodes must read 认领状态未知, not just one of them: ${JSON.stringify(unknownClaims.map(node => node.status))}`)
  assert.deepEqual(unknownClaims.filter(node => node.ownerRendered || node.leaseRendered || node.fenceRendered).map(node => node.title), [],
    `A failed claims read still rendered owner, lease or fence copy: ${JSON.stringify(unknownClaims)}`)
  const failedPlan = await script(`({
    nodeCount: document.querySelectorAll('.loom-plan .loom-flow-node').length,
    stats: document.querySelector('.loom-plan .loom-flow-stats')?.innerText ?? '',
    edges: document.querySelectorAll('.loom-plan .loom-flow-edge').length
  })`)
  assert.equal(failedPlan.nodeCount, 4,
    `A failed claims read must not take the task nodes down with it: ${JSON.stringify(failedPlan)}`)
  assert(failedPlan.stats.includes('依赖就绪: 1') && failedPlan.stats.includes('总任务: 4'),
    `A failed claims read must not blank the flow stats: ${JSON.stringify(failedPlan.stats)}`)
  assert.equal(failedPlan.edges, 3, `A failed claims read must keep the dependency edges: ${JSON.stringify(failedPlan.edges)}`)
  await expectPlanWidths('a failing claims read')
  await backToDelivery('the failing claims read')
  const deliveryAfterClaimsFailure = await cardState(TARGET_CANDIDATE)
  assert.equal(deliveryAfterClaimsFailure.acceptanceState, 'pending',
    `A failed claims read must leave the delivery section intact: ${JSON.stringify(deliveryAfterClaimsFailure)}`)
  assert.deepEqual(await script('window.loomQA.errors'), [],
    'A forced claims read failure was misreported as an unanswered fixture method')
  cases.push('loom.claims.list 读失败时编排显示认领状态未知、不猜任何一个租约状态，且任务节点、统计、连线与交付面板仍正常')

  stage = 'candidate card: registered artifact'
  await resetLoom()
  await openDelivery()
  // 已登记与未登记同屏：candidate-1 的 evidence-1 对得上产物，evidence-2 对不上。
  const reviewedEvidence = await waitEvidence('sha256:restore-protocol', 2,
    'The reviewed candidate did not render one evidence row per evidenceId')
  const registeredRow = reviewedEvidence[0]
  assert.equal(registeredRow.state, 'registered',
    `A registered artifact must be marked data-artifact-state=registered: ${JSON.stringify(registeredRow)}`)
  assert.equal(registeredRow.path, 'artifacts/restore-protocol.md',
    `The registered artifact lost its relative path: ${JSON.stringify(registeredRow)}`)
  assert.equal(registeredRow.pathTitle, 'artifacts/restore-protocol.md',
    `The registered artifact path must stay complete in title: ${JSON.stringify(registeredRow.pathTitle)}`)
  assert.match(registeredRow.hash, /^[0-9a-f]{12}$/u,
    `The artifact hash must be the first 12 hex characters of sha256: ${JSON.stringify(registeredRow.hash)}`)
  assert.equal(registeredRow.hash, 'a1b2c3d4a1b2',
    `The short hash does not match the fixture sha256 prefix: ${JSON.stringify(registeredRow.hash)}`)
  assert.equal(registeredRow.hashTitle, 'a1b2c3d4'.repeat(8),
    `The short hash must carry the full sha256 in title: ${JSON.stringify(registeredRow.hashTitle)}`)
  assert.equal(registeredRow.size, '512 B',
    `Byte sizes must print without a decimal: ${JSON.stringify(registeredRow.size)}`)
  assert.equal(registeredRow.badge, '已登记',
    `A registered artifact may only read 已登记, never 已核验: ${JSON.stringify(registeredRow.badge)}`)
  assert.deepEqual(reviewedEvidence.filter(row => row.badge === '已核验' || row.badge === '已验证').map(row => row.badge), [],
    `The artifact badge must not claim verification: ${JSON.stringify(reviewedEvidence.map(row => row.badge))}`)
  // 只列候选自己引用的产物：未被引用的那一条（evidence-9）不得被当成“凑数”显示出来。
  const deliveryCopy = await script("document.querySelector('.loom-delivery-context')?.innerText ?? ''")
  assert.equal(deliveryCopy.includes('restore-trace-with-a-deliberately-long-file-name.log'), false,
    'The evidence block listed a registered artifact no candidate evidenceId refers to')
  cases.push('候选卡逐条渲染已登记产物的相对路径、12 位短 hash（title 保留全长）、人类可读大小与「已登记」徽章，只列被引用的产物且不冒充已核验')

  stage = 'candidate card: unregistered evidence id'
  const unmatchedRow = reviewedEvidence[1]
  assert.equal(unmatchedRow.state, 'unregistered',
    `An evidence id with no registered artifact must be marked unregistered: ${JSON.stringify(unmatchedRow)}`)
  assert.equal(unmatchedRow.path, 'evidence-2',
    `An unregistered evidence row must show the raw evidenceId: ${JSON.stringify(unmatchedRow.path)}`)
  assert.equal(unmatchedRow.hash, null, `An unregistered evidence row must not invent a hash: ${JSON.stringify(unmatchedRow.hash)}`)
  assert.equal(unmatchedRow.size, null, `An unregistered evidence row must not invent a size: ${JSON.stringify(unmatchedRow.size)}`)
  assert.equal(unmatchedRow.badge, '未登记',
    `An unmatched evidence id must read 未登记: ${JSON.stringify(unmatchedRow.badge)}`)
  const targetEvidence = await waitEvidence(TARGET_CANDIDATE, 1,
    'The target candidate did not render its own evidence row')
  assert.equal(targetEvidence[0].state, 'unregistered',
    `The target candidate's evidence id has no artifact and must read unregistered: ${JSON.stringify(targetEvidence[0])}`)
  assert.equal(targetEvidence[0].path, 'evidence-3',
    `The target candidate must show the raw evidenceId, not another candidate's path: ${JSON.stringify(targetEvidence[0].path)}`)
  assert.equal(targetEvidence[0].badge, '未登记',
    `The target candidate's unmatched evidence id must read 未登记: ${JSON.stringify(targetEvidence[0].badge)}`)
  cases.push('对不上任何已登记产物的 evidenceId 显示 evidenceId 原文与「未登记」徽章，不借用其他候选的路径、hash 或大小')

  stage = 'artifact preview dialog'
  // 正文预览现在在浮层里读：点行打开夹具返回的真实快照文本，Esc 关闭、焦点回到触发行，全程不发写。
  const previewRow = inCard('sha256:restore-protocol', '.loom-preview-row')
  // inCard 的表达式自带 `?? null` 尾巴，必须再加一层括号再串 ?. / 否则焦点会落到 null 上。
  await script(`(${previewRow})?.focus()`)
  await settle(120)
  await clickElement(previewRow)
  await waitFor("!!document.querySelector('.loom-artifact-dialog')",
    'Clicking an evidence row did not open the artifact preview overlay')
  const previewDialog = await script(`(() => {
    const dialog = document.querySelector('.loom-artifact-dialog')
    return {
      role: dialog?.getAttribute('role') ?? null,
      title: dialog?.querySelector('.loom-artifact-title')?.innerText ?? '',
      state: dialog?.querySelector('.loom-preview-body')?.getAttribute('data-preview-state') ?? null,
      copy: dialog?.querySelector('.loom-artifact-doc')?.innerText ?? '',
      haspopup: (${previewRow})?.getAttribute('aria-haspopup') ?? null,
      forms: document.querySelectorAll('.loom-artifact-dialog .loom-review-form').length
    }
  })()`)
  assert.equal(previewDialog.role, 'dialog',
    `The preview overlay is not a modal dialog: ${JSON.stringify(previewDialog.role)}`)
  assert.equal(previewDialog.title, 'restore-protocol.md',
    `The overlay title is not the real file name: ${JSON.stringify(previewDialog.title)}`)
  assert.equal(previewDialog.state, 'ready',
    `The overlay did not show the ready preview state: ${JSON.stringify(previewDialog.state)}`)
  assert(previewDialog.copy.includes('LOOM-PREVIEW-READY'),
    `The overlay did not render the archived text the fixture returned: ${JSON.stringify(previewDialog.copy)}`)
  assert.equal(previewDialog.haspopup, 'dialog',
    `The evidence row does not announce a dialog: ${JSON.stringify(previewDialog.haspopup)}`)
  assert.equal(previewDialog.forms, 0, 'Opening the preview opened an acceptance form by itself')
  await pressKey('Escape')
  await waitFor("!document.querySelector('.loom-artifact-dialog')", 'Escape did not close the artifact preview overlay')
  const previewClosed = await script(`({
    dialog: !!document.querySelector('.loom-artifact-dialog'),
    focusInCard: ${cardFor('sha256:restore-protocol')}?.contains(document.activeElement) ?? false,
    records: window.loomQA.countOf('loom.review.record') + window.loomQA.countOf('loom.verification.record'),
    errors: window.loomQA.errors.slice()
  })`)
  assert.equal(previewClosed.dialog, false, 'The preview overlay survived Escape')
  assert.equal(previewClosed.focusInCard, true,
    `Closing the overlay did not return focus to the invoking card: ${JSON.stringify(previewClosed)}`)
  assert.equal(previewClosed.records, 0, 'Opening and closing a preview must not record acceptance or verification')
  assert.deepEqual(previewClosed.errors, [], `The preview overlay asked for an unanswered method: ${JSON.stringify(previewClosed.errors)}`)
  cases.push('产物正文在浮层里只读展示夹具取到的真实快照文本，Esc 关闭并把焦点还给触发行，全程不写验收/核验')

  stage = 'artifact projection: read failure'
  await resetLoom()
  await switchArtifacts({ fail: true })
  await openDelivery()
  const unknownEvidence = await waitEvidence('sha256:restore-protocol', 2,
    'A failing loom.artifacts.list dropped the evidence rows')
  assert.deepEqual(unknownEvidence.map(row => row.state), ['unknown', 'unknown'],
    `A failed artifacts read must mark every evidence row unknown: ${JSON.stringify(unknownEvidence.map(row => row.state))}`)
  assert.deepEqual(unknownEvidence.map(row => row.badge), ['产物信息读取失败', '产物信息读取失败'],
    `A failed artifacts read must read 产物信息读取失败 on every row: ${JSON.stringify(unknownEvidence.map(row => row.badge))}`)
  assert.equal(unknownEvidence.some(row => row.badge === '未登记' || row.badge === '已登记'), false,
    `A failed artifacts read must not pretend registered or unregistered: ${JSON.stringify(unknownEvidence.map(row => row.badge))}`)
  assert.deepEqual(unknownEvidence.map(row => row.path), ['evidence-1', 'evidence-2'],
    `A failed artifacts read must fall back to the raw evidenceIds: ${JSON.stringify(unknownEvidence.map(row => row.path))}`)
  assert.deepEqual(unknownEvidence.filter(row => row.hash !== null || row.size !== null).map(row => row.path), [],
    `A failed artifacts read must not invent hash or size: ${JSON.stringify(unknownEvidence)}`)
  // 其余七个投影必须照常：候选、两枚徽章、写入口、共享交付面板、编排图都不受影响。
  const afterArtifactsFailure = await script(`({
    candidates: document.querySelectorAll('.loom-delivery-context .loom-candidate').length,
    verificationBadges: [...document.querySelectorAll('.loom-badge-verification')].map(node => node.getAttribute('data-state')),
    acceptanceBadges: [...document.querySelectorAll('.loom-badge-acceptance')].map(node => node.getAttribute('data-state')),
    actions: [...document.querySelectorAll('.loom-delivery-actions button')].map(button => button.textContent.trim()),
    review: document.querySelector('.loom-candidate-review')?.innerText ?? null,
    sharedEvidence: document.querySelectorAll('.loom-workspace .mission-evidence-row').length,
    deliveryEmpty: document.querySelectorAll('.loom-delivery-context .loom-empty').length
  })`)
  assert.equal(afterArtifactsFailure.candidates, 2,
    `A failed artifacts read must keep both candidate cards: ${JSON.stringify(afterArtifactsFailure)}`)
  assert.deepEqual(afterArtifactsFailure.verificationBadges, ['verified', 'unverified'],
    `A failed artifacts read changed the verification axis: ${JSON.stringify(afterArtifactsFailure.verificationBadges)}`)
  assert.deepEqual(afterArtifactsFailure.acceptanceBadges, ['accepted', 'pending'],
    `A failed artifacts read changed the acceptance axis: ${JSON.stringify(afterArtifactsFailure.acceptanceBadges)}`)
  assert.deepEqual(afterArtifactsFailure.actions, ['接受', '退回', '通过核验', '核验失败'],
    `A failed artifacts read removed the delivery actions: ${JSON.stringify(afterArtifactsFailure.actions)}`)
  assert.equal(typeof afterArtifactsFailure.review, 'string',
    `A failed artifacts read dropped the recorded review: ${JSON.stringify(afterArtifactsFailure.review)}`)
  assert.ok(afterArtifactsFailure.sharedEvidence >= 4,
    `A failed artifacts read blanked the shared delivery panel: ${JSON.stringify(afterArtifactsFailure.sharedEvidence)}`)
  assert.equal(afterArtifactsFailure.deliveryEmpty, 0,
    `A failed artifacts read degraded the delivery section into an error empty state: ${JSON.stringify(afterArtifactsFailure.deliveryEmpty)}`)
  await openPlanTab('the failing artifacts read')
  const planAfterArtifactsFailure = await script(`({
    nodes: document.querySelectorAll('.loom-plan .loom-flow-node').length,
    edges: document.querySelectorAll('.loom-plan .loom-flow-edge').length,
    stats: document.querySelector('.loom-plan .loom-flow-stats')?.innerText ?? '',
    empty: document.querySelectorAll('.loom-plan .loom-empty').length,
    claimStates: [...document.querySelectorAll('.loom-plan .loom-flow-claim')].map(node => node.getAttribute('data-claim-state'))
  })`)
  assert.equal(planAfterArtifactsFailure.nodes, 4,
    `A failed artifacts read must not take the task nodes down: ${JSON.stringify(planAfterArtifactsFailure)}`)
  assert.equal(planAfterArtifactsFailure.edges, 3,
    `A failed artifacts read must keep the dependency edges: ${JSON.stringify(planAfterArtifactsFailure.edges)}`)
  assert(planAfterArtifactsFailure.stats.includes('总任务: 4') && planAfterArtifactsFailure.stats.includes('依赖就绪: 1'),
    `A failed artifacts read must not blank the flow stats: ${JSON.stringify(planAfterArtifactsFailure.stats)}`)
  assert.equal(planAfterArtifactsFailure.empty, 0,
    `A failed artifacts read turned 编排 into the read-failed empty state: ${JSON.stringify(planAfterArtifactsFailure.empty)}`)
  assert.deepEqual(planAfterArtifactsFailure.claimStates, ['none', 'none', 'none', 'none'],
    `A failed artifacts read disturbed the claims projection: ${JSON.stringify(planAfterArtifactsFailure.claimStates)}`)
  await expectPlanWidths('a failing artifacts read')
  await backToDelivery('the failing artifacts read')
  assert.deepEqual(await script('window.loomQA.errors'), [],
    'A forced artifacts read failure was misreported as an unanswered fixture method')
  cases.push('loom.artifacts.list 读失败时只有候选卡产物区降级成「产物信息读取失败」（不冒充未登记），其余七个投影照常渲染')

  const afterRemount = async (expression) => {
    const before = await script('document.querySelector("[data-loom-generation]")?.getAttribute("data-loom-generation")')
    await script(expression)
    await waitFor(`document.querySelector("[data-loom-generation]")?.getAttribute("data-loom-generation") !== ${JSON.stringify(before)}`,
      `LOOM workspace did not remount after ${expression}`)
  }

  stage = 'live placements'
  await resetLoom()
  await afterRemount('window.loomQA.setLive("mixed")')
  await openPlanTab('the live placements')
  await waitFor("(document.querySelector('.loom-live-strip')?.innerText ?? '').includes('loom-a') && (document.querySelector('.loom-live-strip')?.innerText ?? '').includes('desk-b')",
    'The mission strip did not name both the local node and the remote node')
  const live = await script(`(() => {
    const text = value => (value ?? '').replace(/\\s+/gu, ' ').trim()
    const item = title => [...document.querySelectorAll('.loom-live-strip-item')].find(node => (node.querySelector('.loom-live-strip-title')?.innerText ?? '').includes(title))
    const lane = role => document.querySelector('.loom-live-lane[data-live-role="' + role + '"]')
    const row = role => document.querySelector('.loom-live-row[data-live-role="' + role + '"]')
    return {
      done: text(item('设计恢复协议')?.innerText),
      local: text(lane('local')?.innerText),
      remote: text(lane('remote')?.innerText),
      localRole: row('local')?.getAttribute('data-live-role') ?? null,
      localPhase: row('local')?.getAttribute('data-live-phase') ?? null,
      remoteRole: row('remote')?.getAttribute('data-live-role') ?? null,
      remotePhase: row('remote')?.getAttribute('data-live-phase') ?? null,
      localCopy: text(row('local')?.innerText),
      remoteCopy: text(row('remote')?.innerText),
      claims: [...document.querySelectorAll('.loom-flow-claim-status')].map(node => text(node.innerText))
    }
  })()`)
  assert(live.done.includes('已完成') && !live.done.includes('loom-a'), `A finished task without a run must stay done and unassigned: ${JSON.stringify(live.done)}`)
  assert(live.local.includes('本机') && live.local.includes('loom-a') && live.local.includes('在跑'),
    `The local run lost its machine or running state on the strip: ${JSON.stringify(live.local)}`)
  assert(live.remote.includes('远端') && live.remote.includes('desk-b') && live.remote.includes('离线'),
    `The remote run lost its badge, machine or offline state on the strip: ${JSON.stringify(live.remote)}`)
  assert(live.localCopy.includes('codex-cli'), `The local card lost its CLI: ${JSON.stringify(live.localCopy)}`)
  assert(live.remoteCopy.includes('claude-code-cli'), `The remote card lost its CLI: ${JSON.stringify(live.remoteCopy)}`)
  assert(live.remoteCopy.includes('最后心跳') && live.remoteCopy.includes('秒前'), `An offline card must show how long since the last heartbeat: ${JSON.stringify(live.remoteCopy)}`)
  const lanes = await script(`({
    roles: [...document.querySelectorAll('.loom-live-lane')].map(node => node.getAttribute('data-live-role')),
    localStatus: [...document.querySelectorAll('.loom-flow-node')].find(node => (node.innerText || '').includes('实现恢复逻辑'))?.querySelector('.loom-flow-node-status')?.innerText ?? ''
  })`)
  assert.deepEqual(lanes.roles, ['local', 'remote', 'none'], `Lanes must be one row per node, local first: ${JSON.stringify(lanes.roles)}`)
  assert.equal(lanes.localStatus.trim(), '在跑', `A running task must not keep a contradictory workflow status: ${JSON.stringify(lanes.localStatus)}`)
  const pins = await script(`[...document.querySelectorAll('.loom-flow-node-pin')].map(node => node.innerText.trim())`)
  assert(pins.some(text => text.includes('钉在') && text.includes('loom-a')), `The local task did not show its pinned node: ${JSON.stringify(pins)}`)
  assert(pins.some(text => text.includes('钉在') && text.includes('desk-b')), `The remote task did not show its pinned node: ${JSON.stringify(pins)}`)
  assert.equal(live.localRole, 'local')
  assert.equal(live.localPhase, 'running')
  assert.equal(live.remoteRole, 'remote')
  assert.equal(live.remotePhase, 'offline')
  assert(live.localCopy.includes('已进行'), `A running card did not show elapsed time: ${JSON.stringify(live.localCopy)}`)
  assert(live.claims.includes('已认领'), `Live node rows replaced the claim block: ${JSON.stringify(live.claims)}`)
  await expectPlanWidths('live placements')
  cases.push('编排卡片和使命进度条写出本机与远端、CLI、在跑或离线、已进行，完成的任务不编造节点，认领行还在')

  stage = 'live output follows until the reader scrolls up'
  // 先量真实几何再点：这条用例要证的是「按钮确实在可视区外，被滚回来之后才点得到」，
  // 不是推断。before/after 两帧几何最后挂在 report.uiGeometry，不参与 cases 计数。
  const liveButtonGeometry = () => script(`(() => {
    const element = document.querySelector('.loom-live-row[data-live-role="local"] .loom-live-open')
    const pane = document.querySelector('.loom-plan')
    if (!element) return null
    const bounds = element.getBoundingClientRect()
    return {
      top: Math.round(bounds.top),
      bottom: Math.round(bounds.bottom),
      height: Math.round(bounds.height),
      innerHeight: window.innerHeight,
      planScrollTop: Math.round(pane?.scrollTop ?? -1),
      planClientHeight: Math.round(pane?.clientHeight ?? -1),
      inViewport: bounds.top >= 0 && bounds.bottom <= window.innerHeight
    }
  })()`)
  const liveGeometryBefore = await liveButtonGeometry()
  await click('.loom-live-row[data-live-role="local"] .loom-live-open')
  const liveGeometryAfter = await liveButtonGeometry()
  uiGeometry.liveOpen = { before: liveGeometryBefore, after: liveGeometryAfter }
  await waitFor("(document.querySelector('.loom-live-output')?.innerText ?? '').includes('帧 2')",
    'Opening a card did not grow the node output')
  await waitFor("(() => { const node = document.querySelector('.loom-live-output'); return !!node && node.clientHeight >= 260 && node.scrollHeight > node.clientHeight + 24 })()",
    'The execution log did not grow to a scrolling viewport', 20000)
  await script(`(() => {
    const node = document.querySelector('.loom-live-output')
    node.scrollTop = 0
    node.dispatchEvent(new Event('scroll', { bubbles: true }))
    return true
  })()`)
  const linesBeforePause = await script("document.querySelectorAll('.loom-live-line').length")
  await waitFor("document.querySelector('.loom-live-output')?.getAttribute('data-follow') === 'false'",
    'Scrolling the output up did not pause follow')
  await waitFor(`document.querySelectorAll('.loom-live-line').length > ${linesBeforePause} && !!document.querySelector('.loom-live-pill')`,
    'Paused output stopped receiving frames', 15000)
  const paused = await script(`(() => {
    const node = document.querySelector('.loom-live-output')
    const pill = document.querySelector('.loom-live-pill')
    const header = document.querySelector('.loom-live-process header')?.innerText ?? ''
    const output = node.getBoundingClientRect()
    const pillBox = pill?.getBoundingClientRect()
    return { follow: node.getAttribute('data-follow'), top: node.scrollTop, height: node.clientHeight, text: node.innerText, pill: pill?.innerText ?? '', header, pillClears: !!pillBox && pillBox.top >= output.bottom - 1 }
  })()`)
  assert.equal(paused.follow, 'false', `Follow resumed on its own: ${JSON.stringify(paused)}`)
  assert.equal(paused.top, 0, `A paused reader was pulled back to the latest line: ${JSON.stringify(paused)}`)
  assert(paused.height >= 260, `The execution log is shorter than the reading viewport: ${JSON.stringify(paused.height)}`)
  assert.equal(paused.pillClears, true, `The new-output pill covers the log: ${JSON.stringify(paused)}`)
  assert(paused.text.includes('帧 1') && paused.text.includes('帧 3'), `The stream did not resume from the lines already shown: ${JSON.stringify(paused.text)}`)
  assert(/^新输出 \d+/u.test(paused.pill.trim()), `Scrolling up did not show a new-output count: ${JSON.stringify(paused.pill)}`)
  assert(paused.header.includes('共') && paused.header.includes('行'), `The process header lost its line count: ${JSON.stringify(paused.header)}`)
  cases.push('点开卡片后执行过程按序号追加，读者往上滚时停止自动跟随，并标出新输出的行数')

  stage = 'claims failure keeps node names off the cards'
  await afterRemount('window.loomQA.failClaimsWithNodes()')
  await openPlanTab('claims failed while nodes are known')
  await waitFor("(document.querySelector('.loom-plan')?.innerText ?? '').includes('认领状态未知')",
    'A failed claims read with a node list stopped saying 认领状态未知')
  const unknownLive = await script(`(() => {
    const text = document.querySelector('.loom-plan')?.innerText ?? ''
    return {
      desk: text.includes('desk-b'),
      rows: document.querySelectorAll('.loom-live-row').length,
      states: [...document.querySelectorAll('.loom-flow-claim')].map(node => node.getAttribute('data-claim-state')),
      strip: document.querySelectorAll('.loom-live-strip-item').length
    }
  })()`)
  assert.equal(unknownLive.desk, false, `A failed claims read still named a node: ${JSON.stringify(unknownLive)}`)
  assert.equal(unknownLive.rows, 0, `A failed claims read still drew a run row: ${JSON.stringify(unknownLive)}`)
  assert.deepEqual(unknownLive.states, [null, null, null, null], `A failed claims read stamped a claim state: ${JSON.stringify(unknownLive.states)}`)
  assert.equal(unknownLive.strip, 4, `A failed claims read removed the progress strip: ${JSON.stringify(unknownLive)}`)
  cases.push('认领读失败时即使节点列表在，也不把 Run 安到卡片上，认领状态未知保持，进度条只剩任务本身')

  stage = 'no plan keeps the empty orchestration'
  await afterRemount('window.loomQA.setPlanHidden(true)')
  await click('.loom-section-tabs button:nth-of-type(2)')
  await expectPressed(1, '编排 did not open for the empty plan')
  await waitFor("(document.querySelector('.loom-plan')?.innerText ?? '').includes('尚未配置编排')",
    'Hiding the plan did not restore 尚未配置编排')
  const emptyPlan = await script(`({
    strip: document.querySelectorAll('.loom-live-strip').length,
    nodes: document.querySelectorAll('.loom-flow-node').length,
    foundation: document.querySelectorAll('.loom-foundation').length,
    title: document.querySelector('.loom-empty h3')?.innerText ?? ''
  })`)
  assert.equal(emptyPlan.strip, 0, `An unplanned mission still drew the live strip: ${JSON.stringify(emptyPlan)}`)
  assert.equal(emptyPlan.nodes, 0, `An unplanned mission still drew flow nodes: ${JSON.stringify(emptyPlan)}`)
  assert.equal(emptyPlan.foundation, 1, `An unplanned mission lost the foundation counts: ${JSON.stringify(emptyPlan)}`)
  assert.equal(emptyPlan.title, '尚未配置编排', `The empty title changed: ${JSON.stringify(emptyPlan.title)}`)
  cases.push('没有计划时仍是尚未配置编排和三格基础计数，不画进度条，也不画节点行')

  stage = 'relay control: unapproved scope'
  // 控制区专用：受控 select / input 只认原生 setter + 事件，直接赋 value 不会触发 React。
  const setNativeValue = (expression, value, prototype, eventName) => script(`(() => {
    const node = ${expression}
    if (!node) return null
    const setter = Object.getOwnPropertyDescriptor(${prototype}.prototype, 'value').set
    setter.call(node, ${JSON.stringify(value)})
    node.dispatchEvent(new Event(${JSON.stringify(eventName)}, { bubbles: true }))
    return node.value
  })()`)
  const setSelect = (expression, value) => setNativeValue(expression, value, 'HTMLSelectElement', 'change')
  const setTextField = (expression, value) => setNativeValue(expression, value, 'HTMLInputElement', 'input')
  const controlState = () => script("document.querySelector('.loom-control')?.getAttribute('data-control-state') ?? null")
  const waitControlState = async (expected, message) => {
    const deadline = Date.now() + 8000
    let seen = null
    while (Date.now() < deadline) {
      seen = await controlState()
      if (seen === expected) return seen
      await sleep(30)
    }
    throw new Error(`${message}: ${JSON.stringify(seen)}`)
  }
  const controlCalls = method => script(
    `window.loomQA.calls.filter(call => call.method === ${JSON.stringify(method)}).map(call => call.params)`)
  const controlFacts = () => script(`([...document.querySelectorAll('.loom-control-fact')].map(node => node.innerText.replace(/\\s+/gu, ' ')))`)
  const openControl = async label => {
    await openPlanTab(label)
    await waitFor("!!document.querySelector('.loom-control')", `${label}: 编排 did not render the relay control region`)
  }

  await resetLoom()
  await openControl('the unapproved relay scope')
  await waitControlState('unapproved', 'A mission without an approved policy must read 尚未批准')
  const controlEmpty = await script(`(() => {
    const root = document.querySelector('.loom-control')
    const approve = document.querySelector('.loom-control-approve')
    return {
      copy: (root?.innerText ?? '').replace(/\\s+/gu, ' '),
      stateCopy: root?.querySelector('.loom-control-state')?.innerText ?? '',
      taskBoxes: [...document.querySelectorAll('.loom-control-task input[type=checkbox]')].map(input => input.checked),
      reviewers: [...document.querySelectorAll('.loom-control-reviewer')].map(select => select.value),
      dispatches: document.querySelector('.loom-control-max-dispatches')?.value ?? null,
      reworks: document.querySelector('.loom-control-max-reworks')?.value ?? null,
      expires: document.querySelector('.loom-control-expires')?.value ?? null,
      problems: [...document.querySelectorAll('.loom-control-problems li')].map(node => node.innerText),
      approve: approve === null ? null : { label: approve.innerText, disabled: approve.disabled },
      facts: document.querySelectorAll('.loom-control-fact').length,
      pause: document.querySelectorAll('.loom-control-pause').length
    }
  })()`)
  assert.equal(controlEmpty.stateCopy, '尚未批准接力范围', `未批准状态文案不对: ${JSON.stringify(controlEmpty.stateCopy)}`)
  assert.deepEqual(controlEmpty.taskBoxes, [false, false, false, false], `控制区替用户预勾了任务: ${JSON.stringify(controlEmpty.taskBoxes)}`)
  assert.deepEqual(controlEmpty.reviewers, ['', '', '', ''], `控制区替用户预选了审查者: ${JSON.stringify(controlEmpty.reviewers)}`)
  assert.deepEqual([controlEmpty.dispatches, controlEmpty.reworks, controlEmpty.expires], ['', '', ''],
    `控制区替用户填了预算或到期: ${JSON.stringify(controlEmpty)}`)
  assert.ok(controlEmpty.problems.length >= 3,
    `空表单没有列出缺口: ${JSON.stringify(controlEmpty.problems)}`)
  assert.deepEqual(controlEmpty.approve, { label: '批准此范围', disabled: true },
    `空表单就能提交批准: ${JSON.stringify(controlEmpty.approve)}`)
  assert.equal(controlEmpty.facts, 0, '未批准就展示了策略事实')
  assert.equal(controlEmpty.pause, 0, '未批准就给出了暂停入口')
  // 独立审查者排除执行者本人：task-3 的执行者是「临舟」，审查者候选项里不能再出现他。
  const reviewerChoices = await script(`(() => {
    const row = document.querySelector('.loom-control-task[data-task-id="task-3"]')
    return [...(row?.querySelectorAll('.loom-control-reviewer option') ?? [])].map(option => option.textContent)
  })()`)
  assert.equal(reviewerChoices.includes('临舟'), false,
    `The executor is still offered as an independent reviewer: ${JSON.stringify(reviewerChoices)}`)
  assert.equal(reviewerChoices.includes('亚纪'), true,
    `The reviewer options lost a real independent candidate: ${JSON.stringify(reviewerChoices)}`)
  assert(controlEmpty.copy.includes('不会终止正在运行的任务'),
    `控制区没有说明不终止当前运行: ${JSON.stringify(controlEmpty.copy)}`)
  assert(controlEmpty.copy.includes('不代替你验收候选或批准发布'),
    `控制区没有说明不代替验收/发布: ${JSON.stringify(controlEmpty.copy)}`)
  cases.push('未批准时控制区不预勾任务、不预选审查者、不预填预算，逐条列出缺口并禁用批准，文案说明不终止运行也不代替验收')

  stage = 'relay control: approve scope'
  await clickElement("document.querySelector('.loom-control-task[data-task-id=\"task-3\"] input[type=checkbox]')")
  await waitFor("document.querySelector('.loom-control-task[data-task-id=\"task-3\"] input[type=checkbox]')?.checked === true",
    'Clicking a task checkbox did not include the task in the relay scope')
  assert.equal(await setSelect("document.querySelector('.loom-control-task[data-task-id=\"task-3\"] .loom-control-reviewer')", 'agent-lead'),
    'agent-lead', 'The reviewer select did not take the chosen reviewer')
  assert.equal(await setTextField("document.querySelector('.loom-control-max-dispatches')", '3'), '3',
    'The dispatch budget input did not take the typed number')
  assert.equal(await setTextField("document.querySelector('.loom-control-max-reworks')", '1'), '1',
    'The rework budget input did not take the typed number')
  await setTextField("document.querySelector('.loom-control-expires')", '2026-10-01T00:00')
  await settle(160)
  await waitFor("document.querySelector('.loom-control-approve')?.disabled === false",
    'A fully specified scope still could not be approved')
  await clickElement("document.querySelector('.loom-control-approve')")
  await waitControlState('approved', 'Approving the scope did not come back as 已批准')
  const configure = (await controlCalls('loom.control.configure')).at(-1)
  assert(configure, 'The approve click never called loom.control.configure')
  assert.equal(configure.enabled, true, `configure did not send enabled=true: ${JSON.stringify(configure)}`)
  assert.equal(configure.expectedRevision, 0, `The first approval must send expectedRevision 0: ${JSON.stringify(configure.expectedRevision)}`)
  assert.equal(configure.missionId, 'mission-loom-018', `configure sent the wrong mission: ${JSON.stringify(configure.missionId)}`)
  assert.match(configure.commandId, UUID_PATTERN, `configure needs a real command id: ${JSON.stringify(configure.commandId)}`)
  assert.deepEqual(configure.taskIds, ['task-3'], `configure sent the wrong task scope: ${JSON.stringify(configure.taskIds)}`)
  assert.deepEqual(configure.reviewers, [{ taskId: 'task-3', reviewerAgentId: 'agent-lead' }],
    `configure sent the wrong reviewers: ${JSON.stringify(configure.reviewers)}`)
  assert.equal(configure.maxDispatches, 3, `configure lost the typed dispatch budget: ${JSON.stringify(configure.maxDispatches)}`)
  assert.equal(configure.maxReworksPerTask, 1, `configure lost the typed rework budget: ${JSON.stringify(configure.maxReworksPerTask)}`)
  assert.equal(typeof configure.expiresAt, 'string', `configure dropped the expiry: ${JSON.stringify(configure.expiresAt)}`)
  assert.equal(Number.isNaN(Date.parse(configure.expiresAt)), false, `configure sent an unparseable expiry: ${JSON.stringify(configure.expiresAt)}`)
  const approvedFacts = await controlFacts()
  assert(approvedFacts.some(text => text.includes('修订') && text.includes('1')),
    `The approved policy facts lost its revision: ${JSON.stringify(approvedFacts)}`)
  assert(approvedFacts.some(text => text.includes('已使用 2 / 上限 3')),
    `The approved policy facts must show 已使用/上限 from every historical dispatch: ${JSON.stringify(approvedFacts)}`)
  const approvedForm = await script(`({
    form: document.querySelectorAll('.loom-control-form').length,
    pause: document.querySelector('.loom-control-pause')?.innerText ?? null,
    rows: document.querySelectorAll('.loom-control-dispatches .loom-dispatch').length
  })`)
  assert.equal(approvedForm.form, 0, 'The approval form stayed open after a successful configure')
  assert.equal(approvedForm.pause, '暂停接力', `An approved scope must offer 暂停接力: ${JSON.stringify(approvedForm.pause)}`)
  assert.equal(approvedForm.rows, 2, `The control region lost the real dispatch rows: ${JSON.stringify(approvedForm.rows)}`)
  cases.push('批准此范围发出 configure 的真实入参（enabled/expectedRevision 0/uuid/任务/审查者/预算/到期）并回读真实策略事实与派发计数')

  stage = 'relay control: pause and resume'
  await clickElement("document.querySelector('.loom-control-pause')")
  await waitControlState('paused', 'Pausing did not come back as 已暂停')
  const pauseCall = (await controlCalls('loom.control.pause')).at(-1)
  assert(pauseCall, 'The pause click never called loom.control.pause')
  assert.equal(pauseCall.paused, true, `pause did not send paused=true: ${JSON.stringify(pauseCall)}`)
  assert.equal(pauseCall.expectedRevision, 1, `pause must send the observed revision: ${JSON.stringify(pauseCall.expectedRevision)}`)
  assert.match(pauseCall.commandId, UUID_PATTERN, `pause needs a real command id: ${JSON.stringify(pauseCall.commandId)}`)
  await waitFor("(document.querySelector('.loom-control-pause')?.innerText ?? '') === '继续接力'",
    'A paused scope did not turn its action into 继续接力')
  await clickElement("document.querySelector('.loom-control-pause')")
  await waitControlState('approved', 'Resuming did not come back as 已批准')
  const resumeCall = (await controlCalls('loom.control.pause')).at(-1)
  assert.equal(resumeCall.paused, false, `resume did not send paused=false: ${JSON.stringify(resumeCall)}`)
  assert.equal(resumeCall.expectedRevision, 2, `resume must send the revision it just observed: ${JSON.stringify(resumeCall.expectedRevision)}`)
  assert.notEqual(resumeCall.commandId, pauseCall.commandId, 'resume reused the pause command id')
  // pause/resume 只推进 revision，不推进授权修订：旧授权下的审查不会因为暂停而突然有效。
  const afterResumeFacts = await controlFacts()
  assert(afterResumeFacts.some(text => text.includes('授权版本') && text.includes('1')),
    `pause/resume must not advance authorizationRevision: ${JSON.stringify(afterResumeFacts)}`)
  cases.push('暂停与继续都发出带 uuid 与真实修订的 pause 入参，并各自回读成已暂停/已批准')

  stage = 'relay control: revision conflict'
  // 另一个客户端把策略改了：界面手里的 revision 已过期，写必须撞冲突而不是本地伪造。
  await script('window.loomQA.driftControlRevision()')
  await clickElement("document.querySelector('.loom-control-pause')")
  await waitFor("(document.querySelector('.loom-control-failure')?.innerText ?? '') !== ''",
    'A stale revision write failed without any visible message')
  const conflicted = await script(`({
    state: document.querySelector('.loom-control')?.getAttribute('data-control-state'),
    failure: document.querySelector('.loom-control-failure')?.innerText ?? '',
    pauseCopy: document.querySelector('.loom-control-pause')?.innerText ?? null,
    pauseDisabled: document.querySelector('.loom-control-pause')?.disabled ?? null
  })`)
  assert.equal(conflicted.state, 'approved', `A failed write must not locally fake the paused state: ${JSON.stringify(conflicted)}`)
  assert.equal(conflicted.pauseCopy, '暂停接力', `A failed write rewrote the button label locally: ${JSON.stringify(conflicted.pauseCopy)}`)
  assert.equal(conflicted.pauseDisabled, true, `A conflicted scope still accepted more writes: ${JSON.stringify(conflicted)}`)
  assert(conflicted.failure.includes('刷新'), `The conflict message must ask for a refresh: ${JSON.stringify(conflicted.failure)}`)
  await clickElement("document.querySelector('.loom-control-failure button')")
  await waitControlState('approved', 'Refreshing after the conflict did not return to the real state')
  const afterConflict = await script(`({
    disabled: document.querySelector('.loom-control-pause')?.disabled ?? null,
    revision: ([...document.querySelectorAll('.loom-control-fact')].map(node => node.innerText.replace(/\\s+/gu, ' ')).find(text => text.includes('修订')) ?? '')
  })`)
  assert.equal(afterConflict.disabled, false, `Refreshing after a conflict left the scope unusable: ${JSON.stringify(afterConflict)}`)
  assert(Number((afterConflict.revision.match(/\d+/u) ?? ['0'])[0]) > 3,
    `Refreshing did not adopt the newer revision from the receipt: ${JSON.stringify(afterConflict.revision)}`)
  cases.push('策略修订冲突时可见失败并引用刷新，不本地伪造暂停；刷新后按真实修订继续')

  stage = 'relay control: read failure'
  await resetLoom()
  await afterRemount('window.loomQA.setControl({ fail: true })')
  await openControl('the failing control read')
  await waitControlState('unreadable', 'A failing loom.control.get did not read as 读不到')
  const unreadable = await script(`({
    stateCopy: document.querySelector('.loom-control-state')?.innerText ?? '',
    copy: (document.querySelector('.loom-control')?.innerText ?? '').replace(/\\s+/gu, ' '),
    approve: document.querySelectorAll('.loom-control-approve').length,
    pause: document.querySelectorAll('.loom-control-pause').length,
    facts: document.querySelectorAll('.loom-control-fact').length,
    nodes: document.querySelectorAll('.loom-plan .loom-flow-node').length,
    errors: window.loomQA.errors.slice()
  })`)
  assert.equal(unreadable.stateCopy, '控制策略读取失败', `控制读失败的文案不对: ${JSON.stringify(unreadable.stateCopy)}`)
  assert.equal(unreadable.copy.includes('尚未批准'), false,
    `A failed control read pretended the scope was never approved: ${JSON.stringify(unreadable.copy)}`)
  assert.equal(unreadable.copy.includes('接力已停用'), false,
    `A failed control read pretended the relay was disabled: ${JSON.stringify(unreadable.copy)}`)
  assert.equal(unreadable.approve + unreadable.pause + unreadable.facts, 0,
    `A failed control read still offered write entries or facts: ${JSON.stringify(unreadable)}`)
  assert.equal(unreadable.nodes, 4, `A failed control read took the task nodes down with it: ${JSON.stringify(unreadable.nodes)}`)
  assert.deepEqual(unreadable.errors, [], 'A forced control read failure was misreported as an unanswered fixture method')

  // 第二轮：快照缺必需字段（authorizationRevision / dispatches）同样只能是「读不到」，不能落成未批准。
  await resetLoom()
  await afterRemount('window.loomQA.setControl({ partial: true })')
  await openControl('the incomplete control snapshot')
  await waitControlState('unreadable', 'An incomplete control snapshot did not read as 读不到')
  const partialSnapshot = await script(`({
    stateCopy: document.querySelector('.loom-control-state')?.innerText ?? '',
    copy: (document.querySelector('.loom-control')?.innerText ?? '').replace(/\\s+/gu, ' '),
    approve: document.querySelectorAll('.loom-control-approve').length,
    nodes: document.querySelectorAll('.loom-plan .loom-flow-node').length
  })`)
  assert.equal(partialSnapshot.stateCopy, '控制策略读取失败', `缺字段快照的文案不对: ${JSON.stringify(partialSnapshot.stateCopy)}`)
  assert.equal(partialSnapshot.copy.includes('尚未批准'), false,
    `An incomplete snapshot was rendered as 未批准: ${JSON.stringify(partialSnapshot.copy)}`)
  assert(partialSnapshot.copy.includes('缺少必需字段'),
    `The incomplete snapshot did not say which field is missing: ${JSON.stringify(partialSnapshot.copy)}`)
  assert.equal(partialSnapshot.approve, 0, 'A partial snapshot still offered approval')
  assert.equal(partialSnapshot.nodes, 4, `A partial snapshot took the task nodes down: ${JSON.stringify(partialSnapshot.nodes)}`)
  cases.push('loom.control.get 读失败或快照缺必需字段时控制区只说读不到，不冒充未批准或已停用，也不给批准/暂停入口，编排其余部分照常')

  stage = 'delivery: rework chain locks the old candidate'
  await resetLoom()
  await afterRemount('window.loomQA.setReworkChain()')
  await click('.loom-section-tabs button:nth-of-type(3)')
  await expectPressed(2, '交付 did not open for the rework chain')
  await waitFor("document.querySelectorAll('.loom-delivery-context .loom-candidate').length === 3",
    'The rework chain did not list three candidate cards')
  const chain = await script(`(() => {
    const cards = [...document.querySelectorAll('.loom-delivery-context .loom-candidate')]
    return cards.map(card => ({
      candidateId: card.getAttribute('data-candidate-id'),
      version: card.getAttribute('data-chain-version'),
      latest: card.getAttribute('data-latest'),
      versionCopy: card.querySelector('.loom-candidate-version')?.innerText ?? '',
      facts: [...card.querySelectorAll('.loom-fact')].map(node => node.getAttribute('data-fact')),
      buttons: [...(card.querySelector(':scope > .loom-delivery-actions')?.querySelectorAll('button') ?? [])].map(button => button.textContent.trim()),
      locked: card.querySelector('.loom-candidate-locked')?.innerText ?? null,
      stageVerdict: card.querySelector('.loom-stage-badge')?.getAttribute('data-verdict') ?? null,
      stageFreshness: card.querySelector('.loom-stage-badge')?.getAttribute('data-freshness') ?? null,
      stageBadgeCopy: card.querySelector('.loom-stage-badge')?.innerText ?? null,
      stageCopy: card.querySelector('.loom-candidate-stage-review')?.innerText ?? null
    }))
  })()`)
  const oldCandidate = chain.find(card => card.candidateId === 'candidate-2')
  const newCandidate = chain.find(card => card.candidateId === 'candidate-3')
  assert(oldCandidate && newCandidate, `The rework chain lost a candidate: ${JSON.stringify(chain.map(card => card.candidateId))}`)
  // 版本是「每个任务各自一条链」：task-3 是 candidate-2(v1) → candidate-3(v2)，
  // candidate-1 属于 task-1，不参与这条链。
  assert.equal(oldCandidate.version, '1', `candidate-2 is the first version of the task-3 chain: ${JSON.stringify(oldCandidate.versionCopy)}`)
  assert.equal(oldCandidate.versionCopy.includes('v1'), true, `The old candidate lost its version label: ${JSON.stringify(oldCandidate.versionCopy)}`)
  assert.equal(oldCandidate.versionCopy.includes('最新'), false, `The old candidate claimed to be latest: ${JSON.stringify(oldCandidate.versionCopy)}`)
  assert.equal(oldCandidate.latest, 'false', 'The superseded candidate is still marked latest')
  assert.deepEqual(oldCandidate.facts, ['verification', 'stage-review', 'acceptance'],
    `The three axes are not kept apart: ${JSON.stringify(oldCandidate.facts)}`)
  assert.deepEqual(oldCandidate.buttons, [], `A superseded candidate still offered 接受/核验: ${JSON.stringify(oldCandidate.buttons)}`)
  assert((oldCandidate.locked ?? '').includes('接受只对最新候选生效'),
    `A superseded candidate lost its refusal note: ${JSON.stringify(oldCandidate.locked)}`)
  assert.equal(oldCandidate.stageVerdict, 'request_changes',
    `The helper review verdict is not read separately from verification: ${JSON.stringify(oldCandidate.stageVerdict)}`)
  assert((oldCandidate.stageCopy ?? '').includes('恢复失败分支没有覆盖'),
    `The helper review reason disappeared: ${JSON.stringify(oldCandidate.stageCopy)}`)
  // 这条审查挂在旧授权（policyRevision 1）上，而当前 authorizationRevision 是 2：
  // 留历史、明确失效，绝不能当「当前通过」渲染；request_changes 也不是人工驳回。
  assert.equal(oldCandidate.stageFreshness, 'stale',
    `A review from a superseded authorization is presented as current: ${JSON.stringify(oldCandidate.stageFreshness)}`)
  assert((oldCandidate.stageBadgeCopy ?? '').includes('旧授权已失效'),
    `A stale-authorization review lost its expiry copy: ${JSON.stringify(oldCandidate.stageBadgeCopy)}`)
  const stalePasses = await script(`([...document.querySelectorAll('.loom-stage-badge[data-freshness="stale"]')]
    .map(node => node.innerText.trim()).filter(copy => copy === '通过'))`)
  assert.deepEqual(stalePasses, [], `A stale review still reads exactly 通过: ${JSON.stringify(stalePasses)}`)
  assert.equal(newCandidate.version, '2', `candidate-3 is the second version of the task-3 chain: ${JSON.stringify(newCandidate.versionCopy)}`)
  assert.equal(newCandidate.versionCopy.includes('v2'), true, `The new candidate lost its version label: ${JSON.stringify(newCandidate.versionCopy)}`)
  assert.equal(newCandidate.latest, 'true', 'The chain tip is not marked latest')
  assert.deepEqual(newCandidate.buttons, ['接受', '退回', '通过核验', '核验失败'],
    `The chain tip lost its two independent action axes: ${JSON.stringify(newCandidate.buttons)}`)
  assert.equal(newCandidate.locked, null, 'The chain tip was refused as an old version')
  const axes = await script(`([...document.querySelectorAll('.loom-delivery-context .loom-candidate')].map(card => ({
    verification: card.querySelector('.loom-badge-verification')?.getAttribute('data-state') ?? null,
    stage: card.querySelector('.loom-stage-badge')?.getAttribute('data-verdict') ?? null,
    acceptance: card.querySelector('.loom-badge-acceptance')?.getAttribute('data-state') ?? null
  })))`)
  assert(axes.every(axis => axis.verification !== null && axis.stage !== null && axis.acceptance !== null),
    `A candidate dropped one of the three axes: ${JSON.stringify(axes)}`)
  assert(axes.every(axis => axis.stage !== axis.verification),
    `The helper review was merged into the verification badge: ${JSON.stringify(axes)}`)
  cases.push('返工链上 previousCandidateId 标出 v1/v2（每个任务各自一条链），旧版失去接受与核验入口并给出理由，旧授权审查留历史并明确失效，每张候选仍分列技术核验/助手审查/用户接受三条事实')

  stage = 'delivery: asset relations'
  await resetLoom()
  await openDelivery()
  await script("(() => { const pane = document.querySelector('.loom-delivery'); if (pane) pane.scrollTop = 0; return true })()")
  await settle(120)
  await waitFor("document.querySelectorAll('.loom-asset-graph .loom-asset-row').length > 0",
    'The delivery section did not render the asset relation region')
  const assetRows = await script(`([...document.querySelectorAll('.loom-asset-graph .loom-asset-row')].map(row => ({
    registration: row.getAttribute('data-registration'),
    hasConsumer: row.getAttribute('data-has-consumer'),
    producer: row.querySelector('.loom-asset-producer')?.innerText ?? '',
    artifact: row.querySelector('.loom-asset-artifact')?.innerText ?? '',
    candidate: row.querySelector('.loom-asset-candidate')?.innerText ?? '',
    review: row.querySelector('.loom-asset-review')?.innerText ?? '',
    consumer: row.querySelector('.loom-asset-consumer')?.innerText ?? ''
  })))`)
  const registeredAsset = assetRows.find(row => row.registration === 'registered')
  assert(registeredAsset, `A registered artifact is missing from the asset relations: ${JSON.stringify(assetRows)}`)
  assert.equal(registeredAsset.artifact, 'artifacts/restore-protocol.md',
    `The asset row lost the real relative path: ${JSON.stringify(registeredAsset.artifact)}`)
  assert.equal(registeredAsset.producer, '生产 Run run-1',
    `The asset row did not name the real producer run: ${JSON.stringify(registeredAsset.producer)}`)
  assert.equal(registeredAsset.review, '审查 通过',
    `The asset row lost the helper review fact: ${JSON.stringify(registeredAsset.review)}`)
  // artifact_accepted 边仍未冻结：使用者必须是「尚未确定」，不许把 task-4 当既成事实。
  assert(assetRows.every(row => row.hasConsumer === 'false'),
    `An unfrozen dependency was presented as a consumer: ${JSON.stringify(assetRows.map(row => row.hasConsumer))}`)
  assert(assetRows.every(row => row.consumer.includes('使用者尚未确定')),
    `The consumer column invented a downstream: ${JSON.stringify(assetRows.map(row => row.consumer))}`)
  assert(assetRows.every(row => row.consumer.includes('验收测试') === false),
    `An unfrozen downstream task was named as a consumer: ${JSON.stringify(assetRows.map(row => row.consumer))}`)
  const unregisteredAsset = assetRows.find(row => row.registration === 'unregistered')
  assert(unregisteredAsset, `Unregistered evidence ids vanished from the asset relations: ${JSON.stringify(assetRows)}`)
  assert.equal(unregisteredAsset.artifact, 'evidence-2',
    `An unregistered asset row must keep the raw evidenceId: ${JSON.stringify(unregisteredAsset.artifact)}`)
  assert.equal(assetRows.some(row => row.artifact.includes('restore-trace-with-a-deliberately-long-file-name.log')), false,
    'The asset region listed an artifact no candidate evidenceId refers to')
  await clickElement("document.querySelector('.loom-asset-graph .loom-asset-row')")
  await waitFor("document.querySelector('.loom-delivery-context .loom-candidate[data-focused=\"true\"]') !== null",
    'Clicking an asset row did not focus the matching candidate card')
  const focusedCandidate = await script(
    "document.querySelector('.loom-delivery-context .loom-candidate[data-focused=\"true\"]')?.getAttribute('data-candidate-id') ?? null")
  assert.equal(focusedCandidate, 'candidate-1',
    `The asset row focused the wrong candidate: ${JSON.stringify(focusedCandidate)}`)
  cases.push('资产关系区就地按真实产物/候选/审查派生生产者→候选→审查，未冻结依赖不标使用者，未登记只显示 evidenceId，点击聚焦对应候选')

  console.log(JSON.stringify({ ok: true, cases, shots, counts: final, output, uiGeometry }))
  app.exit(0)
}).catch(async error => {
  try {
    writeFileSync(join(output, `loom-workspace-failure-${Date.now()}.png`), (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG())
  } catch {}
  console.error(`LOOM workspace fixture failed during ${stage}:`, error)
  console.error(JSON.stringify({ ok: false, stage, cases, shots, output, uiGeometry }))
  app.exit(1)
})

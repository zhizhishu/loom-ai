import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchAcceptanceBrowser, pause } from './lib/host-web-browser.mjs'
const output = resolve(process.argv[2] ?? '/tmp/rovai-references-ui')
const profile = await mkdtemp(join(tmpdir(), 'rovai-references-browser-'))
await mkdir(output, { recursive: true })
const browser = await launchAcceptanceBrowser({ executable: process.env.ROVAI_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--headless=new','--no-first-run','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'] })
const checks = []
const key = async (key, code = key, modifiers = 0) => {
  const windowsVirtualKeyCode = { Enter:13, Escape:27, ArrowDown:40, ArrowUp:38, Backspace:8, Tab:9, KeyA:65, KeyC:67, KeyZ:90 }[code] ?? 0
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode, ...(key === 'Enter' ? { text:'\r', unmodifiedText:'\r' } : {}) })
  await browser.send('Input.dispatchKeyEvent', { type:'keyUp', key, code, modifiers, windowsVirtualKeyCode })
}
const click = selector => browser.click(`document.querySelector(${JSON.stringify(selector)})`)
const type = async text => {
  await click('#camp-message')
  await key('a','KeyA',4); await key('Backspace'); await pause(80)
  if (text) await browser.send('Input.insertText', { text })
}
const wait = expression => browser.wait(`Boolean(${expression})`)
const ready = () => wait("document.querySelector('.ref-options') && document.querySelector('.ref-options').getAttribute('aria-busy') === 'false'")
const check = (name, value) => { assert.ok(value,name); checks.push(name) }
try {
  await browser.send('Emulation.setFocusEmulationEnabled', { enabled:true })
  await browser.send('Page.navigate', { url:pathToFileURL(join(output,'thread-references.html')).href })
  await wait("document.querySelector('#camp-message[contenteditable=true]') && !!window.__references")
  await type('@')
  await ready()
  check('compact categories preserve original member invitation action', await browser.evaluate("[...document.querySelectorAll('[role=tab]')].filter(x=>x.closest('.ref-filters')).map(x=>x.textContent).join('/') === '队员/对话/使命' && !!document.querySelector('[data-option-kind=invite_other]')"))
  await type('@药师寺')
  await ready()
  check('search includes teammates outside this thread', await browser.evaluate("!!document.querySelector('.ref-options [data-agent-id=copy-member-3]')"))
  await type('@登录')
  await wait("document.querySelector('.ref-search-state')")
  check('one loading state without intermediate category hops', await browser.evaluate("document.querySelector('.ref-search-state').textContent === '搜索中…' && document.querySelector('.ref-filters [aria-selected=true]').textContent === '队员'"))
  await ready()
  check('fuzzy search auto-selects threads and returns first eight', await browser.evaluate("document.querySelector('.ref-filters [aria-selected=true]').textContent === '对话' && document.querySelectorAll('.ref-thread-option').length === 8"))
  const dimensions = await browser.evaluate("(()=>{const e=document.querySelector('.ref-thread-option'),t=e.querySelector('strong').getBoundingClientRect(),p=e.querySelector('small').getBoundingClientRect();return {row:e.getBoundingClientRect().height,header:document.querySelector('.ref-menu-heading').getBoundingClientRect().height,left:t.x,right:p.x,copy:document.querySelector('.ref-menu').textContent}})()")
  check('32px rows, 30px tabs, left title and right project, no extra hints', dimensions.row===32 && dimensions.header===30 && dimensions.right>dimensions.left && !/个结果|最近|关键词|Enter|确认/.test(dimensions.copy))
  await browser.capture(join(output,'threads.png'))
  for (let i=0;i<7;i++) { await click('.ref-load-more'); await ready() }
  check('long lists window DOM and cap panel height', await browser.evaluate("document.querySelector('.ref-options').dataset.virtualized === 'true' && document.querySelectorAll('.ref-thread-option').length < 30 && document.querySelector('.ref-menu').getBoundingClientRect().height <= 482"))
  await browser.evaluate("document.querySelector('.ref-options').scrollTop=440")
  await pause(60)
  const before = await browser.evaluate("document.querySelector('.ref-options').scrollTop")
  await click('.ref-load-more'); await ready()
  check('load more retains scroll position', await browser.evaluate("document.querySelector('.ref-options').scrollTop") === before)
  const pos = await browser.evaluate("Number(document.querySelector('.ref-options [aria-selected=true]').getAttribute('aria-posinset'))")
  for (let i=pos;i<55;i++) { await key('ArrowDown'); await pause(8) }
  await wait("document.querySelector('.ref-options [aria-selected=true]')?.getAttribute('aria-posinset') === '55'")
  const selected = await browser.evaluate("document.querySelector('.ref-options [aria-selected=true]').dataset.referenceId")
  await key('Enter')
  await wait("!!document.querySelector('#camp-message [data-composer-atom=thread_reference]')")
  check('keyboard selects a result beyond fifty by its exact ID', await browser.evaluate("document.querySelector('#camp-message [data-composer-atom=thread_reference]').dataset.referenceId") === selected)
  await pause(400)
  const local = await browser.evaluate("Object.keys(localStorage).filter(k=>k.startsWith('rovai.camp-composer-draft.v1:')).map(k=>localStorage.getItem(k)).join('')")
  check('local persistence retains the reference Atom', local.includes(selected) && local.includes('thread_reference'))
  const timeOrigin = await browser.evaluate('performance.timeOrigin')
  await browser.send('Page.reload')
  await wait(`performance.timeOrigin !== ${timeOrigin} && document.querySelector('#camp-message [data-composer-atom=thread_reference]')`)
  check('refresh restores the exact reference', await browser.evaluate("document.querySelector('#camp-message [data-composer-atom=thread_reference]').dataset.referenceId")===selected)
  await pause(250)
  const availability = await browser.evaluate(`(async () => {
    const { model, catalog } = window.__references
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
    const count = () => model.requests.filter(r => r.method === 'threadReferences.resolve').length
    const atom = () => document.querySelector('#camp-message [data-composer-atom=thread_reference]')
    const target = catalog.find(item => item.id === atom().dataset.referenceId)
    const original = target.title
    const event = (reason, threadId = target.id) => model.emitReferenceEvent({ method: 'navigation.invalidated', params: { reason, threadId } })
    let before = count()
    for (let i = 0; i < 5; i++) {
      model.emitReferenceEvent({ method: 'monitoring.changed', params: {} })
      model.invalidateReferences({ messages: [] })
      event('camps.rename', 'other-thread')
      await pause(50)
    }
    await pause(180)
    const unrelatedIgnored = count() === before
    target.title = '改名后的引用'
    const burst = setInterval(() => event('camps.rename'), 40)
    await pause(260)
    const refreshedDuringBurst = count() > before && atom().textContent.includes(target.title)
    clearInterval(burst); await pause(250)
    model.failResolve = true
    model.invalidateReferences({ referencesChanged: true })
    await pause(250)
    const transportPreservesState = atom().dataset.availability === 'available'
    model.failResolve = false
    model.resolveDelay = 300
    model.maxActiveResolves = 0
    target.title = '较早结果'
    event('camps.rename'); await pause(200)
    target.title = '最终结果'
    event('camps.rename')
    await pause(800)
    const noOverlapAndLatest = model.maxActiveResolves === 1 && atom().textContent.includes('最终结果')
    model.resolveDelay = 0
    catalog.splice(catalog.indexOf(target), 1)
    model.invalidateReferences({ referencesChanged: true })
    await pause(250)
    const deletionRefreshed = atom().dataset.availability === 'unavailable'
    target.title = original; catalog.push(target)
    model.invalidateReferences({ resync: true })
    await pause(250)
    const resyncRecovered = atom().dataset.availability === 'available' && atom().textContent.includes(original)
    return { unrelatedIgnored, refreshedDuringBurst, transportPreservesState, noOverlapAndLatest, deletionRefreshed, resyncRecovered }
  })()`)
  for (const [name, passed] of Object.entries(availability)) check('reference availability: ' + name, passed)
  await click('#camp-message'); await key('Enter')
  await wait("document.body.textContent.includes('请补充本轮内容')")
  check('reference-only input cannot publish', await browser.evaluate("window.__references.model.sent.length===0"))
  await key('a','KeyA',4)
  await browser.evaluate("(()=>{const data=new DataTransfer();document.querySelector('#camp-message').dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));window.__copied={text:data.getData('text/plain'),structured:data.getData('application/x-rovai-composer+json')}})()")
  await wait("window.__copied?.structured")
  check('browser copy retains structured reference identity', (await browser.evaluate('window.__copied.structured')).includes(selected))
  await type('')
  await browser.evaluate("(()=>{const data=new DataTransfer();data.setData('application/x-rovai-composer+json',window.__copied.structured);data.setData('text/plain',window.__copied.text);document.querySelector('#camp-message').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))})()")
  await wait("document.querySelector('#camp-message [data-composer-atom=thread_reference]')")
  check('structured paste restores the selected ID',await browser.evaluate("document.querySelector('#camp-message [data-composer-atom=thread_reference]').dataset.referenceId")===selected)

  await type('@发布')
  await ready()
  check('auto search falls back to missions', await browser.evaluate("document.querySelector('.ref-filters [aria-selected=true]').textContent === '使命' && !!document.querySelector('.ref-thread-option .mission-icon')"))
  await browser.capture(join(output,'missions.png'))
  await key('Enter')
  await wait("document.querySelector('#camp-message [data-composer-atom=mission_reference]')")
  await pause(200)
  check('mission Atom uses a canonical mission ID', await browser.evaluate("/^rvm_[a-f0-9]{32}$/.test(document.querySelector('#camp-message [data-composer-atom=mission_reference]').dataset.referenceId)"))
  await browser.evaluate(`(() => {
    const { model, catalog } = window.__references
    const id = document.querySelector('#camp-message [data-composer-atom=mission_reference]').dataset.referenceId
    catalog.find(item => item.id === id).title = '队员修改后的使命'
    model.emitReferenceEvent({ method: 'missions.invalidated', params: { reason: 'missions.agentUpdated', threadId: 'mission-owner' } })
  })()`)
  await wait("document.querySelector('#camp-message [data-composer-atom=mission_reference]').textContent.includes('队员修改后的使命')")
  check('agent Mission updates refresh the reference label', true)
  await key('z','KeyZ',4)
  await wait("!document.querySelector('#camp-message [data-composer-atom=mission_reference]')")
  await key('Z','KeyZ',12)
  await wait("document.querySelector('#camp-message [data-composer-atom=mission_reference]')")
  check('undo and redo preserve the indivisible mission Atom',true)
  await type('@无此记录')
  await ready()
  check('empty result copy stays short', await browser.evaluate("document.querySelector('.ref-options').textContent.trim() === '无匹配结果'"))
  await type('/')
  await wait("document.querySelectorAll('.simple-skill-option').length===4")
  check('Skills and Toolbox use compact original glyph rows', await browser.evaluate("[...document.querySelectorAll('.simple-skill-group-label')].map(x=>x.textContent).join('/')==='工具箱/Skills' && [...document.querySelectorAll('.simple-skill-option')].every(x=>x.getBoundingClientRect().height===32 && x.querySelector('[data-navigation-icon=sparkles]') && Math.abs(x.querySelector('.simple-skill-copy strong').getBoundingClientRect().top-x.querySelector('.simple-skill-copy small').getBoundingClientRect().top)<2) && !document.querySelector('.simple-skill-menu .mention-menu-heading')"))
  await browser.capture(join(output,'skills.png'))
  await key('Enter')
  check('Skill selection keeps its Atom identity and inline icon', await browser.evaluate("!!document.querySelector('#camp-message [data-composer-atom=skill]') && getComputedStyle(document.querySelector('#camp-message [data-composer-atom=skill]'),'::before').content !== 'none'"))
  await type('@')
  await browser.send('Input.imeSetComposition',{text:'登录',selectionStart:2,selectionEnd:2})
  await browser.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:229})
  await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:229})
  check('composition Enter does not insert an Atom or publish', await browser.evaluate("!document.querySelector('#camp-message [data-composer-atom=thread_reference]') && window.__references.model.sent.length===0"))
  await browser.send('Input.insertText',{text:'登录'})
  await ready()
  await type('')
  await browser.evaluate('window.__references.model.delay=600')
  await browser.send('Input.insertText',{text:'@登录'})
  await pause(230)
  await type('')
  await browser.evaluate('window.__references.model.delay=20')
  await browser.send('Input.insertText',{text:'@发布'})
  await ready(); await pause(650)
  check('late responses cannot replace a newer query category', await browser.evaluate("document.querySelector('.ref-filters [aria-selected=true]').textContent==='使命'"))
  await type('@')
  await click('.ref-filters button:nth-child(2)'); await ready()
  await browser.evaluate("document.documentElement.dataset.theme='night'")
  await browser.capture(join(output,'threads-night.png'))
  check('selected references never trigger a send or history expansion', await browser.evaluate("window.__references.model.sent.length===0 && !window.__references.model.requests.some(r=>r.method==='thread.read' || r.method==='missions.get')"))
  await type('请解释 @无此记录'); await ready(); await key('Escape'); await key('Enter')
  await wait('window.__references.model.sent.length===1')
  check('unmatched literal @ remains ordinary text and Enter sends after Escape',true)
  await type('@登录'); await ready(); await key('Enter')
  await browser.send('Input.insertText',{text:' 检查重试'}); await key('Enter')
  await wait('window.__references.model.sent.length===2 && document.querySelector(".ref-message-link")')
  await click('.ref-message-link')
  await wait("document.querySelector('.ref-popover .ref-popover-actions button')")
  await click('#camp-message'); await pause(100)
  check('outside dismissal preserves the clicked Composer focus',await browser.evaluate("document.activeElement?.id==='camp-message' && !document.querySelector('.ref-popover')"))
  await click('.ref-message-link'); await key('Escape'); await pause(100)
  check('Escape returns reference preview focus to the history trigger',await browser.evaluate("document.activeElement?.classList.contains('ref-message-link') && !document.querySelector('.ref-popover')"))
  await browser.evaluate("(()=>{const id=document.querySelector('.ref-message-link').dataset.referenceId;window.__references.catalog.splice(window.__references.catalog.findIndex(item=>item.id===id),1)})()")
  await click('.ref-message-link')
  await wait("document.querySelector('.ref-unavailable-text')?.textContent==='引用不可用'")
  check('unavailable source retains the published reference and title',await browser.evaluate("document.querySelector('.ref-message-link').textContent==='登录改造' && document.querySelector('.ref-popover-title').textContent==='登录改造'"))
  await browser.evaluate('localStorage.clear()')
  await browser.send('Page.navigate', { url: pathToFileURL(join(output, 'thread-references.html')).href + '?recover=mission' })
  await wait("document.querySelector('#camp-message [data-composer-atom=mission_reference]')?.textContent.includes('发布验收 1')")
  check('unsaved Web recovery resolves its reference before any user edit', await browser.evaluate("window.__references.model.requests.some(r => r.method === 'threadReferences.resolve' && r.input.references.some(ref => ref.kind === 'mission'))"))
  await browser.evaluate(`(() => {
    const { model, catalog } = window.__references
    const id = document.querySelector('#camp-message [data-composer-atom=mission_reference]').dataset.referenceId
    catalog.splice(catalog.findIndex(item => item.id === id), 1)
    model.invalidateReferences({ referencesChanged: true })
  })()`)
  await wait("document.querySelector('#camp-message [data-composer-atom=mission_reference]')?.dataset.availability === 'unavailable'")
  check('restored references respond to Web deletion invalidation without an edit', true)
  check('no browser exceptions', browser.errors.length===0)
  await rm(join(output,'failure.json'),{force:true}); await rm(join(output,'failure.png'),{force:true})
  await writeFile(join(output,'verification.json'), JSON.stringify({checks,errors:browser.errors},null,2)+'\n')
  console.log(JSON.stringify({passed:checks.length,output}))
} catch(error) {
  await browser.capture(join(output,'failure.png')).catch(()=>{})
  await writeFile(join(output,'failure.json'),JSON.stringify({checks,errors:browser.errors,error:String(error)},null,2))
  throw error
} finally { await browser.close(); await rm(profile,{recursive:true,force:true}) }

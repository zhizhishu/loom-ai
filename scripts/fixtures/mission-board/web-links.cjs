const assert = require('node:assert/strict')
const { writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

module.exports = async ({ window, userData, waitFor, click: nativeClick, settle }) => {
  const evaluate = expression => window.webContents.executeJavaScript(expression, true)
  const click = async (selector, button = 'left') => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`)
    await settle()
    const hit = await evaluate(`(() => {
      const element=document.querySelector(${JSON.stringify(selector)}), r=element.getClientRects()[0]??element.getBoundingClientRect();
      const top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {ok:element.contains(top),bounds:r.toJSON(),top:top?.outerHTML.slice(0,300)};
    })()`)
    assert(hit.ok, `${selector}: pointer target is obscured: ${JSON.stringify(hit)}`)
    await nativeClick(selector, button)
    await settle()
  }
  const editor = '.mission-definition-dialog [contenteditable]'
  const popup = '.composer-web-link-actions'
  const target = 'https://example.com/mission-review'
  const key = async (keyCode, modifiers = []) => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await settle()
  }
  await waitFor("!!document.querySelector('.mission-board-card')", 'Mission board did not load')
  await evaluate(`(() => {
    window.missionWebOpens = []; window.missionWebCopies = [];
    window.open = (...args) => { window.missionWebOpens.push(args); return null };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.missionWebCopies.push(text) } } });
    const m = window.missionQA.items[0];
    m.descriptionContent = [{kind:'member_mention',agentId:m.memberAgentIds[0]},
      {kind:'text',text:' 项目 ${target}，保留原文。\\n[资料](https://example.com/reference) 与 [本地](docs/plan.md)。\\n第三行\\n第四行'}];
    m.description = '${target}'; window.missionQA.invalidateMissionDetails();
  })()`)
  const original = await evaluate('JSON.stringify(window.missionQA.items[0].descriptionContent)')
  await settle()
  await click('.mission-board-card .mission-card-open')
  await waitFor("!!document.querySelector('.mission-intro')", 'Mission details did not open')
  assert(await evaluate("!!document.querySelector('.mission-description a')"), await evaluate("JSON.stringify({description:document.querySelector('.mission-description')?.outerHTML,errors:window.missionQA.errors})"))
  assert.equal(await evaluate("document.querySelectorAll('.mission-description .web-reference-icon[aria-hidden=true]').length"), 2)
  assert.equal(await evaluate("document.querySelectorAll('.mission-description .message-mention-token').length"), 1)
  assert((await evaluate("document.querySelector('.mission-description').textContent")).includes('[本地](docs/plan.md)'))
  await click('.mission-description-toggle')
  await waitFor("!!document.querySelector('.mission-description.expanded')", 'Mission description did not expand')
  await click('.mission-description a')
  await waitFor('window.missionWebOpens.length===1', 'Mission description URL did not open')
  assert.equal(await evaluate('window.missionWebOpens.at(-1)[0]'), target)
  await click('.mission-description .message-mention-token')
  await waitFor("!!document.querySelector('.mission-member-profile')", 'Member reference lost its profile action')
  await key('Escape')
  await click('[aria-label="关闭使命抽屉"]')

  const clickUrl = async () => {
    const point = await evaluate(`(() => {
      const walker=document.createTreeWalker(document.querySelector('${editor}'),NodeFilter.SHOW_TEXT);
      for(let node=walker.nextNode();node;node=walker.nextNode()) {
        const i=node.textContent.indexOf('${target}'); if(i<0) continue;
        const range=document.createRange();range.setStart(node,i+3);range.setEnd(node,i+4);
        const r=range.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};
      } throw Error('Missing Mission URL');
    })()`)
    window.webContents.sendInputEvent({type:'mouseMove',...point})
    window.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1})
    window.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1})
    await waitFor(`!!document.querySelector('${popup}')`, 'Mission URL did not open its actions')
    await settle()
  }
  for (const [kind, theme, width, height] of [
    ['create', 'day', 1040, 700], ['edit', 'night', 1440, 920],
    ['create', 'night', 390, 844], ['edit', 'day', 1040, 700]
  ]) {
    await evaluate(`document.documentElement.dataset.theme='${theme}'`)
    // Open through the desktop board; then check the same modal at narrow widths.
    window.setContentSize(1440, 920)
    await settle()
    if (kind === 'create') await click('.mission-new-entry')
    else {
      await click('.mission-board-card .mission-card-open', 'right')
      await waitFor("!!document.querySelector('[role=menuitem]')", 'Mission menu did not open')
      await evaluate("[...document.querySelectorAll('[role=menuitem]')].find(n=>n.textContent.trim()==='编辑').dataset.webEdit='' ")
      await click('[data-web-edit]')
    }
    await waitFor(`!!document.querySelector('${editor}')`, 'Mission editor did not open')
    window.setContentSize(width, height)
    await settle()
    if (kind === 'create') {
      await click(editor)
      await key('A', [process.platform === 'darwin' ? 'meta' : 'control'])
      await window.webContents.insertText(`项目 ${target}。`)
      await settle()
    }
    const before = await evaluate(`document.querySelector('${editor}').textContent`)
    const writes = "window.missionQA.calls.filter(call => /^missions\\.(create|update)/.test(call.method)).length"
    const callsBefore = await evaluate(writes)
    await clickUrl()
    const geometry = await evaluate(`(() => {
      const p=document.querySelector('${popup}'),b=p.querySelector('button'),r=p.getBoundingClientRect(),br=b.getBoundingClientRect();
      return {inside:document.querySelector('.mission-definition-dialog').contains(p),clickable:b.contains(document.elementFromPoint(br.x+br.width/2,br.y+br.height/2)),
        visible:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,icon:p.querySelector('.web-reference-icon').getBoundingClientRect().width};
    })()`)
    assert.deepEqual(geometry, {inside:true,clickable:true,visible:true,icon:14}, `${kind}/${theme}: link actions are obscured`)
    writeFileSync(join(dirname(userData), `mission-web-links-${kind}-${theme}.png`), (await window.webContents.capturePage()).toPNG())
    await click(`${popup} button:last-child`)
    await waitFor(`window.missionWebCopies.at(-1)==='${target}'`, 'Mission URL copy did not run')
    const opened = await evaluate('window.missionWebOpens.length')
    await click(`${popup} button:first-child`)
    await waitFor(`window.missionWebOpens.length===${opened+1}`, 'Mission URL open did not run exactly once')
    assert.deepEqual(await evaluate('window.missionWebOpens.at(-1)'), [target, '_blank', 'noopener,noreferrer'])
    assert.equal(await evaluate(`document.querySelector('${editor}').textContent`), before)
    assert.equal(await evaluate(writes), callsBefore, 'Opening/copying a URL saved or submitted the description')
    await key('Escape')
    await waitFor(`!document.querySelector('${popup}') && !!document.querySelector('${editor}')`, 'Escape closed the Mission instead of its link actions')
    if (kind === 'edit' && theme === 'day') {
      await evaluate(`(() => {const node=document.querySelector('${editor}');node.focus();const selection=getSelection();selection.selectAllChildren(node);selection.collapseToEnd()})()`)
      await window.webContents.insertText(' 追加 https://example.com/saved')
      await settle()
      await click('.mission-editor-footer .compact-primary')
      await waitFor("!document.querySelector('.mission-definition-dialog')", 'Mission save did not finish')
      const saved = await evaluate('window.missionQA.items[0].descriptionContent')
      assert.equal(saved[0].kind, 'member_mention')
      assert(saved.some(segment => segment.text?.includes('https://example.com/saved')))
      await click('.mission-board-card .mission-card-open')
      await waitFor("document.querySelectorAll('.mission-description .web-reference-icon').length===3", 'Saved Mission URL did not render')
    } else {
      await click('.mission-definition-dialog .compact-cancel')
      await waitFor("!document.querySelector('.mission-definition-dialog')", 'Cancel did not close the Mission')
      assert.equal(await evaluate('JSON.stringify(window.missionQA.items[0].descriptionContent)'), original)
    }
  }
  assert.deepEqual(await evaluate('window.missionQA.errors'), [])
}

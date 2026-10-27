import { useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ThreadSnapshot, StructuredThreadMessageContent, MessageQuoteSnapshot, MessageQuoteSelection } from '@contracts'
import { MessageQuotes, MessageQuoteSelectionToolbar } from '../../../apps/desktop/src/renderer/src/MessageQuotes'
import { quoteProjectionDigest, revealMessageQuote } from '../../../apps/desktop/src/renderer/src/message-quote-reveal'
import { SafeMarkdown } from '../../../apps/desktop/src/renderer/src/SafeMarkdown'
import { projectQuoteBody, quoteDomOffset, readMessageQuoteSelection } from '../../../apps/desktop/src/renderer/src/message-quote-selection'
import { AgentMessageMarkdownBody, StructuredMessageBody, TruncatedStructuredMessageBody } from '../../../apps/desktop/src/renderer/src/ThreadWorkspace'
import { CurrentUserProfileContext } from '../../../apps/desktop/src/renderer/src/CurrentUserProfile'
import cases from '../../../packages/contracts/fixtures/message-quote-projection-v3.json'
import '../../../apps/desktop/src/renderer/src/styles.css'

const lineSourceIndex = cases.length
const messages = cases.map((entry, index) => ({ id: `source-${index}`, authorType: entry.authorType ?? 'agent', body: entry.source }))
messages.push({ id: `source-${lineSourceIndex}`, authorType: 'agent', body: 'Before the code.\n\n```ts\nconst first = 1;\nconst second = 2;\nconst third = 3;\nconst fourth = 4;\n```\n\nsame text\n\nsame text' })
messages.push({ id: `source-${lineSourceIndex + 1}`, authorType: 'agent', body: 'A following message.' })
const longUserSourceIndex = messages.length
const longUserText = [
  '\n**这份批复大部分是正确的架构校正。**',
  '',
  '主线仍然坚持：**保留原目标，重新构建当前动态上下文。** 🌸',
  '',
  ...Array.from({ length: 6 }, (_, index) => [
    `## ${index + 1}. 需要讨论的边界`,
    '',
    '> 提供已有证据，不要求平台先证明全部业务效果。',
    '',
    '- 复用当前 `Run` 的相关事实。',
    ''
  ].join('\n')),
  '**最后一段也应该能够引用。**'
].join('\n')
const longUserBody = `@芝士*${longUserText}`
messages.push({ id: `source-${longUserSourceIndex}`, authorType: 'user', body: longUserBody })
const errors: string[] = []
window.addEventListener('error', event => errors.push(String(event.error ?? event.message)))
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)))
let fail = false
let failRemoval = false
let latest: MessageQuoteSnapshot[] = []
let setFixtureQuotes: (quotes: MessageQuoteSnapshot[]) => void
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
async function waitFor(condition: () => boolean, reason: string) {
  const deadline = performance.now() + 2000
  while (!condition() && performance.now() < deadline) await frames()
  check(condition(), reason)
}
// macOS may give another integration window OS focus. Keep DOM focus semantics deterministic.
const focus = (element: HTMLElement) => {
  element.focus()
  if (!document.hasFocus()) element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
}
const check = (value: unknown, reason: string) => { if (!value) throw new Error(reason) }
const root = (index: number) => document.querySelector<HTMLElement>(`[data-message-quote-body="source-${index}"]`)!
function click(selector: string, step: string) {
  const button = document.querySelector<HTMLButtonElement>(selector)
  check(button, `${step}: missing ${selector}`)
  button!.click()
}
const plainBody = (index: number) => messages[index].authorType === 'user' ? messages[index].body.replace(/\r\n/gu, '\n') : undefined
const project = (index: number) => projectQuoteBody(root(index), plainBody(index))
function select(index: number, start = 0, end?: number) {
  const projection = project(index)
  const first = projection.positions.find(position => position.end > start)!
  const last = projection.positions.find(position => position.end >= (end ?? Array.from(projection.text).length))!
  const range = document.createRange()
  range.setStart(first.node, quoteDomOffset(first.node.data, start - first.start))
  range.setEnd(last.node, quoteDomOffset(last.node.data, (end ?? last.end) - last.start))
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  return range
}
function messageBody(index: number): ReactNode {
  if (index === longUserSourceIndex) return <TruncatedStructuredMessageBody
    body={longUserBody}
    content={[{ kind: 'member_mention', agentId: 'agent_a' }, { kind: 'text', text: longUserText }]}
    members={[{ agentId: 'agent_a', displayName: '芝士*' }] as ThreadSnapshot['members']}
    truncate forceExpanded={false}
  />
  const entry = cases[index]
  if (entry?.authorType === 'user') return entry.content
    ? <StructuredMessageBody body={entry.source} content={entry.content as StructuredThreadMessageContent}
      members={[{ agentId: 'agent_a', displayName: '芝士*' }] as ThreadSnapshot['members']} /> : entry.source
  if (!entry?.content) return <SafeMarkdown>{messages[index].body}</SafeMarkdown>
  const content = entry.content as StructuredThreadMessageContent
  const members = [{ agentId: 'agent_a', displayName: '芝士*' }] as ThreadSnapshot['members']
  const body = content.some(part => part.kind === 'current_user_mention')
    ? <StructuredMessageBody body={entry.source} content={content} members={members} renderLeadingCurrentUserMarkdown />
    : <AgentMessageMarkdownBody body={entry.source} content={content} members={members} onActivateMemberMention={() => undefined} />
  return entry.currentUserName ? <CurrentUserProfileContext.Provider value={{ profile: { displayName: entry.currentUserName, avatarDataUrl: null }, ready: true, error: null, reload: () => undefined, save: async profile => profile }}>{body}</CurrentUserProfileContext.Provider> : body
}
function Fixture() {
  const [quotes, setQuotes] = useState<MessageQuoteSnapshot[]>([])
  setFixtureQuotes = setQuotes
  const composer = useRef<HTMLTextAreaElement>(null)
  latest = quotes
  const add = async (selection: MessageQuoteSelection) => {
    if (fail) throw { kind: 'infrastructure_failure', code: 'CORE_REQUEST_FAILED', message: 'quote.limit_exceeded', retryable: false, generation: 1, details: {} }
    const locator = { projectionVersion: 3 as const, startScalar: selection.startScalar, endScalar: selection.endScalar, projectionDigest: await quoteProjectionDigest(project(Number(selection.messageId.split('-')[1])).text) }
    setQuotes(current => [...current, { locator, version: 1, quoteId: crypto.randomUUID(),
      source: { scope: 'camp', threadId: 'fixture', messageId: selection.messageId }, authorAtCapture: { type: 'agent', agentId: 'agent_1', displayName: '叮叮' },
      text: selection.text, format: 'plain_text', capturedAt: '2026-09-09T00:00:00Z', sourceContentDigest: 'fixture', snapshotDigest: 'fixture' }])
  }
  return <main style={{ maxWidth: 780, margin: '24px auto', padding: 20 }}>
    <div className="conversation-timeline" style={{ maxHeight: 410, overflow: 'auto' }}>
      <div className="single-chat-transcript" style={{ display: 'block', padding: 0 }}>
        {messages.map((message, index) => <section key={message.id}>
          <div className="final-copy" data-message-quote-body={message.id} data-quote-owner="thread:fixture">
            {messageBody(index)}
          </div>
          {index === 0 && <div data-quote-exclude>文件卡片 <button>复制文件</button></div>}
        </section>)}
      </div>
    </div>
    <MessageQuoteSelectionToolbar ownerKey="thread:fixture" messages={messages} onAdd={add} disabled={false} />
    <div style={{ marginTop: 12 }}><MessageQuotes history quotes={quotes} onReveal={quote => revealMessageQuote(quote, root(Number(quote.source.messageId.split('-')[1])))} /></div>
    <div className="composer-box" style={{ marginTop: 18 }}>
      <div style={{ padding: '8px 12px' }}>回复 叮叮</div>
      <MessageQuotes quotes={quotes} onEmptyFocus={() => composer.current?.focus()} onReveal={quote => revealMessageQuote(quote, root(Number(quote.source.messageId.split('-')[1])))} onMutate={async action => {
        if (failRemoval) throw new Error('quote.draft_changed')
        if (action.type === 'remove') setQuotes(latest.filter(quote => quote.quoteId !== action.quoteId))
      }} />
      <textarea ref={composer} aria-label="本次问题" defaultValue="这几处如何一起调整？" style={{ width: '100%', minHeight: 64, background: 'transparent', border: 0, padding: 12, color: 'inherit' }} />
    </div>
    <div id="excluded-test" data-message-quote-body="source-0" data-quote-owner="thread:fixture"><span>First</span><button data-quote-exclude>卡片</button><span>code.</span></div>
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
Object.assign(window, { quoteTest: {
  async run() {
    await frames()
    const longRoot = root(longUserSourceIndex)
    const longToggle = longRoot.querySelector<HTMLButtonElement>('.message-long-toggle')!
    for (const expanded of [false, true, false]) {
      if (longToggle.getAttribute('aria-expanded') !== String(expanded)) { longToggle.click(); await frames() }
      check(longToggle.getAttribute('aria-expanded') === String(expanded), 'long user message expand state')
      const excerpt = expanded ? '**最后一段也应该能够引用。**' : '主线仍然坚持：**保留原目标，重新构建当前动态上下文。** 🌸'
      const start = Array.from(longUserBody.slice(0, longUserBody.indexOf(excerpt))).length
      const range = select(longUserSourceIndex, start, start + Array.from(excerpt).length)
      range.startContainer.parentElement!.scrollIntoView({ block: 'end' })
      // Keep the chosen line inside the viewport even when its text node contains many lines.
      const viewport = document.querySelector<HTMLElement>('.conversation-timeline')!
      viewport.scrollTop += range.getBoundingClientRect().bottom - viewport.getBoundingClientRect().bottom + 45
      document.dispatchEvent(new Event('scroll')); await frames()
      const candidate = readMessageQuoteSelection(window.getSelection(), 'thread:fixture', id => messages.find(message => message.id === id))
      check(candidate?.selection.text === excerpt, `long user ${expanded ? 'expanded' : 'collapsed'} selection excludes folding announcements`)
      check(candidate.selection.bodyAtSelection === longUserBody && candidate.selection.startScalar === start,
        'long user selection keeps the original body and Unicode offsets')
      check(document.querySelector('.message-quote-selection-toolbar button'), 'long user selection exposes quote action')
      const announcement = longRoot.querySelector('.sr-only')!
      check(announcement.getAttribute('aria-live') === 'polite' && announcement.textContent?.includes(expanded ? '全文已展开' : '其余内容已收起'),
        'folding continues to announce its state to screen readers')
      // Selecting the body together with its controls is still outside the quote boundary.
      range.selectNodeContents(longRoot)
      check(!readMessageQuoteSelection(window.getSelection(), 'thread:fixture', id => messages.find(message => message.id === id)),
        'long user selection cannot include expand controls or announcements')
      window.getSelection()!.removeAllRanges(); await frames()
    }
    for (const [index, entry] of cases.entries()) {
      check(project(index).text === entry.text, `projection: ${entry.name}: ${JSON.stringify(project(index).text)}`)
      if (entry.strong) check(JSON.stringify([...root(index).querySelectorAll('strong')].map(node => node.textContent)) === JSON.stringify(entry.strong),
        `strong markup: ${entry.name}`)
      select(index)
      const candidate = readMessageQuoteSelection(window.getSelection(), 'thread:fixture', id => messages.find(message => message.id === id))
      check(candidate?.selection.text === entry.text, `selection: ${entry.name}`)
      check(candidate?.selection.bodyAtSelection === entry.source, `original body remains the revision guard: ${entry.name}`)
      for (const excerpt of entry.selections ?? []) {
        const start = Array.from(entry.text.slice(0, entry.text.indexOf(excerpt))).length
        select(index, start, start + Array.from(excerpt).length)
        const selected = readMessageQuoteSelection(window.getSelection(), 'thread:fixture', id => messages.find(message => message.id === id))
        check(selected?.selection.text === excerpt && selected.selection.startScalar === start, `reference excerpt: ${entry.name}: ${excerpt}`)
        const snapshot: MessageQuoteSnapshot = { version: 1, quoteId: 'reference-quote',
          source: { scope: 'camp', threadId: 'fixture', messageId: messages[index].id }, authorAtCapture: { type: 'user', displayName: '用户' },
          text: excerpt, format: 'plain_text', capturedAt: '2026-10-23T00:00:00Z', sourceContentDigest: 'fixture', snapshotDigest: 'fixture',
          locator: { projectionVersion: 3, startScalar: start, endScalar: start + Array.from(excerpt).length, projectionDigest: await quoteProjectionDigest(entry.text) } }
        await revealMessageQuote(snapshot, root(index), plainBody(index))
        check(root(index).dataset.quoteLocated === 'true', `reference excerpt reveal: ${entry.name}`)
      }
      if (entry.currentUserName) check(candidate?.selection.currentUserDisplayName === entry.currentUserName, 'capture only the displayed local-user token name')
      check(!readMessageQuoteSelection(window.getSelection(), 'thread:other', id => messages.find(message => message.id === id)), 'cross owner')
    }
    const range = select(0)
    const final = projectQuoteBody(root(1)).positions.at(-1)!
    range.setEnd(final.node, final.node.length)
    check(!readMessageQuoteSelection(window.getSelection(), 'thread:fixture', id => messages.find(message => message.id === id)), 'cross message')
    const excluded = document.getElementById('excluded-test')!
    range.selectNodeContents(excluded)
    check(!readMessageQuoteSelection(window.getSelection(), 'thread:fixture', id => messages.find(message => message.id === id)), 'card between endpoints')
    const placeholderIndex = cases.findIndex(entry => entry.name === 'standalone placeholder')
    root(placeholderIndex).scrollIntoView(); select(placeholderIndex); await frames()
    check(window.getSelection()!.toString() === '<UUID>', 'native selection preserves literal angle brackets')
    click('.message-quote-selection-toolbar button', 'capture literal placeholder'); await pause(30); await frames()
    const placeholderSaved: MessageQuoteSnapshot = JSON.parse(JSON.stringify(latest[0]))
    check(placeholderSaved.text === '<UUID>' && placeholderSaved.locator?.projectionVersion === 3, 'literal placeholder capture uses v3')
    await revealMessageQuote(placeholderSaved, root(placeholderIndex)); await frames()
    check(root(placeholderIndex).dataset.quoteLocated === 'true', 'literal placeholder reveals its precise source')
    const pathIndex = cases.findIndex(entry => entry.name === 'literal attachment placeholders')
    const oldPathText = '路径 ~/.rovai-server/instances//attachments//.txt'
    const oldHtml = { ...placeholderSaved,
      source: { ...placeholderSaved.source, messageId: messages[pathIndex].id }, text: oldPathText, locator: {
      projectionVersion: 2 as const, startScalar: 0, endScalar: Array.from(oldPathText).length,
      projectionDigest: await quoteProjectionDigest(oldPathText)
    } }
    const frozenOldHtml = JSON.stringify(oldHtml)
    await revealMessageQuote(oldHtml, root(pathIndex)).then(
      () => { throw new Error('changed v2 HTML projection must not highlight') },
      error => check(String(error).includes('selection_unavailable'), 'old HTML projection loses only its highlight'))
    check(JSON.stringify(oldHtml) === frozenOldHtml, 'old HTML quote remains immutable')
    setFixtureQuotes([]); window.getSelection()!.removeAllRanges(); await frames()
    check(!document.querySelector('[data-message-quote-body] script, [data-message-quote-body] img[onerror]'), 'literal HTML never creates executable elements')

    // CJK capture, serialized reuse, and old immutable snapshots share the same
    // production selection/reveal surfaces as ordinary messages.
    const cjkIndex = cases.findIndex(entry => entry.name === 'CJK original conflict reply')
    root(cjkIndex).scrollIntoView(); select(cjkIndex, 0, 5); await frames()
    check(window.getSelection()!.toString() === '有冲突。我', 'native CJK selection copies visible text without markers')
    click('.message-quote-selection-toolbar button', 'capture CJK excerpt'); await pause(30); await frames()
    const cjkSaved: MessageQuoteSnapshot = JSON.parse(JSON.stringify(latest[0]))
    check(cjkSaved.text === '有冲突。我' && cjkSaved.locator?.projectionVersion === 3, 'CJK snapshot uses the current projection')
    await revealMessageQuote(cjkSaved, root(cjkIndex)); await frames()
    check(root(cjkIndex).dataset.quoteLocated === 'true', 'CJK persisted quote returns to its exact source')
    const oldCjk: MessageQuoteSnapshot = {
      ...cjkSaved,
      text: cases[cjkIndex].source,
      locator: { projectionVersion: 1, startScalar: 0, endScalar: Array.from(cases[cjkIndex].source).length,
        projectionDigest: await quoteProjectionDigest(cases[cjkIndex].source) }
    }
    const frozenOldCjk = JSON.stringify(oldCjk)
    await revealMessageQuote(oldCjk, root(cjkIndex)).then(
      () => { throw new Error('old changed CJK projection must not highlight') },
      error => check(String(error).includes('selection_unavailable'), 'old projection loses only its highlight'))
    check(!document.querySelector('.message-quote-line-band') && JSON.stringify(oldCjk) === frozenOldCjk,
      'failed old CJK location preserves the frozen quote')
    // Exercise the actual history/draft UI failure path, retaining display and use.
    setFixtureQuotes([oldCjk]); await frames()
    root(0).scrollIntoView()
    const cjkTrigger = document.querySelector<HTMLButtonElement>('.message-quotes:not(.is-history) .message-quotes-trigger')!
    cjkTrigger.click(); await frames()
    click('.message-quote-jump', 'unavailable old CJK highlight'); await pause(30); await frames()
    check(document.querySelector('.message-quote-full-text')?.textContent === oldCjk.text
      && document.querySelector('[role="alert"]')?.textContent?.includes('引用文字仍保留'),
      'old CJK quote remains fully visible after highlight failure')
    check(latest[0].text === oldCjk.text && latest[0].format === 'plain_text', 'old CJK quote remains available to send')
    click('.message-quote-remove', 'finish CJK fixture'); await pause(30); await frames()
    for (let index = 0; index < 3; index++) {
      root(0).scrollIntoView(); select(0, index, 14 + index); await frames()
      const button = document.querySelector<HTMLButtonElement>('.message-quote-selection-toolbar button')
      check(button, 'valid selection toolbar'); button!.click(); await pause(30); await frames()
    }
    check(latest.length === 3 && document.querySelectorAll('.message-quotes-trigger').length === 2, 'one collapsed label per surface')
    for (const label of document.querySelectorAll('.message-quotes-trigger')) {
      check(label.textContent === '引用 3 段叮叮', 'count and author only')
      check(!label.textContent.includes(latest[0].text), 'no excerpt in composer or history')
    }
    check(document.querySelector('textarea')!.value === '这几处如何一起调整？', 'question preserved')
    check(document.querySelector('.message-quotes-row')!.getBoundingClientRect().height <= 36, 'compact height')
    fail = true; select(0, 0, 12); await frames()
    click('.message-quote-selection-toolbar button', 'quote error retention'); await pause(30); await frames()
    check(latest.length === 3 && !!document.querySelector('[role="alert"]') && !window.getSelection()!.isCollapsed, 'failure retains quotes and selection')
    check(document.querySelector('[role="alert"]')?.textContent?.includes('12,000'), 'contextBridge failure objects retain actionable quote errors')
    document.dispatchEvent(new Event('copy')); await frames()
    check(!document.querySelector('.message-quote-selection-toolbar'), 'copy dismisses')
    document.dispatchEvent(new Event('scroll')); await frames()
    check(!document.querySelector('.message-quote-selection-toolbar'), 'scroll does not revive copied selection')
    const trigger = document.querySelector<HTMLButtonElement>('.message-quotes:not(.is-history) .message-quotes-trigger')!
    focus(trigger); await frames()
    check(document.querySelector('.message-quote-full-text')?.textContent === latest[0].text, 'focus opens full text without a nested modal')
    check(!document.querySelector('.message-quotes-overlay'), 'no modal overlay')
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await frames()
    check(document.activeElement?.classList.contains('message-quote-jump'), 'keyboard enters rows')
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await frames()
    check(document.activeElement === trigger && !document.querySelector('.message-quotes-popover'), 'escape dismisses and restores trigger')
    trigger.click(); await frames()
    failRemoval = true
    click('.message-quote-remove', 'failed individual removal'); await pause(30); await frames()
    check(latest.length === 3 && document.querySelector('[role="alert"]')?.textContent?.includes('草稿已更新'), 'failed removal keeps quotes and reports the failure')
    failRemoval = false
    const remainingIds = latest.slice(1).map(quote => quote.quoteId)
    click('.message-quote-remove', 'successful individual removal'); await pause(30); await frames()
    check(latest.length === 2 && latest.every((quote, index) => quote.quoteId === remainingIds[index]), 'individual removal preserves remaining order')
    check(document.activeElement?.classList.contains('message-quote-jump') && trigger.textContent === '引用 2 段叮叮', 'keyboard removal focuses the remaining row and updates the count')
    check(!document.querySelector('.message-quotes-undo') && !document.body.textContent?.includes('撤销移除'), 'no undo control in the bubble or composer')
    click('.message-quote-jump', 'reveal quote source'); await pause(35); await frames()
    check(!document.querySelector('.message-quotes-popover') && root(0).dataset.quoteLocated === 'true', 'whole row jumps to source')
    const history = document.querySelector<HTMLButtonElement>('.is-history .message-quotes-trigger')!
    focus(history); history.click(); await frames()
    check(document.querySelectorAll('.message-quote-full-text').length === 2 && !document.querySelector('.message-quote-remove'), 'history full text rows are read only')
    history.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await frames()

    // Save a partial selection of two code rows, deserialize it, and use the same production locator.
    fail = false
    const codeText = projectQuoteBody(root(lineSourceIndex)).text
    const start = Array.from(codeText.slice(0, codeText.indexOf('second') + 3)).length
    const end = Array.from(codeText.slice(0, codeText.indexOf('third') + 3)).length
    root(lineSourceIndex).scrollIntoView(); select(lineSourceIndex, start, end); await frames()
    click('.message-quote-selection-toolbar button', 'capture code-line excerpt'); await pause(30); await frames()
    const saved: MessageQuoteSnapshot = JSON.parse(JSON.stringify(latest.at(-1)))
    for (const projectionVersion of [1, 2] as const) {
      await revealMessageQuote({ ...saved, locator: { ...saved.locator!, projectionVersion } }, root(lineSourceIndex))
    }
    check(root(lineSourceIndex).dataset.quoteLocated === 'true', 'unchanged v1 projection still locates exactly')
    await revealMessageQuote(saved, root(lineSourceIndex)); await frames()
    const band = root(lineSourceIndex).querySelector<HTMLElement>('.message-quote-line-band')!
    const code = root(lineSourceIndex).querySelector('pre')!
    const height = Number.parseFloat(getComputedStyle(code.querySelector('code')!).lineHeight)
    check(band?.dataset.lines === '2' && Math.abs(band.getBoundingClientRect().height - 2 * height) < 2, 'only two complete code rows')
    check(band.getBoundingClientRect().top > code.getBoundingClientRect().top + height, 'first code row untouched')
    check(Math.abs(band.getBoundingClientRect().width - code.clientWidth) < 2, 'whole row width')
    select(lineSourceIndex, start, end)
    check(readMessageQuoteSelection(window.getSelection(), 'thread:fixture', id => messages.find(message => message.id === id)), 'highlight decorations preserve native selection')
    document.querySelector<HTMLElement>('main')!.style.maxWidth = '520px'; await pause(60)
    check(Math.abs(root(lineSourceIndex).querySelector('.message-quote-line-band')!.getBoundingClientRect().width - code.clientWidth) < 2, 'line bands track reflow')
    document.querySelector<HTMLElement>('main')!.style.maxWidth = '780px'; await frames()
    const duplicateText = 'same text'
    const secondStart = Array.from(codeText.slice(0, codeText.lastIndexOf(duplicateText))).length
    const repeated: MessageQuoteSnapshot = { ...saved, text: duplicateText, locator: { ...saved.locator!, startScalar: secondStart, endScalar: secondStart + duplicateText.length } }
    await revealMessageQuote(repeated, root(lineSourceIndex)); await frames()
    check(root(lineSourceIndex).querySelector('p:last-child .message-quote-line-band'), 'saved offsets distinguish repeated excerpts')
    const legacy = { ...repeated, locator: undefined }
    await revealMessageQuote(legacy, root(lineSourceIndex)).then(() => { throw new Error('ambiguous legacy must fail') }, error => check(String(error).includes('selection_unavailable'), 'ambiguous excerpt fails closed'))
    check(!document.querySelector('.message-quote-line-band'), 'ambiguous text receives no false highlight')
    const multiText = Array.from(codeText).slice(0, end).join('')
    await revealMessageQuote({ ...saved, text: multiText, locator: { ...saved.locator!, startScalar: 0 } }, root(lineSourceIndex)); await frames()
    check(root(lineSourceIndex).querySelector('p .message-quote-line-band') && root(lineSourceIndex).querySelector('pre .message-quote-line-band'), 'multi-block selection covers involved blocks')
    // A changed source cannot reuse valid-looking offsets at another occurrence.
    await revealMessageQuote({ ...saved, locator: { ...saved.locator!, projectionDigest: 'changed' } }, root(lineSourceIndex)).then(() => { throw new Error('stale anchor must fail') }, error => check(String(error).includes('selection_unavailable'), 'stale digest'))
    check(!document.querySelector('.message-quote-line-band'), 'stale source is unhighlighted')
    trigger.scrollIntoView(); await frames()
    // Single Chat has a scrolling viewport outside its non-scrolling transcript.
    const viewport = document.querySelector<HTMLElement>('.conversation-timeline')!
    viewport.className = 'single-chat-viewport'
    viewport.scrollIntoView({ block: 'start', behavior: 'instant' }); await frames()
    viewport.scrollTop = 0
    await revealMessageQuote(saved, root(lineSourceIndex))
    // The shared corpus can change scroll distance. Wait for the visible result,
    // since smooth scrolling is not complete when revealMessageQuote resolves.
    await waitFor(() => {
      const located = root(lineSourceIndex).querySelector('.message-quote-line-band')!.getBoundingClientRect()
      const visible = viewport.getBoundingClientRect()
      return viewport.scrollTop > 0 && located.top >= Math.max(0, visible.top)
        && located.bottom <= Math.min(window.innerHeight, visible.bottom)
    }, 'private jump scrolls the actual viewport into view')
    const visible = viewport.getBoundingClientRect()
    const clippedRange = select(lineSourceIndex, start + 1, end)
    viewport.scrollTop += clippedRange.getBoundingClientRect().top - (visible.bottom + 20)
    document.dispatchEvent(new Event('scroll')); await frames()
    check(!document.querySelector('.message-quote-selection-toolbar'), 'clipped private selection has no floating toolbar outside the viewport')
    viewport.className = 'conversation-timeline'
    trigger.click(); await frames()
    while (latest.length) {
      click('.message-quote-remove', 'clear remaining quotes'); await pause(30); await frames()
    }
    await pause(250)
    check(!document.querySelector('.message-quotes') && !document.querySelector('.message-quotes-popover'), 'last removal closes the bubble and leaves no empty metadata row')
    check(document.activeElement === document.querySelector('textarea') && document.querySelector('textarea')!.value === '这几处如何一起调整？', 'last keyboard removal returns to the unchanged question')
    // A new drag starts a fresh selection, including an excerpt dismissed earlier.
    // Selectionchange alone must not revive the old selection after copy/focus.
    root(lineSourceIndex).scrollIntoView()
    root(lineSourceIndex).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 }))
    select(lineSourceIndex, start, end)
    root(lineSourceIndex).dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0 }))
    await frames()
    click('.message-quote-selection-toolbar button', 'add excerpt after clearing'); await pause(30); await frames()
    check(latest.length === 1 && !document.querySelector('.message-quotes-popover'), 'new selection after clearing starts with a collapsed label')
    check(!errors.length, errors.join('\n'))
    return { ok: true, projectionCases: cases.length, verified: ['long user collapsed and expanded selection', 'shared CJK projection and strong markup', 'CJK and literal HTML selection with persisted v3 quotes', 'immutable v1/v2 quotes after highlight failure', 'unchanged v1/v2 exact anchors', 'Unicode and code', 'cross message and cards', 'multiple compact quotes', 'failure retention', 'stale copy selection', 'hover and keyboard disclosure', 'full row navigation and direct removal', 'last removal closes and returns focus', 'persisted code-line anchors', 'duplicate and stale source', 'reflow and multi-block highlights'] }
  },
  async linePreview() {
    await revealMessageQuote(latest.at(-1)!, root(lineSourceIndex)); await frames()
  },
  async cjkPreview() {
    window.getSelection()?.removeAllRanges()
    root(cases.findIndex(entry => entry.name === 'CJK original conflict reply')).scrollIntoView({ block: 'start', behavior: 'instant' })
    await frames()
  },
  async literalPreview() {
    window.getSelection()?.removeAllRanges()
    root(cases.findIndex(entry => entry.name === 'literal attachment placeholders')).scrollIntoView({ block: 'start', behavior: 'instant' })
    await frames()
  },
  hoverTarget() {
    ;(document.activeElement as HTMLElement)?.blur()
    const rect = document.querySelector('.message-quotes:not(.is-history) .message-quotes-trigger')!.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  },
  hoverState() {
    const popup = document.querySelector('.message-quotes-popover')
    const rect = popup?.getBoundingClientRect()
    return { open: !!popup, triggerFocused: document.activeElement?.classList.contains('message-quotes-trigger'), x: rect ? rect.x + 20 : 0, y: rect ? rect.y + 20 : 0 }
  },
  async lastLineTarget() {
    const paragraph = root(lineSourceIndex).querySelector<HTMLElement>('p:last-child')!
    paragraph.scrollIntoView({ block: 'center' }); await frames()
    const rect = paragraph.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  },
  lastLineState() {
    const selection = window.getSelection()
    const candidate = readMessageQuoteSelection(selection, 'thread:fixture', id => messages.find(message => message.id === id))
    return {
      text: selection?.toString().trim(),
      toolbar: !!document.querySelector('.message-quote-selection-toolbar'),
      candidate: !!candidate
    }
  },
  async clearSelection() {
    window.getSelection()?.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange')); await frames()
  },
  async theme(value: string) {
    document.documentElement.dataset.theme = value
    await frames()
    await Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished))
    await frames()
    return document.documentElement.scrollWidth <= innerWidth
  }
} })

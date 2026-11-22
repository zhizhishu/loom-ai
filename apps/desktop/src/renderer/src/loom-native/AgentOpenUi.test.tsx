import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentMarkdown } from './AgentMarkdown'
import { AgentOpenUi } from './AgentOpenUi'
import { AgentOpenUiProvider, resolveOpenUiAction } from './AgentOpenUiButton'

const render = (text: string, isStreaming = false): string => renderToStaticMarkup(createElement(AgentMarkdown, { text, isStreaming }))
const card = (source: string): string => `\`\`\`openui\n${source}\n\`\`\``
const withHost = (text: string): string => renderToStaticMarkup(
  createElement(AgentOpenUiProvider, { value: { send: async () => true } }, createElement(AgentMarkdown, { text })),
)

/** Mikka `components/workspace/agent-openui-button.tsx` + `apps/mobile/components/OpenUI.tsx`, as LOOM draws them. */
describe('OpenUI cards in the native conversation', () => {
  it('draws an OpenUI fence as cards instead of a source block', () => {
    const html = render(card('root = Stack([TextContent("你好"), BeCard("标题", [TextContent("内容")], "说明")])'))
    expect(html).toContain('class="ln-openui"')
    expect(html).toContain('你好')
    expect(html).toContain('<h3>标题</h3>')
    expect(html).toContain('说明')
    expect(html).not.toContain('data-language="openui"')
  })

  it('keeps the source when the fence does not parse, as a reply still arriving', () => {
    const html = render(card('root = Stack([TextContent("没写完'))
    expect(html).toContain('data-language="openui"')
    expect(html).toContain('没写完')
    expect(html).not.toContain('class="ln-openui"')
  })

  it('keeps the words a reply wrote before its cards', () => {
    const html = render(card('北京和香港各挑几处。\n\nroot = Stack([TextContent("北京")])'))
    expect(html).toContain('ln-openui-prose')
    expect(html).toContain('北京和香港各挑几处。')
    expect(html).toContain('北京')
  })

  it('leaves other fences alone', () => {
    const html = render('```ts\nconst a = 1\n```')
    expect(html).toContain('data-language="ts"')
    expect(html).not.toContain('class="ln-openui"')
  })

  it('draws a button it cannot honour as disabled, and says which capability is missing', () => {
    const html = render(card('root = BeButton("继续", "继续了解")'))
    expect(html).toContain('ln-openui-button-face')
    expect(html).toContain('disabled')
    expect(html).toContain('当前会话没有可发送消息的宿主。')
  })

  it('enables the button once the conversation offers the send path', () => {
    const html = withHost(card('root = BeButton("继续", "继续了解")'))
    expect(html).toContain('继续')
    expect(html).not.toContain('disabled')
    expect(html).not.toContain('ln-openui-button-reason')
  })

  it('refuses an action the native chat cannot run, with its type in the reason', () => {
    const html = withHost(card('root = BeButton("整理", {type:"run"})'))
    expect(html).toContain('disabled')
    expect(html).toContain('run')
    expect(html).toContain('没有对应能力')
  })

  it('prints the raw id of a task or run chip, as upstream does without citation chips', () => {
    const html = render(card('root = InlineText(["派给 ", RunChip("12345678-1234-1234-1234-123456789ABC"), " 处理"])'))
    expect(html).toContain('ln-openui-inline')
    expect(html).toContain('12345678-1234-1234-1234-123456789abc')
    expect(html).toContain('处理')
  })

  it('opens a cited page outside the app', () => {
    const html = render(card('root = InlineText(["见 ", SourceChip("https://example.test/pr/1", "PR")])'))
    expect(html).toContain('href="https://example.test/pr/1"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).toContain('>PR<')
  })

  it('draws no follow-ups in a chat, as the web library does (R-12)', () => {
    const html = render(card('root = Stack([TextContent("前言"), BeFollowUps([{label:"起草回复", prompt:"帮我起草回复"}])])'))
    expect(html).toContain('前言')
    expect(html).not.toContain('起草回复')
  })

  it('draws a card it has no drawing for as its words', () => {
    const html = render(card('root = BeStat("完成", 3, "项")'))
    expect(html).toContain('ln-openui-plain')
    expect(html).toContain('完成')
    expect(html).not.toContain('ln-openui-button-face')
  })

  it('draws nothing for a reply that is not OpenUI at all', () => {
    expect(renderToStaticMarkup(createElement(AgentOpenUi, { text: '普通的 **Markdown** 回复' }))).toBe('')
  })
})

describe('an OpenUI button click', () => {
  it('sends the words an action carries', () => {
    expect(resolveOpenUiAction('继续了解', '继续')).toEqual({ text: '继续了解' })
    expect(resolveOpenUiAction({ type: 'to_assistant', text: '起草回复' }, '起草')).toEqual({ text: '起草回复' })
    expect(resolveOpenUiAction({ steps: [{ type: 'to_assistant', prompt: '看看今天的日程' }] }, '日程')).toEqual({ text: '看看今天的日程' })
  })

  it('falls back to the label when the action carries no words', () => {
    expect(resolveOpenUiAction(null, '继续')).toEqual({ text: '继续' })
    expect(resolveOpenUiAction('', '继续')).toEqual({ reason: '这个按钮没有可发送的内容。' })
    expect(resolveOpenUiAction(null, '  ')).toEqual({ reason: '这个按钮没有可执行的动作。' })
  })

  it('refuses a step plan the conversation cannot carry', () => {
    expect(resolveOpenUiAction({ steps: [{ type: 'run', refType: 'mutation' }] }, '整理')).toEqual({ reason: '这个按钮要执行的动作（run）在当前会话没有对应能力。' })
    expect(resolveOpenUiAction({ steps: [{ type: 'custom_action' }] }, '整理')).toEqual({ reason: '这个按钮要执行的动作（custom_action）在当前会话没有对应能力。' })
    expect(resolveOpenUiAction({ steps: [{ type: 'to_assistant', text: 'a' }, { type: 'to_assistant', text: 'b' }] }, '继续')).toEqual({ reason: '这个按钮要依次执行多个动作，当前会话只能发送一条消息。' })
  })
})

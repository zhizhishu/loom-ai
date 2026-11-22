import { describe, expect, it } from 'vitest'
import { inlineMarkdown, isComponent, isImageQuery, isOpenUI, openUIRootCount, openUIText, parseOpenUI, splitOpenUI, type Component } from './openui-lang'

/**
 * Mikka `lib/openui-lang.test.ts`, moved over with the reader. Upstream's last case compares `isImageQuery` against
 * the server's `agentImageQuery` zod schema; LOOM has no image lookup to compare with, so that rule is asserted
 * directly on the same inputs instead of being dropped.
 */

const WELCOME = 'root = Stack([TextContent("你好，Alex！我是你的 Coordinator。"), BeQuestions("刚开始使用", [{id:"start", title:"想先从哪里开始？", options:[{value:"a", label:"整理收件箱"}, {value:"b", label:"看看今天的日程"}], allowCustom:true}])])'

describe('OpenUI language', () => {
  it('reads a welcome card: text and a question with options', () => {
    const root = parseOpenUI(WELCOME) as Component
    expect(root.name).toBe('Stack')
    const [text, questions] = root.props.children as Component[]
    expect(text.props.text).toBe('你好，Alex！我是你的 Coordinator。')
    expect(questions.name).toBe('BeQuestions')
    expect(questions.props.questions).toEqual([{ id: 'start', title: '想先从哪里开始？', options: [{ value: 'a', label: '整理收件箱' }, { value: 'b', label: '看看今天的日程' }], allowCustom: true }])
  })

  it('follows references to other statements, escapes and numbers', () => {
    const root = parseOpenUI('root = Stack([intro, more])\nintro = TextContent("第一行\\n第二行 \\"引号\\"")\nmore = BeStat("完成", 3, "项", 0)') as Component
    const [intro, more] = root.props.children as Component[]
    expect(intro.props.text).toBe('第一行\n第二行 "引号"')
    expect(more.name).toBe('BeStat')
    expect(more.args).toEqual(['完成', 3, '项', 0])
  })

  it('an approval and follow-ups get their named props', () => {
    const root = parseOpenUI('root = Stack([BeApproval("改到周五", "把评审挪到周五 10:00", "日程冲突"), BeFollowUps([{label:"起草回复", prompt:"帮我起草回复"}])])') as Component
    const [approval, follow] = root.props.children as Component[]
    expect(approval.props).toEqual({ title: '改到周五', description: '把评审挪到周五 10:00', context: '日程冲突' })
    expect(follow.props.items).toEqual([{ label: '起草回复', prompt: '帮我起草回复' }])
  })

  it('not OpenUI, or broken OpenUI, is null', () => {
    expect(parseOpenUI('普通的 **Markdown** 回复')).toBeNull()
    expect(parseOpenUI('root = Stack([TextContent("没写完')).toBeNull()
    expect(parseOpenUI('root = {kind:"component"}')).toBeNull()
    expect(parseOpenUI('root = {kind:"component",name:"TextContent",props:{},args:"invalid"}')).toBeNull()
  })

  it("chips become the chat's citation tokens and links", () => {
    const root = parseOpenUI('root = InlineText(["派给 ", RunChip("12345678-1234-1234-1234-123456789abc"), " 做 ", TaskChip("12345678-1234-1234-1234-123456789abd"), "，见 ", SourceChip("https://x.dev/pr/1", "PR")])')
    expect(isComponent(root ?? undefined)).toBe(true)
    expect(inlineMarkdown(root ?? undefined)).toBe('派给 [[run:12345678-1234-1234-1234-123456789abc]] 做 [[issue:12345678-1234-1234-1234-123456789abd]]，见 [PR](https://x.dev/pr/1)')
  })

  it('text of a card: words, question, options; no ids or style words', () => {
    expect(openUIText(parseOpenUI(WELCOME) ?? undefined)).toBe('你好，Alex！我是你的 Coordinator。\n想先从哪里开始？\n- 整理收件箱\n- 看看今天的日程')
    expect(openUIText(parseOpenUI('root = Stack([ShadcnBadge("待评审", "secondary"), BeTodoList("计划", [{id:"one", title:"整理需求"}], "suggestion")])') ?? undefined)).toBe('待评审\n计划\n整理需求')
  })

  it('image cards get their named props; their text leaves out the search words', () => {
    const root = parseOpenUI('root = BeCardGrid([a, b])\na = BeImageCard("故宫", "Forbidden City Beijing", "明清皇宫", ["历史"], "怎么逛故宫？")\nb = BeImage("Beijing hutong", "北京胡同", "南锣鼓巷")') as Component
    const [card, figure] = root.props.children as Component[]
    expect(card.props).toEqual({ title: '故宫', query: 'Forbidden City Beijing', description: '明清皇宫', tags: ['历史'], prompt: '怎么逛故宫？' })
    expect(figure.props).toEqual({ query: 'Beijing hutong', alt: '北京胡同', caption: '南锣鼓巷' })
    expect(openUIText(root)).toBe('故宫\n明清皇宫\n南锣鼓巷')
  })

  it("image search words: the server's rule, asserted here on the same inputs", () => {
    const accepted = ['Forbidden City', '  故宫  ', 'x'.repeat(160), 'http:/ok']
    const refused = ['a', ' a ', 'x'.repeat(161), 'line\nbreak', '<b>', 'see https://a.b', 'HTTP://A.B']
    for (const query of accepted) expect(isImageQuery(query), JSON.stringify(query)).toBe(true)
    for (const query of refused) expect(isImageQuery(query), JSON.stringify(query)).toBe(false)
  })

  it('a reply that opens with prose and then assigns root is a card, with its prose kept', () => {
    const text = '北京和香港各挑几处。\n\nroot = Stack([TextContent("北京")])'
    expect(splitOpenUI(text)).toEqual({ prose: '北京和香港各挑几处。', source: 'root = Stack([TextContent("北京")])' })
    expect(isOpenUI(text)).toBe(true)
    expect(parseOpenUI(text)).toBeTruthy()
    expect(isOpenUI('先看例子：\n```\nroot = Stack([])\n```')).toBe(false)
    expect(isOpenUI('the root = cause')).toBe(false)
  })

  it('counts assigned roots across merged messages without treating quoted text as a new card', () => {
    const first = 'root = TextContent("root = BeApproval()")'
    const second = 'root = BeButton("Continue", "continue")'
    expect(openUIRootCount(first)).toBe(1)
    expect(openUIRootCount([first, second].join('\n'))).toBe(2)
    expect((parseOpenUI([first, second].join('\n')) as Component).name).toBe('BeButton')
    expect(openUIRootCount('ordinary prose mentioning root = ')).toBe(0)
  })
})

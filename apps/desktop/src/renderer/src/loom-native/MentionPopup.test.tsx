import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MentionPopup } from './MentionPopup'
import type { MentionMember } from './mention-completion'

const members: MentionMember[] = [
  { agentId: 'a1', displayName: 'Hanzi' },
  { agentId: 'a2', displayName: 'Muwa' }
]

const render = (options: readonly MentionMember[], activeIndex = 0): string =>
  renderToStaticMarkup(createElement(MentionPopup, { id: 'ln-mention-options', options, activeIndex, onPick: () => {} }))

describe('MentionPopup lists the current thread’s candidates', () => {
  it('renders one option per member and marks the highlighted one', () => {
    const html = render(members, 1)
    expect(html).toContain('role="listbox"')
    expect(html).toContain('aria-label="选择要 @ 的助手"')
    expect(html).toContain('@Hanzi')
    expect(html).toContain('@Muwa')
    expect(html.match(/role="option"/g)).toHaveLength(2)
    expect(html).toContain('id="ln-mention-options-option-1"')
    expect(html).toContain('aria-selected="true"')
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
    expect(html).toContain('is-active')
  })

  it('renders nothing when no member matches', () => {
    expect(render([])).toBe('')
  })
})

describe('MentionPopup picks without stealing the caret', () => {
  const popup = MentionPopup({ id: 'ln-mention-options', options: members, activeIndex: 0, onPick: () => {} }) as unknown as {
    props: { children: { props: Record<string, unknown> }[] }
  }

  it('calls onPick with the clicked member', () => {
    const onPick = vi.fn()
    const element = MentionPopup({ id: 'ln-mention-options', options: members, activeIndex: 0, onPick })
    const options = (element as unknown as { props: { children: { props: { onClick(): void } }[] } }).props.children
    options[1].props.onClick()
    expect(onPick).toHaveBeenCalledWith(members[1])
  })

  it('keeps the textarea focused by preventing the mousedown default', () => {
    const preventDefault = vi.fn()
    const first = popup.props.children[0] as unknown as { props: { onMouseDown(event: { preventDefault(): void }): void } }
    first.props.onMouseDown({ preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(1)
  })
})

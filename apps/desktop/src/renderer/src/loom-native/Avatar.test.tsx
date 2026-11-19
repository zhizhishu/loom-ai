import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentProfile } from './types'
import { MemberAvatar } from '../MemberAvatar'
import { Avatar, LoomMark } from './Avatar'

// MemberAvatar owns every personal avatar. This file only proves two things:
// the brand mark is the approved bundled image, and Avatar still forwards the
// member's own avatar fields instead of substituting the brand image.
vi.mock('../MemberAvatar', async () => {
  const { createElement: h } = await import('react')
  return {
    MemberAvatar: vi.fn((props: { displayName: string }) =>
      h('span', { className: 'member-avatar', 'data-mock': 'member-avatar' }, props.displayName))
  }
})

const mockedMemberAvatar = vi.mocked(MemberAvatar)
const agent = { agentId: 'a-1', displayName: 'Muwa', avatarRef: 'builtin:muwa' } as unknown as AgentProfile

describe('LoomMark brand identity', () => {
  it('renders the approved bundled image as a 30px non-draggable LOOM mark', () => {
    const html = renderToStaticMarkup(createElement(LoomMark))
    expect(html).toContain('<img')
    expect(html).toContain('class="ln-brand-mark"')
    expect(html).toMatch(/src="[^"]*(?:loom-brand-user-approved-256\.webp|data:image\/webp;base64,)/)
    expect(html).toContain('alt="LOOM"')
    expect(html).toContain('width="30"')
    expect(html).toContain('height="30"')
    expect(html).toContain('display:block')
    expect(html).toContain('object-fit:contain')
    expect(html).toContain('border-radius:8px')
    expect(html).not.toContain('draggable="true"')
  })

  it('drops the old robot drawing and its label instead of keeping both', () => {
    const html = renderToStaticMarkup(createElement(LoomMark))
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('编织机器人')
    expect(html).not.toContain('#edf2ff')
  })
})

describe('Avatar personal identity', () => {
  it('forwards the member avatar fields and never shows the brand image', () => {
    mockedMemberAvatar.mockClear()
    const html = renderToStaticMarkup(createElement(Avatar, { agent, size: 34 }))
    expect(mockedMemberAvatar).toHaveBeenCalledTimes(1)
    expect(mockedMemberAvatar.mock.calls[0][0]).toMatchObject({
      agentId: 'a-1', avatarRef: 'builtin:muwa', displayName: 'Muwa', size: 'workspace', decorative: true
    })
    expect(html).not.toContain('loom-brand-user-approved')
    expect(html).toContain('--ln-avatar-size:34px')
  })

  it('keeps the initials fallback when no member is selected', () => {
    mockedMemberAvatar.mockClear()
    const named = renderToStaticMarkup(createElement(Avatar, { agent: null, name: 'Muwa' }))
    expect(named).toContain('class="ln-avatar-fallback"')
    expect(named).toContain('aria-hidden="true"')
    expect(named).toContain('>M<')
    expect(renderToStaticMarkup(createElement(Avatar, {}))).toContain('>L<')
    expect(mockedMemberAvatar).not.toHaveBeenCalled()
  })
})

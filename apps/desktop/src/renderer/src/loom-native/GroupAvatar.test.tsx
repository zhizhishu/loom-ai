import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentProfile } from './types'
import { MemberAvatar } from '../MemberAvatar'
import { GroupAvatar, STACKED_MEMBERS } from './GroupAvatar'

vi.mock('../MemberAvatar', async () => {
  const { createElement: h } = await import('react')
  return {
    MemberAvatar: vi.fn((props: { agentId: string }) =>
      h('span', { className: 'member-avatar', 'data-agent': props.agentId }))
  }
})

const mockedMemberAvatar = vi.mocked(MemberAvatar)
const member = (agentId: string): AgentProfile => ({
  agentId, displayName: agentId, avatarRef: `builtin:${agentId}`
} as unknown as AgentProfile)

// 群头像照抄 Mikka `components/nav/group-avatar.tsx:22,29-35`：成员头像横向重叠、
// 最多三个；没有成员才退回标题首字母（旧 bug：「0.9.5 发版群」读成「0」）。
describe('group avatar stacks members instead of the title letter', () => {
  it('stacks at most three member avatars', () => {
    mockedMemberAvatar.mockClear()
    const html = renderToStaticMarkup(createElement(GroupAvatar, {
      title: '发版群', members: [member('a1'), member('a2'), member('a3'), member('a4'), member('a5')]
    }))
    expect(STACKED_MEMBERS).toBe(3)
    expect(mockedMemberAvatar).toHaveBeenCalledTimes(3)
    expect(mockedMemberAvatar.mock.calls.map(call => call[0].agentId)).toEqual(['a1', 'a2', 'a3'])
    expect(html).toContain('ln-group-avatar')
    expect(html).not.toContain('ln-avatar-fallback')
  })

  it('falls back to the title letter when the roster is empty or still unread', () => {
    mockedMemberAvatar.mockClear()
    for (const members of [undefined, null, [] as AgentProfile[]]) {
      const html = renderToStaticMarkup(createElement(GroupAvatar, { title: '发版群', members }))
      expect(html).toContain('ln-avatar-fallback')
      expect(html).toContain('>发<')
      expect(html).not.toContain('ln-group-avatar')
    }
    // 挂一行绝不因为画头像去读成员名单：这里一次成员头像请求都没有。
    expect(mockedMemberAvatar).not.toHaveBeenCalled()
  })

  it('keeps a single member visible as that member instead of inventing a stack', () => {
    mockedMemberAvatar.mockClear()
    const html = renderToStaticMarkup(createElement(GroupAvatar, { title: '发版群', members: [member('a1')] }))
    expect(html).toContain('ln-group-avatar')
    expect(mockedMemberAvatar).toHaveBeenCalledTimes(1)
  })
})

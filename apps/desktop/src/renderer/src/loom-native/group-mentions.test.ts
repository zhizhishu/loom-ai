import { describe, expect, it } from 'vitest'
import { mentionRecipient, mentionsIn } from './group-mentions'

// 规则照抄 Mikka `lib/group-mentions.ts:4-9`：正文里出现 `@<成员名>`（小写全包含）
// 就算点名，返回顺序按成员顺序。
const hanzi = { agentId: 'a-1', displayName: 'Hanzi' }
const muwa = { agentId: 'a-2', displayName: 'Muwa' }
const members = [hanzi, muwa]

describe('group mentions in a plain text body', () => {
  it('names the member the body writes as @name', () => {
    expect(mentionsIn('请 @Hanzi 看一下这个接口', members)).toEqual(['a-1'])
    expect(mentionsIn('@Muwa 先出一版', members)).toEqual(['a-2'])
  })

  it('matches case-insensitively, like the reference', () => {
    expect(mentionsIn('@hanzi 在吗', members)).toEqual(['a-1'])
    expect(mentionsIn('@HANZI 在吗', members)).toEqual(['a-1'])
  })

  it('returns every named member in member order, not in written order', () => {
    expect(mentionsIn('@Muwa 和 @Hanzi 都看一下', members)).toEqual(['a-1', 'a-2'])
  })

  it('does not treat a name without @ as a mention', () => {
    expect(mentionsIn('Hanzi 看一下', members)).toEqual([])
    expect(mentionRecipient('Hanzi 看一下', members)).toBeUndefined()
  })

  it('does not match a partial name', () => {
    expect(mentionsIn('@Han', members)).toEqual([])
  })

  it('never turns a blank name into a wildcard mention', () => {
    expect(mentionsIn('@ 随便说点什么', [{ agentId: 'a-3', displayName: '   ' }])).toEqual([])
    expect(mentionsIn('@', [{ agentId: 'a-3', displayName: '' }])).toEqual([])
  })

  it('addresses the first named member and leaves an unmentioned message to the server', () => {
    expect(mentionRecipient('@Muwa 和 @Hanzi 都看一下', members)).toBe('a-2')
    // 没 @ 就不指定收件人：谁该答由服务端判断（Mikka group-chat-view.tsx:56）。
    expect(mentionRecipient('大家看看这个报错', members)).toBeUndefined()
  })
})

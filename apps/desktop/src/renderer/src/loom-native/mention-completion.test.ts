import { describe, expect, it } from 'vitest'
import { MAX_MENTION_OPTIONS, completeMention, filterMentionMembers, liveMentionQuery, mentionOptions, mentionQuery, mentionScope, type MentionMember } from './mention-completion'

const members: MentionMember[] = [
  { agentId: 'a1', displayName: 'Hanzi' },
  { agentId: 'a2', displayName: 'Muwa' },
  { agentId: 'a3', displayName: 'Review Bot' }
]

// 上游 rakazo `packages/core/src/composer/composer-mentions.ts:112-159,170-198,220-233`：
// 光标处认 token、按名字排候选、补全只替换 token 本身。
describe('mentionQuery reads the @ token under the caret', () => {
  it('finds the token and its typed query', () => {
    expect(mentionQuery('你好 @Mu', 6, 6, members)).toEqual({ start: 3, end: 6, query: 'Mu' })
  })

  it('accepts Chinese prose without a space before the @', () => {
    expect(mentionQuery('请@Ha', 4, 4, members)).toEqual({ start: 1, end: 4, query: 'Ha' })
  })

  it('ignores an @ glued to a word', () => {
    expect(mentionQuery('foo@bar', 7, 7, members)).toBeNull()
    expect(mentionQuery('没有 @ 号', 6, 6, members)).toBeNull()
  })

  it('has no query while the user has a selection or the caret is out of range', () => {
    expect(mentionQuery('@Mu', 1, 3, members)).toBeNull()
    expect(mentionQuery('@Mu', 9, 9, members)).toBeNull()
  })

  it('covers the whole known name when the caret sits inside it', () => {
    expect(mentionQuery('@Hanzi 你好', 4, 4, members)).toEqual({ start: 0, end: 6, query: 'Han' })
  })

  it('stops at the first non-name character for an unknown name', () => {
    expect(mentionQuery('@Muw 在吗', 4, 4, members)).toEqual({ start: 0, end: 4, query: 'Muw' })
  })

  // 已知全名里可以有空格（`Review Bot`）：光标停在第一个词里时右边界要盖住整个全名，
  // 否则补全只换掉前半截，留下后半截变成 `@Review Bot Bot 在吗`。
  it('covers a known full name that contains spaces', () => {
    const query = mentionQuery('@Review Bot 在吗', 3, 3, members)
    expect(query).toEqual({ start: 0, end: 11, query: 'Re' })
    expect(completeMention('@Review Bot 在吗', query!, members[2]))
      .toEqual({ text: '@Review Bot 在吗', caret: 12 })
  })

  it('does not eat spaces or later words when the rest is not the known full name', () => {
    expect(mentionQuery('@Review 看一下', 3, 3, members)).toEqual({ start: 0, end: 7, query: 'Re' })
    expect(mentionQuery('@Re view Bot 在吗', 3, 3, members)).toEqual({ start: 0, end: 3, query: 'Re' })
    expect(mentionQuery('@Re 在吗', 3, 3, members)).toEqual({ start: 0, end: 3, query: 'Re' })
    // 没有对应全名时，正文一字不动。
    expect(completeMention('@Re 在吗', mentionQuery('@Re 在吗', 3, 3, members)!, members[2]))
      .toEqual({ text: '@Review Bot 在吗', caret: 12 })
  })
})

describe('filterMentionMembers orders candidates the way the picker does', () => {
  it('keeps the given order for an empty query', () => {
    expect(filterMentionMembers(members, '').map(member => member.agentId)).toEqual(['a1', 'a2', 'a3'])
  })

  it('matches a word prefix before a word inside the name', () => {
    expect(filterMentionMembers(members, 'mu').map(member => member.agentId)).toEqual(['a2'])
    expect(filterMentionMembers(members, 'bot').map(member => member.agentId)).toEqual(['a3'])
    expect(filterMentionMembers(members, 'view').map(member => member.agentId)).toEqual(['a3'])
  })

  it('requires every query word to match', () => {
    expect(filterMentionMembers(members, 'review mu')).toEqual([])
    expect(filterMentionMembers(members, 'review bot').map(member => member.agentId)).toEqual(['a3'])
  })

  it('ranks a prefix hit above a middle hit and keeps ties in order', () => {
    const roster: MentionMember[] = [
      { agentId: 'b', displayName: 'Abb' },
      { agentId: 'a', displayName: 'Bobby' },
      { agentId: 'c', displayName: 'Bia' }
    ]
    expect(filterMentionMembers(roster, 'b').map(member => member.agentId)).toEqual(['a', 'c', 'b'])
  })

  it('never invents synthetic targets: an unknown name matches nobody', () => {
    expect(filterMentionMembers(members, 'everyone')).toEqual([])
    expect(filterMentionMembers(members, 'all')).toEqual([])
  })
})

describe('mentionOptions caps the list at ten', () => {
  it('keeps at most MAX_MENTION_OPTIONS candidates', () => {
    const roster = Array.from({ length: 14 }, (_, index) => ({ agentId: `a${index}`, displayName: `Bot ${index}` }))
    const options = mentionOptions(roster, '')
    expect(MAX_MENTION_OPTIONS).toBe(10)
    expect(options).toHaveLength(10)
    expect(options[0].agentId).toBe('a0')
  })
})

describe('completeMention replaces only the token', () => {
  it('keeps the text before and after and puts the caret after the name', () => {
    expect(completeMention('你好 @Mu 在吗', { start: 3, end: 6, query: 'Mu' }, members[1]))
      .toEqual({ text: '你好 @Muwa 在吗', caret: 9 })
  })

  it('adds the trailing space when the mention ends the draft', () => {
    expect(completeMention('@Mu', { start: 0, end: 3, query: 'Mu' }, members[1]))
      .toEqual({ text: '@Muwa ', caret: 6 })
  })

  it('replaces a full name that the caret was inside', () => {
    expect(completeMention('@Hanzi 你好', { start: 0, end: 6, query: 'Han' }, members[1]))
      .toEqual({ text: '@Muwa 你好', caret: 6 })
  })
})

// 弹层是上一帧的状态：Ctrl/Cmd+A 全选、光标离开 token、草稿被改写之后都不能再拦 Tab/Enter，
// 也不能拿旧区间去替换正文。
describe('liveMentionQuery only trusts a query the caret is still inside', () => {
  const query = { start: 3, end: 6, query: 'Mu' }

  it('keeps the displayed query while the collapsed caret is inside it', () => {
    expect(liveMentionQuery(query, '你好 @Mu', 4, 4)).toEqual(query)
    expect(liveMentionQuery(query, '你好 @Mu', 6, 6)).toEqual(query)
  })

  it('drops the query once the selection is not collapsed (Ctrl/Cmd+A)', () => {
    expect(liveMentionQuery(query, '你好 @Mu', 0, 6)).toBeNull()
    expect(liveMentionQuery(query, '你好 @Mu', 4, 6)).toBeNull()
  })

  it('drops the query when the caret left the token or the text changed', () => {
    expect(liveMentionQuery(query, '你好 @Mu', 1, 1)).toBeNull()
    expect(liveMentionQuery(query, '你好 @Mu', 8, 8)).toBeNull()
    expect(liveMentionQuery(query, '你好 @Xy', 6, 6)).toBeNull()
    expect(liveMentionQuery(query, '你好 Mu', 6, 6)).toBeNull()
    expect(liveMentionQuery(query, '你好 @Mu', -1, -1)).toBeNull()
  })

  it('has nothing to trust without a displayed query', () => {
    expect(liveMentionQuery(null, '你好 @Mu', 6, 6)).toBeNull()
  })
})

// 只在群聊、且会话条目与快照指向同一个会话时开候选：单聊 / 快照缺失 / 不同步都不查也不弹。
describe('mentionScope gates completion to a synced group', () => {
  const snapshot = { thread: { id: 'th-1' } }

  it('opens for a group whose item and snapshot agree', () => {
    expect(mentionScope({ threadId: 'th-1' }, snapshot, true)).toBe('th-1')
  })

  it('stays shut in a one-to-one conversation', () => {
    expect(mentionScope({ threadId: 'th-1' }, snapshot, false)).toBeNull()
  })

  it('stays shut when the snapshot belongs to another conversation', () => {
    expect(mentionScope({ threadId: 'th-2' }, snapshot, true)).toBeNull()
    expect(mentionScope({ threadId: null }, snapshot, true)).toBeNull()
  })

  it('stays shut before the item or the snapshot exists', () => {
    expect(mentionScope({ threadId: 'th-1' }, null, true)).toBeNull()
    expect(mentionScope(null, snapshot, true)).toBeNull()
  })
})

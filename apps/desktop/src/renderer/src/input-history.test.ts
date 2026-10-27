import { describe, expect, it, vi } from 'vitest'
import type { StructuredThreadMessageContent } from '@contracts'
import { composerDocumentFromText } from './composer-document'
import { InputHistoryNavigation, isInputHistoryKey, singleInputHistory, threadInputHistory } from './input-history'

const message = (body: string, content: StructuredThreadMessageContent = []) => ({
  authorType: 'user' as const, authorId: 'local_user', withdrawn: false, body, content
})

describe('input history content extraction', () => {
  it('keeps only editable current-user content in source order, preserving whitespace and independent Atoms', () => {
    const content: StructuredThreadMessageContent = [
      { kind: 'text', text: '  code\n' },
      { kind: 'member_mention', agentId: 'member' },
      { kind: 'all_members_mention' },
      { kind: 'skill_mention', skillId: 'skill', nameAtSend: 'my-skill' },
      { kind: 'thread_reference', threadId: 'rvcamp_01k87hrb9yfay8vvr14d2pf2db', titleAtSend: '发布标题' },
      { kind: 'mission_reference', missionId: 'rvm_019abcde123470008000000000000001', titleAtSend: '使命' },
      { kind: 'current_user_mention', userId: 'local_user' },
      { kind: 'external_quote', senderDisplayName: 'External', body: 'external quote', attachmentSummaries: [], contentDigest: 'sha256:fixture' }
    ]
    const inputs = [message('fallback\n'), message('derived display text', content), message('same'), message('same'),
      message('  \n\t'), message('do not revive this quote', content.slice(6)),
      { ...message('withdrawn'), withdrawn: true },
      { ...message('other user'), authorId: 'other' },
      { ...message('agent output'), authorType: 'agent' as const },
      { ...message('external'), authorType: 'external_principal' as const }]
    const recalled = threadInputHistory(inputs)
    expect(recalled).toEqual([
      composerDocumentFromText('fallback\n'), { version: 2, segments: [
        { kind: 'text', text: '  code\n' },
        { kind: 'atom', atom: { type: 'member', agentId: 'member' } },
        { kind: 'atom', atom: { type: 'all_members' } },
        { kind: 'atom', atom: { type: 'skill', skillId: 'skill', nameAtSend: 'my-skill' } },
        { kind: 'atom', atom: { type: 'thread_reference', threadId: 'rvcamp_01k87hrb9yfay8vvr14d2pf2db', labelFallback: '发布标题' } },
        { kind: 'atom', atom: { type: 'mission_reference', missionId: 'rvm_019abcde123470008000000000000001', labelFallback: '使命' } }
      ] }, composerDocumentFromText('same'), composerDocumentFromText('same')
    ])
    inputs[0].body = 'changed'
    content[0] = { kind: 'text', text: 'changed' }
    const member = content[1]
    if (member.kind === 'member_mention') member.agentId = 'changed'
    expect(recalled[0]).toEqual(composerDocumentFromText('fallback\n'))
    expect(recalled[1].segments[0]).toEqual({ kind: 'text', text: '  code\n' })
    expect(recalled[1].segments[1]).toEqual({ kind: 'atom', atom: { type: 'member', agentId: 'member' } })
    expect(threadInputHistory([message('', [{ kind: 'all_members_mention' }])])).toHaveLength(1)
  })

  it('appends existing pending order after formal user messages without collapsing equal submissions', () => {
    expect(singleInputHistory([
      message('  first\n'), { ...message('output'), authorType: 'agent' },
      { ...message('other'), authorId: 'other' }, message(' \t'), message('same')
    ], [{ body: 'same' }, { body: ' \n' }, { body: 'last queued\n' }]))
      .toEqual(['  first\n', 'same', 'same', 'last queued\n'])
  })
})

describe('input history browsing round', () => {
  it('does not capture an empty history, and reads again only on the next first Up', () => {
    let items: string[] = []
    const read = vi.fn(() => [...items])
    const capture = vi.fn(() => 'draft')
    const preview = vi.fn()
    const restore = vi.fn()
    const nav = new InputHistoryNavigation(read, { capture, preview, restore })
    expect(nav.newer()).toBe(false)
    expect(nav.cancel()).toBe(false)
    expect(read).not.toHaveBeenCalled()
    expect(nav.older()).toBe(false)
    expect(nav.browsing).toBe(false)
    expect(capture).not.toHaveBeenCalled()
    items = ['oldest', 'newest']
    expect(nav.older()).toBe(true)
    expect(preview).toHaveBeenLastCalledWith('newest', 'start')
    nav.older()
    expect(preview).toHaveBeenLastCalledWith('oldest', 'start')
    expect(nav.older()).toBe(false)
    expect(read).toHaveBeenCalledTimes(2)
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('freezes a round across message edits, withdrawal, loading older messages and new submissions', () => {
    let messages = [message('older'), message('latest')]
    const read = vi.fn(() => threadInputHistory(messages))
    const original = { content: composerDocumentFromText('draft'), selection: 0 }
    const capture = vi.fn(() => original)
    const preview = vi.fn()
    const restore = vi.fn()
    const nav = new InputHistoryNavigation(read, { capture, preview, restore })
    nav.older()
    messages[0].body = 'changed'
    messages[1].withdrawn = true
    messages = [message('loaded later'), ...messages, message('new submission')]
    nav.older()
    expect(preview).toHaveBeenLastCalledWith(composerDocumentFromText('older'), 'start')
    expect(nav.older()).toBe(false)
    nav.newer()
    expect(preview).toHaveBeenLastCalledWith(composerDocumentFromText('latest'), 'end')
    nav.newer()
    expect(restore).toHaveBeenCalledWith(original)
    expect(nav.browsing).toBe(false)
    expect(read).toHaveBeenCalledTimes(1)
    nav.older()
    expect(preview).toHaveBeenLastCalledWith(composerDocumentFromText('new submission'), 'start')
    nav.older()
    expect(preview).toHaveBeenLastCalledWith(composerDocumentFromText('changed'), 'start')
    nav.older()
    expect(preview).toHaveBeenLastCalledWith(composerDocumentFromText('loaded later'), 'start')
    expect(read).toHaveBeenCalledTimes(2)
    nav.cancel()
    expect(restore).toHaveBeenCalledTimes(2)
  })

  it('keeps published/cancelled pending content only for the current round, with no identity mapping', () => {
    let messages = [message('formal')]
    let pending = [{ body: 'queued' }, { body: 'cancelled later' }]
    const preview = vi.fn()
    const nav = new InputHistoryNavigation(() => singleInputHistory(messages, pending), {
      capture: () => '', preview, restore: vi.fn()
    })
    nav.older()
    messages = [...messages, message('published body')]
    pending = []
    nav.older()
    expect(preview).toHaveBeenLastCalledWith('queued', 'start')
    nav.newer()
    expect(preview).toHaveBeenLastCalledWith('cancelled later', 'end')
    nav.cancel()
    nav.older()
    expect(preview).toHaveBeenLastCalledWith('published body', 'start')
    nav.older()
    expect(preview).toHaveBeenLastCalledWith('formal', 'start')
    expect(nav.older()).toBe(false)
  })

  it('releases the round on adoption, so edits, sends and target changes cannot restore an old draft', () => {
    let source = ['A history']
    let draft = 'A draft'
    const preview = vi.fn()
    const restore = vi.fn()
    const nav = new InputHistoryNavigation(() => [...source], { capture: () => draft, preview, restore })
    nav.older()
    nav.adopt()
    expect(nav.browsing).toBe(false)
    expect(nav.cancel()).toBe(false)
    expect(restore).not.toHaveBeenCalled()
    source = ['B history']
    draft = 'B draft'
    nav.older()
    expect(preview).toHaveBeenLastCalledWith('B history', 'start')
    nav.cancel()
    expect(restore).toHaveBeenCalledExactlyOnceWith('B draft')
  })

  it('leaves IME, modifiers and events already handled by menus alone', () => {
    const event = { key: 'ArrowUp', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false }
    expect(isInputHistoryKey(event)).toBe(true)
    for (const field of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'isComposing', 'defaultPrevented']) {
      expect(isInputHistoryKey({ ...event, [field]: true })).toBe(false)
    }
    expect(isInputHistoryKey({ ...event, keyCode: 229 })).toBe(false)
    expect(isInputHistoryKey({ ...event, key: 'Enter' })).toBe(false)
  })
})

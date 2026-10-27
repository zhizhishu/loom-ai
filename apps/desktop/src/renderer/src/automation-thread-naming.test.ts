import { expect, it } from 'vitest'
import { automationTitlePreview, defaultThreadNaming } from './automation-thread-naming'
import { defaultDraft, draftFingerprint, draftFromAutomation } from './automation-workspace-model'
import type { AutomationView } from '@contracts'

it('previews the Core title contract with fixed formats, all checkbox/position choices and Unicode', () => {
  const at = new Date(2026, 9, 26, 15, 4, 9)
  const naming = defaultThreadNaming()
  expect(automationTitlePreview('周报', '', naming, at)).toBe('周报 · 2026-10-26 15:04')
  for (const [includeDate, includeTime, stamp] of [
    [true, true, '2026-10-26 15:04'], [true, false, '2026-10-26'],
    [false, true, '15:04'], [false, false, '']
  ] as const) {
    for (const position of ['prefix', 'suffix'] as const) {
      expect(automationTitlePreview('周报', '', { ...naming, includeDate, includeTime, position }, at))
        .toBe(!stamp ? '周报' : position === 'prefix' ? `${stamp} · 周报` : `周报 · ${stamp}`)
    }
  }
  for (const [hour, time] of [[0, '00:01'], [12, '12:01']] as const) {
    expect(automationTitlePreview('周报', '', { ...naming, includeDate: false }, new Date(2026, 0, 1, hour, 1))).toBe(`周报 · ${time}`)
  }
  expect(automationTitlePreview('  周报\n 总结 ', '', { ...naming, includeDate: false, includeTime: false }, at)).toBe('周报 总结')
  expect(automationTitlePreview('', '🌸'.repeat(21), naming, at)).toBe(`${'🌸'.repeat(20)}… · 2026-10-26 15:04`)
  expect(automationTitlePreview('🌸'.repeat(80), '', naming, at)).toBe(`${'🌸'.repeat(80)} · 2026-10-26 15:04`)
})

it('keeps naming edits in the autosave fingerprint and restores saved choices', () => {
  const draft = defaultDraft('member')
  const changed = { ...draft, threadNaming: { ...draft.threadNaming, includeTime: false, position: 'prefix' as const } }
  expect(draftFingerprint(changed)).not.toBe(draftFingerprint(draft))
  const restored = draftFromAutomation({ ...changed, automationId: 'task', version: 2 } as AutomationView)
  expect(restored.threadNaming).toEqual(changed.threadNaming)
  expect(defaultDraft('another').threadNaming).toEqual(defaultThreadNaming())
  const { threadNaming: _legacyAbsent, ...oldReceipt } = { ...changed, automationId: 'task', version: 1 }
  expect(draftFromAutomation(oldReceipt as AutomationView).threadNaming).toEqual(defaultThreadNaming())
})

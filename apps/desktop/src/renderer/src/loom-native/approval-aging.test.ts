import { describe, expect, it } from 'vitest'
import { approvalAging, approvalAgingText, formatWaitingAge } from './approval-aging'

describe('approval aging', () => {
  it('formats waiting time without inventing expiry', () => {
    expect(formatWaitingAge(12_000)).toBe('12 秒')
    expect(formatWaitingAge(5 * 60_000)).toBe('5 分钟')
    expect(formatWaitingAge(65 * 60_000)).toBe('1 小时 5 分钟')
  })
  it('marks only genuinely old requests as aged', () => {
    const now = Date.parse('2026-11-26T00:10:00Z')
    expect(approvalAging('2026-11-26T00:09:00Z', now)).toMatchObject({ aged: false, label: '1 分钟' })
    expect(approvalAging('2026-11-26T00:04:59Z', now).aged).toBe(true)
    expect(approvalAgingText(approvalAging('2026-11-26T00:04:59Z', now))).toContain('等待较久')
  })
  it('ignores missing or invalid timestamps', () => {
    expect(approvalAging(null, 1).label).toBeNull()
    expect(approvalAging('not-a-date', 1).label).toBeNull()
  })
})

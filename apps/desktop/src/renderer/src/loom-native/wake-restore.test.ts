import { expect, it } from 'vitest'
import type { AgentProfile, ThreadSnapshot } from './types'
import { wakeRestoreLines } from './wake-restore'

const agent = { agentId: 'a', displayName: 'Ada' } as AgentProfile
const delivery = {
  id: 'd', recipientAgentId: 'a', status: 'waiting', wakeState: 'wake_waiting', createdAt: '2026-11-26T00:00:00Z'
} as ThreadSnapshot['messageDeliveries'][number]

it('restores the newest persisted wake fact per recipient without hiding an active run', () => {
  const snapshot = {
    messageDeliveries: [
      { ...delivery, id: 'old', wakeState: 'wake_exhausted', createdAt: '2026-11-26T00:00:00Z' },
      { ...delivery, id: 'new', wakeState: 'wake_start_unconfirmed', createdAt: '2026-11-26T00:01:00Z' }
    ],
    agentRuns: []
  } as Pick<ThreadSnapshot, 'messageDeliveries' | 'agentRuns'>
  expect(wakeRestoreLines(snapshot, [agent])).toEqual([
    { recipientAgentId: 'a', state: 'wake_start_unconfirmed', working: false, label: 'Ada启动未确认，系统会继续恢复' }
  ])
  const running = { ...snapshot, agentRuns: [{ agentId: 'a', status: 'running' } as ThreadSnapshot['agentRuns'][number]] }
  expect(wakeRestoreLines(running, [agent])).toEqual([])
})

it('keeps waiting, failed, and exhausted wake states visible and honest', () => {
  for (const [state, working, text] of [
    ['wake_waiting', true, 'Ada正在恢复处理'],
    ['wake_failed', false, 'Ada启动失败'],
    ['wake_exhausted', false, 'Ada多次唤醒未成功']
  ] as const) {
    const [line] = wakeRestoreLines({ messageDeliveries: [{ ...delivery, wakeState: state }], agentRuns: [] }, [agent])
    expect(line?.working).toBe(working)
    expect(line?.label).toBe(text)
  }
})

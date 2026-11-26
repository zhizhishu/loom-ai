import type { AgentProfile, ThreadSnapshot } from './types'

export type WakeRestoreLine = {
  recipientAgentId: string
  state: 'wake_waiting' | 'wake_start_unconfirmed' | 'wake_exhausted' | 'wake_failed'
  working: boolean
  label: string
}

/**
 * Mikka 250d2451 `lib/coordinator/chat-state.ts`：重启后不能让持久化的等待输入静默消失。
 * LOOM Core 已投影每条 Delivery 的 wake facts；这里只把最新事实翻译成人话。真正运行
 * 优先于 wake 行；同一人多条等待输入只显示最新一条，旧行的恢复结论不叠加刷屏。
 */
export function wakeRestoreLines(
  snapshot: Pick<ThreadSnapshot, 'messageDeliveries' | 'agentRuns'>,
  agents: readonly AgentProfile[]
): WakeRestoreLine[] {
  const active = new Set(snapshot.agentRuns
    .filter(run => ['running', 'queued', 'waiting'].includes(run.status))
    .map(run => run.agentId))
  const latest = new Map<string, ThreadSnapshot['messageDeliveries'][number]>()
  for (const delivery of snapshot.messageDeliveries) {
    if (delivery.status !== 'waiting' || !delivery.wakeState || active.has(delivery.recipientAgentId)) continue
    const prior = latest.get(delivery.recipientAgentId)
    if (!prior || prior.createdAt.localeCompare(delivery.createdAt) <= 0) latest.set(delivery.recipientAgentId, delivery)
  }
  return [...latest.values()].map(delivery => {
    const name = agents.find(agent => agent.agentId === delivery.recipientAgentId)?.displayName || '助手'
    const state = delivery.wakeState as WakeRestoreLine['state']
    const label = state === 'wake_waiting'
      ? `${name}正在恢复处理`
      : state === 'wake_exhausted'
        ? `${name}多次唤醒未成功`
        : state === 'wake_failed'
          ? `${name}启动失败`
          : `${name}启动未确认，系统会继续恢复`
    return { recipientAgentId: delivery.recipientAgentId, state, working: state === 'wake_waiting', label }
  })
}

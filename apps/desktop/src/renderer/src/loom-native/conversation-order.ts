import type { ConversationItem } from './types'

/**
 * 会话列表排序：置顶优先 → 置顶顺序 → 最新活动时间倒序 → 名字字典序。
 * 照抄 Mikka 侧栏同一把比较器（`components/nav/bot-list.tsx:46-52`），
 * 让两个人扫同一份列表看到同一个顺序。
 *
 * 注意事实边界：LOOM 的 `ConversationItem` 目前没有 Core 下发的
 * `pinned` / `pinOrder`（Mikka 的这两列在 `GroupSummary`，`lib/group-messages.ts:130`），
 * 也没有「协调者」这种钉顶行。所以今天这一层只对显式带上这两个字段的行走作用，
 * 其余行按「时间 → 名字」排；等 Core 暴露置顶事实后不需要改这里的排序。
 */
export function compareConversationItems(left: ConversationItem, right: ConversationItem): number {
  const pinnedLeft = left.pinned === true
  const pinnedRight = right.pinned === true
  const byPinned = Number(pinnedRight) - Number(pinnedLeft)
  if (byPinned !== 0) return byPinned
  if (pinnedLeft && pinnedRight && typeof left.pinOrder === 'number' && typeof right.pinOrder === 'number') {
    const byPinOrder = left.pinOrder - right.pinOrder
    if (byPinOrder !== 0) return byPinOrder
  }
  const byTime = (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '')
  if (byTime !== 0) return byTime
  return left.title.localeCompare(right.title)
}

export function sortConversationItems(items: readonly ConversationItem[]): ConversationItem[] {
  return [...items].sort(compareConversationItems)
}

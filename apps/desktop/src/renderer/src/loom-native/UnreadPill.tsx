import { Icon } from './icons'

/** Mikka `lib/unread.ts` 的 formatCount：100 条以上只露 99+。 */
export function formatUnreadCount(count: number): string {
  return count > 99 ? '99+' : String(count)
}

export type BottomUnreadEntry = {
  key: string
  kind: string
  message?: { authorType: string }
}

/**
 * Mikka `arrivedSinceLeftBottom` 的 LOOM 适配：上游按 position 数别人发来的消息；
 * 这里聊天流已经按时间排好，用离开底部时的条目 key 数后面别人发来的消息；
 * 群成员行/运行事件行不算“消息”，仍由原有↓回到最新按钮承接。
 */
export function bottomUnreadCount(entries: readonly BottomUnreadEntry[], leftBottomKey: string | null): number {
  if (!leftBottomKey) return 0
  const anchor = entries.findIndex(entry => entry.key === leftBottomKey)
  if (anchor < 0) return 0
  return entries.slice(anchor + 1).filter(entry =>
    entry.kind === 'message' && entry.message?.authorType !== 'user' && entry.message?.authorType !== 'external_principal'
  ).length
}

/** Mikka `components/chat/unread-pill.tsx`：主体跳最新，× 只关闭当前提示。 */
export function UnreadPill({ count, onJump, onDismiss }: { count: number; onJump(): void; onDismiss(): void }) {
  const display = formatUnreadCount(count)
  return <div className="ln-unread-pill" data-unread-pill="down">
    <div className="ln-unread-pill-group">
      <button type="button" className="ln-unread-pill-jump" aria-label={`回到最新，${display} 条新消息`} onClick={onJump}>
        <Icon name="down" size={14}/><span>{display} 条新消息</span>
      </button>
      <button type="button" className="ln-unread-pill-dismiss" aria-label="关闭新消息提示" title="关闭" onClick={onDismiss}>
        <Icon name="close" size={13}/>
      </button>
    </div>
  </div>
}

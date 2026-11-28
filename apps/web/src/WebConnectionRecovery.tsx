import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ConsoleClient } from './client'
import { useUiText } from '../../desktop/src/renderer/src/interface-language'

/** One Web-wide reconnect notice; the business page and its drafts stay mounted
 * and interactive. Only the transport gate keeps new submissions back, so the
 * page needs no modal, focus trap or capture-phase shortcut blocking. */
export function WebConnectionRecovery({ transport, enabled, onNotice, children }: {
  transport: ConsoleClient
  enabled: boolean
  onNotice(message: string): void
  children: ReactNode
}) {
  const t = useUiText()
  const subscribe = useCallback((listener: () => void) => transport.onConnectionChanged(listener), [transport])
  const snapshot = useCallback(() => transport.connectionState, [transport])
  const connection = useSyncExternalStore(subscribe, snapshot)
  const subscribePending = useCallback((listener: () => void) => transport.onPendingCommandsChanged(listener), [transport])
  const pendingSnapshot = useCallback(() => transport.pendingCommandCount, [transport])
  const pending = useSyncExternalStore(subscribePending, pendingSnapshot)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const active = useRef({ busy })
  active.current = { busy }
  const blocked = enabled && (connection !== 'live' || busy)

  // Live hides the bar and forgets the previous failure/dismissal, so the next
  // disconnect is announced again.
  useEffect(() => { if (!blocked) { setFailed(false); setDismissed(false) } }, [blocked])
  // A dismissed bar must not hide a freshly recorded unfinished operation: the
  // × only hides the notice, never the recovery transaction behind it.
  const previousPending = useRef(pending)
  useEffect(() => {
    const recorded = pending > previousPending.current
    previousPending.current = pending
    if (recorded) setDismissed(false)
  }, [pending])

  const recover = async (): Promise<void> => {
    if (active.current.busy) return
    active.current.busy = true
    setBusy(true); setFailed(false)
    try {
      const needsFile = await transport.retryPending()
      if (needsFile) onNotice(t('连接已恢复。未完成的上传需要重新选择原文件。'))
    } catch { if (transport.authenticated) setFailed(true) }
    finally { active.current.busy = false; setBusy(false) }
  }

  const variant = busy ? 'recovering' : failed ? 'failed' : 'reconnecting'
  const title = busy ? t('正在恢复连接…') : failed ? t('仍无法连接服务')
    : pending > 0 ? t('有 {0} 个操作等待核对', pending) : t('正在重新连接')
  const description = busy ? t('正在恢复未完成的操作，请稍候。')
    : failed ? t('请确认服务已启动后重试，页面和草稿会继续保留。')
    : pending > 0 ? t('恢复连接后只核对原提交，不会重复发送。页面和草稿已保留。')
    : t('网络恢复后会自动续传，页面和草稿已保留。')

  return <>
    {children}
    {blocked && !dismissed && <div className="web-live-bar" data-variant={variant}
      role="status" aria-live="polite" aria-atomic="true" aria-busy={busy}>
      <div className="web-live-bar-copy">
        <strong className="web-live-bar-title">{title}</strong>
        <span className="web-live-bar-description">{description}</span>
      </div>
      {(pending > 0 || busy || failed) && <button type="button" className="web-live-bar-retry"
        disabled={busy} onClick={() => { void recover() }}>
        {busy && <span className="web-login-spinner" aria-hidden="true" />}
        {t(busy ? '正在恢复…' : '恢复连接并重试')}
      </button>}
      <button type="button" className="web-live-bar-dismiss" aria-label={t('关闭重连提示')}
        onClick={() => setDismissed(true)}>×</button>
    </div>}
  </>
}

/** Mikka pending-actions 的逐项老化提示：LOOM 审批合同没有 expiresAt，
 * 所以这里只做展示，不把本地等待时长伪造成 Core 的过期事实。 */
export const APPROVAL_AGED_AFTER_MS = 5 * 60_000

export interface ApprovalAging {
  waitingMs: number | null
  label: string | null
  aged: boolean
}

export function approvalWaitingMs(requestedAt: string, nowMs: number): number | null {
  const requested = Date.parse(requestedAt)
  if (!Number.isFinite(requested)) return null
  return Math.max(0, nowMs - requested)
}

export function formatWaitingAge(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分钟`
}

export function approvalAging(requestedAt: string | null, nowMs: number, agedAfterMs = APPROVAL_AGED_AFTER_MS): ApprovalAging {
  if (!requestedAt) return { waitingMs: null, label: null, aged: false }
  const waitingMs = approvalWaitingMs(requestedAt, nowMs)
  if (waitingMs === null) return { waitingMs: null, label: null, aged: false }
  return { waitingMs, label: formatWaitingAge(waitingMs), aged: waitingMs >= agedAfterMs }
}

export function approvalAgingText(aging: ApprovalAging): string | null {
  if (aging.label === null) return null
  return aging.aged ? `已等待 ${aging.label} · 等待较久，不需要可拒绝` : `已等待 ${aging.label}`
}

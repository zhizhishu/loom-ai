import type { ExecutionNodeCli, ExecutionNodePairing, ExecutionNodeRecord } from '@contracts'
import { uiAttribute } from './interface-language'

export type NodeListState = {
  nodes: ExecutionNodeRecord[] | null
  readError: string | null
  refreshError: string | null
}

export function applyListResult(
  current: NodeListState,
  result: { ok: true; nodes: ExecutionNodeRecord[] } | { ok: false; code: string }
): NodeListState {
  if (result.ok) return { nodes: result.nodes, readError: null, refreshError: null }
  if (current.nodes) return { nodes: current.nodes, readError: null, refreshError: result.code }
  return { nodes: null, readError: result.code, refreshError: null }
}

export function isLocalNode(node: ExecutionNodeRecord): boolean {
  return node.role === 'local'
}

export function remoteNodes(nodes: ExecutionNodeRecord[]): ExecutionNodeRecord[] {
  return nodes.filter(node => !isLocalNode(node))
}

export function relativeAge(iso: string | null, now: number): string | null {
  if (!iso) return null
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return null
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return uiAttribute('{0} 秒前', seconds)
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return uiAttribute('{0} 分钟前', minutes)
  const hours = Math.round(minutes / 60)
  if (hours < 48) return uiAttribute('{0} 小时前', hours)
  return uiAttribute('{0} 天前', Math.round(hours / 24))
}

export function roleLabel(node: ExecutionNodeRecord): string {
  return isLocalNode(node) ? uiAttribute('本机') : uiAttribute('拨入')
}

export function statusLabel(node: ExecutionNodeRecord): { kind: 'ok' | 'stale'; text: string } {
  if (node.revokedAt) return { kind: 'stale', text: uiAttribute('已作废') }
  if (node.status === 'online') return { kind: 'ok', text: uiAttribute('在线') }
  if (isLocalNode(node)) return { kind: 'stale', text: uiAttribute('离线') }
  return { kind: 'stale', text: uiAttribute('离线 · 上次见到') }
}

export function nodeMeta(node: ExecutionNodeRecord, now: number): string {
  const os = node.os || uiAttribute('未知')
  const arch = node.arch || uiAttribute('未知')
  const age = relativeAge(node.lastHeartbeat, now)
  const beat = node.status === 'online'
    ? (age ? uiAttribute('心跳 {0}', age) : uiAttribute('还没有心跳'))
    : (age ? uiAttribute('上次心跳 {0}', age) : uiAttribute('还没有心跳'))
  const transport = isLocalNode(node) ? uiAttribute('进程内') : uiAttribute('出站 WebSocket')
  return `${os} · ${arch} · ${beat} · ${transport}`
}

export function runSummary(node: ExecutionNodeRecord): string {
  const count = node.activeRunCount
  const detail = node.activeRuns.map(run => run.runtime).filter(Boolean).join('、')
  if (node.status !== 'online' && count > 0) {
    return detail
      ? uiAttribute('在途 {0} · {1} · 不改派', count, detail)
      : uiAttribute('在途 {0} · 不改派', count)
  }
  if (count > 0 && detail) return uiAttribute('在跑 {0} · {1}', count, detail)
  return uiAttribute('在跑 {0}', count)
}

export type CliTone = 'ok' | 'stale' | 'warn'

export function cliPresentation(node: ExecutionNodeRecord, cli: ExecutionNodeCli, now: number): { tone: CliTone; status: string } {
  if (cli.availability === 'last_seen') {
    const age = relativeAge(cli.reportedAt, now)
    return { tone: 'stale', status: age ? uiAttribute('上次见到 {0}', age) : uiAttribute('上次见到') }
  }
  if (cli.availability === 'path_missing') return { tone: 'warn', status: uiAttribute('路径缺失') }
  if (cli.availability === 'reported') return { tone: 'ok', status: uiAttribute('路径有效') }
  if (node.status !== 'online') return { tone: 'stale', status: uiAttribute('上次见到') }
  return cli.pathPresent
    ? { tone: 'ok', status: uiAttribute('路径有效') }
    : { tone: 'warn', status: uiAttribute('路径缺失') }
}

export function offlineRunBanner(nodes: ExecutionNodeRecord[]): string | null {
  const names = nodes
    .filter(node => !isLocalNode(node) && node.status !== 'online' && node.activeRunCount > 0 && !node.revokedAt)
    .map(node => node.displayName)
  if (names.length === 0) return null
  return uiAttribute('{0} 已离线。在途的 Run 留在那台机器上，不改派。新 Run 不会派给它。上次上报的 CLI 还留着。', names.join('、'))
}

export function pairingCommand(ticket: ExecutionNodePairing): string {
  return [
    'loom-node --data-dir ~/.loom-node \\',
    `  --server ${ticket.connectUrl} \\`,
    `  --pair-code ${ticket.pairingCode}`
  ].join('\n')
}

export function formatRemaining(deadlineMs: number, now: number): string {
  const total = Math.max(0, Math.ceil((deadlineMs - now) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function pairLifetimeCopy(deadlineMs: number, now: number): string {
  if (deadlineMs <= now) return uiAttribute('配对码已过期。关闭后重新打开会生成新的。')
  return uiAttribute('剩余 {0}，用过即废。这里不显示节点令牌。', formatRemaining(deadlineMs, now))
}

/** Idle nodes confirm immediately. A node with active runs must match its display name. */
export function canConfirmRevoke(node: ExecutionNodeRecord, typed: string): boolean {
  if (isLocalNode(node) || !node.revocable || node.revokedAt) return false
  if (node.activeRunCount > 0) return typed === node.displayName
  return true
}

export function listFailureDetail(code: string): string {
  if (code === 'nodes_unavailable') return uiAttribute('这份 Core 的节点服务还没开。请先在远程连接里开启 Web 服务，然后重新读取。')
  if (code === 'session_required') return uiAttribute('登录已失效，请重新登录后再读取节点。')
  return uiAttribute('请重新读取。失败时若已有上次成功的列表，会保留那份列表。')
}

export function pairFailure(code: string): string {
  if (code === 'node_channel_requires_loopback') return uiAttribute('节点通道只接受本机回环上的配对。')
  if (code === 'nodes_unavailable') return uiAttribute('这份 Core 的节点服务还没开。请先在远程连接里开启 Web 服务，然后重新读取。')
  if (code === 'session_required') return uiAttribute('登录已失效，请重新登录后再读取节点。')
  return uiAttribute('配对码暂时无法生成，请重试。')
}

export function revokeFailure(code: string): string {
  if (code === 'node_not_revocable') return uiAttribute('本机节点不能作废。')
  if (code === 'node_not_found') return uiAttribute('没有找到这台节点。')
  return uiAttribute('作废未完成，请重试。')
}

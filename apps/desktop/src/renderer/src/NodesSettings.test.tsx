import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ExecutionNodeRecord } from '@contracts'
import { NodesSettings, NodesSettingsBody } from './NodesSettings'
import type { NodeApi } from './nodes-api'
import {
  applyListResult,
  canConfirmRevoke,
  pairingCommand,
  type NodeListState
} from './nodes-model'

const now = Date.parse('2026-11-01T10:18:04.000Z')

function node(overrides: Partial<ExecutionNodeRecord> & Pick<ExecutionNodeRecord, 'nodeId' | 'displayName' | 'role'>): ExecutionNodeRecord {
  return {
    revocable: overrides.role !== 'local',
    status: 'online',
    os: 'Linux',
    arch: 'x64',
    pairedAt: '2026-11-01T09:00:00.000Z',
    revokedAt: null,
    lastHeartbeat: '2026-11-01T10:18:02.000Z',
    activeRunCount: 0,
    activeRuns: [],
    clis: [],
    ...overrides
  }
}

const local = node({
  nodeId: 'node_local',
  displayName: 'loom-a',
  role: 'local',
  revocable: false,
  clis: [{ adapterKind: 'claude-code-cli', path: '/home/loom/.npm-global/bin/claude', version: '2.1.316', pathPresent: true, reportedAt: '2026-11-01T10:00:00.000Z' }]
})

const remote = node({
  nodeId: 'node_desk',
  displayName: 'desk-b',
  role: 'remote',
  os: 'macOS',
  arch: 'arm64',
  lastHeartbeat: '2026-11-01T10:18:00.000Z',
  activeRunCount: 1,
  activeRuns: [{ runId: 'run_1', attempt: 1, runtime: 'codex-cli', status: 'running', ackedSeq: 4 }],
  clis: [{ adapterKind: 'codex-cli', path: '/Users/loom/.npm-global/bin/codex', version: '0.166.0', pathPresent: true, reportedAt: '2026-11-01T10:00:00.000Z' }]
})

const offline = node({
  nodeId: 'node_win',
  displayName: 'win-studio',
  role: 'remote',
  status: 'offline',
  os: 'Windows',
  arch: 'x64',
  lastHeartbeat: '2026-10-29T10:18:00.000Z',
  clis: [{ adapterKind: 'codex-cli', path: 'C:\\Users\\loom\\.npm-global\\bin\\codex.cmd', version: '0.166.0', pathPresent: false, reportedAt: '2026-10-31T10:18:00.000Z' }]
})

const ready: NodeListState = { nodes: [local, remote, offline], readError: null, refreshError: null }

function renderBody(overrides: Partial<Parameters<typeof NodesSettingsBody>[0]> = {}): string {
  return renderToStaticMarkup(createElement(NodesSettingsBody, {
    list: ready,
    expanded: { node_desk: true },
    now,
    onToggle: () => undefined,
    onRetry: () => undefined,
    onAdd: () => undefined,
    onRevoke: () => undefined,
    pairOpen: false,
    ticket: null,
    pairBusy: false,
    pairError: '',
    copied: null,
    deadline: null,
    onPairOpenChange: () => undefined,
    onCopyCode: () => undefined,
    onCopy: () => undefined,
    revokeNode: null,
    typed: '',
    revokeBusy: false,
    revokeError: '',
    onRevokeOpenChange: () => undefined,
    onTyped: () => undefined,
    onConfirmRevoke: () => undefined,
    ...overrides
  }))
}

const api: NodeApi = {
  list: async () => ({ nodes: [] }),
  pair: async () => ({ pairingCode: 'unused', expiresInSeconds: 600, connectUrl: 'ws://127.0.0.1:9/api/v1/nodes/connect' }),
  revoke: async () => ({ nodeId: 'node_desk', revokedAt: '2026-11-01T10:19:00.000Z', status: 'offline' }),
  output: async () => ({ runId: 'run_1', attempt: 1, nodeId: 'node_local', runtime: 'codex-cli', status: 'running', ackedSeq: 0, exitCode: null, frames: [], truncated: false, nextFrom: null })
}

describe('nodes settings', () => {
  it('shows the loading title without a node list', () => {
    const markup = renderToStaticMarkup(createElement(NodesSettings, { api, now }))
    expect(markup).toContain('<h1>节点</h1>')
    expect(markup).toContain('正在读取节点…')
    expect(markup).toContain('data-nodes-state="loading"')
    expect(markup).not.toContain('data-node-id=')
    expect(markup).toContain('disabled="">添加节点</button>')
  })

  it('lists the local node beside remote online and offline rows', () => {
    const markup = renderBody()
    expect(markup).toContain('data-nodes-state="ready"')
    expect(markup).toContain('data-node-id="node_local"')
    expect(markup).toContain('data-node-role="local"')
    expect(markup).toContain('不可作废')
    expect(markup).toContain('本机节点跟这份 Core 走')
    expect(markup).toContain('desk-b')
    expect(markup).toContain('在线')
    expect(markup).toContain('codex-cli')
    expect(markup).toContain('0.166.0')
    expect(markup).toContain('在跑 1 · codex-cli')
    expect(markup).toContain('/Users/loom/.npm-global/bin/codex')
    expect(markup).toContain('路径有效')
    expect(markup).toContain('win-studio')
    expect(markup).toContain('离线 · 上次见到')
    expect(markup).toContain('心跳 4 秒前')
    expect(markup).toContain('上次心跳 3 天前')
    expect(markup).not.toContain('token')
  })

  it('keeps the local node when no remote node has dialed in', () => {
    const markup = renderBody({ list: { nodes: [local], readError: null, refreshError: null }, expanded: {} })
    expect(markup).toContain('data-nodes-state="empty"')
    expect(markup).toContain('还没有拨入的节点')
    expect(markup).toContain('loom-a')
    expect(markup).not.toContain('desk-b')
  })

  it('does not draw nodes when the first read fails', () => {
    const markup = renderBody({ list: { nodes: null, readError: 'nodes_unavailable', refreshError: null }, expanded: {} })
    expect(markup).toContain('data-nodes-state="error"')
    expect(markup).toContain('节点列表读取失败')
    expect(markup).toContain('这次没有读到节点')
    expect(markup).toContain('重新读取')
    expect(markup).not.toContain('data-node-id=')
    expect(markup).not.toContain('还没有拨入的节点')
  })

  it('keeps the last successful rows when a later read fails', () => {
    const markup = renderBody({ list: { ...ready, refreshError: 'nodes_unavailable' } })
    expect(markup).toContain('上次读到的列表还留着')
    expect(markup).toContain('data-node-id="node_local"')
    expect(markup).toContain('desk-b')
  })

  it('shows an offline banner without rewriting the last CLI report as missing', () => {
    const working = { ...remote, status: 'offline', lastHeartbeat: '2026-11-01T10:17:00.000Z' }
    const markup = renderBody({ list: { nodes: [local, working], readError: null, refreshError: null } })
    expect(markup).toContain('data-nodes-state="offline"')
    expect(markup).toContain('desk-b 已离线')
    expect(markup).toContain('不改派')
    expect(markup).toContain('上次见到')
    expect(markup).not.toContain('路径缺失')
  })

  it('shows the pairing code, its countdown, and a copyable loom-node command', () => {
    const ticket = {
      pairingCode: '4f7kq2m9aabbccdd',
      expiresInSeconds: 545,
      connectUrl: 'ws://127.0.0.1:8767/api/v1/nodes/connect',
      reachabilityWarning: true
    }
    const markup = renderBody({ pairOpen: true, ticket, deadline: now + 545_000 })
    expect(markup).toContain('添加节点')
    expect(markup).toContain('4f7kq2m9aabbccdd')
    expect(markup).toContain('剩余 09:05')
    expect(markup).toContain('复制配对码')
    expect(markup).toContain('ws://127.0.0.1:8767/api/v1/nodes/connect')
    expect(markup).toContain('B 必须能连上这个地址')
    expect(markup).toContain('loom-node --data-dir ~/.loom-node')
    expect(markup).toContain('--pair-code 4f7kq2m9aabbccdd')
    expect(markup).toContain('复制命令')
    expect(markup).not.toContain('administratorToken')
    expect(pairingCommand(ticket)).not.toMatch(/token|Bearer/i)
    const tunnel = renderBody({
      pairOpen: true,
      deadline: now + 180_000,
      ticket: {
        pairingCode: 'aabbccddeeff0011',
        expiresInSeconds: 180,
        connectUrl: 'wss://loom.trycloudflare.com/api/v1/nodes/connect',
        reachabilityWarning: false
      }
    })
    expect(tunnel).toContain('wss://loom.trycloudflare.com/api/v1/nodes/connect')
    expect(tunnel).toContain('剩余 03:00')
    expect(tunnel).not.toContain('回环地址')
  })

  it('dims a last-seen CLI and warns when the path is missing', () => {
    const seen = node({
      nodeId: 'node_seen',
      displayName: 'studio',
      role: 'remote',
      clis: [{
        adapterKind: 'codex-cli',
        path: '/opt/codex',
        version: '0.166.0',
        pathPresent: true,
        reportedAt: '2026-11-01T10:17:00.000Z',
        availability: 'last_seen'
      }]
    })
    const missing = node({
      nodeId: 'node_missing',
      displayName: 'lab',
      role: 'remote',
      clis: [{
        adapterKind: 'claude-code-cli',
        path: '/opt/claude',
        version: '2.1.316',
        pathPresent: false,
        reportedAt: '2026-11-01T10:00:00.000Z',
        availability: 'path_missing'
      }]
    })
    const markup = renderBody({ list: { nodes: [seen, missing], readError: null, refreshError: null }, expanded: { node_seen: true, node_missing: true } })
    expect(markup).toContain('nodes-cli is-stale')
    expect(markup).toContain('上次见到 1 分钟前')
    expect(markup).toContain('nodes-cli is-warn')
    expect(markup).toContain('class="is-warn"')
    expect(markup).toContain('路径缺失')
  })

  it('hides the role label when it repeats the display name', () => {
    const markup = renderBody({ list: { nodes: [{ ...local, displayName: '本机' }], readError: null, refreshError: null }, expanded: {} })
    expect(markup).toContain('>本机</strong>')
    expect(markup).not.toContain('nodes-role')
  })

  it('requires the node name before revoking a node with active runs', () => {
    const blocked = renderBody({ revokeNode: remote, typed: 'desk' })
    expect(blocked).toContain('作废 desk-b？')
    expect(blocked).toContain('输入 desk-b 以确认')
    expect(blocked).toContain('在途进程由节点自己杀掉并上报')
    expect(blocked).toContain('disabled="">作废</button>')
    const readyToRevoke = renderBody({ revokeNode: remote, typed: 'desk-b' })
    expect(readyToRevoke).not.toContain('disabled="">作废</button>')
    expect(canConfirmRevoke(remote, 'desk-b')).toBe(true)
    expect(canConfirmRevoke(remote, 'desk')).toBe(false)
    expect(canConfirmRevoke(local, 'loom-a')).toBe(false)
  })

  it('confirms an idle node without typing its name', () => {
    const idle = { ...offline, activeRunCount: 0, activeRuns: [] }
    const markup = renderBody({ revokeNode: idle, typed: '' })
    expect(markup).toContain('这台节点现在没有在途 Run')
    expect(markup).not.toContain('node-revoke-name')
    expect(markup).not.toContain('disabled="">作废</button>')
    expect(canConfirmRevoke(idle, '')).toBe(true)
  })

  it('keeps a successful list when the next read fails and replaces it when the read succeeds', () => {
    const failed = applyListResult(ready, { ok: false, code: 'nodes_unavailable' })
    expect(failed.nodes).toEqual(ready.nodes)
    expect(failed.refreshError).toBe('nodes_unavailable')
    expect(failed.readError).toBeNull()
    const first = applyListResult({ nodes: null, readError: null, refreshError: null }, { ok: false, code: 'session_required' })
    expect(first.nodes).toBeNull()
    expect(first.readError).toBe('session_required')
    const recovered = applyListResult(failed, { ok: true, nodes: [local] })
    expect(recovered).toEqual({ nodes: [local], readError: null, refreshError: null })
  })
})

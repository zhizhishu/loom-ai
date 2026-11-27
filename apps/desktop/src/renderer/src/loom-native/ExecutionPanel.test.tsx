import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ExecutionNodeRecord } from '@contracts'
import {
  executionTargetBlock,
  executionTargetDraftFromView,
  setTargetMode,
  setTargetNode,
  type ExecutionTargetRuntimeDescriptor,
  type ExecutionTargetView
} from '../member-execution-target-model'
import { RemoteWorkspacePrepare, remotePrepareNodeId } from './ExecutionPanel'

function descriptor(kind: string): ExecutionTargetRuntimeDescriptor {
  return {
    adapterKind: kind,
    permissionSchemaVersion: 1,
    permissionOptions: [],
    memberRuntimeDefaults: {
      adapterKind: kind,
      model: { mode: 'runtime_default' },
      permissions: { adapterKind: kind, schemaVersion: 1, values: {} }
    },
    supportsRuntimeDefaultModel: true
  } as unknown as ExecutionTargetRuntimeDescriptor
}

/** A member with no prepared remote workspace at all: the real no-workspace entry. */
const view: ExecutionTargetView = {
  memberId: 'member_1',
  revision: 2,
  selection: null,
  availableWorkspaces: [],
  runtimeDescriptors: [descriptor('claude-code-cli')]
}

function node(over: Partial<ExecutionNodeRecord> & Pick<ExecutionNodeRecord, 'nodeId'>): ExecutionNodeRecord {
  return {
    displayName: over.nodeId,
    role: 'remote',
    revocable: true,
    status: 'online',
    os: 'linux',
    arch: 'x64',
    pairedAt: '2026-11-01T00:00:00.000Z',
    revokedAt: null,
    lastHeartbeat: '2026-11-02T00:00:00.000Z',
    activeRunCount: 0,
    activeRuns: [],
    clis: [{
      adapterKind: 'claude-code-cli',
      path: '/usr/local/bin/claude',
      version: '2.1.241',
      pathPresent: true,
      reportedAt: '2026-11-02T00:00:00.000Z',
      availability: 'reported'
    }],
    ...over
  }
}

const onlineNode = node({ nodeId: 'node_b', displayName: 'desk-b' })

/** Remote mode with this online node selected and no workspace on it yet. */
const noWorkspaceDraft = setTargetNode(
  setTargetMode(executionTargetDraftFromView(view), 'remote', view),
  'node_b',
  view
)

function renderPrepare(overrides: Partial<Parameters<typeof RemoteWorkspacePrepare>[0]> = {}): string {
  return renderToStaticMarkup(createElement(RemoteWorkspacePrepare, {
    block: executionTargetBlock(noWorkspaceDraft, view, [onlineNode]),
    draft: noWorkspaceDraft,
    nodes: [onlineNode],
    sourceRoot: '',
    busy: false,
    preparing: false,
    onSourceRoot: () => undefined,
    onPrepare: () => undefined,
    ...overrides
  }))
}

describe('远端工作区准备入口', () => {
  it('appears in the no-workspace state with the source root right next to it', () => {
    expect(executionTargetBlock(noWorkspaceDraft, view, [onlineNode])).toBe('no-workspace')
    const markup = renderPrepare()
    expect(markup).toContain('在所选电脑准备工作区')
    // 源目录没有可信来源时不假装有：只给字面输入框。
    expect(markup).toContain('远端工作区源目录')
    expect(markup).toContain('只创建并登记工作区，不保存运行位置，也不改任务绑定。')
  })

  it('stays off every state that has nothing to prepare', () => {
    expect(remotePrepareNodeId('no-workspace', noWorkspaceDraft, [onlineNode])).toBe('node_b')
    // 离线、已撤销、读不到节点列表：都确认不了「在这台在线的电脑上做」。
    expect(renderPrepare({ nodes: [node({ nodeId: 'node_b', status: 'offline' })] })).toBe('')
    expect(renderPrepare({ nodes: [node({ nodeId: 'node_b', revokedAt: '2026-11-02T00:00:00.000Z' })] })).toBe('')
    expect(renderPrepare({ nodes: null })).toBe('')
    // 不是 no-workspace 就没有要准备的东西。
    expect(renderPrepare({ block: 'workspace-required' })).toBe('')
    expect(renderPrepare({ block: 'read-error' })).toBe('')
    // 本机模式不准备远端工作区。
    expect(renderPrepare({ draft: { mode: 'local', remote: noWorkspaceDraft.remote } })).toBe('')
    // 没有选中设备时也没有目标。
    expect(renderPrepare({ draft: setTargetMode(executionTargetDraftFromView(view), 'remote', view) })).toBe('')
  })
})

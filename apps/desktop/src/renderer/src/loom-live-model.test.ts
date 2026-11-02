import { describe, expect, it } from 'vitest'
import type { ExecutionNodeRecord } from '@contracts'
import { appendOutputLines, elapsedClock, formatElapsed, liveLanes, livePlacements, type LiveClaimRef, type LiveTaskRef } from './loom-live-model'

const tasks: LiveTaskRef[] = [
  { taskId: 'task-1', title: '设计恢复协议', status: 'done' },
  { taskId: 'task-3', title: '实现恢复逻辑', status: 'in_review' },
  { taskId: 'task-4', title: '验收测试', status: 'blocked' }
]

function node(overrides: Partial<ExecutionNodeRecord> & Pick<ExecutionNodeRecord, 'nodeId' | 'displayName' | 'role' | 'status'>): ExecutionNodeRecord {
  return {
    revocable: overrides.role !== 'local',
    os: 'linux',
    arch: 'x64',
    pairedAt: '2026-11-01T00:00:00.000Z',
    revokedAt: null,
    lastHeartbeat: '2026-11-01T00:00:00.000Z',
    activeRunCount: overrides.activeRuns?.length ?? 0,
    activeRuns: [],
    clis: [],
    ...overrides
  }
}

const claims: LiveClaimRef[] = [
  { taskId: 'task-3', agentRunId: 'run-local-1', fenceGeneration: 1, releasedAt: null },
  { taskId: 'task-4', agentRunId: 'run-remote-1', fenceGeneration: 1, releasedAt: null }
]

const nodes: ExecutionNodeRecord[] = [
  node({
    nodeId: 'node_local',
    displayName: 'loom-a',
    role: 'local',
    status: 'online',
    activeRuns: [{ runId: 'run-local-1', attempt: 1, runtime: 'codex-cli', status: 'running', ackedSeq: 4, startedAt: '2026-11-01T10:00:00.000Z' }]
  }),
  node({
    nodeId: 'node_desk',
    displayName: 'desk-b',
    role: 'remote',
    status: 'offline',
    activeRuns: [{ runId: 'run-remote-1', attempt: 1, runtime: 'claude-code-cli', status: 'running', ackedSeq: 8, startedAt: '2026-11-01T09:40:00.000Z' }]
  })
]

describe('loom live placements', () => {
  it('joins a claim to the node that holds its run, and leaves the rest queued or done', () => {
    const placed = livePlacements(tasks, claims, nodes)
    expect(placed.map(entry => [entry.title, entry.phase, entry.nodeName, entry.remote, entry.runtime])).toEqual([
      ['设计恢复协议', 'done', null, false, null],
      ['实现恢复逻辑', 'running', 'loom-a', false, 'codex-cli'],
      ['验收测试', 'offline', 'desk-b', true, 'claude-code-cli']
    ])
  })

  it('does not invent a machine when claims or the node list failed to load', () => {
    expect(livePlacements(tasks, null, nodes).every(entry => entry.nodeName === null)).toBe(true)
    expect(livePlacements(tasks, claims, null).every(entry => entry.nodeName === null)).toBe(true)
    expect(livePlacements(tasks, null, nodes).find(entry => entry.taskId === 'task-3')?.phase).toBe('queued')
  })

  it('shows the pinned node once claims have loaded, and hides it when they have not', () => {
    const pinnedTasks: LiveTaskRef[] = [
      { taskId: 'task-9', title: '等待开工', status: 'ready', executionHostId: 'node_desk' },
      { taskId: 'task-8', title: '没钉住', status: 'ready', executionHostId: null }
    ]
    const placed = livePlacements(pinnedTasks, [], nodes)
    expect(placed[0]).toMatchObject({ nodeName: 'desk-b', remote: true, phase: 'queued', runId: null, pinnedName: 'desk-b' })
    expect(placed[1].nodeName).toBeNull()
    expect(livePlacements(pinnedTasks, null, nodes).every(entry => entry.nodeName === null && entry.pinnedName === null)).toBe(true)
    const running = livePlacements(
      [{ taskId: 'task-3', title: '实现恢复逻辑', status: 'ready', executionHostId: 'node_local' }],
      claims,
      nodes
    )
    expect(running[0]).toMatchObject({ phase: 'running', nodeName: 'loom-a', pinnedName: 'loom-a' })
  })

  it('reads a finished dispatch as exited or failed', () => {
    const finished = [
      node({
        nodeId: 'node_local',
        displayName: 'loom-a',
        role: 'local',
        status: 'online',
        recentRuns: [
          { runId: 'run-local-1', attempt: 1, runtime: 'codex-cli', status: 'exited', ackedSeq: 3, exitCode: 0, startedAt: '2026-11-01T10:00:00.000Z' },
          { runId: 'run-remote-1', attempt: 1, runtime: 'codex-cli', status: 'interrupted', ackedSeq: 1, exitCode: null, startedAt: '2026-11-01T10:00:00.000Z' }
        ]
      })
    ]
    const placed = livePlacements(tasks, claims, finished)
    expect(placed.find(entry => entry.taskId === 'task-3')?.phase).toBe('exited')
    expect(placed.find(entry => entry.taskId === 'task-4')?.phase).toBe('failed')
  })

  it('formats elapsed time and keeps sequence holes as one gap', () => {
    expect(formatElapsed('2026-11-01T10:00:00.000Z', Date.parse('2026-11-01T10:01:05.000Z'))).toBe('1 分 05 秒')
    expect(formatElapsed(null, 0)).toBeNull()
    const first = appendOutputLines([], [{ seq: 1, stream: 'stdout', data: btoa('hello') }], 1)
    expect(first.lines).toEqual([{ kind: 'frame', seq: 1, stream: 'stdout', text: 'hello' }])
    const second = appendOutputLines(first.lines, [{ seq: 4, stream: 'stderr', data: btoa('later') }], first.cursor)
    expect(second.lines[1]).toEqual({ kind: 'gap', seq: 2, missed: 2 })
    expect(second.lines[2]).toMatchObject({ kind: 'frame', seq: 4, text: 'later' })
    expect(second.cursor).toBe(5)
  })

  it('groups tasks onto one lane per node and freezes an offline clock at the heartbeat', () => {
    const placed = livePlacements(tasks, claims, nodes)
    const lanes = liveLanes(placed)
    expect(lanes.map(lane => [lane.remote, lane.nodeName, lane.segments.map(entry => entry.title)])).toEqual([
      [false, 'loom-a', ['实现恢复逻辑']],
      [true, 'desk-b', ['验收测试']],
      [false, '', ['设计恢复协议']]
    ])
    const remote = placed.find(entry => entry.taskId === 'task-4')!
    const frozen = elapsedClock(remote, Date.parse('2026-11-01T12:00:00.000Z'))
    expect(frozen).toBe(Date.parse('2026-11-01T00:00:00.000Z'))
    expect(elapsedClock(remote, Date.parse('2026-11-01T12:05:00.000Z'))).toBe(frozen)
    const local = placed.find(entry => entry.taskId === 'task-3')!
    expect(elapsedClock(local, Date.parse('2026-11-01T12:00:00.000Z'))).toBe(Date.parse('2026-11-01T12:00:00.000Z'))
  })
})

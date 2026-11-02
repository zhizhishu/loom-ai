import type { ExecutionNodeRecord, ExecutionNodeRun, NodeOutputFrame } from '@contracts'

/** What one task is doing on the mission strip. A missing claim or node list never becomes a guessed machine. */
export type LivePhase = 'queued' | 'running' | 'exited' | 'failed' | 'offline' | 'done'

export type LiveTaskRef = { taskId: string; title: string; status: string; executionHostId?: string | null }

export type LiveClaimRef = {
  taskId: string
  agentRunId: string
  fenceGeneration: number
  releasedAt: string | null
}

export type LivePlacement = {
  taskId: string
  title: string
  runId: string | null
  nodeId: string | null
  nodeName: string | null
  remote: boolean
  runtime: string | null
  phase: LivePhase
  startedAt: string | null
  /** Node heartbeat. An offline run freezes its clock here instead of counting forward. */
  lastHeartbeat: string | null
  ackedSeq: number
  /** Display name of the task's pinned node, when the node list actually contains it. */
  pinnedName: string | null
}

export type LiveLane = {
  nodeId: string | null
  nodeName: string
  remote: boolean
  offline: boolean
  segments: LivePlacement[]
}

export type OutputLine =
  | { kind: 'frame'; seq: number; stream: string; text: string; receivedAt?: number }
  | { kind: 'gap'; seq: number; missed: number; receivedAt?: number }

export function livePhaseText(phase: LivePhase): string {
  switch (phase) {
    case 'queued': return '排队'
    case 'running': return '在跑'
    case 'exited': return '已结束'
    case 'failed': return '失败'
    case 'offline': return '离线'
    case 'done': return '已完成'
  }
}

const TERMINAL = new Set(['done', 'canceled'])

function latestClaim(claims: readonly LiveClaimRef[], taskId: string): LiveClaimRef | null {
  let latest: LiveClaimRef | null = null
  for (const claim of claims) {
    if (claim.taskId !== taskId) continue
    if (latest === null || claim.fenceGeneration > latest.fenceGeneration) latest = claim
  }
  return latest
}

function runsOf(node: ExecutionNodeRecord): ExecutionNodeRun[] {
  const seen = new Set<string>()
  const runs: ExecutionNodeRun[] = []
  for (const run of [...node.activeRuns, ...(node.recentRuns ?? [])]) {
    if (seen.has(run.runId)) continue
    seen.add(run.runId)
    runs.push(run)
  }
  return runs
}

function findRun(nodes: readonly ExecutionNodeRecord[], runId: string): { node: ExecutionNodeRecord; run: ExecutionNodeRun } | null {
  for (const node of nodes) {
    const run = runsOf(node).find(entry => entry.runId === runId)
    if (run) return { node, run }
  }
  return null
}

function runPhase(node: ExecutionNodeRecord, run: ExecutionNodeRun): LivePhase {
  if (node.revokedAt || node.status !== 'online') return 'offline'
  if (run.status === 'running') return 'running'
  if (run.status === 'exited' && (run.exitCode === 0 || run.exitCode === null || run.exitCode === undefined)) return 'exited'
  return 'failed'
}

export function livePlacements(
  tasks: readonly LiveTaskRef[],
  claims: readonly LiveClaimRef[] | null,
  nodes: readonly ExecutionNodeRecord[] | null
): LivePlacement[] {
  return tasks.map(task => {
    const done = TERMINAL.has(task.status)
    const bare = (phase: LivePhase): LivePlacement => ({
      taskId: task.taskId,
      title: task.title,
      runId: null,
      nodeId: null,
      nodeName: null,
      remote: false,
      runtime: null,
      phase,
      startedAt: null,
      lastHeartbeat: null,
      ackedSeq: 0,
      pinnedName: null
    })
    // A missing claim projection is not "nobody claimed it", and a missing node list is not "no machines".
    // The pin is a task fact, but it stays hidden until claims loaded: a failed claims read must not name a machine.
    if (claims === null || nodes === null) return bare(done ? 'done' : 'queued')
    const pinned = task.executionHostId
      ? nodes.find(entry => entry.nodeId === task.executionHostId) ?? null
      : null
    const claim = latestClaim(claims, task.taskId)
    const found = claim ? findRun(nodes, claim.agentRunId) : null
    if (!found) {
      if (!pinned) return bare(done ? 'done' : 'queued')
      return {
        taskId: task.taskId,
        title: task.title,
        runId: null,
        nodeId: pinned.nodeId,
        nodeName: pinned.displayName,
        remote: pinned.role === 'remote',
        runtime: null,
        phase: done ? 'done' : 'queued',
        startedAt: null,
        lastHeartbeat: pinned.lastHeartbeat,
        ackedSeq: 0,
        pinnedName: pinned.displayName
      }
    }
    return {
      taskId: task.taskId,
      title: task.title,
      runId: found.run.runId,
      nodeId: found.node.nodeId,
      nodeName: found.node.displayName,
      remote: found.node.role !== 'local',
      runtime: found.run.runtime,
      phase: runPhase(found.node, found.run),
      startedAt: found.run.startedAt ?? null,
      lastHeartbeat: found.node.lastHeartbeat,
      ackedSeq: found.run.ackedSeq,
      pinnedName: pinned?.displayName ?? null
    }
  })
}

/** Local lane first, then each remote. Tasks with no machine stay on their own lane. */
export function liveLanes(placements: readonly LivePlacement[]): LiveLane[] {
  const groups = new Map<string, LiveLane>()
  const unassigned: LivePlacement[] = []
  for (const placement of placements) {
    if (!placement.nodeId) {
      unassigned.push(placement)
      continue
    }
    const lane = groups.get(placement.nodeId) ?? {
      nodeId: placement.nodeId,
      nodeName: placement.nodeName ?? placement.nodeId,
      remote: placement.remote,
      offline: false,
      segments: []
    }
    if (placement.phase === 'offline') lane.offline = true
    lane.segments.push(placement)
    groups.set(placement.nodeId, lane)
  }
  const lanes = [...groups.values()].sort((left, right) => Number(left.remote) - Number(right.remote) || left.nodeName.localeCompare(right.nodeName, 'zh-CN'))
  if (unassigned.length) {
    lanes.push({ nodeId: null, nodeName: '', remote: false, offline: false, segments: unassigned })
  }
  return lanes
}

/** Offline runs stop at the last heartbeat. Everyone else uses the clock passed in. */
export function elapsedClock(placement: LivePlacement, now: number): number {
  if (placement.phase !== 'offline' || !placement.lastHeartbeat) return now
  const frozen = Date.parse(placement.lastHeartbeat)
  return Number.isNaN(frozen) ? now : frozen
}

/** Share of a three-minute window, so a live run's bar moves once a second and then holds. */
export function elapsedRatio(placement: LivePlacement, now: number): number {
  if (placement.phase === 'done' || placement.phase === 'exited') return 1
  if (placement.phase === 'queued' || !placement.startedAt) return 0
  const then = Date.parse(placement.startedAt)
  if (Number.isNaN(then)) return 0
  const seconds = Math.max(0, Math.floor((elapsedClock(placement, now) - then) / 1000))
  return Math.min(1, seconds / 180)
}

export function heartbeatSeconds(placement: LivePlacement, now: number): number | null {
  if (!placement.lastHeartbeat) return null
  const then = Date.parse(placement.lastHeartbeat)
  if (Number.isNaN(then)) return null
  return Math.max(0, Math.round((now - then) / 1000))
}

/** `已进行` clock. Hours drop the seconds so a long run stays one short token. */
export function formatElapsed(startedAt: string | null, now: number): string | null {
  if (!startedAt) return null
  const then = Date.parse(startedAt)
  if (Number.isNaN(then)) return null
  const total = Math.max(0, Math.floor((now - then) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  if (hours > 0) return `${hours} 小时 ${pad(minutes)} 分`
  return `${minutes} 分 ${pad(seconds)} 秒`
}

export function decodeOutputData(data: string): string {
  try {
    const binary = atob(data)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

/** Append a page. A hole in the sequence becomes one gap line; older frames are ignored. */
export function appendOutputLines(lines: readonly OutputLine[], frames: readonly NodeOutputFrame[], cursor: number): { lines: OutputLine[]; cursor: number } {
  const next = lines.slice()
  let expected = cursor
  const ordered = frames.slice().sort((left, right) => left.seq - right.seq)
  for (const frame of ordered) {
    if (!Number.isInteger(frame.seq) || frame.seq < expected) continue
    if (frame.seq > expected) {
      next.push({ kind: 'gap', seq: expected, missed: frame.seq - expected })
    }
    next.push({ kind: 'frame', seq: frame.seq, stream: frame.stream, text: decodeOutputData(frame.data) })
    expected = frame.seq + 1
  }
  return { lines: next, cursor: expected }
}

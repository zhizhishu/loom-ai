import type { ExecutionNodeRecord, ExecutionNodeRun, NodeOutputFrame } from '@contracts'

/** What one task is doing on the mission strip. A missing claim or node list never becomes a guessed machine. */
export type LivePhase = 'queued' | 'running' | 'exited' | 'failed' | 'offline' | 'done'

export type LiveTaskRef = { taskId: string; title: string; status: string }

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
  ackedSeq: number
}

export type OutputLine =
  | { kind: 'frame'; seq: number; stream: string; text: string }
  | { kind: 'gap'; seq: number; missed: number }

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
      ackedSeq: 0
    })
    // A missing claim projection is not "nobody claimed it", and a missing node list is not "no machines".
    if (claims === null || nodes === null) return bare(done ? 'done' : 'queued')
    const claim = latestClaim(claims, task.taskId)
    const found = claim ? findRun(nodes, claim.agentRunId) : null
    if (!found) return bare(done ? 'done' : 'queued')
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
      ackedSeq: found.run.ackedSeq
    }
  })
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

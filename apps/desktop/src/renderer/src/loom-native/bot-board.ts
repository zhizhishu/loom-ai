// PiBot@6741737 host-core/runtime-bot-board.js:116 deriveTaskStatusLine, 复制改写。
import type { AgentProfile, ConversationItem, MissionRecord, WorkBundle } from './types'
import { flattenWork, workStatus } from './Inspector'
export type BoardBucket = 'attention' | 'working' | 'review' | 'idle' | 'offline'
export type BoardTarget = { key: string; name: string; threadId: string | null; taskId: string | null;
  attention: boolean; working: boolean; phase?: string; resultId?: string; title: string; status: string; online: boolean; runtimeLabel?: string }
const RUNTIME_LABELS: Record<string, string> = { 'claude-code-cli': 'Claude Code', 'codex-cli': 'Codex', 'deepseek-harness': 'DSH', pi: 'Pi' }
export function botBoardBucket(item: BoardTarget, seenId?: string): BoardBucket {
  if (!item.online) return 'offline'
  if (item.phase === 'stopping' || item.phase === 'interrupting') return 'working'
  if (item.phase === 'failed') return 'attention'
  if (item.attention) return 'attention'
  if (item.working) return 'working'
  if (item.resultId && item.resultId !== seenId) return 'review'
  return 'idle'
}
// PiBot runtime-bot-board derives global tasks; LOOM has no per-Bot live projection.
// Pending acceptance alone never means a user action: workStatus checks control facts.
export function botBoardTargets(agents: readonly AgentProfile[], conversations: readonly ConversationItem[],
  missions: readonly MissionRecord[], bundles: WorkBundle[]): BoardTarget[] {
  const work = flattenWork(bundles)
  return agents.map(agent => {
    const tasks = work.filter(row => row.task.assigneeAgentId === agent.agentId)
    const related = missions.filter(m => m.memberAgentIds.includes(agent.agentId))
    const attention = tasks.find(row => workStatus(row).group === '等待你')
    const working = tasks.find(row => workStatus(row).group === '进行中')
    const result = tasks.filter(row => row.candidate && row.task.status === 'done')
      .sort((a,b) => (b.candidate?.createdAt??'').localeCompare(a.candidate?.createdAt??''))[0]
    const mission = related.find(m=>m.status==='needs_you') ?? related.find(m=>m.runningAgentIds.includes(agent.agentId))
    const active = attention ?? working ?? result ?? tasks[0]
    return { key:agent.agentId, name:agent.displayName, attention:!!attention||mission?.status==='needs_you',
      working:!!working||related.some(m=>m.runningAgentIds.includes(agent.agentId)),
      resultId:result?.candidate?.candidateId,
      threadId:active?.mission.threadId ?? mission?.threadId ?? conversations.find(c=>c.agentId===agent.agentId)?.threadId ?? null,
      taskId:active?.task.taskId ?? null, title:active?.task.title ?? mission?.title ?? '',
      status:active?workStatus(active).label:mission?.status==='needs_you'?'需要你':mission?'进行中':'空闲', online:true,
      runtimeLabel:agent.runtimeConfiguration?.adapterKind?RUNTIME_LABELS[agent.runtimeConfiguration.adapterKind]??agent.runtimeConfiguration.adapterKind:'未配置' }
  })
}

// Translation of PiBot deriveTaskStatusLine; prompt and step facts must be explicit.
export function deriveTaskStatusLine(task:{status:string;pendingPrompt?:{kind:string}}, step?:{status:string}): string {
  if(task.pendingPrompt)return task.pendingPrompt.kind==='plan'?'待确认':'待你回应'
  if(step?.status==='working')return '进行中'
  if(step?.status==='todo')return '等待开始'
  if(step?.status==='blocked')return '受阻 · 等待前置结果'
  if(step?.status==='waiting')return '等待确认'
  if(task.status==='triaging')return '拆解中'
  if(task.status==='waiting')return '等待前置结果'
  if(task.status==='working')return '进行中'
  return '等待开始'
}

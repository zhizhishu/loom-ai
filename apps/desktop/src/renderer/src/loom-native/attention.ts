/**
 * 注意力评分与预算 —— Mikka `lib/attention/{score,budget,interrupt}.ts` 的
 * renderer-only 移植。只借三个核心思想，不搬账号/设备/计费与 Decisions API：
 *
 * - score（Mikka score.ts）：每条「等你」的事实打一个可解释的分——严重度定档，
 *   等待时长加成但封顶；分数只用于排序，不假装是模型判断。
 * - budget（Mikka budget.ts 的 runaway cap）：同一时刻最多露出 ATTENTION_BUDGET
 *   条，超出的一律聚合成「还有 N 项」，不逐条刷屏。
 * - interrupt（Mikka interrupt.ts）：只有高分项才计入 attentionCount（才打扰你）；
 *   低分通知（`completion`）永远不单独露出，只进聚合数。
 *
 * 全部是纯函数：事实由调用方从真实投影里挑（工作面板的等待项、提问、当前会话
 * 的待确认授权），这里不读状态、不发请求、不改 Core 语义。没有时间事实时按
 * 「刚到」处理，不编时间。
 */

import type { ActionApprovalView } from '@contracts'

/** 一条等待用户处理的事实的类别。 */
export type AttentionKind =
  | 'approval'   // 一项运行正被这个授权扣住：不确认就走不下去
  | 'question'   // 一项运行正在等这句回答
  | 'review'     // 成果结论已交回，验收在你手里
  | 'completion' // 纯完成通知：知道了就行，不为你打断

export type AttentionSeverity = 'high' | 'normal' | 'low'

/** 输入事实：定位（thread/mission/task）+ 标题 + 时间。严重度由 kind 决定。 */
export interface AttentionFact {
  /** 稳定标识：排序后回跳定位与去重都用它 */
  id: string
  kind: AttentionKind
  title: string
  threadId: string | null
  missionId: string | null
  taskId: string | null
  /** 事实发生时间（RFC3339）。null 或不可解析按「刚到」算，不外推。 */
  createdAt: string | null
}

/** 评分后的事实：输入事实 + 严重度、等待年龄与分数。 */
export interface ScoredAttention extends AttentionFact {
  severity: AttentionSeverity
  /** 等待了多少分钟；时间缺失或不可解析时为 0 */
  ageMinutes: number
  score: number
}

const KIND_SEVERITY: Record<AttentionKind, AttentionSeverity> = {
  approval: 'high',
  question: 'high',
  review: 'normal',
  completion: 'low'
}

/** 严重度是档位下限：低分项加满等待加成也越不过高一个档位的底线。 */
const SEVERITY_SCORE: Record<AttentionSeverity, number> = { high: 70, normal: 40, low: 10 }
/** 等待加成：每小时 +1，封顶 24——「老通知永远压不住新审批」。 */
const AGE_BONUS_MAX = 24

export function attentionSeverity(kind: AttentionKind): AttentionSeverity {
  return KIND_SEVERITY[kind]
}

export function attentionAgeMinutes(createdAt: string | null, now: Date): number {
  if (!createdAt) return 0
  const at = new Date(createdAt).getTime()
  if (!Number.isFinite(at)) return 0
  return Math.max(0, Math.floor((now.getTime() - at) / 60_000))
}

export function attentionScore(fact: AttentionFact, now: Date = new Date()): number {
  const bonus = Math.min(Math.floor(attentionAgeMinutes(fact.createdAt, now) / 60), AGE_BONUS_MAX)
  return SEVERITY_SCORE[attentionSeverity(fact.kind)] + bonus
}

/** 评分排序：分数高的在前；同分先到先办（等待更久的在前）。稳定：完全并列时保持输入顺序。 */
export function rankAttention(facts: readonly AttentionFact[], now: Date = new Date()): ScoredAttention[] {
  return facts
    .map(fact => {
      const ageMinutes = attentionAgeMinutes(fact.createdAt, now)
      const severity = attentionSeverity(fact.kind)
      const score = SEVERITY_SCORE[severity] + Math.min(Math.floor(ageMinutes / 60), AGE_BONUS_MAX)
      return { ...fact, severity, ageMinutes, score }
    })
    .sort((a, b) => b.score - a.score || b.ageMinutes - a.ageMinutes)
}

/** 同一时刻最多露出的「等你」条数；其余聚合成一行，不逐条打扰。 */
export const ATTENTION_BUDGET = 5

export interface AttentionSummary {
  /** 预算内、真正需要你处理的条目，按分数排序 */
  surfaced: ScoredAttention[]
  /** 预算外与低分通知的总数：界面聚合成「还有 N 项」 */
  remainder: number
  /** attentionCount 的来源：只数预算内的有效项，低分通知不计 */
  count: number
}

export function summarizeAttention(
  facts: readonly AttentionFact[],
  now: Date = new Date(),
  budget: number = ATTENTION_BUDGET
): AttentionSummary {
  const ranked = rankAttention(facts, now)
  const surfaced = ranked.filter(item => item.severity !== 'low').slice(0, Math.max(0, budget))
  return { surfaced, remainder: ranked.length - surfaced.length, count: surfaced.length }
}

/** 当前会话待确认的授权 → 高分事实。运行正被它扣住：不处理就走不下去。
 * 只读 pending；已同意/已拒绝/已取消/已过期都不是「等你」。 */
export function attentionFactsFromApprovals(
  approvals: readonly ActionApprovalView[],
  threadId: string | null,
  missionId: string | null
): AttentionFact[] {
  return approvals
    .filter(approval => approval.status === 'pending')
    .map(approval => ({
      id: `approval:${approval.id}`,
      kind: 'approval',
      title: approval.actionSummary,
      threadId,
      missionId,
      taskId: null,
      createdAt: approval.requestedAt
    }))
}

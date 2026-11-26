// 无参考，按用户定（待复审习得技能）
import type { SkillView } from '@contracts'
export function learnedSkills(skills: readonly SkillView[], agentId: string, state = 'active'): SkillView[] {
  return skills.filter(s => s.learned?.agentId === agentId && (state === 'all' || s.learned.state === state))
    .sort((a,b) => Number(b.learned?.pinned) - Number(a.learned?.pinned) || a.name.localeCompare(b.name))
}
export function learnedBadges(skill: SkillView): string[] {
  if (!skill.learned) return []
  return [skill.learned.state === 'archived' ? '已归档' : skill.learned.state === 'stale' ? '待复审' : '已启用',
    ...(skill.learned.pinned ? ['已置顶'] : []), ...(skill.learned.locked ? ['已锁定'] : [])]
}
export function canManageLearned(skill: SkillView): boolean { return !!skill.learned }

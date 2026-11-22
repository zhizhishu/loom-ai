import type { SkillVisibilityScope } from '@contracts'
export const DEFAULT_SKILL_SCOPE: SkillVisibilityScope = 'private'
export const visibilityChoices = [
  { value: 'all', label: '全部可见范围' },
  { value: 'private', label: '仅此助手' },
  { value: 'assigned', label: '指定助手' },
  { value: 'global', label: '所有助手' }
]
export function scopeLabel(scope: SkillVisibilityScope = DEFAULT_SKILL_SCOPE, owned = true): string {
  if (!owned) return '公共技能'
  return visibilityChoices.find(item => item.value === scope)?.label ?? '仅此助手'
}
export function matchesVisibility(scope: SkillVisibilityScope | undefined, filter: string): boolean {
  return filter === 'all' || (scope ?? DEFAULT_SKILL_SCOPE) === filter
}

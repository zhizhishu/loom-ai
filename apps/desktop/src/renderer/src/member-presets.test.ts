import { describe, expect, it } from 'vitest'
import { parseControlledMemberAvatarRef } from '@contracts'
import { BUILTIN_MEMBER_PRESETS } from './member-presets'

describe('builtin member presets', () => {
  it('ship four independent identity presets with canonical builtin avatar refs', () => {
    expect(BUILTIN_MEMBER_PRESETS.map((preset) => preset.role)).toEqual([
      'luoke',
      'muwa',
      'mianzhi',
      'qilu'
    ])
    expect(BUILTIN_MEMBER_PRESETS.map((preset) => preset.displayName)).toEqual([
      'Hanzi',
      'Linxi',
      'Beichen',
      'Yezi'
    ])
    expect(BUILTIN_MEMBER_PRESETS[1]).toMatchObject({
      teamRole: '独立审查',
      professionalResponsibilities:
        '负责独立检查实现、边界条件与安全风险，指出可复现的问题、影响与修正建议；审查通过不代表代替用户接受成果。',
      personalityTraits: ['严谨', '坦诚', '克制']
    })
    for (const preset of BUILTIN_MEMBER_PRESETS) {
      expect(parseControlledMemberAvatarRef(preset.avatarRef)).toMatchObject({
        kind: 'builtin',
        role: preset.role
      })
      expect(preset.professionalResponsibilities.length).toBeGreaterThan(30)
      expect(preset.personalityTraits).toHaveLength(3)
      expect(preset.workingPrinciples).toBe('')
      expect(preset.growthTopic).toBe('')
    }
  })
})

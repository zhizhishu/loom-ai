import { describe,expect,it } from 'vitest'
import { DEFAULT_SKILL_SCOPE,matchesVisibility,scopeLabel } from './capability-scope'
describe('skill visibility presentation',()=>{
  it('defaults to private and keeps the legacy public label explicit',()=>{
    expect(DEFAULT_SKILL_SCOPE).toBe('private');expect(scopeLabel()).toBe('仅此助手')
    expect(scopeLabel('assigned')).toBe('指定助手');expect(scopeLabel('global')).toBe('所有助手')
    expect(scopeLabel('private',false)).toBe('公共技能')
    expect(matchesVisibility(undefined,'private')).toBe(true)
    expect(matchesVisibility(undefined,'global')).toBe(false)
  })
  it('filters each tier without widening it',()=>{
    for(const scope of ['private','assigned','global'] as const){
      expect(matchesVisibility(scope,'all')).toBe(true)
      for(const other of ['private','assigned','global'])expect(matchesVisibility(scope,other)).toBe(scope===other)
    }
  })
})

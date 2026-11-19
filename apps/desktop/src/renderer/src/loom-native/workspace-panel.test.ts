import { describe, expect, it } from 'vitest'
import { moveConversation, movePanel, panelFor, modeFor, readPanelPreference, scopedBundles, type PanelRoute } from './workspace-panel'
import { ASSISTANT_PRESETS, availablePresetName, presetIdentity } from './assistant-presets'
import { parseControlledMemberAvatarRef } from '@contracts'
import type { WorkBundle } from './types'

const route: PanelRoute = { panel:'flow', threadId:'a', scope:'conversation', selectedTaskId:'task-a', selectedArtifactId:'artifact-a' }
describe('one contextual workspace dock',()=>{
  it('maps old routes without making a separate computer workspace',()=>{
    expect(panelFor('map')).toBe('flow')
    expect(panelFor('profile','computer')).toBe('computer')
    expect(panelFor('profile','assets')).toBe('assets')
    expect(panelFor('profile','details')).toBe('work')
    expect(modeFor('flow')).toBe('map')
  })
  it('changes only the view and retains the exact conversation/node selection',()=>{
    expect(movePanel(route,'assets')).toEqual({...route,panel:'assets'})
  })
  it('drops stale node selections when the conversation changes',()=>{
    expect(moveConversation(route,'b')).toEqual({...route,threadId:'b',selectedTaskId:null,selectedArtifactId:null})
    expect(moveConversation(route,'a')).toBe(route)
  })
  it('scopes actual bundles and never substitutes all work for an empty selected conversation',()=>{
    const bundles=[{mission:{threadId:'a'}},{mission:{threadId:'b'}}] as WorkBundle[]
    expect(scopedBundles(bundles,'a','conversation')).toEqual([bundles[0]])
    expect(scopedBundles(bundles,'missing','conversation')).toEqual([])
    expect(scopedBundles(bundles,'a','all')).toEqual(bundles)
    expect(scopedBundles(bundles,null,'conversation')).toEqual(bundles)
  })
  it('only restores known view preferences, never a serialized permission',()=>{
    expect(readPanelPreference('computer')).toBe('computer')
    expect(readPanelPreference('{"controlId":"secret"}')).toBe('work')
    expect(readPanelPreference(null)).toBe('work')
  })
})
describe('romanized assistant starting points',()=>{
  it('provides eight unique useful roles with accepted animated avatar refs',()=>{
    expect(ASSISTANT_PRESETS.map(row=>row.name)).toEqual(['Hanzi','Yezi','Linxi','Beichen','Qinghe','Muyu','Anyu','Xinghe'])
    expect(new Set(ASSISTANT_PRESETS.map(row=>row.id)).size).toBe(8)
    for(const preset of ASSISTANT_PRESETS){
      expect(preset.name).toMatch(/^[A-Za-z]+$/)
      expect(preset.purpose.length).toBeGreaterThan(20)
      expect(parseControlledMemberAvatarRef(preset.avatarRef)).not.toBeNull()
    }
  })
  it('templates cannot carry a model, runtime, credentials or permissions',()=>{
    const value=presetIdentity(ASSISTANT_PRESETS[0])
    expect(Object.keys(value).sort()).toEqual(['instructions','name','purpose','role','style'])
    expect(value.instructions).toContain('用户决定')
  })
  it('keeps custom names and picks a conflict-free suggestion case-insensitively',()=>{
    expect(availablePresetName('Hanzi',['HANZI','Hanzi 2'])).toBe('Hanzi 3')
    expect(availablePresetName('Yezi',['My custom bot'])).toBe('Yezi')
  })
})

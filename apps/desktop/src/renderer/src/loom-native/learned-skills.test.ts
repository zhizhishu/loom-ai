import { expect,it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SkillView } from '@contracts'
import type { BusinessEnvironment } from '../business-environment'
import { canManageLearned,learnedBadges,learnedSkills } from './learned-skills'
import { LearnedSkillsPanel } from './LearnedSkillsPanel'
it('never substitutes imported skills for learned facts',()=>{
  const imported={id:'i',name:'Imported'} as SkillView
  expect(learnedSkills([imported],'bot')).toEqual([])
  expect(canManageLearned(imported)).toBe(false);expect(learnedBadges(imported)).toEqual([])
})
it('filters agent and state and puts pinned learned skills first',()=>{
  const row=(id:string,state:'active'|'stale'|'archived',pinned=false)=>({id,name:id,learned:{agentId:'bot',state,pinned,locked:true}} as SkillView)
  const rows=[row('a','active'),row('z','active',true),row('old','archived'),row('review','stale')]
  expect(learnedSkills(rows,'bot').map(s=>s.id)).toEqual(['z','a'])
  expect(learnedSkills(rows,'other','all')).toEqual([])
  expect(learnedBadges(rows[2]!)).toEqual(['已归档','已锁定'])
  expect(learnedBadges(rows[3]!)).toEqual(['待复审','已锁定'])
})
it('renders the honest no-producer empty state',()=>{
  const html=renderToStaticMarkup(createElement(LearnedSkillsPanel,{environment:{client:{}} as BusinessEnvironment,agentId:'bot'}))
  expect(html).toContain('还没有学到技能');expect(html).toContain('学习管线尚未接入')
})

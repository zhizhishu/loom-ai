// 无参考，按用户定（学到只读空态）
import { useEffect, useRef, useState } from 'react'
import type { SkillView } from '@contracts'
import type { BusinessEnvironment } from '../business-environment'
import { learnedBadges, learnedSkills } from './learned-skills'
import { setSkillMetadata } from './capability-service'
import { FormMessage } from './Controls'

export function LearnedSkillsPanel({ environment, agentId }: { environment: BusinessEnvironment; agentId: string }) {
  const [skills,setSkills] = useState<SkillView[]>([])
  const [filter,setFilter] = useState('active')
  const [error,setError] = useState('')
  const [busy,setBusy] = useState(false)
  const epoch = useRef(0)
  useEffect(() => {
    const current = ++epoch.current
    setSkills([]); setError('')
    void environment.client.request<SkillView[]>('skills.list',{}).then(rows => {
      if (current === epoch.current) setSkills(rows)
    }).catch(cause => { if (current === epoch.current) setError(String(cause)) })
    return () => { epoch.current++ }
  },[environment.client,agentId])
  const patch = async (skill: SkillView, value: Parameters<typeof setSkillMetadata>[3]) => {
    if (busy || !skill.learned) return
    const current = epoch.current
    setBusy(true); setError('')
    try {
      await setSkillMetadata(environment.client,skill.id,skill.version,value)
      const rows = await environment.client.request<SkillView[]>('skills.list',{})
      if (current === epoch.current) setSkills(rows)
    } catch (cause) { if (current === epoch.current) setError(String(cause)) }
    finally { if (current === epoch.current) setBusy(false) }
  }
  const rows = learnedSkills(skills,agentId,filter)
  return <section aria-label="学到的技能">
    <p>只展示这个助手自己学到的技能，不把导入技能当成习得成果。</p>
    <p>学习管线尚未接入；自动提炼和高级学习策略暂不可用。</p>
    <label><input type="checkbox" disabled/>空闲时自动提炼技能</label>
    <details><summary>高级学习策略</summary><p>自动标记待复审、自动归档将在学习管线接入后开放。</p></details>
    <nav aria-label="习得技能筛选">{[['active','已启用'],['all','本 Bot 习得'],['archived', '已归档 ('+learnedSkills(skills,agentId,'archived').length+')']].map(([value,label]) =>
      <button type="button" key={value} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{label}</button>)}</nav>
    {error && <FormMessage error>{error}</FormMessage>}
    {!rows.length && <p>还没有学到技能</p>}
    {rows.map(skill => <article key={skill.id}><h4>{skill.name}</h4><p>{learnedBadges(skill).join(' · ')}</p>
      <button type="button" disabled={busy} onClick={()=>void patch(skill,{pinned:!skill.learned?.pinned})}>{skill.learned?.pinned?'取消置顶':'置顶'}</button>
      <button type="button" disabled={busy} onClick={()=>void patch(skill,{locked:!skill.learned?.locked})}>{skill.learned?.locked?'解锁':'锁定'}</button>
      <button type="button" disabled={busy} onClick={()=>void patch(skill,{learnedState:skill.learned?.state==='archived'?'active':'archived'})}>{skill.learned?.state==='archived'?'恢复':'归档'}</button>
    </article>)}
  </section>
}

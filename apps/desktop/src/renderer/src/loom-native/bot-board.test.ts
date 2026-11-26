import { expect,it,vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentProfile, MissionRecord } from './types'
import { BotBoard } from './BotBoard'
import { botBoardBucket,botBoardTargets,deriveTaskStatusLine,type BoardTarget } from './bot-board'
import { markViewed,readSeen } from './bot-board-seen'
import { RailBottom } from './LoomApp'
it('renders inbox, badge and profile in one bottom rail',()=>{
 const html=renderToStaticMarkup(createElement(RailBottom,{children:[createElement('button',{key:'inbox'},'待发送'),createElement('small',{key:'badge'},'2'),createElement('button',{key:'profile'},'设置')]}))
 expect(html.match(/class="ln-rail-bottom"/g)).toHaveLength(1)
 const source=readFileSync(new URL('./LoomApp.tsx',import.meta.url),'utf8')
 expect(source.match(/<RailBottom>/g)).toHaveLength(1)
 expect(source.match(/className="ln-rail-bottom"/g)).toHaveLength(1)
 expect(html).toContain('待发送');expect(html).toContain('<small>2</small>');expect(html).toContain('设置')
})
vi.mock('./Controls',async original=>({...await original<typeof import('./Controls')>(),SurfaceDialog:({children}:{children:ReactNode})=>children}))
it('renders exactly three main columns, collapsed idle rows, and an honest read failure',()=>{
 const html=renderToStaticMarkup(createElement(BotBoard,{open:true,agents:[],conversations:[],missions:[],bundles:[],error:'offline',refresh:async()=>{},onOpen:()=>{},onClose:()=>{},onCreate:()=>{}}))
 expect(html.match(/<h3>/g)).toHaveLength(3)
 for(const label of ['需要你','进行中','待查看','空闲 0 · 离线 0','上次更新','新建助手'])expect(html).toContain(label)
 expect(html).not.toContain('data-slot="empty"')
 expect(html).toContain('<details>');expect(html).not.toContain('<details open')
})
it('uses the shared empty pattern for a confirmed empty board',()=>{
 const html=renderToStaticMarkup(createElement(BotBoard,{open:true,agents:[],conversations:[],missions:[],bundles:[],error:null,refresh:async()=>{},onOpen:()=>{},onClose:()=>{},onCreate:()=>{}}))
 for(const label of ['还没有助手','看板会按需要你、进行中、待查看分组','新建助手'])expect(html).toContain(label)
 expect(html).toContain('data-slot="empty"');expect(html).toContain('data-slot="empty-title"');expect(html).toContain('data-slot="empty-icon"')
})
it('derives running agents from mission facts instead of inventing per-bot runtime activity',()=>{
 const agent={agentId:'a',displayName:'A'} as AgentProfile
 const mission={missionId:'m',threadId:'t',memberAgentIds:['a'],runningAgentIds:['a'],title:'Real work'} as MissionRecord
 const [target]=botBoardTargets([agent],[],[mission],[])
 expect(target?.working).toBe(true);expect(botBoardBucket(target!)).toBe('working')
 expect(target?.runtimeLabel).toBe('未配置')
 const [piTarget]=botBoardTargets([{...agent,runtimeConfiguration:{adapterKind:'pi'}} as AgentProfile],[],[mission],[])
 expect(piTarget?.runtimeLabel).toBe('Pi')
})
const base:BoardTarget={key:'bot',name:'Helper',threadId:'t',taskId:null,attention:false,working:false,title:'',status:'',online:true}
it('keeps the upstream attention, busy, unseen, idle and offline precedence',()=>{
 expect(botBoardBucket({...base,attention:true,working:true})).toBe('attention')
 expect(botBoardBucket({...base,working:true,resultId:'r'})).toBe('working')
 expect(botBoardBucket({...base,resultId:'r'})).toBe('review')
 expect(botBoardBucket({...base,resultId:'r'},'r')).toBe('idle')
 expect(botBoardBucket({...base,online:false})).toBe('offline')
 expect(botBoardTargets([],[],[],[])).toEqual([])
})
it('persists only viewed IDs and surfaces storage failures',()=>{
 const values=new Map<string,string>();const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v)}}
 expect(readSeen('bot',storage)).toBeUndefined()
 markViewed('bot','result-id',storage);expect(readSeen('bot',storage)).toBe('result-id')
 expect([...values.values()]).toEqual(['result-id'])
 expect(()=>markViewed('bot','next',{...storage,setItem:()=>{throw new Error('blocked')}})).toThrow('blocked')
})

it('keeps control transitions ahead of attention and maps upstream task lines',()=>{
 for(const phase of ['stopping','interrupting'])expect(botBoardBucket({...base,phase,attention:true})).toBe('working')
 expect(botBoardBucket({...base,phase:'failed'})).toBe('attention')
 expect(deriveTaskStatusLine({status:'working',pendingPrompt:{kind:'plan'}})).toBe('待确认')
 expect(deriveTaskStatusLine({status:'working',pendingPrompt:{kind:'question'}})).toBe('待你回应')
 for(const [status,label] of [['working','进行中'],['todo','等待开始'],['blocked','受阻 · 等待前置结果'],['waiting','等待确认']])
   expect(deriveTaskStatusLine({status:'working'},{status:status!})).toBe(label)
 expect(deriveTaskStatusLine({status:'triaging'})).toBe('拆解中')
 expect(deriveTaskStatusLine({status:'waiting'})).toBe('等待前置结果')
})

it('shows assigned task ownership even before control facts are observed',()=>{
 const agent={agentId:'a',displayName:'A'} as AgentProfile
 const mission={missionId:'m',threadId:'t',memberAgentIds:['a'],runningAgentIds:[],title:'Mission'} as unknown as MissionRecord
 const bundle={mission,plan:null,tasks:[{taskId:'task-a',title:'Owned task',assigneeAgentId:'a',status:'draft'}],candidates:[],artifacts:[],reviews:[],verifications:[]} as never
 const [target]=botBoardTargets([agent],[],[mission],[bundle])
 expect(target?.title).toBe('Owned task')
 expect(target?.taskId).toBe('task-a')
})

it('uses existing presence and runtime-readiness facts for each bot live state',()=>{
 const present={agentId:'a',displayName:'A',presence:'present',removedAt:null,runtimeReadiness:{status:'ready',blockers:[]}} as unknown as AgentProfile
 const away={...present,agentId:'away',presence:'away'} as AgentProfile
 const removed={...present,agentId:'removed',removedAt:'2026-11-26T00:00:00Z'} as AgentProfile
 const broken={...present,agentId:'broken',runtimeReadiness:{status:'needs_attention',blockers:[{code:'runtime_configuration_invalid',detail:null}]}} as AgentProfile
 const rows=botBoardTargets([present,away,removed,broken],[],[],[])
 expect(rows.find(row=>row.key==='a')?.online).toBe(true)
 expect(rows.find(row=>row.key==='away')?.online).toBe(false)
 expect(rows.find(row=>row.key==='away')?.status).toBe('离开')
 expect(rows.find(row=>row.key==='removed')?.online).toBe(false)
 expect(rows.find(row=>row.key==='removed')?.status).toBe('已移除')
 const brokenRow=rows.find(row=>row.key==='broken')!
 expect(brokenRow.attention).toBe(true)
 expect(brokenRow.status).toBe('运行需处理')
 expect(botBoardBucket(brokenRow)).toBe('attention')
})

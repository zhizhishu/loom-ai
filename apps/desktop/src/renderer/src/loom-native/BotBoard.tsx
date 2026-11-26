// PiBot@6741737 web/src/BotBoard.tsx:15-24 columns, 结构对照。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentProfile, ConversationItem, MissionRecord, WorkBundle } from './types'
import { botBoardBucket, botBoardTargets, type BoardBucket, type BoardTarget } from './bot-board'
import { markViewed, readSeen } from './bot-board-seen'
import { SurfaceDialog } from './Controls'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './EmptyState'
import { Icon } from './icons'
import './bot-board.css'
export function BotBoard({ open, agents, conversations, missions, bundles, error, refresh, onOpen, onDetails, onClose, onCreate, theme='day' }: {
  open:boolean; agents:AgentProfile[]; conversations:ConversationItem[]; missions:MissionRecord[]; bundles:WorkBundle[];
  error:string|null; refresh():Promise<void>; onOpen(row:BoardTarget):void; onDetails?(row:BoardTarget):void; onClose():void; onCreate():void; theme?:'day'|'night'
}) {
  const [query,setQuery]=useState('')
  const [filter,setFilter]=useState('all')
  const [seen,setSeen]=useState<Record<string,string>>({})
  const [storageError,setStorageError]=useState('')
  const [updated,setUpdated]=useState('')
  const flight=useRef(false)
  const latest=useRef(refresh);latest.current=refresh
  const reload=async()=>{
    if(flight.current)return
    flight.current=true
    try{await latest.current();setUpdated(new Date().toLocaleTimeString())}
    finally{flight.current=false}
  }
  useEffect(()=>{
    if(!open)return
    let disposed=false
    let timer:ReturnType<typeof setTimeout>
    const poll=async()=>{
      if(!document.hidden)try{await reload()}catch{/* Data source owns the error. */}
      if(!disposed)timer=setTimeout(()=>void poll(),5000)
    }
    void poll()
    return()=>{disposed=true;clearTimeout(timer)}
  },[open])
  useEffect(()=>{
    if(!open)return
    try{setSeen(Object.fromEntries(agents.map(a=>[a.agentId,readSeen(a.agentId)??''])))}
    catch{setStorageError('无法读取本机查看标记；待查看状态可能不完整。')}
  },[open,agents])
  const rows=useMemo(()=>botBoardTargets(agents,conversations,missions,bundles),[agents,conversations,missions,bundles])
  const filtered=rows.filter(row=>(filter==='all'||botBoardBucket(row,seen[row.key])===filter) &&
    (row.name+' '+row.title).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const card=(row:BoardTarget)=><article key={row.key} className="ln-board-card" onClick={()=>onDetails?.(row)}><strong>{row.name}</strong><p>{row.title||'没有正在处理的工作'}</p><small>{row.status} · {row.runtimeLabel??'未配置'}</small>
    <button type="button" disabled={!row.threadId||!!error} onClick={event=>{
      event.stopPropagation()
      if(row.resultId)try{markViewed(row.key,row.resultId);setSeen(s=>({...s,[row.key]:row.resultId!}))}
      catch{setStorageError('查看标记未能保存；稍后可能再次显示待查看。')}
      onOpen(row)
    }}>{row.attention?'回答问题':botBoardBucket(row,seen[row.key])==='review'?'查看结果':'进入聊天'}</button></article>
  const columns:[BoardBucket,string][]=[['attention','需要你'],['working','进行中'],['review','待查看']]
  return <SurfaceDialog open={open} onClose={onClose} theme={theme} title="助手看板" description="可见时每 5 秒刷新 · 只读摘要">
    <section className="ln-bot-board"><button type="button" onClick={()=>void reload().catch(()=>{})}>刷新看板</button><button type="button" onClick={onCreate}>新建助手</button>
      <input aria-label="搜索助手看板" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索助手或工作"/>
      <select aria-label="看板状态" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部状态</option>{columns.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>
      {storageError&&<p role="alert">{storageError}</p>}
      {error&&<p role="alert">状态未确认：{error} · 上次更新 {updated||'尚无成功更新'}</p>}
      <div className="ln-board-columns">{columns.map(([key,label])=><section key={key}><h3>{label}</h3>{filtered.filter(r=>botBoardBucket(r,seen[r.key])===key).map(card)}</section>)}</div>
      {!filtered.length&&!error&&<Empty className="ln-empty--inline"><EmptyHeader><EmptyMedia variant="icon"><Icon name={rows.length?'search':'board'} size={18}/></EmptyMedia><EmptyTitle>{rows.length?'没有匹配的助手':'还没有助手'}</EmptyTitle><EmptyDescription>{rows.length?'换一个关键词，或清除搜索和状态筛选。':'先创建一位助手；看板会按需要你、进行中、待查看分组。'}</EmptyDescription></EmptyHeader><EmptyContent>{rows.length?<button type="button" onClick={()=>{setQuery('');setFilter('all')}}>清除筛选</button>:<button type="button" onClick={onCreate}>新建助手</button>}</EmptyContent></Empty>}
      <details><summary>空闲 {rows.filter(r=>botBoardBucket(r,seen[r.key])==='idle').length} · 离线 {rows.filter(r=>botBoardBucket(r,seen[r.key])==='offline').length}</summary>{filtered.filter(r=>['idle','offline'].includes(botBoardBucket(r,seen[r.key]))).map(card)}</details>
    </section>
  </SurfaceDialog>
}

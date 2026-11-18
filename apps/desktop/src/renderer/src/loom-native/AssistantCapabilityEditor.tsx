import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BusinessEnvironment } from '../business-environment'
import type { AgentProfile } from './types'
import { conflictTools, highRiskToConfirm, hookReviewSnapshot, itemKey, pendingHookReview, sameSelection, selectionsOf,
  type CapabilityCatalog, type HookReviewSnapshot } from '../member-catalog-model'
import { createCapabilityPort } from './capability-service'
import { AssistantCapabilityPicker } from './AssistantCapabilityPicker'
import { FormMessage, SurfaceDialog } from './Controls'
import { Icon } from './icons'
import { HookScopeSummary } from './HookScopeSummary'

/** Existing assistants use the same discovery/import surface as creation. */
export function AssistantCapabilityEditor({ environment, agent, theme, threadId, onDirtyChange, onBusyChange, onSaved }: {
  environment: BusinessEnvironment; agent: AgentProfile; theme: 'day' | 'night'; threadId?: string
  onDirtyChange?(dirty:boolean):void; onBusyChange?(busy:boolean):void; onSaved?():void
}) {
  const port=useMemo(()=>createCapabilityPort(environment.client,threadId),[environment.client,threadId])
  const [catalog,setCatalog]=useState<CapabilityCatalog|null>(null)
  const catalogRef=useRef<CapabilityCatalog|null>(null)
  const catalogScope=useRef(threadId)
  const [keys,setKeys]=useState<string[]>([])
  const [saving,setSaving]=useState(false)
  const [importing,setImporting]=useState(false)
  const [error,setError]=useState('')
  const [saved,setSaved]=useState(false)
  const [conflict,setConflict]=useState(false)
  const [epoch,setEpoch]=useState(0)
  const reviewGeneration=useRef(0)
  const saveGeneration=useRef(0)
  useEffect(()=>{saveGeneration.current++;setSaving(false);return()=>{saveGeneration.current++}},[port])
  const [review,setReview]=useState<HookReviewSnapshot|null>(null)
  const [preview,setPreview]=useState<'idle'|'reading'|'ready'|'unsupported'|'error'>('idle')
  const selected=new Set(keys)
  const items=useMemo(()=>catalog?.items.map(item=>({...item,selected:item.kind==='skill'&&item.source==='工具箱'?item.selected:selected.has(itemKey(item))}))??[],[catalog,keys])
  const dirty=!!catalog&&!sameSelection(catalog.items,items)
  const callbacks=useRef({onDirtyChange,onBusyChange,onSaved});callbacks.current={onDirtyChange,onBusyChange,onSaved}
  useEffect(()=>{callbacks.current.onDirtyChange?.(dirty);return()=>callbacks.current.onDirtyChange?.(false)},[dirty])
  useEffect(()=>{callbacks.current.onBusyChange?.(saving||importing);return()=>callbacks.current.onBusyChange?.(false)},[saving,importing])
  const readCatalog=useCallback((next:CapabilityCatalog)=>{
    const before=catalogRef.current
    if(before&&catalogScope.current!==threadId){
      reviewGeneration.current++;setReview(null);setConflict(true);setError('工作位置已改变。你的选择仍保留，请重新读取后确认。');return
    }
    if(before&&!sameSelection(before.items,next.items)){
      setConflict(true);setError('这个助手的能力被其他操作更新了。你的选择仍保留，请核对后重新读取。');return
    }
    catalogScope.current=threadId;catalogRef.current=next;setCatalog(next);reviewGeneration.current++;setReview(null)
    if(!before)setKeys(next.items.filter(item=>item.selected&&!(item.kind==='skill'&&item.source==='工具箱')).map(itemKey))
  },[threadId])
  const select=(next:string[])=>{setKeys(next);setSaved(false);setError('');setPreview('idle')}
  const reload=()=>{catalogRef.current=null;setCatalog(null);setKeys([]);setConflict(false);setError('');setReview(null);setEpoch(value=>value+1)}
  const submit=async(snapshot?:HookReviewSnapshot)=>{
    if(!catalog||saving||importing||conflict)return
    if(catalogScope.current!==threadId){setReview(null);setConflict(true);setError('工作位置已改变，请重新读取后确认。');return}
    if(snapshot&&(snapshot.agentId!==agent.agentId||snapshot.revision!==catalog.revision||snapshot.token!==reviewGeneration.current)){
      setReview(null);setError('能力内容或运行范围已改变，请重新确认。');return
    }
    const ticket=++saveGeneration.current
    setSaving(true);setError('')
    try{
      const next=await port.save(catalog,items,snapshot)
      if(ticket!==saveGeneration.current)return
      catalogRef.current=next;setCatalog(next);setKeys(next.items.filter(item=>item.selected&&!(item.kind==='skill'&&item.source==='工具箱')).map(itemKey));setReview(null);setSaved(true);reviewGeneration.current++;setEpoch(value=>value+1);callbacks.current.onSaved?.()
    }catch(cause){if(ticket===saveGeneration.current)setError(cause instanceof Error?cause.message:'保存失败，选择已保留。')}finally{if(ticket===saveGeneration.current)setSaving(false)}
  }
  const save=()=>{
    if(!catalog||saving||conflict)return
    if(conflictTools(items).length){setError('选中的能力有同名工具冲突，请关闭一个冲突项。');return}
    const risky=highRiskToConfirm(items,catalog.items),pending=pendingHookReview(items)
    if(!risky.length&&!pending.length){void submit();return}
    const snapshot=hookReviewSnapshot({agentId:agent.agentId,revision:catalog.revision,token:reviewGeneration.current,acknowledgeHighRisk:risky.length>0,selections:selectionsOf(items),pending})
    if(!snapshot){setError('完整的 Hook 正文或范围无法确认，未授予权限。');return}
    setReview(snapshot)
  }
  const inspect=async()=>{
    if(!catalog||dirty)return
    setPreview('reading')
    const result=await port.preview(agent.agentId,catalog.runtime)
    setPreview(result.status)
  }
  return <section className="ln-capability-editor" aria-label={`${agent.displayName}的能力`}>
    <AssistantCapabilityPicker key={`${agent.agentId}:${epoch}`} environment={environment} threadId={threadId} catalogAgentId={agent.agentId} runtime={agent.runtimeConfiguration?.adapterKind??null} selectedKeys={keys} onSelection={select} theme={theme} disabled={saving||conflict} onBusyChange={setImporting} onCatalogue={readCatalog}/>
    {error&&<FormMessage error>{error}</FormMessage>}{conflict&&<button type="button" className="ln-action" onClick={reload}>放弃本地修改并重新读取</button>}
    {saved&&!dirty&&<FormMessage>能力选择已保存，下一次运行采用新配置。是否真正加载以执行记录为准。</FormMessage>}
    {preview==='ready'&&<FormMessage>下一次配置已生成。该检查不代表模型或工具已经实际执行。</FormMessage>}
    {preview==='unsupported'&&<FormMessage>当前运行端不提供统一配置预览；没有将它标为已生效。</FormMessage>}
    {preview==='error'&&<FormMessage error>预览未完成，已保存的选择没有改变。</FormMessage>}
    <footer className="ln-cap-editor-footer"><span><Icon name={dirty?'clock':'check'} size={13}/>{dirty?'修改尚未保存':`${keys.length} 项已选`}</span><button type="button" className="ln-action" disabled={!catalog||dirty||saving||importing||preview==='reading'} onClick={()=>{void inspect()}}>检查下次配置</button><button type="button" className="ln-action is-primary" disabled={!dirty||saving||importing||conflict} onClick={save}>{saving?'保存中…':'保存能力'}</button></footer>
    <SurfaceDialog open={review!==null} title="确认能力权限" description="仅授权列出的助手、内容和工作范围。" theme={theme} onClose={()=>{if(!saving)setReview(null)}} className="ln-room-dialog"><div className="ln-room-content">{review&&<>{highRiskToConfirm(items,catalog?.items??[]).map(item=><div className="ln-review-card" key={itemKey(item)}><h3>{item.name}</h3><p>{item.note||'可能执行命令或访问外部资源。'}</p></div>)}{review.entries.map(entry=><div className="ln-review-card" key={entry.id}><h3>{entry.name}</h3><HookScopeSummary scope={entry.scope}/><pre>{entry.body}</pre></div>)}<footer className="ln-form-actions"><button type="button" className="ln-action" disabled={saving} onClick={()=>setReview(null)}>取消</button><button type="button" className="ln-action is-primary" disabled={saving} onClick={()=>{void submit(review)}}>确认并保存</button></footer></>}</div></SurfaceDialog>
  </section>
}

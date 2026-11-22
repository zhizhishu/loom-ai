// One list, no state filter or device selector. Keep transport terminology out of UI.
import { useEffect, useRef, useState } from 'react'
import type { StoredCommandResult } from '@contracts'
import type { ThreadClient } from '../camp-client'
import { SurfaceDialog } from './Controls'
import { deleteOutbox, readOutbox, updateOutbox, type PendingRecord } from './pending-outbox-store'
import { settleOutboxAttempt } from './service'
import './pending-inbox.css'
export function PendingInbox({open,client,threadIds,onClose,theme='day'}:{
  open:boolean;client:ThreadClient;threadIds:string[];onClose():void;theme?:'day'|'night'
}) {
  const [rows,setRows]=useState<PendingRecord[]>([])
  const [errors,setErrors]=useState<Record<string,string>>({})
  const [loadError,setLoadError]=useState('')
  const [busy,setBusy]=useState<string|null>(null)
  const epoch=useRef(0)
  const inFlight=useRef(false)
  const signature=JSON.stringify(threadIds)
  useEffect(()=>{
    const current=++epoch.current
    setRows([]);setErrors({});setLoadError('');setBusy(null)
    if(!open)return
    const reload=()=>{
      try{const next=threadIds.flatMap(id=>readOutbox(id).slice(0,50))
        if(current===epoch.current){setRows(next);setLoadError('')}
      }catch(cause){setRows([]);setLoadError(String(cause))}
    }
    reload();window.addEventListener('loom-outbox-changed',reload)
    return()=>{epoch.current++;window.removeEventListener('loom-outbox-changed',reload)}
  },[open,client,signature])
  const run=async(row:PendingRecord,action:'send'|'check'|'delete')=>{
    if(inFlight.current)return
    inFlight.current=true;setBusy(row.id)
    const current=epoch.current
    try{
      if(action==='delete')deleteOutbox(row)
      else {
        let command:StoredCommandResult|null=null
        if(action==='send'){
          updateOutbox(row,'sending')
          const result=await client.request<{commandResult:StoredCommandResult}>('thread.messages.send',row.params)
          command=result?.commandResult??null
          if(!command)throw new Error('可能已送达，请检查。')
        }else{
          const result=await client.request<{state:string;result?:{commandResult:StoredCommandResult}}>('commands.reconcile',{operation:'thread.messages.send',params:row.params})
          command=result.state==='recorded'?result.result?.commandResult??null:null
          if(!command){
            if(current===epoch.current)updateOutbox(row,'pending')
            return
          }
        }
        if(current!==epoch.current)return
        const state=command.status==='accepted'||command.status==='applied'?'accepted':command.status==='rejected'?'rejected':'unconfirmed'
        updateOutbox(row,state,state==='rejected'?'发送未被接受，请检查消息内容。':undefined)
        if(state==='accepted')settleOutboxAttempt(client,row.threadId,row.commandId)
      }
    }catch(cause){
      if(current===epoch.current){
        if(action==='send')try{updateOutbox(row,'unconfirmed')}catch{/* Preserve prior durable state. */}
        setErrors(e=>({...e,[row.id]:String(cause)}))
      }
    }finally{inFlight.current=false;if(current===epoch.current)setBusy(null)}
  }
  return <SurfaceDialog open={open} onClose={onClose} theme={theme} title="待发送" description="离线时保留、尚未确认送达的消息">
    <PendingInboxList rows={rows} errors={errors} busy={!!busy} loadError={loadError} onAction={(row,action)=>void run(row,action)}/>
  </SurfaceDialog>
}

export function PendingInboxList({rows,errors={},busy=false,loadError='',onAction}:{
  rows:PendingRecord[];errors?:Record<string,string>;busy?:boolean;loadError?:string
  onAction(row:PendingRecord,action:'send'|'check'|'delete'):void
}) {
  const card=(row:PendingRecord)=><article key={row.id}><p>{row.text}</p><small>{row.state==='pending'?'还没发出':row.state==='sending'?'正在发送…':row.state==='unconfirmed'?'可能已送达，待确认':row.state==='rejected'?'发送失败：'+(row.error||'请检查内容'):'已送达'}</small>
    {row.state==='pending'&&<><button type="button" disabled={busy} onClick={()=>onAction(row,'send')}>发送</button><button type="button" disabled={busy} onClick={()=>onAction(row,'delete')}>删除</button></>}
    {['unconfirmed','rejected'].includes(row.state)&&<button type="button" disabled={busy} onClick={()=>onAction(row,'check')}>{row.state==='rejected'?'再检查一次':'检查是否送达'}</button>}
    {errors[row.id]&&<p role="alert">{errors[row.id]}</p>}</article>
  return <section className="ln-pending-inbox">{loadError&&<p role="alert">{loadError}</p>}
      {!rows.length&&!loadError&&<><h3>没有待发送的消息</h3><p>离线时发出的消息会暂存在这里，联网后可以继续发送。</p></>}
      <p>不会自动重发。附件不能稍后自动重发，请重新选择文件。</p>
      {rows.filter(r=>r.state!=='accepted').map(card)}
      <details><summary>已完成 ({rows.filter(r=>r.state==='accepted').length})</summary>{rows.filter(r=>r.state==='accepted').map(card)}</details>
    </section>
}

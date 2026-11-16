import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThreadSnapshot } from '@contracts'
import { SurfaceDialog } from './Controls'
import { V2BotStatusPanel } from './V2BotStatusPanel'
import { readV2RunFacts, type V2RunFacts, type V2RunPort } from './v2-run-service'
import type { ArtifactSelection, WorkBundle } from './types'

type Snapshot = { scope:string; port:V2RunPort; facts:V2RunFacts; bundle:WorkBundle }
type ReadInput = {
  open:boolean; scope:string|null; port:V2RunPort; bundle:WorkBundle|null;
  thread:ThreadSnapshot|null; retry:number; version:number; timeoutMs:number
}

/** A coherent snapshot is retained while a same-work refresh is pending. Polling
 * changes are coalesced instead of cancelling every read: a slow Host must not
 * be starved by a faster parent refresh. New work never renders old work data. */
export function RunStatusDialog({ open, port, bundle, thread, theme, onClose, onArtifact, onCreateWork, readTimeoutMs=15000 }: {
  open:boolean; port:V2RunPort; bundle:WorkBundle|null; thread:ThreadSnapshot|null
  theme:'day'|'night'; readTimeoutMs?:number; onClose():void; onArtifact(selection:ArtifactSelection):void; onCreateWork?():void
}) {
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null)
  const [busy,setBusy]=useState(false)
  const [failure,setFailure]=useState<{scope:string;port:V2RunPort;message:string}|null>(null)
  const [retry,setRetry]=useState(0)
  const tickets=useRef(0)
  const active=useRef<{ticket:number;scope:string;port:V2RunPort}|null>(null)
  const mounted=useRef(true)
  const opener=useRef<HTMLElement|null>(null)
  const failedRead=useRef<{scope:string;port:V2RunPort;retry:number}|null>(null)
  const timeoutMs=Number.isFinite(readTimeoutMs)?Math.min(60000,Math.max(100,readTimeoutMs)):15000
  const threadMatches=!!bundle && !!thread && bundle.mission.threadId===thread.thread.id
  const scope=threadMatches ? `${bundle!.mission.missionId}\0${thread!.thread.id}` : null
  const latest=useRef<ReadInput>({open,scope,port,bundle,thread,retry,version:0,timeoutMs})
  const previous=latest.current
  if (previous.open!==open || previous.scope!==scope || previous.port!==port || previous.bundle!==bundle || previous.thread!==thread || previous.retry!==retry || previous.timeoutMs!==timeoutMs) {
    latest.current={open,scope,port,bundle,thread,retry,version:previous.version+1,timeoutMs}
  }
  const current=snapshot && snapshot.port===port && snapshot.scope===scope ? snapshot : null
  const error=failure && failure.port===port && failure.scope===scope ? failure.message : null

  const beginRead=useCallback(function startLatestRead():void {
    const input=latest.current
    if (!mounted.current) return
    if (!input.open || input.scope===null || input.bundle===null || input.thread===null) {
      active.current=null
      tickets.current+=1
      setBusy(false)
      return
    }
    if (failedRead.current?.scope===input.scope && failedRead.current.port===input.port && failedRead.current.retry===input.retry) return
    if (active.current?.scope===input.scope && active.current.port===input.port) return
    const {scope:readScope,bundle:readBundle,thread:readThread,port:readPort}=input
    const ticket=++tickets.current
    active.current={ticket,scope:readScope,port:readPort}
    setBusy(true)
    setFailure(null)
    failedRead.current=null
    const relevant=():boolean=>mounted.current && latest.current.open && latest.current.scope===readScope && latest.current.port===readPort && active.current?.ticket===ticket
    const request=readV2RunFacts({port:readPort,declaration:null,claimsAccess:'observe-readonly',missionId:readBundle.mission.missionId,bundle:readBundle,thread:readThread,
      preferredFor:artifact=>readBundle.candidates.find(candidate=>candidate.taskId===artifact.taskId && candidate.evidenceIds.includes(artifact.artifactId))??null
    })
    let timer:ReturnType<typeof setTimeout>|undefined
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('读取超时，请重试；保留的旧记录不会被当作新回执。')),input.timeoutMs)})
    void Promise.race([request,deadline]).then(facts=>{
      if (relevant()) setSnapshot({scope:readScope,port:readPort,facts,bundle:readBundle})
    }).catch(cause=>{
      if (relevant()) {
        failedRead.current={scope:readScope,port:readPort,retry:input.retry}
        setFailure({scope:readScope,port:readPort,message:cause instanceof Error?cause.message:'暂时无法读取工作记录'})
      }
    }).finally(()=>{
      if(timer!==undefined)clearTimeout(timer)
      if (active.current?.ticket!==ticket || !mounted.current) return
      active.current=null
      if (latest.current.open && latest.current.scope===readScope && latest.current.port===readPort && latest.current.version!==input.version && failedRead.current===null) {
        startLatestRead()
      } else {
        setBusy(false)
      }
    })
  },[])

  useEffect(()=>{
    mounted.current=true
    return ()=>{mounted.current=false;active.current=null;tickets.current+=1}
  },[])
  useEffect(()=>{beginRead()},[open,scope,port,bundle,thread,retry,timeoutMs,beginRead])

  return <SurfaceDialog open={open} title="运行与成果" theme={theme} onClose={onClose} className="ln-run-dialog"
    onOpenAutoFocus={()=>{opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null}}
    onCloseAutoFocus={event=>{if(opener.current?.isConnected){event.preventDefault();opener.current.focus({preventScroll:true})}}}>
    {!bundle ? <div className="ln-run-state"><p>选择一项工作，查看助手分工、执行记录和成果。</p>{onCreateWork && <button type="button" onClick={onCreateWork}>创建一项工作</button>}</div>
      : !threadMatches ? <div className="ln-run-state" role="status">正在对齐当前工作的对话记录，暂不显示其他工作的内容。</div>
      : <>
        <div className="ln-run-toolbar"><span role="status">{busy ? current?'正在更新，保留上次读到的记录…':'正在读取工作记录…' : error?'更新未成功':'当前工作的主机记录'}</span>
          <button type="button" disabled={busy} onClick={()=>setRetry(value=>value+1)} aria-label="刷新运行与成果">{error?'重试读取':'刷新'}</button></div>
        {error && <div className="ln-run-state" role="alert">读取失败：{error}{current && <p>以下保留的是上次成功读取的内容。</p>}</div>}
        {current ? <V2BotStatusPanel facts={current.facts} bundle={current.bundle} onArtifact={onArtifact}/>
          : !busy && !error ? <p className="ln-run-state">尚未读取到这项工作的记录。</p> : null}
      </>}
  </SurfaceDialog>
}

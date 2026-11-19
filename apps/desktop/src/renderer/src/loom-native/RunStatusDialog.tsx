import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentProfile, ThreadSnapshot } from '@contracts'
import { SurfaceDialog } from './Controls'
import { ControlPanel } from './ControlPanel'
import type { ControlAttempt } from './control-service'
import { V2BotStatusPanel } from './V2BotStatusPanel'
import { readV2RunFacts, type V2RunFacts, type V2RunPort } from './v2-run-service'
import type { ArtifactSelection, WorkBundle } from './types'

type Snapshot = { scope:string; port:V2RunPort; facts:V2RunFacts; bundle:WorkBundle; readToken:number }
type ReadInput = {
  open:boolean; scope:string|null; port:V2RunPort; bundle:WorkBundle|null;
  thread:ThreadSnapshot|null; retry:number; version:number; timeoutMs:number
}

/** A coherent snapshot is retained while a same-work refresh is pending. Polling
 * changes are coalesced instead of cancelling every read: a slow Host must not
 * be starved by a faster parent refresh. New work never renders old work data. */
export function RunStatusDialog({ open, port, bundle, thread, agents = [], theme, onClose, onArtifact, onCreateWork, onRefreshWork, readTimeoutMs=15000 }: {
  open:boolean; port:V2RunPort; bundle:WorkBundle|null; thread:ThreadSnapshot|null
  /** 当前线程的真实成员档案：独立审查者只能在这些成员里选，不由本组件编造。
   * 缺省空数组只服务旧的合成渲染夹具，不推举任何默认审查者。 */
  agents?:AgentProfile[]
  theme:'day'|'night'; readTimeoutMs?:number; onClose():void; onArtifact(selection:ArtifactSelection):void; onCreateWork?():void
  /** An explicit refresh re-reads the Mission's tasks/candidates before V2 facts. */
  onRefreshWork?():Promise<void>
}) {
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null)
  const [busy,setBusy]=useState(false)
  const [refreshingWork,setRefreshingWork]=useState(false)
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
  // Keep the *same Mission's* local-only scope editor mounted while its
  // latest WorkBundle/thread projection is being refreshed. Unmounting it on
  // a transient read gap discards the user's checkbox/reviewer draft even
  // before any Core write. A different Mission never inherits the editor.
  const retained=snapshot && bundle && snapshot.port===port
    && snapshot.bundle.mission.missionId===bundle.mission.missionId
    && snapshot.bundle.mission.threadId===bundle.mission.threadId ? snapshot : null
  const error=failure && failure.port===port && failure.scope===scope ? failure.message : null
  // 未确认的接力写入只存 UI 请求意图（不是业务事实），按 port 实例隔离：换端口/退出即自然清空。
  // 存在这里而不是 ControlPanel 内部，关掉对话框、切走再切回都不会丢同一个 commandId。
  const attemptStore=useMemo(()=>({port,map:new Map<string,ControlAttempt>()}),[port])
  const [,bumpAttemptStore]=useState(0)
  const controlScope=retained===null || bundle===null ? null : {
    missionId:bundle.mission.missionId,
    threadId:bundle.mission.threadId,
    tasks:bundle.tasks
  }
  const setControlAttempt=(missionId:string,next:ControlAttempt|null):void=>{
    if(next===null)attemptStore.map.delete(missionId)
    else attemptStore.map.set(missionId,next)
    bumpAttemptStore(value=>value+1)
  }

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
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('读取超时，请重试。')),input.timeoutMs)})
    void Promise.race([request,deadline]).then(facts=>{
      // Publish the completed facts with the exact bundle they were read from.
      // A queued update follows below; requiring a quiet parent here would
      // starve the UI while active assistants keep invalidating their records.
      if (relevant()) {
        setSnapshot({scope:readScope,port:readPort,facts,bundle:readBundle,readToken:ticket})
      }
    }).catch(cause=>{
      if (relevant()) {
        failedRead.current={scope:readScope,port:readPort,retry:latest.current.retry}
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

  const refreshVisibleWork = async ():Promise<void> => {
    if (busy || refreshingWork) return
    const requestedScope=scope
    const requestedPort=port
    setRefreshingWork(true)
    try {
      // V2 facts alone do not contain a fresh plan. The parent owns the
      // WorkBundle cache; an explicit UI click may refresh it, not silently
      // approve or dispatch anything.
      if(onRefreshWork) await onRefreshWork()
      if(latest.current.open && latest.current.scope===requestedScope && latest.current.port===requestedPort) {
        setRetry(value=>value+1)
      }
    } catch(cause) {
      if(latest.current.open && latest.current.scope===requestedScope && latest.current.port===requestedPort) {
        setFailure({scope:requestedScope??'',port:requestedPort,message:cause instanceof Error?cause.message:'工作资料刷新失败'})
      }
    } finally {
      if(mounted.current) setRefreshingWork(false)
    }
  }

  return <SurfaceDialog open={open} title="运行与成果" theme={theme} onClose={onClose} className="ln-run-dialog"
    onOpenAutoFocus={()=>{opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null}}
    onCloseAutoFocus={event=>{if(opener.current?.isConnected){event.preventDefault();opener.current.focus({preventScroll:true})}}}>
    {!bundle ? <div className="ln-run-state"><p>选择一项工作，查看助手分工、执行记录和成果。</p>{onCreateWork && <button type="button" onClick={onCreateWork}>创建一项工作</button>}</div>
      : !threadMatches ? <div className="ln-run-state" role="status">正在加载工作记录…</div>
      : <>
        <div className="ln-run-toolbar"><span role="status">{busy || refreshingWork ? current?'正在更新…':'正在读取工作记录…' : error?'更新失败':'工作记录'}</span>
          <button type="button" disabled={busy || refreshingWork} onClick={()=>{void refreshVisibleWork()}} aria-label="刷新运行与成果">{error?'重试读取':'刷新'}</button></div>
        {error && <div className="ln-run-state" role="alert">读取失败：{error}{current && <p>当前显示上次的记录。</p>}</div>}
        {current ? <V2BotStatusPanel facts={current.facts} bundle={current.bundle} onArtifact={onArtifact}/>
          : !busy && !error ? <p className="ln-run-state">尚未读取到这项工作的记录。</p> : null}
      </>}
    {controlScope && <div hidden={!threadMatches} aria-hidden={!threadMatches}>
      {/* This is only a local editor while the Thread is aligned. The Core
          remains the sole authority for permissions, revisions and writes. */}
      <ControlPanel missionId={controlScope.missionId} threadId={controlScope.threadId}
        thread={threadMatches?thread:null} tasks={controlScope.tasks} agents={agents}
        port={port} theme={theme} refreshToken={retained?.readToken ?? retry}
        attempt={attemptStore.map.get(controlScope.missionId) ?? null}
        onAttempt={next=>setControlAttempt(controlScope.missionId,next)}/>
    </div>}
  </SurfaceDialog>
}

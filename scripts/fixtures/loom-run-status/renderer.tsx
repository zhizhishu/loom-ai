import { useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentProfile, CoreMethod, MissionRecord, ThreadSnapshot, LoomReviewRecordInput, LoomReviewRecordReceipt } from '@contracts'
import type { ArtifactSelection, WorkBundle } from '../../../apps/desktop/src/renderer/src/loom-native/types'
import { ThreadClientProvider, type ThreadClient } from '../../../apps/desktop/src/renderer/src/camp-client'
import { RunStatusDialog } from '../../../apps/desktop/src/renderer/src/loom-native/RunStatusDialog'
import { ArtifactView } from '../../../apps/desktop/src/renderer/src/loom-native/ArtifactView'
import { refreshArtifactSelection } from '../../../apps/desktop/src/renderer/src/loom-native/artifact-service'
import '../../../apps/desktop/src/renderer/src/loom-native/native.css'
import '../../../apps/desktop/src/renderer/src/loom-native/product.css'

// Synthetic transport only. This renders production React and styling but never
// opens a real Core, SQLite, Runtime, account, or daily application profile.
const now = '2026-11-15T01:00:00Z'
const claimReceipt = (id: string) => ({ evaluatedAt: now, claims: [{
  claimId:'claim-'+id, taskId:'task-'+id, agentRunId:'run-'+id, claimantAgentId:'hanzi',
  fenceGeneration:1, claimedAt:now, leaseExpiresAt:'2026-11-15T02:00:00Z', releasedAt:null, expired:false
}] })
let mode = 'success'
let reviewMode = 'success'
const calls: string[] = []
const writes: LoomReviewRecordInput[] = []
// 自动接力范围的合成读取：只读投影，无任何 control 写入（写入会直接抛错）。
const controlReads: string[] = []
const reviewReceipts = new Map<string, LoomReviewRecordReceipt>()
const pending = new Map<string, (result:unknown)=>void>()
const request = async<T,>(method:CoreMethod, params?:Record<string,unknown>):Promise<T> => {
  if (method === 'preferences.tasks.get') return { enabled:false, headsUpAfterSequence:0, observedThroughChangeSequence:0 } as T
  if (method === 'loom.artifact.preview') return { text:'# 发布页面检查说明\n\n已核对桌面与手机布局。此正文来自明确标记的合成验收传输层。', unavailableReason:null } as T
  if (method === 'loom.review.record') {
    const input = JSON.parse(JSON.stringify(params)) as LoomReviewRecordInput
    writes.push(input)
    const previous = reviewReceipts.get(input.commandId)
    if (previous) return { ...previous, replayed:true } as T
    const result:LoomReviewRecordReceipt = {
      missionId:input.missionId, planId:'plan-'+input.missionId, taskId:input.taskId,
      taskStatus:input.verdict==='accepted'?'done':'ready', candidateAcceptanceStatus:input.verdict,
      releasedDependencyIds:[], replayed:false,
      review:{ reviewId:'review-'+input.commandId, candidateId:input.candidateId,
        acceptanceCriteriaVersion:input.acceptanceCriteriaVersion, verdict:input.verdict, reason:input.reason,
        criteriaResults:input.criteriaResults, reviewerId:'synthetic-ui-test-owner', reviewedAt:now }
    }
    reviewReceipts.set(input.commandId, result)
    if (reviewMode === 'lose-once') { reviewMode='success'; throw new Error('Fixture receipt lost after commit') }
    return result as T
  }
  if (method === 'loom.control.get') {
    const missionId=(params as {missionId:string}).missionId
    controlReads.push(missionId)
    return { missionId, policy:null, stageReviews:[], dispatches:[], evaluatedAt:now } as T
  }
  if (method !== 'loom.claims.list') throw new Error('Unexpected method '+method)
  const id=(params as {missionId:string}).missionId
  calls.push(id)
  if (mode==='failure') throw new Error('Fixture connection unavailable')
  if (mode==='deferred') return await new Promise<unknown>(resolve=>pending.set(id,resolve)) as T
  return claimReceipt(id) as T
}
const client = { request, platform:'win32' } as unknown as ThreadClient
// 真实成员档案的合成替身：独立审查者只能从当前 Thread 的活跃成员里选。
const controlAgents = [
  {agentId:'hanzi',displayName:'Hanzi',teamRole:'实现',presence:'present',removedAt:null,avatarRef:null,accent:null},
  {agentId:'linxi',displayName:'Linxi',teamRole:'审查',presence:'present',removedAt:null,avatarRef:null,accent:null}
] as unknown as AgentProfile[]
const criteria = { version:'criteria-1', criteria:[{criterionId:'responsive',text:'桌面与手机布局均已检查'}] }
const bundle=(id:string):WorkBundle=>{
  const review = [...reviewReceipts.values()].find(value=>value.missionId===id)
  return {
    mission:{missionId:id,threadId:'thread-'+id,title:id==='A'?'为新产品准备发布页面':'复核接口的异常与恢复',description:'实现页面并独立检查；成果需要你最后确认。',status:'in_progress',defaultLeadAgentId:'hanzi',memberAgentIds:['hanzi','linxi']} as MissionRecord,
    plan:null,
    tasks:[{taskId:'task-'+id,planId:'plan-'+id,title:'实现首屏与手机布局',description:'',assigneeAgentId:'hanzi',status:review?.taskStatus??'in_review',blockedReason:null,createdAt:now,updatedAt:now,revision:1,acceptanceCriteria:criteria}],
    candidates:[{candidateId:'candidate-'+id,taskId:'task-'+id,agentRunId:'run-'+id,contentHash:'hash-'+id,evidenceIds:['artifact-'+id],acceptanceCriteria:criteria,previousCandidateId:null,verificationStatus:'unverified',acceptanceStatus:review?.candidateAcceptanceStatus??'pending',createdAt:now}],
    artifacts:[{artifactId:'artifact-'+id,planId:'plan-'+id,taskId:'task-'+id,agentRunId:'run-'+id,relativePath:'output/发布页面检查说明.md',sha256:'a'.repeat(64),sizeBytes:1024,contentType:'text/markdown',creatorId:'hanzi',createdAt:now}],
    reviews:review?[review.review]:[],verifications:[]
  }
}
const thread=(id:string):ThreadSnapshot=>({
  thread:{id:'thread-'+id,defaultLeadAgentId:'hanzi'},
  members:[{agentId:'hanzi',displayName:'Hanzi',teamRole:'实现',isDefaultLead:true,membershipStatus:'active',profilePresence:'present'},
    {agentId:'linxi',displayName:'Linxi',teamRole:'审查',isDefaultLead:false,membershipStatus:'active',profilePresence:'present'}],
  agentRuns:[{id:'run-'+id,agentId:'hanzi',taskId:'task-'+id,status:'succeeded',startedAt:now,endedAt:now}]
} as unknown as ThreadSnapshot)

function Fixture() {
  const [id,setId]=useState('A')
  const [epoch,setEpoch]=useState(0)
  const [open,setOpen]=useState(false)
  const [theme,setTheme]=useState<'day'|'night'>('day')
  const [selected,setSelected]=useState('')
  const [empty,setEmpty]=useState(false)
  const [openArtifacts,setOpenArtifacts]=useState(false)
  const [readTimeoutMs,setReadTimeoutMs]=useState(15000)
  const [artifact,setArtifact]=useState<ArtifactSelection|null>(null)
  const [data,setData]=useState(()=>({bundle:bundle('A'),thread:thread('A')}))
  const opener=useRef<HTMLElement|null>(null)
  const currentArtifact=useMemo(()=>artifact===null?null:refreshArtifactSelection(artifact,[data.bundle]),[artifact,data.bundle])
  const refresh=async()=>{setEpoch(x=>x+1);setData({bundle:bundle(id),thread:thread(id)})}
  window.runStatusQA={
    calls,controlReads,writes,setTheme,setMode:value=>{mode=value},setReviewMode:value=>{reviewMode=value},setReadTimeoutMs,
    refresh:()=>{void refresh()},switchWork:next=>{setId(next);setData({bundle:bundle(next),thread:thread(next)})},
    release:key=>{const resolve=pending.get(key);pending.delete(key);resolve?.(claimReceipt(key))},
    releaseExpired:key=>{const resolve=pending.get(key);pending.delete(key);const value=claimReceipt(key);value.claims[0].expired=true;resolve?.(value)},
    setEmpty,selected:()=>selected,epoch:()=>epoch,setOpenArtifacts,
    addArtifact:artifactId=>setData(old=>({...old,bundle:{...old.bundle,artifacts:[...old.bundle.artifacts,
      {...old.bundle.artifacts[0],artifactId,relativePath:'output/'+artifactId+'.md'}]}})),
    invalidateArtifact:()=>setData(old=>({...old,bundle:{...old.bundle,artifacts:old.bundle.artifacts.map(a=>({...a,sha256:'b'.repeat(64)}))}}))
  }
  return <ThreadClientProvider client={client}><div className="ln-app" data-theme={theme}>
    <header style={{padding:24}}><button id="open-runs" onClick={()=>{opener.current=document.activeElement as HTMLElement;setOpen(true)}}>打开运行与成果</button><p>独立交互验收 · 合成数据，不调用模型</p></header>
    <RunStatusDialog readTimeoutMs={readTimeoutMs} open={open} port={client} bundle={empty?null:data.bundle} thread={data.thread} agents={controlAgents} theme={theme}
      onClose={()=>setOpen(false)} onCreateWork={()=>setSelected('create-work')}
      onArtifact={selection=>{setSelected(selection.bundle.mission.missionId+':'+selection.artifact.artifactId);if(openArtifacts){setOpen(false);setArtifact(selection)}}}/>
    {artifact && <ArtifactView key={artifact.artifact.artifactId} selection={currentArtifact?.selection??artifact}
      contextAvailable={currentArtifact?.contextAvailable??false} theme={theme} fallbackFocus={opener.current}
      onClose={()=>setArtifact(null)} onRefresh={refresh}/>}
    <output id="selected" hidden>{selected}</output>
  </div></ThreadClientProvider>
}
declare global { interface Window { runStatusQA:{
  calls:string[];controlReads:string[];writes:LoomReviewRecordInput[];setTheme(value:'day'|'night'):void;setMode(value:string):void;
  setReviewMode(value:string):void;setReadTimeoutMs(value:number):void;releaseExpired(id:string):void;refresh():void;switchWork(id:string):void;release(id:string):void;
  setEmpty(value:boolean):void;selected():string;epoch():number;setOpenArtifacts(value:boolean):void;invalidateArtifact():void;addArtifact(id:string):void
} } }
createRoot(document.getElementById('root')!).render(<Fixture/>)

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CoreMethod, MissionRecord } from '@contracts'
import { ThreadClientProvider, type ThreadClient } from '../../../apps/desktop/src/renderer/src/camp-client'
import { ArtifactView } from '../../../apps/desktop/src/renderer/src/loom-native/ArtifactView'
import type { WorkBundle } from '../../../apps/desktop/src/renderer/src/loom-native/types'
import '../../../apps/desktop/src/renderer/src/loom-native/native.css'
import '../../../apps/desktop/src/renderer/src/loom-native/product.css'

declare global { interface Window { loomQaCore: {
  request<T>(method:string, params?:Record<string,unknown>):Promise<T>
} } }
const query=new URLSearchParams(location.search)
const missionId=query.get('missionId')??''
const firstArtifactId=query.get('artifactId')??''

function Fixture(){
 const [bundle,setBundle]=useState<WorkBundle|null>(null)
 const [error,setError]=useState<string|null>(null)
 const [open,setOpen]=useState(false)
 // Stable authenticated client identity: the immutable attempt registry is scoped to this client.
 const client=useMemo(()=>({
  platform:'win32',
  request:<T,>(method:CoreMethod,params?:Record<string,unknown>)=>window.loomQaCore.request<T>(method,params)
 }) as unknown as ThreadClient,[])
 const refresh=useCallback(async()=>{
  if(!missionId)throw new Error('fixture missionId missing')
  const [tasks,candidates,artifactResult,reviews]=await Promise.all([
   client.request<any>('loom.tasks.list',{missionId}),
   client.request<any>('loom.candidates.list',{missionId}),
   client.request<any>('loom.artifacts.list',{missionId}),
   client.request<any>('loom.reviews.list',{missionId})
  ])
  if(!Array.isArray(tasks)||!Array.isArray(candidates)||!Array.isArray(artifactResult?.artifacts)||!Array.isArray(reviews))
   throw new Error('Real Core returned an invalid WorkBundle')
  setBundle({mission:{missionId} as MissionRecord,plan:null,tasks,candidates,
   artifacts:artifactResult.artifacts,reviews,verifications:[]})
 },[client])
 useEffect(()=>{void refresh().catch(e=>setError(String(e)))},[refresh])
 const selected=useMemo(()=>{
  if(!bundle)return null
  const artifact=bundle.artifacts.find(row=>row.artifactId===firstArtifactId)
  if(!artifact)return null
  const candidate=bundle.candidates.find(row=>row.evidenceIds.includes(artifact.artifactId))??null
  return {artifact,candidate,bundle}
 },[bundle])
 return <ThreadClientProvider client={client}><div className="ln-app" data-theme="day">
  <header style={{padding:24}}>
   <button id="open-review" disabled={!selected} onClick={()=>setOpen(true)}>打开待审成果</button>
   <span id="fixture-status">{error??(selected?'real-core-ready':'loading-core')}</span>
  </header>
  {selected&&open&&<ArtifactView key={selected.artifact.artifactId}
   selection={selected} contextAvailable={true} theme="day"
   onClose={()=>setOpen(false)}
   onRefresh={async()=>{await refresh()}} />}
 </div></ThreadClientProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture/>)

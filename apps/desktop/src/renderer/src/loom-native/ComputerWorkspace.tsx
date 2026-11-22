import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ThreadClient } from '../camp-client'
import type { AgentProfile } from './types'
import type { HostWorkbench } from './host-services'
import { ComputerPanel } from './ComputerPanel'
import { ChoiceMenu, FormMessage } from './Controls'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './EmptyState'
import { Icon } from './icons'

type Node = { nodeId: string; displayName: string; status: string; computerProtocolVersions: number[]; os: string | null }
/** Explicit target selection. Switching unmounts the previous view/lease first. */
export function ComputerWorkspace({workbench,client,agent,theme,onConnectDevice}:{workbench?:HostWorkbench;client?:ThreadClient;agent:AgentProfile|null;theme:'day'|'night';onConnectDevice?():void}) {
  const [nodeId,setNodeId]=useState('local')
  const [nodes,setNodes]=useState<Node[]>([])
  const [loading,setLoading]=useState(false)
  const [error,setError]=useState('')
  const load=useCallback(async()=>{
    if(!workbench?.computerNodes)return
    setLoading(true);setError('')
    try{setNodes(await workbench.computerNodes())}catch(cause){setError(cause instanceof Error?cause.message:'无法读取执行设备。')}finally{setLoading(false)}
  },[workbench])
  useEffect(()=>{void load()},[load])
  const selected=nodes.find(node=>node.nodeId===nodeId)
  const allowed=nodeId==='local'||!!selected&&selected.status==='online'&&selected.computerProtocolVersions.includes(1)
  const port=useMemo(()=>nodeId==='local'?workbench?.computer:allowed?workbench?.remoteComputer?.(nodeId):undefined,[workbench,nodeId,allowed])
  return <section className="ln-computer-workspace" aria-label="电脑与执行设备">
    <div className="ln-computer-target"><Icon name="computer" size={17}/><ChoiceMenu label="选择要查看的电脑" value={nodeId} onChange={setNodeId} theme={theme} choices={[{value:'local',label:'这台电脑',description:'LOOM 所连接的电脑'},...nodes.map(node=>({value:node.nodeId,label:node.displayName,description:node.status!=='online'?'设备离线':node.computerProtocolVersions.includes(1)?`${node.os||'远端'} · 支持电脑画面`:'可执行命令，暂无桌面',disabled:node.status!=='online'||!node.computerProtocolVersions.includes(1)}))]}/><button type="button" className="ln-icon-button" aria-label="刷新电脑列表" disabled={loading} onClick={()=>{void load()}}><Icon name="refresh" size={15}/></button></div>
    {error&&<FormMessage error>{error}</FormMessage>}
    {nodeId!=='local'&&<p className="ln-computer-target-hint">所选电脑：{selected?.displayName||'设备不可用'}</p>}
    {nodeId!=='local'&&!allowed?<FormMessage error>设备离线或桌面不可用，控制已停止。连接恢复后请重新授权。</FormMessage>:<ComputerPanel key={nodeId} port={port} client={client} agent={agent} theme={theme}/>}
    {!nodes.length&&<Empty className="ln-empty--inline"><EmptyHeader><EmptyMedia variant="icon"><Icon name="computer" size={18}/></EmptyMedia><EmptyTitle>还没有可查看的其他电脑</EmptyTitle><EmptyDescription>在「设置 › 设备」中添加其他电脑后，这里会列出它们的执行位置；屏控必须单独授权。</EmptyDescription></EmptyHeader>{onConnectDevice&&<EmptyContent><button type="button" className="ln-action" onClick={onConnectDevice}>去连接设备</button></EmptyContent>}</Empty>}
  </section>
}

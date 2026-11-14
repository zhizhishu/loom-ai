import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ThreadClient } from '../camp-client'
import type { AgentProfile } from './types'
import type { HostWorkbench } from './host-services'
import { ComputerPanel } from './ComputerPanel'
import { ChoiceMenu, FormMessage } from './Controls'
import { Icon } from './icons'

type Node = { nodeId: string; displayName: string; status: string; computerProtocolVersions: number[]; os: string | null }
/** Explicit target selection. Switching unmounts the previous view/lease first. */
export function ComputerWorkspace({workbench,client,agent,theme}:{workbench?:HostWorkbench;client?:ThreadClient;agent:AgentProfile|null;theme:'day'|'night'}) {
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
    <div className="ln-computer-target"><Icon name="computer" size={17}/><ChoiceMenu label="选择要查看的电脑" value={nodeId} onChange={setNodeId} theme={theme} choices={[{value:'local',label:'当前主机',description:'LOOM 所连接的电脑'},...nodes.map(node=>({value:node.nodeId,label:node.displayName,description:node.status!=='online'?'设备离线':node.computerProtocolVersions.includes(1)?`${node.os||'远端'} · 支持电脑画面`:'仅命令执行，未启用图形桌面',disabled:node.status!=='online'||!node.computerProtocolVersions.includes(1)}))]}/><button type="button" className="ln-icon-button" aria-label="刷新电脑列表" disabled={loading} onClick={()=>{void load()}}><Icon name="refresh" size={15}/></button></div>
    {error&&<FormMessage error>{error}</FormMessage>}
    {nodeId!=='local'&&<p className="ln-computer-target-hint">已配对设备：{selected?.displayName||'当前设备不可读取'}。画面和输入发往该节点，不会退回到本机。</p>}
    {nodeId!=='local'&&!allowed?<FormMessage error>这个节点已离线或不再提供电脑画面；原控制已停止。重新连接后必须再次授权。</FormMessage>:<ComputerPanel key={nodeId} port={port} client={client} agent={agent} theme={theme}/>}
    {!nodes.length&&<p className="ln-computer-target-hint">更多设备可在“连接与设备”中配对。无图形桌面的节点仍可执行命令，但不会显示虚构屏幕。</p>}
  </section>
}

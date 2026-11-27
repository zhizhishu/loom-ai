import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ExecutionNodeRecord } from '@contracts'
import type { BusinessEnvironment } from '../business-environment'
import {
  memberTargetState, setTargetMode, setTargetNode, setTargetWorkspace, setTargetAdapter,
  setTargetModelInput, setTargetPermission, remoteNodeChoices, descriptorFor,
  type ExecutionTargetAdapterKind, type ExecutionTargetBlock, type ExecutionTargetDraft
} from '../member-execution-target-model'
import { createExecutionService } from './execution-service'
import { ChoiceMenu, FormMessage } from './Controls'
import { Icon } from './icons'

/**
 * 可以准备工作区的唯一状态：远端模式、已选设备在线、还没选定设备上的工作区。
 * 返回要准备的设备 id；其余情况为空——不显示假按钮。
 */
export function remotePrepareNodeId(
  block: ExecutionTargetBlock,
  draft: ExecutionTargetDraft | null,
  nodes: readonly ExecutionNodeRecord[] | null
): string {
  if (block !== 'no-workspace' || draft?.mode !== 'remote') return ''
  const remote = draft.remote
  if (!remote?.nodeId) return ''
  const selected = remoteNodeChoices(nodes ?? [], remote.adapterKind, remote.nodeId)
    .find(choice => choice.node.nodeId === remote.nodeId)?.node
  return selected && selected.status === 'online' && !selected.revokedAt ? remote.nodeId : ''
}

/** 源目录是所选设备上的事实：没有可信来源就只给一个字面输入框。 */
export function RemoteWorkspacePrepare({ block, draft, nodes, sourceRoot, busy, preparing, onSourceRoot, onPrepare }: {
  block: ExecutionTargetBlock; draft: ExecutionTargetDraft | null; nodes: readonly ExecutionNodeRecord[] | null
  sourceRoot: string; busy: boolean; preparing: boolean
  onSourceRoot(value: string): void; onPrepare(): void
}) {
  const nodeId = remotePrepareNodeId(block, draft, nodes)
  if (!nodeId) return null
  return <>
    <label className="ln-field"><span>源目录</span><input aria-label="远端工作区源目录" value={sourceRoot} disabled={preparing || busy} placeholder="所选电脑上的项目目录，例如 /srv/project" onChange={event => onSourceRoot(event.target.value)}/><small>在 {nodeId} 自己的磁盘上，不是这台主机的路径。</small></label>
    <div className="ln-form-actions"><small>只创建并登记工作区，不保存运行位置，也不改任务绑定。</small><button type="button" className="ln-action" disabled={preparing || busy || !sourceRoot.trim()} onClick={onPrepare}>{preparing ? '准备中…' : '在所选电脑准备工作区'}</button></div>
  </>
}

export function ExecutionPanel({ environment, agentId, threadId, theme = 'day', onDirtyChange, onSaved }: {
  environment: BusinessEnvironment; agentId: string; threadId?: string; theme?: 'day' | 'night'; onDirtyChange?(dirty: boolean): void; onSaved?(): void
}) {
  const service = useMemo(() => createExecutionService(environment.client, environment.nodes ?? null), [environment.client,environment.nodes])
  const controller = useMemo(() => service.controller(), [service])
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const current = memberTargetState(state,agentId)
  const [nodes, setNodes] = useState<readonly ExecutionNodeRecord[] | null>(null)
  const [nodeError, setNodeError] = useState('')
  const [reload, setReload] = useState(0)
  // 源目录是所选电脑上的事实，当前视图里没有就不假装有：一个字面输入框。
  const [sourceRoot, setSourceRoot] = useState('')
  const [preparing, setPreparing] = useState(false)
  const [prepareError, setPrepareError] = useState('')
  const [prepareNotice, setPrepareNotice] = useState('')
  useEffect(() => {
    let active = true
    controller.select(agentId); controller.load()
    void service.nodes().then(result => {
      if (!active) return
      if (result.status === 'ready') { setNodes(result.nodes); setNodeError('') }
      else { setNodes(null); setNodeError('当前连接暂时没有提供可用的设备列表。') }
    })
    return () => { active = false; controller.select(null) }
  }, [agentId,controller,service,reload])
  useEffect(() => { onDirtyChange?.(current?.dirty ?? false) }, [current?.dirty,onDirtyChange])
  const view = current?.view ?? null
  const draft = current?.draft ?? null
  const remote = draft?.remote ?? null
  const available = remoteNodeChoices(nodes ?? [],remote?.adapterKind ?? 'claude-code-cli',remote?.nodeId ?? '')
  const descriptor = remote ? descriptorFor(view,remote.adapterKind) : null
  const workspaces = remote ? service.workspaces(view,remote.nodeId) : []
  const block = service.block(draft,view,nodes)
  const blockCopy: Record<string,string> = {
    'read-error':'先成功读取运行位置，再选择目标。', 'reload-required':'当前结果未确认，请重新读取。',
    'no-workspace':'所选设备还没有准备好的工作区。',
    'workspace-required':'请选择已准备好的工作区。', 'adapter-required':'所选设备没有对应的运行端配置。', 'node-unknown':'设备状态尚未确认。'
  }
  const busy = current?.saving ?? false
  const save = async () => { await controller.save(); if (memberTargetState(controller.getState(),agentId)?.notice.kind === 'saved') onSaved?.() }
  const prepareNodeId = remotePrepareNodeId(block, draft, nodes)
  const prepareRemote = async () => {
    if (preparing || !prepareNodeId) return
    const source = sourceRoot.trim()
    if (!source) { setPrepareError('请先填写所选电脑上的源目录。'); return }
    setPreparing(true); setPrepareError(''); setPrepareNotice('')
    try {
      const missionId = await service.missionOfThread(threadId ?? null)
      if (!missionId) { setPrepareError('当前对话不是使命线程，无法为它准备工作区。'); return }
      await service.prepareRemote({ missionId, nodeId: prepareNodeId, sourceRoot: source })
      setPrepareNotice('工作区已准备，正在重新读取设备和工作区。')
      // 只刷新事实，不写选择：用户可以自己挑刚准备好的工作区，再保存。
      setReload(value => value + 1)
    } catch (error) {
      setPrepareError(error instanceof Error ? error.message : '准备工作区没有完成')
    } finally { setPreparing(false) }
  }
  return <section className="ln-execution-panel" aria-label="助手工作位置">
    <div className="ln-panel-title"><h3>工作位置</h3><button type="button" className="ln-icon-button" aria-label="刷新设备与工作区" disabled={busy} onClick={() => setReload(value => value + 1)}><Icon name="refresh" size={15}/></button></div>
    {!current || current.phase === 'loading' ? <p className="ln-cap-state" role="status">正在读取运行位置…</p> : current.phase === 'error' || !draft || !view ? <FormMessage error>暂时无法读取运行位置，不会把未知状态显示成本机运行。</FormMessage> : <>
      <label className="ln-field"><span>执行设备</span><ChoiceMenu label="执行设备类型" theme={theme} value={draft.mode} disabled={busy} onChange={value => controller.edit(setTargetMode(draft,value as 'local'|'remote',view))} choices={[{value:'local',label:'当前主机',description:'使用该助手的本机运行端配置'},{value:'remote',label:'已连接的远程设备',description:'使用设备提供的运行端与就绪工作区'}]}/></label>
      {draft.mode === 'local' ? <div className="ln-workspace-choice"><Icon name="computer" size={24}/><span><strong>当前连接的主机</strong><small>每个会话的工作目录在创建对话或群聊时选择，不等于浏览器所在设备。</small></span></div> : <>
        {nodeError && <FormMessage error>{nodeError}</FormMessage>}
        {!remote ? <FormMessage>当前主机尚未提供远程运行描述，不会生成虚假的设备配置。</FormMessage> : <>
          <label className="ln-field"><span>运行端</span><ChoiceMenu label="远程运行端" theme={theme} value={remote.adapterKind} disabled={busy} onChange={value => controller.edit(setTargetAdapter(draft,value as ExecutionTargetAdapterKind,view))} choices={service.runtimes(view).map(kind => ({value:kind,label:kind === 'claude-code-cli' ? 'Claude Code' : 'Codex CLI'}))}/><small>目前远程绑定只支持主机已声明的 Claude / Codex。DSH / Pi 可在本机运行，不冒称远程已接通。</small></label>
          <label className="ln-field"><span>设备</span><ChoiceMenu label="远程设备" theme={theme} value={remote.nodeId} disabled={busy} onChange={value => controller.edit(setTargetNode(draft,value,view))} choices={available.map(choice => ({value:choice.node.nodeId,label:choice.node.displayName,description:({ready:'在线且已报告运行端',offline:'当前离线',revoked:'已撤销', 'missing-cli':'未报告所需运行端'})[choice.state],disabled:!choice.selectable}))}/></label>
          <label className="ln-field"><span>工作区</span><ChoiceMenu label="远程工作区" theme={theme} value={remote.workspaceId} disabled={busy} onChange={value => controller.edit(setTargetWorkspace(draft,value,view))} choices={workspaces.map(workspace => ({value:workspace.workspaceId,label:workspace.missionTitle,description:workspace.workspaceRoot}))}/><small>{remote.workspaceRoot || '只可选择目标设备已准备好的目录。'}</small></label>
          <label className="ln-field"><span>模型</span><input aria-label="远程模型" value={remote.modelInput} disabled={busy} placeholder="留空沿用远程运行端默认" onChange={event => controller.edit(setTargetModelInput(draft,event.target.value))}/><small>不读取或复制账号凭据，不自动替换为另一个模型。</small></label>
          {descriptor?.permissionOptions.filter(item => item.supported && item.valueType === 'enum').map(item => <label className="ln-field" key={item.key}><span>{item.label}</span><ChoiceMenu label={`远程${item.label}`} theme={theme} value={String(remote.permissions.values[item.key] ?? '')} disabled={busy} onChange={value => controller.edit(setTargetPermission(draft,item.key,value))} choices={item.choices.map(choice => ({value:choice.value,label:choice.label}))}/><small>{item.description}</small></label>)}
        </>}
      </>}
      {current.unknown && <FormMessage error>上次保存结果尚未确认。先重新读取，不能直接再次提交。</FormMessage>}
      {current.notice.kind === 'saved' && <FormMessage>工作位置已保存，尚未启动任何任务。</FormMessage>}
      {current.notice.kind === 'read-failed' && <FormMessage error>更新读取失败；保留上次状态和未保存的选择。</FormMessage>}
      {current.notice.kind === 'rejected' && <FormMessage error>保存被拒绝：{current.notice.code}</FormMessage>}
      {current.notice.kind === 'conflict' && <FormMessage error>运行位置刚被修改，请重新读取后核对。</FormMessage>}
      {block && <FormMessage>{blockCopy[block] ?? '当前目标还不能保存。'}</FormMessage>}
      <RemoteWorkspacePrepare block={block} draft={draft} nodes={nodes} sourceRoot={sourceRoot} busy={busy} preparing={preparing} onSourceRoot={value => { setSourceRoot(value); setPrepareError(''); setPrepareNotice('') }} onPrepare={() => { void prepareRemote() }}/>
      {prepareError && <FormMessage error>{prepareError}</FormMessage>}
      {prepareNotice && <FormMessage>{prepareNotice}</FormMessage>}
      <footer className="ln-form-actions"><small>工作位置与能力选择分开保存。</small><button type="button" className="ln-action is-primary" disabled={busy || !current.dirty || current.unknown || !!block} onClick={() => { void save() }}>{busy ? '保存中…' : '保存工作位置'}</button></footer>
    </>}
  </section>
}

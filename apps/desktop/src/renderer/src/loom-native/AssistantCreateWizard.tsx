import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentProfile, MemberRuntimeConfiguration, WorkspaceSelection } from '@contracts'
import type { BusinessEnvironment } from '../business-environment'
import type { HookReviewSnapshot } from '../member-catalog-model'
import { Avatar } from './Avatar'
import { Icon } from './icons'
import { ChoiceMenu, FormMessage, SurfaceDialog } from './Controls'
import { AssistantCreateRejected, assistantRuntimeAvailabilityLabel, assistantRuntimeSetupDefaults, piPurgeNeedsFileGrant, readAssistant, readAssistantRuntimeOptions, withPiPurgeFileGrant, type AssistantRuntimeOption } from './assistant-service'
import { ASSISTANT_PRESETS, availablePresetName, presetIdentity } from './assistant-presets'
import { AssistantCapabilityPicker } from './AssistantCapabilityPicker'
import { finishAssistantSetup, newSetupAttempt, setupProblems, setupSignature, type AssistantSetupAttempt, type AssistantSetupDraft } from './assistant-onboarding'
import { runtimeLogoFor } from './runtime-logo'

const STEPS = ['认识它','运行方式','选择能力','工作区域','准备完成']
const RUNTIME_MARKS: Record<string,string> = { 'claude-code-cli':'C', 'codex-cli':'◧', 'deepseek-harness':'D', pi:'π' }
const DRAFT_KEY = 'loom.assistant.onboarding.v1'
const ATTEMPT_KEY = 'loom.assistant.onboarding.attempt.v1'
function readAttempt(draft: AssistantSetupDraft): AssistantSetupAttempt | null {
  try { const value = JSON.parse(sessionStorage.getItem(ATTEMPT_KEY) || 'null'); return value?.signature === setupSignature(draft) && typeof value.createCommandId === 'string' && typeof value.runtimeCommandId === 'string' && typeof value.roomCommandId === 'string' ? value as AssistantSetupAttempt : null } catch { return null }
}
function clearRecovery(): void { try { sessionStorage.removeItem(DRAFT_KEY); sessionStorage.removeItem(ATTEMPT_KEY) } catch { /* storage can be refused */ } }

export function AssistantCreateWizard({ environment, agents, theme, onCreated, onDirtyChange, onBusyChange, onOpenConnections }: {
  environment: BusinessEnvironment; agents: AgentProfile[]; theme: 'day' | 'night'
  onCreated(agent: AgentProfile, threadId: string | null): Promise<void> | void
  onDirtyChange(dirty: boolean): void; onBusyChange(busy: boolean): void; onOpenConnections?(): void
}) {
  const [step,setStep] = useState(0)
  const [preset,setPreset] = useState(ASSISTANT_PRESETS[0].id)
  const [draft,setDraft] = useState<AssistantSetupDraft>(()=>{
    try{const saved=JSON.parse(sessionStorage.getItem(DRAFT_KEY)||'null');if(saved?.identity&&typeof saved.identity.name==='string'&&Array.isArray(saved.capabilityKeys))return saved as AssistantSetupDraft}catch{/* no recovery available */}
    const identity=presetIdentity(ASSISTANT_PRESETS[0]);identity.name=availablePresetName(identity.name,agents.map(agent=>agent.displayName))
    return {identity,avatarRef:ASSISTANT_PRESETS[0].avatarRef,runtime:null,capabilityKeys:[],workspace:null,openConversation:true}
  })
  const [options,setOptions] = useState<AssistantRuntimeOption[]>([])
  const [loading,setLoading] = useState(true)
  const [busy,setBusy] = useState(false)
  const [importBusy,setImportBusy] = useState(false)
  const [touched,setTouched] = useState(false)
  const [error,setError] = useState('')
  const [message,setMessage] = useState('')
  const [review,setReview] = useState<{snapshot:HookReviewSnapshot;names:string[]} | null>(null)
  const [acknowledged,setAcknowledged] = useState(false)
  const attempt = useRef<AssistantSetupAttempt | null>(readAttempt(draft))
  const [locked,setLocked] = useState(() => attempt.current !== null)
  const ticket = useRef(0)
  const catalogAgentId = agents.find(agent=>agent.presence==='present'&&!agent.removedAt)?.agentId??null
  const selectedOption=options.find(option=>option.kind===draft.runtime?.adapterKind)
  // Pi is LOOM's built-in primary assistant. Its absence is a connection problem the
  // user can act on, not a silently greyed-out row nobody can explain.
  const piMissing=!loading&&options.some(option=>option.kind==='pi'&&!option.usable)
  const errors=setupProblems(draft,locked?[]:agents.map(agent=>agent.displayName))
  useEffect(() => { if (locked) setStep(STEPS.length - 1) }, [])
  const dangerous=selectedOption?.permissionOptions.filter(item=>item.risk!=='normal')??[]
  const blocks=(step===0&&errors.some(item=>item.includes('名字')||item.includes('名称'))) || (step===1&&!draft.runtime) || (step===4&&dangerous.length>0&&!acknowledged)
  const markImportBusy=useCallback((value:boolean)=>setImportBusy(value),[])
  const patch=(value:Partial<AssistantSetupDraft>)=>{if(locked)return;setDraft(current=>({...current,...value}));setTouched(true);setError('');setMessage('');setAcknowledged(false)}
  useEffect(()=>{onDirtyChange(touched||locked);return()=>onDirtyChange(false)},[touched,locked,onDirtyChange])
  useEffect(()=>{onBusyChange(busy||importBusy);return()=>onBusyChange(false)},[busy,importBusy,onBusyChange])
  useEffect(()=>{if(touched&&!locked){try{sessionStorage.setItem(DRAFT_KEY,JSON.stringify(draft))}catch{/* keep in-memory draft */}}},[draft,touched,locked])
  const readOptions=useCallback(async()=>{const generation=++ticket.current;setLoading(true);try{const value=await readAssistantRuntimeOptions(environment.client);if(generation===ticket.current)setOptions(value)}catch(cause){if(generation===ticket.current)setError(cause instanceof Error?cause.message:'运行端读取失败。')}finally{if(generation===ticket.current)setLoading(false)}},[environment.client])
  useEffect(()=>{void readOptions();return()=>{ticket.current++}},[readOptions])
  const chooseRuntime=(option:AssistantRuntimeOption)=>{
    if(!option.usable||!option.defaults||locked)return
    // A new assistant starts from the installation's own defaults. The single Pi
    // exception is documented in assistantRuntimeSetupDefaults: an absent `native`
    // file policy would make Pi Purge Append unsavable afterwards.
    const value=assistantRuntimeSetupDefaults(option)
    if(!value)return
    if(option.installation?.snapshot?.permissionSchemaVersion!==undefined)value.permissions.schemaVersion=option.installation.snapshot.permissionSchemaVersion
    patch({runtime:value})
  }
  const chooseWorkspace=async()=>{setBusy(true);setError('');try{const value=await environment.selectWorkspaceDirectory();if(value)patch({workspace:value})}catch(cause){setError(cause instanceof Error?cause.message:'无法读取主机目录。')}finally{setBusy(false)}}
  const setModel=(id:string)=>{
    if(!draft.runtime)return
    const choice=selectedOption?.models.find(item=>item.id===id)
    const source = choice?.runtimeMetadata?.dshSource
    const runtime:MemberRuntimeConfiguration={...draft.runtime,model:id==='__default'?{mode:'runtime_default'}:{mode:'explicit',modelId:id,options:Object.fromEntries((choice?.options??[]).filter(item=>item.defaultValue!==null).map(item=>[item.key,item.defaultValue])),...(source === 'native' || source === 'web' ? { dshSource:source } : {})}}
    patch({runtime})
  }
  const persistAttempt = (value: AssistantSetupAttempt) => {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(value)) } catch { /* in-memory replay ids are retained */ }
  }
  const keepPartial = async () => {
    if (!attempt.current?.agentId || busy) return
    setBusy(true); setError('')
    try { const agent = await readAssistant(environment.client,attempt.current.agentId); clearRecovery(); setTouched(false); setLocked(false); await onCreated(agent,null) } catch(cause) { setError(cause instanceof Error ? cause.message : '助手暂时无法读回。') } finally { setBusy(false) }
  }
  const submit=async(approved?:HookReviewSnapshot)=>{
    if(busy||importBusy)return
    if(errors.length){setError(errors.join(' '));return}
    setBusy(true);setError('');setMessage('');setLocked(true)
    attempt.current??=newSetupAttempt(draft)
    persistAttempt(attempt.current)
    try{
      const result=await finishAssistantSetup(environment,draft,attempt.current,approved,persistAttempt)
      if(result.status==='review'){setReview({snapshot:result.review,names:result.names});return}
      setReview(null);setTouched(false);setLocked(false)
      clearRecovery()
      if(result.warning)setMessage(result.warning)
      await onCreated(result.agent,result.threadId)
    }catch(cause){
      setReview(null)
      // Only a durable explicit rejection proves that no identity was created.
      // Lost responses/read-back failures retain the replay key and lock.
      if(cause instanceof AssistantCreateRejected && !attempt.current?.agentId){
        attempt.current=null
        try{sessionStorage.removeItem(ATTEMPT_KEY)}catch{/* preserve the in-memory draft */}
        setLocked(false);setTouched(true)
      }
      setError(cause instanceof Error?cause.message:'创建尚未完成，输入和原请求已保留。')
    }
    finally{setBusy(false)}
  }
  const avatarAgent=useMemo(()=>({agentId:'assistant-draft',displayName:draft.identity.name,avatarRef:draft.avatarRef}) as AgentProfile,[draft.identity.name,draft.avatarRef])
  const count=(kind:string)=>draft.capabilityKeys.filter(key=>key.startsWith(kind+':')).length
  return <div className="ln-assistant-wizard">
    <header className="ln-wizard-heading"><Avatar agent={avatarAgent} name={draft.identity.name} size={44}/><div><h3>创建你的助手</h3><p>一次配好，随时一起工作。</p></div><span>{step+1} / {STEPS.length}</span></header>
    <nav className="ln-wizard-steps" aria-label="创建助手步骤">{STEPS.map((label,index)=><button key={label} type="button" className={step===index?'is-current':index<step?'is-done':''} disabled={busy||importBusy||locked} onClick={()=>{setStep(index);setError('')}} aria-current={step===index?'step':undefined}><i>{index<step?<Icon name="check" size={12}/>:index+1}</i><span>{label}</span></button>)}</nav>
    <div className="ln-wizard-body">
      {step===0&&<><div className="ln-onboarding-section-head"><div><h3>先选一个起点</h3><p>名字和职责都能改；模板不会替你授予权限。</p></div></div><div className="ln-preset-grid">{ASSISTANT_PRESETS.map(item=><button type="button" className={preset===item.id?'is-selected':''} key={item.id} disabled={locked} onClick={()=>{setPreset(item.id);const identity=presetIdentity(item);identity.name=availablePresetName(identity.name,agents.map(agent=>agent.displayName));patch({identity,avatarRef:item.avatarRef})}}><Avatar agent={{agentId:`preset:${item.id}`,displayName:item.name,avatarRef:item.avatarRef} as AgentProfile} name={item.name} size={29}/><span><strong>{item.name}</strong><small>{item.role}</small></span>{preset===item.id&&<Icon name="check" size={14}/>}</button>)}</div>
        <div className="ln-field-grid"><label className="ln-field"><span>名称</span><input aria-label="新助手名称" value={draft.identity.name} maxLength={40} disabled={locked} onChange={event=>patch({identity:{...draft.identity,name:event.target.value}})}/></label><label className="ln-field"><span>职责</span><input aria-label="新助手职责" value={draft.identity.role} disabled={locked} onChange={event=>patch({identity:{...draft.identity,role:event.target.value}})}/></label></div><label className="ln-field"><span>它主要帮你做什么</span><textarea aria-label="新助手用途" rows={3} value={draft.identity.purpose} disabled={locked} onChange={event=>patch({identity:{...draft.identity,purpose:event.target.value}})}/></label><label className="ln-field"><span>沟通方式</span><input aria-label="新助手沟通方式" value={draft.identity.style.join('、')} disabled={locked} onChange={event=>patch({identity:{...draft.identity,style:event.target.value.split(/[、,，]/).map(value=>value.trim()).filter(Boolean)}})}/></label></>}
      {step===1&&<><div className="ln-onboarding-section-head"><div><h3>选择执行引擎</h3><p>助手身份保持不变，运行方式可以以后更换。</p></div><button type="button" className="ln-action" disabled={loading} onClick={()=>{void readOptions()}}><Icon name="refresh" size={14}/>重新读取</button></div>
        <div className="ln-wizard-runtimes">{options.map(option=><button type="button" className={draft.runtime?.adapterKind===option.kind?'is-selected':''} key={option.kind} disabled={!option.usable||busy||locked} onClick={()=>chooseRuntime(option)}><span className={`ln-runtime-mark is-${option.kind}`}>{runtimeLogoFor(option.kind)?<img className="ln-runtime-mark-logo" src={runtimeLogoFor(option.kind)!} alt="" aria-hidden="true" draggable={false}/>:RUNTIME_MARKS[option.kind]}</span><span><strong>{option.label}</strong><small>{assistantRuntimeAvailabilityLabel(option)}</small></span>{draft.runtime?.adapterKind===option.kind&&<Icon name="check" size={15}/>}</button>)}</div>
        {piMissing&&<p className="ln-native-help" role="status">内置主助手需要连接本机 Pi 运行环境。<button type="button" className="ln-text-action" onClick={onOpenConnections}>到「设置 › 运行端」检查 Pi</button></p>}
        {loading&&<p className="ln-picker-empty">正在读取主机的实际安装信息…</p>}
        {draft.runtime&&<><label className="ln-field"><span>模型</span><ChoiceMenu label="新助手模型" theme={theme} disabled={locked} value={draft.runtime.model.mode==='explicit'?draft.runtime.model.modelId:'__default'} onChange={setModel} choices={[{value:'__default',label:'使用运行端默认模型',description:'保留主机原配置，不自动换模型'},...(selectedOption?.models??[]).filter(model=>!model.hidden&&!model.deprecated).map(model=>({value:model.id,label:model.displayName||model.id}))]}/></label>
          <details className="ln-wizard-permissions"><summary>权限与高级选项 <small>沿用此运行端的真实设置</small></summary>{selectedOption?.permissionOptions.map(descriptor=><label className="ln-field" key={descriptor.key}><span>{descriptor.label}</span>{descriptor.valueType==='enum'?<ChoiceMenu theme={theme} label={`新助手${descriptor.label}`} disabled={locked||!descriptor.supported} value={JSON.stringify(draft.runtime?.permissions.values[descriptor.key])} onChange={encoded=>patch({runtime:{...draft.runtime!,permissions:{...draft.runtime!.permissions,values:{...draft.runtime!.permissions.values,[descriptor.key]:JSON.parse(encoded)}}}})} choices={descriptor.choices.map(choice=>({value:JSON.stringify(choice.value),label:choice.label}))}/>:<small>{JSON.stringify(draft.runtime?.permissions.values[descriptor.key])}</small>}<small>{descriptor.unsupportedReason||descriptor.description}</small></label>)}<p>“仅一次”与“本会话允许”以运行端实际提供的选项为准，不自动扩大成永久权限。</p></details>
          {draft.runtime.adapterKind==='pi'&&<details className="ln-wizard-permissions"><summary>助手设定 · Pi Purge <small>默认关闭，只作用于这个助手</small></summary>
            <label className="ln-field"><span>启用方式</span><ChoiceMenu theme={theme} label="新助手 Pi Purge 模式" disabled={locked} value={draft.runtime!.piPurge?.mode??'off'} onChange={value=>patch({runtime:{...draft.runtime!,piPurge:{mode:value as 'off'|'append',persona:draft.runtime!.piPurge?.persona??''}}})} choices={[{value:'off',label:'关闭',description:'Off'},{value:'append',label:'追加助手设定',description:'Append'}]}/></label>
            <label className="ln-field"><span>角色与偏好</span><textarea aria-label="新助手 Pi Purge 人格提示词" rows={4} maxLength={16*1024} disabled={locked} value={draft.runtime!.piPurge?.persona??''} placeholder="写清这个助手的角色、表达风格和任务偏好" onChange={event=>patch({runtime:{...draft.runtime!,piPurge:{mode:draft.runtime!.piPurge?.mode??'off',persona:event.target.value}}})}/><small>追加（Append）把设定放在 Pi 原始系统提示词前；{(draft.runtime!.piPurge?.persona??'').length} 字符。人格不扩大工具与文件授权。</small></label>
            {piPurgeNeedsFileGrant(draft.runtime)&&<div className="ln-review-card"><h3>追加（Append）需要工作目录文件权限</h3><p>当前「文件与任务权限」是原生或未设置，Core 会在保存时拒绝这个组合（pi_purge_requires_file_grant）。</p><button type="button" className="ln-action" disabled={locked} onClick={()=>patch({runtime:withPiPurgeFileGrant(draft.runtime!)})}>设为读写工作目录</button></div>}
          </details>}
        </>}
        <button type="button" className="ln-text-action" onClick={onOpenConnections}>找不到客户端？检查连接与安装</button>
        <button type="button" className="ln-text-action" disabled={locked} onClick={()=>{patch({runtime:null});setStep(2)}}>先创建身份，稍后配置运行端</button>
      </>}
      {step===2&&<AssistantCapabilityPicker draftAssistant environment={environment} catalogAgentId={catalogAgentId} runtime={draft.runtime?.adapterKind??null} selectedKeys={draft.capabilityKeys} onSelection={keys=>patch({capabilityKeys:keys})} theme={theme} disabled={locked} onBusyChange={markImportBusy}/>}
      {step===3&&<><div className="ln-onboarding-section-head"><div><h3>从哪个工作区域开始</h3><p>目录由当前连接主机提供，不是浏览器设备的目录。</p></div></div><div className="ln-wizard-location"><Icon name="computer" size={28}/><div><strong>当前连接主机</strong><p>新对话使用这个工作区。每项工作仍有独立的授权和执行边界。</p></div><span>本机</span></div><div className="ln-workspace-choice"><Icon name="files" size={23}/><span><strong>{draft.workspace?.name||'快速对话工作区'}</strong><small>{draft.workspace?.projectPath||'由主机创建独立工作目录'}</small></span><button type="button" className="ln-action" disabled={busy||locked} onClick={()=>{void chooseWorkspace()}}>选择文件夹</button></div>{draft.workspace&&<button type="button" className="ln-text-action" disabled={locked} onClick={()=>patch({workspace:null})}>改用快速对话目录</button>}
        <div className="ln-wizard-location-note"><Icon name="globe" size={19}/><span><strong>在另一台电脑执行</strong><p>已配对的设备和准备好的远端工作区可在助手的“工作位置”中选择。尚未就绪的节点不会被标成可用。</p><button type="button" className="ln-text-action" onClick={onOpenConnections}>管理执行设备</button></span></div><label className="ln-wizard-check"><input type="checkbox" checked={draft.openConversation} disabled={locked} onChange={event=>patch({openConversation:event.target.checked})}/><span>创建后打开一段对话<small>不会自动发送消息或消耗模型额度。</small></span></label></>}
      {step===4&&<><div className="ln-wizard-review"><Avatar agent={avatarAgent} name={draft.identity.name} size={58}/><h3>{draft.identity.name}</h3><p>{draft.identity.role}</p><div><span>执行引擎</span><strong>{selectedOption?.label||'稍后配置'}</strong></div><div><span>模型</span><strong>{draft.runtime?.model.mode==='explicit'?draft.runtime.model.modelId:draft.runtime?'运行端默认':'未配置'}</strong></div><div><span>能力</span><strong>{count('skill')} Skills · {count('mcp')} MCP · {count('rule')} 规则 · {count('hook')} Hooks</strong></div><div><span>初始工作区</span><strong title={draft.workspace?.projectPath}>{draft.workspace?.name||'快速对话'}</strong></div></div><p className="ln-wizard-reassurance">创建只保存你的选择。模型运行、电脑接管和高风险工具依然单独授权。</p>{dangerous.length>0&&<label className="ln-wizard-check"><input type="checkbox" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)}/><span>我已核对所选运行端的权限设置<small>{dangerous.map(item=>item.label).join('、')}。不会替其他助手或当前等待中的操作授权。</small></span></label>}
        {!draft.runtime&&<FormMessage>助手可以加入群聊，但配置运行端前不能执行模型任务。</FormMessage>}{locked&&<FormMessage>创建请求已经提交。重试会继续同一个助手，不会重复创建；完成后再修改配置。</FormMessage>}
      </>}
      {error&&<FormMessage error>{error}</FormMessage>}{locked&&attempt.current?.agentId&&<button type="button" className="ln-text-action" disabled={busy} onClick={()=>{void keepPartial()}}>保留已创建的助手，打开配置继续完善</button>}{message&&<FormMessage>{message}</FormMessage>}
    </div>
    <footer className="ln-wizard-footer"><span>{draft.capabilityKeys.length} 项能力已选</span>{step>0&&<button type="button" className="ln-action" disabled={busy||importBusy||locked} onClick={()=>{setStep(value=>value-1);setError('')}}>上一步</button>}{step<STEPS.length-1?<button type="button" className="ln-action is-primary" disabled={busy||importBusy||blocks||locked} onClick={()=>{setStep(value=>value+1);setError('')}}>下一步</button>:<button type="button" className="ln-action is-primary" disabled={busy||importBusy||errors.length>0||blocks} onClick={()=>{void submit()}}>{busy?'正在保存…':locked?'继续完成创建':'创建助手'}</button>}</footer>
    <SurfaceDialog open={review!==null} title="最后确认能力范围" description="助手身份已创建，下面的能力尚未授予。请核对真实正文和运行范围。" theme={theme} onClose={()=>{if(!busy)setReview(null)}} className="ln-room-dialog"><div className="ln-room-content">{review&&<>{review.names.map(name=><p key={name}>{name} · 高风险能力</p>)}{review.snapshot.entries.map(entry=><div className="ln-review-card" key={entry.id}><h3>{entry.name}</h3><p>{entry.scope.adapterKind} · {entry.scope.workspaceRoot}</p><pre>{entry.body}</pre></div>)}<footer className="ln-form-actions"><button type="button" className="ln-action" disabled={busy} onClick={()=>{setReview(null);void keepPartial()}}>暂不授权，保留助手</button><button type="button" className="ln-action is-primary" disabled={busy} onClick={()=>{void submit(review.snapshot)}}>确认范围并完成</button></footer></>}</div></SurfaceDialog>
  </div>
}

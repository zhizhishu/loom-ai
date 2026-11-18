import { useEffect, useMemo, useRef, useState } from 'react'
import { AssistantCreateWizard } from './AssistantCreateWizard'
import { ASSISTANT_PRESETS } from './assistant-presets'
import type { MemberRuntimeConfiguration, PermissionOptionDescriptor } from '@contracts'
import type { BusinessEnvironment } from '../business-environment'
import type { AgentProfile } from './types'
import { Avatar } from './Avatar'
import { Icon } from './icons'
import { ChoiceMenu, FormMessage, SurfaceDialog, UnsavedNotice } from './Controls'
import { AssistantCapabilityEditor } from './AssistantCapabilityEditor'
import { ExecutionPanel } from './ExecutionPanel'
import {
  ASSISTANT_RUNTIME_REGISTRY, assistantIdentityOf, assistantRuntimeChoice,
  createAssistant, readAssistantRuntimeOptions, saveAssistantIdentity, saveAssistantRuntime,
  type AssistantIdentity, type AssistantRuntimeKind, type AssistantRuntimeOption
} from './assistant-service'

const blankIdentity = (): AssistantIdentity => ({ name: '', role: '', purpose: '', style: [], instructions: '' })
const purposeTemplates = ASSISTANT_PRESETS.map(preset => ({ value:preset.id, label:`${preset.name} · ${preset.role}`, role:preset.role, purpose:preset.purpose }))

export function AssistantStudio({ open, environment, agents, initialAgentId, theme = 'day', onClose, onRefresh, onLibrary, catalogEpoch = 0, onCreatedConversation, onOpenConnections }: {
  open: boolean; environment: BusinessEnvironment; agents: AgentProfile[]; initialAgentId?: string
  theme?: 'day' | 'night'; onClose(): void; onRefresh(): Promise<void>; onLibrary?(): void; catalogEpoch?: number; onCreatedConversation?(threadId: string): Promise<void> | void; onOpenConnections?(): void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [local, setLocal] = useState<AgentProfile | null>(null)
  const [tab, setTab] = useState<'identity' | 'capabilities' | 'runtime' | 'location'>('identity')
  const [identity, setIdentity] = useState<AssistantIdentity>(blankIdentity)
  const [baseline, setBaseline] = useState('')
  const [options, setOptions] = useState<AssistantRuntimeOption[]>([])
  const [runtime, setRuntime] = useState<MemberRuntimeConfiguration | null>(null)
  const [runtimeBase, setRuntimeBase] = useState('null')
  const [capDirty, setCapDirty] = useState(false)
  const [locationDirty, setLocationDirty] = useState(false)
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)
  const [dangerConfirm, setDangerConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [wizardBusy, setWizardBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loadingRuntime, setLoadingRuntime] = useState(false)
  const generation = useRef(0)
  const createCommandId = useRef<string | null>(null)
  const roster = agents.filter(agent => agent.presence !== 'removed' && !agent.removedAt)
  const choose = (agent: AgentProfile | null) => {
    generation.current++; createCommandId.current = null; setSelected(agent?.agentId ?? null); setLocal(agent)
    const next = agent ? assistantIdentityOf(agent) : blankIdentity()
    setIdentity(next); setBaseline(JSON.stringify(next)); setRuntime(agent?.runtimeConfiguration ?? null)
    setRuntimeBase(JSON.stringify(agent?.runtimeConfiguration ?? null)); setTab('identity')
    setCapDirty(false); setLocationDirty(false); setError(''); setMessage(''); setDangerConfirm(false)
  }
  useEffect(() => {
    if (open) choose(agents.find(agent => agent.agentId === initialAgentId) ?? roster[0] ?? null)
  }, [open, initialAgentId])
  useEffect(() => {
    if (!open) return
    let active = true
    setLoadingRuntime(true)
    void readAssistantRuntimeOptions(environment.client).then(value => { if (active) setOptions(value) })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '无法读取运行端。') })
      .finally(() => { if (active) setLoadingRuntime(false) })
    return () => { active = false }
  }, [environment.client, open])
  const identityDirty = JSON.stringify(identity) !== baseline
  const runtimeDirty = JSON.stringify(runtime) !== runtimeBase
  const dirty = identityDirty || runtimeDirty || capDirty || locationDirty
  const guard = (action: () => void) => { if (busy || wizardBusy) return; if (dirty) setPendingAction(() => action); else action() }
  const patch = (value: Partial<AssistantIdentity>) => { setIdentity(current => ({ ...current, ...value })); setError(''); setMessage('') }
  const saveIdentity = async () => {
    if (busy) return
    const ticket = generation.current
    setBusy(true); setError(''); setMessage('')
    try {
      const next = local
        ? await saveAssistantIdentity({ client: environment.client, agent: local, agents, patch: identity })
        : await createAssistant({ client: environment.client, identity, commandId: createCommandId.current ??= crypto.randomUUID() })
      if (ticket !== generation.current) return
      setLocal(next); setSelected(next.agentId); setBaseline(JSON.stringify(assistantIdentityOf(next))); setIdentity(assistantIdentityOf(next))
      setMessage(local ? '助手资料已保存。' : '助手已创建。接下来为它选择运行端和能力。')
      await onRefresh()
    } catch (cause) { if (ticket === generation.current) setError(cause instanceof Error ? cause.message : '保存未完成，输入仍保留。') }
    finally { if (ticket === generation.current) setBusy(false) }
  }
  const option = options.find(value => value.kind === runtime?.adapterKind) ?? null
  const explicitModel = runtime?.model.mode === 'explicit' ? runtime.model : null
  const selectedModel = option?.models.find(model => model.id === explicitModel?.modelId && (!explicitModel?.dshSource || model.runtimeMetadata?.dshSource === explicitModel.dshSource)) ?? null
  const switchRuntime = (kind: string) => {
    if (!local) return
    const value = options.find(row => row.kind === kind)
    if (!value?.installation || !value.usable) return
    setRuntime(assistantRuntimeChoice(local, kind as AssistantRuntimeKind, value.installation)); setError(''); setMessage('')
  }
  const updatePermission = (key: string, value: unknown) => setRuntime(current => current ? {
    ...current, permissions: { ...current.permissions, values: { ...current.permissions.values, [key]: value } }
  } : current)
  const updatePiPurge = (patch: Partial<{ mode: 'off' | 'append'; persona: string }>) => setRuntime(current =>
    current?.adapterKind === 'pi' ? { ...current, piPurge: { mode: 'off', persona: '', ...current.piPurge, ...patch } } : current)
  const changedDangerous = useMemo(() => {
    if (!runtime || !option) return []
    const before = local?.runtimeConfiguration?.adapterKind === runtime.adapterKind ? local.runtimeConfiguration.permissions.values : {}
    return option.permissionOptions.filter(item => item.risk !== 'normal' && JSON.stringify(before[item.key]) !== JSON.stringify(runtime.permissions.values[item.key]))
  }, [runtime, option, local])
  const saveRuntime = async () => {
    if (!local || !runtime || busy) return
    const ticket = generation.current
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await saveAssistantRuntime({ client: environment.client, agent: local, choice: runtime })
      if (ticket !== generation.current) return
      setLocal({ ...local, version: result.version, runtimeConfiguration: runtime }); setRuntimeBase(JSON.stringify(runtime))
      setDangerConfirm(false); setMessage('运行配置已保存。下一次运行使用此配置，未改变全局设置。')
      await onRefresh()
    } catch (cause) { if (ticket === generation.current) setError(cause instanceof Error ? cause.message : '配置未保存，请核对后重试。') }
    finally { if (ticket === generation.current) setBusy(false) }
  }
  const permissionField = (descriptor: PermissionOptionDescriptor) => {
    const value = runtime?.permissions.values[descriptor.key]
    const disabled = !descriptor.supported || busy
    return <label className="ln-field" key={descriptor.key}><span>{descriptor.label}</span>
      {descriptor.valueType === 'enum' ? <ChoiceMenu label={descriptor.label} theme={theme} disabled={disabled} value={JSON.stringify(value)}
        onChange={encoded => updatePermission(descriptor.key, JSON.parse(encoded))} choices={descriptor.choices.map(choice => ({ value: JSON.stringify(choice.value), label: choice.label }))}/>
      : descriptor.valueType === 'boolean' ? <button type="button" className="ln-toggle" role="switch" aria-checked={value === true} aria-label={descriptor.label} disabled={disabled} onClick={() => updatePermission(descriptor.key, value !== true)}><i/></button>
      : descriptor.valueType === 'rule_list' ? <div className="ln-review-card"><pre>{JSON.stringify(value ?? [],null,2)}</pre><small>保留原生结构化权限规则，本页不会把它转换成普通文本。</small></div>
      : <><textarea aria-label={descriptor.label} value={Array.isArray(value) ? value.join('\n') : ''} disabled={disabled} placeholder="每行一项" onChange={event => updatePermission(descriptor.key, event.target.value.split('\n').map(line => line.trim()).filter(Boolean))}/><small>每行一项，格式由当前运行端校验。</small></>}
      <small>{descriptor.unsupportedReason || descriptor.description}{descriptor.risk !== 'normal' ? ' · 变更前将单独确认范围' : ''}</small>
    </label>
  }
  return <SurfaceDialog open={open} title="你的助手" description="每位助手有自己的职责、能力和运行方式。" theme={theme} onClose={() => guard(onClose)} className="ln-studio">
    <div className="ln-studio-layout"><aside className="ln-studio-roster" aria-label="助手名单">
      {roster.map(agent => <button type="button" className={`ln-studio-person ${selected === agent.agentId ? 'is-selected' : ''}`} key={agent.agentId} onClick={() => guard(() => choose(agent))}><Avatar agent={agent} size={32}/><span><strong>{agent.displayName}</strong><small>{agent.teamRole || '助手'}</small></span></button>)}
      <button type="button" className={`ln-studio-person ${!selected ? 'is-selected' : ''}`} onClick={() => guard(() => choose(null))}><Icon name="plus" size={25}/><span><strong>新建助手</strong></span></button>
    </aside><div className="ln-studio-main">{!local ? <AssistantCreateWizard environment={environment} agents={agents} theme={theme} onDirtyChange={setCapDirty} onBusyChange={setWizardBusy} onOpenConnections={onOpenConnections}
      onCreated={async (created, threadId) => { choose(created); await onRefresh(); if (threadId && onCreatedConversation) { onClose(); await onCreatedConversation(threadId) } }} /> : <><div className="ln-studio-identity"><Avatar agent={local} name={identity.name || '新助手'} size={48}/><div><h3>{local?.displayName || '新助手'}</h3><p>{local ? local.teamRole || '定义职责，配好能力，再开始协作。' : '从用途开始，不需要写很长的提示词。'}</p></div></div>
      <nav className="ln-segment-tabs ln-studio-tabs" aria-label="助手配置分区">{(['identity','capabilities','runtime','location'] as const).map((value,index) => <button type="button" key={value} className={tab === value ? 'is-selected' : ''} disabled={!local && value !== 'identity'} onClick={() => guard(() => setTab(value))}>{['资料','能力','运行与权限','工作位置'][index]}</button>)}</nav>
      <div className="ln-studio-content">
        {tab === 'identity' && <>
          <div className="ln-field-grid"><label className="ln-field"><span>名称</span><input aria-label="助手名称" value={identity.name} maxLength={40} onChange={event => patch({ name: event.target.value })} placeholder="给它一个名字"/></label><label className="ln-field"><span>职责</span><input aria-label="助手职责" value={identity.role} maxLength={120} onChange={event => patch({ role: event.target.value })} placeholder="例如：前端工程师"/></label></div>
          <label className="ln-field"><span>它主要帮助你做什么</span><textarea aria-label="助手用途" rows={4} value={identity.purpose} onChange={event => patch({ purpose: event.target.value })} placeholder="写清目标和分工，不需要列出平台内部规则。"/></label>
          <div className="ln-panel-title"><small>从简洁职责模板开始</small><ChoiceMenu label="使用职责模板" theme={theme} value="" onChange={value => { const template = purposeTemplates.find(row => row.value === value); if (template) patch({ role: template.role, purpose: template.purpose, style: ['简洁', '直接', '重视证据'], instructions: '依据实际结果汇报，遇到阻塞说清原因。用户决定是否接受成果。' }) }} choices={[{ value:'', label:'选择模板' }, ...purposeTemplates.map(template => ({ value: template.value, label:template.label }))]}/></div>
          <label className="ln-field"><span>沟通方式</span><input aria-label="助手沟通方式" value={identity.style.join('、')} onChange={event => patch({ style: event.target.value.split(/[、,，]/).map(value => value.trim()).filter(Boolean) })} placeholder="例如：简洁、直接、讲清依据"/><small>多个词用逗号分隔。规则、工具和自动动作在“能力”里选择。</small></label>
          <details className="ln-cap-detail" style={{ marginLeft:0 }}><summary>补充工作约定</summary><label className="ln-field" style={{ marginTop:10 }}><textarea aria-label="补充工作约定" value={identity.instructions ?? ''} onChange={event => patch({ instructions: event.target.value })}/><small>仅修改这个助手，不覆盖项目规则或系统权限。</small></label></details>
          {error && <FormMessage error>{error}</FormMessage>}{message && <FormMessage>{message}</FormMessage>}
          <footer className="ln-form-actions"><small>头像和既有运行配置不会被资料保存覆盖。</small><button type="button" className="ln-action is-primary" disabled={busy || !identityDirty || !identity.name.trim()} onClick={() => { void saveIdentity() }}>{busy ? '保存中…' : local ? '保存资料' : '创建助手'}</button></footer>
        </>}
        {tab === 'capabilities' && local && <AssistantCapabilityEditor key={`${local.agentId}:${catalogEpoch}`} environment={environment} agent={local} theme={theme} onDirtyChange={setCapDirty} onBusyChange={setWizardBusy} onSaved={() => { void onRefresh() }}/>}
        {tab === 'location' && local && <ExecutionPanel environment={environment} agentId={local.agentId} theme={theme} onDirtyChange={setLocationDirty} onSaved={() => { void onRefresh() }}/>}
        {tab === 'runtime' && local && <>
          <label className="ln-field"><span>运行端</span><ChoiceMenu label="助手运行端" theme={theme} value={runtime?.adapterKind ?? ''} onChange={switchRuntime} disabled={busy || loadingRuntime} choices={[
            { value:'', label: loadingRuntime ? '正在读取运行端…' : '选择运行端', disabled:true },
            ...options.map(row => ({ value: row.kind, label: row.label, description: row.usable ? '已检测到主机安装' : row.installation ? '当前安装尚未准备好' : '当前主机尚未检测到', disabled: !row.usable }))
          ]}/><small>仅支持 Claude、Codex、DSH 和 Pi。配置跟随当前助手，不改全局默认。</small></label>
          {runtime && !Object.hasOwn(ASSISTANT_RUNTIME_REGISTRY,runtime.adapterKind) && <FormMessage>此助手使用的既有运行端不在本期四种选项中，原配置已保留。</FormMessage>}
          {runtime && option && <>
            <label className="ln-field"><span>模型</span><ChoiceMenu label="助手模型" theme={theme} disabled={busy} value={runtime.model.mode === 'explicit' ? runtime.model.modelId : '__default'} onChange={id => setRuntime(current => { if (!current) return current; if (id === '__default') return { ...current, model: { mode:'runtime_default' } }; const model = option.models.find(row => row.id === id); const source = model?.runtimeMetadata?.dshSource; return { ...current, model: { mode:'explicit', modelId:id, options:Object.fromEntries((model?.options ?? []).filter(item => item.defaultValue !== null).map(item => [item.key,item.defaultValue])), ...(source === 'native' || source === 'web' ? { dshSource:source } : {}) } } })} choices={[
              { value:'__default', label:'使用运行端默认模型', description:'不改动主机的全局模型配置' },
              ...option.models.filter(model => !model.hidden && !model.deprecated).map(model => ({ value:model.id,label:model.displayName || model.id }))
            ]}/>{runtime.model.mode === 'explicit' && !option.models.some(model => runtime.model.mode === 'explicit' && model.id === runtime.model.modelId) && <small>当前已保存的模型不在最新目录中：{runtime.model.modelId}。不会自动换成其他模型。</small>}</label>
            {explicitModel && selectedModel?.options.map(modelOption => <label className="ln-field" key={modelOption.key}><span>{modelOption.label}</span><ChoiceMenu theme={theme} label={modelOption.label} value={String(explicitModel.options[modelOption.key] ?? modelOption.defaultValue ?? '')} disabled={busy} onChange={value => setRuntime(current => current?.model.mode === 'explicit' ? { ...current, model: { ...current.model, options: { ...current.model.options, [modelOption.key]:value } } } : current)} choices={modelOption.values.map(choice => ({value:choice.value,label:choice.label}))}/></label>)}
            {runtime.adapterKind === 'pi' && <section className="ln-review-card" aria-label="Pi Purge 人格扩展">
              <div className="ln-panel-title"><h3>Pi Purge · 助手设定</h3></div>
              <label className="ln-field"><span>启用方式</span><ChoiceMenu label="Pi Purge 模式" theme={theme} value={runtime.piPurge?.mode ?? 'off'} disabled={busy} onChange={value => updatePiPurge({mode: value as 'off' | 'append'})} choices={[{ value:'off', label:'关闭' }, { value:'append', label:'追加助手设定' }]}/></label>
              <label className="ln-field"><span>角色与偏好</span><textarea aria-label="Pi Purge 人格提示词" rows={4} maxLength={16 * 1024} disabled={busy} value={runtime.piPurge?.persona ?? ''} placeholder="写清这个助手的角色、表达风格和任务偏好" onChange={event => updatePiPurge({persona:event.target.value})}/><small>保存后从下次运行开始生效，仅用于当前助手。</small></label>
            </section>}
            <div className="ln-panel-title"><h3>权限与确认方式</h3></div>
            {option.permissionOptions.length ? option.permissionOptions.map(permissionField) : <FormMessage>当前运行端没有提供可编辑的权限选项。实际操作仍以运行时授权为准。</FormMessage>}
            <FormMessage>运行中需要授权时，会在对话里向你确认。</FormMessage>
          </>}
          {error && <FormMessage error>{error}</FormMessage>}{message && <FormMessage>{message}</FormMessage>}
          <footer className="ln-form-actions"><small>新配置从下次运行开始生效。</small><button type="button" className="ln-action is-primary" disabled={!runtimeDirty || !runtime || busy || !option?.usable} onClick={() => { if (changedDangerous.length) setDangerConfirm(true); else void saveRuntime() }}>{busy ? '保存中…' : '保存运行配置'}</button></footer>
        </>}
      </div></>}
    </div></div>
    {pendingAction && <UnsavedNotice onKeep={() => setPendingAction(null)} onDiscard={() => { const action = pendingAction; setPendingAction(null); setCapDirty(false); setLocationDirty(false); if (!local) { try { sessionStorage.removeItem('loom.assistant.onboarding.v1'); sessionStorage.removeItem('loom.assistant.onboarding.attempt.v1') } catch { /* browser storage may be disabled */ } } if (local) { const restored = assistantIdentityOf(local); setIdentity(restored); setBaseline(JSON.stringify(restored)); setRuntime(local.runtimeConfiguration); setRuntimeBase(JSON.stringify(local.runtimeConfiguration)); } action() }}/>}
    <SurfaceDialog open={dangerConfirm} title="确认权限配置" description="请核对作用范围。此保存不会自动批准当前等待中的工具操作。" theme={theme} onClose={() => { if (!busy) setDangerConfirm(false) }} className="ln-room-dialog"><div className="ln-room-content">{changedDangerous.map(descriptor => <div className="ln-review-card" key={descriptor.key}><h3>{descriptor.label}</h3><p>{descriptor.description}</p><pre>{JSON.stringify(runtime?.permissions.values[descriptor.key],null,2)}</pre></div>)}{error && <FormMessage error>{error}</FormMessage>}<footer className="ln-form-actions"><button type="button" className="ln-action" disabled={busy} onClick={() => setDangerConfirm(false)}>取消</button><button type="button" className="ln-action is-primary" disabled={busy} onClick={() => { void saveRuntime() }}>确认并保存</button></footer></div></SurfaceDialog>
  </SurfaceDialog>
}

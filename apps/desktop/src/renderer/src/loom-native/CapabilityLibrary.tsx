import { useEffect, useMemo, useRef, useState } from 'react'
import type { SkillImportInspection, SkillView } from '@contracts'
import type { BusinessEnvironment } from '../business-environment'
import { createCapabilityPort } from './capability-service'
import { ChoiceMenu, FormMessage, SurfaceDialog, UnsavedNotice } from './Controls'
import { Icon } from './icons'

export function CapabilityLibrary({ open, environment, theme = 'day', onClose, onChanged }: {
  open: boolean; environment: BusinessEnvironment; theme?: 'day' | 'night'; onClose(): void; onChanged(): void
}) {
  const port = useMemo(() => createCapabilityPort(environment.client), [environment.client])
  const [tab, setTab] = useState<'skills' | 'rule' | 'hook'>('skills')
  const [path, setPath] = useState('')
  const [inspection, setInspection] = useState<SkillImportInspection | null>(null)
  const [library, setLibrary] = useState<readonly SkillView[]>([])
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [hookEvent, setHookEvent] = useState('Stop')
  const [hookCommand, setHookCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [discard, setDiscard] = useState(false)
  const [reviewHook, setReviewHook] = useState(false)
  const [pendingRegistration, setPendingRegistration] = useState<string | null>(null)
  const commits = useRef(new Map<string,string>())
  const snippetId = useRef<string | null>(null)
  const generation = useRef(0)
  const dirty = !!name || !!body || !!hookCommand
  useEffect(() => {
    if (!open) return
    const ticket = ++generation.current
    setError(''); setNotice(''); setDiscard(false)
    void port.listLibrary().then(value => { if (ticket === generation.current) setLibrary(value) })
      .catch(cause => { if (ticket === generation.current) setError(cause instanceof Error ? cause.message : '技能库读取失败。') })
    return () => { generation.current++ }
  }, [port,open])
  const execute = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，请核对后重试。') } finally { setBusy(false) }
  }
  const inspect = () => execute(async () => {
    const result = await port.inspectSkill(path)
    setInspection(result)
  })
  const register = (id: string) => execute(async () => {
    await port.registerSkill(id); setPendingRegistration(null)
    setNotice('已加入可选目录。回到助手的能力页，勾选并保存后才会供后续运行使用。'); onChanged()
  })
  const commit = (candidateName: string) => execute(async () => {
    if (!inspection) return
    const candidate = inspection.candidates.find(item => item.name === candidateName)
    if (!candidate) return
    const identity = `${inspection.stagingToken}:${candidateName}:${candidate.contentDigest}`
    if (!commits.current.has(identity)) commits.current.set(identity,crypto.randomUUID())
    const result = await port.commitSkill(inspection, { candidateName, expectedSkillVersion: candidate.existingSkillVersion,
      confirmUpdate: candidate.importAction === 'update', commandId: commits.current.get(identity)! })
    if (result.status !== 'applied') throw new Error(result.message || '导入未被接受。')
    if (!result.skillId) throw new Error('导入已提交，但未取得技能编号。请重新读取技能库核对，不要重复创建。')
    setPendingRegistration(result.skillId)
    await port.registerSkill(result.skillId); setPendingRegistration(null)
    setNotice('Skill 已导入并加入可选目录，尚未为任何助手自动启用。'); onChanged()
    setLibrary(await port.listLibrary())
  })
  const hookBody = JSON.stringify({ hooks: { [hookEvent]: [{ hooks: [{ type:'command', command:hookCommand, timeout:30 }] }] } },null,2)
  const create = () => execute(async () => {
    if (!name.trim() || !(tab === 'hook' ? hookCommand.trim() : body.trim())) throw new Error('请填写名称和内容。')
    const id = snippetId.current ??= `user-${crypto.randomUUID()}`
    if (tab === 'rule') await port.putRule({ id, name:name.trim(), body, scope:'cloud' })
    else await port.putHook({ id, name:name.trim(), body:hookBody, scope:'cloud', note:`${hookEvent} · 需确认后启用` })
    snippetId.current = null; setName(''); setBody(''); setHookCommand(''); setReviewHook(false)
    setNotice('已保存到能力目录，未启用、未执行。请为需要的助手勾选。'); onChanged()
  })
  return <SurfaceDialog open={open} title="能力库" description="先把能力添加到目录，再分配给需要它的助手。" theme={theme} onClose={() => { if (!busy) { if (dirty) setDiscard(true); else onClose() } }} className="ln-room-dialog"><div className="ln-room-content">
    <nav className="ln-segment-tabs" aria-label="添加能力类型" style={{marginBottom:20}}>{(['skills','rule','hook'] as const).map((value,index) => <button type="button" key={value} className={tab === value ? 'is-selected' : ''} disabled={busy} onClick={() => { setTab(value); setError(''); setNotice('') }}>{['Skills','规则','Hooks'][index]}</button>)}</nav>
    {tab === 'skills' ? <>
      <label className="ln-field"><span>Skill 文件夹</span><input value={path} aria-label="Skill 文件夹路径" onChange={event => { setPath(event.target.value); setInspection(null) }} placeholder="当前连接主机上的 Skill 文件夹路径" disabled={busy}/><small>路径属于当前主机，不是浏览器所在设备。检查只读取，不导入或执行。</small></label>
      <button type="button" className="ln-action" disabled={busy || !path.trim()} onClick={() => { void inspect() }}><Icon name="search" size={14}/>{busy ? '处理中…' : '检查文件夹'}</button>
      {inspection && <div style={{marginTop:16}}>{inspection.candidates.map(candidate => <article className="ln-cap-item" key={candidate.name}><div className="ln-cap-main"><Icon name="bulb" size={20}/><div className="ln-cap-copy"><strong>{candidate.name}</strong><p>{candidate.description}</p><p>{candidate.fileCount} 个文件 · {candidate.totalBytes} 字节</p></div><button type="button" className="ln-action" disabled={busy || !!pendingRegistration || candidate.importAction === 'official_conflict'} onClick={() => { void commit(candidate.name) }}>{candidate.importAction === 'update' ? '确认更新' : candidate.importAction === 'official_conflict' ? '内置名称冲突' : '导入'}</button></div><details className="ln-cap-detail"><summary>来源与检查结果</summary><p>{candidate.sourcePath}</p><pre>{JSON.stringify(candidate.riskSummary,null,2)}</pre></details></article>)}{inspection.rejectedCandidates.map((candidate,index) => <FormMessage error key={index}>{candidate.message}</FormMessage>)}</div>}
      {pendingRegistration && <div className="ln-review-card"><p>导入已成功，但加入能力目录尚未完成。只重试登记，不重新导入。</p><button type="button" className="ln-action" disabled={busy} onClick={() => { void register(pendingRegistration) }}>重试加入目录</button></div>}
      <div className="ln-panel-title" style={{marginTop:24}}><h3>已有技能</h3><small>{library.length} 项</small></div>
      {library.filter(skill => skill.lifecycleStatus === 'active' && skill.managementPolicy !== 'system_required').map(skill => <article className="ln-cap-item" key={skill.id}><div className="ln-cap-main"><Icon name="bulb" size={18}/><div className="ln-cap-copy"><strong>{skill.name}</strong><p>库内版本 {skill.version}</p></div><button type="button" className="ln-action" disabled={busy} onClick={() => { void register(skill.id) }}>加入可选目录</button></div></article>)}
    </> : <>
      <label className="ln-field"><span>名称</span><input value={name} maxLength={120} aria-label="能力名称" placeholder={tab === 'rule' ? '例如：前端代码约定' : '例如：任务结束后检查'} onChange={event => setName(event.target.value)}/></label>
      {tab === 'rule' ? <label className="ln-field"><span>规则正文</span><textarea value={body} rows={6} maxLength={8000} aria-label="规则正文" placeholder="描述可执行的工作约定，例如使用 pnpm、修改后运行类型检查。" onChange={event => setBody(event.target.value)}/><small>规则是给助手的指引，不会获得额外文件或账号权限。</small></label>
        : <><label className="ln-field"><span>触发时机</span><ChoiceMenu label="Hook 触发时机" theme={theme} value={hookEvent} onChange={setHookEvent} choices={[{value:'Stop',label:'本轮结束时'},{value:'SessionStart',label:'会话开始时'},{value:'PostToolUse',label:'工具完成后'}]}/></label><label className="ln-field"><span>执行命令</span><textarea value={hookCommand} aria-label="Hook 执行命令" rows={3} onChange={event => setHookCommand(event.target.value)} placeholder="例如：pnpm typecheck"/><small>目前仅创建 Claude 原生格式的命令 Hook。保存不执行；分配前仍需审阅正文、工作区和运行端。其他运行端不冒称支持。</small></label></>}
      <footer className="ln-form-actions"><small>保存到目录，不自动分配。</small><button type="button" className="ln-action is-primary" disabled={busy || !name.trim() || !(tab === 'hook' ? hookCommand.trim() : body.trim())} onClick={() => { if (tab === 'hook') setReviewHook(true); else void create() }}>添加到能力库</button></footer>
    </>}
    {error && <FormMessage error>{error}</FormMessage>}{notice && <FormMessage>{notice}</FormMessage>}
  </div>{discard && <UnsavedNotice onKeep={() => setDiscard(false)} onDiscard={() => { setName(''); setBody(''); setHookCommand(''); setDiscard(false); onClose() }}/>}
  <SurfaceDialog open={reviewHook} title="确认 Hook 定义" description="这一步只保存定义；不会执行命令，也不授予助手运行权限。" theme={theme} onClose={() => { if (!busy) setReviewHook(false) }} className="ln-room-dialog"><div className="ln-room-content"><div className="ln-review-card"><h3>{name}</h3><pre>{hookBody}</pre></div>{error && <FormMessage error>{error}</FormMessage>}<footer className="ln-form-actions"><button type="button" className="ln-action" onClick={() => setReviewHook(false)} disabled={busy}>返回修改</button><button type="button" className="ln-action is-primary" disabled={busy} onClick={() => { void create() }}>保存定义，不执行</button></footer></div></SurfaceDialog>
  </SurfaceDialog>
}

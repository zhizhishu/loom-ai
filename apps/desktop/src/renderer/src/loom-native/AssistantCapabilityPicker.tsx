import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BusinessEnvironment } from '../business-environment'
import { itemKey, selectRefusal, type CapabilityCatalog, type CapabilityKind } from '../member-catalog-model'
import { createCapabilityPort } from './capability-service'
import { inspectNativeImport, commitNativeImport, type NativeImportReview } from './native-import-service'
import { hostFeatureError, type NativeCapability, type NativeCatalog } from './host-services'
import { ChoiceMenu, FormMessage, SurfaceDialog } from './Controls'
import { McpConnections } from './McpConnections'
import { sourceStateLabel, sourceExplanation, sourceTotals, discoveryExplanation } from './native-source-presentation'
import { Icon, type IconName } from './icons'

const KINDS: { id: CapabilityKind; label: string; icon: IconName; hint: string }[] = [
  { id:'skill', label:'Skills', icon:'bulb', hint:'可复用的方法与专业技能' },
  { id:'mcp', label:'MCP', icon:'globe', hint:'连接浏览器、文件和外部服务' },
  { id:'rule', label:'规则', icon:'file', hint:'项目约定和工作习惯' },
  { id:'hook', label:'Hooks', icon:'branch', hint:'在明确时机运行的自动动作' }
]
const RUNTIME_NAMES: Record<string,string> = { 'claude-code-cli':'Claude Code', 'codex-cli':'Codex', 'deepseek-harness':'DSH', pi:'Pi' }

/** One place to discover, inspect, import and select. Selection remains a draft. */
export function AssistantCapabilityPicker({ environment, catalogAgentId, runtime, selectedKeys, onSelection,
  theme = 'day', disabled = false, threadId, onBusyChange, onCatalogue, draftAssistant = false }: {
  environment: BusinessEnvironment; catalogAgentId: string | null; runtime: string | null
  selectedKeys: string[]; onSelection(keys: string[]): void; theme?: 'day' | 'night'; disabled?: boolean; threadId?: string; draftAssistant?: boolean
  onBusyChange?(busy: boolean): void; onCatalogue?(catalog: CapabilityCatalog): void
}) {
  const port = useMemo(() => createCapabilityPort(environment.client,threadId),[environment.client,threadId])
  const [catalog,setCatalog] = useState<CapabilityCatalog | null>(null)
  const [native,setNative] = useState<NativeCatalog | null>(null)
  const [kind,setKind] = useState<CapabilityKind>('skill')
  const [source,setSource] = useState('all')
  const [query,setQuery] = useState('')
  const [loading,setLoading] = useState(true)
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  const [scanError,setScanError] = useState('')
  const [notice,setNotice] = useState('')
  const [review,setReview] = useState<NativeImportReview | null>(null)
  const [connections,setConnections] = useState(false)
  const generation = useRef(0)
  const catalogueCallback = useRef(onCatalogue)
  catalogueCallback.current = onCatalogue
  const chosen = useRef(selectedKeys)
  chosen.current = selectedKeys
  const load = useCallback(async () => {
    const ticket=++generation.current
    setLoading(true);setError('');setScanError('')
    const [library, found] = await Promise.allSettled([
      catalogAgentId ? port.read(catalogAgentId) : Promise.resolve(null),
      environment.workbench ? environment.workbench.catalog(threadId) : Promise.reject(new Error('当前主机没有提供原生发现接口。请在设置 › 运行端中检查所连接的主机。'))
    ])
    if(ticket!==generation.current)return
    if(library.status==='fulfilled'){setCatalog(library.value);if(library.value)catalogueCallback.current?.(library.value)}else setError(hostFeatureError(library.reason))
    if(found.status==='fulfilled')setNative(found.value);else {setNative(null);setScanError(hostFeatureError(found.reason))}
    setLoading(false)
  },[catalogAgentId,environment.workbench,port,threadId])
  useEffect(()=>{void load();return()=>{generation.current++}},[load])
  useEffect(()=>{onBusyChange?.(busy);return()=>onBusyChange?.(false)},[busy,onBusyChange])
  const selected = new Set(selectedKeys)
  const needle=query.trim().toLocaleLowerCase()
  const matches=(name:string,note:string)=>!needle||`${name} ${note}`.toLocaleLowerCase().includes(needle)
  const library=(catalog?.items??[]).filter(item=>!(item.kind==='skill'&&item.source==='工具箱')&&item.kind===kind&&matches(item.name,item.note))
  const found=(native?.items??[]).filter(item=>item.kind===kind&&(source!=='runtime'||!runtime||item.runtime===runtime)&&(source!=='claude'||item.runtime==='claude-code-cli')&&matches(item.name,item.sourcePath))
  const toggle=(key:string)=>onSelection(selected.has(key)?selectedKeys.filter(value=>value!==key):[...selectedKeys,key])
  const inspect=async(item:NativeCapability)=>{
    if(busy||disabled)return
    setBusy(true);setError('');setNotice('')
    try{setReview(await inspectNativeImport(environment,item,threadId))}catch(cause){setError(hostFeatureError(cause))}finally{setBusy(false)}
  }
  const importItem=async(name?:string)=>{
    if(!review||busy)return
    setBusy(true);setError('')
    try{
      const result=await commitNativeImport(environment,review,name,threadId)
      await load()
      if(result.selectionKey)onSelection([...new Set([...chosen.current,result.selectionKey])])
      setNotice(result.message);setReview(null)
      if(review.candidate.kind==='mcp')setConnections(true)
    }catch(cause){setError(hostFeatureError(cause))}finally{setBusy(false)}
  }
  const browse=async()=>{
    if(busy||disabled)return
    setBusy(true);setError('')
    try{
      const folder=await environment.selectWorkspaceDirectory()
      if(!folder)return
      const inspection=await port.inspectSkill(folder.projectPath)
      const first=inspection.candidates[0]
      if(!first)throw new Error(inspection.rejectedCandidates[0]?.message||'这个文件夹里没有可导入的 SKILL.md。')
      setReview({candidate:{sourceId:'user-picked-directory',kind:'skill',name:first.name,runtime:(runtime||'pi') as NativeCapability['runtime'],sourceScope:'user',sourcePath:folder.projectPath,digest:first.contentDigest,importable:true},commandId:crypto.randomUUID(),inspection})
    }catch(cause){setError(hostFeatureError(cause))}finally{setBusy(false)}
  }
  return <section className="ln-assistant-cap-picker" aria-label="发现并选择助手能力">
    <div className="ln-onboarding-section-head"><div><h3>把合适的能力交给它</h3><p>从这台主机发现，也可以直接导入。先选择，最后一起保存。</p></div><button type="button" className="ln-action" disabled={busy||loading||disabled} onClick={()=>{void load()}}><Icon name="refresh" size={14}/>刷新</button></div>
    <nav className="ln-cap-kind-tabs" aria-label="四类助手能力">{KINDS.map(entry=><button type="button" key={entry.id} className={kind===entry.id?'is-selected':''} aria-pressed={kind===entry.id} onClick={()=>{setKind(entry.id);setConnections(false)}}><Icon name={entry.icon} size={17}/><span>{entry.label}</span><small>{selectedKeys.filter(key=>key.startsWith(entry.id+':')).length}</small></button>)}</nav>
    <div className="ln-picker-filter"><label className="ln-cap-search"><Icon name="search" size={14}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索能力名称或来源…" aria-label="搜索可选能力"/></label><ChoiceMenu label="能力来源" value={source} onChange={setSource} theme={theme} choices={[...(runtime?[{value:'runtime',label:`${RUNTIME_NAMES[runtime]||runtime} 的来源`}]:[]),{value:'all',label:'全部来源（推荐）'},{value:'claude',label:'Claude 原生主来源'},{value:'library',label:'LOOM 能力库'},{value:'native',label:'全部本机客户端'}]}/></div>
    <p className="ln-native-help">Claude 作为原生配置主来源；Codex / DSH / Pi 的兼容来源会分别标注。发现不等于已导入、已保存或在本次运行生效。</p>
    <div className="ln-picker-source-line"><Icon name="computer" size={14}/><span>{native?.home?.root?'本机来源已确认':'当前连接主机'}{native?` · 发现 ${native.items.length} 项`:''}</span><details><summary>扫描范围</summary><p>{native?.home?.root||'读取主机允许的原生客户端配置；不扫描浏览器设备。'}</p><p>显示真实来源与兼容限制。勾选不复制账号、不执行自动动作。</p>{native?.sources?.filter(item=>item.kind===kind||item.kind==='config').map((item,index)=><p key={index}><strong>{RUNTIME_NAMES[item.runtime]||item.runtime} · {sourceStateLabel(item)}</strong><br/>{sourceExplanation(item)}{item.path!=='<declared>'&&<><br/><span>{item.path}</span></>}</p>)}{native?.errors.map((item,index)=><p key={'error-'+index}>{item.runtime?RUNTIME_NAMES[item.runtime]||item.runtime:'主机'} · {discoveryExplanation(item.code)}</p>)}</details></div>
    {error&&<FormMessage error>{error}</FormMessage>}{scanError&&<FormMessage error>{scanError}</FormMessage>}{notice&&<FormMessage>{notice}</FormMessage>}
    {native?.sources&&sourceTotals(native).needsAttention>0&&<FormMessage>有 {sourceTotals(native).needsAttention} 个来源尚不能读取。展开“扫描范围”查看原因；不会为了显示更多资源而越过目录边界。</FormMessage>}
    {loading?<p className="ln-inspector-empty">正在读取能力库和本机客户端…</p>:<>
      {source!=='native'&&source!=='claude'&&<div className="ln-picker-group"><h4>可以直接选择 <span>{library.length}</span></h4>{library.map(item=>{
        const key=itemKey(item), isSelected=selected.has(key)
        const missingScope=!draftAssistant&&selectRefusal({...item,selected:isSelected})==='hook-scope'
        const unsupported=!draftAssistant&&item.kind==='hook'&&runtime!==null&&!!item.hookDefinition&&item.hookDefinition.reviewScope.adapterKind!==runtime
        return <label className={`ln-picker-row${isSelected?' is-selected':''}`} key={key}><input type="checkbox" checked={isSelected} disabled={disabled||busy||!isSelected&&((!!item.sourceError&&!(draftAssistant&&item.kind==='hook'))||unsupported||missingScope)} onChange={()=>toggle(key)}/><span><strong>{item.name}{item.risk==='high'&&<i>需确认</i>}</strong><small>{draftAssistant&&item.kind==='hook'?'创建时会按新助手的实际运行端、正文和工作范围重新校验及确认；此处只作选择。':item.sourceError|| (missingScope?'请先打开这个助手的对话，确认工作目录后再启用。':unsupported?'此 Hook 属于另一运行方式，需要重新确认范围。':item.note||item.source||KINDS.find(row=>row.id===kind)?.hint)}</small></span><span className="ln-picker-state">{isSelected?'已选':'库内'}</span></label>
      })}{!library.length&&<p className="ln-picker-empty">{needle?'没有匹配的库内能力。':'还没有这一类可选能力，可从下方本机来源检查并导入。'}</p>}</div>}
      {source!=='library'&&<div className="ln-picker-group"><h4>{source==='runtime'&&runtime?`从 ${RUNTIME_NAMES[runtime]||runtime} 发现`:source==='claude'?'从 Claude 原生主来源发现':'从本机客户端发现'} <span>{found.length}</span></h4>{found.map(item=><article className="ln-picker-row is-native" key={item.sourceId}><Icon name={KINDS.find(row=>row.id===kind)!.icon} size={18}/><span><strong>{item.name}</strong><small>{RUNTIME_NAMES[item.runtime]||item.runtime}{item.aliasSource?' · 继承 Claude 来源':''} · {item.sourceScope==='project'?'当前项目':'用户配置'}</small><details><summary>来源与兼容</summary><p>{item.sourcePath}</p><p>{item.import?.reason||'保存到 LOOM 目录后，可独立选择给助手；原客户端配置不变。'}</p></details></span><button type="button" className="ln-action" disabled={busy||disabled||!item.importable} onClick={()=>{void inspect(item)}}>{item.importable?'检查并导入':'仅原生使用'}</button></article>)}{!found.length&&!scanError&&<p className="ln-picker-empty">{needle?'没有匹配的本机资源。':'这个来源尚未发现此类资源。查看扫描范围，或手动选择主机上的文件夹。'}</p>}</div>}
      {native && <p className="ln-native-help" aria-live="polite">扫描结果：Skills {native.items.filter(item=>item.kind==='skill').length} · MCP {native.items.filter(item=>item.kind==='mcp').length} · Rules {native.items.filter(item=>item.kind==='rule').length} · Hooks {native.items.filter(item=>item.kind==='hook').length}。各端可能引用同一原生来源，数字不代表互不重复。</p>}
      {native?.truncated.limitHit&&<FormMessage>发现结果达到扫描边界，当前是部分列表。没有静默扫描更多私人目录。</FormMessage>}
    </>}
    <div className="ln-picker-actions">{kind==='skill'&&<button type="button" className="ln-action" disabled={disabled||busy} onClick={()=>{void browse()}}><Icon name="files" size={15}/>从文件夹导入</button>}{kind==='mcp'&&<button type="button" className="ln-action" onClick={()=>setConnections(value=>!value)}><Icon name="globe" size={15}/>{connections?'收起连接设置':'添加或管理 MCP 连接'}</button>}<small>{selectedKeys.length} 项已选 · 最终保存时分配</small></div>
    {connections&&<div className="ln-picker-connection"><McpConnections client={environment.client} theme={theme} onChanged={()=>{void load()}}/></div>}
    <SurfaceDialog open={!!review} title="检查能力来源" description="导入只登记内容；不会执行命令、复制账号或替其他助手授权。" theme={theme} onClose={()=>{if(!busy)setReview(null)}} className="ln-room-dialog"><div className="ln-room-content">
      {review&&<><h3>{review.candidate.name}</h3><p className="ln-native-help">{review.candidate.sourcePath}</p>
        {review.inspection?review.inspection.candidates.map(candidate=><div className="ln-review-card" key={candidate.name}><h4>{candidate.name}</h4><p>{candidate.description}</p><small>{candidate.fileCount} 个文件 · {candidate.totalBytes} 字节</small><button type="button" className="ln-action is-primary" disabled={busy||candidate.importAction==='official_conflict'} onClick={()=>{void importItem(candidate.name)}}>{busy?'处理中…':candidate.importAction==='update'?'确认更新并选择':'导入并选择'}</button></div>)
          : <><p>{review.candidate.kind==='mcp'?'MCP 连接默认停用、未分配；认证和启用仍需你明确操作。':'正文如下。规则是工作约定，Hook 可能执行命令；后续分配还需精确范围确认。'}</p>{review.preview?.content?.text&&<pre className="ln-picker-preview">{review.preview.content.text}</pre>}<footer className="ln-form-actions"><button type="button" className="ln-action" onClick={()=>setReview(null)} disabled={busy}>返回</button><button type="button" className="ln-action is-primary" disabled={busy} onClick={()=>{void importItem()}}>{busy?'处理中…':review.candidate.kind==='mcp'?'仅登记连接':'导入并选择'}</button></footer></>}
        {error&&<FormMessage error>{error}</FormMessage>}
      </>}
    </div></SurfaceDialog>
  </section>
}

import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import type {BusinessEnvironment} from '../business-environment'
import type {NavigationSnapshot,NavigationPreferencesSnapshot,WorkspaceSelection} from '@contracts'
import {SurfaceDialog,FormMessage} from './Controls'
import {Icon} from './icons'
import {readWorkspaceDefault,writeWorkspaceDefault,validateWorkspaceDefault} from './workspace-defaults'

type Entry = WorkspaceSelection & { key:string; threads:number }
/** User-facing saved project manager. It only registers validated locations,
 * never claims registration grants cross-root filesystem access to a Run. */
export function WorkspaceManager({open=true,embedded=false,environment,theme,onClose,onStart}:{
  open?:boolean; embedded?:boolean; environment:BusinessEnvironment;theme:'day'|'night';
  onClose():void;onStart(value:WorkspaceSelection):void
}){
  const [pref,setPref]=useState<NavigationPreferencesSnapshot|null>(null)
  const [navigation,setNavigation]=useState<NavigationSnapshot|null>(null)
  const [defaultRoot,setDefaultRoot]=useState<WorkspaceSelection|null>(null)
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [message,setMessage]=useState('')
  const generation=useRef(0)
  const preferenceApi=environment.preferences.navigationPreferences
  const validate=useCallback((choice:WorkspaceSelection)=>validateWorkspaceDefault(
    <T,>(method:'workspaces.validate',params:{path:string})=>environment.client.request<T>(method,params),choice
  ),[environment.client])
  const refresh=useCallback(async(ticket:number)=>{
    const [prefs,nav]=await Promise.all([
      preferenceApi.get(),
      environment.client.request<NavigationSnapshot>('navigation.snapshot',{})
    ])
    if(ticket!==generation.current)return
    setPref(prefs);setNavigation(nav)
  },[preferenceApi,environment.client])
  useEffect(()=>{
    if(!open)return
    const ticket=++generation.current
    setBusy(false);setError('');setMessage('')
    setDefaultRoot(readWorkspaceDefault(localStorage))
    void refresh(ticket).catch(e=>{if(ticket===generation.current)setError(e instanceof Error?e.message:'无法读取工作区')})
    return()=>{generation.current++}
  },[open,refresh])
  const entries=useMemo(()=>{
    const paths=new Set<string>(pref?.registeredProjects??[])
    for(const value of navigation?.projects??[]) paths.add(value.projectPath)
    return [...paths].filter(Boolean).slice(0,64).map(projectPath=>{
      const group=navigation?.projects.find(x=>x.projectPath===projectPath)
      const name=group?.name||projectPath.split(/[\\/]/).filter(Boolean).pop()||projectPath
      return {name,projectPath,key:'directory:'+projectPath,threads:group?.recentThreads?.length??0}
    })
  },[pref,navigation])
  const apply=async(operation:()=>Promise<void>)=>{
    if(busy)return
    const ticket=generation.current
    setBusy(true);setError('');setMessage('')
    try{await operation();if(ticket===generation.current)await refresh(ticket)}
    catch(e){if(ticket===generation.current)setError(e instanceof Error?e.message:'工作目录操作失败')}
    finally{if(ticket===generation.current)setBusy(false)}
  }
  const add=()=>void apply(async()=>{
    const selected=await environment.selectWorkspaceDirectory()
    if(!selected)return
    const checked=await validate(selected)
    await preferenceApi.registerProjects([checked.projectPath])
    setMessage('目录已登记。将它设为默认后，新工作会先在此根目录运行。')
  })
  const setDefault=(entry:Entry)=>void apply(async()=>{
    const checked=await validate(entry)
    writeWorkspaceDefault(localStorage,checked)
    setDefaultRoot(checked)
    setMessage('默认项目根已保存，下次新建工作会在使用前再次验证。')
  })
  const clearDefault=()=>void apply(async()=>{
    writeWorkspaceDefault(localStorage,null)
    setDefaultRoot(null)
    setMessage('已恢复主机默认快速对话目录。')
  })
  const start=(entry:Entry)=>void apply(async()=>{
    const checked=await validate(entry)
    onStart(checked)
    if(!embedded)onClose()
  })
  const forget=(entry:Entry)=>void apply(async()=>{
    if(entry.threads>0)throw Error('此目录仍有工作对话，请先保留它；这里只移除收藏，不删除源文件。')
    await preferenceApi.removeProject(entry.key,[])
    if(defaultRoot?.projectPath===entry.projectPath){writeWorkspaceDefault(localStorage,null);setDefaultRoot(null)}
    setMessage('已取消收藏（没有删除任何文件，原生运行端的授权也没有因此改变）。')
  })
  const content=<div className="ln-room-content">
      <p className="ln-native-help">采用多根工作区管理：一个项目作为新任务默认根，其他项目可随时独立开始工作。保存目录不授予已有 AgentRun 跨目录读写权限；需要越界操作时，仍由原生 Runtime 的权限请求决定。</p>
      <div className="ln-panel-title"><h3>默认运行目录</h3><button className="ln-action" type="button" disabled={busy} onClick={add}><Icon name="plus" size={14}/>添加目录</button></div>
      <div className="ln-workspace-choice"><Icon name="files" size={23}/><span><strong>{defaultRoot?.name||'主机默认快速对话'}</strong><small>{defaultRoot?.projectPath||'未固定到项目目录'}</small></span>{defaultRoot&&<button className="ln-text-action" type="button" disabled={busy} onClick={clearDefault}>取消默认</button>}</div>
      {error&&<FormMessage error>{error}</FormMessage>}
      {message&&<FormMessage>{message}</FormMessage>}
      <div className="ln-panel-title"><h3>已登记项目</h3><small>{entries.length} 个目录</small></div>
      <div className="ln-workspace-registered" aria-label="已登记的工作目录">
        {entries.map(entry=><div className="ln-workspace-registered-row" key={entry.projectPath}>
          <Icon name="files" size={18}/>
          <div><strong>{entry.name}{defaultRoot?.projectPath===entry.projectPath?' · 默认':''}</strong><small title={entry.projectPath}>{entry.projectPath}</small></div>
          <button type="button" className="ln-action" disabled={busy} onClick={()=>setDefault(entry)} aria-label={'设为默认目录：'+entry.name}>设默认</button>
          <button type="button" className="ln-action is-primary" disabled={busy} onClick={()=>start(entry)} aria-label={'在目录新建工作：'+entry.name}>新建工作</button>
          {entry.threads===0&&<button type="button" className="ln-text-action" disabled={busy} onClick={()=>forget(entry)} aria-label={'取消收藏目录：'+entry.name}>移除</button>}
        </div>)}
        {!entries.length&&<p className="ln-inspector-empty">还没有登记项目，可以从主机挑选目录。</p>}
      </div>
      <p className="ln-native-help">这里的「移除」仅管理项目列表，不删除文件，也不撤销已有原生 CLI 运行中的工具权限。真正跨根运行必须明确设定目标根或单独通过 Runtime 权限审批。</p>
      {!embedded&&<footer className="ln-form-actions"><button className="ln-action" type="button" disabled={busy} onClick={onClose}>关闭</button></footer>}
    </div>
  if(embedded)return <section className="ln-workspace-manager is-embedded" aria-label="工作目录">{content}</section>
  return <SurfaceDialog open={open} title="工作目录" description="管理默认运行根和多个项目；跨目录访问仍需目标运行端单独批准。" theme={theme} onClose={()=>{if(!busy)onClose()}} className="ln-room-dialog ln-workspace-manager">
    {content}
  </SurfaceDialog>
}

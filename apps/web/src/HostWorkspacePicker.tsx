import { useEffect, useRef, useState } from 'react'
import type { WorkspaceSelection } from '@contracts'
import type { ConsoleClient, WorkspaceListing } from './client'
import { FormMessage, SurfaceDialog } from '../../desktop/src/renderer/src/loom-native/Controls'
import { Icon } from '../../desktop/src/renderer/src/loom-native/icons'

/** Browse the authenticated Host, never the browser machine. The selected path
 * must be the exact successfully inspected listing; typing a path grants nothing. */
export function HostWorkspacePicker({ transport, onSelect }: {
  transport: ConsoleClient; onSelect(value: WorkspaceSelection | null): void
}) {
  const [listing,setListing] = useState<WorkspaceListing | null>(null)
  const [path,setPath] = useState('')
  const [editing,setEditing] = useState(false)
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  const generation = useRef(0)
  const theme = document.querySelector('.ln-app')?.getAttribute('data-theme') === 'night' ? 'night' : 'day'
  const browse = async (target?: string, offset = 0) => {
    const ticket = ++generation.current
    setBusy(true);setError('')
    try {
      const next = await transport.getWorkspaces(target,offset)
      if (ticket !== generation.current) return
      setListing(previous => offset && previous?.projectPath === next.projectPath
        ? { ...next,directories:[...previous.directories,...next.directories] } : next)
      setPath(next.projectPath);setEditing(false)
    } catch { if (ticket === generation.current) setError('无法读取这个主机目录，请检查路径和访问权限。') }
    finally { if (ticket === generation.current) setBusy(false) }
  }
  useEffect(() => { void browse();return () => { generation.current++ } },[transport])
  const useDisabled = busy || !listing || !!error || path !== listing.projectPath
  return <SurfaceDialog open title="选择工作区域" description="浏览当前连接主机的文件夹，不会改变整机访问权限。" theme={theme} onClose={() => onSelect(null)} className="ln-room-dialog ln-workspace-browser">
    <div className="ln-room-content">
      <div className="ln-workspace-location"><button type="button" className="ln-icon-button" aria-label="上一级目录" disabled={busy || !listing?.parentPath} onClick={() => { if(listing?.parentPath) void browse(listing.parentPath) }}><Icon name="left" size={17}/></button>
        <button type="button" className="ln-icon-button" aria-label="主机主目录" disabled={busy} onClick={() => { void browse() }}><Icon name="home" size={17}/></button>
        <strong>{listing?.name || (busy ? '正在读取…' : '当前目录')}</strong>
        <button type="button" className="ln-action" disabled={busy && !listing} onClick={() => { setEditing(value => !value);setPath(listing?.projectPath || '') }}>输入路径</button>
      </div>
      {editing && <form className="ln-workspace-path" onSubmit={event => { event.preventDefault();void browse(path.trim()) }}><label className="ln-field"><span>主机完整路径</span><input aria-label="主机完整路径" value={path} onChange={event => setPath(event.target.value)} autoFocus autoComplete="off" spellCheck={false} disabled={busy}/></label><button type="submit" className="ln-action" disabled={busy || !path.trim()}>前往</button></form>}
      {editing && !!listing?.roots.length && <div className="ln-workspace-roots">{listing.roots.map(root => <button type="button" className="ln-action" key={root} disabled={busy} onClick={() => { void browse(root) }}>{root}</button>)}</div>}
      {error && <FormMessage error>{error}</FormMessage>}
      <div className="ln-workspace-directories" aria-label="主机文件夹" aria-busy={busy}>{listing?.directories.map(directory => <button type="button" key={directory.projectPath} className="ln-workspace-directory" disabled={busy} onClick={() => { void browse(directory.projectPath) }}><Icon name="files" size={20}/><span>{directory.name}</span><Icon name="right" size={14}/></button>)}
        {busy && !listing && <p className="ln-inspector-empty" role="status">正在读取主机目录…</p>}
        {!busy && listing?.directories.length === 0 && <p className="ln-inspector-empty">这里没有子目录，可以使用当前目录。</p>}
      </div>
      {listing?.nextOffset != null && <button type="button" className="ln-action" disabled={busy} onClick={() => { void browse(listing.projectPath,listing.nextOffset!) }}>加载更多</button>}
      <footer className="ln-form-actions"><small className="ln-workspace-current-path">{listing?.projectPath || '尚未选择目录'}</small><button type="button" className="ln-action" onClick={() => onSelect(null)}>取消</button><button type="button" className="ln-action is-primary" disabled={useDisabled} onClick={() => { if(listing) onSelect({ name:listing.name, projectPath:listing.projectPath }) }}>使用此目录</button></footer>
    </div>
  </SurfaceDialog>
}

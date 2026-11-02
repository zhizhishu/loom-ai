import { useEffect, useState, type JSX } from 'react'
import { UiText, uiAttribute } from './interface-language'

export interface WorkspaceTreeEntry {
  name: string
  kind: 'file' | 'dir'
  children?: WorkspaceTreeEntry[]
  truncated?: boolean
}

export interface WorkspaceTreeModel {
  ownerName: string
  online: boolean
  lastHeartbeat?: string | null
  status: 'ready' | 'offline' | 'loading' | 'empty' | 'error'
  relative: string
  entries: WorkspaceTreeEntry[]
  message?: string
  truncated?: boolean
}

export interface WorkspaceFileContent {
  path: string
  text: string
  size: number
  truncated: boolean
}

export interface WorkspaceFileError {
  path: string
  message: string
}

export type WorkspaceTreeLoad = (threadId: string, relative: string) => Promise<WorkspaceTreeModel | null>
export type WorkspaceFileRead = (threadId: string, relative: string) => Promise<WorkspaceFileContent>

let loader: WorkspaceTreeLoad | null = null
let reader: WorkspaceFileRead | null = null

export function registerWorkspaceTreeLoader(next: WorkspaceTreeLoad | null): void {
  loader = next
}

export function registerWorkspaceFileReader(next: WorkspaceFileRead | null): void {
  reader = next
}

export function workspaceTreeLoader(): WorkspaceTreeLoad | null {
  return loader
}

export function WorkspaceProjectPane({
  ownerName,
  online,
  lastHeartbeat,
  entries,
  rootTruncated,
  selected,
  file,
  error,
  everLoaded,
  loading,
  onOpen,
  onToggle,
  onRefresh,
}: {
  ownerName: string
  online: boolean
  lastHeartbeat?: string | null
  entries: WorkspaceTreeEntry[]
  rootTruncated?: boolean
  selected?: string
  file?: WorkspaceFileContent | null
  error?: WorkspaceFileError | null
  everLoaded: boolean
  loading?: boolean
  onOpen?(path: string): void
  onToggle?(path: string): void
  onRefresh?(): void
}): JSX.Element {
  const offlineCached = !online && everLoaded
  const offlineEmpty = !online && !everLoaded
  return <div className={`workspace-project-pane${offlineCached ? ' is-offline-cached' : ''}${offlineEmpty ? ' is-offline-empty' : ''}`}>
    {offlineCached && <p className="workspace-offline-banner" role="status">
      {uiAttribute('这台机器不在线 · 最后心跳 {0} 前 · 显示的是离线前的内容', heartbeatAgo(lastHeartbeat))}
    </p>}
    <div className="workspace-project-body">
      <nav className="workspace-project-tree" aria-label={uiAttribute('项目文件')}>
        <header className="workspace-project-tree-heading">
          <strong><UiText zh="项目" /></strong>
          {ownerName && <span className="workspace-owner-chip">
            <span className={`workspace-owner-dot${online ? ' is-online' : ''}`} aria-hidden="true" />
            {ownerName}
          </span>}
          <button className="workspace-refresh" type="button" aria-label={uiAttribute('重新读取')} onClick={() => onRefresh?.()}>
            <UiText zh="刷新" />
          </button>
        </header>
        {loading && <p className="workspace-project-tree-status"><UiText zh="正在从主人节点读取…" /></p>}
        {offlineEmpty && <p className="workspace-project-tree-status"><UiText zh="这台机器不在线，上线后自动加载文件列表" /></p>}
        {!offlineEmpty && !loading && entries.length === 0 && online && <p className="workspace-project-tree-status"><UiText zh="这是空目录" /></p>}
        {!offlineEmpty && entries.length > 0 && <>
          <TreeEntries entries={entries} prefix="" depth={0} selected={selected} onOpen={onOpen} onToggle={onToggle} />
          {rootTruncated && <p className="workspace-tree-truncated"><UiText zh="已截断，只显示前 200 项" /></p>}
        </>}
      </nav>
      <WorkspaceFilePreview ownerName={ownerName} file={offlineEmpty ? null : file} error={offlineEmpty ? null : error} offlineEmpty={offlineEmpty} />
    </div>
  </div>
}

function TreeEntries({ entries, prefix, depth, selected, onOpen, onToggle }: {
  entries: WorkspaceTreeEntry[]
  prefix: string
  depth: number
  selected?: string
  onOpen?(path: string): void
  onToggle?(path: string): void
}): JSX.Element {
  return <ul className={depth === 0 ? 'workspace-project-tree-list' : 'workspace-project-tree-list workspace-tree-children'}>
    {entries.map(entry => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const expanded = entry.kind === 'dir' && entry.children !== undefined
      const current = selected === path
      return <li key={path}>
        <button
          type="button"
          className={`workspace-tree-row${current ? ' is-selected' : ''}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          aria-current={current ? 'true' : undefined}
          aria-expanded={entry.kind === 'dir' ? expanded : undefined}
          onClick={() => entry.kind === 'dir' ? onToggle?.(path) : onOpen?.(path)}
        >
          {entry.kind === 'dir' ? <Chevron expanded={expanded} /> : <span className="workspace-tree-chevron-spacer" />}
          {entry.kind === 'dir' ? <FolderIcon /> : <FileIcon />}
          <span className="workspace-tree-name">{entry.name}</span>
        </button>
        {entry.kind === 'dir' && expanded && <>
          <TreeEntries entries={entry.children ?? []} prefix={path} depth={depth + 1} selected={selected} onOpen={onOpen} onToggle={onToggle} />
          {entry.truncated && <p className="workspace-tree-truncated" style={{ paddingLeft: 8 + (depth + 1) * 16 }}><UiText zh="已截断，只显示前 200 项" /></p>}
        </>}
      </li>
    })}
  </ul>
}

export function WorkspaceFilePreview({ ownerName, file, error, offlineEmpty }: {
  ownerName: string
  file?: WorkspaceFileContent | null
  error?: WorkspaceFileError | null
  offlineEmpty?: boolean
}): JSX.Element {
  if (offlineEmpty) {
    return <section className="workspace-file-preview" aria-label={uiAttribute('文件预览')}>
      <div className="workspace-file-empty">
        <h2><UiText zh="这台机器不在线，上线后自动加载文件列表" /></h2>
      </div>
    </section>
  }
  if (error) {
    return <section className="workspace-file-preview" aria-label={uiAttribute('文件预览')}>
      <header className="workspace-file-header">
        <span className="workspace-file-path">{error.path}</span>
        {ownerName && <span className="workspace-owner-badge">{uiAttribute('在 {0} 上', ownerName)}</span>}
      </header>
      <div className="workspace-file-error" role="alert">
        <p>{error.message}</p>
      </div>
    </section>
  }
  if (!file) {
    return <section className="workspace-file-preview" aria-label={uiAttribute('文件预览')}>
      <div className="workspace-file-empty">
        <h2><UiText zh="选择一个文件预览" /></h2>
      </div>
    </section>
  }
  const lines = file.text.split('\n')
  return <section className="workspace-file-preview" aria-label={uiAttribute('文件预览')}>
    <header className="workspace-file-header">
      <span className="workspace-file-path">{file.path}</span>
      <span className="workspace-file-size">{formatSize(file.size)}</span>
      {ownerName && <span className="workspace-owner-badge">{uiAttribute('在 {0} 上', ownerName)}</span>}
      {file.truncated && <span className="workspace-file-truncated"><UiText zh="已截断，只显示前 1 MiB" /></span>}
    </header>
    <div className="workspace-file-body">
      {lines.map((line, index) => <div className="workspace-file-line" key={index}>
        <span className="workspace-file-gutter">{index + 1}</span>
        <code>{line || ' '}</code>
      </div>)}
    </div>
  </section>
}

export function LiveWorkspaceProjectTree({ threadId, onOpen }: {
  threadId: string
  onOpen(path: string): void
}): JSX.Element | null {
  const active = workspaceTreeLoader()
  const [model, setModel] = useState<WorkspaceTreeModel | null>(null)
  const [entries, setEntries] = useState<WorkspaceTreeEntry[]>([])
  const [selected, setSelected] = useState<string>()
  const [file, setFile] = useState<WorkspaceFileContent | null>(null)
  const [error, setError] = useState<WorkspaceFileError | null>(null)
  const [rootTruncated, setRootTruncated] = useState(false)
  const [everLoaded, setEverLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const reload = (): void => {
    if (!active) return
    setLoading(true)
    void active(threadId, '').then(next => {
      setLoading(false)
      if (!next) { setModel(null); return }
      setModel(current => next.status === 'offline' && current
        ? { ...next, ownerName: next.ownerName || current.ownerName, lastHeartbeat: next.lastHeartbeat ?? current.lastHeartbeat }
        : next)
      if (next.status === 'offline') return
      setEverLoaded(true)
      setRootTruncated(Boolean(next.truncated))
      setEntries(next.entries)
    }).catch(() => {
      setLoading(false)
      setModel(current => current ? { ...current, online: false, status: 'offline' } : { ownerName: '', online: false, status: 'offline', relative: '', entries: [] })
    })
  }
  useEffect(() => { reload() }, [active, threadId])
  if (!active || !model) return null
  const toggle = (path: string): void => {
    const current = findEntry(entries, path)
    if (current?.children) {
      setEntries(list => updateEntry(list, path, entry => ({ ...entry, children: undefined })))
      return
    }
    void active(threadId, path).then(next => {
      if (!next) return
      if (next.status === 'offline') {
        setModel(model => model ? { ...model, online: false, status: 'offline', lastHeartbeat: next.lastHeartbeat ?? model.lastHeartbeat } : model)
        return
      }
      setEntries(list => updateEntry(list, path, entry => ({ ...entry, children: next.entries, truncated: next.truncated })))
    })
  }
  const open = (path: string): void => {
    setSelected(path)
    setError(null)
    if (!reader) { onOpen(path); return }
    void reader(threadId, path).then(content => {
      setFile({ ...content, path })
      setError(null)
      onOpen(path)
    }).catch((reason: unknown) => {
      const message = reason instanceof Error && reason.message ? reason.message : '文件读取失败'
      setError({ path, message })
    })
  }
  return <WorkspaceProjectPane
    ownerName={model.ownerName}
    online={model.online && model.status !== 'offline'}
    lastHeartbeat={model.lastHeartbeat}
    entries={everLoaded ? entries : []}
    rootTruncated={rootTruncated}
    selected={selected}
    file={file}
    error={error}
    everLoaded={everLoaded}
    loading={loading && !everLoaded}
    onOpen={open}
    onToggle={toggle}
    onRefresh={reload}
  />
}

function findEntry(entries: WorkspaceTreeEntry[], path: string, prefix = ''): WorkspaceTreeEntry | undefined {
  for (const entry of entries) {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entryPath === path) return entry
    if (entry.children) {
      const nested = findEntry(entry.children, path, entryPath)
      if (nested) return nested
    }
  }
  return undefined
}

function updateEntry(entries: WorkspaceTreeEntry[], path: string, change: (entry: WorkspaceTreeEntry) => WorkspaceTreeEntry, prefix = ''): WorkspaceTreeEntry[] {
  return entries.map(entry => {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entryPath === path) return change(entry)
    if (entry.children) return { ...entry, children: updateEntry(entry.children, path, change, entryPath) }
    return entry
  })
}

function heartbeatAgo(value?: string | null): string {
  if (!value) return '未知'
  const then = Date.parse(value)
  if (Number.isNaN(then)) return value
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.round(minutes / 60)} 小时`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function Chevron({ expanded }: { expanded: boolean }): JSX.Element {
  return <svg className={`workspace-tree-chevron${expanded ? ' is-expanded' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
    <path d="M6 4.5 10 8l-4 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

function FolderIcon(): JSX.Element {
  return <svg className="workspace-tree-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M2.5 4.5h4l1 1.5h6v6.5h-11z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
}

function FileIcon(): JSX.Element {
  return <svg className="workspace-tree-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4.5 2.5h5l3 3v8h-8z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
}

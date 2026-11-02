import { useEffect, useState, type JSX } from 'react'
import { UiText, uiAttribute } from './interface-language'

export interface WorkspaceTreeEntry {
  name: string
  kind: 'file' | 'dir'
  children?: WorkspaceTreeEntry[]
}

export interface WorkspaceTreeModel {
  ownerName: string
  status: 'ready' | 'offline' | 'loading' | 'empty' | 'error'
  relative: string
  entries: WorkspaceTreeEntry[]
  message?: string
  truncated?: boolean
}

export type WorkspaceTreeLoad = (threadId: string, relative: string) => Promise<WorkspaceTreeModel | null>

let loader: WorkspaceTreeLoad | null = null

export function registerWorkspaceTreeLoader(next: WorkspaceTreeLoad | null): void {
  loader = next
}

export function workspaceTreeLoader(): WorkspaceTreeLoad | null {
  return loader
}

export function WorkspaceProjectTree({ model, selected, onOpen, onToggle }: {
  model: WorkspaceTreeModel
  selected?: string
  onOpen?(path: string): void
  onToggle?(path: string): void
}): JSX.Element {
  return <nav className="workspace-project-tree" aria-label={uiAttribute('项目文件')}>
    <header className="workspace-project-tree-heading">
      <strong><UiText zh="项目" /></strong>
      {model.ownerName ? <span>{model.ownerName}</span> : null}
    </header>
    {model.status === 'loading' && <p className="workspace-project-tree-status"><UiText zh="正在从主人节点读取…" /></p>}
    {model.status === 'offline' && <p className="workspace-project-tree-status" role="alert"><UiText zh="这台机器不在线" /></p>}
    {model.status === 'error' && <p className="workspace-project-tree-status" role="alert"><UiText zh={model.message ?? '列出文件失败'} /></p>}
    {model.status === 'empty' && <p className="workspace-project-tree-status"><UiText zh="这是空目录" /></p>}
    {model.status === 'ready' && <TreeEntries entries={model.entries} prefix="" selected={selected} onOpen={onOpen} onToggle={onToggle} />}
    {model.truncated && <p className="workspace-project-tree-status"><UiText zh="只列出了前 200 项" /></p>}
  </nav>
}

function TreeEntries({ entries, prefix, selected, onOpen, onToggle }: {
  entries: WorkspaceTreeEntry[]
  prefix: string
  selected?: string
  onOpen?(path: string): void
  onToggle?(path: string): void
}): JSX.Element {
  return <ul className="workspace-project-tree-list">
    {entries.map(entry => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const current = selected === path
      return <li key={path}>
        <button
          type="button"
          className={current ? 'is-selected' : undefined}
          aria-current={current ? 'true' : undefined}
          aria-expanded={entry.kind === 'dir' ? Boolean(entry.children) : undefined}
          onClick={() => entry.kind === 'dir' ? onToggle?.(path) : onOpen?.(path)}
        >
          {entry.kind === 'dir' ? `${entry.name}/` : entry.name}
        </button>
        {entry.kind === 'dir' && entry.children && (
          <TreeEntries entries={entry.children} prefix={path} selected={selected} onOpen={onOpen} onToggle={onToggle} />
        )}
      </li>
    })}
  </ul>
}

export function LiveWorkspaceProjectTree({ threadId, onOpen }: {
  threadId: string
  onOpen(path: string): void
}): JSX.Element | null {
  const active = workspaceTreeLoader()
  const [model, setModel] = useState<WorkspaceTreeModel | null>(null)
  const [selected, setSelected] = useState<string>()
  useEffect(() => {
    if (!active) return
    let cancelled = false
    setModel({ ownerName: '', status: 'loading', relative: '', entries: [] })
    void active(threadId, '').then(next => { if (!cancelled) setModel(next) }).catch(() => {
      if (!cancelled) setModel({ ownerName: '', status: 'error', relative: '', entries: [], message: '列出文件失败' })
    })
    return () => { cancelled = true }
  }, [active, threadId])
  if (!active || !model) return null
  const toggle = (path: string): void => {
    if (!active) return
    void active(threadId, path).then(next => {
      if (!next) return
      setModel(current => current ? insertChildren(current, path, next.entries) : current)
    })
  }
  return <WorkspaceProjectTree
    model={model}
    selected={selected}
    onToggle={toggle}
    onOpen={path => { setSelected(path); onOpen(path) }}
  />
}

function insertChildren(model: WorkspaceTreeModel, path: string, children: WorkspaceTreeEntry[]): WorkspaceTreeModel {
  const attach = (entries: WorkspaceTreeEntry[], prefix: string): WorkspaceTreeEntry[] => entries.map(entry => {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entryPath === path) return { ...entry, children }
    if (entry.children) return { ...entry, children: attach(entry.children, entryPath) }
    return entry
  })
  return { ...model, status: model.status === 'loading' ? 'ready' : model.status, entries: attach(model.entries, '') }
}

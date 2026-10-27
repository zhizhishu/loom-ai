import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { WorkspaceSelection } from '@contracts'
import {
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogGlyph,
  AppDialogHeader,
  DialogControlIcon
} from '../../desktop/src/renderer/src/AppDialog'
import type { ConsoleClient, WorkspaceListing } from './client'

export function HostWorkspacePicker({ transport, onSelect }: { transport: ConsoleClient; onSelect(value: WorkspaceSelection | null): void }) {
  const [listing, setListing] = useState<WorkspaceListing | null>(null)
  const [path, setPath] = useState('')
  const [pathEditorOpen, setPathEditorOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const pathInputRef = useRef<HTMLInputElement>(null)

  async function browse(target?: string, offset = 0): Promise<void> {
    const current = ++generation.current
    setBusy(true)
    setError('')
    try {
      const next = await transport.getWorkspaces(target, offset)
      if (current !== generation.current) return
      setListing((previous) => offset && previous?.projectPath === next.projectPath
        ? { ...next, directories: [...previous.directories, ...next.directories] }
        : next)
      setPath(next.projectPath)
      setPathEditorOpen(false)
    } catch {
      if (current === generation.current) setError('无法读取该目录。请检查路径、访问权限和连接状态。')
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }

  useEffect(() => {
    void browse()
    return () => { generation.current++ }
  }, [transport])

  useEffect(() => {
    if (pathEditorOpen) pathInputRef.current?.focus()
  }, [pathEditorOpen])

  const togglePathEditor = (): void => {
    if (pathEditorOpen) {
      setPath(listing?.projectPath ?? '')
      setError('')
    }
    setPathEditorOpen((current) => !current)
  }
  const parentLabel = workspaceLocationLabel(listing?.parentPath ?? null)
  const useDisabled = busy || !listing || Boolean(error) || path !== listing.projectPath

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onSelect(null) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <AppDialogContent className="web-workspace-picker" width="wide">
          <AppDialogHeader
            title="选择项目目录"
            description="浏览目录，然后使用当前目录。"
            hideDescription
          />
          <AppDialogBody className="web-workspace-body">
            <div className="web-workspace-location" aria-label="当前位置">
              <button
                type="button"
                className="web-workspace-location-action"
                aria-label="上一级"
                disabled={busy || !listing?.parentPath}
                onClick={() => listing?.parentPath && void browse(listing.parentPath)}
              >
                <DialogControlIcon name="back" />
              </button>
              <button
                type="button"
                className="web-workspace-location-action"
                aria-label="主目录"
                disabled={busy}
                onClick={() => void browse()}
              >
                <WorkspaceHomeGlyph />
              </button>
              <div className="web-workspace-breadcrumb" title={listing?.projectPath}>
                {parentLabel && <><span>{parentLabel}</span><WorkspaceChevron /></>}
                <strong>{listing?.name ?? (busy ? '正在读取…' : '当前目录')}</strong>
              </div>
              <button
                type="button"
                className="web-workspace-location-action"
                aria-label="输入完整路径"
                aria-expanded={pathEditorOpen}
                aria-controls="web-workspace-path-editor"
                disabled={busy && !listing}
                onClick={togglePathEditor}
              >
                <AppDialogGlyph name="pencil" />
              </button>
            </div>

            {pathEditorOpen && (
              <form
                id="web-workspace-path-editor"
                className="web-workspace-path"
                onSubmit={(event) => {
                  event.preventDefault()
                  void browse(path.trim())
                }}
              >
                <label htmlFor="host-workspace-path">完整路径</label>
                <div>
                  <input
                    ref={pathInputRef}
                    id="host-workspace-path"
                    disabled={busy}
                    value={path}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={Boolean(error)}
                    onChange={(event) => {
                      setPath(event.target.value)
                      setError('')
                    }}
                  />
                  <button type="submit" className="quiet-button compact" disabled={busy || !path.trim()}>前往</button>
                </div>
                {listing && listing.roots.length > 0 && (
                  <div className="web-workspace-roots" aria-label="可用位置">
                    {listing.roots.map((root) => (
                      <button type="button" key={root} disabled={busy} onClick={() => void browse(root)}>{root}</button>
                    ))}
                  </div>
                )}
              </form>
            )}

            {error && <p className="web-workspace-error" role="alert">{error}</p>}
            <div className="web-workspace-list" aria-label="文件夹" aria-busy={busy}>
              {listing?.directories.map((choice) => (
                <button
                  type="button"
                  className="web-workspace-choice"
                  key={choice.projectPath}
                  disabled={busy}
                  onClick={() => void browse(choice.projectPath)}
                >
                  <AppDialogGlyph name="folder" />
                  <span>{choice.name}</span>
                  <WorkspaceChevron />
                </button>
              ))}
              {busy && !listing && <p className="web-workspace-status" role="status">正在读取目录…</p>}
              {!busy && listing?.directories.length === 0 && (
                <p className="web-workspace-status">这里没有子目录，可以使用当前目录。</p>
              )}
            </div>
            {listing?.nextOffset != null && (
              <button
                type="button"
                className="quiet-button compact web-workspace-more"
                disabled={busy}
                onClick={() => void browse(listing.projectPath, listing.nextOffset!)}
              >
                加载更多目录
              </button>
            )}
          </AppDialogBody>
          <AppDialogFooter leading={(
            <div className="web-workspace-current">
              <span>当前目录</span>
              {listing
                ? <><strong>{listing.name}</strong><small title={listing.projectPath}>{listing.projectPath}</small></>
                : <strong>{busy ? '正在读取…' : '尚未选择'}</strong>}
            </div>
          )}>
            <button type="button" className="quiet-button" onClick={() => onSelect(null)}>取消</button>
            <button
              type="button"
              className="primary-button conversation-primary-button"
              disabled={useDisabled}
              onClick={() => listing && onSelect({ name: listing.name, projectPath: listing.projectPath })}
            >
              使用此目录
            </button>
          </AppDialogFooter>
        </AppDialogContent>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function workspaceLocationLabel(path: string | null): string {
  if (!path) return ''
  const normalized = path.replace(/[\\/]+$/u, '')
  return normalized.split(/[\\/]/u).filter(Boolean).at(-1) ?? path
}

function WorkspaceHomeGlyph(): React.JSX.Element {
  return (
    <svg className="dialog-glyph" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3 9 7-6 7 6v8H3Z" />
      <path d="M8 17v-5h4v5" />
    </svg>
  )
}

function WorkspaceChevron(): React.JSX.Element {
  return <span className="web-workspace-chevron" aria-hidden="true"><DialogControlIcon name="chevron" /></span>
}

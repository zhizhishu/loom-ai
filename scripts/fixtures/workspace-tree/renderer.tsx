import { createRoot } from 'react-dom/client'
import { WorkspaceProjectPane, type WorkspaceFileContent, type WorkspaceTreeEntry } from '../../../apps/desktop/src/renderer/src/WorkspaceProjectTree'
import '../../../packages/ui/src/theme.css'
import '../../../apps/desktop/src/renderer/src/styles.css'

const params = new URLSearchParams(location.search)
const night = params.get('theme') === 'night'
const state = params.get('state') ?? 'ready'
document.documentElement.dataset.theme = night ? 'night' : 'day'
document.documentElement.style.colorScheme = night ? 'dark' : 'light'
document.body.style.margin = '0'
document.body.style.background = 'var(--canvas)'

const heartbeat = new Date(Date.now() - 125_000).toISOString()
const entries: WorkspaceTreeEntry[] = [
  {
    name: 'src',
    kind: 'dir',
    children: [{ name: 'main.rs', kind: 'file' }],
  },
  { name: 'hello.txt', kind: 'file' },
  { name: 'notes.log', kind: 'file' },
]
const hello: WorkspaceFileContent = {
  path: 'hello.txt',
  size: 48,
  truncated: false,
  text: 'from-b\nowner: desk-b\nworktree: /home/b/loom/mission_b6\n',
}
const notes: WorkspaceFileContent = {
  path: 'notes.log',
  size: 1024 * 1024 + 8,
  truncated: true,
  text: [
    '2026-11-02T00:00:01Z build started',
    '2026-11-02T00:00:02Z compiled protocol',
    '2026-11-02T00:00:04Z worktree ready',
    '2026-11-02T00:00:05Z reading hello.txt',
    '2026-11-02T00:00:06Z listed 3 entries',
    '2026-11-02T00:00:08Z output exceeded 1 MiB',
    '…',
  ].join('\n'),
}
const cached = state === 'offline-cached'
const empty = state === 'offline-empty'
const truncated = state === 'truncated'
const file = empty ? null : truncated ? notes : hello

createRoot(document.getElementById('root')!).render(
  <div className="file-preview-retained-host" style={{ position: 'relative', width: '1040px', height: '700px' }}>
    <WorkspaceProjectPane
      ownerName="desk-b"
      online={!cached && !empty}
      lastHeartbeat={heartbeat}
      entries={empty ? [] : entries}
      rootTruncated={truncated}
      selected={empty ? undefined : file?.path}
      file={file}
      everLoaded={!empty}
      onRefresh={() => undefined}
    />
  </div>
)

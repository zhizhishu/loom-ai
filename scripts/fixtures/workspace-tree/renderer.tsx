import { createRoot } from 'react-dom/client'
import { WorkspaceProjectTree, type WorkspaceTreeModel } from '../../../apps/desktop/src/renderer/src/WorkspaceProjectTree'
import '../../../packages/ui/src/theme.css'
import '../../../apps/desktop/src/renderer/src/styles.css'

const params = new URLSearchParams(location.search)
const night = params.get('theme') === 'night'
const offline = params.get('state') === 'offline'
document.documentElement.dataset.theme = night ? 'night' : 'day'
document.documentElement.style.colorScheme = night ? 'dark' : 'light'
document.body.style.margin = '0'
document.body.style.background = 'var(--canvas)'

const ready: WorkspaceTreeModel = {
  ownerName: 'desk-b',
  status: 'ready',
  relative: '',
  entries: [
    { name: 'src', kind: 'dir', children: [{ name: 'main.rs', kind: 'file' }] },
    { name: 'hello.txt', kind: 'file' },
  ],
}
const model: WorkspaceTreeModel = offline
  ? { ownerName: 'desk-b', status: 'offline', relative: '', entries: [] }
  : ready

createRoot(document.getElementById('root')!).render(
  <div className="file-preview-retained-host" style={{ position: 'relative', width: '1040px', height: '700px' }}>
    <WorkspaceProjectTree model={model} selected={offline ? undefined : 'hello.txt'} />
    <section className="file-preview-pane" aria-label="文件预览">
      {offline
        ? <div className="file-preview-empty"><h2>这台机器不在线</h2><p>已经打开的内容留在这里，不能再向主人要新的字节。</p></div>
        : <div className="file-preview-content"><pre>from-b</pre></div>}
    </section>
  </div>
)

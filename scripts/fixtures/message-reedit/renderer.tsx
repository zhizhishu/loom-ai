import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import * as Dialog from '@radix-ui/react-dialog'
import { NavigationShell } from '../../../apps/desktop/src/renderer/src/NavigationShell'
import { createDesktopNavigation } from '../../../apps/desktop/src/renderer/src/desktop-navigation'
import { ThreadNavigation } from '../../../apps/desktop/src/renderer/src/ThreadNavigation'
import { AppHeader } from '../../../apps/desktop/src/renderer/src/AppHeader'
import { ThreadWorkspace } from '../../../apps/desktop/src/renderer/src/ThreadWorkspace'
import { ThreadClientProvider } from '../../../apps/desktop/src/renderer/src/camp-client'
import { FilePreviewProvider } from '../../../apps/desktop/src/renderer/src/FilePreviewContext'
import { CurrentUserProfileContext } from '../../../apps/desktop/src/renderer/src/CurrentUserProfile'
import { MobileLayoutProvider } from '../../../apps/desktop/src/renderer/src/MobileLayout'
import { AppDialogBody, AppDialogContent, AppDialogFooter, AppDialogHeader, DialogControlIcon } from '../../../apps/desktop/src/renderer/src/AppDialog'
import { NavigationIcon } from '../../../apps/desktop/src/renderer/src/NavigationIcon'
import { initializeInterfaceLanguage } from '../../../apps/desktop/src/renderer/src/interface-language'
import { review, currentId, secondaryId, installations } from './model'
import '../../../apps/desktop/src/renderer/src/styles.css'
import './prototype.css'

declare const __SOURCE_COMMIT__: string
initializeInterfaceLanguage({ interfaceLanguage: 'zh-CN', interfaceLanguagePreference: 'zh-CN',
  systemLanguage: 'zh-CN', languageRevision: 0, readError: null })
document.documentElement.dataset.platform = 'darwin'
document.documentElement.dataset.rovaiPlatform = 'darwin'
document.documentElement.dataset.rovaiSurface = 'desktop'
const params = new URLSearchParams(location.search)
function Workbench() {
  const state = useSyncExternalStore(review.subscribe, review.get)
  const snapshot = useMemo(() => review.snapshot(), [state.messages, state.currentId, state.generation])
  const [theme, setTheme] = useState(params.get('theme') === 'night' ? 'night' : 'day')
  const [controls, setControls] = useState(params.get('pure') !== '1')
  const [details, setDetails] = useState(false)
  const [inspector, setInspector] = useState<any>(null)
  const [detailHost, setDetailHost] = useState<HTMLElement | null>(null)
  const [placement, setPlacement] = useState<any>('inspector')
  const navigation = useMemo(() => {
    const nav = createDesktopNavigation(async (target, transaction) => {
      if (target.kind === 'camp') await review.openThread(target.threadId, true)
      transaction.commit()
    })
    nav.reset({ kind: 'camp', threadId: state.currentId } as any); review.navigation = nav; return nav
  }, [])
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => {
    const stop = review.reeditStore.start()
    const listener = (event: KeyboardEvent) => {
      if (event.altKey && event.code === 'KeyD') { event.preventDefault(); setControls(v => !v) }
    }
    addEventListener('keydown', listener)
    Object.assign(window, { __withdrawReview: Object.assign(review, { setTheme, setControls, sourceCommit: __SOURCE_COMMIT__ }) })
    return () => { stop(); removeEventListener('keydown', listener) }
  }, [])
  useEffect(() => {
    if (!state.note) return
    const timer = setTimeout(() => review.note(''), 3200)
    return () => clearTimeout(timer)
  }, [state.note])
  const base: any = { defaultLead: { agentId: review.agents[0].agentId, displayName: '爱丽丝' }, projectBindingKind: 'directory',
    projectPath: '/review/rovai-ai', activationState: 'active', marker: 'none', lastActivityAt: '2026-10-23T06:30:00Z',
    lastActivityGlobalSequence: 10, latestCompletionGlobalSequence: 0, version: 1 }
  const navSnapshot: any = { schemaVersion: 3, throughGlobalSequence: state.messages.length,
    quickChat: { totalCount: 0, recentThreads: [] }, projects: [{ projectKey: 'rovai-ai', name: 'rovai-ai', projectPath: '/review/rovai-ai',
      lastActivityAt: base.lastActivityAt, lastActivityGlobalSequence: 10, totalCount: 2, recentThreads: [
        { ...base, id: currentId, title: '撤回消息重新编辑' }, { ...base, id: secondaryId, title: '输入框历史浏览' }
      ] }] }
  const outside = () => review.note('本稿演示消息撤回与重新编辑；此入口保留现有外观。')
  return <MobileLayoutProvider value={false}><ThreadClientProvider client={review.client as any}>
    <CurrentUserProfileContext.Provider value={{ profile: { displayName: '你', avatarDataUrl: null }, ready: true, error: null, reload() {}, save: async (v: any) => v }}>
      <FilePreviewProvider threadId={state.currentId} resolvedTheme={theme as any} api={review.fileApi}>
        <div className="review-workbench">
          <NavigationShell platform="darwin" className="app-shell-camp" navigation={navigation}>
            <div className="review-window-lights" aria-hidden="true"><i /><i /><i /></div>
            <ThreadNavigation view="camp" platform="darwin" state="ready" navigation={navSnapshot} activeThreadId={state.currentId}
              currentProjectKey="rovai-ai" pendingMemoryCount={0} onNewConversation={outside} onMembers={outside} onMemory={outside}
              onAutomations={outside} onMissions={outside} onSettings={outside} onOpenProject={outside} onCreateInProject={outside}
              onThread={t => void review.openThread(t.id)} onRemoveProject={async () => outside()} onDelete={async () => outside()}
              onRename={async () => outside()} onError={e => review.note(String(e))} />
            <AppHeader threadTitle={snapshot.thread.title} contextLabel="rovai-ai" thread={snapshot as any} detailEntryHostRef={setDetailHost} onFocusApprovals={() => {}} />
            <main className="content task-content camp-content">
              <ThreadWorkspace key={state.currentId + ':' + state.generation} snapshot={snapshot as any} projectName="rovai-ai"
                agents={review.agents as any} installations={installations as any} initialComposerDraft={review.draft() as any} busy={state.busy}
                onSend={review.send} onWithdrawMessage={review.withdraw} reeditStore={review.reeditStore} onChangeLead={async () => {}}
                onTasksChanged={async () => {}} onAddMembers={async () => { outside(); return { addedAgentIds: [], unchangedAgentIds: [], failures: [] } }}
                onResolveApproval={() => {}} stopping={false} onCancelAgentRun={async () => {}}
                executionPlacement={placement} onExecutionPlacementChange={async value => { setPlacement(value); return value }}
                worldMapEnabled={false} inspectorVisible={inspector !== null} inspectorTab={inspector ?? 'members'} detailEntryHost={detailHost}
                onOpenInspector={setInspector} onCloseInspector={() => setInspector(null)} onInspectorTabChange={setInspector}
                onOpenSingleChat={outside} onConfigureRuntime={outside} suppressExecutionAutoOpen
                onNotify={review.note} onNotifyError={e => review.note(String(e))} />
            </main>
          </NavigationShell>
          {controls ? <footer className="review-controls" aria-label="设计稿演示控制">
            <strong>撤回后重新编辑</strong><span className="review-label">交互稿</span>
            <select aria-label="演示场景" value={state.scenario} onChange={e => void review.scenario(e.target.value)}>
              {review.scenarios.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
            <button onClick={() => void review.scenario(state.scenario)}>重置场景</button>
            <div className="review-spacer" />
            <button onClick={() => setDetails(true)}>交互说明</button>
            <button className="review-icon" aria-label="切换日夜主题" title="切换日夜主题" onClick={() => setTheme(t => t === 'day' ? 'night' : 'day')}><NavigationIcon name="sun-moon" /></button>
            <button className="review-icon" aria-label="隐藏演示栏" title="隐藏演示栏 · Alt+D" onClick={() => setControls(false)}><DialogControlIcon name="close" /></button>
          </footer> : <button className="review-restore" onClick={() => setControls(true)}>演示栏</button>}
        </div>
        <Dialog.Root open={details} onOpenChange={setDetails}>
          <Dialog.Portal><Dialog.Overlay className="dialog-overlay app-dialog-overlay" />
            <AppDialogContent width="wide" className="review-notes"><AppDialogHeader title="撤回后重新编辑" description="两分钟内恢复文字的交互说明" hideDescription />
              <AppDialogBody>
                <p>在「你撤回了一条消息」旁加入一个轻量文字入口，其余会话界面与当前产品保持一致。</p>
                <ul>
                  <li>撤回成功后两分钟内可以重新编辑；刷新或重启沿用原截止时间。</li>
                  <li>默认接收时，消息气泡前显示 @队长；重新编辑只回填原文，不带入这个显示前缀。</li>
                  <li>输入框已有内容时先确认替换，取消保留草稿；原文明示的 @队员 保留身份。</li>
                  <li>原消息继续保持已撤回状态。再次发送才创建一条新消息。</li>
                  <li>历史撤回且没有原文副本的消息，不显示重新编辑入口。</li>
                  <li>原文副本在本稿自己的浏览器存储中短期保存，刷新后仅在原有效期内可用；已回填内容按普通草稿保存。场景切换仅重置演示数据。</li>
                </ul>
                <dl><dt>正式会话组件</dt><dd>侧栏、顶栏、消息区、撤回弹窗、Lexical 输入框、队员面板。</dd>
                  <dt>主题与样式</dt><dd>当前 styles.css 与 packages/ui 的完整主题。新增入口仅使用现有语义颜色。</dd>
                  <dt>演示范围</dt><dd>两分钟有效期、确认替换、过期拒绝、重新发送、刷新恢复与存储失败。</dd>
                </dl>
                <p className="review-provenance">源码基线 {__SOURCE_COMMIT__.slice(0, 12)}。固定示例消息；操作仅作用于本稿，不连接 Core 或真实队员。本稿使用本分支的正式恢复模块与组件，不代表已发布版本。</p>
              </AppDialogBody>
              <AppDialogFooter><button type="button" className="quiet-button" onClick={() => setDetails(false)}>继续体验</button></AppDialogFooter>
            </AppDialogContent>
          </Dialog.Portal>
        </Dialog.Root>
        {state.note && <div className="review-notice" role="status">{state.note}</div>}
      </FilePreviewProvider>
    </CurrentUserProfileContext.Provider>
  </ThreadClientProvider></MobileLayoutProvider>
}
createRoot(document.getElementById('root')!).render(<Workbench />)

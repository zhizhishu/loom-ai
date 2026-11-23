// rakazo@51ff52e infra/updater/src/updater-logic.ts:106-119 (default-off interval), structural comparison; PiBot@6741737 web/src/ClientUpdateSection.tsx:105,218 / ClientUpdateProvider.tsx:134,147-155, structural comparison; label 「自动检查更新」: 无参考，按用户定.
// 抄自 mikka-current@250d2451（Win11 loom\_artifacts\reference-repos\mikka-current，或 Bero /bundles/refs/mikka-current）：components/slots/settings-account.tsx、settings-preferences.tsx、settings-notifications.tsx、settings-memory.tsx（快捷键、关于两区 Mikka 没有，见各函数注释）
import { Suspense, lazy, useState } from 'react'
import { currentUserDisplayName, type InterfaceLanguagePreference } from '@contracts'
import type { BusinessEnvironment } from '../business-environment'
import type { AgentProfile } from './types'
import { ChoiceMenu } from './Controls'
import { LanguagePreferenceOptions } from '../LanguagePreferenceControl'
import { WindowCloseSettings } from '../WindowCloseSettings'
import { ComposerSendPreference } from './ComposerSendPreference'
import { useCurrentUserProfile } from '../CurrentUserProfile'
import { useInterfaceLanguageSnapshot } from '../interface-language'
import { useAppUpdates } from '../useAppUpdates'
import { RemoteAboutSettings } from '../RemoteAboutSettings'
import { SettingRow, SettingsLoading, SettingsSection } from './SettingsPrimitives'

// The 5 sections whose content is an existing whole-page surface are loaded only when
// that section is shown: they are the older shell's screens (own header, own CSS) and
// must not be pulled into every settings render.
const CurrentUserProfileEditorLazy = lazy(() => import('../CurrentUserProfileEditor').then(module => ({ default: module.CurrentUserProfileEditor })))
const NotificationSettingsLazy = lazy(() => import('../NotificationSettings').then(module => ({ default: module.NotificationSettings })))
const ShortcutSettingsLazy = lazy(() => import('../ShortcutSettings').then(module => ({ default: module.ShortcutSettings })))
const MemoryLibraryLazy = lazy(() => import('../MemoryLibrary').then(module => ({ default: module.MemoryLibrary })))
const DiagnosticsCenterLazy = lazy(() => import('../DiagnosticsCenter').then(module => ({ default: module.DiagnosticsCenter })))
const AboutUpdatesSettingsLazy = lazy(() => import('../AboutUpdatesSettings').then(module => ({ default: module.AboutUpdatesSettings })))

export type SettingsPersonalProps = {
  environment: BusinessEnvironment
  agents: AgentProfile[]
  theme: 'day' | 'night'
  onTheme(theme: 'day' | 'night'): void
  onLogout?(): void
  onRefreshWorkspace?(): void
  /** Jumps to 设置 › 连接 (diagnostics repairs). */
  onConnections(): void
  /** Jumps to 设置 › 运行端 (diagnostics repairs). */
  onRuntime(): void
}

/** The host's platform as the window already recorded it (`renderer-platform.ts:6-8`);
 * only labels depend on it. */
function hostPlatform(): NodeJS.Platform | undefined {
  if (typeof document === 'undefined') return undefined
  return (document.documentElement.getAttribute('data-rovai-platform') as NodeJS.Platform | null) ?? undefined
}

/** 账户: the local profile, the connection it belongs to, and signing out
 * (Mikka `components/slots/settings-account.tsx:19-40`, assembled at
 * `components/settings/settings-view.tsx:150`). */
export function AccountSection({ onLogout, onRefreshWorkspace }: SettingsPersonalProps) {
  const { profile, ready, error } = useCurrentUserProfile()
  const [editing, setEditing] = useState(false)
  const name = currentUserDisplayName(profile)
  return <>
    <SettingsSection id="settings-profile" title="个人资料" description="只用于这台电脑上的显示，不进入模型上下文。">
      <SettingRow title="显示名" description={error ?? (ready ? (profile.displayName.trim() || `尚未设置，默认显示「${name}」`) : '正在读取…')}>
        <button type="button" className="ln-action" aria-expanded={editing} onClick={() => setEditing(value => !value)}>{editing ? '收起' : '编辑'}</button>
      </SettingRow>
    </SettingsSection>
    {editing && <Suspense fallback={<SettingsLoading label="正在打开个人资料编辑…" rows={2}/>}>
      <CurrentUserProfileEditorLazy onStateChange={() => undefined}/>
    </Suspense>}
    <SettingsSection id="settings-connection" title="当前连接">
      <SettingRow icon="globe" title="当前主机" description="本机执行、文件、运行端与助手配置都来自这个 Host；刷新只重新读取，不修改任何数据。">
        <button type="button" className="ln-action" onClick={() => onRefreshWorkspace?.()}>刷新工作空间</button>
      </SettingRow>
    </SettingsSection>
    {onLogout && <SettingsSection id="settings-signout" title="退出">
      <SettingRow title="退出当前连接" description="退出后回到登录；这台电脑上的文件与运行端配置不会被删除。">
        <button type="button" className="ln-action is-danger" onClick={onLogout}>退出当前连接</button>
      </SettingRow>
    </SettingsSection>}
  </>
}

/** 偏好设置: appearance and language, plus the window's close behavior where the
 * platform has one (Mikka `components/slots/settings-preferences.tsx:14-38`). */
export function PreferencesSection({ environment, theme, onTheme }: SettingsPersonalProps) {
  const language = useInterfaceLanguageSnapshot()
  const windowClose = environment.desktop?.windowClose
  const changeLanguage = (value: InterfaceLanguagePreference) => {
    void environment.preferences.generalPreferences.setInterfaceLanguagePreference(value).catch(() => undefined)
  }
  return <>
    <SettingsSection id="settings-appearance" title="外观">
      <SettingRow title="主题" description="浅色或深色；只影响这个窗口的界面。">
        <ChoiceMenu value={theme} choices={[{ value: 'day', label: '浅色' }, { value: 'night', label: '深色' }]} label="外观主题" theme={theme} onChange={value => onTheme(value === 'night' ? 'night' : 'day')}/>
      </SettingRow>
    </SettingsSection>
    <SettingsSection id="settings-language" title="界面语言">
      <SettingRow title="语言" description={language.readError ? '语言偏好暂时无法读取，原记录已保留。' : '跟随系统，或固定为一种语言。'}>
        <LanguagePreferenceOptions name="ln-settings-language" className="ln-settings-language" disabled={language.readError !== null} onChange={changeLanguage}/>
      </SettingRow>
    </SettingsSection>
    {windowClose && <SettingsSection id="settings-window" title="窗口">
      <div className="ln-settings-surface"><WindowCloseSettings api={windowClose}/></div>
    </SettingsSection>}
    <ComposerSendPreference/>
  </>
}

/** 通知: in-app switches only — no push timing and no external channel (personal build). */
export function NotificationsSection(_props: SettingsPersonalProps) {
  return <Suspense fallback={<SettingsLoading label="正在打开通知设置…" rows={6}/>}><NotificationSettingsLazy/></Suspense>
}

/** 快捷键: Mikka has no shortcuts section, so the row shape comes from rakazo
 * (`apps/web/src/pages/shell/keyboard-shortcuts-dialog.tsx:30-95`: label left,
 * keys right) and the editable table is LOOM's own. */
export function ShortcutsSection(_props: SettingsPersonalProps) {
  return <Suspense fallback={<SettingsLoading label="正在打开快捷键设置…" rows={6}/>}><ShortcutSettingsLazy/></Suspense>
}

/** 记忆: the existing library view, one Bot filter away from where it lived. */
export function MemorySection({ agents }: SettingsPersonalProps) {
  return <Suspense fallback={<SettingsLoading label="正在打开记忆…" rows={5}/>}><MemoryLibraryLazy agents={agents}/></Suspense>
}

/** 数据与诊断: checks, repairs and the diagnostics export; repair targets jump to
 * the sections that own them. */
export function DiagnosticsSection({ onConnections, onRuntime }: SettingsPersonalProps) {
  return <Suspense fallback={<SettingsLoading label="正在打开诊断…" rows={5}/>}>
    <DiagnosticsCenterLazy platform={hostPlatform()} onNavigate={section => { if (section === 'mcp') onConnections(); else onRuntime() }}/>
  </Suspense>
}

/** 关于: version and updates. Mikka has no About section — its update entry is the
 * rail button (`components/nav/icon-rail-view.tsx:41-44,52`) — so the content is
 * LOOM's own and only the row/title shape follows the settings page. */
export function AboutSection({ environment }: SettingsPersonalProps) {
  const updates = useAppUpdates(environment.desktop?.appUpdates ?? null)
  if (!environment.desktop?.appUpdates) return <RemoteAboutSettings updatesApi={environment.serverUpdates}/>
  return <Suspense fallback={<SettingsLoading label="正在读取版本…" rows={3}/>}><AboutUpdatesSettingsLazy updates={updates}/></Suspense>
}

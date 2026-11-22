// 抄自 mikka-current@250d2451（Win11 loom\_artifacts\reference-repos\mikka-current，或 Bero /bundles/refs/mikka-current）：components/settings/settings-shell.tsx、components/settings/settings-view.tsx
import { Component, useEffect, useState, type ReactNode } from 'react'
import type { WorkspaceSelection } from '@contracts'
import type { BusinessEnvironment } from '../business-environment'
import type { AgentProfile } from './types'
import { SurfaceDialog, UnsavedNotice } from './Controls'
import { SettingsSidebar } from './SettingsSidebar'
import { settingsSectionDef, writeStoredSettingsSection, SETTINGS_SECTIONS, type SettingsSectionId } from './settings-sections'
import {
  AboutSection, AccountSection, DiagnosticsSection, MemorySection, NotificationsSection, PreferencesSection, ShortcutsSection,
  type SettingsPersonalProps
} from './SettingsPersonal'
import { ConnectionsSection, DeviceSection, RuntimeSection, WorkspaceDirectorySection, type SettingsMachineProps } from './SettingsMachine'
import type { ProductRuntimeKind } from './runtime-setup-service'
import './settings-page.css'

export type SettingsPageProps = {
  /** The section shown. The caller owns it so the rail and the settings page agree. */
  section: SettingsSectionId
  onSection(section: SettingsSectionId): void
  environment: BusinessEnvironment
  agents: AgentProfile[]
  theme: 'day' | 'night'
  onTheme(theme: 'day' | 'night'): void
  threadId?: string
  onLogout?(): void
  onRefreshWorkspace?(): void
  onManageAssistants(): void
  /** 工作目录 › 新建工作: leaves settings and opens the work dialog on that root. */
  onStartWorkspace(value: WorkspaceSelection): void
  /** Host reads changed: re-read capabilities and refresh the conversation. */
  onChanged(): void
  /** Receives the page's unsaved-changes guard, so leaving settings from the rail asks first. */
  onLeaveGuard?(guard: SettingsLeaveGuard | null): void
}

export type SettingsLeaveGuard = (leave: () => void) => void

/** Leave now, or hand the leave to `ask` while a half-written MCP connection is unsaved. */
export function guardSettingsLeave(dirty: boolean, leave: () => void, ask: (leave: () => void) => void) {
  if (dirty) ask(leave)
  else leave()
}

/**
 * Settings inside the app window, like Mikka (`components/settings/settings-shell.tsx:26-30`):
 * the window bar and the icon rail stay, the section list is the frame's first column and
 * the section scrolls in the second. Two columns in one frame, not one page per section
 * (`settings-view.tsx:123-124`).
 */
export function SettingsPage({
  section, onSection, environment, agents, theme, onTheme, threadId,
  onLogout, onRefreshWorkspace, onManageAssistants, onStartWorkspace, onChanged, onLeaveGuard
}: SettingsPageProps) {
  const [query, setQuery] = useState('')
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState<(() => void) | null>(null)
  const [epoch, setEpoch] = useState(0)
  const [connectionRuntime, setConnectionRuntime] = useState<ProductRuntimeKind | null>(null)
  const definition = settingsSectionDef(section)
  // Remembered locally, not in Core: the contract's `SettingsSection` has no
  // account/workspace/devices/connections id (see the plan's §5 gap 1).
  useEffect(() => {
    writeStoredSettingsSection(typeof localStorage === 'undefined' ? null : localStorage, section)
  }, [section])
  useEffect(() => { setDirty(false) }, [section])
  const askLeave = (leave: () => void) => setPending(() => leave)
  useEffect(() => {
    onLeaveGuard?.(leave => guardSettingsLeave(dirty, leave, askLeave))
    return () => onLeaveGuard?.(null)
  }, [dirty, onLeaveGuard])
  const personal: SettingsPersonalProps = {
    environment, agents, theme, onTheme, onLogout, onRefreshWorkspace,
    onConnections: () => onSection('connections'), onRuntime: () => onSection('runtime')
  }
  const machine: SettingsMachineProps = { environment, theme, threadId, onChanged }
  const go = (next: SettingsSectionId) => {
    if (next === section) return
    // A half-written MCP connection is the only unsaved state on this page.
    guardSettingsLeave(dirty, () => onSection(next), askLeave)
  }
  return <div className="ln-settings">
    <SettingsSidebar sections={SETTINGS_SECTIONS} current={section} query={query} onQuery={setQuery} onSelect={go}/>
    <main className="ln-settings-body" aria-label={`${definition.title}设置`}>
      <div className="ln-settings-content">
        {!definition.selfTitled && <h1 className="ln-settings-title">{definition.title}</h1>}
        <SectionErrorBoundary key={`${section}:${epoch}`} title={definition.title} onRetry={() => setEpoch(value => value + 1)}>
          {section === 'account' && <AccountSection {...personal}/>}
          {section === 'preferences' && <PreferencesSection {...personal}/>}
          {section === 'notifications' && <NotificationsSection {...personal}/>}
          {section === 'shortcuts' && <ShortcutsSection {...personal}/>}
          {section === 'memory' && <MemorySection {...personal}/>}
          {section === 'diagnostics' && <DiagnosticsSection {...personal}/>}
          {section === 'about' && <AboutSection {...personal}/>}
          {section === 'workspace' && <WorkspaceDirectorySection environment={environment} theme={theme} onStart={onStartWorkspace}/>}
          {section === 'runtime' && <RuntimeSection {...machine} onConnections={runtime => { setConnectionRuntime(runtime ?? null); onSection('connections') }} onManageAssistants={onManageAssistants}/>}
          {section === 'connections' && <ConnectionsSection {...machine} initialRuntime={connectionRuntime} onDirtyChange={setDirty}/>}
          {section === 'devices' && <DeviceSection {...machine}/>}
        </SectionErrorBoundary>
      </div>
    </main>
    <SurfaceDialog open={pending !== null} title="放弃未保存的连接修改？" theme={theme} onClose={() => setPending(null)} className="ln-room-dialog">
      <UnsavedNotice onKeep={() => setPending(null)} onDiscard={() => { const leave = pending; setPending(null); setDirty(false); leave?.() }}/>
    </SurfaceDialog>
  </div>
}

/** One section throwing must not take the sidebar and the rest of the page with it
 * (Mikka `components/settings/settings-view.tsx:186-198`). */
export class SectionErrorBoundary extends Component<{ title: string; onRetry(): void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: unknown) { console.error('设置分区渲染失败', error instanceof Error ? error.message : error) }
  render() {
    if (!this.state.failed) return this.props.children
    return <div className="ln-settings-error" role="alert">
      <strong>{this.props.title}暂时打不开</strong>
      <p>其他设置仍然可用；重试只重新加载这一区。</p>
      <button type="button" className="ln-action" onClick={() => { this.setState({ failed: false }); this.props.onRetry() }}>重试</button>
    </div>
  }
}

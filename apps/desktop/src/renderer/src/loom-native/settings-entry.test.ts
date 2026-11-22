import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')

describe('settings entry points', () => {
  const app = read('LoomApp.tsx')
  it('keeps only the avatar menu as the settings entry', () => {
    for (const gone of ['icon="settings"', 'setSetupOpen', 'NativeSetup', '连接与设备', '连接与设置']) expect(app).not.toContain(gone)
    expect(app).toContain('<ProfileMenu')
    expect(app).toContain("event.key === ','")
    expect(app).toMatch(/<section[^>]*className="ln-frame"[\s\S]*<SettingsPage/)
    expect(app).toContain("label=\"工作目录\" active={settingsSection === 'workspace'} onClick={() => openSettings('workspace')}")
    expect(app).toMatch(/const openSettings = [^\n]*safeInspectorAction\(/)
    expect(app).toContain('onCreated={openCreatedConversation}')
    expect(app).toContain('onCreatedConversation={openCreatedConversation}')
    expect(app).toMatch(/const openCreatedConversation[^\n]*setSettingsSection\(null\)/)
    expect(existsSync(new URL('./NativeSetup.tsx', import.meta.url))).toBe(false)
  })
  it('asks before the rail 对话 button leaves settings with unsaved changes', () => {
    expect(app).toMatch(/label="对话"[^\n]*onClick=\{\(\) => leaveSettings\(\(\) => \{ setSettingsSection\(null\)/)
  })
  it('asks before selecting a conversation leaves settings with unsaved changes', () => {
    expect(app).toMatch(/const select = [^\n]*=> leaveSettings\(\(\) => \{ void selectNow\(/)
    expect(app).toMatch(/const selectNow = async [^\n]*\n\s*setSettingsSection\(null\)/)
  })
  it('asks before opening the work panel leaves settings with unsaved changes', () => {
    expect(app).toMatch(/const openWork = [^\n]*=> leaveSettings\(\(\) => safeInspectorAction\(\(\) => \{ setSettingsSection\(null\)/)
    expect(app).toMatch(/const leaveSettings = [^\n]*settingsLeaveGuard\.current/)
    expect(app).toContain('onLeaveGuard={registerSettingsLeave}')
  })
  it('moves the setup dialog content into settings', () => {
    const machine = read('SettingsMachine.tsx')
    for (const part of ['RuntimeConnectionSettings', 'McpConnections', 'environment.nodes', 'export function RuntimeSection', 'export function DeviceSection']) expect(machine).toContain(part)
    const personal = read('SettingsPersonal.tsx')
    for (const part of ['CurrentUserProfileEditor', 'LanguagePreferenceOptions', 'WindowCloseSettings', 'NotificationSettings', 'ShortcutSettings', 'MemoryLibrary', 'DiagnosticsCenter', 'AboutUpdatesSettings']) expect(personal).toContain(part)
    const css = read('settings-page.css')
    expect(css).toContain('.ln-settings-list{')
    expect(css).toContain('.ln-settings-body{')
  })
})

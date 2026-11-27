// rakazo@51ff52e infra/updater/src/updater-logic.ts:106-119 (default-off interval), structural comparison; PiBot@6741737 web/src/ClientUpdateSection.tsx:105,218 / ClientUpdateProvider.tsx:134,147-155, structural comparison; label 「自动检查更新」: 无参考，按用户定.
import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SettingsSidebar } from './SettingsSidebar'
import { SettingRow, SettingsSection } from './SettingsPrimitives'
import { SETTINGS_SECTIONS } from './settings-sections'

const sidebar = (query: string) => renderToStaticMarkup(createElement(SettingsSidebar, { sections: SETTINGS_SECTIONS, current: 'devices', query, onQuery() {}, onSelect() {} }))

describe('settings page parts', () => {
  it('places Mikka owner permission rows in the native preferences surface',()=>{
    const source=readFileSync(new URL('./SettingsPersonal.tsx',import.meta.url),'utf8')
    for(const text of ['管理员','电脑操作','命令执行','依赖安装','Host 写文件','联网','Git 推送','settings-owner-permissions']) expect(source).toContain(text)
    for(const key of ['computerUse','commandExecution','installDependency','hostFileWrite','networkAccess','gitPush']) expect(source).toContain(key)
  })
  it('routes native About to the Desktop provider or the existing remote Server surface',()=>{
    const source=readFileSync(new URL('./SettingsPersonal.tsx',import.meta.url),'utf8')
    expect(source).toContain('environment.desktop?.appUpdates')
    expect(source).toContain('<RemoteAboutSettings updatesApi={environment.serverUpdates}')
  })
  it('renders two groups, search and one current item', () => {
    const html = sidebar('')
    expect(html.match(/class="ln-settings-item/g)).toHaveLength(11)
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toContain('个人')
    expect(html).toContain('本机与运行')
    expect(html).toContain('aria-label="搜索设置"')
  })
  it('narrows the list and shows the empty state', () => {
    expect(sidebar('设备').match(/class="ln-settings-item/g)).toHaveLength(1)
    expect(sidebar('zzzz')).toContain('没有匹配的设置')
  })
  it('renders rows inside a borderless section', () => {
    const html = renderToStaticMarkup(createElement(SettingsSection, { id: 's', title: '外观', children: createElement(SettingRow, { title: '主题', description: '浅色或深色', children: createElement('button', null, '切换') }) }))
    expect(html).toContain('aria-labelledby="s"')
    expect(html).toContain('data-settings-rows')
    expect(html).toContain('主题')
    expect(html).toContain('浅色或深色')
    expect(html).toContain('切换')
    expect(html).not.toMatch(/style="[^"]*(border-radius|background)/)
  })
})

import type { BusinessEnvironment } from '../business-environment'
import { guardSettingsLeave, SectionErrorBoundary, SettingsPage, type SettingsPageProps } from './SettingsPage'
import type { SettingsSectionId } from './settings-sections'

// SSR runs render only (no effects), so the Host is a stub whose every call resolves.
function stub(): unknown {
  return new Proxy(function host() {}, {
    get: (_target, key) => key === 'then' ? undefined : key === Symbol.toPrimitive ? () => '' : stub(),
    apply: () => Promise.resolve(undefined)
  })
}
const page = (section: SettingsSectionId) => renderToStaticMarkup(createElement(SettingsPage, {
  section, onSection() {}, environment: stub() as BusinessEnvironment, agents: [], theme: 'day', onTheme() {},
  onManageAssistants() {}, onStartWorkspace() {}, onChanged() {}
} satisfies SettingsPageProps))
const h1 = (html: string) => (html.match(/<h1[\s>]/g) ?? []).length

describe('settings page', () => {
  it('draws one page title for devices and keeps the sidebar', () => {
    const html = page('devices')
    expect(h1(html)).toBe(1)
    expect(html).toContain('<h1 class="ln-settings-title">设备</h1>')
    expect(html).toContain('aria-label="执行节点"')
    expect(html.match(/class="ln-settings-item/g)).toHaveLength(11)
  })
  it('leaves the title to self-titled sections', () => {
    const html = page('notifications')
    expect(h1(html)).toBe(0)
    expect(html).toContain('正在打开通知设置')
  })
  it('moves runtimes, MCP and the workspace manager in', () => {
    const runtime = page('runtime')
    for (const name of ['Claude Code', 'Codex', 'DSH', 'Pi']) expect(runtime).toContain(name)
    expect(page('connections')).toContain('aria-label="MCP 连接管理"')
    const workspace = page('workspace')
    expect(workspace).toContain('默认运行目录')
    expect(workspace).toContain('已登记项目')
  })
  it('is never a dialog', () => {
    for (const section of ['account', 'preferences', 'notifications', 'workspace', 'runtime', 'connections', 'devices'] as const) expect(page(section)).not.toContain('ln-dialog')
  })
})

describe('settings section error boundary', () => {
  // Server rendering cannot catch, so the failed state is rendered directly.
  class Failed extends SectionErrorBoundary { state = { failed: true } }
  it('turns a throw into a retry inside the section', () => {
    expect(SectionErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true })
    const html = renderToStaticMarkup(createElement(Failed, { title: '设备', onRetry() {}, children: createElement('p', null, 'body') }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('设备暂时打不开')
    expect(html).toContain('重试')
    expect(html).not.toContain('body')
  })
  it('wraps only the section body, so the sidebar stays when a section fails', () => {
    const source = readFileSync(new URL('./SettingsPage.tsx', import.meta.url), 'utf8')
    const sidebar = source.indexOf('<SettingsSidebar')
    const body = source.indexOf('className="ln-settings-body"')
    const boundary = source.indexOf('<SectionErrorBoundary')
    expect(sidebar).toBeGreaterThan(0)
    expect(sidebar).toBeLessThan(body)
    expect(body).toBeLessThan(boundary)
  })
})

describe('leaving settings with unsaved changes', () => {
  it('leaves at once when clean and asks first when an MCP connection is half-written', () => {
    const left: string[] = [], asked: Array<() => void> = []
    guardSettingsLeave(false, () => left.push('clean'), leave => asked.push(leave))
    expect(left).toEqual(['clean'])
    guardSettingsLeave(true, () => left.push('dirty'), leave => asked.push(leave))
    expect(left).toEqual(['clean'])
    asked[0]()
    expect(left).toEqual(['clean', 'dirty'])
  })
})

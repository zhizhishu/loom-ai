import { describe, expect, it } from 'vitest'
import { SETTINGS_SECTIONS, SETTINGS_GROUP_LABELS, SETTINGS_GROUP_TITLES, resolveSettingsSection } from './settings-sections'
import { settingsItemVisible } from './settings-sidebar-search'
import { ICON_NAMES } from './icons'

const visible = (query: string) => SETTINGS_SECTIONS.filter(section => settingsItemVisible({
  query, groupTitle: SETTINGS_GROUP_TITLES[section.group], groupLabel: SETTINGS_GROUP_LABELS[section.group],
  itemTitle: section.title, label: section.title, keywords: section.keywords, section: section.id
})).map(section => section.id)

describe('settings sections table', () => {
  it('has 7 personal and 4 machine sections in sidebar order', () => {
    expect(SETTINGS_SECTIONS).toHaveLength(11)
    expect(SETTINGS_SECTIONS.filter(row => row.group === 'personal').map(row => row.id)).toEqual(['account', 'preferences', 'notifications', 'shortcuts', 'memory', 'diagnostics', 'about'])
    expect(SETTINGS_SECTIONS.filter(row => row.group === 'machine').map(row => row.id)).toEqual(['workspace', 'runtime', 'connections', 'devices'])
  })
  it('names the tenth section 连接 and marks the five self-titled bodies', () => {
    expect(SETTINGS_SECTIONS.find(row => row.id === 'connections')?.title).toBe('连接')
    for (const row of SETTINGS_SECTIONS) { expect(row.title).not.toBe(''); expect(ICON_NAMES).toContain(row.icon); expect(typeof (row.selfTitled ?? false)).toBe('boolean') }
    expect(SETTINGS_SECTIONS.filter(row => row.selfTitled).map(row => row.id)).toEqual(['notifications', 'shortcuts', 'memory', 'diagnostics', 'about'])
  })
  it('resolves stored and legacy ids', () => {
    expect(resolveSettingsSection(null)).toBe('preferences')
    expect(resolveSettingsSection('nope')).toBe('preferences')
    expect(resolveSettingsSection('devices')).toBe('devices')
    const legacy = { general: 'workspace', nodes: 'devices', mcp: 'connections', skills: 'connections', appearance: 'preferences', monitoring: 'diagnostics' } as const
    for (const [from, to] of Object.entries(legacy)) expect(resolveSettingsSection(from)).toBe(to)
  })
  it('filters the sidebar by title, group label and keywords', () => {
    expect(visible('设备')).toEqual(['devices'])
    expect(visible('本机与运行')).toEqual(['workspace', 'runtime', 'connections', 'devices'])
    expect(visible('mcp')).toContain('connections')
    expect(visible('zzzz')).toEqual([])
  })
})

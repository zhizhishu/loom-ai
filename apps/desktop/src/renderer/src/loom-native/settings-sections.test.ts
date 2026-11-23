import { describe, expect, it } from 'vitest'
import { SETTINGS_SECTIONS, SETTINGS_GROUP_LABELS, SETTINGS_GROUP_TITLES, readSettingsSectionLink, resolveSettingsSection, settingsSectionHref } from './settings-sections'
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

describe('settings address-bar links', () => {
  it('opens each of the eleven current sections from a link', () => {
    for (const section of SETTINGS_SECTIONS) expect(readSettingsSectionLink(`?section=${section.id}`)).toBe(section.id)
  })
  it('reads back the link it writes, so a refresh keeps the section', () => {
    for (const section of SETTINGS_SECTIONS) expect(readSettingsSectionLink(settingsSectionHref(section.id))).toBe(section.id)
    expect(readSettingsSectionLink(settingsSectionHref(null))).toBeNull()
  })
  it('falls back to preferences for an unknown name and defaults an empty selection', () => {
    expect(readSettingsSectionLink('?section=not-a-section')).toBe('preferences')
    expect(readSettingsSectionLink('?section=')).toBe('preferences')
  })
  it('refuses duplicates, extra keys and encoded delimiters instead of picking one', () => {
    expect(readSettingsSectionLink('')).toBeNull()
    expect(readSettingsSectionLink('?section')).toBeNull()
    expect(readSettingsSectionLink('?thread=1')).toBeNull()
    expect(readSettingsSectionLink('?section=account&section=devices')).toBeNull()
    expect(readSettingsSectionLink('?section=account&token=secret')).toBeNull()
    expect(readSettingsSectionLink('?token=secret&section=account')).toBeNull()
    expect(readSettingsSectionLink('?section=%2F')).toBeNull()
    expect(readSettingsSectionLink('?section=a%26b')).toBeNull()
    expect(readSettingsSectionLink('?section=account+1')).toBeNull()
  })
  it('writes and clears the section query', () => {
    expect(settingsSectionHref('account')).toBe('?section=account')
    expect(settingsSectionHref(null)).toBe('')
  })
})

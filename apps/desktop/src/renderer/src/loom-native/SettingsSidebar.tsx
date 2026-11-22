// 抄自 mikka-current@250d2451（Win11 loom\_artifacts\reference-repos\mikka-current，或 Bero /bundles/refs/mikka-current）：components/slots/settings-sidebar.tsx
import { Icon } from './icons'
import {
  SETTINGS_GROUPS,
  SETTINGS_GROUP_LABELS,
  SETTINGS_GROUP_TITLES,
  type SettingsSectionDef,
  type SettingsSectionId
} from './settings-sections'
import { SETTINGS_SEARCH_EMPTY, settingsItemVisible } from './settings-sidebar-search'

/**
 * The settings section list: title, search, then the groups in table order, each
 * item an icon + name with `aria-current="page"` on the one shown
 * (Mikka `components/slots/settings-sidebar.tsx:56-71`). Presentation only: the
 * caller owns the current section and the query, so this renders in a test
 * without a Host.
 */
export function SettingsSidebar({ sections, current, query, onQuery, onSelect, title = '设置' }: {
  sections: readonly SettingsSectionDef[]
  current: SettingsSectionId
  query: string
  onQuery(value: string): void
  onSelect(id: SettingsSectionId): void
  title?: string
}) {
  const groups = SETTINGS_GROUPS.map(group => ({
    group,
    label: SETTINGS_GROUP_LABELS[group],
    items: sections.filter(section => section.group === group && settingsItemVisible({
      query,
      groupTitle: SETTINGS_GROUP_TITLES[group],
      groupLabel: SETTINGS_GROUP_LABELS[group],
      itemTitle: section.title,
      label: section.title,
      keywords: section.keywords,
      section: section.id
    }))
  }))
  const noMatch = query.trim().length > 0 && groups.every(group => group.items.length === 0)
  return <nav className="ln-settings-list" aria-label="设置分区">
    <h2 className="ln-settings-list-title">{title}</h2>
    <label className="ln-settings-search">
      <Icon name="search" size={14}/>
      <input value={query} aria-label="搜索设置" placeholder="搜索设置" onChange={event => onQuery(event.target.value)}/>
    </label>
    {noMatch && <p className="ln-settings-empty" role="status">{SETTINGS_SEARCH_EMPTY}</p>}
    {groups.map(({ group, label, items }) => items.length > 0 && <div className="ln-settings-group" key={group}>
      <h3 className="ln-settings-group-title">{label}</h3>
      {items.map(section => {
        const selected = section.id === current
        return <button type="button" key={section.id} className={`ln-settings-item${selected ? ' is-active' : ''}`}
          aria-current={selected ? 'page' : undefined} onClick={() => onSelect(section.id)}>
          <Icon name={section.icon} size={17}/><span>{section.title}</span>
        </button>
      })}
    </div>)}
  </nav>
}

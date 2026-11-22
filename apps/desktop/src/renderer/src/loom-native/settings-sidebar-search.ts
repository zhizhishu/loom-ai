// 抄自 mikka-current@250d2451（Win11 loom\_artifacts\reference-repos\mikka-current，或 Bero /bundles/refs/mikka-current）：lib/settings-sidebar-search.ts
import type { SettingsSectionId } from './settings-sections'

/** Words a section answers to beyond its title, in any locale: what lives on its
 * page (Mikka `lib/settings-sidebar-search.ts:1-8`). The section table carries a
 * translated keyword string; this table is the extra cross-language alias. */
export const SETTINGS_SECTION_KEYWORDS: Partial<Record<SettingsSectionId, readonly string[]>> = {
  connections: ['mcp', 'skill', 'tool', 'hook', 'rule', 'import'],
  runtime: ['claude', 'codex', 'dsh', 'pi', 'model'],
  devices: ['node', 'pair', 'device'],
  workspace: ['project', 'directory', 'root', 'folder']
}

/** Whether a settings sidebar item stays visible for the current search query.
 * Matches the group's English name, the group label, the section's English name,
 * its translated label and its keywords — one place, so the sidebar and any
 * later search results agree (Mikka `lib/settings-sidebar-search.ts:14-38`). */
export function settingsItemVisible({ query, groupTitle, groupLabel, itemTitle, label, keywords = '', section }: {
  /** Raw search input. */
  query: string
  /** English group name (e.g. "Machine"). */
  groupTitle: string
  /** Translated group label. */
  groupLabel: string
  /** English item name (e.g. "Connections"). */
  itemTitle: string
  /** Translated item label. */
  label: string
  /** Extra search words for the item, space separated. */
  keywords?: string
  section?: SettingsSectionId
}): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  const aliases = (section && SETTINGS_SECTION_KEYWORDS[section]) || []
  return `${groupTitle} ${groupLabel} ${itemTitle} ${label} ${keywords} ${aliases.join(' ')}`.toLowerCase().includes(normalized)
}

export const SETTINGS_SEARCH_EMPTY = '没有匹配的设置'

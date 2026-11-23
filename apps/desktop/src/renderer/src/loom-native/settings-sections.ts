// 抄自 mikka-current@250d2451（Win11 loom\_artifacts\reference-repos\mikka-current，或 Bero /bundles/refs/mikka-current）：lib/settings-sections.ts
import type { IconName } from './icons'

/** Settings sections, single source of truth. The sidebar, the page body and the
 * search all read this list, so a section exists in one place only
 * (Mikka `lib/settings-sections.ts:1-6`). LOOM keeps the personal build's 11
 * sections: 7 personal + 4 本机与运行 (Mikka's workspace group, narrowed to this
 * machine and its runtimes). */
export type SettingsSectionId =
  | 'account'
  | 'preferences'
  | 'notifications'
  | 'shortcuts'
  | 'memory'
  | 'diagnostics'
  | 'about'
  | 'workspace'
  | 'runtime'
  | 'connections'
  | 'devices'

/** `personal` is the account group; `machine` is 本机与运行 (this machine + its runtimes). */
export type SettingsSectionGroup = 'personal' | 'machine'

export interface SettingsSectionDef {
  id: SettingsSectionId
  group: SettingsSectionGroup
  title: string
  icon: IconName
  /** Extra search words beyond the title, as Mikka's `SETTINGS_SECTION_KEYWORDS`. */
  keywords: string
  /**
   * The body draws its own heading (`SettingsPageHeader` from the older shell), so the
   * page does not draw a second h1. Same rule as Mikka `settings-view.tsx:135`.
   */
  selfTitled?: true
}

/** Group titles participate in search (`lib/settings-sidebar-search.ts:34`). */
export const SETTINGS_GROUP_TITLES: Record<SettingsSectionGroup, string> = { personal: 'Account', machine: 'Machine' }
export const SETTINGS_GROUP_LABELS: Record<SettingsSectionGroup, string> = { personal: '个人', machine: '本机与运行' }
export const SETTINGS_GROUPS: readonly SettingsSectionGroup[] = ['personal', 'machine']

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  // 个人（7）
  { id: 'account', group: 'personal', title: '账户', icon: 'user', keywords: '个人资料 显示名 头像 账号 连接 退出' },
  { id: 'preferences', group: 'personal', title: '偏好设置', icon: 'settings', keywords: '外观 主题 浅色 深色 语言 中文 English 窗口关闭' },
  { id: 'notifications', group: 'personal', title: '通知', icon: 'bell', keywords: '提醒 通知 开关 审批 完成 失败', selfTitled: true },
  { id: 'shortcuts', group: 'personal', title: '快捷键', icon: 'command', keywords: '键盘 按键 组合键 恢复默认', selfTitled: true },
  { id: 'memory', group: 'personal', title: '记忆', icon: 'bulb', keywords: '记忆条目 待确认 建议', selfTitled: true },
  { id: 'diagnostics', group: 'personal', title: '数据与诊断', icon: 'file', keywords: '诊断 日志 导出 数据目录 数据库 修复', selfTitled: true },
  { id: 'about', group: 'personal', title: '关于', icon: 'info', keywords: '版本 更新 检查更新 安装 说明', selfTitled: true },
  // 本机与运行（4）
  { id: 'workspace', group: 'machine', title: '工作目录', icon: 'files', keywords: '项目 目录 默认运行根 工作区 收藏' },
  { id: 'runtime', group: 'machine', title: '运行端', icon: 'branch', keywords: 'claude codex dsh pi 引擎 模型 安装 检查' },
  {
    id: 'connections',
    group: 'machine',
    title: '连接',
    icon: 'globe',
    keywords: 'mcp skill 技能 规则 hook 能力 导入 工具连接',
    // 本区由 McpConnections 自己的 `ln-panel-title` 与能力块标题分段，页面仍画分区标题。
  },
  { id: 'devices', group: 'machine', title: '设备', icon: 'computer', keywords: '节点 配对 执行 电脑 撤销 屏控' }
]

/** 内容自带页头的分区（旧壳整页组件），页面不再画 h1。 */
export const SELF_TITLED_SECTIONS: ReadonlySet<SettingsSectionId> = new Set<SettingsSectionId>([
  'notifications',
  'shortcuts',
  'memory',
  'diagnostics',
  'about'
])

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'preferences'
export const SETTINGS_SECTION_STORAGE_KEY = 'loom.settings.section'

/** Section ids from before this page existed (`GeneralPreferences.SettingsSection`), so a
 * stored value or a deep link lands on the page that now holds the content
 * (Mikka `lib/settings-sections.ts:62-70`). */
const LEGACY: Record<string, SettingsSectionId> = {
  general: 'workspace',
  nodes: 'devices',
  mcp: 'connections',
  skills: 'connections',
  toolbox: 'connections',
  appearance: 'preferences',
  monitoring: 'diagnostics',
  remote: 'preferences',
  remoteHosts: 'preferences',
  channels: 'preferences'
}

const ids = new Set<string>(SETTINGS_SECTIONS.map(section => section.id))
const known = new Set<string>([...ids, ...Object.keys(LEGACY)])

/** Every section this build shows. Personal build has no admin/routed/billing filters,
 * so the whole table is visible (Mikka `visibleSettingsSections`, `:106-108`). */
export function visibleSettingsSections(): readonly SettingsSectionDef[] {
  return SETTINGS_SECTIONS
}

/** The section a stored value or link shows: a current id wins, then a legacy id, else preferences. */
export function resolveSettingsSection(value: string | null | undefined): SettingsSectionId {
  if (value && ids.has(value)) return value as SettingsSectionId
  if (value && Object.hasOwn(LEGACY, value)) return LEGACY[value]
  return DEFAULT_SETTINGS_SECTION
}

export function isSettingsSection(value: string | null | undefined): value is SettingsSectionId {
  return Boolean(value) && known.has(value as string)
}

/** The entry's only query: a settings link is `/?section=<id>` (Mikka `settingsHref`, `lib/settings-sections.ts:91`). */
export const SETTINGS_SECTION_QUERY = 'section'

/** The Host's raw grammar rather than `URLSearchParams`: exactly one `section` key with a
 * bounded identifier, so extra keys, duplicates and encoded delimiters read as no link at all.
 * An unknown or empty name falls back to preferences; `null` opens no page. */
export function readSettingsSectionLink(search: string): SettingsSectionId | null {
  const query = search.startsWith('?') ? search.slice(1) : search
  if (!query.startsWith(`${SETTINGS_SECTION_QUERY}=`)) return null
  const value = query.slice(SETTINGS_SECTION_QUERY.length + 1)
  return /^[A-Za-z0-9-]{0,32}$/.test(value) ? resolveSettingsSection(value) : null
}

/** The exact inverse of `readSettingsSectionLink`: the section's query, or none when closed. */
export function settingsSectionHref(section: SettingsSectionId | null): string {
  return section ? `?${SETTINGS_SECTION_QUERY}=${section}` : ''
}

export function settingsSectionDef(id: SettingsSectionId): SettingsSectionDef {
  return SETTINGS_SECTIONS.find(section => section.id === id) ?? SETTINGS_SECTIONS[1]
}

/** Stored locally, not in Core: the contract's `SettingsSection` enum has no
 * 账户/工作目录/设备/连接 id and widening it is a separate batch. */
export function readStoredSettingsSection(storage: Pick<Storage, 'getItem'> | null | undefined): SettingsSectionId {
  try {
    return resolveSettingsSection(storage?.getItem(SETTINGS_SECTION_STORAGE_KEY) ?? null)
  } catch {
    return DEFAULT_SETTINGS_SECTION
  }
}

export function writeStoredSettingsSection(storage: Pick<Storage, 'setItem'> | null | undefined, id: SettingsSectionId): void {
  try {
    storage?.setItem(SETTINGS_SECTION_STORAGE_KEY, id)
  } catch {
    /* Blocked storage must not stop the page from switching. */
  }
}

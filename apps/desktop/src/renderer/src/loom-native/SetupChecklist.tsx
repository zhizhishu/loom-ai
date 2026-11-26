import { useMemo, useState } from 'react'
import type { AgentProfile } from '@contracts'
import { Icon, IconButton } from './icons'
import type { SettingsSectionId } from './settings-sections'
import {
  SETUP_CHECKLIST_DISMISSED_KEY,
  SETUP_CHECKLIST_ITEMS,
  SETUP_ITEM_ACTIONS,
  setupChecklistRemaining,
  setupChecklistStates,
  type SetupChecklistItem
} from './setup-checklist'

const ITEM_LABELS: Record<SetupChecklistItem, string> = {
  assistant: '建立一位助手',
  runtime: '给助手配置运行端',
  mcp: '连接一个 MCP 工具',
  workspace: '选择默认工作目录'
}

/** Mikka setup-checklist 的首启引导：只读现有投影/本地工作区偏好，不发明后端事实；
 * 点项目深链到真实设置分区。关闭是本地展示偏好，不是完成状态。 */
export function SetupChecklist({ agents, hasWorkspaceDefault, hasMcpConnection, onOpenSettings, onCreateAssistant }: {
  agents: readonly AgentProfile[]
  hasWorkspaceDefault: boolean
  hasMcpConnection: boolean
  onOpenSettings(section: SettingsSectionId): void
  onCreateAssistant(): void
}) {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(SETUP_CHECKLIST_DISMISSED_KEY) === '1' } catch { return false }
  })
  const input = useMemo(() => ({ agents, hasWorkspaceDefault, hasMcpConnection }), [agents, hasWorkspaceDefault, hasMcpConnection])
  const states = setupChecklistStates(input)
  const remaining = setupChecklistRemaining(input)
  if (dismissed || remaining === 0) return null
  const dismiss = () => {
    try { localStorage.setItem(SETUP_CHECKLIST_DISMISSED_KEY, '1') } catch { /* storage may be disabled */ }
    setDismissed(true)
  }
  return <section className="ln-setup-checklist" aria-label="开始前的准备">
    <header><strong>先把 LOOM 准备好</strong><span>还剩 {remaining} 项</span><IconButton icon="close" label="关闭引导" onClick={dismiss}/></header>
    <ol>{SETUP_CHECKLIST_ITEMS.map(item => {
      const done = states[item] === 'done'
      const section = SETUP_ITEM_ACTIONS[item]
      return <li key={item} data-state={done ? 'done' : 'todo'}>
        <Icon name={done ? 'check' : 'progress'} size={16}/>
        <span>{ITEM_LABELS[item]}</span>
        {!done && (item === 'assistant'
          ? <button type="button" onClick={onCreateAssistant}>新建助手</button>
          : section ? <button type="button" data-section={section} onClick={() => onOpenSettings(section)}>去设置</button> : null)}
      </li>
    })}</ol>
  </section>
}

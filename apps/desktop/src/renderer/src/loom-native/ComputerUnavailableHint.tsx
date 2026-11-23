import { useEffect, useState } from 'react'
import type { ComputerStatus } from './host-services'

/** Why the Host cannot offer a computer view. Every reason comes from facts
 * ComputerPanel already holds; this hint never probes the Host on its own and
 * never grants a view, control or agent authorization. */
export type ComputerHintReason = 'unsupported' | 'not-configured' | 'device-missing' | 'not-ready' | 'check-failed'

export type ComputerHintInput = {
  hasPort: boolean
  status: Pick<ComputerStatus, 'configured' | 'ready' | 'device'> | null
  viewActive: boolean
  busy: boolean
  hasRefresh: boolean
  hasRetryDiscovery: boolean
  hasOpenSettings: boolean
  /** Set only when a status read actually failed; a pending or unknown status
   * stays quiet. Cleared by the next successful read. */
  statusFailed?: boolean
}

export type ComputerHintModel = {
  show: boolean
  reason: ComputerHintReason | null
  message: string
  retry: { label: string; disabled: boolean; note: string | null }
  settings: { label: string; disabled: boolean; note: string | null }
  help: { label: string; content: string }
}

export const COMPUTER_HINT_HELP_ID = 'ln-computer-hint-help'

/** An absent entry point is stated, not hidden: this handoff cannot invent a
 * settings route or a device-discovery call, so the control stays visible but
 * disabled with the reason it is unavailable. */
const RETRY_UNAVAILABLE = '这个面板还没有接入状态重读或设备发现，无法重新检查。'
const RETRY_UNAVAILABLE_NO_PORT = '这里没有可用的检查入口：这台设备没有电脑画面接口，也没有接入设备发现。'
const SETTINGS_UNAVAILABLE = '这个页面还没有接入设置入口；请手动打开「设置 › 设备」检查电脑服务。'
const HELP_CONTENT = '电脑画面由当前 Host 提供，云端 Host 使用相同接口。屏控必须由目标 Host 提供并单独授权；设备离线时控制会停止，连接恢复后请重新授权。'

export function computerHintModel(input: ComputerHintInput): ComputerHintModel {
  const canRetry = input.hasRefresh || input.hasRetryDiscovery
  const note = input.hasPort ? RETRY_UNAVAILABLE : RETRY_UNAVAILABLE_NO_PORT
  const retry = { label: input.busy ? '检查中…' : '重新检查', disabled: input.busy || !canRetry, note: canRetry ? null : note }
  const settings = { label: '打开电脑设置', disabled: !input.hasOpenSettings, note: input.hasOpenSettings ? null : SETTINGS_UNAVAILABLE }
  const help = { label: '设置帮助', content: HELP_CONTENT }
  const hidden: ComputerHintModel = { show: false, reason: null, message: '', retry, settings, help }
  // No hint while a consented view is on screen, and none for a healthy device.
  if (input.viewActive) return hidden
  if (!input.hasPort) return { show: true, reason: 'unsupported', message: '这台设备没有提供电脑画面接口，无法在这里检查。', retry, settings, help }
  const status = input.status
  // A failed read is a real verdict even when no status was ever received or the
  // last one is now stale; a pending/unknown read is not, so it stays quiet.
  if (input.statusFailed) return { show: true, reason: 'check-failed', message: '没能确认这台电脑的状态；请重新检查连接。', retry, settings, help }
  if (!status) return hidden
  if (status.ready && status.device) return hidden
  const reason: ComputerHintReason = status.configured === false ? 'not-configured' : !status.device ? 'device-missing' : 'not-ready'
  const message = reason === 'not-configured' ? '这台主机还没有配置电脑服务。' : reason === 'device-missing' ? '目标主机暂时没有可查看的桌面。' : '电脑画面暂不可用。'
  return { show: true, reason, message, retry, settings, help }
}

export type ComputerUnavailableHintViewProps = {
  model: ComputerHintModel
  helpOpen: boolean
  onRetry?: () => void
  onOpenSettings?: () => void
  onToggleHelp?: () => void
}

/** Presentational half: no Host call, no link, no implicit authorization. */
export function ComputerUnavailableHintView({ model, helpOpen, onRetry, onOpenSettings, onToggleHelp }: ComputerUnavailableHintViewProps) {
  if (!model.show) return null
  return <div data-testid="computer-unavailable-hint" role="group" aria-label="电脑不可用提示">
    <p className="ln-computer-scope">{model.message}</p>
    <div className="ln-computer-actions">
      <button type="button" className="ln-action" disabled={model.retry.disabled} onClick={onRetry}>{model.retry.label}</button>
      <button type="button" className="ln-action" disabled={model.settings.disabled} onClick={onOpenSettings}>{model.settings.label}</button>
      <button type="button" className="ln-action" aria-expanded={helpOpen} aria-controls={COMPUTER_HINT_HELP_ID} onClick={onToggleHelp}>{model.help.label}</button>
    </div>
    {model.retry.disabled && model.retry.note && <p className="ln-computer-target-hint">{model.retry.note}</p>}
    {model.settings.disabled && model.settings.note && <p className="ln-computer-target-hint">{model.settings.note}</p>}
    <p className="ln-computer-scope" id={COMPUTER_HINT_HELP_ID} hidden={!helpOpen}>{model.help.content}</p>
  </div>
}

export type ComputerUnavailableHintProps = {
  status: Pick<ComputerStatus, 'configured' | 'ready' | 'device'> | null
  viewActive: boolean
  busy: boolean
  hasPort: boolean
  /** True only after a status read failed; cleared by the next success. */
  statusFailed?: boolean
  /** Status re-read inside ComputerPanel; present only while a port exists. */
  refreshStatus?: () => void | Promise<void>
  /** Real device discovery, supplied by a future approved ComputerWorkspace edit. */
  retryDiscovery?: () => void | Promise<void>
  /** Real settings route, supplied by a future approved ComputerWorkspace edit. */
  openSettings?: () => void
}

/** Retry order is the real status re-read first, device discovery only as the
 * fallback. Pure so the priority is asserted without a DOM. */
export function selectRetry(input: { refreshStatus?: () => void | Promise<void>; retryDiscovery?: () => void | Promise<void> }) {
  return input.refreshStatus ?? input.retryDiscovery
}

export function ComputerUnavailableHint({ status, viewActive, busy, hasPort, statusFailed = false, refreshStatus, retryDiscovery, openSettings }: ComputerUnavailableHintProps) {
  const [helpOpen, setHelpOpen] = useState(false)
  const model = computerHintModel({ hasPort, status, viewActive, busy, statusFailed, hasRefresh: !!refreshStatus, hasRetryDiscovery: !!retryDiscovery, hasOpenSettings: !!openSettings })
  useEffect(() => { if (!model.show) setHelpOpen(false) }, [model.show])
  const retry = () => {
    const run = selectRetry({ refreshStatus, retryDiscovery })
    if (run) void run()
  }
  return <ComputerUnavailableHintView model={model} helpOpen={helpOpen} onRetry={retry} onOpenSettings={() => openSettings?.()} onToggleHelp={() => setHelpOpen(open => !open)} />
}

import { useEffect, useRef, useState } from 'react'
import { writeClipboardText } from './clipboard'
import { UiText, uiAttribute } from './interface-language'
import { adapterLabel } from './runtime-products'
import {
  REMOTE_RUNTIME_PROVISION_COMMAND,
  remoteRuntimeProvisionReady,
  type RemoteRuntimeProvisionRow
} from './remote-runtime-provision'
import './remote-connection.css'

function ProvisionCommand({ command }: { command: string }): React.JSX.Element {
  const [feedback, setFeedback] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const copy = async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current)
    setFeedback(await writeClipboardText(command) ? uiAttribute('已复制') : uiAttribute('复制失败，请手动选择命令'))
    timer.current = setTimeout(() => setFeedback(''), 2500)
  }
  return <div className="runtime-guide-command">
    <span aria-hidden="true">$</span>
    <code>{command}</code>
    <button type="button" className="runtime-guide-copy" aria-label={uiAttribute('复制配齐命令')} onClick={() => void copy()}>
      {feedback === uiAttribute('已复制') ? uiAttribute('已复制') : feedback ? uiAttribute('复制失败') : uiAttribute('复制')}
    </button>
    <span className="sr-only" role="status">{feedback}</span>
  </div>
}

function ProvisionResults({ rows }: { rows: readonly RemoteRuntimeProvisionRow[] }): React.JSX.Element {
  return <ul className="remote-runtime-provision-results" role="status" aria-label={uiAttribute('探测结果')}>
    {rows.map((row) => <li key={row.runtimeKind} data-runtime={row.runtimeKind} data-status={row.status}>
      <span>{adapterLabel(row.runtimeKind)}</span>
      <span>{row.label}</span>
    </li>)}
  </ul>
}

/**
 * Guidance for provisioning Claude Code and Codex on a server. `command` is the
 * Desktop remote-host page: copy only, because this computer cannot probe that
 * server. `action` is the Linux host's own agent catalog: copy, current
 * detection, and a rescan. `result` is that rescan after both CLIs are no
 * longer missing.
 */
export function RemoteRuntimeProvision({
  mode,
  rows = [],
  busy = false,
  onRecheck
}: {
  mode: 'command' | 'action' | 'result'
  rows?: readonly RemoteRuntimeProvisionRow[]
  busy?: boolean
  onRecheck?: () => void
}): React.JSX.Element {
  const title = mode === 'command'
    ? uiAttribute('配齐远端 CLI')
    : mode === 'action'
      ? uiAttribute('配齐 Claude Code 与 Codex')
      : uiAttribute('探测结果')
  return <div className="remote-runtime-provision" data-remote-runtime-provision={mode} role="region" aria-label={title} aria-busy={busy || undefined}>
    <h3>{mode === 'command'
      ? <UiText zh={"配齐远端 CLI"} />
      : mode === 'action'
        ? <UiText zh={"配齐 Claude Code 与 Codex"} />
        : <UiText zh={"探测结果"} />}</h3>
    {mode !== 'result' && <>
      <p><UiText zh={"在含有 scripts/provision-remote-runtimes.sh 的目录中，以 Server 的运行用户执行下面这一行。App 只展示这条命令，不会安装，也不会写入账号或打开端口。"} /></p>
      <ProvisionCommand command={REMOTE_RUNTIME_PROVISION_COMMAND} />
    </>}
    {mode === 'command' && <p><UiText zh={"执行后打开该主机，到「设置 → 能力 → 智能体」点「重新检测」。Claude Code 与 Codex 显示「可用」即表示这台 Server 已探测到它们。若 Server 由 systemd 启动，把 $HOME/.npm-global/bin 加进该单元的 PATH 后再重启 Server。"} /></p>}
    {mode !== 'command' && <ProvisionResults rows={rows} />}
    {mode === 'result' && remoteRuntimeProvisionReady(rows) && <p><UiText zh={"Claude Code 与 Codex 已可用。"} /></p>}
    {mode === 'action' && <>
      <p><UiText zh={"若由 systemd 启动，把 $HOME/.npm-global/bin 加进该单元的 PATH 并重启 Server，再重新检测。"} /></p>
      <div className="remote-runtime-provision-actions">
        <button type="button" className="primary-button" disabled={busy} aria-busy={busy || undefined} onClick={() => { if (!busy) onRecheck?.() }}>
          {busy ? uiAttribute('正在重新检测…') : uiAttribute('重新检测')}
        </button>
      </div>
    </>}
  </div>
}

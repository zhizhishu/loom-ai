import type { AdapterKind, HostPlatformKey } from '@contracts'
import type { RuntimeUserStatus } from './runtime-status'

/** Claude Code and Codex are the two CLIs `scripts/provision-remote-runtimes.sh` installs. */
export const REMOTE_RUNTIME_PROVISION_KINDS = ['claude-code-cli', 'codex-cli'] as const

export type RemoteRuntimeProvisionKind = (typeof REMOTE_RUNTIME_PROVISION_KINDS)[number]

/**
 * One line the operator runs on the server, as that server's user, from a
 * directory that contains the script. The Renderer only copies it.
 */
export const REMOTE_RUNTIME_PROVISION_COMMAND =
  'scripts/provision-remote-runtimes.sh --prefix "$HOME/.npm-global"'

export interface RemoteRuntimeProvisionRow {
  runtimeKind: RemoteRuntimeProvisionKind
  status: RuntimeUserStatus
  label: string
}

/** Missing executable or a path Core can no longer resolve. Login and a disabled adapter are separate. */
export function remoteRuntimeNeedsProvision(status: RuntimeUserStatus): boolean {
  return status === 'not_installed'
}

export function remoteRuntimeProvisionRows(
  hostPlatform: HostPlatformKey | null,
  rows: readonly { runtimeKind: AdapterKind; status: RuntimeUserStatus; label: string }[]
): RemoteRuntimeProvisionRow[] | null {
  if (hostPlatform !== 'linux-x64') return null
  return REMOTE_RUNTIME_PROVISION_KINDS.map((runtimeKind) => {
    const row = rows.find((item) => item.runtimeKind === runtimeKind)
    return {
      runtimeKind,
      status: row?.status ?? 'unknown',
      label: row?.label ?? ''
    }
  })
}

export function remoteRuntimeProvisionVisible(rows: readonly RemoteRuntimeProvisionRow[] | null): boolean {
  return Boolean(rows?.some((row) => remoteRuntimeNeedsProvision(row.status)))
}

export function remoteRuntimeProvisionReady(rows: readonly RemoteRuntimeProvisionRow[]): boolean {
  return rows.length > 0 && rows.every((row) => row.status === 'available')
}

/** `announced` is a rescan started from this note. A later non-missing snapshot stays as its result. */
export function remoteRuntimeProvisionMode(
  rows: readonly RemoteRuntimeProvisionRow[] | null,
  announced: boolean
): 'hidden' | 'action' | 'result' {
  if (!rows) return 'hidden'
  if (remoteRuntimeProvisionVisible(rows)) return 'action'
  return announced ? 'result' : 'hidden'
}

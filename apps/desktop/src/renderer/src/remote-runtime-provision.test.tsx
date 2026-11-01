import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { HostPlatformKey, ProductRuntimeAvailability, RemoteHostApi, RuntimePlatformAdmission, RuntimeStatus } from '@contracts'
import { RuntimeInstallationsPanel } from './MemberManagement'
import { RemoteHostsSettings } from './RemoteHostsSettings'
import { RemoteRuntimeProvision } from './RemoteRuntimeProvision'
import {
  REMOTE_RUNTIME_PROVISION_COMMAND,
  remoteRuntimeNeedsProvision,
  remoteRuntimeProvisionMode,
  remoteRuntimeProvisionReady,
  remoteRuntimeProvisionRows,
  remoteRuntimeProvisionVisible,
  type RemoteRuntimeProvisionRow
} from './remote-runtime-provision'

function renderedText(markup: string): string {
  return markup.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
}

const api: RemoteHostApi = {
  list: async () => ({ ok: true, value: [] }),
  add: async () => ({ ok: false, code: 'remote_host_failed' }),
  remove: async () => ({ ok: true, value: [] }),
  open: async () => ({ ok: true, value: null })
}

const missingRow = (runtimeKind: RemoteRuntimeProvisionRow['runtimeKind']): RemoteRuntimeProvisionRow =>
  ({ runtimeKind, status: 'not_installed', label: '未检测到' })
const readyRow = (runtimeKind: RemoteRuntimeProvisionRow['runtimeKind']): RemoteRuntimeProvisionRow =>
  ({ runtimeKind, status: 'available', label: '可用' })

describe('remote runtime provision offer', () => {
  it('copies one server command and does not describe an install the App would run', () => {
    expect(REMOTE_RUNTIME_PROVISION_COMMAND).toBe('scripts/provision-remote-runtimes.sh --prefix "$HOME/.npm-global"')
    expect(REMOTE_RUNTIME_PROVISION_COMMAND).not.toMatch(/npm install|curl |sudo /)
    expect(remoteRuntimeNeedsProvision('not_installed')).toBe(true)
    for (const status of ['available', 'authentication_required', 'unavailable', 'version_unsupported', 'unknown'] as const) {
      expect(remoteRuntimeNeedsProvision(status)).toBe(false)
    }
  })

  it('offers the note only for a Linux host that is missing Claude Code or Codex', () => {
    const missing = [missingRow('claude-code-cli'), readyRow('codex-cli')]
    expect(remoteRuntimeProvisionRows('linux-x64', missing)?.map((row) => row.runtimeKind)).toEqual(['claude-code-cli', 'codex-cli'])
    expect(remoteRuntimeProvisionVisible(remoteRuntimeProvisionRows('linux-x64', missing))).toBe(true)
    expect(remoteRuntimeProvisionRows('windows-x64', missing)).toBeNull()
    expect(remoteRuntimeProvisionRows('macos-arm64', missing)).toBeNull()
    expect(remoteRuntimeProvisionRows(null, missing)).toBeNull()
    const present = [readyRow('claude-code-cli'), readyRow('codex-cli')]
    expect(remoteRuntimeProvisionVisible(remoteRuntimeProvisionRows('linux-x64', present))).toBe(false)
    const login = [
      { runtimeKind: 'claude-code-cli' as const, status: 'authentication_required' as const, label: '认证未通过' },
      readyRow('codex-cli')
    ]
    expect(remoteRuntimeProvisionVisible(remoteRuntimeProvisionRows('linux-x64', login))).toBe(false)
  })

  it('keeps a rescan result after the CLIs are no longer missing', () => {
    const missing = [missingRow('claude-code-cli'), missingRow('codex-cli')]
    const ready = [readyRow('claude-code-cli'), readyRow('codex-cli')]
    expect(remoteRuntimeProvisionMode(null, true)).toBe('hidden')
    expect(remoteRuntimeProvisionMode(remoteRuntimeProvisionRows('linux-x64', missing), false)).toBe('action')
    expect(remoteRuntimeProvisionMode(remoteRuntimeProvisionRows('linux-x64', ready), false)).toBe('hidden')
    expect(remoteRuntimeProvisionMode(remoteRuntimeProvisionRows('linux-x64', ready), true)).toBe('result')
    expect(remoteRuntimeProvisionReady(ready)).toBe(true)
    expect(remoteRuntimeProvisionReady(missing)).toBe(false)
  })
})

describe('remote runtime provision UI', () => {
  const missing = [missingRow('claude-code-cli'), missingRow('codex-cli')]

  it('shows the command with a copy control and no rescan on the remote-host page', () => {
    const markup = renderToStaticMarkup(createElement(RemoteRuntimeProvision, { mode: 'command' }))
    expect(markup).toContain('data-remote-runtime-provision="command"')
    expect(renderedText(markup)).toContain(REMOTE_RUNTIME_PROVISION_COMMAND)
    expect(markup).toContain('aria-label="复制配齐命令"')
    expect(markup).toContain('>复制<')
    expect(markup).not.toContain('>重新检测<')
    expect(markup).not.toContain('<form')
    expect(markup).not.toContain('primary-button')
  })

  it('shows the same command, current detection, and a rescan on the Linux catalog', () => {
    const markup = renderToStaticMarkup(createElement(RemoteRuntimeProvision, {
      mode: 'action', rows: missing, onRecheck() {}
    }))
    expect(markup).toContain('data-remote-runtime-provision="action"')
    expect(renderedText(markup)).toContain(REMOTE_RUNTIME_PROVISION_COMMAND)
    expect(markup).toContain('data-runtime="claude-code-cli"')
    expect(markup).toContain('data-status="not_installed"')
    expect(markup).toContain('未检测到')
    expect(markup).toContain('>重新检测<')
    expect(markup).toContain('type="button"')
    expect(markup).not.toContain('<form')
  })

  it('reports a finished rescan without asking to install again', () => {
    const ready = renderToStaticMarkup(createElement(RemoteRuntimeProvision, {
      mode: 'result', rows: [readyRow('claude-code-cli'), readyRow('codex-cli')]
    }))
    expect(ready).toContain('data-status="available"')
    expect(ready).toContain('Claude Code 与 Codex 已可用。')
    expect(renderedText(ready)).not.toContain(REMOTE_RUNTIME_PROVISION_COMMAND)
    expect(ready).not.toContain('>重新检测<')

    const login = renderToStaticMarkup(createElement(RemoteRuntimeProvision, {
      mode: 'result',
      rows: [
        readyRow('claude-code-cli'),
        { runtimeKind: 'codex-cli', status: 'authentication_required', label: '认证未通过' }
      ]
    }))
    expect(login).toContain('认证未通过')
    expect(login).not.toContain('Claude Code 与 Codex 已可用。')
    expect(renderedText(login)).not.toContain(REMOTE_RUNTIME_PROVISION_COMMAND)
  })

  it('places the copy-only command on the remote hosts settings page', () => {
    const markup = renderToStaticMarkup(createElement(RemoteHostsSettings, { api }))
    expect(markup).toContain('data-remote-runtime-provision="command"')
    expect(renderedText(markup)).toContain(REMOTE_RUNTIME_PROVISION_COMMAND)
    expect(markup).toContain('aria-label="复制配齐命令"')
  })
})

function availability(
  runtimeKind: 'claude-code-cli' | 'codex-cli',
  status: 'missing' | 'ready' | 'authentication_required' | 'path_missing'
): ProductRuntimeAvailability {
  const absent = status === 'missing' || status === 'path_missing'
  return {
    runtimeKind,
    status,
    checking: false,
    discovery: {
      runtimeKind,
      discoveryStatus: absent ? 'missing' : 'found',
      executablePath: absent ? null : `/usr/local/bin/${runtimeKind}`,
      source: absent ? null : 'inherited_path',
      reportedVersion: absent ? null : '1.0.0',
      executableFingerprint: absent ? null : `sha256:${runtimeKind}`,
      searchPathSource: absent ? null : 'inherited_path',
      entrypointKind: absent ? null : 'native_executable',
      candidateExtension: absent ? null : 'native',
      resolvedNativeTarget: false,
      versionProbeSucceeded: absent ? null : true,
      searchGeneration: 1,
      observedAt: '2026-11-01T00:00:00Z',
      diagnosticCode: null
    },
    installationId: status === 'ready' ? `installation-${runtimeKind}` : null,
    reportedVersion: absent ? null : '1.0.0',
    diagnosticCode: null,
    failure: status === 'authentication_required' ? {
      runtimeKind,
      origin: 'runtime',
      phase: 'authentication',
      code: 'runtime_authentication_required',
      summary: '尚未登录',
      detail: null,
      retryable: true
    } : null
  }
}

function catalog(platform: HostPlatformKey, claude: Parameters<typeof availability>[1], codex: Parameters<typeof availability>[1]): string {
  const admission = (runtimeKind: 'claude-code-cli' | 'codex-cli'): RuntimePlatformAdmission => ({
    runtimeKind,
    platform,
    status: 'qualified',
    reasonCode: null,
    evidenceRevision: 'sha256:test'
  })
  const health: RuntimeStatus = {
    hostPlatform: platform,
    runtimeCatalog: [],
    runtimePlatformAdmission: [admission('claude-code-cli'), admission('codex-cli')],
    runtimeAvailability: [availability('claude-code-cli', claude), availability('codex-cli', codex)],
    searchEnvironment: {
      generation: 1,
      createdAt: '2026-11-01T00:00:00Z',
      pathEntryCount: 1,
      shell: { status: 'captured', interactive: false, shellName: 'bash', entryCount: 1, elapsedMillis: 1 }
    }
  }
  return renderToStaticMarkup(createElement(RuntimeInstallationsPanel, {
    health,
    installations: [],
    onReload: async () => undefined
  }))
}

describe('agent catalog provisioning note', () => {
  it('shows the command and rescan when a Linux host has not detected Claude Code or Codex', () => {
    const markup = catalog('linux-x64', 'missing', 'path_missing')
    expect(markup).toContain('data-remote-runtime-provision="action"')
    expect(renderedText(markup)).toContain(REMOTE_RUNTIME_PROVISION_COMMAND)
    expect(markup).toContain('>重新检测<')
    expect(markup).toContain('data-status="not_installed"')
  })

  it('hides the server command on other platforms and when the CLIs are already detected or only need login', () => {
    expect(catalog('windows-x64', 'missing', 'missing')).not.toContain('data-remote-runtime-provision')
    expect(renderedText(catalog('macos-arm64', 'missing', 'missing'))).not.toContain('provision-remote-runtimes')
    expect(catalog('linux-x64', 'ready', 'ready')).not.toContain('data-remote-runtime-provision')
    expect(renderedText(catalog('linux-x64', 'authentication_required', 'authentication_required'))).not.toContain('provision-remote-runtimes')
  })
})

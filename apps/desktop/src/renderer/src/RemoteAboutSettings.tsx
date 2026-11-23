// rakazo@51ff52e infra/updater/src/updater-logic.ts:106-119 (default-off interval), structural comparison; PiBot@6741737 web/src/ClientUpdateSection.tsx:105,218 / ClientUpdateProvider.tsx:134,147-155, structural comparison; label 「自动检查更新」: 无参考，按用户定.
import { useEffect, useState } from 'react'
import type { AppUpdateSnapshot, AppUpdatesApi } from '@contracts'
import { useThreadClient } from './camp-client'
import { AboutUpdatesSettingsView } from './AboutUpdatesSettings'
import { useAppUpdates } from './useAppUpdates'
import { currentReleaseFromBundledSources } from '../../shared/app-current-release'
import releaseNotes from '../../../../../build/release-notes.md?raw'
import releaseMetadata from '../../../../../build/release-metadata.json'

export function RemoteAboutSettings({ updatesApi }: { updatesApi?: AppUpdatesApi }): React.JSX.Element {
  const client = useThreadClient()
  const desktopHosted = Boolean(client.channels)
  const updates = useAppUpdates(desktopHosted ? null : updatesApi ?? null)
  const [current, setCurrent] = useState<AppUpdateSnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    void client.request<{ version: string }>('app.info').then(info => {
      if (!active) return
      setCurrent({ currentVersion: info.version, status: 'idle',
        currentRelease: currentReleaseFromBundledSources(
          info.version,
          desktopHosted ? releaseNotes : null,
          desktopHosted ? releaseMetadata : null
        ),
        availableRelease: null,
        lastCheckSource: null, checkedAt: null, lastSuccessfulCheckAt: null,
        downloadPercent: null, transferredBytes: null, totalBytes: null, bytesPerSecond: null,
        failureReason: null, pendingPrompt: null })
    }, () => { if (active) setFailed(true) })
    return () => { active = false }
  }, [client, desktopHosted])
  const snapshot = desktopHosted ? current : updates.snapshot && {
    ...updates.snapshot, currentRelease: updates.snapshot.currentRelease ?? current?.currentRelease ?? null
  }
  return <AboutUpdatesSettingsView snapshot={snapshot} product={desktopHosted ? 'desktop' : 'server'} readOnly={desktopHosted}
    canUpdate={!desktopHosted && !!updatesApi} loading={desktopHosted ? !current && !failed : updates.loading}
    loadError={desktopHosted ? failed : updates.loadError} actionError={desktopHosted ? null : updates.actionError}
    onSetAutoCheck={desktopHosted ? undefined : updates.setAutoCheck}
    onCheck={() => { void updates.check() }} onDownload={() => { void updates.download() }} onInstall={() => { void updates.install() }} />
}

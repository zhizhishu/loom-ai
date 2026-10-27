import { LanguagePreferenceReadNotice } from './LanguagePreferenceControl'
import { WindowCloseDialog } from './WindowCloseSettings'
import { ShortcutProvider } from './ShortcutProvider'
import { useEffect, useRef, useState } from 'react'
import type { CoreEvent, DesktopStartupSnapshot, SupervisorSnapshot, AppearanceSnapshot } from '@contracts'
import { CurrentUserProfileProvider } from './CurrentUserProfile'
import { CoreSubsystemNotice } from './CoreSubsystemNotice'
import { ThreadClientProvider } from './camp-client'
import { desktopThreadClient } from './desktop-camp-client'
import { desktopBusinessEnvironment } from './desktop-business-environment'
import { observeInterfaceLanguage, useInterfaceLanguage } from './interface-language'
import { applyAppearanceSnapshot } from './theme'
import {
  BusinessApp, BootstrapShell, StartupWorkspace, ControlledShutdownOverlay,
  authoritativeWorkspaceIsAvailable, SHUTDOWN_FEEDBACK_DELAY_MS,
  errorMessage, asRecord, stringField
} from './BusinessApp'
export * from './BusinessApp'

export function App(): React.JSX.Element {
  useInterfaceLanguage()
  const [languageReady, setLanguageReady] = useState(false)
  const [supervisorState, setSupervisorState] = useState<{
    latest: SupervisorSnapshot | null
    lastNonShutdown: SupervisorSnapshot | null
  }>({ latest: null, lastNonShutdown: null })
  const supervisor = supervisorState.latest
  const [startupSnapshot, setStartupSnapshot] = useState<DesktopStartupSnapshot | null>(null)
  const [startupError, setStartupError] = useState<string | null>(null)
  const [startupReadAttempt, setStartupReadAttempt] = useState(0)
  const [runtimeShuttingDown, setRuntimeShuttingDown] = useState(false)
  const [shutdownFeedbackVisible, setShutdownFeedbackVisible] = useState(false)
  const startupStartedAt = useRef(performance.now())

  useEffect(() => {
    let disposed = false
    setStartupError(null)
    // This snapshot belongs to the local Main Window Session, not to Core. Read it
    // alongside the Supervisor so the target frame never waits for DB admission.
    void window.rovai.desktopSession.getStartupSnapshot().then((snapshot) => {
      if (!disposed) setStartupSnapshot(snapshot)
    }).catch((error) => {
      if (!disposed) setStartupError(errorMessage(error))
    })
    return () => { disposed = true }
  }, [startupReadAttempt])

  useEffect(() => observeInterfaceLanguage(window.rovai.generalPreferences, () => setLanguageReady(true)), [])

  useEffect(() => {
    let disposed = false
    let receivedChange = false
    const apply = (snapshot: AppearanceSnapshot): void => {
      if (!disposed) applyAppearanceSnapshot(document.documentElement, snapshot)
    }
    const unsubscribe = window.rovai.appearance.onChanged((snapshot) => {
      receivedChange = true
      apply(snapshot)
    })
    void window.rovai.appearance.get().then((snapshot) => {
      if (!receivedChange) apply(snapshot)
    }).catch(() => undefined)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let disposed = false
    const apply = (snapshot: SupervisorSnapshot): void => {
      if (disposed || snapshot.schemaVersion !== 1) return
      setSupervisorState((current) => {
        if (current.latest !== null && snapshot.revision <= current.latest.revision) return current
        return {
          latest: snapshot,
          lastNonShutdown: snapshot.fullCoreState === 'shutting_down'
            ? current.lastNonShutdown
            : snapshot
        }
      })
    }
    const unsubscribe = window.rovai.supervisor.onChanged(apply)
    void window.rovai.supervisor.getSnapshot().then(apply).catch(() => undefined)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  useEffect(() => window.rovai.onEvent((event: CoreEvent) => {
    if (event.method !== 'runtime.state') return
    if (stringField(asRecord(event.params), 'status') === 'shutting_down') {
      setRuntimeShuttingDown(true)
    }
  }), [])

  useEffect(() => {
    const wakeNetworkRecovery = (): void => {
      void window.rovai.request('runtime.networkRecovery.wake').catch(() => undefined)
    }
    window.addEventListener('online', wakeNetworkRecovery)
    return () => window.removeEventListener('online', wakeNetworkRecovery)
  }, [])

  const shuttingDown = runtimeShuttingDown || supervisor?.fullCoreState === 'shutting_down'
  const presentationSupervisor = shuttingDown ? supervisorState.lastNonShutdown : supervisor

  useEffect(() => {
    if (!shuttingDown) {
      setShutdownFeedbackVisible(false)
      return undefined
    }
    const timer = window.setTimeout(
      () => setShutdownFeedbackVisible(true),
      SHUTDOWN_FEEDBACK_DELAY_MS
    )
    return () => window.clearTimeout(timer)
  }, [shuttingDown])

  // The first frame contains no locale-dependent copy until local restoration completes.
  if (!languageReady) return <div className="language-bootstrap" aria-busy="true" />

  let workspace: React.JSX.Element
  if (
    presentationSupervisor?.fullCoreState === 'blocked'
    || presentationSupervisor?.fullCoreState === 'crashed'
  ) {
    workspace = <BootstrapShell snapshot={presentationSupervisor} />
  } else if (!authoritativeWorkspaceIsAvailable(presentationSupervisor) || !startupSnapshot) {
    workspace = <StartupWorkspace
      snapshot={startupSnapshot}
      feedbackVisible={!shuttingDown}
      error={shuttingDown ? null : startupError}
      onRetry={() => setStartupReadAttempt((attempt) => attempt + 1)}
    />
  } else {
    workspace = (
      <div className="authoritative-workspace">
        <ThreadClientProvider client={desktopThreadClient}><ShortcutProvider api={window.rovai.shortcuts} platform={window.rovai.platform}><CurrentUserProfileProvider api={window.rovai.currentUserProfile}>
          <BusinessApp environment={desktopBusinessEnvironment}
            initialStartupSnapshot={startupSnapshot}
            startupStartedAtMs={startupStartedAt.current}
          />
        </CurrentUserProfileProvider></ShortcutProvider></ThreadClientProvider>
        <CoreSubsystemNotice subsystems={presentationSupervisor?.coreSubsystems ?? []} />
      </div>
    )
  }

  return (
    <>
      {workspace}
      <LanguagePreferenceReadNotice />
      {window.rovai.windowClose && <WindowCloseDialog api={window.rovai.windowClose} />}
      {shuttingDown && <ControlledShutdownOverlay visible={shutdownFeedbackVisible} />}
    </>
  )
}

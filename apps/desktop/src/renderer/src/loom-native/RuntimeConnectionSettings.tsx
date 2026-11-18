import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeStatus } from '@contracts'
import type { BusinessEnvironment } from '../business-environment'
import { ThreadClientProvider } from '../camp-client'
import { RuntimeStartupSettings, type RuntimeStartupLeaveGuard } from '../RuntimeStartupSettings'
import { ASSISTANT_RUNTIME_REGISTRY, type AssistantRuntimeKind } from './assistant-service'
import { SurfaceDialog, FormMessage } from './Controls'
import './runtime-settings.css'

/** Expose the existing private configuration editor through the personal UI. */
export function RuntimeConnectionSettings({ environment, runtimeKind, theme, onClose }: {
  environment: BusinessEnvironment
  runtimeKind: AssistantRuntimeKind
  theme: 'day' | 'night'
  onClose(): void
}) {
  const [health, setHealth] = useState<RuntimeStatus | null>(null)
  const [readError, setReadError] = useState('')
  const leaveGuard = useRef<RuntimeStartupLeaveGuard | null>(null)
  const alive = useRef(true)
  const registerGuard = useCallback((guard: RuntimeStartupLeaveGuard | null) => { leaveGuard.current = guard }, [])
  useEffect(() => {
    alive.current = true
    let active = true
    void environment.client.request<RuntimeStatus>('runtime.status.get').then(value => {
      if (active) setHealth(value)
    }).catch(() => { if (active) setReadError('暂时无法读取运行端状态，仍可查看连接设置。') })
    return () => { active = false; alive.current = false }
  }, [environment.client, runtimeKind])
  const close = async () => {
    // A close or Escape must use the editor's existing busy/draft guard.
    if (!leaveGuard.current) return
    if (await leaveGuard.current() && alive.current) onClose()
  }
  return <SurfaceDialog open title={`${ASSISTANT_RUNTIME_REGISTRY[runtimeKind].label} 连接设置`} description="设置程序路径和供助手共用的连接变量。" theme={theme} onClose={() => { void close() }} className="ln-runtime-settings">
    <div className="ln-room-content">
      {readError && <FormMessage error>{readError}</FormMessage>}
      <ThreadClientProvider client={environment.client}>
        <RuntimeStartupSettings key={runtimeKind} runtimeKind={runtimeKind} health={health} nativeTheme={theme} backLabel="返回运行端" onBack={onClose} onLeaveGuardChange={registerGuard}/>
      </ThreadClientProvider>
    </div>
  </SurfaceDialog>
}

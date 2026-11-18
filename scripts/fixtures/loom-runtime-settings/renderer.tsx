import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CoreMethod, RuntimeStartupSettings } from '@contracts'
import type { BusinessEnvironment } from '../../../apps/desktop/src/renderer/src/business-environment'
import type { ThreadClient } from '../../../apps/desktop/src/renderer/src/camp-client'
import { NativeSetup } from '../../../apps/desktop/src/renderer/src/loom-native/NativeSetup'
import '../../../apps/desktop/src/renderer/src/loom-native/native.css'
import '../../../apps/desktop/src/renderer/src/loom-native/product.css'

// This fixture renders production components with a declared in-memory transport.
// It does not start Core, discover real runtimes, or read/write user configuration.
const kinds = ['claude-code-cli', 'codex-cli', 'deepseek-harness', 'pi'] as const
const settings = new Map(kinds.map(runtimeKind => [runtimeKind, {
  runtimeKind, revision: 3, reconnectRequired: false,
  configuration: { programPath: null, environment: [] },
  commonEnvironment: { revision: 7, environment: { LOOM_QA_NOTE: 'initial fixture value' } }
} as RuntimeStartupSettings]))
const calls: { method: string; params?: unknown }[] = []
const writes: Record<string, unknown>[] = []
let conflictOnce = false
let failReadOnce = false
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const status = { hostPlatform: 'windows-x64', runtimeAvailability: [], runtimePlatformAdmission: [], runtimeCatalog: [] }
const request = async <T,>(method: CoreMethod, params?: Record<string, unknown>): Promise<T> => {
  calls.push({ method, params: clone(params ?? {}) })
  if (method === 'runtime.status.get') return clone(status) as T
  if (method === 'runtime.installations.list') return [] as T
  const runtimeKind = params?.runtimeKind as typeof kinds[number]
  const stored = settings.get(runtimeKind)
  if (method === 'runtime.startup.get') {
    if (failReadOnce) { failReadOnce = false; throw new Error('Fixture settings read failed') }
    if (!stored) throw new Error('Unexpected fixture runtime')
    return clone(stored) as T
  }
  if (method === 'runtime.startup.save') {
    if (!stored) throw new Error('Unexpected fixture runtime')
    writes.push(clone(params!))
    const edits = params?.edits as { path: string[]; before: unknown; after: unknown; label: string }[]
    if (conflictOnce) {
      conflictOnce = false
      const latest = clone(stored)
      latest.revision += 1
      latest.configuration.programPath = 'C:/LOOM-QA/external-codex.exe'
      settings.set(runtimeKind, latest)
      return { status: 'conflict', latest: clone(latest), conflicts: edits.map(edit => ({
        ...edit, current: latest.configuration.programPath
      })) } as T
    }
    const next = clone(stored)
    for (const edit of edits) {
      if (edit.path.join('.') !== 'programPath' || edit.before !== stored.configuration.programPath) {
        throw new Error('Fixture refuses an unexpected or stale startup edit')
      }
      next.configuration.programPath = edit.after as string | null
    }
    const common = params?.commonEnvironment as { expectedRevision: number; json: string } | undefined
    if (common) {
      if (common.expectedRevision !== stored.commonEnvironment?.revision) throw new Error('Common environment changed')
      const environment = JSON.parse(common.json) as Record<string, string>
      if (Object.keys(environment).some(key => key !== 'LOOM_QA_NOTE')) throw new Error('Only non-sensitive fixture variables are permitted')
      next.commonEnvironment = { revision: common.expectedRevision + 1, environment }
    }
    next.revision += 1
    settings.set(runtimeKind, next)
    return clone(next) as T
  }
  throw new Error('Unexpected fixture request: ' + method)
}
const environment = {
  client: { request, subscribe: () => () => {} } as unknown as ThreadClient,
  workbench: { catalog: async () => ({ protocolVersion: 1, programs: [], items: [], errors: [],
    truncated: { limitHit: false, visited: 0, visitedItems: 0, depth: 0 } }) }
} as unknown as BusinessEnvironment

function App() {
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useState<'day' | 'night'>('day')
  Object.assign(window, { runtimeSettingsQA: {
    calls, writes,
    stored: (kind: typeof kinds[number]) => clone(settings.get(kind)),
    setTheme, conflictOnce: () => { conflictOnce = true }, failReadOnce: () => { failReadOnce = true }
  } })
  return <main className="ln-shell" data-theme={theme}>
    <button id="open-setup" className="ln-action" onClick={() => setOpen(true)}>打开工作环境</button>
    <NativeSetup open={open} environment={environment} theme={theme}
      onClose={() => setOpen(false)} onChanged={() => {}} onManageAssistants={() => {}}/>
  </main>
}
createRoot(document.getElementById('root')!).render(<App/>)

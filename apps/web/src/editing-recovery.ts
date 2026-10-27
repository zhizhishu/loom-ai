import type { EditingRecovery } from '../../desktop/src/renderer/src/camp-client'
import type { RecoveryStorage } from './tab-recovery'

export function browserEditingRecovery(scope: string, storage: RecoveryStorage = sessionStorage): EditingRecovery {
  const key = 'rovai.web.edits.v1'
  const read = (): Record<string, unknown> => {
    const raw = storage.getItem(key)
    if (!raw) return {}
    const saved = JSON.parse(raw) as { scope?: unknown; entries?: Record<string, unknown> }
    return saved.scope === scope && saved.entries && typeof saved.entries === 'object' ? saved.entries : {}
  }
  return {
    get: identity => read()[identity] ?? null,
    set(identity, value) {
      const entries = read()
      if (value === null) delete entries[identity]
      else entries[identity] = value
      storage.setItem(key, JSON.stringify({ scope, entries }))
    }
  }
}

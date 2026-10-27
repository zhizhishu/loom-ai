import { useSyncExternalStore } from 'react'
import type { GeneralPreferencesSnapshot, InterfaceLanguage, InterfaceLanguageApi, InterfaceLanguagePreference, InterfaceLanguageSnapshot } from '@contracts'
import { DEFAULT_GENERAL_PREFERENCES } from '../../shared/general-preferences-model'
import englishCopy from './locales/en.json'

const english: Readonly<Record<string, string>> = englishCopy
const listeners = new Set<() => void>()
// Unbound, component-only callers retain the catalog's original Chinese presentation.
// Desktop/Web entries gate their first frame on the local source below.
let current: InterfaceLanguageSnapshot = languageSnapshot({ ...DEFAULT_GENERAL_PREFERENCES, interfaceLanguagePreference: 'zh-CN', interfaceLanguage: 'zh-CN' })
let saved = current
let initialized = false
let requestNumber = 0
let pendingRequests = 0
let latestRequestFailed = false
let epoch = 0
let source: InterfaceLanguageApi | null = null

function languageSnapshot(snapshot: InterfaceLanguageSnapshot): InterfaceLanguageSnapshot {
  const { interfaceLanguagePreference, interfaceLanguage, systemLanguage, languageRevision, readError } = snapshot
  return { interfaceLanguagePreference, interfaceLanguage, systemLanguage, languageRevision, readError }
}
function publish(snapshot: InterfaceLanguageSnapshot): void {
  if (typeof document !== 'undefined') document.documentElement.lang = snapshot.interfaceLanguage
  if (JSON.stringify(current) === JSON.stringify(snapshot)) return
  current = languageSnapshot(snapshot)
  listeners.forEach(listener => listener())
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export const getInterfaceLanguage = (): InterfaceLanguage => current.interfaceLanguage
export const getInterfaceLanguageSnapshot = (): InterfaceLanguageSnapshot => current
export const useInterfaceLanguage = (): InterfaceLanguage => useSyncExternalStore(subscribe, getInterfaceLanguage, getInterfaceLanguage)
export const useInterfaceLanguageSnapshot = (): InterfaceLanguageSnapshot => useSyncExternalStore(subscribe, getInterfaceLanguageSnapshot, getInterfaceLanguageSnapshot)

function effective(snapshot: InterfaceLanguageSnapshot, preference = snapshot.interfaceLanguagePreference): InterfaceLanguageSnapshot {
  return { ...snapshot, interfaceLanguagePreference: preference, interfaceLanguage: preference === 'system' ? snapshot.systemLanguage : preference }
}
function accept(snapshot: InterfaceLanguageSnapshot): void {
  if (snapshot.languageRevision < saved.languageRevision) return
  saved = languageSnapshot(snapshot)
  initialized = true
  publish(effective(saved, pendingRequests > 0 && !latestRequestFailed ? current.interfaceLanguagePreference : saved.interfaceLanguagePreference))
}

/** Standalone consumers can restore once; the entry's live local source owns later changes. */
export function initializeInterfaceLanguage(snapshot: InterfaceLanguageSnapshot): void {
  if (source || initialized || pendingRequests > 0) return
  accept(snapshot)
}

/** Subscribe before reading; revisions and source epochs reject stale reads, events and saves. */
export function observeInterfaceLanguage(api: InterfaceLanguageApi, ready: () => void = () => undefined): () => void {
  const generation = ++epoch
  source = api
  initialized = false
  pendingRequests = 0
  latestRequestFailed = false
  saved = { ...languageSnapshot(DEFAULT_GENERAL_PREFERENCES), languageRevision: -1 }
  const unsubscribe = api.onInterfaceLanguageChanged(snapshot => { if (generation === epoch) accept(snapshot) })
  void refreshInterfaceLanguage().finally(() => { if (generation === epoch) ready() })
  return () => {
    unsubscribe()
    if (generation === epoch) { epoch++; source = null }
  }
}

export async function refreshInterfaceLanguage(): Promise<void> {
  if (!source) return
  const generation = epoch
  try {
    const snapshot = await source.getInterfaceLanguage()
    if (generation === epoch) accept(snapshot)
  } catch {
    if (generation !== epoch) return
    saved = { ...saved, readError: {
      code: 'interface_language_unreadable', message: '语言偏好暂时无法读取，原记录已保留。', retryable: true, details: {}
    } }
    publish({ ...(initialized ? current : effective(saved)), readError: saved.readError })
  }
}

/** Optimistic display; persistence is serialized by the local preference owner. */
export async function changeInterfaceLanguage(
  api: InterfaceLanguageApi,
  preference: InterfaceLanguagePreference,
  onSaved?: (snapshot: GeneralPreferencesSnapshot) => void
): Promise<void> {
  const request = ++requestNumber, generation = epoch
  pendingRequests++
  latestRequestFailed = false
  publish(effective(current, preference))
  try {
    const snapshot = await api.setInterfaceLanguagePreference(preference)
    if (generation !== epoch) return
    if (snapshot.languageRevision >= saved.languageRevision) saved = languageSnapshot(snapshot)
    initialized = true
    if (request === requestNumber) {
      latestRequestFailed = false
      publish(effective(saved))
      onSaved?.({ ...snapshot, ...saved })
    }
  } catch (error) {
    if (generation === epoch && request === requestNumber) {
      latestRequestFailed = true
      publish(effective(saved))
      // Refresh the system result on rollback; it is never restored from a cached manual language.
      await refreshInterfaceLanguage()
    }
    throw error
  } finally {
    if (generation === epoch) {
      pendingRequests--
      if (pendingRequests === 0 && latestRequestFailed) publish(effective(saved))
    }
  }
}

/** Only app-owned copy enters this catalog. User data and Runtime output stay untouched. */
export function translateUi(language: InterfaceLanguage, chinese: string, ...values: Array<string | number>): string {
  const key = chinese.trim()
  const prefix = chinese.slice(0, chinese.indexOf(key))
  const suffix = chinese.slice(chinese.indexOf(key) + key.length)
  const template = language === 'en' ? english[key] ?? key : key
  const formatted = template.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = values[Number(index)]
    return value === undefined ? match : String(value)
  })
  return prefix + formatted + suffix
}

export function useUiText(): (chinese: string, ...values: Array<string | number>) => string {
  const language = useInterfaceLanguage()
  return (chinese, ...values) => translateUi(language, chinese, ...values)
}

export function UiText({ zh }: { zh: string }): string {
  const language = useInterfaceLanguage()
  return translateUi(language, zh)
}

export function uiAttribute(chinese: string, ...values: Array<string | number>): string {
  return translateUi(current.interfaceLanguage, chinese, ...values)
}

import { describe, expect, it, vi } from 'vitest'
import type { GeneralPreferencesApi, GeneralPreferencesSnapshot, InterfaceLanguage } from '@contracts'
import { DEFAULT_GENERAL_PREFERENCES } from '../../shared/general-preferences-model'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure })
  return { promise, resolve, reject }
}

describe('interface language', () => {
  it('uses a complete translated sentence while preserving interpolated member names', async () => {
    vi.resetModules()
    const { translateUi } = await import('./interface-language')
    expect(translateUi('en', '使用这台电脑上已安装的智能体，为{0}提供模型与工具。', 'Dingding'))
      .toBe('Choose an installed Agent to give Dingding access to models and tools.')
    expect(translateUi('zh-CN', '欢迎来到 Rovai')).toBe('欢迎来到 Rovai')
  })

  it('keeps the last saved choice after a newer save fails', async () => {
    vi.resetModules()
    const { changeInterfaceLanguage, getInterfaceLanguage, initializeInterfaceLanguage } = await import('./interface-language')
    initializeInterfaceLanguage(DEFAULT_GENERAL_PREFERENCES)
    const first = deferred<GeneralPreferencesSnapshot>()
    const second = deferred<GeneralPreferencesSnapshot>()
    const saves = [first, second]
    const api = {
      setInterfaceLanguagePreference: (_language: InterfaceLanguage) => saves.shift()!.promise
    } as unknown as GeneralPreferencesApi

    const english = changeInterfaceLanguage(api, 'en')
    const chinese = changeInterfaceLanguage(api, 'zh-CN')
    first.resolve({ ...DEFAULT_GENERAL_PREFERENCES, interfaceLanguagePreference: 'en', interfaceLanguage: 'en', languageRevision: 1 })
    await english
    second.reject(new Error('disk unavailable'))
    await expect(chinese).rejects.toThrow('disk unavailable')
    expect(getInterfaceLanguage()).toBe('en')
  })

  it('keeps preference changes visible even when the resolved language is unchanged, and ignores stale reads and events', async () => {
    vi.resetModules()
    const state = await import('./interface-language')
    const reading = deferred<GeneralPreferencesSnapshot>()
    let listener!: (value: GeneralPreferencesSnapshot) => void
    const initial = { ...DEFAULT_GENERAL_PREFERENCES, systemLanguage: 'zh-CN' as const, interfaceLanguage: 'zh-CN' as const }
    const api = {
      getInterfaceLanguage: () => reading.promise,
      onInterfaceLanguageChanged: (callback: typeof listener) => { listener = callback; return () => undefined },
      setInterfaceLanguagePreference: async (preference: 'zh-CN' | 'system') => ({ ...initial, interfaceLanguagePreference: preference, languageRevision: 3 })
    } as unknown as GeneralPreferencesApi
    const stop = state.observeInterfaceLanguage(api)
    listener({ ...initial, languageRevision: 2 })
    await state.changeInterfaceLanguage(api, 'zh-CN')
    reading.resolve(initial)
    await reading.promise
    listener({ ...initial, languageRevision: 1 })
    expect(state.getInterfaceLanguageSnapshot()).toMatchObject({ interfaceLanguagePreference: 'zh-CN', interfaceLanguage: 'zh-CN' })
    await state.changeInterfaceLanguage(api, 'system')
    expect(state.getInterfaceLanguageSnapshot().interfaceLanguagePreference).toBe('system')
    stop()
  })

  it('resolves the saved system preference again after a failed manual save', async () => {
    vi.resetModules()
    const state = await import('./interface-language')
    let system: 'zh-CN' | 'en' = 'zh-CN'
    let revision = 0
    const api = {
      getInterfaceLanguage: async () => ({ ...DEFAULT_GENERAL_PREFERENCES, systemLanguage: system, interfaceLanguage: system, languageRevision: ++revision }),
      onInterfaceLanguageChanged: () => () => undefined,
      setInterfaceLanguagePreference: async () => { system = 'en'; throw new Error('write failed') }
    } as unknown as GeneralPreferencesApi
    const ready = deferred<void>()
    const stop = state.observeInterfaceLanguage(api, () => ready.resolve())
    await ready.promise
    await expect(state.changeInterfaceLanguage(api, 'zh-CN')).rejects.toThrow('write failed')
    expect(state.getInterfaceLanguageSnapshot()).toMatchObject({ interfaceLanguagePreference: 'system', interfaceLanguage: 'en' })
    stop()
  })

  it('retains a failed rollback read until a successful retry clears the recovery notice', async () => {
    vi.resetModules()
    const state = await import('./interface-language')
    let failRead = false
    const api = {
      getInterfaceLanguage: async () => {
        if (failRead) throw new Error('read failed')
        return DEFAULT_GENERAL_PREFERENCES
      },
      onInterfaceLanguageChanged: () => () => undefined,
      setInterfaceLanguagePreference: async () => { failRead = true; throw new Error('write failed') }
    } as unknown as GeneralPreferencesApi
    const ready = deferred<void>()
    const stop = state.observeInterfaceLanguage(api, () => ready.resolve())
    await ready.promise
    await expect(state.changeInterfaceLanguage(api, 'zh-CN')).rejects.toThrow('write failed')
    expect(state.getInterfaceLanguageSnapshot()).toMatchObject({
      interfaceLanguagePreference: 'system', interfaceLanguage: 'en',
      readError: { code: 'interface_language_unreadable', retryable: true }
    })
    failRead = false
    await state.refreshInterfaceLanguage()
    expect(state.getInterfaceLanguageSnapshot().readError).toBeNull()
    stop()
  })
})

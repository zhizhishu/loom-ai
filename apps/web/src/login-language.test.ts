import { describe, expect, it, vi } from 'vitest'
import type { GeneralPreferencesSnapshot, InterfaceLanguageApi, InterfaceLanguagePreference } from '@contracts'
import { DEFAULT_GENERAL_PREFERENCES } from '../../desktop/src/shared/general-preferences-model'
import { createLoginLanguagePreferences } from './login-language'

function snapshot(preference: InterfaceLanguagePreference): GeneralPreferencesSnapshot {
  return { ...DEFAULT_GENERAL_PREFERENCES, interfaceLanguagePreference: preference,
    interfaceLanguage: preference === 'system' ? 'en' : preference }
}
function api(save = vi.fn(async (preference: InterfaceLanguagePreference) => snapshot(preference))): InterfaceLanguageApi {
  return { getInterfaceLanguage: async () => DEFAULT_GENERAL_PREFERENCES,
    onInterfaceLanguageChanged: () => () => undefined, setInterfaceLanguagePreference: save }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('login language handoff', () => {
  it('leaves the existing authenticated preference untouched after passive detection', async () => {
    const login = createLoginLanguagePreferences(api())
    const scoped = api()
    await login.api.getInterfaceLanguage()
    await login.transferTo(scoped)
    expect(scoped.setInterfaceLanguagePreference).not.toHaveBeenCalled()
  })

  it('preserves a later login choice while a scoped write is waiting for the browser lock', async () => {
    const login = createLoginLanguagePreferences(api())
    const firstSave = deferred<GeneralPreferencesSnapshot>()
    const started = deferred<void>()
    const save = vi.fn(async (preference: InterfaceLanguagePreference) => {
      if (preference === 'en') { started.resolve(); return firstSave.promise }
      return snapshot(preference)
    })
    await login.api.setInterfaceLanguagePreference('en')
    const transfer = login.transferTo(api(save))
    await started.promise
    await login.api.setInterfaceLanguagePreference('system')
    firstSave.resolve(snapshot('en'))
    await transfer
    expect(save.mock.calls).toEqual([['en'], ['system']])
    await login.transferTo(api(save))
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('waits for an in-flight login choice before switching to the authenticated scope', async () => {
    const localSave = deferred<GeneralPreferencesSnapshot>()
    const login = createLoginLanguagePreferences(api(vi.fn(() => localSave.promise)))
    const scoped = api()
    const choice = login.api.setInterfaceLanguagePreference('zh-CN')
    const transfer = login.transferTo(scoped)
    expect(scoped.setInterfaceLanguagePreference).not.toHaveBeenCalled()
    localSave.resolve(snapshot('zh-CN'))
    await choice
    await transfer
    expect(scoped.setInterfaceLanguagePreference).toHaveBeenCalledWith('zh-CN')
  })
})

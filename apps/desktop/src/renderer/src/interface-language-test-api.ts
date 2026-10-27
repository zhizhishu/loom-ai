import type { InterfaceLanguageApi } from '@contracts'
import { DEFAULT_GENERAL_PREFERENCES } from '../../shared/general-preferences-model'
import { getInterfaceLanguageSnapshot } from './interface-language'

/** Locale fixture for component-only tests without a mounted Desktop/Web entry. */
export const languageTestApi: InterfaceLanguageApi = {
  getInterfaceLanguage: async () => getInterfaceLanguageSnapshot(),
  onInterfaceLanguageChanged: () => () => undefined,
  setInterfaceLanguagePreference: async preference => {
    const previous = getInterfaceLanguageSnapshot()
    return { ...DEFAULT_GENERAL_PREFERENCES, ...previous, interfaceLanguagePreference: preference,
      interfaceLanguage: preference === 'system' ? previous.systemLanguage : preference,
      languageRevision: previous.languageRevision + 1 }
  }
}

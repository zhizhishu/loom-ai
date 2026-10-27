import type { GeneralPreferencesSnapshot, InterfaceLanguageApi, InterfaceLanguagePreference } from '@contracts'

/** The unauthenticated page has no storage scope. Transfer only an explicit choice,
 * including choices made while the authenticated browser scope is still saving. */
export function createLoginLanguagePreferences(temporary: InterfaceLanguageApi): {
  api: InterfaceLanguageApi
  transferTo(scoped: InterfaceLanguageApi): Promise<void>
} {
  let choice: { preference: InterfaceLanguagePreference; saved: Promise<GeneralPreferencesSnapshot> } | null = null
  return {
    api: {
      ...temporary,
      setInterfaceLanguagePreference(preference) {
        const saved = temporary.setInterfaceLanguagePreference(preference)
        choice = { preference, saved }
        return saved
      }
    },
    async transferTo(scoped) {
      let failure: unknown
      while (choice) {
        const transferring = choice
        try {
          await transferring.saved
          if (choice !== transferring) continue
          await scoped.setInterfaceLanguagePreference(transferring.preference)
          failure = undefined
        } catch (error) { failure = error }
        if (choice === transferring) choice = null
      }
      if (failure) throw failure
    }
  }
}

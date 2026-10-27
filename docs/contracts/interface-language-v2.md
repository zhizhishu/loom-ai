---
document_type: interface-contract
contract: interface-language
version: 2
status: accepted
authority: interface-language-preference-and-presentation
source_version: v1.72
last_updated: 2026-10-21
---

# Interface Language v2

## Preference and local authority

`InterfaceLanguagePreference` is `system | zh-CN | en`; `InterfaceLanguage` remains `zh-CN | en` for translations and presentation. Settings → General, the onboarding welcome header and Web login expose the same three choices: 跟随系统 / 简体中文 / English. Language names remain in their own language. Changing the choice never reloads or remounts the business component tree.

Desktop Main reads `app.getPreferredSystemLanguages()` and owns the local result used by startup, the business workspace and native prompts. It does not use a remote Host's locale. Web reads `navigator.languages`, supplemented with `navigator.language`, and keeps each authenticated owner's existing browser presentation scope. An unauthenticated login choice is memory-only until that scope is known; an explicit choice transfers once after authentication. Passive detection does not replace a saved owner preference.

## Resolution

For `system`, normalize tag case and `_` to `-`, then scan the device list in order. The primary `zh` tag and every region/script variant, including zh-TW, zh-HK and zh-Hant, select the existing simplified Chinese resources. The primary `en` tag and its variants select English. Skip unsupported languages. An empty, unreadable or entirely unsupported list resolves to `en`. Manual choices always win.

The runtime language snapshot contains `interfaceLanguagePreference`, resolved `interfaceLanguage`, current `systemLanguage`, monotonic `languageRevision` and nullable `readError`. `systemLanguage` lets an immediate manual → system selection and failure rollback use the local owner's current result. None of those runtime fields except the preference enters storage.

## Storage and upgrade

`GeneralPreferencesStorage` is exact-key schema 6: replace schema 5's `interfaceLanguage` with `interfaceLanguagePreference`, retaining the other general preference fields. `GeneralPreferencesSnapshot` adds the language snapshot's runtime fields; storage and runtime validation are separate. Writes persist only the storage shape.

| Actual source | Preference after reading |
| --- | --- |
| Missing file/storage item | `system` |
| Valid schema 1–4 | `zh-CN` |
| Valid schema 5 | Preserve its `zh-CN` or `en` |
| Valid schema 6 | Preserve `system`, `zh-CN` or `en` |

Do not infer language initialization from install time, App version or onboarding completion. Schema 5 cannot distinguish a deliberate Chinese choice from the former saved default; both remain Chinese. Normal upgrades, overwrite installs and reinstalls retaining user data read the existing record. Version v0.4.1 introduced the language field, but schema/content alone control migration, including self-built versions.

A corrupt or unreadable record is preserved. Retain a previously valid in-memory preference; a cold process without one temporarily resolves `system` with English fallback. Show a recoverable local read notice. Unrelated automatic general preference writes must also refuse to replace an unreadable record. Only a successful subsequent read clears the guard. Missing storage is distinct from an invalid JSON value or storage access failure.

## Startup, changes and recovery

Restore and resolve local language before showing localized startup, onboarding or workspace text. Desktop's local-only read waits for the preference store, never Core/business readiness. Until this read completes, render the neutral startup canvas. Web similarly restores authentication/owner scope before showing a workspace with saved preferences.

Selection updates the UI immediately. Main serializes private JSON writes; Web uses its existing browser preference lock. Reading or saving language never requires a successful shared new-conversation preference request. Language change events are local to each client. Source identity, revision and request order prevent older reads, events and save responses from replacing a later selection; a new Web owner/source cannot accept responses from the previous source.

On failure, restore the last successfully saved preference. A saved `system` preference resolves against the current local language source rather than restoring a cached display language. Keep the local error/retry affordance. Do not clear drafts, reset navigation, cancel tasks or rewrite any user data.

Desktop refreshes on startup, window activation, resume and available macOS locale notifications. Web refreshes on `languagechange`, focus and visible activation, and observes changes to the same browser preference record. System changes do not persist automatic results or alter a manual selection. Update `document.documentElement.lang` with the effective language.

## Content and onboarding boundary

Only App-owned navigation, controls, explanatory copy, status/error shells and accessible names enter the translation catalog. User-written text, saved member identities, names, drafts, messages, memories, Runtime output, paths, commands, model names and IDs retain their bytes. Non-Renderer AgentRun callers retain their established default presentation.

Unsaved built-in onboarding candidates follow the displayed language. Creation durably freezes a concrete language in the provisioning checkpoint under [First-run Onboarding v7](first-run-onboarding-v7.md). Resume and replay use that language even if the system or manual preference changes. The four untouched, unconfigured factory identities may be initialized in that language; customized, configured or removed profiles are preserved.

Desktop retains the provenance-based First Chat display rule: only the completed onboarding snapshot's `quickChatThreadId`, while its saved name remains `初次集结`, displays `First Chat` in English. Persisted titles and command payloads remain unchanged. Renamed Threads and unrelated same-name Threads remain user data; search accepts display and saved names.

## References

- [First-run presentation](../ui/components/first-run-onboarding.md)
- [App Shell and General Settings](../ui/components/app-shell-navigation.md)
- [Electron system language source](https://www.electronjs.org/docs/latest/api/app#getpreferredsystemlanguages)

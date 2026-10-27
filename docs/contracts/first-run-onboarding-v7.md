---
document_type: interface-contract
contract: first-run-onboarding
version: 7
status: accepted
authority: desktop-first-run-state-authority-origin-provisioning-deferral-and-local-entry
source_version: v1.72
last_updated: 2026-10-21
---

# First-run Onboarding v7 Contract

v7 retains [v6](first-run-onboarding-v6.md)'s authority admission, Runtime copy plan, deferral, command replay and Desktop-local starter. It adds a durable language boundary for [follow-system presentation](interface-language-v2.md).

New snapshots use schema 4. Every non-null provisioning operation has an exact-key `interfaceLanguage: 'zh-CN' | 'en'`. `beginProvisioning(selection, permissions, interfaceLanguage)` validates and saves the concrete display language before any identity command. Repeated calls retain the original checkpoint, including its language and command IDs. The Renderer derives every candidate identity payload from the returned checkpoint, not the current UI preference.

Valid schema 1–3 snapshots normalize to schema 4, retaining all existing IDs, progress and terminal origins. An older in-progress checkpoint lacks a recorded language; migrate it from the restored local display language, then preserve that value on subsequent writes. Main therefore restores General Preferences before loading onboarding. Schema 1/2 still acquire the v6 Runtime copy plan default; schema 3 retains its existing copy plan. Completed snapshots never reopen or backfill saved identities. Invalid and mixed-version shapes remain rejected.

Before provisioning, candidate text follows the effective display language while the selected role, step and model choices remain stable. During provisioning and after a restart, the frozen checkpoint controls identity initialization even when the operating system language changes. UI text can still follow the device; it does not rewrite the frozen creation payload or any saved user identity.

The existing `onboarding-preferences`, `onboarding-provisioning` and `onboarding-runtime-copy` test owners cover migration, frozen identity replay and unchanged Runtime/Thread behavior.

## References

- [First-run architecture](../architecture/first-run-onboarding.md)
- [First-run UI](../ui/components/first-run-onboarding.md)
- [Interface Language v2](interface-language-v2.md)

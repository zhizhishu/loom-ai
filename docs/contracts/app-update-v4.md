---
document_type: interface-contract
contract: app-update
version: 4
status: accepted
authority: desktop-app-update-state-actions-and-controlled-exit
source_version: v1.60
last_updated: 2026-09-19
---

# App Update v4 Contract

v4 inherits [v3](app-update-v3.md)'s snapshot/API wire, updater-first staging, prompt generations, actions and
platform release verification. It follows [Planned Shutdown v8](planned-shutdown-v8.md) for installer-accepted exit.

After `quitAndInstall` synchronously accepts installer handoff, native quit enters the ordinary
`AppQuitCoordinator`. In-flight Renderer input operations still settle before teardown. Already saved Active-Camp
Composer snapshots remain Desktop-local and can be restored after restart; the coordinator neither writes a Core
Draft nor discards those snapshots. If local preparation fails, Rovai does not start service drain or claim that
installer handoff rolled back; a later native quit may retry.

Installer staging still precedes this coordination. Core must not shut down merely to discover that the platform
updater rejected installation synchronously.

## References

- [App Update v3 (historical)](app-update-v3.md)
- [Desktop App Updates architecture](../architecture/desktop-app-updates.md)
- [Camp Composer Draft v15](camp-composer-draft-v15.md)
- [Planned Shutdown v8](planned-shutdown-v8.md)

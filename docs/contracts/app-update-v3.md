---
document_type: interface-contract
contract: app-update-v3
version: 3
status: accepted
authority: desktop-app-update-state-actions-and-renderer-local-controlled-exit
source_version: v1.60
last_updated: 2026-09-18
---

# App Update v3 Contract

v3 inherits v2's snapshot/API wire, release normalization, checks, prompt generations, download/install actions,
updater-first staging and platform release verification. It replaces the public Composer Draft save fence.

After `quitAndInstall` synchronously accepts installer handoff, native quit enters the ordinary
`AppQuitCoordinator`. Renderer-local in-flight input operations follow [Planned Shutdown v7](planned-shutdown-v7.md);
the coordinator does not persist or restore unsent public Composer content. If local preparation fails, Rovai does not
start service drain or claim that installer handoff rolled back; a later native quit may retry.

Installer staging still precedes this coordination. Core must not shut down merely to discover that the platform
updater rejected installation synchronously.

## References

- [App Update v2 (historical)](app-update-v2.md)
- [Desktop App Updates architecture](../architecture/desktop-app-updates.md)
- [Camp Composer Draft v14](camp-composer-draft-v14.md)
- [Planned Shutdown v7](planned-shutdown-v7.md)

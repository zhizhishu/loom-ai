---
document_type: interface-contract
contract: first-run-onboarding
version: 5
status: accepted
authority: desktop-first-run-state-authority-origin-provisioning-deferral-and-local-entry
source_version: v1.60
last_updated: 2026-09-19
---

# First-run Onboarding v5 Contract

v5 inherits [v4](first-run-onboarding-v4.md)'s schema 2 state, admission, provisioning, `runtime_deferred`, real
`初次集结` Active Camp and presentation-only starter rows. The fourth-page starter input now follows
[Camp Composer Draft v15](camp-composer-draft-v15.md).

Selecting a starter replaces the Active Camp's Desktop-local Composer snapshot, focuses its end and announces that
the content is ready to edit. It does not write a Core Draft, create Pending input, publish a message, start a Run or
invoke a Skill. Camp switching, Renderer refresh, window recreation and ordinary restart restore that same unsent
snapshot. Confirmed send success replaces it; rejection or uncertain outcome keeps it.

The Active Camp remains the durable fourth-page destination. `runtime_deferred` still creates no synthetic Camp or
starter surface.

## References

- [First-run Onboarding v4 (historical)](first-run-onboarding-v4.md)
- [First-run Onboarding architecture](../architecture/first-run-onboarding.md)
- [First-run UI](../ui/components/first-run-onboarding.md)
- [Camp Composer Draft v15](camp-composer-draft-v15.md)

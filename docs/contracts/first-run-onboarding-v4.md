---
document_type: protocol-contract
contract: first-run-onboarding-v4
authority: desktop-first-run-state-authority-origin-provisioning-deferral-and-local-entry
status: accepted
version: 4
source_version: v1.60
last_updated: 2026-09-18
---

# First-run Onboarding v4 Contract

v4 inherits v3's schema 2 state, three mandatory pages, Full Core authority-origin admission, idempotent provisioning,
`runtime_deferred`, preference-failure handling and real `初次集结` Active Camp. It changes only the fourth-page starter
input to follow [Camp Composer Draft v14](camp-composer-draft-v14.md).

When `completed(onboarding)` opens the real Camp, the three starter rows are presentation shortcuts. Selecting one
replaces the currently mounted Renderer input, focuses its end and announces that content is ready to edit. It does not
write a Core Draft, create Pending input, publish a message, start a Run or invoke a Skill. Send success clears the local
input; rejection or failure keeps it in that mounted Renderer. Switching, refreshing, closing or exiting does not
persist or restore the selection.

The Active Camp itself remains the durable fourth-page destination. `runtime_deferred` still creates no synthetic Camp
or starter surface.

## References

- [First-run Onboarding v3 (historical)](first-run-onboarding-v3.md)
- [First-run Onboarding architecture](../architecture/first-run-onboarding.md)
- [First-run UI](../ui/components/first-run-onboarding.md)
- [Camp Composer Draft v14](camp-composer-draft-v14.md)

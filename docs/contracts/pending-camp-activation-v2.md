---
document_type: protocol-contract
contract: pending-camp-activation-v2
authority: camp-creation-activation-and-renderer-local-first-input
status: accepted
version: 2
source_version: v1.60
last_updated: 2026-09-18
---

# Pending Camp Activation v2 Contract

v2 keeps v1's `camps.create.activationState: "pending" | "active"`, atomic membership creation, first-message
activation, mutation guard and guarded empty discard. It replaces public Draft-backed navigation and first-send input.

## Renderer-local Pending input

A confirmed one-click entry creates a Pending Camp and opens it in the current Renderer. Its unsent body, structured
content, quotes, reply state and source-attachment references are Renderer-local and are not written to
`camp_composer_draft`, `pending_camp_input` or another recovery store. Pending Camps do not become Navigation or
restorable-location entries because local input is meaningful.

Switching Camp, refreshing, closing the window or exiting does not persist or restore that input. The product may wait
for an already-started local operation or show a lightweight dirty warning, but neither behavior creates a durable
Draft contract.

## First accepted send

The Renderer submits one frozen message snapshot. After authorization and message validation, one Core transaction:

1. verifies the Camp is still Pending;
2. changes `activation_state` to `active` and records `camp.activated`;
3. publishes the CampMessage; and
4. creates one waiting Delivery per explicit target.

Rejection or rollback leaves the Camp Pending. It does not instruct the Renderer to clear its current input. Agent sends
cannot originate from a Pending Camp because it has no accepted public input or AgentRun.

## Guarded discard and startup cleanup

`camps.discardPending` remains idempotent for an absent Camp, rejects an Active Camp, and may delete only an untouched
Pending Camp with no message or non-command-result domain mutation. Startup applies the same empty predicate. Legacy
Draft/Pending rows are not a current source of recoverable content and are removed by the v1.60 clean break.

## References

- [Pending Camp Activation v1 (historical)](pending-camp-activation-v1.md)
- [Camp Composer Draft v14](camp-composer-draft-v14.md)
- [Camp Activation architecture](../architecture/camp-activation-lifecycle.md)

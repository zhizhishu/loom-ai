---
document_type: protocol-contract
contract: accepted-input-recovery-v6
authority: accepted-runtime-input-failure-and-execution-isolation
status: accepted
version: 6
source_version: v1.60
last_updated: 2026-09-18
---

# Accepted Input Recovery v6

v6 keeps v5's frozen-input, delivery-evidence and late-ACK fences. For public Camp it replaces the user-resolved
`recovery_blocked` product flow with automatic failure plus independently proven execution isolation.

## Input outcome

- An input proven `not_accepted`, with no unresolved effect, may continue transport recovery only inside the same
  AgentRun, execution identity and frozen ContextManifest.
- An `accepted` or `delivery_unknown` input is never replayed, copied into a successor Run or treated as unexecuted.
- When its final result cannot be reconciled, Core ends the AgentRun as failed and preserves the typed
  `accepted_input_outcome_unknown` evidence internally. The normal UI presents the same red failure treatment as other
  execution errors; there is no user “end this run” or retry action.
- A new user message is a new Delivery. It does not reinterpret, complete or retry the failed input.

## Isolation gate

AgentRun terminal state and old execution isolation are separate facts. A failed or cancelled Run does not release its
`(CampId, AgentId)` lane merely because `status` is terminal. The Adapter's existing stop/cleanup path must prove that
the old execution can no longer produce authoritative effects before Scheduler may claim the next Delivery.

While cleanup is unconfirmed:

- successor input remains a waiting Delivery; Core does not create a Run that cannot dispatch;
- if the old execution may still write an execution root, only dispatches sharing that root are temporarily fenced;
- silence, Core write revocation, a new Native Session or user acknowledgement is not isolation proof.

After cleanup is confirmed, Scheduler resumes ordinary FIFO claim. After an unknown outcome Core defaults to a new
Native Session unless the Adapter already proves the old native turn ended; Session rotation never substitutes for
process cleanup.

## Stop and restart

User Stop uses exact `agentRunId + version` CAS. It settles only that Run, preserves accepted/unknown and effect
evidence, requests Adapter cleanup, and neither pauses the lane nor cancels waiting Delivery. Once cleanup is confirmed,
the next Delivery may claim normally. There is no business retry API or manual recovery-release override.

Startup performs the same evidence classification and cleanup gating before opening Scheduler admission. Repeated
startup is idempotent: it does not increment an execution attempt, rewrite a terminal result or resend accepted input.

## References

- [Accepted Input Recovery v5 (historical)](accepted-input-recovery-v5.md)
- [Message Delivery v10](message-delivery-v10.md)
- [AgentRun Recovery architecture](../architecture/agent-run-recovery.md)
- [Runtime recovery and shutdown invariants](../architecture/foundational-invariants.md#runtime-recovery-shutdown)

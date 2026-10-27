---
document_type: protocol-contract
contract: camp-message-send
version: 23
status: accepted
authority: principal-message-receipt-and-withdrawal-surface
last_updated: 2026-09-20
---

# Camp Message Send v23

v23 inherits [v22](camp-message-send-v22.md) publication, routing, waiting Delivery and idempotency semantics,
including the recall boundary inherited from v21. It adds the shared Desktop/Web presentation and transport
rules for a local Principal message after publication.

Only a local user-authored message may render the lightweight processing receipt. The collapsed receipt shares
the message action row and shows only an aggregate pending or processing count; terminal failures do not create
an additional aggregate warning. Opening a visible receipt reveals the addressed Agents and links only those
recipients that already have a materialized AgentRun to that exact Run. Agent-authored messages do not receive
this routine processing receipt.

Withdrawal eligibility comes only from the authoritative `CampMessageView.canWithdraw` projection. The UI must
not infer eligibility from a cached Run list. When eligible, it opens a confirmation titled “撤回这条消息？”
with the description “所有接收队员均未读，可直接撤回。”. Confirm submits `camp.messages.withdraw` with the
exact `campId`, `messageId` and projected `expectedVersion`; Cancel closes without mutation. Desktop and Web Host
both admit the same operation and command reconciliation identity.

After success, the shared snapshot replaces the body with the existing withdrawn marker at the original timeline
position. A stale or too-late rejection leaves the message and dialog recoverable and shows the returned failure.
This contract does not add an Execution-console withdrawal action or a new AgentRun cancellation reason.

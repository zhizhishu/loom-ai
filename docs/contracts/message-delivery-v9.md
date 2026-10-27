---
document_type: protocol-contract
contract: message-delivery
version: 9
status: accepted
authority: public-message-delivery-first-queue
last_updated: 2026-09-18
---

# Message Delivery v9

v9 replaces [v8](message-delivery-v8.md) for new public Camp work. Historical v1–v8 rows remain
read-only evidence; they are not dispatched by the v9 scheduler.

## Responsibility and ordering

Publishing one `CampMessage` creates at most one Delivery for each explicit target. A Delivery is the
durable fact that one Agent must receive that message; it is not an execution attempt or completion
aggregate.

```ts
type CampMessageDeliveryV9 = {
  id: string
  campId: string
  messageId: string
  recipientAgentId: string
  recipientMembershipVersionAtAdmission: number
  queueSequence: number
  status: 'waiting' | 'claimed' | 'settled' | 'failed' | 'cancelled'
  claimedAgentRunId?: string
  failureCode?: string
  version: number
}
```

`(campId, recipientAgentId, queueSequence)` is unique and ordered by the source message sequence.
`(messageId, recipientAgentId)` is unique. Waiting rows do not freeze Runtime configuration and do not
create an AgentRun.

## Claim

The scheduler atomically claims a complete FIFO prefix for one `(campId, agentId)` lane. The transaction:

1. validates current membership, prior execution isolation for the same Camp+Agent lane, and cleanup for the
   actual shared execution root as independent gates;
2. reads the Agent's current Runtime, model, mode, workspace, tools and permissions;
3. projects each candidate message exactly as `RUN_INPUT.messages[]`, including its own body, quotes, source
   attachments and Skills, serializes that projection under the once-resolved Runtime capacity, and selects the
   largest complete prefix without skipping the head;
4. creates one immutable `AgentRun` plus ordered `AgentRunInput` rows;
5. binds every selected Delivery to that Run and changes it to `claimed`.

The Run's last input is its `anchorMessageId`. Later settings and messages cannot change the frozen Run.
A crash before commit leaves waiting Deliveries; a crash after commit recovers the same Run.

Sources do not form batch boundaries. User, Agent/A2A, Mission, Automation and Channel messages can share
one Run. No budget root, depth, caller lineage, Gather or CampTurn is consulted. Self-send remains invalid.

Exactly one ordinary batch Scheduler in a Core process may claim waiting Deliveries. It performs one startup
reconciliation, then wakes after committed Delivery creation, lane release, Runtime readiness or cleanup
completion. A wake carries no durable work identity; the database remains the only work list. Duplicate and
coalesced wakes are valid. The Scheduler continues across query-page limits and dispatches Runtime preparation
in independent workers.

One process-global 30-second fallback remains active without being postponed by ordinary wakes. Its tick must
first perform a read-only pending-work check; when neither waiting Delivery nor undispatched queued batch Run
exists, it must not open the claim write transaction. Terminal settlement must not directly claim a successor,
and an error while later scheduling work must not change an already-committed terminal result. Network recovery
may dispatch its admitted existing Run but must not claim a new Delivery. Existing non-batch Run dispatch and
other 500ms maintenance duties are outside this Scheduler contract and retain their existing cadence in one
separate serialized, non-overlapping task. That path must not claim an ordinary Delivery or dispatch an ordinary
queued batch Run, and slow non-batch preparation must not block ordinary batch wakes or the fallback.

## Terminal behavior

Run settlement changes each claimed Delivery to `settled`, `failed` or `cancelled` with monotonic evidence.
There is no user business-retry transition and no replacement Run for accepted/unknown input. A safe
transport continuation may resume the same frozen Run only when the Runtime did not accept it.

Stopping a Run does not cancel waiting Deliveries. Membership removal cancels that membership lifetime's
waiting Deliveries; rejoining creates a new lifetime and only later messages create new work.

## Migration

Migration 163 preserves already-public legacy work that has no frozen ContextManifest or accepted Runtime
input as v9 waiting Deliveries. It terminalizes the old mutable Run/attempt placeholders. Frozen or
accepted legacy work is never requeued.

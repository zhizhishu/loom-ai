---
document_type: protocol-contract
contract: message-delivery
version: 10
status: accepted
authority: public-message-delivery-route-reconciliation
last_updated: 2026-09-19
---

# Message Delivery v10

v10 inherits [v9](message-delivery-v9.md) Delivery states, FIFO batching, claim-time execution freezing,
settlement, isolation and transport-recovery rules. New publication follows
[Camp Message Send v22](camp-message-send-v22.md) and therefore creates the required Camp-member Conversation
route before a waiting Delivery is committed.

Before selecting eligible lanes, the claim transaction reconciles historical waiting Deliveries whose active,
present recipient has no `kind = camp_member` Conversation. It creates that route idempotently and then evaluates
the ordinary lane gates in the same transaction. Inactive, leaving or removed recipients are not repaired and
remain governed by membership settlement.

The ordinary Scheduler's startup scan and its fixed 30-second fallback both enter this claim path when waiting
work exists, so already-stranded rows self-heal and are immediately eligible without a schema migration,
database backfill or separate maintenance event. Reconciliation creates no Run by itself and does not weaken
Runtime, membership-lifetime, execution-isolation or cleanup checks.

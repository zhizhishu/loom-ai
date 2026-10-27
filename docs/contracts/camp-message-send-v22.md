---
document_type: protocol-contract
contract: camp-message-send
version: 22
status: accepted
authority: delivery-route-complete-public-message-send
last_updated: 2026-09-19
---

# Camp Message Send v22

v22 inherits [v21](camp-message-send-v21.md) body, attachment, addressing, Channel, recall and idempotency
semantics. It closes the first-recipient routing gap.

For every explicit active recipient, the publication transaction idempotently establishes the recipient's
`kind = camp_member` Conversation before inserting its waiting Delivery. The Conversation is a durable route;
publication still does not create an AgentRun, freeze Runtime configuration or perform Runtime admission.
Existing Conversations are reused, and multiple recipients remain all-or-none with the CampMessage and
Deliveries.

`--public-only` still creates neither Delivery nor recipient Conversation. Self-send and inactive-recipient
validation remain unchanged.

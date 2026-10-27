---
document_type: protocol-contract
contract: camp-message-send
version: 21
status: accepted
authority: delivery-first-public-message-send
last_updated: 2026-09-18
---

# Camp Message Send v21

v21 inherits v20 body, file registration, Principal-attention and command authorization rules. A successful
send always commits one public `CampMessage`. Explicit Agent targets atomically create v9 waiting Deliveries;
`--public-only` creates none. Multiple targets share the message but not a completion aggregate.

The sender must name targets explicitly. Anchor/reply metadata never infers a caller, target or permission.
Self-send is rejected; depth, fanout, ancestor-cycle and collaboration-budget checks no longer exist.
There is no Gather capture path.

Agent output from a Run receives that Run's frozen `anchorMessageId` unless the caller supplied another
allowed explicit reply anchor. In a Channel-bound Camp, every successfully published Agent message also
creates one idempotent ChannelDelivery for the bound channel. Channel failure does not roll back the public
message or rerun the Agent.

Local Principal publication can create a recallable message. Its command receipt may later become an
erased-terminal receipt: replay in the same actor/command/Camp scope returns `message.withdrawn`; conflicting
scope/type returns idempotency conflict; neither executes the send handler again.


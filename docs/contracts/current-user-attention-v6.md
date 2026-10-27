---
document_type: contract
name: Current User Attention
version: v6
status: accepted
source_version: v1.60
last_updated: 2026-09-19
---

# Current User Attention v6

v6 inherits [v5](current-user-attention-v5.md)'s foreground, exact-surface and observed-through rules. Public
Delivery-first execution results add an exact AgentRun source.

The public Camp surface reports visible Message IDs, legacy CampTurn IDs, batch AgentRun IDs and pending Approval IDs.
An AgentRun ID is reported only while its execution stage intersects the visible execution drawer/inspector viewport.
`acknowledgeVisibleSources` accepts bounded `visibleAgentRunIds` alongside the existing sets and matches each terminal
Occurrence by its stored source type. Multi-recipient messages are not a confirmation unit: seeing Run A never confirms
Run B, even when both originated from the same message.

Notification navigation for `open_agent_run` activates the source Camp, opens the correct member's execution history,
selects the exact Run and moves focus to its stage. Heads-up suppression uses the same exact source set and remains
separate from persistent unread state.


---
document_type: contract
name: Notification Episode
version: v7
status: accepted
source_version: v1.60
last_updated: 2026-09-19
---

# Notification Episode v7

v7 inherits [v6](notification-episode-v6.md)'s Occurrence/Disposition, Journal, preferences, exact acknowledgement,
Single Chat identity and transient queue. Inbox and Change Batch `schemaVersion` are 8.

Delivery-first batch AgentRuns have no CampTurn. Their terminal transition therefore creates one immutable
`sourceType = agent_run` Occurrence and one collaboration Episode per exact Run. Episode and action views add nullable
`agentRunId`; `NotificationActionView.kind` adds `open_agent_run`. For that action `agentRunId` is required and
`campTurnId` is null. Historical CampTurn occurrences and `open_camp_turn` remain readable and navigable.

The existing `turn_completed`, `turn_failed` and `turn_incomplete` semantic names remain wire-compatible preference
categories for execution outcomes; source identity and navigation no longer imply a CampTurn. User-requested Run
cancellation remains excluded. A later local user message may satisfy an earlier completed batch Run in the same Camp,
but does not acknowledge it or affect failures.

Migration 164 / projection schema 114 adds the nullable source columns and batch AgentRun terminal triggers without
synthesizing CampTurns or rewriting historical occurrences. Hydration verifies the exact Run still belongs to the Camp.
Renderer navigation opens that Run in the execution surface and focuses its `data-agent-run-id` node.

Exact visible-source confirmation adds `visibleAgentRunIds`. A Run occurrence is acknowledged only when its own
execution node intersects the visible execution viewport through the observed Journal boundary; seeing the Camp,
another Run or a message is insufficient. Details are in [Current User Attention v6](current-user-attention-v6.md).


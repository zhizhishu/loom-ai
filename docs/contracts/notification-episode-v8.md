---
document_type: contract
name: Notification Episode
version: v8
status: accepted
source_version: v1.62
last_updated: 2026-09-20
---

# Notification Episode v8

v8 inherits [v7](notification-episode-v7.md)'s schema 8 wire, Delivery-first AgentRun source, Journal cursor,
preferences, invalidation and exact acknowledgement behavior. No Migration, stored field or IPC shape changes.

The foreground transient queue now treats an attentive active Camp as a quiet scope. During Change Journal reduction,
Renderer still applies invalidations and advances its cursor, but does not enqueue a heads-up signal from that Camp. When
an already queued signal's Camp becomes the attentive active Camp, Renderer removes it from the transient queue. Removed
or omitted signals are not replayed when navigation later leaves the Camp; background and other-Camp signals continue to
queue under the existing preference and lifetime rules.

This queue policy does not mutate persistent attention. Exact visible-source acknowledgement, unread state and action
availability remain Core-owned and continue to follow [Current User Attention v7](current-user-attention-v7.md). A
Renderer may still refresh and acknowledge an exact visible Mention while suppressing its card, but active-Camp identity
alone is never acknowledgement evidence.

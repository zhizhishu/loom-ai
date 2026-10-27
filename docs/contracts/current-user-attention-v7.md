---
document_type: contract
name: Current User Attention
version: v7
status: accepted
source_version: v1.62
last_updated: 2026-09-20
---

# Current User Attention v7

v7 inherits [v6](current-user-attention-v6.md)'s exact visible-source acknowledgement, public / Single Chat
separation and AgentRun navigation. It replaces only the transient heads-up suppression boundary.

While the Rovai window is visible and focused and the active product surface is a Camp workspace, every heads-up signal
whose Episode belongs to that Camp is quiet. This applies equally to ordinary Camps, full Mission conversations and
Mission conversation drawers, and to approval, failure, incomplete, Mention and completion semantics. A signal omitted
under this rule is not retained for replay after the user leaves the Camp. Another Camp, another primary page, a blocked
Camp surface or an unfocused / hidden window does not satisfy the rule.

Quieting is presentation-only. It never acknowledges an Occurrence, clears an Episode or changes unread navigation.
Message, CampTurn, AgentRun and Approval attention remains unread until its exact source is actually visible through the
observed Journal boundary. Entering a Camp can therefore remove its transient card while leaving its unread marker intact.

All three execution placements observe and locate AgentRun sources through the stable execution Portal rather than the
conversation DOM root. Right-side navigation opens the Execution tab before selecting and focusing the exact Run; compact
layout must retain that target pane. A right-side Run is reported as visible only while its exact stage intersects the
visible execution viewport, preserving v6's acknowledgement boundary.

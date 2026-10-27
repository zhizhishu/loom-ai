---
document_type: contract
contract: scheduled-automation-v3
status: accepted
target_version: v1.60
last_updated: 2026-09-18
---

# Scheduled Automation v3

v3 inherits v2 Automation definition, scheduling, Owner notification and optional occurrence time limit.
Occurrence admission has only two outcomes:

- an active occurrence already exists: persist `skipped(overlap)`;
- none exists: atomically create a `started` occurrence, new Camp, first system-authored message and waiting
  Delivery.

The unified scheduler immediately tries to claim that Delivery; only a successful claim creates an
AgentRun. If claim cannot proceed, the Delivery remains waiting while the occurrence stays `started` and
its time limit continues. There is no queued occurrence, queue timeout, special input kind, dedicated Run
or source-based batch boundary. Later messages use the same public queue.

Occurrence result, timeout and Owner notification are Automation business facts; they are not inferred from
generic Delivery or Run settlement.


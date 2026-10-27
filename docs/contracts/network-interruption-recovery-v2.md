---
document_type: protocol-contract
contract: network-interruption-recovery-v2
authority: live-network-interruption-classification-scheduling-and-safe-resume
status: accepted
version: 2
source_version: v1.60
last_updated: 2026-09-18
---

# Network Interruption Recovery v2

v2 keeps v1's strict network classifier, Adapter coverage, in-memory per-Run queue, fixed
`1, 2, 3, 5, 10, 15, 30, 30...` second backoff, online/resume wake, epoch fencing and accepted-input prohibition. It
removes CampTurn and collaboration-budget dependencies and composes with [Accepted Input Recovery v6](accepted-input-recovery-v6.md).

## Safe same-Run recovery

Recovery is admitted only after an ACP Prompt network terminal when the current epoch input is absent, proven
`not_accepted`, or still `prepared` without `dispatch_started_at`, and no Approval, Action, Runtime Delivery or external
effect remains unsettled. It reuses the same frozen AgentRun and ContextManifest with a new execution epoch; it never
creates a new Run, Delivery or business retry.

Every attempt rechecks exact Run/version/epoch, cancellation, membership, current authorization over frozen
capabilities, input safety and pending effects. Public Camp collaboration budgets, deadlines, A2A counts/depth/fanout
and CampTurn state are not checks because they are no longer current execution authority. Provider quota, Runtime
capacity and transport failures retain their own normal errors and are not reclassified as network evidence.

`accepted`, `delivery_unknown` or crossed dispatch boundary permanently disables automatic resend. A safety change
before acceptance moves the exact Run to `waiting/network_recovery_blocked`; its ordinary exact Run Stop remains
available. Core restart does not reconstruct attempt/deadline or promise cross-generation automatic recovery.

Only the current recovery epoch's accepted ACK clears the network failure cycle. Host/Session creation or a successful
socket connection is insufficient. Normal terminal, exact Stop and invalidation clear the in-memory entry through their
ordinary lifecycle.

## Projection and evidence

Read Side reuses the same AgentRun: waiting shows “连接中断，等待恢复”, a new pre-acceptance epoch shows “正在恢复”,
and a safety-blocked state shows “自动恢复已停止”. Raw protocol payload, credentials and unbounded errors never enter
the projection. Logs remain limited to Run, epoch, source, attempt, delay, category and admission/stop code.

## References

- [Network Interruption Recovery v1 (historical)](network-interruption-recovery-v1.md)
- [Accepted Input Recovery v6](accepted-input-recovery-v6.md)
- [AgentRun Recovery architecture](../architecture/agent-run-recovery.md)

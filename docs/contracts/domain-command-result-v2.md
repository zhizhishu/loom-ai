---
document_type: protocol-contract
contract: domain-command-result-v2
authority: command-result-persistence-replay-and-event-projection
status: accepted
version: 2
last_updated: 2026-10-12
---

# Domain Command Result v2

Inherits the single stored result body, event projection and transaction rules from
[v1](domain-command-result-v1.md), replacing request content fingerprinting with existing
command identity and scope.

The primary lookup remains `commandId`. A repeated ID returns its first committed result
only within the same command type, actor type/ID, Camp and source AgentRun. These fields are
compared directly. Changed payload, expected versions or execution epoch under that same
identity do not create a second operation; a new operation needs a new command ID.

Private draft commands also store the existing Host-verified editor ID in `command_client_id`
and compare it directly on replay. This preserves the existing editor boundary without hashing
the body. Historical rows have no separately stored editor ID and use their stored actor/Camp
scope; migration does not reconstruct identity from retired digests.

New commands still pass the handler's current permissions, epoch and domain checks. Applied,
accepted and rejected results remain queryable through `commands.reconcile`; handler errors
roll back. Stored status, code, payload, result entity and timestamp are unchanged. The result
API no longer emits `requestDigest` or `requestDigestVersion`. There is no request hashing,
new retry policy, retention schedule or second result store.

Migration 196/schema 146 removes the digest requirements from the command-result row check.
Old result rows and digests remain intact and readable; new rows leave those two columns NULL.
The existing withdrawal path clears both legacy digests along with its existing erased payload.
Normal startup neither prunes results nor reconstructs an old result from current business state.

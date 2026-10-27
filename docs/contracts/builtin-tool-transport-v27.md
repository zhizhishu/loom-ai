---
document_type: protocol-contract
contract: builtin-tool-transport-v27
authority: builtin-tool-transport
status: accepted
version: 27
last_updated: 2026-09-18
---

# Built-in Tool Transport v27

Inherits [v26](builtin-tool-transport-v26.md), including authentication, execution fencing, command replay,
IPC 2, Envelope 1, receipt 1, Agent Output Projection 3 and the three Mission operations. Contract and CLI
command versions are 27; Runtime capability is `builtin_cli.transport.v27`.

The closed `mission.get` result adds Mission attachment source paths:

| CLI | Input | Output |
| --- | --- | --- |
| `rovai mission get` | `{}` | `{missionId,title,description,status,sourceMessageId,attachments}` |

`attachments` is required and has schema `string[]`; an empty Mission returns `[]`. Values are current
Mission attachment source paths with the semantics and authorization in [Mission v2](mission-v2.md).
The canonical result and Agent output use the same shape. Missing `attachments`, a non-array value, or a
non-string item fails the closed output contract with the existing non-retryable
`builtin_tool.output_contract_mismatch` projection.

The catalog description, result schema and digest change atomically with the Core result. Built-in invocation
evidence intentionally continues to omit attachment paths.

v27 also removes `rovai gather` and all Gather schemas, help and capability entries. Multi-target collaboration
uses ordinary `rovai send --to … --to …`; replies are ordinary public messages and are never intercepted by a
Core-owned barrier or completion operation.

Rovai-owned request, response, CLI reader and Runtime adapter layers do not impose the former common 1/8/16 MiB
logical-result limits. A successful Agent-facing call contains the complete logical result. Serialization or
transport interruption is an explicit failure, never `success + truncated`. Internal bounded buffers, chunked
I/O, backpressure and managed spooling are allowed without changing the output schema or requiring an
Agent-visible `blobRef`, preview or continuation call.

On the CLI receive path, one explicit projection entry point performs the complete Envelope validation exactly
once, including version, operation, result/error exclusivity and receipt consistency. Canonical-result checks
borrow the parsed result tree, and projections that preserve the business shape consume that owned tree; operations
that intentionally remove or reshape fields retain their operation-specific projection. These ownership rules do
not weaken Core input authorization, lease fencing, construction-time validation, or receipt verification.

Replay returns the first complete, finalized result. Evidence stores that result or an integrity-preserving
managed identity with byte length and digest. An interrupted transport for an effectful command does not prove
that the business operation did not occur; existing idempotency and effect-recovery rules still apply.

Bundled CLI and Core advertise only v27 together; v26 remains historical and there is no mixed v26/v27 mode.
The public Session Charter revision is 8. Single Chat policy remains closed and otherwise unchanged.

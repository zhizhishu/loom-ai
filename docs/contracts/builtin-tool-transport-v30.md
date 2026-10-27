---
document_type: protocol-contract
contract: builtin-tool-transport-v30
authority: builtin-tool-transport
status: accepted
version: 30
last_updated: 2026-09-20
---

# Built-in Tool Transport v30

v30 inherits [v29](builtin-tool-transport-v29.md), including its 26 operations, IPC 2, Envelope 1, receipt 1,
Agent Output Projection 3, Mission global reads, complete logical results and closed request/result schemas.
Contract and CLI command versions are 30; Runtime capability is `builtin_cli.transport.v30`.

`mission.status` retains the same input and result shapes, but its catalog now describes `sourceMessageId` as an
optional reference for every status under [Mission v6](mission-v6.md). Exact CLI help includes
`rovai mission status --status needs_you` without a source message. The current error catalog removes
`mission.source_message_required`, retains `mission.invalid_source_message` with `fix_input`, and the Router
derives the actual invocation recovery from that operation catalog so emitted errors cannot drift to `stop`.

The public Session Charter remains revision 10, including the Mission-only full-definition completion guidance.
Native Session Bootstrap stays v3, Bootstrap Formatter stays 3,
public ContextManifest/Formatter stay 27 with Delivery Profile 8, Single Chat ContextManifest/Formatter stay 25,
and IPC, Envelope, receipt and Agent Output Projection versions do not change. No database migration or
operation-count change is introduced. Bundled CLI and Core advertise only v30 together; v29 remains historical
and there is no mixed v29/v30 mode.

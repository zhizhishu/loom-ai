---
document_type: protocol-contract
contract: builtin-tool-transport-v29
authority: builtin-tool-transport
status: accepted
version: 29
last_updated: 2026-09-19
---

# Built-in Tool Transport v29

v29 inherits [v28](builtin-tool-transport-v28.md), including IPC 2, Envelope 1, receipt 1, Agent Output
Projection 3, complete logical results and closed request/result schemas. Contract and CLI command versions are
29; Runtime capability is `builtin_cli.transport.v29`.

The catalog adds `mission.list` and replaces `mission.get` with the optional opaque internal `missionId` selector
and the structured attachment result from [Mission v5](mission-v5.md). `mission.update/status` keep their request
shape and return the same internal `rvm_...` IDs used by relations and model context. The CLI root directory,
generated exact help, flag mapping, output validation, evidence projection, error catalog and operation identity
list rotate atomically with Core.

The complete catalog contains 26 operations. Public Native Sessions can discover
`mission list|get|update|status`; Single Chat operation-policy version 2 exposes only `mission.list/get` alongside
its existing history reads. Read errors use correctable-input recovery for invalid filters, cursors, explicit
misses and a missing current Mission. Mutation authority and terminal recovery remain unchanged.

The current public Session Charter revision is 10. Revision 10 changes only the Mission-specific completion
guidance and does not change this catalog or transport. Native Session Bootstrap stays v3, Bootstrap Formatter stays 3,
public ContextManifest/Formatter stay 26, Single Chat ContextManifest/Formatter stay 25, and IPC, Envelope,
receipt and Agent Output Projection versions do not change. Bundled CLI and Core advertise only v29 together;
v28 remains historical and there is no mixed v28/v29 mode.

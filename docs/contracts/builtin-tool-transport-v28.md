---
document_type: protocol-contract
contract: builtin-tool-transport-v28
authority: builtin-tool-transport
status: accepted
version: 28
last_updated: 2026-09-19
---

# Built-in Tool Transport v28

v28 inherits [v27](builtin-tool-transport-v27.md), including IPC 2, Envelope 1, receipt 1, Agent Output
Projection 3, complete logical results and all closed request/result schemas. Contract and CLI command versions
are 28; Runtime capability is `builtin_cli.transport.v28`.

The operation catalog now describes the public read scope from [Camp History v8](camp-history-v8.md): target-Camp
membership is not a permission for `camp.list`, `camp.search`, `camp.read` or `history.search`. `mission.get`
is explicitly read-only under [Mission v4](mission-v4.md); `mission.update` and `mission.status` retain mutation
authorization. The catalog text and digest change atomically with Core and the bundled CLI.

CLI help for an explicit `campId` names any extant public Camp rather than an "authorized" Camp. The
ContextManifest catalog is a discovery/temporal aid and never an ACL; `camp.read` directly resolves the target
under its live-read contract.

The public Session Charter remains byte-identical at revision 8; Bootstrap, Dynamic Context, Formatter and
ContextManifest versions are unchanged. Bundled CLI and Core advertise only v28 together; v27 remains historical
and there is no mixed v27/v28 mode. No wire schema or database migration changes in this version.

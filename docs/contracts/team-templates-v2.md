---
document_type: protocol-contract
contract: team-templates-v2
status: accepted
version: 2
source_version: v1.72
last_updated: 2026-10-26
---

# Team Templates v2

Inherits [Team Templates v1](team-templates-v1.md), except that Mission creation now accepts the same optional
Team selection as ordinary Thread creation. [Mission v13](mission-v13.md) owns that command extension and
the union with structured description mentions. Custom and legacy callers still omit the selection.

Team validation, CAS, shared defaults, events and immutable Thread guidance are unchanged. Mission creation
reuses the existing Thread transaction and Bootstrap path; no Team/Mission relationship table or additional
context field is introduced. General's default source initializes either creation dialog. Only the existing
General/ordinary-conversation preference actions write one-click defaults; creating a Mission never does so.

---
document_type: protocol-contract
contract: mission-v4
authority: mission-read-and-mutation-authorization
status: accepted
version: 4
last_updated: 2026-09-19
---

# Mission v4

Mission v4 inherits [Mission v3](mission-v3.md) identity, definition, status, attachments, cumulative Diff,
workspace reuse, cleanup and deletion semantics. It separates the read-only Agent operation from mutation
authorization.

`mission.get` reads the Mission attached to the authenticated Run's current public Camp and returns the existing
`MissionAgentInfo` projection, including ordered attachment source paths. It does not call the Camp mutation
authorization gate and grants no write authority. The Built-in binding must still authenticate an effective
running teammate identity; this change does not expose an arbitrary `missionId` selector or private Runtime data.

`mission.update` and `mission.status` continue to require the current active Camp membership, exact Run/epoch
fence and all existing field/status validation. Reading a Mission never proves authority to mutate it.

The public Session Charter remains byte-identical at revision 8; the existing text already lists all three
Mission operations and does not define their internal authorization gate. No database migration, Native Session
rotation or historical data rewrite is required.

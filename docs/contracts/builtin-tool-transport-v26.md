---
document_type: protocol-contract
contract: builtin-tool-transport-v26
authority: builtin-tool-transport
status: accepted
version: 26
last_updated: 2026-09-16
---

# Built-in Tool Transport v26

Inherits [v25](builtin-tool-transport-v25.md), including Agent source-path publication, the default output
location and historical attachment read routing. Authentication, fencing, command replay, IPC 2, Envelope 1
and command receipts are unchanged. Contract / CLI command version is 26; Runtime capability is
`builtin_cli.transport.v26`. Agent Output Projection 3 remains current. The catalog adds three closed Mission operations:

| CLI | Input | Output |
| --- | --- | --- |
| `rovai mission get` | `{}` | `{missionId,title,description,status,sourceMessageId}` |
| `rovai mission update` | `{title?,description?}`, at least one | `{missionId,changed}` |
| `rovai mission status` | `{status,sourceMessageId?}` | `{missionId,changed}` |

All operations resolve only the authenticated current public Camp's Mission. Inputs never accept Mission
ID, workspace or version. Current members, including non-leads, may edit; removed/stale membership and
private Single Chat are rejected. Status is a four-value enum. For Agent `needs_you`/`completed`, sourceMessageId
must identify an already published, non-tombstoned public explanation in that Camp. Field limits and status,
no-op and retry behavior are owned by [Mission v1](mission-v1.md). Editing never schedules or stops a Run.

The existing CLI input-source, help, error and unknown-outcome recovery contracts apply. `cli-operations`
routes Mission separately from Task and points to operation help; it does not require repetitive reads.

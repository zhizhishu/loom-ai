---
document_type: protocol-contract
contract: mission-v2
authority: mission-lifecycle-workspace-and-delivery
status: accepted
version: 2
last_updated: 2026-09-17
---

# Mission v2

Mission v2 inherits [Mission v1](mission-v1.md) in full except for the Agent attachment-read projection
defined below. Identity, lifecycle, status, source-message validation, optimistic user editing, workspace
preparation, cumulative Git changes, cleanup, database schema and Renderer/Web commands are unchanged.

## Agent attachment-read projection

The authenticated current public Camp's `rovai mission get` result is:

```ts
type MissionAgentInfo = {
  missionId: string
  title: string
  description: string
  status: 'needs_you' | 'not_started' | 'in_progress' | 'completed'
  sourceMessageId: string | null
  attachments: string[]
}
```

`attachments` is always present and is `[]` when the current Mission has no source attachments. Each
item is the stored original absolute `sourcePath` of a file or directory, in current Mission-definition
order. Removing an attachment removes its path from subsequent reads; adding an attachment makes its path
visible after the definition transaction commits.

The read does not stat, enumerate, copy, move, rewrite or otherwise validate a source. A moved, deleted,
kind-changed or newly unreadable source therefore retains its stored path in `mission get`; a later file
operation reports its own failure. The result does not expose attachment IDs, display names, kinds, sizes,
availability or the internal `detailsVersion`.

Core constructs this result through a dedicated Agent projection over `MissionRecord.info` and
`MissionRecord.source_attachments`. The shared `MissionInfo`, `LocalAttachmentSourceView`, Desktop/Web
`missions.get`, activity, domain events, logs, errors and Built-in invocation evidence remain path-free.
This locally replaces v1's statement that raw Mission paths are always Core-private; disclosure is limited
to this authenticated Agent read seam.

Authorization is unchanged: the caller must be the attested current AgentRun of an active member in the
current public Mission Camp. The input stays the closed object `{}` and accepts no Mission, Camp, path or
version selector. Single Chat, ordinary Camp, removed membership and stale execution remain rejected.
The read is still side-effect free and does not acknowledge `updateNotice` or advance accepted-delivery
watermarks. Agent mutation still cannot add or remove Mission attachments.

The wire and catalog are owned by [Built-in Tool Transport v27](builtin-tool-transport-v27.md). Migration
161/schema 111 already stores the source refs, so v2 adds no database migration and does not rewrite frozen
Runtime inputs or historical Mission records.

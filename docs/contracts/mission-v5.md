---
document_type: protocol-contract
contract: mission-v5
authority: mission-agent-read-and-mutation
status: accepted
version: 5
last_updated: 2026-09-19
---

# Mission v5

Mission v5 inherits [Mission v4](mission-v4.md) definition, status, workspace, cumulative Diff, cleanup and
deletion semantics. It adds the global Agent read protocol, makes the existing internal `rvm_...` primary key the
single program/model identifier, and preserves current-Mission-only mutation.

## Agent-facing identity

Database relations, internal events, Agent Mission operations and newly generated Run Facts all carry the same
opaque internal `rvm_...` primary key. Agent-facing results contain only `missionId`; they do not add `number` or
`displayId`, and Core performs no conversion between an Agent ID and a display number. Models normally copy and
pass this opaque value rather than deriving or remembering it.

The immutable positive `MissionRecord.number` remains a UI and managed-workspace concern. Renderer formats it as
`M-001`, `M-999` or `M-1000`; Agent selectors and model context never use that display form. Deleted numbers are
not reused. Frozen historical context and evidence bytes are never rewritten, and Mission descriptions or
attachment paths are never string-replaced.

## Read operations

All effective authenticated AgentRuns may use both reads across all extant Missions in the Rovai instance. The
target Mission's Camp membership is not a read ACL.

```ts
type MissionStatus = 'not_started' | 'in_progress' | 'needs_you' | 'completed'

type MissionGetInput = {
  missionId?: string
}

type MissionAttachment = {
  attachmentId: string
  name: string
  kind: 'file' | 'directory'
  fileCount: number | null
  mediaType: string | null
  byteSize: number | null
  path: string
}

type MissionGetResult = {
  missionId: string
  title: string
  description: string
  status: MissionStatus
  sourceMessageId: string | null
  attachments: MissionAttachment[]
}
```

Omitting `missionId` resolves only the authenticated Run's current Camp association. A Camp without a Mission
returns `mission.current_unavailable`; an explicit missing identity returns `mission.not_found` and never falls
back. Reading does not switch context, join a Camp, start work, change cwd or state, or advance a read watermark.

Attachments preserve definition order and saved identity/name/metadata. Files have `fileCount: 1`; a directory
without a stored count and any unknown metadata use `null`, never a fabricated zero. `path` is the registered
absolute source path and is required for every Agent. `mission.get` performs no filesystem existence check,
directory scan, copy or metadata refresh; a moved or deleted source therefore does not make the definition read
fail.

```ts
type MissionListInput = {
  query?: string
  status?: MissionStatus
  limit?: number
  cursor?: string
}

type MissionListResult = {
  missions: Array<{
    missionId: string
    campId: string
    title: string
    status: MissionStatus
    updatedAt: string
  }>
  nextCursor: string | null
  hasMore: boolean
}
```

`mission.list` reads only the listed summary columns. `query` matches a title substring or an exact internal
Mission ID; absent `status` includes every status. `limit` defaults to 20 and is bounded to 1–50. Ordering is
Mission number descending, but the number is not returned. Pagination uses an opaque last-number cursor bound to
the original query and status; a malformed or mismatched cursor returns `mission.invalid_cursor`. Pagination is live and is not a transaction
snapshot. Empty results are `{missions: [], nextCursor: null, hasMore: false}`. Unstarted, message-free, Run-free
and completed Missions remain discoverable; deleted Missions do not.

## Authorization and mutation

Both reads reuse exact Run, epoch, lease and Native Binding authentication, but do not call the target Camp's
mutation gate or use ContextManifest discovery as an ACL. Single Chat operation-policy version 2 permits only
`mission.list` and `mission.get` in addition to its existing reads.

`mission.update` and `mission.status` retain their existing current public Camp selector and membership/write
gate. They do not accept `missionId`; reading another Mission cannot redirect either mutation. Their successful
Agent results return the current Mission's internal `rvm_...` identity. `needs_you` and `completed` retain the
existing public `sourceMessageId` requirement.

Invalid list inputs and cursors are correctable-input errors; an explicit unknown ID returns `mission.not_found`.
Authentication failures remain terminal.
`mission.current_unavailable` is correctable for reads because the caller may provide an ID or list Missions;
it remains terminal for current-Mission-only mutation.

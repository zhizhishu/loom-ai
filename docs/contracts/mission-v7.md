---
document_type: protocol-contract
contract: mission-v7
authority: mission-workspace-asynchronous-cleanup
status: accepted
version: 7
last_updated: 2026-09-20
---

# Mission v7

Mission v7 inherits [Mission v6](mission-v6.md) identity, definition, global read, current-Mission mutation,
optional status-source association, attachment, workspace preparation and cumulative Diff semantics. It replaces
the inherited foreground workspace-cleanup and delete-before-cleanup ordering with a durable asynchronous cleanup
intent. No database migration is required; the existing workspace state, command identity, expected branch OID
and two step checkpoints remain the authoritative recovery record.

## Standalone cleanup

`missions.workspace.cleanup` remains a user Domain Command with `{ missionId }`. Under the workspace preparation
fence, Core rechecks Mission/workspace existence, current execution Host and related Run occupancy. A valid
`ready` or explicitly retried `cleanup_failed` row is changed to `cleanup_pending`, receives the command identity,
clears its diagnostic and durably commits with the command result. The applied result code is
`mission.workspace_cleanup_scheduled`; it means the intent is durable, not that either Git resource has already
been removed. A second request while the row is pending is rejected with
`mission.workspace_cleanup_pending`.

After commit, an in-process notification wakes one serialized cleanup worker. A fixed maintenance pass is only
a missed-notification/crash fallback for unfinished `cleanup_pending` rows. It never automatically retries
`cleanup_failed`. Workspace preparation sees the pending/failed row and cannot reuse that exact workspace, while
ordinary Mission/Camp operations and preparation for other workspaces do not wait for the Git process.

The worker preserves the exact two-step safety protocol:

1. verify the owned worktree, registration and interrupted staging root; read and persist the expected local
   branch OID before the first destructive step; remove the verified Worktree resources and checkpoint
   `cleanup_worktree_removed`;
2. skip step 1 on retry, reject a branch used by another worktree, conditionally delete the exact branch at the
   persisted OID and checkpoint `cleanup_branch_removed`.

An already absent owned resource remains idempotent success. A failure sets `cleanup_failed` with the diagnostic
and retains both checkpoints. An explicit retry returns the same row to `cleanup_pending`, clears the diagnostic
and executes only unfinished steps. When both checkpoints are true, a live Mission keeps the row for future
workspace reconstruction and projects cleanup as complete.

The path-free Renderer `MissionRecord` projection adds the optional field:

```ts
workspaceCleanup?: {
  state: 'cleaning' | 'failed' | 'cleaned'
  worktreeRemoved: boolean
  branchRemoved: boolean
  diagnostic: string | null
}
```

`cleanupAvailable` is true only for an idle `ready` workspace. Pending, failed and completed cleanup never expose
the context-menu action. `MissionWorkspace` delivery/orphan projections additionally expose
`cleanupWorktreeRemoved` and `cleanupBranchRemoved`; cleanup command identity and expected OID stay private.

Renderer closes the confirmation dialog after the scheduling command commits. The card then owns a distinct
resource-status row: progress while pending, persistent failure plus `查看`, or a local success acknowledgement
for about four seconds. Persisted `cleaned` is still shown in Mission details, but a refresh or later board entry
does not replay card success. A projection refresh error is reported as a refresh problem and cannot turn a
scheduled or completed cleanup into another state.

When Core projects `cleanup_failed`, Renderer keeps the card error after the error Toast expires. The Toast names
the Mission and provides `查看`; details show the diagnostic, exact path/branch, both actual checkpoints and one
retry action. If only branch deletion failed, presentation says `分支清理失败` and retry does not claim to restore
the already removed Worktree.

## Mission deletion

`camps.delete` keeps `workspaceDisposition: 'retain' | 'cleanup'` and defaults to `retain`. With `cleanup`, the same
transaction that removes the Camp/Mission first changes every unfinished owned workspace row to
`cleanup_pending` and durably records cleanup intent. Only an applied delete result removes the card; filesystem
cleanup is not part of command latency and a later failure never restores the Camp or Mission.

A completed orphan row is removed. An unfinished deleted-Mission row stays outside the Camp aggregate, runs
through the same two checkpoints and is deleted after success. Failure remains in `missions.cleanup.list`, raises
the ordinary actionable error Toast during the observing session, and uses the existing `工作区待清理` route for
actual-state inspection and explicit retry. Retained resources never enter this route. To preserve the meaning
of `retain`, deletion with `retain` is rejected while standalone cleanup is actively pending; after a failure it
may retain the resources that actually remain.

No percentage, countdown, pause control, replacement task center, backup or undelete promise is introduced.
Mission business status, card style hierarchy and ordinary execution state remain independent of resource
cleanup.

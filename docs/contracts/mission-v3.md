---
document_type: protocol-contract
contract: mission-v3
authority: mission-workspace-reuse-cleanup-and-deletion
status: accepted
version: 3
last_updated: 2026-09-19
---

# Mission v3

Mission v3 inherits [Mission v2](mission-v2.md) in full except for the workspace reuse, explicit cleanup and
Mission deletion rules defined below. Mission identity, definition, status, attachments, cumulative Diff,
Agent input/CLI and authenticated attachment-read projection are unchanged.

## Workspace reuse after explicit cleanup

Core still prepares a Git workspace only when an admitted AgentRun enters preparing. A saved workspace record
is resolved against its actual worktree path and local Mission branch at that boundary:

| Worktree | Mission local branch | Preparing result |
| --- | --- | --- |
| present and valid | present and matching | reuse it and retain the saved `base_sha` |
| absent | present | recreate the worktree from the branch's current commit and retain the saved `base_sha` |
| absent | absent | resolve the source checkout's current `HEAD`, recreate the branch and worktree from that exact commit, and replace `base_sha` |
| present | absent or mismatched | fail explicitly; do not repair or replace it |

Core persists whether an interrupted preparation is creating a branch or restoring an existing one. Preparation
and cleanup share the existing per-Core Mission workspace mutex. An unfinished cleanup blocks a new Run until
the user retries it successfully or deletes the Mission while retaining the resources that still exist.

Workspace recreation does not create a new Native Session, add a workspace-change notice, inject special
context or alter the existing resume fallback. An internal workspace generation may invalidate Diff snapshots
and late asynchronous results only.

## Explicit workspace cleanup

The Mission projection adds three Core-owned booleans:

- `workspaceEverCreated` comes from a persisted workspace record, never Mission business status.
- `workspaceResourcesPresent` is true for an existing record until both managed worktree and branch cleanup
  steps are recorded complete; it is false when no workspace record has ever existed.
- `cleanupAvailable` is true only while managed resources remain on the current execution Host and no related
  AgentRun is queued, preparing, running, waiting/recovering or stopping. Related Runs include the Mission Camp
  and any Run bound to the same execution root.

Renderer shows the right-click action only when `cleanupAvailable` is true. Confirmation invokes the existing
user-command envelope with operation `missions.workspace.cleanup` and command `{ missionId }`. Core acquires the
same workspace mutex used by Run preparation, then rechecks Mission existence, Host identity, workspace
ownership, current branch identity and all related Run occupancy.

Cleanup has exactly two durable steps: remove the verified worktree/registration, then remove the recorded local
Mission branch. Core stores the cleanup command identity, each completed step and the branch's expected OID in
the existing workspace record. Branch deletion is conditional on that OID; a changed branch or a branch checked
out by another worktree stops the command. A failure retains the Mission and exact partial result for an explicit
retry from the same action. There is no background retry, backup, retained-workspace manager or dirty/untracked
file blocker. Successful standalone cleanup retains the Mission; the next actual Run follows the preparation
table above.

The foreground path validates each required fact once before its corresponding destructive step. On the first
attempt Core verifies the exact path, repository, owner marker and branch ownership, reads the branch OID once,
and persists it before removing the worktree. A retry reuses that persisted expected OID, and a completed
worktree checkpoint skips the worktree verification/removal step. After worktree removal, Core checks that no
other worktree uses the branch and performs one expected-OID `update-ref -d`; it does not surround the delete
with duplicate branch-OID reads. Already absent owned resources are idempotent success, including a retry after
the ref was deleted but before its checkpoint was recorded. Ownership proof still limits stale-registration and
interrupted-staging cleanup to this Mission's exact resources.

The dialog is named `清理使命 Worktree`, says `将删除此使命的 Worktree 和本地分支。`, may list the path and
branch, and has only `取消` and the neutral `清理` action. This is an intentional Mission-specific presentation
choice; the ownership, occupancy and expected-OID correctness checks remain authoritative. Once
`missions.workspace.cleanup` succeeds, Renderer closes the dialog immediately and refreshes the Mission list
and current Camp asynchronously. A later refresh failure is reported as a separate refresh problem and never
turns the completed cleanup into a failed dialog result.

## Mission deletion

Mission deletion continues to use `camps.delete`, whose command adds:

```ts
workspaceDisposition?: 'retain' | 'cleanup'
```

The omitted/default value is `retain`. The delete dialog shows `同时清理 Worktree 及本地分支` only when a
workspace record has existed, leaves it unchecked by default, and explains through the adjacent help control:
`未勾选时，Worktree 和本地分支保留在原位置。`

With `retain`, Camp/Mission deletion leaves the actual worktree and branch where they are. Rovai does not queue,
surface or later maintain that retained workspace. With `cleanup`, Core first uses the existing forced-settlement
flow to stop related execution, then completes both cleanup steps; only a successful cleanup permits Camp,
Mission, conversation and normal Camp-owned data deletion. Cleanup failure keeps the Mission available for
retry and never reports the whole deletion as successful.

Migration 162/schema 112 adds the preparation mode, workspace generation and minimal cleanup checkpoint fields
to the existing `mission_workspace` table. It removes the legacy Camp-delete trigger that unconditionally queued
Mission workspace cleanup. Historical orphan rows already in `cleanup_pending` or `cleanup_failed` remain under
the old recovery route; newly retained rows are not enrolled in it.

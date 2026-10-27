---
document_type: protocol-contract
contract: mission-v10
authority: mission-worktree-safe-cleanup
status: accepted
version: 10
last_updated: 2026-09-20
---

# Mission v10

Mission v10 inherits [Mission v9](mission-v9.md) identity, definition, status, attachment, start availability,
execution admission, checkout observation and dynamic cumulative-Diff semantics. It replaces v9's cleanup rule
that required the owned Worktree to remain on `managedBranch`.

No database or Renderer wire migration is introduced. `mission_workspace.branch` remains the only persisted
managed-branch identity and is still exposed as `managedBranch`; current checkout remains an ephemeral observation.

## Independent Worktree and branch ownership

A Mission owns two independently verified resources:

1. the Worktree directory identified by its canonical path, repository common directory, exact Git registration,
   Rovai owner marker, execution Host and persisted preparation token;
2. the local `managedBranch`, identified by its stored full reference and the expected OID captured for the cleanup
   attempt.

Changing the Worktree's current checkout does not change either identity. Cleanup may remove the verified Worktree
while it is on another named branch, but it never adopts, rewrites or deletes that current branch. The branch step
continues to target only `managedBranch`. If that managed reference was already deleted or renamed before its OID
was captured, the branch step is complete; a renamed branch is not discovered or taken over.

If the managed reference exists, the first attempt records its OID before destructive work. Every partial retry
reuses that recorded OID. Branch occupancy and conditional `update-ref` deletion remain mandatory; a changed or
in-use managed branch stays preserved. Missing after a prior conditional deletion is an idempotent completed step.

## Worktree removal safety

Ordinary cleanup performs these checks before removing the formal Worktree:

- the path, repository, registration, owner marker, execution Host and active-use fences still match;
- staged, unstaged and untracked user changes are absent;
- if `HEAD` is detached, its commit is reachable from an existing persistent Git reference other than the managed
  branch that this cleanup may delete.

A dirty Worktree is rejected with `mission.workspace_dirty`. An otherwise clean detached commit without a retained
reference is rejected with `mission.detached_head_unreachable`. Core never auto-stashes, commits, resets, cleans,
switches branches or creates a preservation branch. Formal Worktree removal uses ordinary `git worktree remove`,
without `--force`, so a change arriving after preflight still fails closed and preserves the directory.

Preparation staging remains a separate rollback boundary. An incomplete staging checkout must still match the
managed branch and may use the existing forceful rollback after its private staging owner is verified; this does not
widen deletion of a completed user-facing Worktree.

When the formal directory is already absent, cleanup may remove only an exact stale registration whose owner marker
and `gitdir` path match this Mission. The registration's current `HEAD` is not an ownership signal and need not still
name `managedBranch`. Other registrations and Worktrees remain untouched.

## Refusal and failed-state recovery

When a refusal such as dirty content or an unreferenced detached commit is observable before intent persistence,
`missions.workspace.cleanup` returns a rejected command and leaves a ready workspace ready. If the same refusal is
observed by the worker after intent persistence, Core audits the real filesystem result. Only when the complete
owned Worktree, registration, marker and execution directory are still intact, and the Mission still exists, may
Core end that attempt by returning the workspace to `ready` and clearing the cleanup attempt fields.

The same intact-resource audit may recover a legacy `cleanup_failed` row at an explicit cleanup retry or the next
execution preparation. Boolean checkpoints alone never prove that removal did not happen. A missing directory,
missing or mismatched registration/marker, completed Worktree step, deleted Mission, or otherwise uncertain/partial
result remains `cleanup_failed` and retries only unfinished steps with the original expected OID.

After a non-destructive refusal, the Mission remains executable and its cumulative changes remain readable. A Git
Mission whose workspace has never been prepared has no cumulative-change surface; `missions.changes` retains its
`mission.workspace_not_prepared` operation error for direct callers.

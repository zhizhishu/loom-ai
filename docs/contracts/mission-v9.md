---
document_type: protocol-contract
contract: mission-v9
authority: mission-worktree-checkout-observation
status: accepted
version: 9
last_updated: 2026-09-20
---

# Mission v9

Mission v9 inherits [Mission v8](mission-v8.md) identity, definition, status, attachment, start availability,
execution projection, workspace and asynchronous cleanup semantics. It replaces the inherited assumption that a
persistent Mission Worktree must remain on its original local branch, and replaces the cumulative-Diff read
session that retained a temporary index.

No database migration is introduced. The existing `mission_workspace.branch` column remains the single persisted
managed-resource identity. Renderer-facing workspace projections expose that value as `managedBranch`; no current
checkout value is written back to it.

## Execution workspace admission

A Mission remains bound to its owned persistent Worktree. Reusing an existing Worktree validates its canonical
path, repository common directory, Git worktree registration, Rovai owner marker, execution subdirectory and Host
ownership. Failure to prove any of those properties rejects execution.

The current checkout is not execution admission. The following observations cannot by themselves reject a new or
continued Run while the owned Worktree remains valid:

- current branch differs from `managedBranch`;
- `managedBranch` was renamed or deleted;
- `HEAD` is detached;
- branch name or `HEAD` observation is unavailable;
- the recorded `baseSha` cannot currently be resolved for Diff.

Preparation therefore does not resolve the managed branch OID or Diff base before accepting an existing valid
Worktree. This rule does not weaken restoration when the Worktree itself is absent, repository/path ownership,
permissions, execution occupancy or cleanup fencing. Rovai does not switch branches, recreate a valid Worktree,
adopt the current branch or rewrite `baseSha` in response to checkout changes.

## Current checkout and cumulative changes

Current checkout is an ephemeral observation:

```ts
type CheckoutState =
  | { kind: 'branch'; branch: string; head: string }
  | { kind: 'detached'; head: string }
  | { kind: 'unavailable' }
```

`missions.changes({ missionId })` returns one current-workspace view:

```ts
interface MissionWorkspaceChangesView {
  checkoutState: CheckoutState
  viewId: string | null
  files: MissionChangedFile[] | null
  diffError: string | null
}
```

Core validates the execution workspace, observes checkout, and then prepares the change list. A Diff-specific
failure such as an unavailable `baseSha` preserves the successfully observed `checkoutState`, returns `viewId` and
`files` as `null`, and describes the failure in `diffError`; it does not change Runtime admission. A non-Git
project or an untrusted workspace remains an operation error.

The comparison remains fixed:

```text
left:  recorded baseSha
right: current Worktree content
```

The right side includes committed changes after the fixed base, staged and unstaged changes, and untracked files
under the existing ignore rules. Core uses a private temporary index and never mutates the real index, creates a
commit, changes checkout or advances the fixed base.

`viewId` is a bounded, expiring, process-local request-association handle. It is neither a persisted snapshot ID
nor proof that file content has not changed. `missions.fileDiff({ missionId, fileId, viewId })` resolves the
associated list metadata, creates a fresh temporary index, rereads the current checkout and change list, and
returns the current path-scoped Diff only while the requested file still belongs to that view. Otherwise it
rejects with `mission.changes_refresh_required`. Multiple outstanding view handles may coexist so an older list
request that finishes late cannot replace or invalidate a newer association. Closing the activity or cleanup
releases the Mission's handles.

This is a dynamic view, not an atomic filesystem snapshot. Renderer commits `checkoutState` and `files` from the
same `missions.changes` response, clears file-detail state when refreshing, and discards superseded list and file
responses. Existing activity-open, window-focus, Run-terminal and explicit-refresh paths reread the view; no
branch watcher, polling state machine, content hash, persistent history or workspace generation service is added.

## Managed cleanup boundary

Cleanup continues to target `managedBranch` and its expected OID. The observed checkout never changes resource
ownership. If the owned Worktree currently checks out another branch or detached `HEAD`, verification fails before
removal with `mission.workspace_branch_mismatch`; Core preserves the Worktree, current branch and unsaved content.
It does not switch back, adopt or delete the current branch. Existing registration, owner, Host, checkpoint,
branch-use and expected-OID protections remain unchanged.

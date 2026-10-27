---
document_type: protocol-contract
contract: mission-v11
authority: mission-worktree-bounded-cleanup
status: accepted
version: 11
last_updated: 2026-09-20
---

# Mission v11

Mission v11 inherits [Mission v10](mission-v10.md) identity, definition, status, attachment, execution,
checkout, cumulative-Diff and independent resource-ownership semantics. It replaces v10's duplicated cleanup
preflight and synchronous refusal result with one bounded asynchronous cleanup path.

No database, Migration or Renderer wire change is introduced. Existing workspace state, diagnostic, expected-OID
and two checkpoint fields remain authoritative.

## Admission and asynchronous result

`missions.workspace.cleanup` performs only command authorization, persisted-state, execution-occupancy and
idempotency checks before recording cleanup intent and queuing the worker. It does not repeat filesystem or Git
safety observation in the request path. Acceptance therefore reports that cleanup was scheduled, not that resource
deletion succeeded.

The worker owns the single destructive safety decision. A refusal that proves the complete owned Worktree remains
intact returns the workspace to usable `ready`, clears attempt-only expected-OID and checkpoint fields, and retains a
path-free diagnostic. Mission projection exposes that diagnostic as a failed cleanup result while leaving cleanup
available, and Activity presents the reason and an explicit retry action. Cumulative changes remain readable.

An uncertain command failure, ownership mismatch after removal starts, missing resource, or partial result remains
`cleanup_failed`. Core never converts uncertainty into `ready`, and a retry resumes only unfinished checkpoints.

## Bounded normal Git path

For a present, clean, attached Worktree whose managed branch exists and is not occupied elsewhere, successful
cleanup launches at most four Git processes:

1. one `rev-parse` observation obtains the canonical Worktree root, administrative directory, common directory,
   Worktree `HEAD`, managed-branch OID and actual checkout;
2. one non-force `worktree remove` removes the verified directory;
3. one `worktree list --porcelain -z` proves the managed branch is not checked out elsewhere;
4. one `update-ref --no-deref -d <full-ref> <expected-oid>` conditionally deletes only that exact branch value.

Core does not run `git status` on this normal path. The non-force removal is the authoritative concurrent-dirtiness
fence. Its stable dirty refusal is accepted as safe only when the Worktree identity can still be proven intact;
otherwise the result is uncertain and remains failed. Missing managed branches, detached checkout reachability,
stale registrations, incomplete staging, retries after checkpoints and command failures are exceptional paths and
may perform additional diagnostic calls without weakening ownership checks.

The managed-branch OID is persisted before Worktree removal and reused on every retry. The Worktree checkpoint is
persisted before branch occupancy and conditional deletion begin. A changed OID, another Worktree occupant, named
non-managed checkout, detached checkout, missing managed branch and stale registration retain Mission v10 safety
semantics.

## Timing evidence

Cleanup emits structured stage timings for request-to-queue, identity and safety, Worktree removal, branch
check/deletion, result publication and total worker duration. Timing logs are observational and do not change command
results, checkpoints or recovery authority.

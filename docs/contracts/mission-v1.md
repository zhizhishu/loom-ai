---
document_type: protocol-contract
contract: mission-v1
authority: mission-lifecycle-workspace-and-delivery
status: accepted
version: 1
last_updated: 2026-09-17
---

# Mission v1

## Identity and lifecycle

A Mission owns a stable internal `rvm_<UUIDv7>` identity, one monotonically allocated positive `number`,
and exactly one main public Camp. Numbers are never reused. Renderer formats the number with a minimum
three digits (`M-018`); it does not expose an ID suffix. Its definition is `missionId`, `title`, `description`,
`status`, and nullable `sourceMessageId`. Status is one of
`needs_you`, `not_started`, `in_progress`, `completed`; it is independent of Task and AgentRun status.
The main Camp owns membership, lead, messages, drafts, execution, attachments and unread state.
There is no ordinary-Camp conversion operation. Mission Camps are excluded from ordinary navigation.

Saving atomically creates an active Camp and a `not_started` Mission. It does not create a Run, Git
branch or worktree. Start is a user command: after execution admission it preserves the current Mission
status and persists a public commission message plus a Mission reference, without copying title or description. The
current Mission source attachments are published with that commission message so the admitted lead receives
the same local source references through the existing attachment path.
The commission card resolves the current definition. An already active
queued/running/waiting Run prevents a duplicate commission. A replay uses the same command result.
Ordinary messages retain ordinary input semantics and can schedule Runs without changing Mission status.

All current Camp members and the user may edit title/description/status. There is no lead-only policy
or model-visible revision. Agent patches preserve omitted fields; the last committed Agent edit wins on
a shared field. The Renderer carries an internal `details_version` only for atomic title/description/source-
attachment edits: creation starts at 1, one effective transaction over those fields advances it once, equal values do not,
and a stale user edit is rejected; Renderer reloads the latest Mission projection before an explicit retry. Tags,
status, membership and lead changes do not advance it. The version is absent from MissionInfo, Agent CLI
inputs/results/errors and model context. Definition, tags, roster, lead and status changes do not schedule
or cancel execution. Completed Missions retain their workspaces and running Agents.

Agent transitions to `needs_you` or `completed` require `sourceMessageId`: an existing, non-tombstoned,
durably published message in the same public Camp. Publish the complete explanation first, then set
status using its ID. Retrying status does not require publishing the explanation again. Manual user
status changes may omit the source. Starting, creating a Run, ending a Run, and publishing a message that
mentions the Principal never infer or change Mission status. Status changes never substitute for a public answer.

Title is 1–200 Unicode scalars after trimming; description is at most 12,000. Only their latest values and
current `details_version` are stored. Activity records `titleChanged` / `descriptionChanged` boolean facts,
never historical definition text; creation and start evidence also omit definition bodies. User tags are trimmed,
case-insensitively deduplicated, at most 30 entries and 24 scalars each. User PR associations accept
HTTP(S) URLs without embedded credentials. Other activity retains the minimum status/roster/lead/PR facts
needed for presentation. There is no definition restore path.

A Mission may retain at most ten source attachments using the canonical local source-reference shape. The
public Mission projection exposes only attachment metadata and availability; raw paths remain Core-private.
Desktop create/edit observes new files outside the database lock, then atomically stores the resulting refs
with the Mission command. Edit explicitly lists retained attachment IDs and new refs; unknown, duplicate or
cross-Mission IDs fail closed. Removing a Mission attachment does not rewrite an attachment already published
on an earlier commission message.

## Workspace preparation

Only Core prepares the workspace, when an admitted Run receives an execution opportunity and enters
preparing. Queue admission and context preflight perform no worktree filesystem mutation. The claim
rechecks cancellation, membership, configuration, execution and budget fences after preparation.

For Git projects, the first preparing phase reads the configured directory's current local branch and
current `HEAD` commit. Persist the branch as nullable `base_branch` (null for detached HEAD) and retain the
commit as `base_sha`. Create branch `rovai/mission/<number>` and sibling directory
`<repo>-mission-<number>` from that exact commit with remote guessing disabled, without switching the
source checkout or copying dirty files. Mission creation accepts no starting ref and performs no Git read.
A number below 1000 is zero-padded to three digits; larger numbers are not truncated.
A project subdirectory maps to
the same relative subdirectory in the repository-wide worktree. Parent/child Missions remain siblings.
If either path or branch is occupied, try the paired suffix `-2`, `-3`, etc. A creation race is retried
only when it is a name collision; other errors are explicit.

Persist the plan and an ownership token before Git side effects. Core uses private staging to recover
an interrupted creation and verifies Git common directory, registration, path and its ownership marker
before moving/reusing/removing the worktree. A matching name alone never proves ownership. Subsequent
Runs, recovery and member changes use the recorded path/branch; `base_sha` never moves. A missing or
invalid associated workspace is an error, not an instruction to create another copy.

Non-Git projects use the configured original directory. They have no Mission branch, Git Diff or saved
content baseline. A missing Git executable in a Git project is an explicit failure, not a non-Git fallback.
Every Git command uses the execution Host's resolved absolute executable path.

Mission completion, Run termination and archive keep the workspace. User deletion first settles/stops
users of the Camp, then deletes the Camp/Mission and cleans the verified associated worktree and Git
registration. Branches remain. Independent cleanup records survive cascading deletion and restart;
failures remain visible and retryable. Cleanup never deletes unrelated paths or prunes other registrations.

## Cumulative changes

The comparison is always fixed `base_sha` versus current worktree content: committed, staged and
unstaged changes form one final net result. Reverting content to the base removes that difference.
`missions.changes` creates or replaces a bounded current-browser snapshot: it copies the actual index into
a private temporary index, registers untracked non-ignored files with intent-to-add, invokes Git Diff once,
and retains the resulting opaque file-ID to raw old/new-path mapping. The real index and HEAD are not mutated.
Git exclusions apply to untracked files; tracked files remain part of the comparison.

Overview returns opaque file ID, path/old path, kind, line counts, binary flag and old/new Git mode.
`missions.fileDiff` requires that current snapshot and computes only its mapped path or rename path pair;
it does not call the overview scan. A missing, expired or mismatched mapping returns
`mission.changes_refresh_required`, after which Renderer refreshes the overview before retrying. Repeated
file requests may reuse the private index while the snapshot is valid. `missions.diffSession.release` drops
the process-local snapshot; capacity eviction and a ten-minute idle expiry are additional cleanup bounds.
Single-file Diff is loaded on demand with hunks and line numbers. Renames, deletions, type changes and
Git executable-bit changes are retained; arbitrary filesystem permission/ACL changes are outside Git's
contract. Binary files have file-level records without ordinary text hunks. No complete patch history or
per-Turn snapshots are stored. Missing Git/worktree/base, unreadable output, or a disappeared file returns
an explicit reason, never a false empty Diff.

## Surfaces

Desktop and wide Web share `missions.list|get|activity|delivery|changes|fileDiff|diffSession.release`, user commands
`missions.create|update|status|start|linkPr`, and orphan cleanup `missions.cleanup.list|retry`.
User commands use the existing command envelope and receipts. Deletion uses `camps.delete`.
Desktop Main alone may invoke private `missions.createWithAttachments` and
`missions.updateWithAttachments` orchestration after converting renderer `File` objects to source paths;
these methods are not Renderer direct-Core or Web operations.
Delivery includes current directory, Git association, linked PRs, and same-Camp available Agent-published
files with their source message. It never manufactures files from narrative claims.

Agent CLI exposes only `mission get|update|status` in the authenticated current public Camp, with no
Mission selector, workspace or version. Private Single Chat and stale/removed membership are rejected.
See [Transport v26](builtin-tool-transport-v26.md), [context evidence v25](context-manifest-evidence-v25.md)
and the [desktop UI contract](../ui/components/mission-board.md). `mission get` is a pure current-state read;
it does not acknowledge or suppress update notices. Mobile has no Mission entry in v1.

Migration 157/schema 107 first applies the mainline DSH closed-set expansion to either admitted
v1.59/schema 106 predecessor. Migration 158 adds Mission/context workspace evidence; Migration 159/schema 109
removes the obsolete creation-time source ref, adds internal definition revision and nullable workspace
`base_branch`. Migration 160/schema 110 adds the stable Mission number, removes stored commission definition
bodies and the read-watermark table, scrubs definition bodies from Mission activity/domain-event facts, and
adds accepted-delivery watermarks to Conversation/ContextManifest. A deployed Mission preview that already
uses receipts 157–159/schema 109 is admitted only for Migration 160, which adds the missing DSH schema and
converges both lineages. No migration creates or renames a workspace or changes frozen context bytes.
Migration 161/schema 111 adds the validated Mission source-attachment array with an empty default, preserving
all existing Missions and leaving frozen Context bytes unchanged.

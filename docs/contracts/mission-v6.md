---
document_type: protocol-contract
contract: mission-v6
authority: mission-status-source-association
status: accepted
version: 6
last_updated: 2026-09-20
---

# Mission v6

Mission v6 inherits [Mission v5](mission-v5.md) identity, global Agent reads, current-Mission-only mutation,
definition, workspace, cumulative Diff, cleanup and deletion semantics. It makes the status source message an
optional association for every status rather than a precondition for selected Agent transitions.

```ts
type MissionStatusInput = {
  status: 'not_started' | 'in_progress' | 'needs_you' | 'completed'
  sourceMessageId?: string
}

type MissionStatusResult = {
  missionId: string
  changed: boolean
}
```

An authorized Agent may set any of the four statuses while omitting `sourceMessageId`. Status mutation does not
publish or search for a message, bind the latest message, start or stop a Run, or change Mission execution. The
existing membership, current public Mission, authenticated Run, epoch, lease and Native Binding gates remain in
force.

When `sourceMessageId` is present, Core still requires an existing, non-deleted public message in the same Camp.
An unknown, cross-Camp, unpublished or deleted message rejects the complete command with
`mission.invalid_source_message`; status, association and Mission activity remain unchanged. Empty strings and
non-string values remain invalid catalog inputs. The error uses `fix_input` recovery in both the catalog and the
actual invocation envelope.

Omitting `sourceMessageId` writes `NULL`, including when an earlier status had a source association. Core does not
inherit that association. `changed` compares both status and source association: clearing an existing association
is a change, while equal status and association are a no-op. Command replay returns the stored result and does not
append another activity; each actual change keeps the ordinary status activity and domain event.

The retired `mission.source_message_required` error is absent from the current catalog. Historical Mission rows
and activities are not rewritten. This revision requires no database migration and does not change Mission IDs,
Run Facts, Bootstrap, ContextManifest or Renderer wire shapes.

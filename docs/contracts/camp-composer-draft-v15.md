---
document_type: interface-contract
contract: camp-composer-draft
version: 15
status: accepted
authority: desktop-local-public-camp-composer-recovery
last_updated: 2026-09-19
---

# Camp Composer Draft v15

v15 inherits [v14](camp-composer-draft-v14.md)'s clean break from Core Draft, public Pending,
revision coordination, edit leases and cross-client merge. It replaces the mounted-Renderer-only lifetime:
Desktop preserves one unsent Composer snapshot per Active Camp in local application storage. Pending Camp first input
continues to follow [Pending Camp Activation v2](pending-camp-activation-v2.md) and is not a restorable location.

The snapshot contains the V2 document, quotes, reply intent, continuation intent and ready source attachments.
Active Camp A → Camp B → Camp A, Renderer refresh, window recreation and ordinary App restart restore the same Camp's
snapshot. Camps never share a snapshot. Successful publication replaces the sent snapshot; deleting a Camp removes
its local snapshot and attachment authority. Invalid, oversized or incompatible local data fails closed to an empty
Composer without creating Core state. A failed send retains the frozen local edit; only an accepted publication
response replaces it with the next local Composer state.

## Continuation and reply

After an accepted publication with exactly one explicit, non-Lead member recipient, Desktop records that member as
the next-message continuation. It derives the recipient from the accepted local user's route, not from the last Agent
who happened to speak. A reply, an explicit member mention, broadcast, multiple recipients or Lead-only routing takes
precedence and does not create or apply continuation. Before sending, the continuation is materialized as an ordinary
member recipient and current membership/profile availability is revalidated.

Reply starts from the complete message already visible to the user, including a search/around anchored message that
is not in the main timeline page. Publication still revalidates the message ID in Core; a withdrawn or unavailable
source rejects publication and preserves the draft.

## Local source attachments

Desktop Main owns a bounded `(campId, attachmentId) → source path` registry. Restore, thumbnail bytes, in-app preview,
system open and reveal revalidate that authority and the current file kind/readability. The Renderer-provided path is
never accepted as a replacement for an existing attachment identity; publication uses the restored binding and Core
still performs its existing source-file admission. Images may be previewed before send; files and directories may be
opened or revealed before send. This authority does not recreate a Core Draft row or copy the user's source file.

Single Chat retains its separate private Draft/Pending contract.

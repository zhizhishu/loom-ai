---
document_type: interface-contract
contract: camp-composer-draft
version: 14
status: accepted
authority: renderer-local-public-camp-composer
last_updated: 2026-09-18
---

# Camp Composer Draft v14

v14 is a clean break for the public Camp Composer. The current edit exists only in the mounted Renderer.
Core has no public-Camp Draft row, revision, autosave, recovery session, Pending queue or cross-client merge.
Sending snapshots the current document, quotes, reply anchor, recipients, selected Skills and source-file
references into one publication command. A failed send leaves the mounted edit unchanged; a successful send
clears it.

Camp switch, refresh and app exit do not persist or recover the edit. A lightweight dirty warning may be a
Renderer-only choice, but cannot introduce Core draft state. Single Chat retains its separate private draft
and pending-input contract.

Migration 163 deletes legacy public Composer Draft, unpublished Pending and their edit/recovery state. It
does not delete user source files or attachments used by published messages. No legacy recovery screen or
reactivation API remains.

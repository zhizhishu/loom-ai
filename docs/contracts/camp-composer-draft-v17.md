---
document_type: interface-contract
contract: camp-composer-draft
version: 17
status: accepted
authority: client-local-public-camp-composer-recovery
last_updated: 2026-10-20
---

# Camp Composer Draft v17

Inherits [v16](camp-composer-draft-v16.md)'s per-Thread local snapshots and Pending presence.
This addition covers only Desktop public Composer plain-text paste. Existing file/image and valid internal
structured clipboard branches take precedence. More than 10,000 Unicode code points in one paste creates a complete
UTF-8 `.txt`; exactly 10,000 remains ordinary text. The final plain text extracted from HTML uses the same rule.
Existing content and selection are preserved on conversion. No cumulative text or send-budget check is introduced.
Single Chat, mission descriptions, member-creation overlays and remote/browser adapters keep their existing entry points.

## Local authority and lifetime

`composerAttachments.preparePastedText(threadId, file)` is an optional Desktop capability. Main writes a UUID-named file
directly under the canonical Thread output directory. Its local-only `host.thread.attachmentOutputRoot` read checks
Desktop ownership and Thread existence, and reuses Core's storage layout. It is absent from the Renderer Core-method
allowlist. Main neither reconstructs the platform path nor recreates a deleted Thread directory.

On macOS/Linux the layout is `~/.rovai/instances/<instanceKey>/attachments/<threadId>/<UUID>.txt`. Display names start
at `粘贴内容-1.txt` / `Pasted-text-1.txt` and avoid only this Composer's ready and preparing names. Body, atoms, quotes,
reply and attachment identities stay in the existing local snapshot; the generated text is not duplicated in it.
Generated preparation shares the existing serial queue, the ten-attachment draft admission and 25 MiB byte-entry limit.
Preload rejects a larger `file.size` before reading its array buffer or sending IPC; Main still validates the actual bytes.

Main's existing registry retains `generatedBy: "long_text_paste"`, the existing Thread binding and
`enteredSendFlow: boolean`. New entries start false. The optional `generatedBy` field in a local attachment view is
only a routing hint; deletion eligibility always comes from Main's registry. Missing or unknown provenance/flag
never grants permission to delete. Generated entries are exempt from the ordinary 30-day/200-entry cache pruning
until explicitly released; authoritative Thread deletion uses the existing navigation invalidation to release them,
including startup discard. Ordinary entries retain their existing policy.

## Acceptance and fallback

The original editor operation retains the pasted text while preparation runs. Local draft save is the explicit
acceptance point, before Pending presence acknowledgement. A later presence failure does not add another body copy.
Generated mutations do not reload a stale snapshot over text typed during preparation.

If local acceptance has not occurred, append the complete original to the original editor's current content before
cleaning up a prepared generated file. Complete this fallback before the preparation queue settles, remove the
replaced failed card, and use existing save/leave protection if saving the fallback fails. Cleanup failure must not
prevent fallback. A write/registry failure before returning an attachment identity may leave a residue for normal
Thread deletion. A result whose acceptance cannot be established is not evidence of rejection: retain its original
operation and error/leave protection until the existing save/read/retry path establishes the result. No persistent
recovery transaction, cross-Thread fallback, automatic retry or indefinitely pending recovery promise is added.

## Send and removal

Before forwarding a potentially publishing `thread.messages.send`, Main durably marks only generated sources in
that request's final frozen attachment snapshot as `enteredSendFlow: true`. It does not mark every registration owned
by the Thread: previously removed attachments, including failed-cleanup residues, are excluded unless the same source
is explicitly included again. ID matching is scoped to the sending Thread; exact `sourcePath` matching also protects
the original generated registration when another Thread selects that file through its ordinary file entry.
An empty attachment snapshot returns before registry loading or queueing. It adds no protection and does not remove
protection from files used by an earlier request.
A failed protection write prevents forwarding. This mark never resets in this version,
including after explicit send failure. Protection and file removal serialize on the registry's existing mutation
queue. No per-attempt associations, polling or reconciliation are introduced.

`composerAttachments.removePastedText(threadId, attachmentRefId)` runs only after saving the local draft without that
reference. Main checks exact Thread provenance and canonical output-directory ownership. It awaits asynchronous
`unlink` only for a generated file with `enteredSendFlow === false`; ENOENT is already cleaned. Protected files retain
their bytes while the released draft registration is removed. Unknown eligibility retains the file. Cleanup failure
retains the registry and reports a cleanup error without rolling back the saved draft or disabling continued editing.
The result is `deleted` or `retained`, never a promise that a queued deletion will eventually succeed.

Generic `discard` remains registration-only. External file removal and accepted-send clearing never delete source
files. After publication succeeds, save the replacement local draft **before** releasing its old registrations;
if saving fails, keep the file and registrations needed to restore the old local snapshot.

## Creation and Thread cleanup

Use current activation state and the existing accepted-first-send acknowledgement. A normal Dialog creates Active
even with zero messages or when enabling one-click creation for future use. Clearing such input does not discard the
Thread. One-click creates Pending; attachment-only input is meaningful and must keep its presence. After activation
the same Thread ID and files remain in place.

Removing all meaningful Pending input keeps the existing hide/leave/guarded-discard sequence. File cleanup is not
inferred from sidebar visibility. Successful Pending deletion and the existing startup empty-Pending cleanup also
remove that Thread's output directory. No timer, directory scan, reference count, deferred cleanup queue or general
garbage collector is introduced. Files that entered send but were never published may remain until Thread deletion.
Cross-Thread source reuse does not extend the owning Thread's lifetime: its existing deletion rules, including
empty-Pending lifecycle cleanup, still remove its output directory.
Storage consists of the real text files and local metadata; failed residues in a retained Active Thread may remain
indefinitely. No automatic eventual cleanup is promised.

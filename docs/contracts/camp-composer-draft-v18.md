---
document_type: interface-contract
contract: camp-composer-draft
version: 18
status: accepted
authority: client-local-public-camp-composer-recovery
last_updated: 2026-10-21
---

# Camp Composer Draft v18

Inherits [v17](camp-composer-draft-v17.md)'s Desktop scope, local draft authority, attachment preparation,
fallback, Thread-owned storage, send protection and cleanup. This revision narrows the internal clipboard
exception without changing the clipboard wire format or adding state.

## Clipboard precedence

Files and images retain first priority. Otherwise validate and recover the existing private Composer MIME.
Only a recovered document containing an actual Member, All Members or Skill Atom bypasses long-text conversion.

A recovered document containing only text uses its own complete text for the existing single-paste threshold,
even when it arrived as `application/x-rovai-composer+json`. Plain `@name` and `/skill` characters are not Atoms.
The internal document remains authoritative if the parallel `text/plain` or HTML representation differs.
References downgraded to visible text by existing clipboard recovery are evaluated as that recovered text.
Without a valid internal document, use the existing plain-text / HTML-to-text fallback.

More than 10,000 Unicode code points invokes the optional Desktop public Composer attachment callback;
exactly 10,000 keeps normal insertion. Successful conversion preserves existing body and selection. If the
callback is absent or declines, use the previous insertion path; asynchronous failure keeps v17's original-text
recovery. No cumulative-length or send-budget check is introduced.

## Verification

The existing production Composer Electron fixture covers Copy followed by Paste of text-only internal data,
the 10,000 / 10,001 boundary, complete whitespace and Unicode content, selected body preservation,
internal text differing from its plain-text fallback, delayed preparation failure, and long text with each
of the three Atom types. Existing file/image, invalid MIME, HTML and non-paste input cases remain in the same owner.

---
document_type: protocol-contract
contract: camp-history-v7
version: 7
status: accepted
authority: live-agent-visible-camp-history
last_updated: 2026-09-18
---

# Camp History v7

v7 inherits v6 identity, authorization, attachment-path and cursor contracts, and changes public message
visibility and result sizing.

`camp.read` evaluates the calling Agent's latest authorized Camp state at call time. It is not restricted by
the current Run's ContextManifest, public-tail window or frozen visibility snapshot. It applies `limit <= 20`
and cursor first, then returns the selected page with complete bodies, quotes, attachments, metadata and
`anchorMessageId`. The former 80,000-scalar aggregate budget, prefix bodies and size-driven page shrinking
are removed.

The public request contract has four direct forms:

```text
rovai camp read --limit 20
rovai camp read --before CURSOR
rovai camp read --message-id MESSAGE_ID
rovai camp read --thread MESSAGE_ID --limit 20
```

`campId` may be added to any form to select one authorized Camp. The exact-item form accepts only
`campId + messageId`; the timeline and thread forms accept the exclusive `before` sequence cursor and
`limit <= 20`. The request does not expose `mode`, `direction`, `around`, `after`, or a generic `cursor`,
and the CLI does not translate those retired fields into the direct contract. Timeline and thread pagination
always select backward from the newest eligible boundary while emitting each selected page in ascending sequence;
an omitted limit means 20.

Every Agent-facing read/search/thread/reference path applies the same visibility policy:

- a recallable local-Principal message is invisible to every Agent;
- after the first target claim, an unclaimed target remains suppressed until its own Delivery is claimed;
- claimed targets receive the message through `RUN_INPUT`; non-target Agents then use ordinary public rules;
- withdrawn messages are absent from collections and pagination; exact ID returns `message.withdrawn`.

Stored quote text remains an immutable excerpt, but projection is viewer-specific: every quote source is
rechecked under the same Agent visibility fence before its snapshot may appear. A visible message therefore
cannot reveal a recallable, suppressed, withdrawn, out-of-scope, or post-boundary source through `quotes[]`.

Reading does not claim a Delivery, close recall, or advance accepted watermarks. A cursor cannot bypass
current authorization, suppression or withdrawal.

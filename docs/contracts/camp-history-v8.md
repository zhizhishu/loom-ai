---
document_type: protocol-contract
contract: camp-history-v8
version: 8
status: accepted
authority: public-camp-history-read-scope
last_updated: 2026-09-19
---

# Camp History v8

v8 inherits [v7](camp-history-v7.md) request shapes, complete-result behavior, attachment projection,
recipient suppression, withdrawal filtering and viewer-specific quote visibility. It replaces target-Camp
membership authorization with one public-history rule: every authenticated teammate may discover, search and
read every extant public Camp. `CampMember` controls participation, addressing and execution; it is not a public
history ACL. Private Single Chat messages and Runtime-private records remain outside this contract.

The authenticated Built-in binding still proves the calling AgentRun, epoch and current Camp. That identity is
used for recipient-specific message visibility, but the target Camp does not require a current or historical
membership row, and an Agent profile does not need to be repeated as a member of that Camp. A Camp ID locates a
public Camp; it does not bypass recall, withdrawal, suppression or quote-source visibility.

`camp.read` resolves the selected Camp directly at call time. Timeline, exact-item and thread reads use that
Camp's live sequence boundary and may see messages published after the calling Run's ContextManifest. The
ContextManifest history catalog is evidence for automatic context and discovery ordering, not read permission.

`camp.list`, cross-Camp `camp.search` and `history.search` retain the calling Run's frozen global publication
boundary for deterministic discovery. New manifests snapshot every other extant Camp. For an older manifest
that omitted a Camp under the retired membership rule, Core supplements the catalog from the current Camp table
and admits that Camp's messages only through the same frozen global boundary. No historical Manifest backfill is
required.

The current Camp remains live for `camp.search`; cross-Camp search remains bounded by the frozen global
publication boundary. All paths continue to hide recallable or withdrawn messages and a target's own still-waiting
Delivery. Reads do not claim Delivery, close recall or advance accepted watermarks.

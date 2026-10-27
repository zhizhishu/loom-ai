---
document_type: protocol-contract
contract: context-manifest-evidence-v27
authority: public-multi-input-agent-run-context-evidence
status: accepted
version: 27
last_updated: 2026-09-21
---

# ContextManifest Evidence v27

Manifest 27 and Formatter 27 apply only to new public Camp Runs. They inherit the section order, multi-input
`RUN_INPUT`, accepted-only incremental `SHARED_CONVERSATION`, Run Facts 5 and all evidence rules from
[Manifest 26](context-manifest-evidence-v26.md). Single Chat remains on Manifest/Formatter 25; frozen public
Runs retain their original Manifest, Profile, payload bytes and digests.

## Mission Session Charter

New Mission bindings append this exact Mission-only block to the public Session Charter:

```text
Rovai Mission Contract

- All current members may use `rovai mission get|update|status` to maintain this Camp's Mission.
- Use `rovai mission get` when the current Mission's full definition is missing or outdated; judge completion against that definition.
- The Mission working directory is already prepared. Continue follow-up work there on its current checkout by default. Do not create or switch branches, or create another Worktree, merely because a new Run starts, context is compacted, or more changes are requested. Follow explicit user requests for a different branch or baseline.
- Change status only when the whole Mission's state changes, not merely when your Run ends.
```

The additional guidance tells follow-up Runs to continue in the already prepared Mission working directory on
its current checkout by default. It neither locks the branch nor changes workspace preparation, cleanup, Git
observation, Runtime compaction, or `[WORKSPACE]` delivery. The Mission-only block itself is unchanged in v1.63.

All new public bindings use Session Charter revision 12. Its shared Built-in CLI block replaces only the help-routing
line with:

```text
- Use `rovai --help` to choose an operation and its exact `--help` for syntax. Reuse help already available in the current Native Session.
```

This aligns the stable Charter with the v31 `rovai task --help` family index without adding Task fields or workflows.
Revision 12 rotates new Binding compatibility; historical Bootstrap evidence, Manifest rows and frozen input bytes remain
immutable. Formatter 27, Manifest 27, Profile 8, section selection, ordering and evidence do not change.

For an Agent-facing public batch projection, Core first renders the stored Structured Camp Message Content.
When and only when `addressMode = default` has exactly one frozen `addressedAgentId`, Core prefixes that
rendered body with the existing Member Mention rendering for that recipient:

```text
@<recipient display name> <authored body>
```

The separator is omitted when the authored body already starts with Unicode whitespace. An attachment-only
message projects only the mention token. A default-addressed message with no recipient is public-only and is
unchanged; more than one recipient or a missing recipient identity fails closed. Explicit addressing,
broadcast, reply/continuation targets and Agent `--to` are unchanged and never receive a second prefix.

The recipient ID comes from the message's frozen addressing snapshot, not the current Default Lead. During the
atomic claim, Core resolves the display name through the existing Agent Member Mention renderer and stores that
claim-time snapshot on the corresponding `AgentRunInput`. The same row freezes ContextManifest version 27 for
new claims; rows claimed before Migration 166 are marked version 26 and remain on Profile 7 even if they had not
yet materialized a Manifest. Final materialization uses the frozen version and display-name snapshot for both copies
of the message even if the Member is renamed after claim. The derived token changes only
`RUN_INPUT.messages[].body` and `SHARED_CONVERSATION.messages[].body`; it does not change
`camp_message.body`, Structured Content, routing, Delivery, timeline/read/search/thread output, Quote
snapshots, FTS, Channel output or permissions.

Each affected run-input or shared-message evidence entry includes:

```json
{
  "defaultRecipientMention": {
    "agentId": "agent-id",
    "displayName": "display name frozen for this Run"
  }
}
```

The field is omitted when no derived prefix exists. `contentDigest` continues to bind the authored
Structured Content. `projectedBodyDigest`, projected input/shared evidence digests, payload digest and Blob
digest bind the exact prefixed bytes. Prefix scalars and UTF-8 bytes participate in
[Profile 8](context-delivery-profile-v8.md) selection and preflight. Recovery reuses the frozen Manifest and
payload exactly; v26/Profile 7 remains a read-only historical recovery pair, and its pre-v27 RunInput rows do not
require a display-name snapshot.

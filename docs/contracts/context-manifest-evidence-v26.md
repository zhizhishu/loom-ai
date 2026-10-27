---
document_type: protocol-contract
contract: context-manifest-evidence-v26
authority: public-multi-input-agent-run-context-evidence
status: accepted
version: 26
last_updated: 2026-09-18
---

# ContextManifest Evidence v26

Manifest 26 and Formatter 26 apply only to new public Camp Runs. Single Chat and historical frozen public
Runs retain Manifest/Formatter 25 or their original versions.

The public dynamic section order is:

```text
[COLLABORATION_STATE]?
[SELF_ACTIVE_TASKS]?
[SHARED_CONVERSATION]?
[RUN_FACTS]
[WORKSPACE]?
[RUN_INPUT]
```

`RUN_INPUT.messages[]` is non-empty, ordered by message sequence and contains every message claimed for the
Run. Public Camp no longer emits `CURRENT_INPUT` or `A2A_GUIDANCE`. Each input records message identity,
sequence, author type/identity, complete body, optional anchor, quotes, attachment paths, Skills and true
mention flag. Sources do not introduce special input variants.

The manifest freezes ordered input references and digests, Run anchor, exact rendered bytes/digest,
[Profile 7](context-delivery-profile-v7.md), [Run Facts 5](run-facts-v5.md), execution configuration digest,
Skill resolution, message-visibility fence, previous accepted public tail, current public tail, selected
shared-message identities, omitted count and optional history cursor.

For each `(campId, agentId)`, `SHARED_CONVERSATION` covers visible public messages in
`(lastAcceptedPublicTailSequence, currentPublicTailSequence]`. It preserves chronological order and the
Agent's own messages. The same message may also appear in `RUN_INPUT`; only `RUN_INPUT` creates a processing
responsibility. Accepted acknowledgement for the exact Run/binding/generation advances the stored lower
watermark to the frozen current tail. Prepared, rejected, unknown and stale acknowledgements do not.

The watermark belongs to Camp+Agent and survives Native Session replacement. Recovery of the same Run
reuses exact Manifest bytes. The manifest freezes automatic context, but does not bound later live
`camp.read` calls.

## Mission Session Charter

New Mission bindings append this exact Mission-only block to the public Session Charter:

```text
Rovai Mission Contract

- All current members may use `rovai mission get|update|status` to maintain this Camp's Mission.
- Use `rovai mission get` when the current Mission's full definition is missing or outdated; judge completion against that definition.
- Change status only when the whole Mission's state changes, not merely when your Run ends.
```

The additional guidance makes the saved Mission definition the completion criterion and permits an explicit
read when that definition is absent or stale. It does not require a read when the complete definition is already
current, create a fixed operation sequence, or change Mission authority and status semantics. Ordinary public
Camp and Single Chat Charters remain unchanged. Session Charter revision 10 rotates new Binding compatibility;
historical Bootstrap evidence, Manifest rows and frozen input bytes remain immutable.

---
document_type: protocol-contract
contract: current-input-skill-links-v2
authority: structured-skill-selection-and-batched-run-input-projection
status: accepted
version: 2
source_version: v1.60
last_updated: 2026-09-18
---

# Run Input Skill Links v2 Contract

v2 keeps v1's closed `skill_mention {skillId,nameAtSend}` segment, `/nameAtSend` body projection, verified
SkillProjection preflight, deterministic resolver and `{name,path}` model link. It replaces Direct-send Run freezing and
`CURRENT_INPUT.skills` with claim-time batch semantics.

## Claim-time selection

CampMessage publication stores only its structured Skill mentions. Waiting Delivery does not freeze Runtime groups,
Skill eligibility or a Run snapshot. When Scheduler atomically claims an ordered Delivery prefix, Core:

1. reads every claimed message's structured content in Run-input order;
2. freezes the current Agent Runtime groups and the Run's execution configuration;
3. builds one `SkillSelectionSnapshot v1`, keeping the first occurrence of each Skill ID across the batch;
4. evaluates current lifecycle, enablement, exact name and frozen Runtime-group assignment; and
5. stores the snapshot and digest with the newly created AgentRun.

An unavailable selection does not reject message publication and cannot be skipped to claim later Delivery. Handwritten,
pasted and historical slash-like text stays Text and never becomes a selection.

## Resolution and model projection

First Context materialization resolves the frozen selection against the current desired-state view and the verified
SkillExposureSnapshot using v1's closed availability, candidate-ordering and omission rules. Any full Exposure integrity
failure remains fail closed; an individual missing/inactive/disabled/renamed/unassigned/non-ready selection is omitted.

Formatter 27 inherits the Formatter 26 rule and projects resolved links only onto `RUN_INPUT.messages[]` items whose own structured content selected that
Skill:

```json
{
  "messages": [
    {
      "messageId": "M1",
      "sequence": 101,
      "senderType": "user",
      "senderId": "local_user",
      "body": "/review-pr inspect this",
      "skills": [
        {"name": "review-pr", "path": "/repo/.codex/skills/review-pr/SKILL.md"}
      ]
    }
  ]
}
```

Within one message each Skill appears at most once and follows its first mention order. If the same resolved Skill is
selected by several claimed messages, each relevant message may contain the same link; resolution and Exposure evidence
remain one Run-level frozen set. A message with no included link omits `skills` rather than returning null or an empty
array.

Skill links are instructions/context only. They grant no tool, filesystem, Runtime or Core permission and do not prove
that the Runtime or model read the file.

## Recovery and transport

Manifest 27 freezes the selection, availability, resolution, Exposure and exact Formatter 27 payload. Same-Run
transport recovery reuses those bytes and does not reread later Library/filesystem state. Runtime Adapters transport the
complete prepared payload unchanged and do not create Provider-specific Skill items.

Single Chat remains on Formatter/Manifest 25 and the v1 `CURRENT_INPUT.skills` behavior.

## References

- [Current Input Skill Links v1 (historical)](current-input-skill-links-v1.md)
- [ContextManifest Evidence v27](context-manifest-evidence-v27.md)
- [Structured Skill Links architecture](../architecture/structured-current-input-skill-links.md)
- [Skill Projection Reconciliation](../architecture/skill-projection-reconciliation.md)

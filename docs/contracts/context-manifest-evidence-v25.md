---
document_type: protocol-contract
contract: context-manifest-evidence-v25
authority: agent-run-context-evidence
status: accepted
version: 25
last_updated: 2026-09-16
---

# ContextManifest Evidence v25

Inherits the published [v24](context-manifest-evidence-v24.md), including Agent source-path attachments,
`attachmentOutputRoot`, optional legacy attachment receipts, exact quotes, public history, private-session
boundaries and immutable evidence. New input uses Formatter/Manifest 25,
[Profile 6](context-delivery-profile-v6.md), [Run Facts 4](run-facts-v4.md), Session Charter revision 7 and
[Built-in Transport 26](builtin-tool-transport-v26.md). Bootstrap contract v3/Formatter 3, IPC 2,
Agent Output Projection 3 and receipt 1 remain unchanged.

## Mission input

Mission facts contain `{missionId,title,status}` plus the optional fixed `updateNotice` defined by
[Run Facts v4](run-facts-v4.md). Description is read through `rovai mission get`.
Only an explicit start proven by the persisted commission record projects
`{"kind":"mission_start","source":{"type":"user"},"missionId":"…"}` as CURRENT_INPUT. The internal
input evidence binds Mission, Camp, command and commission. User-authored lookalike JSON remains ordinary
message text. Ordinary messages and A2A keep their existing projection. No Mission version is exposed.

Mission Session Charter appends exactly:

```text
Rovai Mission Contract

- All current members may use `rovai mission get|update|status` to maintain this Camp's Mission.
- Change status only when the whole Mission's state changes, not merely when your Run ends.
```

Ordinary Camp and Single Chat Charter text is unchanged. Mission guidance does not grant private chats
Mission tools, require a get every Turn or impose a lead-only update policy.

Core keeps the definition revision and each Agent conversation's last successfully delivered Mission detail
version as internal selection state. First entry never emits a notice. Each new manifest freezes the current
version without adding it to model bytes. A later definition change emits the fixed notice until a Runtime Input
carrying that version is accepted on the current binding/generation. Prepared, rejected, unknown or late inputs
cannot advance a successor. `mission get` has no acknowledgement side effect, and no version or changed-field
list enters model bytes or the Agent tool API.

## Workspace evidence

Mission public Run input may include `[WORKSPACE]` after RUN_FACTS and before A2A_GUIDANCE / CURRENT_INPUT:
`{workingDirectory,branch?}`. The absolute directory and Git branch come from the actual prepared Run
environment. Detached Git HEAD yields null; non-Git omits branch. This is information, not a path sandbox,
permission or instruction controlling the Agent.

The manifest persists the canonical workspace JSON, digest and inclusion decision. Include it until an
input carrying those facts is accepted on the current native binding/generation. Failed or unknown
delivery cannot advance the marker; late acknowledgement from a replaced binding cannot affect its
replacement. Unchanged facts are omitted after acceptance, including after restart on the same binding.
A new binding or changed resolved facts causes reinjection. Section bytes and internal evidence must agree.

Direct and A2A preflight share the payload budget policy without creating files. Once preparing resolves
the actual workspace, final materialization validates the environment, recomputes workspace evidence and
the final payload budget, then freezes bytes. The workspace section is not silently truncated.

Migration 158 admits new 25/25/6/RunFacts4 manifests after Migration 157 has applied the DSH closed-set
expansion to either supported schema-106 predecessor: the published attachment-path schema or the previously
installed Mission preview. Frozen 22/22/4, 23/23/5,
published 24/24/5 and Mission-preview 24/24/6 inputs remain readable only with their original evidence;
they are never relabeled or reformatted. Model schema golden:
`packages/contracts/fixtures/agent-run-context-v25.json`.
Migration 159/schema 109 introduces the internal Mission definition revision. Migration 160/schema 110 replaces
read acknowledgement with accepted-delivery watermarks on Conversation and ContextManifest and converges the
deployed Mission-preview lineage with DSH; it does not rewrite any frozen manifest or change the Run Facts schema
number. Migration 161/schema 111 adds Mission definition source attachments without changing ContextManifest,
Run Facts, frozen input bytes or any delivery watermark.

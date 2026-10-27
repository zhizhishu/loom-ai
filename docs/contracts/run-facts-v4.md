---
document_type: protocol-contract
contract: run-facts-v4
authority: dynamic-run-facts
status: accepted
version: 4
last_updated: 2026-09-16
---

# Run Facts v4

Inherits the optional operational facts and omission rules from [Run Facts v3](run-facts-v3.md), while
combining the current attachment-output and Mission facts in one closed top-level object:

```ts
type RunFactsV4 = {
  schemaVersion: 4
  attachmentOutputRoot: string
  mission?: {
    missionId: string
    title: string
    status: 'needs_you' | 'not_started' | 'in_progress' | 'completed'
    updateNotice?: 'Mission details have changed. Read the latest mission name and description before handling CURRENT_INPUT.'
  }
  conversationMode?: ConversationModeFact
  taskContext?: TaskContextFact
  sessionContinuity?: SessionContinuityFact
  externalEffect?: ExternalEffectFact
  gather?: GatherFact
  delegation?: DelegationFact
}
```

`attachmentOutputRoot` is the current Camp's default location for new Agent output. It is not an
enumeration root, a permission grant, or a declaration that every Camp attachment lives below it.

Mission facts remain limited to identity, title, status and the conditional fixed notice above. Description, labels, business revisions,
workspace identity and change history are absent. Workspace is a separate sibling section under
[ContextManifest v25](context-manifest-evidence-v25.md). Private Single Chat does not receive Mission facts.

The first Mission input for an Agent conversation has no notice. An accepted Runtime Input records the Mission
detail version frozen in its manifest. A later input includes the notice when the current internal definition
revision is newer than that conversation's last successfully delivered version. The exact notice persists until
an input carrying the newer version is accepted on the current binding/generation; `mission get` is unrelated.
It contains no revision, editor or changed-field metadata; `CURRENT_INPUT` is unchanged.

Frozen Run Facts v2 and both published Run Facts v3 shapes retain their exact stored payload and evidence.

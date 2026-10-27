---
document_type: protocol-contract
contract: run-facts-v5
authority: public-camp-dynamic-run-facts
status: accepted
version: 5
last_updated: 2026-09-18
---

# Run Facts v5

Public Camp AgentRuns use this closed shape:

```ts
type RunFactsV5 = {
  schemaVersion: 5
  attachmentOutputRoot: string
  mission?: {
    missionId: string
    title: string
    status: 'needs_you' | 'not_started' | 'in_progress' | 'completed'
    updateNotice?: 'Mission details have changed. Read the latest mission name and description before handling RUN_INPUT.'
  }
  taskContext?: TaskContextFact
  sessionContinuity?: SessionContinuityFact
  externalEffect?: ExternalEffectFact
}
```

`gather`, `delegation` and `conversationMode` are absent; they are not emitted as null, empty or renamed
objects. Removing budgets does not grant permissions. `externalEffect` describes a real unresolved effect,
not ordinary accepted-input uncertainty. Single Chat retains [Run Facts v4](run-facts-v4.md), including its
private `conversationMode`.


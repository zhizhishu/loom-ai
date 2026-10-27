---
document_type: protocol-contract
contract: run-facts-v3
authority: dynamic-run-facts
status: accepted
version: 3
last_updated: 2026-09-15
---

# Run Facts v3

Inherits [Run Facts v2](run-facts-v2.md), with wrapper `schemaVersion=3`. Existing non-Mission fields retain
their semantics and omission rules. A public Mission Camp adds only:

```ts
mission?: {
  missionId: string
  title: string
  status: 'needs_you' | 'not_started' | 'in_progress' | 'completed'
}
```

Description, workspace, revision/version, change history and inferred Run outcomes are absent. The internal
typed Mission reference records missionId for evidence. Workspace is a separate sibling dynamic section
under [Manifest v24](context-manifest-evidence-v24.md). Private Single Chat does not receive Mission facts.

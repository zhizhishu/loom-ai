---
document_type: contract
contract: context-delivery-profile-v6
status: accepted
target_version: v1.59
last_updated: 2026-09-15
---

# Context Delivery Profile v6

Inherits all ordering, history/quote selection and numerical limits from [Profile 5](context-delivery-profile-v5.md).
`profileVersion=6` pairs with [Manifest 25](context-manifest-evidence-v25.md). Mission facts, trusted start input,
and the optional first-accepted workspace section participate in the same Runtime byte budget. Required
input is preserved; eligible optional history/tasks are removed by the existing policy before explicit overload.
Direct and A2A final materialization recheck this budget using the prepared workspace. Preflight has no
filesystem side effects. Frozen Profiles 4/5 replay exact old evidence instead of reselecting under Profile 6.

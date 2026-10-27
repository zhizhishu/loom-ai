---
document_type: contract
contract: context-delivery-profile-v8
status: accepted
target_version: v1.61
last_updated: 2026-09-19
---

# Context Delivery Profile v8

Profile 8 is the public Camp profile paired with [ContextManifest 27](context-manifest-evidence-v27.md).
Single Chat continues to use Profile 6; frozen Manifest 26 Runs continue to use Profile 7.

Profile 8 inherits every numeric limit and complete-message selection rule from
[Profile 7](context-delivery-profile-v7.md): the absent Runtime capability default remains `96 * 1024`
UTF-8 bytes, mandatory fixed sections and the largest complete FIFO `RUN_INPUT` prefix are selected before
optional context, and shared history remains the latest 15 eligible messages followed by the latest complete
suffix that fits.

The semantic change is the sizing input. Core must derive the Manifest 27 default-recipient Member Mention
before both claim sizing and final serialization. Its token, optional separator and recipient display name
count in the exact message body scalars and payload bytes; the claim transaction snapshots that display name on
AgentRunInput alongside ContextManifest version 27 so final serialization cannot drift after a Member rename or an
application upgrade. Pre-Migration-166 claimed RunInput remains frozen on Manifest 26/Profile 7. Messages remain indivisible: Core neither truncates
the prefix nor removes it to fit. An oversized queue head still becomes an evidence-bearing
`context_payload_too_large` Run without Runtime delivery, after which later queue work may continue.

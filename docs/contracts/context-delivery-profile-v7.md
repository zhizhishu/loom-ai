---
document_type: contract
contract: context-delivery-profile-v7
status: accepted
target_version: v1.60
last_updated: 2026-09-18
---

# Context Delivery Profile v7

Profile 7 is the public Camp profile paired with [ContextManifest 26](context-manifest-evidence-v26.md).
Single Chat continues to use Profile 6.

At claim, Core resolves the selected Runtime/model `maxContextPayloadBytes` once; an absent capability defaults
to `96 * 1024` UTF-8 bytes. There is no common 1 MiB clamp. Prefix selection and final delivery use the same
`RUN_INPUT.messages[]` projection and serializer rather than a separate sizing DTO. Mandatory fixed sections and
the largest complete FIFO prefix are selected first. Optional `SHARED_CONVERSATION` and other optional context
consume only the remainder.

An input message, including body, viewer-visible quotes, attachment metadata/source references loaded by that
message's own ID regardless of author type, and selected Skills, is indivisible. Core
does not truncate or summarize it. If the queue head alone cannot fit, Core creates an evidence-bearing
preflight-failed Run (`context_payload_too_large`) without sending bytes to the Runtime, settles that
Delivery as failed, and permits later queue work to continue.

Shared history takes the latest 15 eligible messages, then the latest complete suffix that fits the
remaining bytes, and emits it in ascending sequence. Any real omitted candidate produces both
`omittedCount` and an opaque `historyReadCursor`.

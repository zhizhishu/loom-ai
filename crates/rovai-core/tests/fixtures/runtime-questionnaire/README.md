# Native permission questionnaire samples

Captured on macOS arm64 from the installed Kimi Code 2.1.1 and Qwen Code 0.25.0
through `scripts/smoke-native-questionnaires.mjs`, using the production Core and
a local scripted OpenAI-compatible provider. Both native sessions used `yolo`.
The question and options are synthetic. Only `sessionId` and `toolCallId` have
been replaced; object key order/whitespace are insignificant.

The unique regression owner is `approval_selects_the_exact_native_option_id`.
It derives damaged and conflicting samples from these complete native frames.
These are protocol/dispatch evidence, not real-model qualification or evidence
about untested native versions.

Both requests received exactly `{"outcome":{"outcome":"cancelled"}}`. Kimi then
produced its own empty-answer/dismissed tool result; Core did not send an answers
object or claim that a user had answered. The Run retained the unsupported
questionnaire terminal even after the native agent produced final text.

`hermes-0.22.4.json` is produced by the unmodified official
`acp_adapter.elicitation.build_clarify_permission` at
`4d04303818b61bf3aa09278af48356315515965b`, with synthetic question text and IDs.
The same owner derives the open-question case (no choices, only Skip) and verifies
that malformed Hermes cards cannot become execution authorization. Native
Core dispatch and cancellation are exercised by the existing Hermes smoke's
`--questionnaires` extension, with clarify enabled only in its isolated Home.

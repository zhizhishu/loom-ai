---
document_type: contract
name: Single Chat
version: v6
status: accepted
source_version: v1.61
last_updated: 2026-09-19
---

# Single Chat v6

Single Chat v6 inherits [v5](single-chat-v5.md) private Conversation, Source Attachment, Context, FIFO, terminal,
ending and pending-input behavior. It changes only the frozen Built-in operation policy and its Bootstrap
teaching.

New Single Chat AgentRuns persist `operationPolicy=single_chat_v1` with `operationPolicyVersion=2`. Version 2's
closed allowlist is:

```text
camp.search
camp.read
single_chat.history
mission.list
mission.get
```

The two Mission operations follow [Mission v5](mission-v5.md): any effective authenticated Single Chat AgentRun
may discover all Missions and read any one, including registered attachment paths. Reading does not switch the
current Camp or Mission and creates no mutation authority. Every other Mission operation, all public send/task/
memory mutations and every unlisted Built-in remain denied.

Historical version-1 Single Chat Runs retain the original three-operation allowlist. Runtime terminal and
history validation accept frozen policy versions 1 and 2; new Runs use only version 2. Migration 165 widens the
AgentRun policy-version constraint while keeping ordinary Camp Runs on policy version 1. Session Charter
revision 9 introduced the added read operations. Current revision 10 changes only the public Mission suffix;
Single Chat text, Context Formatter and ContextManifest remain unchanged at 25.

---
document_type: protocol-contract
contract: planned-shutdown-v7
authority: renderer-local-input-settlement-before-planned-shutdown
status: accepted
version: 7
source_version: v1.60
last_updated: 2026-09-18
---

# Planned Shutdown v7

v7 inherits v6's `protocolVersion = 3`, ten-second Core hard deadline, durable cycle, cancel-all settlement,
writer/route barriers, Runtime cleanup and report. It replaces the public Composer Draft persistence precondition.

## Desktop pre-shutdown coordination

`AppQuitCoordinator` still coalesces the first normal, update-install or application-closing quit request. Before service
drain it may ask the loaded Renderer to finish an already-started local quote, source-attachment or send operation and
flush the current Lexical editor into the same mounted Renderer state. This coordination prevents teardown in the
middle of an operation; it does not save public Composer content to Core.

A missing, destroyed or still-loading Renderer is a no-op. If an in-flight operation rejects or the private response
channel fails, the current quit attempt stops before service drain and may be retried. No response proves durable Draft
storage, and no public Draft recovery is offered.

Once quit proceeds, unsent public Composer content is discarded with that Renderer. Switching Camp, refreshing,
closing the window and App exit do not create a Core Draft, Pending input, restoration list or second local copy.
Single Chat's private Draft/Pending lifecycle is unchanged.

## Renderer presentation

Local input coordination precedes `runtime.state = shutting_down`. The delayed “正在安全退出” overlay continues to
mean Core planned shutdown, AgentRun cancellation and Runtime cleanup only; it does not promise to save public input.

## References

- [Planned Shutdown v6 (historical)](planned-shutdown-v6.md)
- [Camp Composer Draft v14](camp-composer-draft-v14.md)
- [Planned Shutdown architecture](../architecture/planned-shutdown.md)

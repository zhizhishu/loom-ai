---
document_type: protocol-contract
contract: mission-v8
authority: mission-start-and-execution-projection
status: accepted
version: 8
last_updated: 2026-09-20
---

# Mission v8

Mission v8 inherits [Mission v7](mission-v7.md) identity, definition, status, attachment, workspace, cumulative
Diff and asynchronous cleanup semantics. It makes the existing Mission start-admission rule explicit in the
Renderer read model and aligns execution presentation with the complete non-terminal AgentRun set. It does not
add a Mission status transition, database column, execution state machine or visible start message.

The path-free `MissionRecord` projection includes:

```ts
type MissionExecutionProjection = {
  runningAgentIds: string[]
  startAvailable: boolean
}
```

`runningAgentIds` contains the distinct ordered members that own an AgentRun in the Mission Camp with status
`queued`, `running` or `waiting`. A waiting Delivery that has not been claimed has no AgentRun and therefore does
not appear as executing. Claiming a Delivery creates the queued Run and changes this projection immediately;
Runtime connection, first output and a Mission business-status change are not prerequisites.

`startAvailable` is false when either of these facts exists:

1. this Mission has a start Delivery in `waiting` or `claimed`;
2. its Camp has any `queued`, `running` or `waiting` AgentRun, including one admitted by an ordinary public
   message.

An ordinary waiting Delivery does not by itself block the start entry. When neither fact exists,
`startAvailable` is true. The field is independent of Mission business status; Renderer offers the start action
only when both `status === 'not_started'` and `startAvailable` are true.

`missions.start` evaluates the same two facts inside its Domain Command transaction. When start is unavailable,
it preserves the existing applied `mission.already_running` result with `alreadyRunning: true` and creates no
additional message, Delivery, Run or start activity. A command replay keeps its stored result. When available,
the command admits exactly one Mission start Delivery and preserves the explicitly managed Mission status.

Renderer disables the pressed action immediately, exposes an accessible busy state and changes its label to
`正在开始…`. An accepted command hides the action before refresh or claim; the authoritative
`startAvailable: false` projection then owns the state. An explicit rejection restores the action and presents
the error. The persisted Mission start message remains excluded from the public timeline, so acceptance does not
add a visible “开始使命” or “使命已开始” message.

The Delivery batch scheduler emits the ordinary navigation invalidation after a successful claim so the board,
drawer and full conversation can refresh from the same Mission projection while the Run is still queued. These
presentation facts do not infer or mutate `not_started`, `in_progress`, `needs_you` or `completed`.

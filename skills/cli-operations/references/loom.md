# LOOM

LOOM keeps a Mission's plan, task claims, deliveries and the User's verdicts on record. The User sees them in the Mission's Orchestration and Delivery tabs. Every `rovai loom` command targets the current Thread's Mission.

## Who does what

| Step | Who | Command |
| --- | --- | --- |
| Check whether a plan exists | Anyone | `rovai loom status` |
| Import the plan | Default Lead | `rovai loom plan --input-file plan.json` |
| Make every task claimable | Default Lead | `rovai loom release --task-id <id>` for each task |
| Ask a member to take a task | Default Lead | `rovai send --to <member>` with the task id |
| Claim the task before working | Assignee | `rovai loom claim --task-id <id>` |
| Register each produced file | Assignee | `rovai loom evidence --relative-path <path> --task-id <id>` |
| Submit the delivery | Assignee | `rovai loom submit --task-id <id> --evidence-ids <artifactId>` |
| Accept or reject | User only | Delivery tab |
| Continue after acceptance | Default Lead | `rovai loom status`, then message the next assignees |

## Plan

Read `rovai loom status` first. A Mission accepts one plan and it cannot be replaced, so draft it from the Mission's full definition (`rovai mission get`) before importing. Write 2–8 tasks a member can finish and hand over; give each acceptance criterion a short stable `criterionId`. Task ids are unique across every Mission, so start each with a word from this Mission, such as `report-draft`, never a bare `t1`. Use `task_done` dependencies for ordering and `artifact_accepted` only when the downstream task needs the User-accepted output.

After importing, release every task. Releasing does not wait for dependencies; a task whose dependencies are not met cannot be claimed yet. Message only the assignees whose tasks have no unmet dependencies.

## Deliver

Claim before working; a claim lease expires, so claim again if a long task outlives it. If the claim returns `loom.dependency_unreleased`, do not retry: end the Run and tell the Default Lead the task is waiting. Register only files you produced inside the Mission's working directory, then submit with the returned artifact ids. Submitting proves the delivery is recorded, not that it is accepted. Tell the User in the Thread that a delivery awaits acceptance; do not set the Mission `completed` before the User accepts.

## Continue after acceptance

The User's acceptance does not start anyone. When a dependent task is waiting, ask the User in the Thread to reply after accepting. On that reply, the Default Lead reads `rovai loom status` and messages each assignee whose dependencies are now met.

Follow `error.recovery` on failure; see [Recovery](recovery.md).

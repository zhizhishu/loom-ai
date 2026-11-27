# LOOM

LOOM keeps a Mission's plan, task claims, deliveries and the User's verdicts on record. The User sees them in the Mission's Orchestration and Delivery tabs. Most `rovai loom` commands target the current Thread's Mission; `skill-suggest` records this assistant's learning instead.

## Who does what

| Step | Who | Command |
| --- | --- | --- |
| Check whether a plan exists | Anyone | `rovai loom status` |
| Import the plan | Default Lead | `rovai loom plan --input-file plan.json` |
| Dispatch approved assigned tasks | Core automatic control plane | system handoff delivery |
| Claim the task before working | Assignee | `rovai loom claim --task-id <id>` |
| Register each produced file | Assignee | `rovai loom evidence --relative-path <path> --task-id <id>` |
| Submit the delivery | Assignee | `rovai loom submit --task-id <id> --evidence-ids <artifactId>` |
| Accept or reject | User only | Delivery tab |
| Continue after acceptance | Core automatic control plane | dependency release and system handoff |

## Learned Skill suggestions

When a completed interaction reveals a durable reusable procedure, record it once with `rovai loom skill-suggest --input-file skill.json`. Do not use this for secrets, one-off task facts, user preferences, or memory-owned content. The result is private and pending review; it becomes authority only after review and assignment.

Skill file shape. Every object has exactly these fields:

```json
{
  "name": "triage-release",
  "description": "Triage a release before shipping.",
  "instructions": "1. Inspect evidence.\n2. Ship only after gates pass.",
  "rationale": "The user confirmed this repeatable workflow."
}
```

## Plan

Read `rovai loom status` first. A Mission accepts one plan and it cannot be replaced, so draft it from the Mission's full definition (`rovai mission get`) before importing. Write 2–8 tasks a member can finish and hand over; assign every implementation task to the active member who must produce it, copying real member ids from `rovai mission get`; give each acceptance criterion a short stable `criterionId`. Task ids are unique across every Mission, so start each with a word from this Mission, such as `report-draft`, never a bare `t1`. Use `task_done` dependencies for ordering and `artifact_accepted` only when the downstream task needs the User-accepted output.

After importing, stop the Lead run. Importing seeds the personal default control policy and Core automatically releases and dispatches every assigned task whose dependencies are met. Do not release tasks, message assignees, claim tasks, or implement assigned work from the Lead run. Write implementation tasks rather than separate stage-review tasks; the control plane dispatches the independent review itself.

Plan file shape (`rovai loom plan --input-file plan.json`). Every object has exactly these fields; leave an optional field out instead of sending `null`, and add no other fields:

```json
{
  "goal": "Write a short project report",
  "criteria": [
    { "criterionId": "report-exists", "text": "out/report.md exists and covers the three points" }
  ],
  "tasks": [
    { "taskId": "report-draft", "title": "Draft the report", "description": "Write out/report.md", "assigneeAgentId": "<worker-a-agent-id>" },
    { "taskId": "report-final", "title": "Finish the report", "description": "Produce the final report", "assigneeAgentId": "<worker-b-agent-id>" }
  ],
  "dependencies": [
    { "upstreamTaskId": "report-draft", "downstreamTaskId": "report-final", "condition": "task_done" }
  ]
}
```

Optional: `acceptanceCriteriaVersion` (top level), `description` and `assigneeAgentId` (per task), `condition` (per dependency, `task_done` or `artifact_accepted`, lowercase), `dependencies` itself.

## Deliver

Claim before working; only the task assignee can claim an assigned task. A claim lease expires, so claim again if a long task outlives it. If the claim returns `loom.dependency_unreleased`, do not retry: end the Run and tell the Default Lead the task is waiting. Register only files you produced inside the Mission's working directory, then submit with the returned artifact ids. Submitting proves the delivery is recorded, not that it is accepted. Tell the User in the Thread that a delivery awaits acceptance; do not set the Mission `completed` before the User accepts.

## Continue after acceptance

User acceptance is recorded by Core. When it satisfies a dependency, the automatic control plane releases and dispatches the next approved task; the Lead does not message the next assignee manually.

## Authorized stage review and handoff

Importing a plan seeds the personal default control policy: all imported tasks, an independent active reviewer, a small dispatch/rework budget and a 24-hour expiry. The User can inspect, pause, resume or rewrite that approval in the Orchestration tab. Only the User can change or pause this policy.

An assigned reviewer first runs `rovai loom inspect --task-id <id>`, checks the frozen candidate and its evidence, and submits `rovai loom stage-review --input-file review.json`. The response's `reviewSubmission` block carries the exact shape: copy `taskId`, `candidateId`, `policyRevision` and `manifestHash` from it, and answer every `criterionId` it lists exactly once. Each `criteriaResults` entry uses `satisfied` (a boolean) — there is no `passed` field — and may cite evidence ids of that candidate plus a note. Do not edit the candidate under review. The block is guidance only: it records nothing, approves nothing, and only the User accepts a delivery.

Review file shape (`rovai loom stage-review --input-file review.json`). Every object has exactly these fields:

```json
{
  "taskId": "report-draft",
  "candidateId": "lcand_example",
  "policyRevision": 1,
  "manifestHash": "<the 64-character hash loom inspect returned>",
  "verdict": "request_changes",
  "reason": "out/report.md still carries the placeholder line",
  "criteriaResults": [
    { "criterionId": "report-exists", "satisfied": false, "note": "two sections are missing" }
  ]
}
```

`pass` is internal stage approval and still waits for User acceptance. `request_changes` returns the same task for rework; the producer must acquire a new claim, use a new evidence path for changed content, and submit a new candidate with previousCandidateId pointing to the latest candidate. `blocked` stops that task for a User decision. A reviewer cannot review their own output.

Core may deliver one system handoff message for the next approved action. Read current state before acting. A pause prevents the next automatic dispatch but does not terminate a running Run. A limit, expired approval, lost authority or unknown execution outcome stops automatic progress. Report it instead of repeatedly starting another Run. Human acceptance and external publication remain separate decisions. The selected runtime keeps its existing execution permissions; a handoff is not extra permission to publish, deploy or access another project.

Follow `error.recovery` on failure; see [Recovery](recovery.md).

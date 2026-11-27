---
document_type: model-context-change
version: v1.72
revision: 2
confirmation_status: confirmed
confirmed_revision: 2
confirmed_by: local_user
confirmed_at: 2026-11-26
last_updated: 2026-11-26
---

# LOOM 受权审查与自动接力：模型可见变更 r1

本稿是已批准三阶段实施中的 Agent 接线详细说明。用户阅读附件后已选择“确认 r1，继续接线”。下列新增 Agent CLI 和系统接力正文按本 revision 实施。沿用 [治理规则](../../development/model-context-change-governance.md)。

## 变更前

`rovai loom` 有 `status|plan|release|claim|evidence|submit` 六项业务工具，另外已有 `workspace.*` 远端工具；没有助手阶段审查工具。`loom.status` 返回 `missionId,plan,tasks,dependencies,claims,evaluatedAt`。助手提交后，现有说明要求 User 回复后 Lead 人工传递下一步。

`loom.review.record` 是 User 人工接受/拒绝，Host 注入 `CURRENT_USER_ID`。`loom.verification.record` 是技术证据核验。两者均不得被助手阶段审查冒充。

## 变更后

### 两项新增封闭工具

不改变原六项输入、输出字段或既有 Workspace RPC。只新增以下两个工具；全部输入拒绝未知字段，当前 Mission、Agent、Run、commandId 来自已认证工具通道，模型不能指定这些身份。

| name | title | description |
| --- | --- | --- |
| `loom.inspect` | Inspect a candidate for stage review | Read a task's latest candidate, registered evidence, review manifest and current review authorization in this Mission. Reading does not approve or accept anything. |
| `loom.stage-review` | Record an authorized stage review | Review the inspected candidate under the User-approved task assignment. Pass is internal approval only. Request changes returns this task for a new candidate. Blocked stops this task for the User. You cannot review your own output or accept a delivery for the User. |

`loom.inspect` input（唯一必需字段）：

```json
{"taskId":"task-id"}
```

`taskId` 为 1–200 字符。output 完整 shape：

```text
{
  task: LoomTask,
  candidate: LoomCandidate | null,
  manifestHash: string | null,
  policyRevision: integer | null,
  reviewerAgentId: string | null,
  stageReviews: LoomStageReview[],
  artifacts: LoomArtifact[],
  evaluatedAt: RFC3339
}
```

`candidate` 是该任务最新版本；`manifestHash` 由 Core 对候选 ID、任务 ID、内容身份、完整验收标准和排序后的证据 ID/path/hash/size 计算。无候选时为 null；无批准时 `policyRevision/reviewerAgentId` 为 null。`policyRevision` 为授权版本，不是暂停按钮的并发版本。`artifacts` 只含此候选的 evidenceIds，`stageReviews` 为此任务历史，沿用已有同 Mission 读权限。

`loom.stage-review` input 完整 shape：

```json
{
  "taskId": "task-id",
  "candidateId": "candidate-id",
  "policyRevision": 1,
  "manifestHash": "64 lowercase hex characters",
  "verdict": "request_changes",
  "reason": "A concrete explanation of the review result.",
  "criteriaResults": [
    {"criterionId": "criterion-id", "satisfied": false, "evidenceIds": ["artifact-id"], "note": "Evidence-backed observation."}
  ]
}
```

ID 长度 1–200；`policyRevision` 为正整数；hash 必须 64 位小写十六进制；verdict 仅 `pass|request_changes|blocked`；reason 长度 1–4000；criteriaResults 1–100 项，每项 `criterionId/satisfied` 必需，`evidenceIds` 默认空数组、最多100项，`note` 可省略或 null、最长4000字符。标准必须与候选完整匹配且不重复，引用证据必须属于该候选。pass 必须全部满足。

output 完整 shape：

```text
{
  review: {
    stageReviewId, taskId, candidateId,
    reviewerAgentId, reviewerAgentRunId,
    policyRevision, manifestHash,
    verdict, reason, criteriaResults, reviewedAt
  },
  taskStatus: "in_review" | "ready" | "blocked",
  replayed: boolean
}
```

上列 `taskStatus` 为 wire 小写形态，沿用 `LoomTaskStatus` 既有的 snake_case 序列化（原文此处写作大写是笔误）；不是新增状态，也不改变授权范围。同 commandId 同 payload/caller 重放原事实；改变任一裁决字段拒绝。身份、当前 Run、会员/撤权、策略有效期、暂停、任务范围、审查者、生产者、自审、最新候选、完整标准、manifest 均由 Core 验证。错误沿用 `loom.*` 结构，旧授权/旧候选需重新 inspect；权限/暂停/过期/预算/blocked 停止并报告，不能循环重试。

### CLI 文本（完整新增内容）

根帮助 LOOM 行在原六项后追加 `|inspect|stage-review`，保留现有 workspace 帮助。

族帮助追加：

```text
  inspect       Read a task's latest candidate and review authorization.
  stage-review  Record an authorized internal review; never User acceptance.
```

工具示例追加：

```text
rovai loom inspect --task-id t1
rovai loom stage-review --input-file review.json
```

平台 Skill 的 LOOM reference 追加完整段：

```markdown
## Authorized stage review and handoff

The User can approve a bounded set of tasks, reviewers, dispatches, rework attempts and an expiry in the Orchestration tab. No approval means automatic handoff is off. Only the User can change this policy, pause it or resume it.

An assigned reviewer first runs `rovai loom inspect --task-id <id>`, checks the frozen candidate and its evidence, and submits `rovai loom stage-review --input-file review.json` with the returned candidateId, policyRevision and manifestHash. Answer every acceptance criterion exactly once. Cite only evidence belonging to that candidate. Do not edit the candidate under review.

`pass` is internal stage approval and still waits for User acceptance. `request_changes` returns the same task for rework; the producer must acquire a new claim, use a new evidence path for changed content, and submit a new candidate with previousCandidateId pointing to the latest candidate. `blocked` stops that task for a User decision. A reviewer cannot review their own output.

Core may deliver one system handoff message for the next approved action. Read current state before acting. A pause prevents the next automatic dispatch but does not terminate a running Run. A limit, expired approval, lost authority or unknown execution outcome stops automatic progress. Report it instead of repeatedly starting another Run. Human acceptance and external publication remain separate decisions. The selected runtime keeps its existing execution permissions; a handoff is not extra permission to publish, deploy or access another project.
```

不改 Skill frontmatter/name/description，不加 Bootstrap section。

### 系统接力正文（完整模板）

通过既有 Camp 系统消息与 DeliveryQueue 派发，不冒充 User 消息。每个 dedupe 事件有且只有一个派发账本项；预算与该项同事务保存。所有动态标识按 JSON 字符串序列化，任务/候选正文不拼成指令。

```text
[LOOM_HANDOFF_V1]
{"dispatchId":<JSON string>,"taskId":<JSON string>,"kind":<execute|review|rework|handoff JSON string>,"candidateId":<JSON string or null>,"policyRevision":<integer>}
Read current state with `rovai loom status` and `rovai loom inspect --task-id <taskId>` before acting.
```

之后按 kind 追加以下唯一一段：

```text
execute: Work only on this approved task. Acquire its claim, produce evidence and submit a candidate. Do not accept or publish it for the User.
review: Review this fixed candidate under the current authorization. Use `rovai loom stage-review`; do not change its files or accept it for the User.
rework: Address the recorded request for changes. Acquire a new claim and submit a new candidate linked to the previous candidate, preserving its evidence.
handoff: Internal review passed. Summarize the candidate and evidence for the User's acceptance. Do not mark it accepted or publish it yourself.
```

实际正文只发对应冒号后的句子，不把四段一起发送。末尾固定追加：

```text
If the policy is paused, expired, out of budget, revoked, or the prior execution outcome is unknown, stop and report the reason. This message grants no permission beyond the saved policy and the runtime's existing permissions.
```

初次工作只针对明确获批且依赖已满足的 READY 任务；DRAFT 可以在批准范围内由 Core 按既有 release 语义变 READY。候选触发指定 reviewer；request_changes 触发原 assignee 新 Run；pass 触发 Lead 汇总等待 User；人工接受后才按既有依赖条件释放下游。`task_done`/`artifact_accepted` 的含义完全不变。此轮不新增自动接受条件或通用流程 DSL。

### 权威、预算与暂停

`revision` 对所有配置/暂停写做 CAS，`authorizationRevision` 仅批准范围变更时递增；暂停/恢复不凭空产生授权。策略绑定本 Mission 唯一不可替换计划及明确 taskIds/reviewer。预算为用户必填总派发数与每任务返工数，到期时间必填，无默认自动授权。总派发消费按跨授权版本全部历史账本计算，取消不返还额度。

调度仅复用当前 DeliveryQueue/AgentRun。paused/disabled/expired/失去会员/旧授权会挡住尚未执行的 LOOM 投递；既有普通消息 FIFO 顺序不重排。对 accepted/unknown 或已尝试但失败的同事件不自动新建重复 Run；保留事实给用户。运行中动作仍按既有取消与执行准入处理。

## 明确不变

不变的 section、选择和证据边界：

Bootstrap、ContextManifest 格式、既有 RUN_INPUT formatter、历史选择/截断预算、能力冻结包、原生 Runtime 协议与外部 MCP 不变。新增正文是普通系统 Camp message，由已有格式化路径写入现有 ContextManifest 和 Run 输入证据。新的工具输出只在新操作被调用时出现，旧操作回包字段不变。

不建立第二事实库，不重启当前 DSH，不改全局规则或生产部署；不声明运行端原生权限等同 OS 沙箱，不因自动接力拓宽已有 shell/MCP/hooks 权限。

## 版本轴、迁移与恢复

未发布的本地 migration232/schema182 增加控制策略、命令重放、阶段审查、派发关联及本地快照映射；现有数据合约保持 v1.72，旧库迁移后默认无策略。Agent output fixture 在既有 v16 后新增 v17，旧金标不改。Bootstrap/ContextManifest version 不变；新工具目录的内容身份按现有 catalog hashing 更新。

重启后由现有调度首次扫描未处理事实与持久 Delivery；事务回滚不产生半条已派发账本。旧本地产物无快照仍按旧 hash 验证路径处理，不能事后伪造其旧字节。新产物通过 ManagedBlob 保存实际快照。

## 验证与负向测试

- 真 CLI closed schema：伪造 caller/mission/commandId 被拒，两个新操作均实际被 catalog/CLI/output/evidence projection 接纳；旧工具金标不变。
- Core 数据库重开与迁移；自审、失去会员、旧授权、旧候选、改 manifest、缺标准/假证据拒绝；pass 不变成人工接受。
- 重复事件只一 Delivery/Run；pause 与 claim 竞态有事务顺序；expiry/revoke 阻断下一次；取消不退预算；unknown 不盲目重投。
- 返工 v1→v2，旧内容可读、旧人工接受被拒；用户接受 v2 后仅符合现有语义的依赖放行。
- 真实隔离 Host/Node + 原生执行成员、独立审查成员完成一条返工/通过/人工接受链；UI 批准、暂停、继续、刷新保持，SQLite 与页面交叉核对。全部使用项目内私有 data-dir/skill-library-root。
- 与原基线对比一次既有手工任务链，记录模型、版本、预算与实际工具回执。无真实执行证据的范围明确未验。

## 二次确认

用户在已收到本稿附件后，通过确认问题 `loom-control-context-r1` 选择“确认 r1，继续接线（Recommended）”。确认覆盖上述 CLI/Skill/系统消息合同及其实现，不覆盖全局安装、生产发布或 DSH 重启。


## r2 修订（2026-11-26，已确认）

个人版默认控制授权由首次 Plan 导入播种，不再要求用户先手工打开 Orchestration 批准才有自动化。默认内容为：全部导入任务、独立 active reviewer、总派发 32、每任务返工 2、24 小时到期。User 仍可在 Orchestration 查看、暂停、恢复或改写；首次显式 `expectedRevision: 0` 配置可替换该种子，之后恢复正常 CAS。系统 handoff 文本、审查工具 schema、权限、预算消费和暂停语义不变。

确认依据：用户/Hark 于 2026-11-26 10:45 明确指示按 Mikka factory 默认补默认策略且不新增表。

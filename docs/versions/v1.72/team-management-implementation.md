---
document_type: implementation-plan
version: v1.72
status: implemented-gate-failed
last_updated: 2026-10-22
---

# Team 管理实施记录

- Work item: Issue #504；Thread sequence 29 确认实施中文/英文 V9 交互及上下文 R1。
- Worktree: `/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-team-management`
- Branch: `rovai/team-management`
- Base: `origin/main` / `9a5127ed8a26531808a61c62565c097cf498fd43`
- Governance: 功能分支文档先行，无主线先行要求。
- Status: 功能已实现；通用上下文 Gate 为 `degraded`，不能作为放行通过。
- Validation: Rust、TypeScript、构建、组件交互和五项真实模型定向验证已完成，详见下文。
- Next: 本分支供审阅；通用 Gate 的已知失败、耗时退化与语义证据缺口见下文，不把定向验证外推为语义门禁通过。

## 已确认范围

Team 独立入口、列表与详情、可选指引、下拉添加队员、行内悬停 Make lead/Remove 图标操作、
复制/删除及未保存防护；MCP 风格空态；6/12 人与 Mobile。中英文及双主题沿用生产组件。

General 保留一键创建配置：Team 或 Custom；原偏好保留为 Custom，不自动建 Team，不提供管理跳转。
新对话 Custom 在第一项且可选择队员和队长；保存的 Team 只读选择，不在 Dialog 调整、另存为 Team。
新对话主按钮沿用中性色。Memory 入口移至 Settings，待审核快捷入口和数字保留。

上下文只按 [R1](model-context-change-team-guidance.md)增加可选 Bootstrap 段，无会话级指引编辑。
当前 Thread 的后续成员和 Lead 仍独立于 Team 模板。

## 实施次序

1. Team 持久化、CRUD、版本冲突与共享偏好；旧数据不自动生成 Team。
2. 创建时复验所选 Team，固定启动指引；绑定、恢复、预算与旧版本兼容。
3. Desktop/Web/Mobile 共用 Team 界面、General 和新对话入口；双语与主题检查。
4. 定向测试、迁移、文档门禁、Rust 默认回归、构建和隔离 UI/Runtime 验收。
5. 提交并推送任务分支。按 User 的当前偏好不自动创建 PR，不关闭 Issue，不安装日常 App。

## 测试准入记录

- Team 事务新增独立 owner `teams::tests::templates_preserve_custom_defaults_and_freeze_thread_guidance`：旧代码无 Team 事务入口，不能由现有 Thread 创建测试覆盖 Team CRUD、旧 JSON 导入和删除偏好原子回退。使用 `extended-tests` 与独立数据库克隆；最小命令 `cargo test -p rovai-core --features extended-tests teams::tests::`。
- Bootstrap 格式、字节预算与恢复扩展现有 `bootstrap_formatter_has_fixed_three_section_and_identity_field_order`、`newly_bound_session_bootstraps_on_its_current_generation`、`single_chat_materializes_conversation_input_with_a_memory_free_bootstrap`，不新增同构 fixture。旧失败输入是非空 Team 指引与 Single Chat 同时关联同一 Thread。最小命令分别按上述测试名筛选，DB/Runtime owner 使用既有 `slow-tests`。

## 已实现边界

- [Team Templates v1](../../contracts/team-templates-v1.md)：User 专属 CRUD、版本比较、持久命令回执；删除默认 Team 与清理选择在同一事务，独立 Custom 保留。
- Migration 209 / schema 159：导入旧 JSON 创建偏好，不自动生成 Team；Thread 创建使用同一版本的权威成员、队长和指引，失败整体回滚。
- [Bootstrap v6](../../contracts/native-session-bootstrap-v6.md)：仅非空的创建时指引进入 Bootstrap；旧证据按旧版本恢复，Single Chat 始终省略；实际字节预算与冻结输入包含指引。Charter、Binding、Dynamic Context 和 Profile 版本不变。
- [Team workspace](../../ui/components/team-workspace.md)：生产布局、下拉选人、行内操作、未保存防护、回执未知时原命令重试；Desktop/Web 共用。Memory 移入 Settings，保留待审核快捷入口。
- 复制前选择“保存并继续”会复制刚保存的内容；手机端 Team 保留全局导航入口，Memory 只显示设置页标题。

## 验证记录

测试日志、隔离计划、报告和截图保存在本次 Thread 附件的 `team-management-validation/`，不向仓库提交 Runtime 原始私有证据。
附件根目录为 `/Users/murray.xue/.rovai/instances/v1-ea1b0333b2d3194639a0b5a284275214dc868bf6ebe8bea219653f7c2cd7a4b3/attachments/rvcamp_01m579sezwfgsrrvsmhq203n8e/`。

| 检查 | 结果与范围 |
| --- | --- |
| `cargo check --workspace --jobs 4` | 通过 |
| `cargo test --workspace --jobs 4` | 474 通过、0 失败；1 项既有人工检查忽略 |
| Team 独立事务 owner | 1 通过，覆盖迁移兼容、CAS、重复命令、创建回滚、指引固定、删除和 Custom 保留 |
| `context::slow_tests::` | 45 通过，包含 Single Chat、省略、冻结恢复、大小预算 |
| 数据库现态与迁移检查 | current 3 项、contract preflight 1 项、historical rows 1 项通过 |
| `pnpm test` | Vitest 246 文件 / 2782 项通过；Node 357 通过、2 项平台跳过；文档与 Skill 门禁通过 |
| 最后 UI 修正后的定向 Vitest | App、GeneralSettings、创建偏好、Web 偏好四文件 204 项通过 |
| `pnpm typecheck` | 最终修改后通过 |
| `pnpm exec electron-vite build`、`pnpm build:web` | 最终修改后通过；Web 保留既有大 chunk 提示 |
| UI 实测 | 中文日间、英文夜间；4/6/12 人、390×844、空态、下拉选人、设队长、CRUD、未保存提示、Custom 往返保留、Team 只读摘要 |

组件验收入口为 `node scripts/fixtures/team-management/serve.mjs`；用途与限制见
[fixture 说明](../../../scripts/fixtures/team-management/README.md)。截图为 `team-desktop-day.jpg`、
`team-mobile-night.jpg`、`team-empty-day.jpg`。这是生产组件的隔离验收，不表示运行或安装了日常 App。

### 定向真实模型验证

使用独立 `automatic_acceptance` Core，数据、Skill Library、MCP 与运行目录均在
`team-management-validation/guidance-probe-02/`。Codex CLI 真实完成 5 个 Run：

1. 首次启动读取 `TEAM_ALPHA`。
2. Team 修改为 `TEAM_BETA` 后，旧 Thread 中首次启动的另一队员仍读取 `TEAM_ALPHA`。
3. 新 Thread 读取 `TEAM_BETA`。
4. 当轮 User 明确要求 `USER_OVERRIDE` 时按该要求回复。
5. 删除 Team 后，旧 Thread 恢复仍读取 `TEAM_ALPHA`。

全部通过，报告为 `guidance-probe-report-02.json`，Core 已正常退出。候选 Core digest 为
`ee44a43d26534c63b9b63f4e18d46ece230e3ee73c45d9b3bada0e1f1fdccb35`。
该结果只证明上述合成任务的行为，不替代通用语义 Gate。

### 保留的初次失败

- 初次完整 Vitest 在并行编译时出现两项 5 秒超时；定向 79 项及之后完整 2782 项均通过，没有为此放宽超时。
- 两项旧 context fixture 的版本断言在未改动基线也失败：attachment-only 仍期待 39/39/10；legacy claim 实际创建当前 40 却期待 38。修正既有测试的 fixture/断言后 45 项通过，基线原始日志保留。
- Node product contract 仍期待 schema 158，按实际 Migration 209 更新为 159 后全套通过。
- 首次定向驱动未提交 execution admission，却要求 `accepted` 回执，实际收到仅发布消息的 `applied`；当次未执行模型验证，报告 `guidance-probe-report.json` 保留。修正驱动后使用全新 `guidance-probe-02` 数据目录完成五项验证，没有改动产品实现。

## 通用上下文 Gate

基线为同一 base 的独立 detached worktree `rovai-ai-team-baseline`；候选与基线分别构建，
每个 slot 使用独立 `automatic_acceptance` 目录，具体路径预先记录于 `isolation-plan.json`。
固定 common12、每例一次、新旧两侧共 24 slots、最多两个并行 Case；本 campaign 最多两次尝试。
固定计划摘要为 `97bcacba7181132b44fde8d86de53ed744cd1617475d6c5899240bfae1a70778`。

`attempt-01` 已完成全部 24 slots：两侧各 16/16 合同检查通过，硬性任务各 11/12 通过，
24 次均正常收敛并回收 Runtime，无评测器故障。报告最终为 `degraded`：

- `DEMO-105`：新旧版本都未创建要求的 `report.json`，属于已有失败；报告明确 `newRegression: false`。
- `DEMO-112`：两侧产物验收通过，但 dispatch-to-terminal 从 22.520 秒增至 204.424 秒，超过固定耗时门槛。
  候选只有一个 Run、无 A2A、没有超预算或残留进程；主要间隔位于同一原生 Run 的两条工具完成事件之间
  （16:01:08.055 至 16:04:13.389 UTC）。现有证据不足以区分模型决策、提供者等待或其他原生 Runtime 延迟，
  不能认定为 Team 代码导致，也不能取消这项已观测退化。
- Judge 固定为 `null`，因为没有可追溯的固定模型 snapshot；语义评价不完整，通用质量总分为空。
  109 条证据缺口覆盖 12 个 Case；不得把部分规则分数当成完整语义分数。

本次保留一次完整尝试，不改标准、不挑选成功副本。没有已定位的 Team 实现偏差可供修复重跑；
不以重复运行消除现有失败。正式放行仍需解释或解决耗时退化，并补齐合格 Judge 的同标准证据。
通用 Case 不选择 Team，指引的实际模型行为由上面的独立五项验证覆盖。

已核对 `campaign/index.html`、`campaign/attempt-01/report.html` 的本地内容、JSON 的全部 slots、
`regressions`、`evidenceGaps`、`evaluationFailures` 和 `resourceChanges`。浏览器策略拒绝 `file:` URL；
因此报告核对使用本地只读解析，没有绕过策略或宣称完成报告的浏览器渲染验收。产品界面截图来自前述独立 UI fixture。
完整报告、首次失败和原始证据均保留在附件；实现 worktree 与只读基线 worktree 保留供复查，日常 App 未启动或替换。

## 2026-10-19 状态一致性修复

Thread sequence 34 的两项 P2 均确认存在。本次只修复前端状态传递，不变更 Core、迁移或 Bootstrap：

- TeamWorkspace 在未保存确认之后读取当前保存回执，BusinessApp 将完整 Team 传入新对话；名称、名册和提交版本取自同一快照。列表晚到时只补齐缺失的初始选择，保留名称、工作区及主动选择的 Custom；已有 Team 快照不随外部刷新替换。
- 默认配置失效接口改为必填 `{ expectedTeamId, expectedDefaults }`，由判断失效的界面快照提供两者。Desktop/Web 原样传递，Host 不再从可变的最近观察值补 Team ID；Core 现有比较条件不变。

回归复用现有 Electron 夹具，实际挂载 BusinessApp、TeamWorkspace 与 NewConversationDialog；手动完成
save/list Promise，不用 sleep 控制竞态。旧代码在保存 v2、list 尚未完成时实际提交 v1；修复后提交 v2，
并覆盖刷新后重试、晚到列表保留草稿、外部修改保留选定版本及 Custom 选择。
Host 回归覆盖 Custom 为 null 和未变化名册两种来源：保存 A 的旧观察，确认 B 后再请求失效 A，B 仍被选择且保持已确认。

本轮验证日志使用附件 `team-management-validation/state-consistency-*` 前缀。230 项定向 Vitest、
`pnpm typecheck`、`pnpm build:desktop`（含 Web）及文档治理通过。隔离 Electron 的 Team 创建、
一键草稿、AI 队员创建和真实 preload 桥接四项分次全部通过。
扩展回归先发现旧夹具使用投影 schema 8、遗漏 `teams.list` 和引用已删除的运行配置 class；
更新为当前协议和可访问名称后通过，初次失败日志保留，没有改动对应产品行为。
通用上下文 Gate 保持上节的 `degraded`，本次状态一致性测试不替代语义门禁。

## 2026-10-19 创建目标与恢复有效性边界

Thread sequence 37 的两个边界均确认存在，基线为 `accf81846cf8be5c2318eb0952277935b5ebba99`：

- 新对话与复制共用一个确认后的 Team ID 检查。保存可以更新同一 ID 的版本；放弃草稿导致列表回退到其他团队或空态时，取消原动作并提示重新选择。
- Core 的默认配置失效事务在比较预期来源后复用 `selected_available`；所选名册已恢复有效时忽略迟到通知，不增加客户端同步字段，不改变 Team 模型或 Bootstrap。

测试继续扩展现有 owner：生产 TeamWorkspace 的 Electron 用例覆盖 A 删除后回退 B/空列表，
断言新对话和复制都没有发出，同时保留上一轮的保存回执/列表晚到控制场景。
`teams::tests::templates_preserve_custom_defaults_and_freeze_thread_guidance` 在现有数据库中验证真实失效、
同 ID Team v2 修复、重新确认、旧失效通知以及一键准入；不新增 Rust 测试或平行数据库夹具。
旧失败输入是同一 Team ID、同一 Custom 配置在修复并重新确认后的迟到失效请求。
最小 Rust 命令为 `cargo test -p rovai-core --features extended-tests --lib teams::tests::templates_preserve_custom_defaults_and_freeze_thread_guidance`。
同时将该 owner 所用的 `fresh_schema_database_fast_owned` helper 开放在 `extended-tests`，
修正原先只在 `slow-tests` 提供导致上述命令不能编译的夹具配置；测试层级和业务断言不降级。

验证记录使用附件 `team-management-validation/identity-recovery-*` 前缀。新增断言在产品修复前
分别复现误开其他团队和重新失效；修复后 SQLite 事务 owner、生产组件的四个删除回退组合与
上一轮五个控制场景、230 项定向 Vitest、类型检查、Desktop/Web 构建和 Rust 格式检查通过。
此轮没有改动或重跑模型上下文；完整 Gate 仍为 `degraded`，不以这些定向回归作为放行证据。

## 2026-10-19 Custom 可用性与失效通知收敛

基线 `24bc9508982a8a1e45d58b1368cc8c313781f7cd`，处理 Thread sequence 43 的两项反馈。
复用原 Electron owner，挂载生产 BusinessApp、NewConversationDialog、useTeams 与 Host 偏好包装层；
修复前四组 Custom 输入（开/关一键 × 列表拒绝/未完成）均被阻断，同内容失效回执也实际触发第二个请求。
这确认了生产 React 中的重复触发，不以受控夹具推断真实 App 的请求频率或无限循环。

- 先读取偏好，只有 Team 一键创建等待新列表；Custom 可直接创建，普通弹窗独立打开。列表加载/失败与重试在团队选择处呈现，不阻止显式选择 Custom。Team 读取失败不自动使用 Custom，旧列表也不冒充刚取得的快照。
- 偏好内容未变时保留原 state 对象；useTeams 每次刷新标记 loading，刷新期间不依据旧名册请求失效。Core 的事务内可用性复验保持，不增加同步字段或请求状态。

最终生产组件回归通过，覆盖上述四组 Custom、Team 失败后显式选择、Team 一键等待新版本、
失败后重试的 loading/版本，以及同内容回执只发送一次、列表恢复停止、新失效观察仍能提交。
原保存回执/迟到列表/Custom 草稿/删除后动作身份用例全部保留。Promise 显式完成，无 sleep 排竞态。
日志以附件 `team-management-validation/custom-availability-*` 命名，保留修复前失败和最终成功记录。

`pnpm test` 通过：Vitest 2784 项，主 Node 集合 357 项通过、2 项按原配置跳过；类型检查、
Desktop/Web 构建、文档治理（含真实 base 的 CI 检查）通过。默认 Rust workspace 474 项通过、1 项忽略。
错误态在隔离 Electron 中核对中文日/夜主题和 390×844 窄屏，重试与 Custom 创建按钮均可见，创建可用。
截图夹具初次因临时脚本错误引用 Electron 模块而未启动成功，修正脚本后完成；没有据此更改产品代码。

Team 模型、Core 和 Bootstrap 本轮未改；没有重跑模型或追加协作场景，完整上下文 Gate 仍为 `degraded`。

## 2026-10-19 后台刷新与请求期间的新观察

基线 `ca5f238ae98b5a29d8f16b3df0ae721f01cc7aa4`，处理 Thread sequence 45 的两个剩余边界，
保留 Custom 独立创建、同内容偏好保留引用和每次刷新标记 loading 的修复。

现有 Electron owner 挂载生产 BusinessApp、TeamWorkspace、useTeams 和 Host 偏好包装层，
修复前用可控 Promise 复现：后台列表未完成时请求离页，确认框不存在；已打开的删除确认框也被隐藏；
空团队库中的新草稿同样被加载态隐藏。失效回归先让 O2 名册完成并渲染，再完成 R1 的同内容回执，
实际得到 `expected 2, got 1`，确认遗漏发生于生产组件，不再只有隔离逻辑模型的证据。

- TeamWorkspace 仅在没有团队和草稿时显示整页加载态；其余刷新保留原编辑 DOM、草稿与确认框，在保存栏显示加载状态。
- BusinessApp 只记录请求期间是否有新观察。当前请求完成后触发一次 React 重查，读取最新偏好与名册；多个观察合并，没有新观察时不重试，最新名册恢复有效时不发请求。没有新增同步协议或 Core 字段。

最终 Team 生产组件回归有 20 组场景，包含取消/放弃离页可用、刷新完成不替换草稿、删除确认框、
首次加载与空库新草稿，以及 O2 先到/R1 后到、更新为有效 O3 后不重放 O2、第二次同内容回执不重复。
原保存回执、迟到列表、Custom、删除后动作身份和请求结束后新观察的回归全部保留。
最小复核命令：`node --test --test-name-pattern='Team creation' scripts/lib/member-creation.test.mjs`。
这些 Promise 的完成顺序由测试显式控制，没有使用 sleep。

原始失败、最终三项 Electron 创建流程以及其他验证日志使用附件
`team-management-validation/refresh-observation-*` 前缀。中文日/夜主题、390×844 窄屏的刷新中编辑页和
离页确认框已核对，草稿、提示与操作均可见；临时截图脚本初次因插入检查点缺少分号而超时，
修正脚本后完成截图，产品代码未为截图调整。

类型检查、Desktop/Web 构建与文档治理通过；`pnpm test` 中 Vitest 2784 项、主 Node 集合 357 项通过，
2 项按原配置跳过；三项 Electron 创建流程全部通过；默认 Rust workspace 474 项通过、1 项忽略。

本轮没有修改 Team 模型、Core 或 Bootstrap，也没有重跑真实模型；完整上下文 Gate 保持 `degraded`。

## 2026-10-22 三人协作定向观察

按 Thread sequence 51 追加一次真实 Runtime 协作观察。固定源码
`9aec61f6e434fd9133052fb96d956612e9eceadd`，通过现有 `eval-gate.mjs build`
构建不可变 Core，SHA-256 为 `9e3f0ecff025798e44c878d79b6867449294ae6f017ef721717921968a6bf5e2`。
本轮没有合并 main，也不覆盖 main 新增的 Claude Code / CodeBuddy Bootstrap 规则。
这是派生自 DEMO-103-budget-v2 的定向观察，复用原功能 verifier；修改过任务说明和调度，
不作为已注册 Case 或完整 Gate 的替代。没有产品代码变更。

三个隔离队员分别负责实现与交付、独立审查、测试验收。先以两人 Team 创建 Thread，
首轮结束后修改 Team 模板并通过真实成员加入命令加入测试验收者，再由用户消息要求负责人交接。
两组分别为空指引和有指引；其他角色、任务、配置相同，每组只运行一次，不择优重跑。
配置均为 Codex CLI `0.163.0` / `gpt-6.1-sol` / medium；10 个 Run 的冻结模型配置一致，
Runtime 未回报 observed model ID，因此只能确认下发配置，不能额外证明服务端实际模型身份。
每阶段预算 300 秒、8 个 Run 责任、6 次 accepted A2A，总驱动预算 1500 秒。
数据、Skill Library、MCP 配置、工作目录与缓存均隔离，未改动日常 App 或名册。

启动前冻结的指引为：

> 队长负责实现与整合。提交最终结果前，先请独立审查者复核需求、边界与修改范围，处理反馈后再交付。后来加入的队员先按邀请任务接手，不重做已完成工作。队员把结果交回队长，由队长收取证据并汇总。交接简洁列出「已完成」「验证依据」「待办」；验证依据写实际执行的命令或具体反例。只为明确的新动作寻址，不为致谢、确认或重复结论唤醒队员。

| 观察 | 空指引 | 有指引 |
| --- | --- | --- |
| 首轮 | 负责人直接交付，审查者未启动 | 负责人请求审查，审查者实际运行测试和额外断言，再交回负责人 |
| 后加入者 | 新增 5 项边界测试，负责人复跑并汇总 | 新增 3 项边界测试，负责人复跑并汇总 |
| 最终测试 | 9/9 | 7/7 |
| 两阶段耗时 | 72.399 / 127.263 秒 | 112.757 / 89.328 秒 |
| Run / 队员间消息投递 | 4 / 2 | 6 / 4 |
| 原功能 verifier | 两阶段各 3 项检查通过 | 两阶段各 3 项检查通过 |

队员间投递数从公开消息及 Message Delivery 逐条计算，不采用 export 中旧 A2A 聚合计数。
6 次队员间投递均是明确任务或结果交回；未见致谢唤醒、重复索取结果或未结束的交接。
10 个 Run 全部 succeeded，10 个 Runtime Input Delivery 全部 accepted；两个 Core 正常退出，
进程检查无残留。数据库只读提取显示全部 claim 使用创建时指引，第三位队员同样如此；
空指引组在模板新增指引后仍为空。有指引组新人使用原「已完成 / 验证依据 / 待办」格式。
Team 模板修改后的「结论 / 风险 / 建议」没有替换会话副本；Dynamic Payload 没有 TEAM_GUIDANCE 区块。
这验证了本样本的固定上下文与真实交接，不能推导所有 Runtime 的物理单次投递。

必须保留的未通过项与评测限制：

- 有指引组向 `tests/public.test.mjs` 追加测试，原公开用例逐字保留，但文件 hash 改变，
  因而未通过冻结计划中的「公开测试文件不变」检查。任务只写了「保留既有公开测试」，
  没有明确禁止追加到同一文件，属于计划与给定任务边界不一致；不能把它写成删除测试或产品故障，
  也不在观察后放宽门槛并宣称全项通过。两组 package.json 均未变，改动均在允许目录内。
- 事后只读诊断发现字符串 value 的语义分歧：输入 `" value "` 时空指引组输出 `"value"`，
  有指引组保留 `" value "`。按任务「字符串字段 trim」的字面要求，后者不符合；
  若意图是 value 内容原样保留，则任务必须明确例外。原 verifier 没有字符串 value 断言，
  独立审查反而沿用了实现者的保留假设。这是本次审查没有发现的差异，不能用原断言通过掩盖。
  该诊断单独记录，不倒改原评分，也不据此认定团队指引改善了功能正确性。
- 夹具只执行了 git init、没有提交基线。审查者正确披露 git diff 无法独立证明历史范围；
  本轮范围结论来自驱动保存的前后文件 hash。后续正式 Case 应在冻结前提供可审查的基线，
  并明确字符串 value 与公开测试文件边界，不能用重跑挑选好结果。

两组阶段耗时之和分别为 199.662 秒和 202.085 秒，工作量不同且各只有一个样本，
不能据此报告提速或回退。三人使用同一模型配置，不代表异构模型之间的独立复核。
没有 pinned semantic Judge，不计算语义质量分；完整上下文 Gate 继续为 `degraded`。
当前证据支持保留简单 Team / Bootstrap 方案，以及用少量团队指引约定交接与审查；
不支持扩大团队模型或声称协作质量已经全面通过。

证据位于本 Thread 的 `team-management-validation/collaboration-20261022/`：
`plan.json` / `plan.sha256` 在运行前冻结，计划 digest 为
`fce0f200aba80c1a4bedd32f191405db07101a3b8e0495cf27722477260bd407`；
`run.mjs`、`results.json`、各阶段 snapshot / 测试日志、`analyze.py` /
`evidence-summary.json`、`diagnose.mjs` / `post-observation-checks.json` 保留实际顺序、
生产 claim / delivery 证据与事后诊断。分享包提供可核对的投影和工作文件，原数据库、构建产物
及 Runtime 缓存留在隔离目录，不进入仓库。文档记录不替代这些原始观察。

## 2026-10-22 三 Runtime 开发窗口实测

按 Thread sequence 55 改用 Claude Code 负责实现与交付、Codex 独立审查、MiniMax Code 中途加入验收。
使用 Team 分支 `9dffed15776731a2875984ef4222ee9051774772` 加下述三行 Desktop 修复，
经 `pnpm dev` 启动真实 Main / preload / Renderer / Core；没有合并最新 main。
Core SHA-256 为 `195271028b7376bb78f9b376753d1fab059fb26e13981b59d2f2f580e90265d0`。
开发数据、Skill Library、MCP 和任务工作目录均位于本 Thread 附件的
`team-management-validation/mixed-runtime-dev-20261022T081254/`，日常 App、名册与数据未修改。
开发窗口及数据保留给 User 手工验收。

真实窗口首次调用 `teams.list` / `teams.save` 被 Main 的 `renderer_core_method_unsupported` 拒绝。
此前生产组件夹具使用模拟运输、Core 验证绕过 Desktop，因此未覆盖此遗漏。
仅在 Main 原有方法白名单补入 `teams.list`、`teams.save`、`teams.delete`；没有扩大通配授权，
没有修改 Team 模型、Bootstrap 或偏好协议。隔离窗口重启后，经实际 contextBridge/Core
完成创建、列表读回、删除及删除后读回；内部 `core.shutdown` 仍被 Renderer 拒绝。
`pnpm typecheck`、`runtime-core-methods.test.ts`、`pnpm test:desktop-bridge` 和
`pnpm build:desktop` 通过。

| 队员 / Runtime | 本机下发配置 | 观察 |
| --- | --- | --- |
| 交付负责人 / Claude Code 2.1.304 | `default` / medium；本机目录映射为 `gpt-6.1-sol[1m]` | 实现、交接、收取复核并最终汇总 |
| 独立审查 / Codex CLI 0.163.0 | `gpt-6.1-sol` / medium | 首轮独立审查及新增测试的增量复核 |
| 后加入验收 / MiniMax Code 0.6.12 | 本机 custom provider 的 `gpt-6` / thinking / medium | 只新增独立边界测试并交回负责人 |

这是三种 CLI 的协作样本，不是 Claude、MiniMax、GPT 三家底层模型对照；沿用本机原生 provider，
未改写认证或全局配置。8 个 Run 的实际 adapter 与分工一致；`runtime_observed_model_id` 均为空，
只能证明冻结配置及本机目录映射，不能额外证明服务端实际模型身份。

沿用上一节完整团队指引。先以两人 Team 创建 Thread，首轮结束后将保存 Team 的名册更新为三人，
并通过真实成员加入命令让 MiniMax 加入已有 Thread。指引文本未改，Thread 仍使用创建时副本。
任务在运行前明确字符串 value 必须 trim、公开测试不得追加，并提供 Git 基线
`60a4e0852c653ff3472b5b502f721fe4bf5d51d9`；没有重跑上一轮样本或倒改其结果。
每阶段预算 480 秒、8 个 Run 责任、6 次 accepted A2A，每阶段只投递一次。

| 阶段 | Run / A2A | 全量测试 | 原功能、字符串 value、冻结文件检查 | 耗时 |
| --- | --- | --- | --- | --- |
| 实现与独立审查 | 3 / 2 | 10/10 | 7/7 通过 | 222.452 秒 |
| 后加入者补测、增量审查与汇总 | 5 / 4 | 13/13 | 7/7 通过 | 181.245 秒 |

8 个 Run 全部 succeeded，8 个 Runtime Input Delivery 全部 accepted，6 次 A2A 均完成；
无未完成 Run 或投递。SQLite 使用 `mode=ro` 连同 WAL 读取，8 份 claim 的团队指引与创建快照一致，
包括后加入的 MiniMax；8 份 Dynamic Payload 均无 TEAM_GUIDANCE 区块。
三位队员的真实工具回执均含测试执行记录。最终仅修改一个实现文件并新增两个测试文件，
冻结的公开测试、README、package.json 未变，Git 基线未改。

协作可以闭环，且新人补充 Unicode 空白、内部空白保留、大小写与去重边界，没有重做实现。
仍观察到负责人交接较长、重复列举约束，后半段又对新增测试发起独立审查；
这说明完成闭环不等于沟通开销已经最小。本轮不修改指引、不增加机制、不择优重跑，
也不把单一样本的约 6 分 44 秒与上一轮不同 Runtime、不同任务明确度的样本作性能比较。

验收辅助脚本有两处在首次 verifier 执行前修正：遗漏 workspace 参数时使用固定夹具目录；
字符串 value 专项输入补齐 README 要求的正常 actor/type 或 actorId/kind 字段。
断言与预期输出未放宽，原脚本与更正时点保存在 `harness-note.json` 及对应前稿；
UI 截图脚本也曾因后台 rAF 等待、选择器引号和带状态后缀的标题失败，随后改用已观察的按钮内容。
这些是驱动修正，不是模型重试或产品修改。完整上下文 Gate 继续为 `degraded`。

运行前计划 digest 为 `177b384cb46932e11ad7c2c0d7e25abbcb1a6d7b6a0bd55cacdce38c2f121c6e`，
Desktop 三行补丁 digest 为 `79f6bc4ebd57668c1b8bc449f2dbd741fa9b11033c0ac15fd65c325ba08f9623`。
同目录 `launch.json`、`plan.json`、`run-acceptance.mjs`、`results.json`、`evidence-summary.json`、
`public-thread-evidence.json`、阶段测试日志、桥接回归及最终截图保存可复核证据。
正式展示为团队「三 Runtime 协作验收」、会话「三 Runtime · 实现—复核—验收」。


## V10 收口与 main 整合（2026-10-22）

User 在 Thread sequence 62 选择 V10，明确要求实施、PR 合入 main、安装本机 App。
整合基线为 main `69f4741c84684b43aced1e94e9cbc4c67424a878`。沿用全部已确认的 Team/Custom
与创建状态修复，V10 只调整指引框、名册边框、行反馈和窄屏操作换行，左侧列表保持原式样。
没有引入 V11 的列表和背景改版。生产组件预览覆盖日/夜、6/12 人与 390px 英文窄屏，后者无横向溢出。

主线 Migration 209–212 已被通知、通用环境和 Web 长粘贴使用，Team 顺延为 **213 / schema 163**。
现有 Bootstrap DDL owner 原地增加 Team 迁移收据失败回滚与 schema 162 来源准入；不新增测试 owner
或数据库夹具。旧 Single Chat/通知升级 helper 按主线顺序补齐 Web 长粘贴与 Team 的尾部迁移。
General Preferences 升为 **schema 7**，保留主线 schema 6 的跟随系统语言；旧配置仍作为 Custom，
不自动生成 Team。既有偏好 owner 验证 schema 5/6 语言、Team-only 默认配置与精确 schema。
保留主线 Charter revision 25，只叠加已确认的 R1 Team Guidance；Binding 与动态上下文规则不变。

本轮验证：TypeScript 检查、Desktop/Web/Execution Web 构建、真实 contextBridge 通过；4 项生产
Electron 集成通过，其中 Team 为 20 组受控 Promise 场景，另保留主线 Runtime 通用环境离页保护。
`pnpm test` 首次出现一个旧语言 schema 夹具错误和四个并发超时；夹具去除新 Team 字段后，
按同一测试链将 Vitest worker 限为 2，252 文件 / 2870 项通过，2 项既有跳过；后续 Node 357 通过、2 跳过。
文档和 Skill 门禁均通过。Rust 默认 workspace 474 项通过、1 项既有忽略。
定向 Rust 12 项通过：Team 事务、当前准入/结构、Bootstrap 与历史证据、schema 162→163 回滚/升级、
Web 长粘贴/通用环境/通知迁移链、首次绑定及 Single Chat 省略规则；已先列出非零 owner。
`cargo fmt --all --check`、以固定 main SHA 执行的 `docs:check:ci` 均通过。

完整上下文 Gate 保留之前的 **degraded**，本轮没有重跑模型评测，也不将 UI、单元或迁移验证
写成语义 Gate 通过。用户本轮明确交付指令是此次合并与本机安装依据。

## 合入后的局部状态修补（2026-10-22）

基线 main `186d1cfcf0c0cfff342aa36282b35d75436613c5`，User sequence 64–65 要求核对并简单修复
Web 无差别刷新和已保存快照降版本。两处均在生产 React 夹具复现：无关事件把一次待完成的
团队读取扩大为 9 次；保存 v2 后放弃下一次草稿恢复了旧列表 v1。

Web 沿现有 SSE/Task 标记增加 `teamsChanged`，服务端、解码、合批与 Hook 贯通；只在团队变化或
resync 时刷新，保留请求代次和 loading。TeamWorkspace 在既有 select 入口比较同 ID 版本，
不接受低于当前已确认 base 的列表副本；列表删除回退与待执行动作的 Team ID 保护保持原样。
没有新增缓存、轮询、队列、模型字段或 Bootstrap 内容。

验证归属沿用 Web 解码/重连单测、生产 Electron Team 创建夹具和真实 Host HTTP/SSE owner。
React 新场景用受控 Promise 验证无关事件、定向刷新、重连、旧响应拒收，以及放弃草稿、
点击当前行、新对话和复制保持 v2；显式载入 v3 与既有删除回退仍通过。Host seam 验证通知事件
不附加 Team 标记，实际保存 Team 后收到定向失效，不新增 Rust 测试 owner 或数据库夹具。
本轮不重跑模型协作，完整上下文 Gate 继续为 **degraded**。

Host owner 同时对齐之前 Team 合入后的三处旧夹具预期：导入响应包含空 Team ID、可用 Custom
不被失效通知禁用、导入完成后只读取 SQLite 而不重读损坏旧文件。这些只更新验收预期，
不调整既有 Core 逻辑。定向 Web 47 项、生产 Electron 22 组、TypeScript 和构建通过；
完整前端链使用 Vitest 2 workers，252 文件 / 2870 项通过、2 项既有跳过，后续 Node 357 通过、
2 项平台跳过；Rust 默认 workspace 474 通过、1 项既有忽略。文档门禁与 Rust 格式检查通过。


## 2026-10-25：指引上限 10000

确认范围见 [长度上限 R1](model-context-change-team-guidance-limit.md)。UI 计数和中英文错误、Core Unicode
校验统一改为 10000；Migration 214 / schema 164 原子扩宽两张表约束。原有输入格式、字节预算、冻结来源
和补发机制不变，既有数据不重写为新指引；本轮不重新运行真实模型，完整上下文 Gate 仍为 `degraded`。

验证归属：Team CRUD owner 扩展中文/emoji 的 10000/10001 边界及新 Thread 保存；现有生产 React 夹具
验证完整输入、计数、拒绝超限且草稿保留；现有 Bootstrap 物化 owner 验证 40000 UTF-8 字节的完整投递、
预算失败无 Manifest、同 Run 恢复一致。数据库准入 owner 增加 schema 163→164 来源与 marker 组合。

新增一个 `db::teams::tests::guidance_limit_upgrade_preserves_rows_and_rolls_back`：它拥有新迁移的 DDL 回滚、
生产打开升级、数据保留和重开边界。现有 Team CRUD fixture 已是当前 schema；Bootstrap migration owner
拥有另一张表及 v5/v6 证据，不能覆盖这两张指引表的数据保留。新 owner 使用既有 schema-only 临时 SQLite
fixture，无 Runtime；测试表格/纯谓词不足以验证事务 DDL、触发器和外键。新增 Rust 测试函数 1 个，未删除或禁用。
最小命令：`cargo test -p rovai-core --features extended-tests --lib guidance_limit_upgrade`。

本轮已执行：

- `pnpm typecheck`；`pnpm test` 的文档、Skills、sandbox capability 和 Vitest 路径通过（256 文件、3005 项通过、2 项跳过）。
  最后的 Node 阶段首次发现 Product Contract Fingerprint 仍预期 schema 163；同步为 164 后，单独重跑同一 Node 阶段，358 项通过、2 项跳过。
- `node --test --test-name-pattern='Team creation' scripts/lib/member-creation.test.mjs`：生产 React/Electron 夹具的 23 个场景通过，新增长度边界包含在其中；使用全新临时 userData，无 Core、Skill Library 或模型。
- `cargo test -p rovai-core --features extended-tests --lib guidance_limit_upgrade`：升级、DDL 回滚、保留、重开和外键/不可变触发器通过。
- 相同 extended-tests 命令分别运行 `templates_preserve_custom_defaults_and_freeze_thread_guidance`、`current_migration_state_admission_matrix`、
  `database_contract_preflight_admits_current_and_rejects_future_store`、`run_bootstrap_migration_keeps_audit_and_rolls_back_its_schema_change`，全部通过。
- `cargo test -p rovai-core --features slow-tests --lib newly_bound_session_bootstraps_on_its_current_generation`：完整长指引、预算失败和冻结恢复通过。
- `pnpm build:desktop`、`cargo fmt --all -- --check`、`git diff --check` 通过。
- `DOCS_BASE_REF=51da43668fa9b9e50cd94c86a29825db8666f79a pnpm docs:check:ci` 通过；初次文档检查要求的四个标准标题已补齐。

`pnpm test:rust:pr`（`cargo test --workspace`）通过：477 项通过、1 项按既有原因忽略。
本轮未执行真实模型或重新打包安装日常 App；结果不代表完整上下文 Gate 已通过。

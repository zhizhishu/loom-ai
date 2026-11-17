# 四端验收证据映射 — 2026-11-05

仅整理已有回执，不重跑测试，不把数量换算为总契约 PASS。本表补充 MASTER-ACCEPTANCE，不覆盖总文档状态。S 为源码/配置/fixture；H 为真实已安装宿主。隔离 H 使用 localhost 确定性 provider 与测试凭据，不冒称外部模型 E。

## 证据索引

下列路径相对 C:/Users/echo/Downloads/claude/。

| 键 | 实际证据 | 已验范围 |
| --- | --- | --- |
| S1 | skill-cli/_artifacts/four-ends-audit-20261104/post-gui-source-checks.json；同目录 final-contract-results.json | 三生成器 --check 与 hook verifier exit 0；最终 verifier 明确 S、host_runtime_verified=false，210 PASS/0 WARN/0 FAIL；契约负例 16/16。 |
| S2 | skill-cli/_artifacts/four-ends-audit-20261104/audit-results.json | 基线 unlink_ends.py status exit 0；23 项 link-ok、source_exists；.system 未碰。该历史报告保留原缺陷，不代表修复后仍失败。 |
| S3 | skill-cli/_artifacts/four-ends-audit-20261104/post-retirement-checks.json；memory-post-generation.json | 密码 MCP 退役后实际 DSH/Pi 消费名仅 jshook，Codex 生成一致。后续 memory hook 生成 24 条、检查干净；名单不是 MCP 调用证明。 |
| S4 | dsh/_artifacts/four-ends-audit-20261104/dsh-payload-fixture-results.json | sessionstart.test.mjs 与 stop-reason.test.mjs exit 0。startup 延后等待、去重、显式 preset/unknown fail-closed/切换；14 Stop 用例覆盖优先级、防循环、多 handler、排除。 |
| H1 | skill-cli/_artifacts/four-ends-audit-20261104/pi-native-host/host-results.json | Pi 0.85.1 主助手：allow/Stop 10 项 + deny 7 项全真；真实 Write、上下文送达、Stop 一次续跑、Write 被阻止且目标不存在。 |
| H2 | skill-cli/_artifacts/four-ends-audit-20261104/codex-native-host/accepted-host-results.json | Codex 0.166.0：view_image 成功/Stop 9 项 + shell 映射 Bash deny 6 项全真。允许 shell 的尝试被宿主策略拒绝，保留失败回执且未改策略。 |
| H3 | skill-cli/_artifacts/four-ends-audit-20261104/memory-source-host/four-host-result.json 及其四个 accepted result | 四个原生宿主真实消费同一源 index hook/同 SHA 索引，共 38 项；精确范围见下表。 |
| H4 | dsh/_artifacts/four-ends-audit-20261104/gui-stop-live-observed.json；gui-stop-cleanup-result.json | 原 DSH GUI 实例重启后 reason reply 1 次、active false→true、streaming=false；仅验收 session；专属 handler/file 删除，settings 原字节恢复，memory 设置保留。 |
| H5 | mindkit/_artifacts/memory-audit-20261104/claude-native-host/index-lifecycle-1793824512415037300/result.json | Claude 2.1.241 startup/resume/真实 compact/compact 后 resume/第二项目均 exit 0；200 行/2,804 字节每请求一份，原生 Read 后才见主题，源 guard 真拒 Write、store 不变、native decoy 不加载。 |
| H6 | skill-cli/_artifacts/four-ends-audit-20261104/capability-source-host/four-host-accepted-result.json | 四端真实全局入口消费同一测试规则、Skill 描述→按需完整正文，以及固定 MCP initialize/list/call/回模型；独立于 LOOM bundle。精确宿主方式与限制见下节。 |

## 38 项的实际范围

真实源 hook SHA-256：d9d6840c6dbc5db26144ee14e08426173a39adf19f155dc748c294a77f0cf926。

共享测试索引 SHA-256：9d9b56124da03f121c66f1136cffc703d40b36d96f942224fd4416682d07e0ed。

四宿主该轮实际 source 均 startup；每个两次模型请求均只有一份共享索引，测试主题没有预载。

| 宿主 | 数量 | 此回执额外真实行为 | 不能外推 |
| --- | ---: | --- | --- |
| Pi 0.85.1 | 10 | Session/prompt、Pre/Post Write、fixture 文件落盘、Post context | 此 10 项没有 deny/Stop block；另见 H1。 |
| Codex 0.166.0 | 9 | Session/prompt、Pre/Post view_image、Post context | 不是 shell 成功；信任只针对隔离的一次调用。 |
| DSH 0.1.5-rc.2 | 10 | Session/prompt、Pre/Post Read、真实读 fixture 文件 | headless 无 GUI preset 服务，明确 exclusions=[] opt-in；读的不是记忆主题，不能当排除 preset 已执行 hooks。 |
| Claude 2.1.241 | 9 | fixture Write、Post context、源 hook 未变、store zero writes | 此启动用例没有主题 Read，也未断言 UserPromptSubmit；主题/生命周期另见 H5。 |

38 是异构检查数，不是 38 个 MASTER 验收项，也不是四端 rules/skill body/MCP/召回全通过。

## F-A05 同源全局入口实测

H6 的三个共享源文件在四个宿主各自运行前后 SHA 完全相同；完整 Skill 正文 SHA-256 为 `9c488abcbf7cfbfabb4dc4c1f708af078baf55124289017364b2d82c14dd030e`。每端首次模型请求均含规则和 Skill 描述、不含正文，随后实际宿主读取完整正文；固定 MCP 服务独立记录 initialize、tools/list 和一次 exact-input tools/call，返回值进入真实后续模型请求。以下入口相对 `skill-cli/_artifacts/four-ends-audit-20261104/capability-source-host/`。

| 宿主 | 原生机制 | 精确已验入口 |
| --- | --- | --- |
| Claude 2.1.241 | 用户级 Skill 发现后原生 Read；实际用户 MCP 配置 | hosts/claude/accepted-result.json；raw run-20261105-064358-980877ad/result.json；26 项。 |
| Codex 0.166.0 | app-server 原生 typed Skill(name,path)，正文由宿主读取；真实 MCP 工具 | hosts/codex/runs/1105-063629-d72bc9/supervisor-qualification.json 及同目录 result.json。 |
| DSH 0.1.5-rc.2 | 安装版 headless、六份 live adapter 源字节副本；原生 Read 和 MCP | hosts/dsh/accepted-result.json；raw run-20261105-065135-46328421/result.json；34 项。 |
| Pi 0.85.1 | 原生全局规则/Skill 发现与 Read；安装版 pi-mcp-adapter 2.36.0 默认 aggregate search→call | hosts/pi/accepted-result.json；raw run-20261105-070239-6c2304d5/result.json；27 项；另有原始事件对账 11 项。 |

这些数量保持各宿主原始口径，不相加冒充新的统一验收项。Codex 保留默认 on-request/readOnly，只对已审的固定 echo 做一次原生逐次确认，不持久化授权，没有排入 shell 工具。DSH 明确只在 headless fixture 使用 exclusions=[] opt-in，日常 default/unknown/排除 preset 未放宽。Pi 没有切 directTools；实际一次 search 即发现 echo，准备夹具中的可选 lazy connect 分支没有在这次原生验收中使用。

Claude/DSH/Pi 另有私有 Job 自然整树退出与服务 EOF；Codex 此回执证明 app-server exit 0、reader 正常结束、无应急清理，所捕获服务事件没有 EOF，不扩写为同等 Job/整树证明。Codex 当轮 common.py 为旧 1b65c8…，其余三端为后来修正横向空白的 1d504e…；各自前后源码稳定，原始 FAIL 与原始回执没有改写，三个共享源文件和完整正文哈希一致。

H6 补的是 Skill/rules/MCP 实用组合，不改变 H3 的 38 项 startup 范围，不把 Skill 正文读取当成 M-03 记忆主题读取，也不把 M-05 生命周期、召回、每日 hooks 信任或其它平台提前改绿。

## F-A 对应

| ID | 已有证据 | 尚未覆盖或限制 |
| --- | --- | --- |
| F-A01 | S1 三生成器与 verifier 成功 | 仅静态，不证明活跃宿主信任/加载。 |
| F-A02 | S2 23 个源链接健康、.system 未碰 | 只说明记录时的拓扑。 |
| F-A03 | S1/S3 源消费、生成和密码 MCP 退役；H3 真实 index loader | 不推四端 MCP list/call 或全部 skill/rule 行为。 |
| F-A04 | S1 和 hook_contract v2；H1/H2/H3 校准版本/真实事件 | 保留下面列出的宿主差异与缺失原生事件。 |
| F-A05 | H6：四个实际安装宿主均见规则与 Skill 描述，初始无正文，按需获得同 SHA 完整正文，并真实 MCP list/call 一次及回模型 | 记录的隔离同源组合范围 PASS；不推全部日常 Skill/MCP、DSH 排除 preset 或 Codex 日常 hooks 信任。 |
| F-A06 | H3 四端 startup；Pi/Codex/DSH prompt context；H1/H2 时序 | H3 Claude 未断言 UserPromptSubmit；不能宣称统一全生命周期矩阵。 |
| F-A07 | H1 Write deny/Post；H2 Bash deny + view_image Post；H5 源 memory guard Write deny；H3 DSH Read Pre/Post | 各端实际工具不同；DSH 宿主源 guard deny/所有别名及四端全部 matcher 未获此处 H。 |
| F-A08 | H1–H5 均不是完整 recall 状态/查询矩阵 | 重复/新查询/no-hit/superseded/revoked 需 memory 线专项证据，不由 38 证明。 |
| F-A09 | H1 Pi 主助手五映射事件；S1 worker 禁全局 lifecycle 的契约 | worker 配置/安全隔离此处主要是 S；普通派工回执不能自动替代完整隔离 H。 |
| F-A10 | H4 原 DSH GUI 重启/Stop 实验 | Codex 日常改 hash 后 /hooks 重新信任未完成；GUI A05–A08 未全量重跑。 |
| F-A11 | S4 明确 preset 排除/unknown/切换 fixture | 未证明每个实际 GUI preset 和其它插件消息保留的完整 H。 |
| F-A12 | H5 Claude startup/resume/compact 恢复；H3 四端 startup | 非四端 clear/resume/compact 全等；Pi source 映射限制保留。 |

## F-B 对应

| ID | 实际证据 | 范围 |
| --- | --- | --- |
| F-B01、F-B02 | S4 reason fallback/context 优先；H4 GUI reason-only once | GUI H 只覆盖 reason-only，不代表所有 context 组合。 |
| F-B03 | S4 既有嵌套 context fixture | 未测试已退役 Cursor 原生宿主。 |
| F-B04、F-B05 | S4 quiet/active 防循环；H4 active false→true、正常结束 | 原 GUI 一次 reason reply 已真实观察。 |
| F-B06、F-B07 | S4 preset 排除和多 handler 顺序 | fixture 级，不是全 preset GUI 矩阵。 |
| F-B08 | H4 原 GUI 实例已加载修复并一次结束、精确清理 | 记录范围 PASS；snapshot rollback 未执行。 |

## M 对应

| ID | 本线提供的证据 | 边界 |
| --- | --- | --- |
| M-01 | H3 同一显式 store/同源 loader | 完整环境/cwd resolver 优先级属 memory 线 S owner。 |
| M-02 | H5 Claude 原生 settings/index/guard 和 native decoy 未加载 | 不外推已存在的任意用户会话；handler 形状专项证据另归 memory 线。 |
| M-03 | H3 四端同文件索引字节；H5 Claude 真实主题 Read | H3 不含四端全部主题按需正文读取。 |
| M-04 | H5 真实 200 行有界注入、无主题预载、Read 后主题可见；H3 四端无主题预载 | H5 实际输出 2,804 字节；25KB/MOC/超大输入需 memory 线 S owner。 |
| M-05 | H3 四端 startup；H5 Claude resume/compact/compact 后/第二项目 | 不声称四端 clear/resume/compact 完整通过。 |
| M-06–M-11 | 本表不新增验收结论 | 元数据、路由、强制更新、并发恢复、失败回滚、embedding/network 属 memory 线 owner，启动数量不能替代。 |
| M-12 | H5 源 guard 原生 Write 真 deny、文件不存在/store 不变；禁 native memory 后保留 H3 读索引 | 不是 OS 写沙箱或四端全部 shell/tool deny；Pi/Codex 通用 deny fixture 不自动成为 memory guard H。 |
| M-13 | H5 store 不变；H3 Claude zero writes；四端运行真实只读 loader | 事务/并发仍需专项 owner。 |
| M-14 | H1–H5 未覆盖 | 新指令优于旧记忆和经授权 supersede 流程需自己的 E。 |
| M-15 | H1–H5 未覆盖 | 临时 store 备份恢复归 memory 线，不从此处推断。 |

## 保留的原生限制

Codex hooks 内容 hash 改动后仍需原生 /hooks 重新信任。H2/H3 只为已审查的隔离 fixture 使用一次性自动化参数，没有改变或验收日常全局信任。成功 Post 是 view_image；成功 deny 是 Bash；允许 shell 的失败回执未隐藏。

Pi 仅映射 session_start/before_agent_start/tool_call/tool_result/agent_end 五事件；new reason 映射 clear、其它映射 startup，不等同 Claude 所有 source。PreCompact、SessionEnd、Notification、SubagentStop 明确不映射。deny/ask 会阻止工具但不回写 updatedInput；主助手 Stop 最多续一次，pi-skill worker 不自动续跑。worker 全局 lifecycle 有意禁用。

DSH 的 default/unknown fail-closed 及用户排除项不变。PostToolUse 可能携带被拒工具的错误结果，不能套用其它宿主 no-Post-on-denial 断言；适配的 payload/transcript 不等于原生 Claude transcript。

此轮仅证据对账，不展开 OCE/Notion 未来项。

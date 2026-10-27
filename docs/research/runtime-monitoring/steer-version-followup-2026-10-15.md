---
document_type: validation-report
authority: observed-runtime-evidence
last_updated: 2026-10-15
---

# Steer 版本复核与完整 TRAE 验收

User seq44；代码基线 `d64a1c140b48cd260b87d1db63952842a9253dcf`，当前 Mission 064 工作树。
macOS arm64；真实 LLM 已获授权。保持 Rovai 当前接入通道、统一 Builder／Formatter 和 RUN_INPUT。
没有修改模型提示词、数据库结构、UI 或全局 Runtime 最低版本。全部尝试见
[去敏证据](steer-version-followup-2026-10-15.evidence.json)。

## 当前结论

| 智能体 | Rovai Steer 准入／对外版本 | 本轮结论 |
| --- | --- | --- |
| CodeBuddy | **>=2.109.1，稳定版** | 仅设最低版本。2.167.0 专用 ACP 适配后连续输入 3/3、停止与结束 3/3；2.109.1 新复测 2/3，保留旧路径异常 |
| ZCode | **官方 App 3.12.2 为最早已测通过包** | User 只需看 App 版本；内部继续核验实际捆绑内核 0.16.5+ 与文件身份 |
| Claude Code | **>=2.1.83，major 2 稳定版** | 当前完整 Stream JSON 接线的最低边界；sub2api 真实连续输入 3/3。不是上游最早拥有追加 user 的版本 |
| TRAE CLI CN | **>=0.207.1，major 0 稳定版** | 0.207.1 已补齐当前 Core／Adapter 产品验证，不再只有原生通道证据 |

其他五种准入不变：Codex 0.162.1、Pi 0.99.0、Qwen Code 0.18.4、Grok Build 1.0.14、
Kiro CLI 2.21.1。版本区间是当前协议兼容政策，不表示逐个发布包均已实测；实际还需普通执行可用、
活跃 Run 冻结身份／协议符合、初始输入已接受、目标阶段可接收。完整边界见
[Delivery v16](../../contracts/message-delivery-v16.md)。

## CodeBuddy：连续门槛与新版适配

官方 npm 的 latest 稳定包为 **2.167.0**，存在比 2.132.0／2.133.1 更新的版本。
使用[官方版本包元数据](https://registry.npmjs.org/@tencent-ai/codebuddy-code/2.167.0)校验安装锁中的
SHA-512 integrity，下载到隔离目录，没有更换本机全局 2.133.1。

本轮最初只改连续门槛，保留原并发 `session/prompt`，在 2.167.0 上得到三个失败：

1. 首轮在初始输入前收到 `_codebuddy.ai/modResidentInvalidate`，旧 Core 将它判为不属于活跃 Prompt
   的通知，Run 等待、初始输入 unknown，未到工具边界。
2. 第二、三轮 A/B 都获得 supplemental `end_turn`，实际文件仍为 ORIGINAL。原生 JSONL 的 A
   记录出现在 ORIGINAL 最终回复之后，未发现 B 的记录，不能据此声称模型已消费 B。

官方包的 ACP 实现已提供 `session/steer`，参数为 `contentBlocks`、`expectedRequestId`、
`clientUserMessageId`，返回 `steered` 与 `ownerRequestId`。本次据此修正实际 ACP Adapter：

- 记录原 Prompt 根模型／工具事件中的 `codebuddy.ai/conversationRequestId`；只取首次观察值。
- 优先专用方法，确认回执属于该原生请求；没有原生归属时不作无目标约束的注入。
- 仅在 `-32601` 明确证明方法不存在时，重新检查原 Run／epoch／Prompt，使用旧并发 Prompt。
  `steered:false` 转普通投递；超时、未知错误、错误 owner、迟到回执不重发。
- 精确接纳 CodeBuddy 的无 ID `modResidentInvalidate` 通知为 metadata；其他 Adapter、request
  或未知通知不放行。这条通知不证明接受输入。
- 保持使用过 Steer 的 Host 在原执行终止后回收，不把其原生队列带入后继 Run。

修正后 2.167.0 三次独立 A→B 更正全部在原 Run 生效，两种停止／普通续接与结束／失效目标全部通过。
2.133.1 在修改前与修改后分别 3/3；2.109.1 在新适配器上为 **2/3**，第二次停在 A。
该次 A/B 的 Core 接收回执都存在，原生 JSONL 只有 A，缺 B 的入队／消费证据。保留为证据缺口，
不归因为模型不遵从或已证实版本回归，不用成功重跑覆盖失败。

发布处理：按 User seq46，稳定版仅使用 `>=2.109.1` 下限，不设大版本上限或推荐版本。
保留旧路径和普通执行资格；版本准入与逐次实测结果分别记录。
原 2.132.0 异常及此次旧协议同类异常继续归档于[问题 #762](https://github.com/murray17/rovai-ai/issues/762)
的跟踪范围，本次不关闭问题，不把 2.132.0 简称为不支持。

## ZCode：对外使用 App 版本，内部沿用实际内核核验

官方 App 更新会携带内核，但两者版本号不是一一递增。本轮读取官方包 `Info.plist`，对实际
`Contents/Resources/glm/zcode.cjs` 做摘要和隔离 `--version` 检查，未启动 GUI：

| App | Bundle build | 实际内核 |
| --- | --- | --- |
| 3.12.2 | 3.12.2.7410 | 0.16.5 |
| 3.14.1 | 3.14.1.7714 | 0.16.9 |
| 3.14.5 | 3.14.5.7961 | 0.16.9 |

因此对 User 直接写 **ZCode App 3.12.2 起**即可，并说明它是最早已测包，不能宣称更早官方包全都失败。
内部已有的内核版本及文件摘要仍有价值：Rovai 实际执行的就是该内核，运行期间 App／程序替换也要识别。
没有新增 App 版本表、Run 存储字段或双重门槛。历史真实模型配对正例沿用
[低版本报告](steer-low-versions-2026-10-15.md)，本轮没有重跑 ZCode LLM。

## Claude Code：为何仍是 2.1.83

Rovai 当前依赖的不只是向 stdin 追加 user，还包括必传启动参数、输入 UUID 回显，以及
`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` 下的 `session_state_changed`：`result` 后须确认 idle，
才能安全结束原 Run，不能把暂时的 result 当作整个执行结束。

重新从官方 registry 获取 2.1.81／2.1.83 元数据和 tarball，核对 SHA-1、SHA-256 及本地 cli.js
与官方包一致：2.1.81 没有这组状态开关／事件实现，2.1.83 有；registry 的实际发布列表没有 2.1.82。
来源为[2.1.81 官方包](https://registry.npmjs.org/@anthropic-ai/claude-code/2.1.81)与
[2.1.83 官方包](https://registry.npmjs.org/@anthropic-ai/claude-code/2.1.83)，摘要保存在去敏证据中。

早期包检查也保留：1.0.86 缺 partial 参数；1.0.108／1.0.109 仍缺当前系统提示文件／会话参数；
2.1.53／2.1.70／2.1.77／2.1.81 未提供上述结束状态协议。既有 2.1.53 Core 负例见低版本报告。
本轮 **2.1.83 + sub2api + 实际 gpt-6.1-sol** 三次同轮连续更正全部通过。

结论是 **2.1.83 为当前 Rovai 完整接线边界**，不是 Claude 最早原生 Steer 版本。
要兼容更早包，需要另做结束协议适配；本轮不删除参数或放宽结束判断来降低数字。

## TRAE CN 0.207.1：完整产品验证

固定[官方 CN 0.207.1 manifest](https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae-cli/v2/releases/0.207.1/manifest.json)
对应的 macOS arm64 程序，摘要为
`d11176985cb2f22224cb8a92ed53d7c7382ecc674910b6391b22e892405c393a`。
保留本机已授权的企业配置，复制到私有 fixture。实际模型为 **glm-5.3/high**。
使用生产 ACP `_session/steering` 与完整动态上下文，每次通过 startup 配置固定程序入口并核对路径，
不会自动回退至日常 0.209.1。

| 场景 | 结果 |
| --- | --- |
| 三个独立 Thread，同轮连续 A/B 输入 | 3/3；两个逐输入接收回执，最终 B 和第二项文件结果正确，无后继 Run |
| 未消费／首条回执后停止，普通续接 | 2/2；停止后旧 Host 退出；普通任务没有“忽略旧任务”提示；无旧输入文件副作用 |
| 结束边界与失效目标 | 通过；用合法结果断言检查归属、重复与普通降级，失效目标不串入已结束 Run |
| 同轮文字与纯附件 | 通过；RUN_INPUT 只含各次消息，附件引用保留，两个文件结果正确 |
| 忙碌时原有普通消息排队 | 通过；插话留在原 Run，普通消息独立后继，只有一次普通执行 |
| 一个公共消息同时投三个队员 | 通过；忙碌 TRAE 插话、忙碌 OpenCode 排队、空闲 TRAE 启动；逐目标结果正确 |

混合对照为 OpenCode 2.0.25／sub2api/gpt-6.1-sol，它的配置、数据、状态和缓存亦为隔离目录。
**TRAE 0.207.1 现在有产品通过证据**；0.209.1 的上一轮通过保留。这次未重跑桌面 UI、图片附件、
引用或 Skills 全矩阵，不能将以上通过扩大成所有平台／所有输入类型验收。

## 全部尝试与代码身份

| 尝试 | Core 阶段 | 结果 |
| --- | --- | --- |
| TRAE 0.207.1 positive | 基线 | 3/3 |
| Claude 2.1.83 positive | 基线 | 3/3 |
| TRAE 0.207.1 boundaries | 连续门槛候选 | 3/3 |
| TRAE 0.207.1 full | 连续门槛候选 | 3/3 场景 |
| CodeBuddy 2.167.0 原路径 | 连续门槛候选 | 0/3；一例新通知阻断、两例未同轮采用更正 |
| CodeBuddy 2.133.1 原路径 | 连续门槛候选 | 3/3 |
| CodeBuddy 2.167.0 新适配 positive | ACP 适配后 | 3/3 |
| CodeBuddy 2.167.0 新适配 boundaries | ACP 适配后 | 3/3 |
| CodeBuddy 2.109.1 新适配 positive | ACP 适配后 | 2/3；保留第二轮 A/B 异常 |
| CodeBuddy 2.133.1 新适配 positive | ACP 适配后 | 3/3 |

另以结束协议补齐后的 Core 复验 2.167.0 的结束／失效目标，1/1 通过，结果为加入原执行；
该次筛选补验没有冒充整套重跑。总计 **11 个尝试、31 个 case，27 通过、4 失败**；
失败都保留，不把修改前失败并入修改后通过率。
基线 Core SHA-256 `bfa3f06bc562adbabe94b99722943bbb715e9926e8636af042e4200e48078a2d`；
连续门槛候选 `ca588637cca852dad6331ccf2db29991ecf179ae802946f7253617570fd44a26`；
ACP 适配后 `e01e2b91d159a6fc12d3b6848d08a406ba9353ed251e5ac7950477e064db2b22`。
后续补齐明确 `steered:false` 在原 Prompt 已结束后仍判为未接受的分支，定向夹具覆盖迟到拒绝；
该构建另复验结束／失效目标场景，SHA-256 为
`b95e9cb49893f1627262422586fff3e19de169a726cff3a94967f7d323e9f687`。
后续仅更新报告索引摘要及注释，生产逻辑源码摘要记录于 JSON。

私有 raw report、数据库、原生 JSONL 保留于本机隔离目录；公开证据只包含版本、摘要、Run／消息／原生输入
关联、时间线、结果和 marker，不包含认证文件、完整上下文或服务密钥。测试后删除 fixture 的认证副本。


## 自动化回归与限制

- `pnpm test:rust:pr`：全工作区 **472 passed、0 failed、1 个既有 ignored**。
- 随后补齐迟到明确拒绝分支，ACP 接收／围栏、metadata 与 frozen Run 准入三个既有 owner
  一起复验 **3/3**；结束协议补齐后的构建另跑上表末尾的真实结束／失效目标用例。
- `pnpm docs:test`、`pnpm docs:check`、以 `d64a1c14` 为 base 的 `pnpm docs:check:ci` 通过。
- Core/CLI 构建、Rust 格式、`git diff --check` 与修改后的 smoke JS 语法检查通过。
- 无 Renderer 改动；本轮没有重复整个 UI／Vitest 矩阵。最终台账摘要的既有平台资格 owner **5/5** 通过。

初次 metadata 定向命令漏加 `extended-tests`，实际匹配 **0 项**，没有记作通过；随后正确命令的
3/3 包含该 owner。不把普通执行可用、运行时接收、模型消费和业务结果合并成一个结论。

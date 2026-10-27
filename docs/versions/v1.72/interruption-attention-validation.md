---
document_type: implementation-record
version: v1.72
lifecycle: current
last_updated: 2026-10-21
---

# 执行中断提醒实施与验收

## 当前收口：退出提醒（2026-10-21）

User 将范围收窄为 App 退出打断会话，并在 seq75 明确保留已确认的 Run 异常退出提醒。当前合同是
[Notification Episode v12](../../contracts/notification-episode-v12.md) 与
[Current User Attention v10](../../contracts/current-user-attention-v10.md)，取舍见 [V1.72-D55](decisions.md#v1-72-d55)。
后文 R2、A1–A22 及性能数字是 #841 交付时的历史记录，不代表本次重新测量或当前短亮承诺。

当前代码删除手动停止来源、600ms 短亮、停止意图登记、精确准入描述水合及中断专属 DOM 观察。
退出已读改为前台正式 Thread 展示后按观察边界确认；旧手动停止保留审计而退出侧栏候选。
普通执行进度不再因 callback 身份变化触发通知轮询；空通知增量不刷新投影。
各批独立接收，删除等待全批结束后才能开始后续刷新的门闩，继续用代次和序号拒绝旧响应。

## 验证边界与 owner

本次不增加 Rust 测试函数；在既有 owner 中更换与收窄语义对应的断言：

- `interruption_admission_is_atomic_and_thread_acknowledgement_is_bounded`：退出/执行丢失来源、
  手动停止零准入、同事务回滚、精确 Run 可见性不代替 Thread 范围确认、冻结边界、幂等和迟到确认；增加真实 schema 159→160 的 producer
  升级与 receipt 故障回滚，验证旧手动停止审计的 ACK/通知时钟不变而候选退出。
- `interruption_projection_reads_only_requested_thread_indexes`：保留 100/1,000/10,000 Thread
  与单 Thread 1,001 中断规模/索引断言，不扩大性能承诺。
- 既有单聊、Runtime 退出/恢复、retention、数据库准入 owners 保留原责任；
  主动停止断言改为无通知，退出来源继续验证，旧精确短亮描述断言随接口一起删除。

Renderer 沿用现有通知交互 owner，生产 Hook/Controller/Sidebar 加隔离 transport：

| 场景 | 验证 |
| --- | --- |
| 重启未读、空输出 | 恢复已有退出点；正式 Thread 展示后确认，无需 Run/command/output 来源。 |
| 缓存、失败、后台、折叠侧栏 | 缓存/未就绪/后台不确认；正式展示不依赖侧栏可绘制性。 |
| 执行进度与手动停止 | 连续 30 次 snapshotSequence＋普通执行事件＋messages invalidation，通知 RPC 为 0；停止无点/无短亮/无请求。 |
| 空增量、冻结确认与重试 | 空 changes 不读投影；Web 通知失效可触发重读；边界后新中断保留；失败重试同 UUID/范围且不重做本机设置。 |
| 迟到投影与多批 | 201 Thread 中一批失败不拖住成功批；一批挂起不阻挡另一批后续事件；旧响应不能覆盖确认水位，reset 未加载新代次时不能用保留的旧点自动确认。 |
| 其他通知 | 原通知卡片队列/静默/暂停、三位置 Portal 精确来源继续由原两个交互 owners 验证。 |

最小命令：`cargo test -p rovai-core --features slow-tests --lib notification::slow_tests::`、
`cargo test -p rovai-core --features slow-tests --lib successful_final_is_private_and_a_cancelled_run_cannot_append_late_output`、
`pnpm test:notification-attention`。不启动日常 App 或真实模型，临时 Renderer userData 与 Skill Library 隔离。
本次没有重测整个 App 启动时间；后文历史毫秒值不能作为本次性能实测。

## 本次门禁

- `cargo test --workspace -j4`：474 passed，1 项既有 ignored。
- `cargo test -p rovai-core --features slow-tests --lib <owner>` 定向 25 项通过，包含通知、
  单聊、实际停止/退出/启动恢复与数据库升级准入；新增 Run 可见性隔离断言随后在原事务 owner 复验。
- `pnpm typecheck`、`pnpm test`：249 个 Vitest 文件、2,832 项通过；Node 357 passed、2 项平台限定 skipped。
  数据库 schema 指纹预期随 160 升级同步。
- `pnpm test:notification-attention`：3 项交互 owner 通过；补入 Web 通知失效入口后，退出提醒 owner 再次通过。
- `pnpm build:desktop`：Web、Execution Web 与 Electron 构建通过，既有大 chunk 提示保留。
- 当前 Host 二进制通过 `Desktop and Web share one Core` 集成 owner，包含真实 SSE 通知标识、
  schema 11、新批量 RPC 与跨客户端范围确认回执；数据、Skill Library、MCP 和上传目录均为隔离临时路径。
- `pnpm docs:test`、`pnpm docs:check`、diff-aware `pnpm docs:check:ci` 通过；Rust 格式检查通过。

收口同步 `main` 的 `010e762f0`（#846、#847）后，在 `ab6e52b97` 再次通过类型检查、全量前端、
退出提醒/Portal 两个交互 owner、桌面构建及以该 main 为基线的文档门禁。后端没有随同步变化。
并行构建时，既有 evaluation-host 与 file-preview watcher 的 3 条计时断言曾超时；
停止并行构建后的全量复跑通过，未修改这些测试或延长超时阈值。

以上为隔离自动验证，不是日常安装版的操作验收；未重测整个 App 启动耗时或使用真实模型。

## 复核修复：异步确认与共用失败来源（2026-10-21）

User seq75 的复核指出四处实现问题，seq77 授权修复；同时明确 Run 异常退出也应保留提醒。
本轮不改变 Core 分类、数据库或 RPC；将展示文案改为“执行中断”，说明 `execution_lost`
既包含启动恢复，也包含 App 运行期间已确认的 Host/worker 执行丢失。

| 问题 | 修复及回归 |
| --- | --- |
| 下一帧回调先于 reset 新快照执行，把旧 false 记为已查看 | 写 viewed 之前再核对请求和快照代次。原 Hook 夹具保留旧 false，先排队确认，再 reset 并释放旧回调，最后释放新快照；无需额外聚焦即可确认。 |
| 使命记录尚未就绪时提前确认 | 工作区挂载和正式可见条件共用。真实 App 启动恢复中挂起 missions.list，分别验证成功、失败、重试：工作区未挂载时零中断 ACK，正式内容出现后确认一次。 |
| 拉取中收到的新信号被丢弃 | 单个待刷新标记合并 Desktop/Web 信号，保存恢复意图，请求完成后补读。夹具验证延迟响应期间多个信号只补读一次、聚焦恢复仍重读投影、失败不绕过退避或形成重试循环。 |
| 普通失败气泡的精确来源被误删 | 仅恢复可见 failed presence 的 Run 上报。真实 ThreadWorkspace 使用无输出 batch 失败、关闭执行抽屉，仍回报精确 Run；失焦后不回报，恢复焦点后重新回报。 |

原 201 Thread 部分失败/延迟、冻结确认重试、缓存/后台、隐藏侧栏和手动停止用例继续保留。
连续 30 次执行进度、消息失效和快照推进仍产生零通知 RPC，不新增短亮、后台队列或定时器。
定向门禁：`pnpm typecheck`、`pnpm test:notification-attention`（3 个 owner）、
`pnpm test:startup-presentation`（1 个真实 App owner）通过。
全部使用隔离 Renderer userData/Skill Library 和受控 transport；不启动 Core、真实模型或日常 App。
另逐项临时还原四处旧行为，新用例均在对应断言失败；随后恢复修复版。这验证的是生产 Hook、
Controller、App 和 Workspace 的行为，未用独立复制的业务逻辑代替组件。
常规前端门禁也通过：`pnpm test`（249 个 Vitest 文件、2,832 项；Node 357 passed、2 项平台限定 skipped，
含文档/Skill 门禁）、`pnpm build:desktop`（Web、Execution Web、Electron）与 `cargo fmt --all --check`。
提交流程的默认 `pnpm test:rust:pr` 通过：474 passed、1 项既有 ignored。未改动 Rust、
Migration 或 RPC，未重复执行历史启动性能测量。

## 历史记录：R2 初次交付

按 R2 经评审计划实施。初始基线 `ce8351dad894a643ce9eabb8fc540385ac8c8d9b`；
收口前同步 `main` 的 `2773f3bc3`（#839），保留长粘贴附件改动。
协议为 [Notification Episode v11](../../contracts/notification-episode-v11.md)；
展示为 [Current User Attention v9](../../contracts/current-user-attention-v9.md)；
取舍见 [V1.72-D54](decisions.md#v1-72-d54)。

## 初次交付的验证边界与 owner

新增两个 Rust owner，复用原 notification SQLite fixture：

- `interruption_admission_is_atomic_and_thread_acknowledgement_is_bounded` 拥有新来源事务与
  Thread 范围确认：迁移 receipt 故障回滚、停止/退出/失败分类、终态与 Journal 回滚、
  cleanup 去重、点击后并发中断、不同 Thread、同 UUID 重试、先 ACK 后读取准入和重开持久事实。
  同一 owner 还验证只读连接在主连接持有写事务时读到旧的已提交快照，提交后读到新边界；
  不等待主连接锁，不读取未提交的 Disposition。
  原单项/全局确认 owner 不调用新范围命令，纯函数无法证明 SQL/Gateway 原子性。
- `interruption_projection_reads_only_requested_thread_indexes` 拥有新批量查询的规模边界，
  不是 Inbox hydration 的重复计时；以 SQLite VM 步数和查询计划证明历史 Thread 不被扫描。

继续扩展原单聊终态/结束 owner 验证真实停止、复用失败分类、原 Conversation 精确身份、
C1 结束后候选退出、C2 不代读与原未确认审计，并保留结束时取消在途 Run 和晚到输出被阻止的原验证。
原 Runtime owner 验证主动停止、受控退出、启动恢复及重复收口的真实准入；
原 retention owner 增加停止专属 Episode。
原 Task 边界升级夹具改用真实 schema 156 降级链，移除仅改 marker/错删 receipt 的伪来源。
原独立请求队列 owner 增加批量通知读取：有序队列被无关请求占用时仍能返回；范围确认继续使用写队列。
最小命令：`cargo test -p rovai-core --features slow-tests --lib notification::slow_tests::`；
单聊：`cargo test -p rovai-core --features slow-tests --lib successful_final_is_private_and_a_cancelled_run_cannot_append_late_output`。

Renderer 复用通知自动验收入口，注入隔离 transport，挂载真实侧栏、通知 Controller 和中断 hook。
覆盖实际准入前零闪点、先 ACK 后 poll 仍短亮、约 600ms 生命周期、隐藏侧栏不阻塞 ACK 且不补播、
未见结果持续未读、精确可见确认、冻结边界/UUID 重试、后来手动提醒保留、迟到投影、
来源/路线/焦点/reset 失效及无障碍标签。无 Core、Runtime 或真实模型调用。
既有 Portal 定位 owner 保留历史终态定位，覆盖 inspector/bottom/right 三种承载位置，
并将仍运行的节点改为不报告终态确认。交互使用真实鼠标输入并等待菜单和位置完成切换。
本机偏好 owner 验证保存回执不确定时只读核对一次，不重写后来发生的手动未读意图。
真实 Host/Web owner 验证公开 RPC、Thread/Camp 内部兼容路由及另一客户端命令核对。

## R2 验收映射

| 清单 | 验证层与结论 |
| --- | --- |
| A1–A3、A14–A15、A20、A22 | 真实 Renderer 组件夹具：精确准入前不闪；先 ACK 仍短亮；约 600ms 后退出；侧栏隐藏、离屏行及菜单占槽不补播；切换、失焦、reset 取消；语义标签区分中断、手动未读与新回复。三种执行台位置的终态可见性由原 Portal owner 验证。 |
| A4–A5 | 隔离 Host 进程 SIGKILL 后重启；恢复产生 3 个中断；已读后再次强杀仍保持 1 已读、2 未读、共 3 条事实。事务 owner 另覆盖终态/Journal 回滚和重复收口。 |
| A6–A9 | Renderer 仅从正式快照的精确终态登记可见性，运行中节点不确认；夹具覆盖迟到读、ACK 失败重试和后来新中断；本机 owner 保留新手动未读。 |
| A10、A19 | 原单聊 owner 覆盖停止与复用失败来源；ended C1 退出候选但审计未确认，C2 不代读；Core 可用性查询不依赖 Renderer 当前加载页。 |
| A11 | 原停止、受控退出及启动恢复 owner 验证实际终态准入和重复收口；本改动不改变关窗、可恢复执行及后继调度规则。 |
| A12–A13 | 新库/真实旧 schema 升级、receipt 故障回滚与历史事实保留；规模/查询计划、Journal reset、迟到响应与已确认水位；无历史终态回填。 |
| A16–A18 | SQLite 范围确认和 Renderer 两步提交夹具：冻结 Thread/边界/UUID，保留边界后的来源与其他 Thread；Core 重试不重做本机清除；本机保存不确定时由原 owner 核对。 |
| A21 | 原 retention owner 覆盖停止专属及混合未读 Episode；Renderer 验证停止不产生 heads-up。 |

以上为分层自动验收，不等同于所有组合都用真实模型端到端执行。
停止链路由真实 Core owner 和生产组件夹具共同覆盖；未对日常安装的 App 做强杀或安装。

## 新投影规模测量

在 macOS arm64 隔离 SQLite 中，固定请求 3 个有中断的 Thread，增加其他历史 Thread：

| 历史 Thread | 返回 Thread | SQLite VM 步数 | 单次带计数 hook 耗时 |
| --- | --- | --- | --- |
| 100 | 3 | 251 | 122µs |
| 1,000 | 3 | 251 | 193µs |
| 10,000 | 3 | 251 | 174µs |

查询计划从请求 JSON 虚拟表进入，按 `notification_interruption_thread_idx`
的 User/Thread/序号条件 SEARCH，再按精确 Run、Conversation、Disposition 主键 SEARCH；
只有最多 200 个请求 ID 的 DISTINCT 使用临时 B-tree。范围 ACK 使用相同的部分索引；
空集合、无中断和超出 200 个 ID 的请求也有验证。各规模另外含 10/100/1,000 条历史普通通知。

单 Thread 累积 1,001 条中断时，范围 ACK 一次确认全部 1,001 条约 28.58ms；
随后固定 3 个请求的投影约 1.61ms。单 Thread 自身的有效中断历史增长仍会增加成本，
不能将固定历史 Thread 数的结果解释为所有输入下恒定耗时。

## 隔离启动与崩溃测量

使用 `scripts/smoke-thread-interruption-startup.mjs BASELINE_HOST CURRENT_HOST REPORT.json`，
macOS arm64 Debug 二进制，100/1,000/10,000 个历史 Thread，每档两版本各 3 次；
固定 5 行导航、3 个合成在途私有 Run，10/100/1,000 条历史普通通知。
基线为初始 `ce8351da`，最终实现含 `2773f3bc3` 的同步改动，因此总启动差异不是严格单变量归因。
每次只使用新建临时数据和 Runtime Files Root，不加载真实模型或日常 Electron userData。

| 历史 Thread | 基线 Host ready 中位数 [范围] | 实现 Host ready 中位数 [范围] | 新批量 RPC 中位数 [范围] |
| --- | --- | --- | --- |
| 100 | 139.23 [123.19,382.33]ms | 140.95 [101.40,364.00]ms | 11.36 [10.48,12.12]ms |
| 1,000 | 334.60 [334.19,337.07]ms | 325.94 [299.21,345.40]ms | 9.81 [9.58,11.45]ms |
| 10,000 | 2,354.66 [2,324.31,2,657.10]ms | 2,372.32 [2,305.21,2,376.21]ms | 7.25 [7.23,8.67]ms |

| 历史 Thread | 基线/实现 DB ready 中位数 | 基线/实现恢复及服务阶段中位数 | 基线/实现首份可靠侧栏数据中位数 |
| --- | --- | --- | --- |
| 100 | 61/61ms | 44/24ms | 142.19/155.21ms |
| 1,000 | 253/268ms | 44/22ms | 336.40/337.67ms |
| 10,000 | 2,267/2,311ms | 22/23ms | 2,360.26/2,385.03ms |

首份可靠数据计时包含 Host 启动、导航读取（基线 1 次 RPC）以及实现新增的 1 次批量 RPC，
不是 Electron 首帧绘制，也不是完整 App 所有 RPC 的统计。
新投影业务查询为 Journal 边界及批量候选各 1 次 SELECT，同一短事务内完成；
冷连接打开成本已包含在 RPC 测量。启动恢复沿用原流程，本改动不增加逐 Thread 读取或恢复扫描。
既有 DB 准入在 10,000 档位仍约 2.3s，不能声称整个 App 启动不随历史增长。

首次有效测量曾发现新查询等待附件维护占用主连接锁，10,000 档位的 3 次 RPC 为
2.11/3,673.32/3,765.76ms。最终改为既有独立读队列中的惰性只读 WAL 连接，
同档位复测为 8.67/7.23/7.25ms；仍以同一数据库的 Disposition 为真源，不引入缓存或后台扫描。

共 6 份隔离在途现场在正常关闭前 SIGKILL 自有 Host，各重启 3 次。
实现每次恢复得到 3 个确定丢失执行的中断候选；确认其中 1 个后再强杀，重启后
仍为 1 已读、2 未读、恰好 3 条中断事实。夹具同时确认没有伪造附件完整性事件。
这证明合成持久现场的进程恢复链路；不作为真实 Runtime、多平台或发布构建的性能结论。

## 门禁记录

2026-10-21，在同步上述 main 后验证：

- `cargo test --workspace -j2`：474 passed，1 项既有 ignored；定向 slow owner 25 passed。
- `pnpm typecheck`、`pnpm test`：247 个 Vitest 文件、2,817 项通过；后续 Node 357 passed、
  2 项 Windows 限定 skipped；文档及 Skill 基础门禁通过。
- `pnpm build:desktop`：Web、Execution Web、Electron main/preload/Renderer 构建通过；
  既有大 chunk 提示仍在，不影响构建。
- `pnpm test:notification-attention` 的中断/原通知 owner 通过；Portal 扩展修正为真实鼠标输入后
  使用同入口名称过滤单独复跑通过，合计 3 项 owner 通过。
- 最终 Host 二进制的 `Desktop and Web share one Core` owner 通过，包含新公开 RPC 与命令核对。
- 此前同分支的 startup presentation、navigation shell、run presence、Desktop bridge 和
  Host notification clock owner 通过；最终后端只读连接变更由上述 Host/SQLite owner 与启动 smoke 复验。
- 隔离启动报告 `complete=true`，18 组样本齐全，已读后再崩溃的事实数量及已读保持断言通过。

正式文档遵循通用版本与决定门禁；本记录不将未执行的全平台、真实模型或发布安装验收记为通过。

## 分批读取复核修复（2026-10-21）

固定提交 `0a24616c2` 的复核发现，Renderer 虽按 200 个 Thread 请求，
却在 `Promise.all` 全部成功后才合并结果。一批失败或延迟会连带阻塞成功批次，
不符合合同的独立接收要求；此前单 Thread 交互夹具没有覆盖这一场景。

改为每批成功返回后立即合并到最新投影，失败只保留本批最后可信状态。
代次、确认水位与结果序号检查在每批成功回调内继续执行；等待所有请求仅用于合并后续刷新轮次，
不再作为接收结果的屏障。重试仍由已有通知事件、聚焦和恢复轮询驱动。

在原 Renderer owner 内增加两个 201 Thread 用例：

- 部分失败：先建立两批旧状态，再让第二批失败；第一批的真实侧栏蓝点仍出现，第二批保留旧状态，
  恢复后通过既有刷新收敛。新用例在未修复的 `0a24616c2` 控制流上确定失败。
- 部分延迟：第二批挂起时，第一批蓝点先显示；精确确认回执提升水位后释放旧响应，不能恢复旧未读。
  故意让随后重试失败，避免新的已读响应掩盖错误应用旧响应的问题，再验证正常重读恢复。

本次通过 `pnpm typecheck`、通知交互 3 个 owner（含上述两个新增场景）、
Notification Attention/Navigation Unread 定向 Vitest 24 项、Desktop bridge 1 项。
这是仅 Renderer 刷新与夹具的修复；本次没有重跑前述完整 Rust、全量前端或启动性能测量。

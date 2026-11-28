# LOOM 参考项目完整研究报告（只读）

实际编制：12 个 `oct-chat/deepseek-v4.1-flash/max` 项目工兵（批跑 4 路并发）+ 1 个 `oct-chat/glm-5.3/max` 队长审查；另有前段 1 个 glm 队长 + 3 个 deepseek 工兵完成 rokbot/LOOM 手机链初查。只读研究，未改 LOOM，未开 cand，未联网查资料。

范围与口径：参考只看用户 Win11 本地快照包；rokbot 用 `4d624fc + local diff`，其余用 `refs.tar.gz` 内 tar + local diff。LOOM 对照固定为 `312bbb87629657e72ea13eee78b3042d71850a57`。用户红线：不学企业微信/飞书推送；推送只考虑 iOS APNs/Bark 与网页 Web Push。

许可证口径：只学架构和契约，不直接搬代码；需要借鉴实现时另行按编制开 cand，并在 `THIRD_PARTY_NOTICES` 标出处。ROKBot diff 中 license 状态有本地改动，仍按“自用可学、标出处、不照搬”处理。

---

# 队长审查与终极路线

# 审查报告（只读，未改任何文件）

## RESULT

对 12 份工兵报告共抽查 60+ 处引用（每项目 ≥3 参考证据 + ≥2 LOOM 对照），逐条用 read/grep 打开核对行号与语句。**未发现伪造引用**；行号全部存在且语句基本对应。发现 1 处红线违规（agenteam）、1 处通道越界建议（rokbot 提议 webhook/ntfy）。

## EVIDENCE（抽查结果，每项目一行）

- **accp：PASS**。delivery.go:196/200-215/221-240（STALE_REVIEW、TOOL_OUTCOME_UNRESOLVED、EVIDENCE_CHANGED）逐条属实；governance.go:252-260 确为 SEPARATION_REQUIRED/APPROVAL_FINAL/BINDING_CHANGED；App.tsx:230-239 移动横滑导航+aria-current 属实。LOOM 侧 mobile.css:2-22（data-mobile-web、container、safe-area）与 loom.rs:4280-4286（criteria 快照）属实。
- **agenteam：FAIL（红线）**。证据本身真实（IntegrationQrCode.java:17-23 服务端自绘二维码、ChannelDeliveryPolicy.java:65-73 捕获凭据/绑定版本、ChannelSessionGuard.java:39-41 restricted 会话、index.ts:3349-3364 十一阶段含 unknown_remote_state——该行实际到 3364，off-by-one 无碍）。但**前 3 条建议全部是企业微信/飞书 IM 链路**（IM 个人通知外发、企微身份受限会话、飞书扫码接入），按最新红线一律不学；仅第 4/5 条（发布原子事务、定时动作注册表）可保留。
- **codeg：PASS**。types.ts:117-127（receiver_count==0 丢事件、重取快照恢复）、mobile-workspace-panes.tsx:6-14（hide 不卸载）、web-transport.ts:27-34（60s vs 5s 就绪上限）属实；client.ts:973-976（reconcile 仅显式触发）、BusinessApp.tsx:4215-4216（view==='camp' 才渲染）属实。
- **cospan：PASS**。observation.mjs:3（8192 硬预算）、:61-83 逐级降级、AGENTS.md:11 契约稳定性均属实；thread_runs.rs:161 `waitReason: {"type":"null"}`、run_continuation.rs:44-47 `invocation_kind='batch' AND run.status IN ('failed','cancelled')` 属实。
- **deskfleet：PASS（小提醒）**。web/README.md:95-106（APNs/FCM + 三布尔偏好 + PUT /api/push/subscription）、agent-sessions.md:957-960（首个有效决定胜出）、scheduled-tasks.md:38-48（IANA 时区、不补跑）属实；automation.rs:47-51 确为现存 Feishu/Lark/Dingtalk 枚举（报告仅作现状引用，未推荐），automation.rs:1093 CURRENT_USER_ID 属实。提醒：落地时只取 APNs 侧，FCM/Android 不在允许通道。
- **mindfs：PASS**。vite.config.ts:158-171（SW 导航回退）、webpush/service.go:76-84（首启生成 VAPID）、relay/service.go:354-360（yamux 复用）属实；LOOM 全仓 grep `web-push|vapid|PushManager|webmanifest` **我复核为零命中**，其“缺失”结论成立。Web Push 建议合规。
- **movo：PASS**。composerFocusPolicy.ts:20（mobileDevice 直接 return false）、knowledge_admission.py:19-23（0.05/0.15/0.02）、approval_scope.py:26-34（sha256 规范化 scope_key）属实；SingleChatPanel.tsx:1177 无条件 focus、memory_retrieval.rs:36-61（无 score）、action.rs:1004-1007（bot_full_permission 总开关）属实。
- **pi-desktop：PASS（注意为文档行）**。05-remote-agent-control.md:316-336（viewer/controller/approver/owner、controller 不得自批）、13-plugin-permissions-matrix.md:71-80（net.domains 缺省即无出口）、session-collaboration.ts:119-126（发送须 Host 认证的活跃 invocation）属实；host-web-v2.md:99-114（32 会话容量）、public-a2a-message-delivery.md:42-43（不再维护 depth/root）属实。其证据多为 spec/ADR 文档行，报告已自认，非冒充实现。
- **pibot：PASS**。pairing.js:59-71（CA 嵌码、明文只返一次、库存哈希）、mobile/README.md:42-44（std::process::exit 双进程）、useBotBoard.ts:31-39（纯函数桶序）属实；LoomWorkspace.tsx:533-542（六桶任务维度）、scripts/node/README.md:66（前台运行不注册服务）属实。版本 6741737 与参考锁 8b9f3d7 不一致已自披露。
- **rakazo：PASS**。work-activity.ts:37-51（token/代际/登出 end）、WorkLiveActivity.swift:9-19、builtin-computer.tool-definition.ts:352-360（request_takeover）属实；computer.rs:70-82（CONTROL_TOTAL_MAX_MS=300_000、INPUT_IDLE_DEADMAN_MS=15_000）、automation.rs:104-122（无 watch 触发）属实。
- **rokbot：WARN**。证据真实：push-service.mjs:315-345（deviceId:itemId 去重+前台抑制+指纹）、RBNotifications.m:107-112（1MB 缓冲上限）、push-config.mjs:23-31（isPublicPushHost 拒内网/CGNAT）；operations.rs:135-149（通知事实/偏好/ack 已有）、execution-web/main.tsx:276-283（/events 无 Last-Event-ID）属实。但第 1 条建议“先落 webhook/ntfy 再补 APNs”——**webhook/ntfy 不在允许通道**（仅 APNs/Bark/Web Push），路线综合时已剔除该路径，其余投递台账设计可取。
- **rovai-ai：PASS**。host-web-mobile.md:15/17/31（768px、展示上下文、44px/16px）、native-interactions-v1.md:62/75-77（alreadyHandled、editor 无 timeout、expired 拒迟到）、memory_capability.rs:23-26（缺行=基础设施故障非用户关闭）属实；native.css:142-143（仅 800/520px 窗口断点）、pi-questions.ts:8-21（无 expiresAt、options 仅 string[]）属实。

## 全库 8 条候选（按价值排序，推送仅 APNs/Bark/Web Push）

1. **手机推送投递台账层**（rokbot push-service.mjs:315-410 + deskfleet README:95-106）：LOOM 已有通知事实/偏好（operations.rs:135-149），缺投递层——deviceId:itemId 去重、前台抑制、410 清 token、有限退避、投递后复核。大小：大；风险：中（.p8 密存、Bark 端点 SSRF 校验）。
2. **PWA 安装壳 + Web Push**（mindfs vite.config.ts:212-229、webpush/service.go:76,559-563）：manifest/apple meta/SW 离线壳，iOS 加主屏后 Web Push 才可用；VAPID 密钥持久化、410/404 删订阅。大小：中；风险：中（订阅端点属凭证面，不入日志）。
3. **手机验收断言化**（accp ui.spec.ts:1549-1576 真实 390×844 + movo composerFocusPolicy.ts:20）：LOOM 手机验证多为 CSS 文本断言，补“无横向溢出、≥44px、aria-current、凭据不落盘、不抢焦点”的可跑断言。大小：小；风险：低。
4. **保活面板 + 事件就绪栅栏**（codeg mobile-workspace-panes.tsx:6-25 + types.ts:117-152）：切视图不卸 Thread、发命令前 waitForReady。大小：小-中；风险：低-中（浮层/焦点泄漏）。
5. **“等你拍板”自解释状态**（cospan job-diagnostics.mjs:138-158 reason/summary/recovery + rakazo WorkLiveActivity.swift:9-55 锁屏投影）：LOOM waitReason 恒 null（thread_runs.rs:161），手机卡片须带可执行动作。大小：中；风险：低。
6. **run 进度快照硬预算 + observe/wait 原语**（cospan observation.mjs:3,61-83；AGENTS.md:11）：8KiB 逐级降级，手机轮询 payload 有上界；wait 的“运行中不算错误”退出码。大小：中；风险：中（新原语语义）。
7. **远端会话角色与权限上限**（pi-desktop 05-remote-agent-control.md:316-336 + deskfleet agent-sessions.md:957-960）：viewer/controller/approver 分离、controller 不得自批、首个有效决定胜出并记账。大小：中；风险：中（与现有 editor 语义并存）。
8. **调度显式 IANA 时区**（deskfleet scheduled-tasks.md:38-48）：LOOM AutomationSchedule 仅 `at: String`（automation.rs:104-122）、宿主 Local 求值、claim 写 CURRENT_USER_ID（automation.rs:1093），上云即漂移。大小：小；风险：低。

## LOOM 终极方案（5 步）

**第 1 步（iOS/手机优先）：手机 Web 壳达标 + 验收断言**。改 `apps/web/index.html`（manifest/apple meta）、`apps/web/src/mobile.css`（已有基础）、composer 聚焦策略（参照 movo，SingleChatPanel.tsx:1177 处加环境开关）+ 新增 390×844 Playwright 断言。大小：小-中；风险：低。macOS Actions 验：跑 web 单测 + 既有 capture 脚本加手机视口档；无需新凭据。
**第 2 步（iOS）：推送双通道 + 投递台账**。APNs（.p8 自托管不可用则先接 Bark）+ Web Push（VAPID），改 `crates/rovai-web`（新 push 模块、订阅/偏好 operation）、通知事实表旁挂投递台账；设备令牌加密存储、端点 SSRF 校验（学 rokbot push-config.mjs:23）。**不引入任何 IM 通道**。大小：大；风险：中。Actions 验：投递状态机单元测试 + fake APNs/Bark/WebPush server 集成测试；.p8 不进 CI。
**第 3 步：状态语义落地**。waitReason 落实（thread_runs.rs:161）、reason/summary/recovery 三件套、run 快照 8KiB 预算（thread_runs.rs:145-197 加字节级上限与 truncated）。大小：中；风险：低。
**第 4 步：多端角色与仲裁**。会话角色 + 远端权限上限 + 首个有效决定胜出 + 设备台账与撤销级联（撤一台设备原子吊销推送/SSE）。改 rovai-web auth/session、core action。大小：中-大；风险：中。Actions 验：并发决定仲裁与撤销级联的单元测试。
**第 5 步：异步委派原语**。blocked_on（等人 vs 在跑）+ observe/wait 有预算阻塞 + 深度 1 worker 边界（pi-desktop ADR 0237 与 cospan 通道语义合并）。大小：大；风险：中（血缘/取消需先定）。

## CHECKS
- 工具：read/grep/find/ls 只读抽查 60+ 处引用，全部行号可达、语句对应；LOOM 全仓 `web-push|vapid|PushManager|webmanifest` 零命中已独立复核。
- 未运行任何构建/测试（本任务为只读审查，环境亦未提供执行通道）；所有“缺失”结论均为文本检索级，非行为验证。
- 红线核查：12 份报告中仅 agenteam 3 条建议落在企微/飞书 IM（不学），rokbot 1 处 webhook/ntfy 越界（剔除）；其余推送建议均限 APNs/Bark/Web Push 或 iOS 原生 Live Activity。

## BLOCKERS
无。

STATUS: DONE_AWAITING_APPROVAL

---

# 分项目完整研究结果


## rokbot@4d624fc

**RokBot 是什么**：自托管的私有 AI 助手——Host（Node 管理服务 + 原版运行时 + 模型适配）与 box（Docker 里的 Linux 桌面）跑在你自己的服务器上，Mac/Win/Linux/iOS/Android/网页六端用配对码连同一台 Host，客户端是对官方 App 打补丁后重定向到自建 Host。

---

**1. 推送是一本可核对的"投递台账"，不是一句 APNs 调用（手机优先）**
- 参考证据：`rokbot@4d624fc host/server/push-service.mjs:315-345`（enqueue：按 `deviceId:itemId` 去重、前台抑制、配置指纹入账）、`host/server/push-service.mjs:347-384`（flush：设备撤销/配置指纹变了/超过 24h 直接 cancelled，非重试错误不重发）、`host/server/push-service.mjs:386-410`（settle：最多 4 次、`min(300s, retryMs*2^n)` 退避、invalidToken 清 token 并写 registrationError）；`host/server/push-config.mjs:23-58`（`isPublicPushHost`：回环/内网/CGNAT/元数据/`.local`/`.internal` 全拒）；`host/server/push-transports.mjs:382-410`（410/BadDeviceToken=令牌失效，429/5xx/ExpiredProviderToken=可重试，且重定向一律拒绝）。
- LOOM 对照：`LOOM@312bbb8 crates/rovai-web/src/operations.rs:135-149` 已有通知事实、changesSince、偏好与 ack，`apps/desktop/src/renderer/src/NotificationSettings.tsx:109-143` 有偏好读写；但没有投递通道、设备令牌、前台抑制与重试台账（`crates` 里检索 push/apns 无传输实现）。
- 借鉴价值：把"通知事实"与"投递"分层，LOOM 可先落 Bark/Web Push 再补 APNs，不走 webhook/ntfy。改动大小：大。风险：中（.p8/服务账号要密存；用户自填端点必须做 SSRF 校验）。

**2. 移动端常驻 SSE：游标 + 前台声明 + 有上限的退避**
- 参考证据：`rokbot@4d624fc ios/clients/ios/RBNotifications.m:44-90`（只在 App active 时连 `/notifications/events`，带 `X-RokBot-Foreground: 1` 和按 base URL 持久化的 `Last-Event-ID`）、`:92-99`（200 才清零重试；401 立即停并弹配对）、`:107-118`（1MB 缓冲上限、忽略重定向）、`:177-190`（`min(60, 3*2^n)`、最多 8 次、generation 防旧任务复活）；Host 侧 `host/server/notifications.mjs:101-166`（replayItems 按条数与 128KB 双重封顶、15s heartbeat、256KB 背压断流）。
- LOOM 对照：`LOOM@312bbb8 apps/desktop/src/execution-web/main.tsx:276-290` 的 `/events` 只带 Accept，没有 Last-Event-ID；`:325-338` 固定 1.2s 重试，无退避/抖动，也无法告诉服务端"我在前台"。
- 借鉴价值：同一套 SSE 要同时在桌面/手机/浏览器跑时，游标和前台声明决定"重复推送还是漏通知"。改动大小：中。风险：低。

**3. 配对：短码/密码双模 + 设备台账去重 + 配对即交付端点**
- 参考证据：`rokbot@4d624fc host/server/auth.mjs:160-176`（6 位、去掉 I/L/O/0/1 的字母表、5 分钟 TTL、只存 hash、保留最近 19 个）、`:188-241`（码/密码只能给一个、platform 白名单、web/android/ios 归一）、`:256-323`（按 `clientDeviceId` 或 legacy bundleId+同名复用主记录、轮换 token、吊销重复、上限 100 台）、`:415-441`（6/IP、60 全局、密码 5/IP，响应直接带 gatewayUrl 与 notificationUrl）；客户端 `ios/clients/ios/RBConnection.m:725-820`（401/403/409/429 各有可读原因，且校验返回的 gatewayUrl 与所填地址一致才落盘）、`ios/clients/ios/RBDeviceIdentity.m:71-107`（Keychain + NSUserDefaults 保住同一个 clientDeviceId）；管理页 `host/server/public/devices.js:188-205`（一次性码实时显示"已使用/已过期"）。
- LOOM 对照：登录票据其实更强（`crates/rovai-web/src/auth.rs:425-460` digest 存储、一次性、限速；`crates/rovai-web/src/lib.rs:507-560` 兑换），node 也已有 10 分钟一次性码（`crates/rovai-host/src/node_cli.rs:58-66`），但只有 `clientId` 会话（`auth.rs:55-79`），没有持久设备台账、去重、按设备撤销与"配对即返回端点"。
- 借鉴价值：短码是"人能念出来"的入口，设备台账是"换机/重装不产生幽灵设备"的前提；LOOM 应保留现票据强度，另加设备层。改动大小：中。风险：中（短码熵低，必须限速 + 短 TTL，不可替代 256-bit ticket）。

**4. Host/box：执行面收敛成"一个 Bearer 网关 + 路径白名单 + 逐服务健康"**
- 参考证据：`rokbot@4d624fc host/deploy/execution-gateway.mjs:11-47`（单 token 授权；只放行 `/exec`、`/windows`、`/vnc/{desktop,fork}`，含 `..`/%2e/%2f 穿越拒绝；`/health` 逐端口探测返回 `{protocol, ready, services}`；`upgrade` 只允许 `/vnc/` 且必须带 token）；`host/server/execution-node.mjs:63-79`（保存时校验 URL 与 32–256 位 key，测试时要求 `protocol==='rokbot-execution/v1' && ready===true` 才算通过）。
- LOOM 对照：node 出站 WS 与控制面已分离（`crates/loom-node/src/session.rs:142-245`）、能力广播在 `:457-483`；但电脑页没有屏幕流提供者（`PRODUCT.md:47`），也没有把执行/窗口/画面挂到同一个受限入口的合同。
- 借鉴价值：补屏幕流前先定"一个凭据 + 有限路由 + 未就绪即未连接"，把"连上了"和"真可用"分开。改动大小：中。风险：中（WS 反向代理、token 泄漏面、绝不可做任意路径转发）。

**5. 设备分权与撤销级联（多端隔离的最小闭环）**
- 参考证据：`rokbot@4d624fc host/server/index.mjs:351-360`（web 监听只认 Cookie、主监听只认 Bearer，platform 与通道必须匹配）、`:381-395`（改模型需管理员密码 step-up，IP 与设备各限 5 次）、`:407-452`（VNC 用短期票据 + 按路径限定 Cookie，只对原生 App 接受 `Origin: null`）、`:454-464`（撤销设备同时吊销推送登记、VNC 票据、SSE 连接）；`host/server/web-client.mjs:296-302`（Cookie + `x-rokbot-web: 1` + 同源，两道防线）。
- LOOM 对照：会话层已有单 clientId 单会话与容量淘汰（`crates/rovai-web/src/auth.rs:493-520`）、node 有 `/nodes/{node_id}/revoke`（`crates/rovai-web/src/lib.rs:320`），但没有"设备"这一层，撤销也不会级联到推送/画面/流——因为这三者还不存在。
- 借鉴价值：多端一旦成立，"撤一台设备"必须是原子动作，否则留下能继续收推送的幽灵连接。改动大小：小-中。风险：低。

许可证/来源提醒：RokBot 仓库标 MIT，但 iOS/Android 的注入库与 `.gbp.gz` 字节码配方是上游第三方数据（见其架构文档 iOS/Android 段），LOOM 只学设计，不要复制补丁脚本、recipe 或 App 内代码。

READ_FILES：host/server/push-service.mjs；host/server/push-transports.mjs；host/server/push-config.mjs；host/server/notifications.mjs；ios/clients/ios/RBNotifications.m；ios/clients/ios/RBConnection.m；ios/clients/ios/RBDeviceIdentity.m；host/server/auth.mjs；host/server/index.mjs；host/server/web-client.mjs；host/deploy/execution-gateway.mjs；crates/loom-ref(loom-ref-312bbb)/crates/loom-node/src/session.rs。

LIMITS：纯只读，未运行任何构建/测试；Android 侧只依据 `docs/ARCHITECTURE.md` 的段落，手机结论以 iOS 源码为准；FCM/ntfy/UnifiedPush 只读了分类与部分分支，未逐行通读；"多端打包"（iOS 四目标自签、Android 覆盖升级）只读了 `ios/README.md:25-43`，证据不足以单列，故未入选；附件只读了 `host/server/attachments.mjs` 与 `index.mjs:1365-1420`，判断 LOOM 的 managed_attachment/downloads 更完整，未作借鉴条目；第 4/5 条的 LOOM"缺失"是检索未见，不等于证明不存在（未通读 loom-protocol）。

STATUS: DONE_AWAITING_APPROVAL

## deskfleet@091e4d9

只读研究完成。以下为纯文本结果。

────────────────────────────
一句话：DeskFleet（deskfleet@091e4d9）是“团队共享的 AI 编码代理控制台”——Rust/Actix Web 中央控制面（PostgreSQL，存团队、机器注册、同步历史、信令）+ 每台机器一个 TypeScript daemon（本地 SQLite 权威 journal，napi-rs 提供 WebRTC/PTY/抓屏）+ Electron/Web/Capacitor 共享 Vue 前端，代理走 ACP，远程操作走授权后的 WebRTC 数据通道。

────────────────────────────
最值得 LOOM 学的前 5 条

1）把“等你拍板”推到手机：推送订阅 + 点击直达会话
参考证据：`deskfleet@091e4d9 apps/web/README.md:95-106`——原生壳用 `@capacitor/push-notifications`（证据同时描述 iOS/Android；按红线只借鉴 iOS APNs 侧），且在“开关打开 + 已授权通知 + 已登录”三条同时满足时才把 push token、locale 和 `enabled/taskCompleted/taskNeedsInput` 三个偏好写到 `PUT /api/push/subscription`，点通知直接打开目标 Session；服务端只持凭据（`apps/server/README.md:122-141`）；手机上“本地文件夹”由原生端点注入共享传输队列，不靠浏览器目录句柄（`agents/docs/files.md:208-227`）。
LOOM 对照：`LOOM@312bbb8 docs/loom/LOOM-ARCHITECTURE.md:37` 写的是“Web / Desktop / 未来 Mobile”，`apps/` 只有 desktop 与 web（实测 apps 下无 capacitor/manifest.webmanifest/serviceWorker）；LOOM 目前没有 APNs/Bark/Web Push 投递层；缺安装形态、缺推送、缺把 AttentionItem 落到手机。
借鉴价值：LOOM 的“需要你拍板/任务完成”正是必须打断人的事件，手机推送是最短路径；只要三个布尔偏好就够，不必先造通知中心。改动大小：大（Capacitor 工程 + iOS/Android 签名与推送凭据）。风险：中（凭据与隐私、审核周期），可先只做 TestFlight/内部包。

2）多人共享同一活跃会话：不设控制租约，规则是“首个有效决定胜出”
参考证据：`agents/docs/agent-sessions.md:13-23`——所有已授权客户端可同时操作，daemon 只在 Team registration 内排序状态变更/输入投递/审批；关掉所有观看者后代理继续跑、审批继续挂着；`:887-898` 共享 backlog 按接收序排队、可 Steer now 或撤回、提交返回含 operationId 的持久回执；`:957-960` 权限请求先落稳定 permission ID 再广播，第一个有效决定生效，后来的决定只返回该结果并各留审计，只有胜者触发 provider 回调。
LOOM 对照：`crates/rovai-core/src/current_user.rs:5` 仍是单一 `local_user`；作者身份已能写 `external_principal`（`collaboration.rs:2954-2961`）；Web 只做单向 invalidate/resync（`crates/rovai-web/src/lib.rs:777-779`）。缺“多观看者共享 backlog / 决定仲裁 / 谁批的记账”三条规则。
借鉴价值：LOOM 今天多窗口、多端就会出现“两边同时点批准”，先把规则和落库写死（决定 ID、首个生效、actor 记账），不动执行路径。改动大小：中。风险：低。

3）远程机器：把“授权”与“连接”分开，别自己造加密层
参考证据：`agents/docs/webrtc-security.md:42-52`——grant 按 login/user/registration/Team/purpose 分级配额（含按用途 32、桌面 8 个槽），落库先给 2 分钟预留租约、激活才给完整期限，失败即回收；`agents/docs/architecture.md:255-260` daemon 每 20 秒心跳按 PostgreSQL 对账 peer grant，撤销广播丢了也能关掉该关的 peer；`:265` 跨实例 inbox 是 at-most-once 且有过期，命令重试前先查 operation receipt。信任模型明说信任中心信令、不自造密钥层、不防恶意中心。
LOOM 对照：`LOOM-ARCHITECTURE.md:113`、`:181` 已定“不移植 WebRTC 整套”；loom-node 侧已有配对 TTL（`crates/rovai-web/src/nodes.rs:344-352`）、连接代次与旧 socket 退役（`:467-497`）、workspace 准入（`crates/loom-node/src/workspace_authority.rs:130`）。缺“grant 自带动作集/期限/配额、可撤销、并与服务端周期对账”这一层。
借鉴价值：不搬 WebRTC，搬它的授权语义——用途分离、期限、撤销对账，以及“重连 ≠ 重新授权”。改动大小：中。风险：中（撤销与在线连接的正交性最容易做错）。

4）离线可读历史：副本只是显示投影，永不推进权威游标
参考证据：`agents/docs/architecture.md:78-80`——服务端存同步视图，机器离线也能翻历史，客户端显示“这份数据最后观测于何时”；`agents/docs/agent-sessions.md:1376-1396`——IndexedDB 缓存最多 30 个会话/32MiB、按最近访问淘汰、每秒批量写、不缓存未提交流，并明确“显示投影，不是 daemon 游标或授权源”，不增加离线登录或离线写；`:1514-1518` 保留历史可先填屏，daemon 历史到货即覆盖（含相同序号），迟到响应不得覆盖 journal。
LOOM 对照：Core 是唯一事实，会话历史天生不受设备离线影响（这是 LOOM 的优势）；但远端节点内容一断就直接报错（`crates/rovai-web/src/resources.rs:386-414` 一路 `node_offline`），前端无本地缓存、也没有“这是缓存/最后观测时间”的披露。
借鉴价值：把“能读”与“能操作”在 UI 上分开；缓存键含账号/设备/会话并设硬上限；任何迟到副本不回写权威。改动大小：中（前端为主）。风险：低（最大坑正是把缓存当授权或游标）。

5）调度：显式时区 + 先 claim 后派发 + 不补跑（LOOM 已有大半，补两点）
参考证据：`agents/docs/scheduled-tasks.md:38-48`——日/周触发存显式 IANA 时区加 `HH:mm`，不存在的夏令时跳过、重复墙钟只取第一次，间隔从当前派发推进、不回放错过的那批；`:53-70` 派发前先落 claim 和 operation ID，复用同一套会话创建/目录/backlog/审计/审批流，同一任务上一轮未结束记 skipped 而不并发，完成以 journal 实际结局为准而非 RPC 返回；`:1-9` timer 归 daemon，窗口关闭、观看者断开都不停。
LOOM 对照：已有 claim 与不补跑（`crates/rovai-core/src/automation.rs:1061-1095`：missed→skipped、overlap→skipped、否则 claim）与休眠边界（`automation_clock.rs:1-8`）；但 `AutomationSchedule` 只有 `at: String`（`automation.rs:102-121`），Cron 求值用宿主 `Local`（`automation.rs:2510-2516`），claim 固定写 `CURRENT_USER_ID`（`:1087-1095`）。
借鉴价值：Core 上云跑 UTC 后，用户设的 09:00 会漂，必须把 IANA 时区存进任务；自动执行要记“保存/发起的用户”而不是当前用户。改动大小：小。风险：低。

────────────────────────────
许可与来源：本报告只借思路、不搬代码。注意 DeskFleet README 声称 Apache-2.0，但本快照 `LICENSE:1` 实为 MIT，LOOM 参考锁亦记 MIT（`docs/loom/LOOM-V2-REFERENCE-LOCK.md:43`）；两处不一致，若日后整段搬代码，须先核对 LICENSE/NOTICE 与专利条款。

READ_FILES（12）
1 /home/ubuntu/rokbot-research/refs/deskfleet-091e4d9/README.md
2 …/refs/deskfleet-091e4d9/agents/docs/architecture.md
3 …/refs/deskfleet-091e4d9/agents/docs/agent-sessions.md
4 …/refs/deskfleet-091e4d9/agents/docs/scheduled-tasks.md
5 …/refs/deskfleet-091e4d9/agents/docs/webrtc-security.md
6 …/refs/deskfleet-091e4d9/agents/docs/files.md
7 …/refs/deskfleet-091e4d9/apps/web/README.md
8 …/refs/deskfleet-091e4d9/apps/server/README.md
9 /home/ubuntu/loom-ref-312bbb/docs/loom/LOOM-ARCHITECTURE.md
10 …/loom-ref-312bbb/crates/rovai-core/src/automation.rs
11 …/loom-ref-312bbb/crates/rovai-core/src/current_user.rs
12 …/loom-ref-312bbb/crates/rovai-web/src/resources.rs

另核对过但未列入 12 项（受上限）：LOOM `crates/rovai-core/src/collaboration.rs`、`automation_clock.rs`、`crates/rovai-web/src/lib.rs`、`nodes.rs`、`computer/node_provider.rs`、`crates/loom-node/src/workspace_authority.rs`、`docs/loom/LOOM-V2-REFERENCE-LOCK.md`、deskfleet `LICENSE`。

LIMITS
- 全程只读：未写任何文件、未联网、未运行构建或测试，未修改参考项目或 LOOM。
- DeskFleet 侧只读了文档与少数入口文件，未读 `apps/daemon`、`packages/client`、`crates/native` 实现，故“改动大小”是按文档所述形态估算，不是按代码行数评估。
- 手机端只核对了 Web/Server 文档与 `files.md`，未打开 Capacitor 工程目录（`apps/web/ios`、`android`），也未验证推送在真机上的行为。
- LOOM 侧为抽查：未确认 LOOM 是否已有未落地的移动端/离线缓存计划文档；多用户明确排在 P14，与本次建议不冲突。
- DeskFleet 文档自称的测试与验收（含 `control-plane-verification.md`）未复核，不作为已验证结论引用。

STATUS: DONE_AWAITING_APPROVAL

## codeg@b457eca0

RESULT

**codeg@b457eca0 是什么**：Tauri(Rust) 桌面壳 + Next.js 前端，同一份 Rust lib 另编出无 UI 的 `codeg-server`；前端用 Transport 抽象在 IPC / 浏览器 / 远程桌面三通道间切换，智能体侧靠 per-launch 的 `codeg-mcp` 伴随进程把 Core 能力（含异步委派）暴露给本地 agent CLI。

**最值得 LOOM 学的前 5 条**

1. 移动端的“就绪栅栏”：把重连语义写进传输契约
- 参考证据：`codeg@b457eca0 src/lib/transport/types.ts:117-152`（onReconnect/onReady/waitForReady；注释写明断开窗口里广播器 receiver_count==0 直接丢事件，唯一恢复手段是重取快照）；`src/lib/transport/web-transport.ts:27-34`（60s 调用超时 vs 5s 就绪等待上限，超时放行不锁死 UI）
- LOOM 对照：`LOOM@312bbb8 apps/web/src/client.ts:973-975` 明确 reconcile 只由用户显式触发、SSE/重连/登录都不触发；`apps/web/src/client.ts:342-357` 已用 invalidate/resync 失效重读。缺“发命令前先等事件通道就绪”这道栅栏，也没有把就绪/重连收进统一接口
- 价值：手机切前后台、弱网必踩；改动小；风险低

2. 移动端面板保活：隐藏而不卸载
- 参考证据：`codeg@b457eca0 src/components/layout/mobile-workspace-panes.tsx:6-25`（对话面板切走后 invisible+aria-hidden+inert 仍挂载，注释写明“不释放 runtime”）；`src/hooks/use-mobile.ts:3-8`（767px 断点）
- LOOM 对照：`LOOM@312bbb8 apps/desktop/src/renderer/src/BusinessApp.tsx:4215-4218`（canRenderThread 要求 view==='camp'，切视图即卸载 ThreadWorkspace）；`apps/desktop/src/renderer/src/MobileLayout.tsx:8-16` 只做视口判定与过渡；`docs/loom/LOOM-ARCHITECTURE.md:37` 里 Mobile 仍是“未来”
- 价值：中（LOOM 已有草稿/滚动持久化，收益主要是省掉返回时重读首屏）；改动小；风险低-中（隐藏面板的浮层、焦点、aria 不能泄漏）

3. MCP 异步子智能体：秒回 ack + 状态族 + “卡在你拍板”
- 参考证据：`codeg@b457eca0 src-tauri/src/acp/delegation/tool_schema.json:3-42`（工具描述自述 ASYNCHRONOUS、立刻返 task_id、可扇形并发、@Agent 视为显式委派、子智能体冷启动）；`src-tauri/src/acp/delegation/types.rs:332-460`（Running/Completed/Failed/Canceled/Unknown + BlockedKind + DelegationProgress 步数与每步成败）；`src-tauri/src/bin/codeg_mcp.rs:1-35`（per-launch stdio MCP，token+UDS，父进程死则自退）；`src-tauri/src/chat_channel/session_event_subscriber.rs:1021-1026`（聊天通道只播一行“Delegated…running in background”）
- LOOM 对照：`docs/loom/LOOM-ARCHITECTURE.md:28`、`:184` 已定 cospan job 协议（send/wait/observe/continue/result/cancel，含 stdio MCP 形态）；但 `crates/rovai-core/src/context.rs:24` 现行规则是“Do not background … native subagents”，`context.rs:7928` 的委派只有成员消息一条路，没有 agent 自发的 delegate 工具族，也没有 blocked_on 这种“等人拍板 vs 真在跑”的区分
- 价值：高；改动大；风险中（血缘/深度限制/取消与恢复须先定）

4. 共享核心：一个 *_core、两个薄适配、一个无 UI 二进制
- 参考证据：`codeg@b457eca0 src-tauri/src/commands/delegation.rs:192-255`（clamp+落库+推 broker 只在 set_delegation_settings_core 一处，命令仅用 `#[cfg_attr(feature="tauri-runtime", tauri::command)]` 接线）；`src-tauri/src/web/handlers/delegation.rs:1-40`（HTTP 复用同一 core 函数）；`src-tauri/src/web/event_bridge.rs:117-131`（EventEmitter 三态 Tauri/WebOnly/Noop）；`src-tauri/src/bin/codeg_server.rs:1-20`（同一 lib 编出服务器，含 --supervise）
- LOOM 对照：`crates/rovai-web/src/lib.rs:60-70` 已把 CoreService 放同进程，`crates/rovai-web/src/operations.rs:1-8` 有显式 Operation 白名单（比 codeg 更严）；`apps/desktop/src/preload/index.ts:104-106` 走 IPC。缺“同一语义只写一次”的显式约束和事件发射口子统一
- 价值：中高；改动中；风险中（别为对齐放宽白名单）

5. 每连接 attach：快照/补播阈值 + 背压 + detach 原因
- 参考证据：`codeg@b457eca0 src-tauri/src/web/ws_attach.rs:1-70`（attach 带 since_seq，服务端在锁内决定 snapshot 还是 replay；REPLAY_BATCH_THRESHOLD=32 超阈值直接给快照；OUTBOUND_CAPACITY=64 背压）；`:92-105`（DetachReason: connection_gone/lagged/server_shutdown）
- LOOM 对照：`LOOM@312bbb8 apps/web/src/client.ts:342-357` 已有 resync/invalidate 帧与 `:1357` 的合并上报；缺“按 gap 大小决定补播或重取快照”的阈值与首帧高水位语义
- 价值：中；改动中；风险中（双协议兼容期）

只学思路不搬代码：codeg 为 MIT（`LICENSE:1`），与 LOOM 决策 10（`docs/loom/LOOM-ARCHITECTURE.md:26`）的“保留版权与出处”一致。

READ_FILES（12）
1. codeg:/src/lib/transport/types.ts
2. codeg:/src/lib/transport/web-transport.ts
3. codeg:/src-tauri/src/web/ws_attach.rs
4. codeg:/src-tauri/src/acp/delegation/types.rs
5. codeg:/src-tauri/src/acp/delegation/tool_schema.json
6. codeg:/src-tauri/src/acp/delegation/mod.rs
7. codeg:/src-tauri/src/bin/codeg_mcp.rs
8. codeg:/src-tauri/src/commands/delegation.rs
9. codeg:/src-tauri/src/web/handlers/delegation.rs
10. codeg:/src/components/layout/mobile-workspace-panes.tsx
11. LOOM:/apps/web/src/client.ts
12. LOOM:/crates/rovai-web/src/operations.rs

LIMITS
- 只读；未跑构建/测试，未联网，未改任何文件。
- codeg 委派实现只读了类型、工具 schema 与模块头，未读 broker/spawner/listener 主体，故“改动大小=大”是估算。
- LOOM 侧未逐页核对移动端是否已有 keep-alive；未评估 async 委派对 cospan 契约的兼容成本。
- 移动原生 App 与 Android 仓库不在快照内（codeg 手机端是外部 iOS/Android 客户端连同一 Web 服务），无法核对客户端实现。
- PWA/Service Worker（`codeg src/lib/service-worker.ts`）同属移动端差异，本次未展开。

CHECKS
- 所有引用行均以 read/grep 打开核对；未运行任何测试或构建（按要求）。
- 无失败测试（未运行）；无阻断项。

STATUS: DONE_AWAITING_APPROVAL

## cospan@565db03

## 一句话
`cospan` 是一个**跨 harness 的异步委派适配器**：Node ≥20、纯 ESM、零运行时依赖，用一套 CLI + stdio MCP（`send/wait/observe/continue/result/cancel/status/ask`）把 agy、codex、claude、dsh 四个 headless coding CLI 统一成"派活—后台跑—按需取回"的作业协议。

## 最值得 LOOM 学的前 5 条

**1. 给"看进度"一个 8 KiB 硬预算快照，正文只留指针**
- 参考证据：`cospan@565db03 src/observation.mjs:3`（`SNAPSHOT_MAX_BYTES = 8192`）；`src/observation.mjs:61-83`（`boundSnapshot` 逐级降级：先丢 `recent_activities`、再清 `latest_text`、再把顶层字符串截到 256/512、最后退到最小快照并标 `truncated`）；`src/job-diagnostics.mjs:105-130`（`readObservation` 只返回 `details` 里的 `raw_output/diagnostics/result` 三个文件路径，不塞正文）；`AGENTS.md:11` 把"`<= 8 KiB` bounded `observe` JSON"写进 Contract Stability。
- LOOM 对照：`LOOM@312bbb8 crates/rovai-core/src/thread_runs.rs:145-197` 的 output schema 只有分字段与条数上限（`:159` `messagePreview` maxLength 201、`:181` items maxItems 100），整包没有字节预算，也没有"逐级降级 + 汇总 truncated"；`crates/rovai-core/src/memory_retrieval.rs:26-32` 已有聚合字节预算先例（`MEMORY_SEARCH_ALL_SNIPPETS_MAX_BYTES = 2_048`），但没用到 run 投影上。
- 借鉴价值：手机/远程端（390 宽、蜂窝网络）轮询 run 进度时，整包必须有硬上界，否则列表一长就把 payload 拉爆；host 侧 agent 也能"看进度"而不吃正文。改动大小：中；风险：低。

**2. 让"在跑/等待"自解释：reason + summary + recovery 三件套**
- 参考证据：`src/job-diagnostics.mjs:36-57`（`timeoutRecovery`：建议 timeout 翻倍且封顶于 `src/cli-args.mjs:5` 的 120m、给出 `at_timeout_ceiling`、直接产出可执行的 `continue`/`restart` 命令行、`requires_user_confirmation: true`）；`src/job-diagnostics.mjs:138-158`（非 done 状态统一补 `reason/summary/recovery`，attention 的 summary 直接写"问用户是否继续"）；`skills/codex/SKILL.md:27-28`（exit 2 就再 wait、exit 5 先问用户再 continue）。
- LOOM 对照：`crates/rovai-core/src/thread_runs.rs:161` 与 `:274` 的 `waitReason` 是 typed null 且代码恒写 null——run 卡在 `waiting` 时既没有原因也没有下一步；失败侧反而做得好（`crates/rovai-core/src/runtime_failure.rs:33-41` 有 origin/phase/code/summary/detail/retryable）。
- 借鉴价值：手机端"需要你"卡片必须带一个可执行动作（延长 timeout / 续跑），而不是只有状态词；顺手把 `waitReason` 从占位字段变成真字段。改动大小：小；风险：低。

**3. `continue` 要有 `--last` 简写、运行中拒绝、以及血缘链接**
- 参考证据：`src/commands/dispatch.mjs:157-181`（`--last` 取本工作区最近一个"非 running 且有 conversation_id"的 job，可按 target 过滤，找不到就明确报错）；`:183-190`（仍在跑直接拒绝："wait for it or cancel it before continuing"）；`:203-218`（继承 readonly/permissions/timeout，写 `conversationId` 与 `continuedFrom`）；`skills/codex/SKILL.md:31`（follow-up 只传 delta 指令）。
- LOOM 对照：`crates/rovai-core/src/run_continuation.rs:18-31` 的命令只有 `agent_run_id`/`use_new_session`，没有 last 简写；`:40-70` 的资格要求 `invocation_kind='batch'` 且 `run.status IN ('failed','cancelled')`，成功结束的 run 无法"接着说"，只能重新开消息派活。
- 借鉴价值：手机上"接着让它改"是最常见动作；LOOM 的门槛偏严是为会话/幂等安全，建议只在"用户明确续跑"路径放宽并保留血缘。改动大小：中；风险：中。

**4. 派活信封固定四件事：访问模式、护栏、脏工作区有界快照、回复状态前缀**
- 参考证据：`src/envelope.mjs:83-118`（`wrapPrompt` 约 15 行：workspace/branch/date、READ-ONLY 或 WRITABLE、禁 `git commit/push/reset/clean` 等默认关闭的护栏、要求最终回复以 `Status: DONE|DONE_WITH_CONCERNS|BLOCKED` 开头）；`:40-63`（`formatDirtyContext`：最多 100 行/16 KiB、注明 omitted、提示"不要动无关改动"）；`:92`（`raw: true` 整段旁路，便于上层框架接管）；`:65-80`（`computePorcelainDelta` 派活前后比对，只回变更与被回滚文件）。
- LOOM 对照：`crates/rovai-core/src/team_tool.rs:111-123` 的 `ThreadMessageSendInput` 只有 body/to/mentionUser/publicOnly/taskId/files——没有访问模式、没有护栏、也没有"回复形态"要求；权限是成员级配置（`crates/rovai-core/src/agent_runtime_adapter.rs:3563-3566` 的 native / workspace_read_only / workspace_read_write / workspace_workflow），教学文案（`crates/rovai-core/src/camp_message_send_teaching.rs:1`）只强调"send 只证明已提交，不证明对方开工或完成"。
- 借鉴价值：状态前缀让"完成/有疑虑/被阻塞"可机器判定，手机卡片和 host 都少一轮解析；脏工作区快照能避免委派方误回滚他人改动。改动大小：小；风险：低（用开关旁路即可灰度）。

**5. 三条通道分离：ask（2m 只读同步）/ send（异步写）/ wait（有预算阻塞，"运行中"不算错误）**
- 参考证据：`src/cli-args.mjs:5-18`（send 默认 60m、120m 上限；ask 2m；wait 100s；退出码 `0/2/3/4/5` 含 `attention`）；`src/commands/dispatch.mjs:105-141`（`cmdAsk` 强制 `readonly: true` 走前台）；`src/mcp/tools.mjs:284-291`（wait 的 exit 2 与 5 是结构化生命周期结果，只有 1/3 才算错误）；`src/commands/lifecycle.mjs:11-33`（wait 以 200ms 轮询到预算为止，不无限等、不空转）。
- LOOM 对照：`crates/rovai-core/src/team_tool.rs:54-101` 的 46 个工具里没有 wait/observe，只有 `thread.runs`（`crates/rovai-core/src/thread_runs.rs:21-28` 的六态列表）；`camp_message_send_teaching.rs:1` 已明说 send 不证明对方开工，但 agent 没有便宜的"窥视/有预算等待"原语，只能重跑列表或被回复消息唤醒。
- 借鉴价值：避免小问题也占一条后台 run，也避免把"还在跑"误判成失败；ask 通道还能挡住"只想问一句却给写权限"。改动大小：中；风险：中（新原语要同时定预算与退出码语义）。

许可证/来源：cospan 为 MIT（`LICENSE`，Copyright (c) 2026 Keli Wen）。以上只取设计取舍，不搬代码；若要复刻具体常量或协议文案，需按 MIT 保留版权与许可声明。

READ_FILES（12）
1. rokbot-research/refs/cospan-565db03/README.md
2. rokbot-research/refs/cospan-565db03/AGENTS.md
3. rokbot-research/refs/cospan-565db03/src/observation.mjs
4. rokbot-research/refs/cospan-565db03/src/job-diagnostics.mjs
5. rokbot-research/refs/cospan-565db03/src/envelope.mjs
6. rokbot-research/refs/cospan-565db03/src/commands/dispatch.mjs
7. rokbot-research/refs/cospan-565db03/src/commands/lifecycle.mjs
8. rokbot-research/refs/cospan-565db03/src/mcp/tools.mjs
9. rokbot-research/refs/cospan-565db03/src/cli-args.mjs
10. loom-ref-312bbb/crates/rovai-core/src/thread_runs.rs
11. loom-ref-312bbb/crates/rovai-core/src/run_continuation.rs
12. loom-ref-312bbb/crates/rovai-core/src/team_tool.rs

LIMITS
- 只读研究，未运行 lint/测试/构建，未做任何写入；所有结论基于阅读，不是行为验证。
- 另读过但未列入 12 个名额的文件：cospan `skills/codex/SKILL.md`、`skills/jobs/SKILL.md`、`src/mcp/tools.mjs` 之外的部分 `src/job-worker.mjs` 未读；LOOM 的 `camp_message_send_teaching.rs`、`camp_message_send` 教学与 `builtin_tool_evidence_projection.rs`、`memory_retrieval.rs`、`runtime_failure.rs`、`message_changes.rs`、`rovai-web/src/operations.rs`、`managed_process.rs` 仅按 grep 行定位，未逐段通读。
- LOOM 侧"手机/iOS"判断依据是 `apps/web`（含 `phone` 导航模式测试）与 `rovai-web` 通知操作；仓库中没有 iOS 原生工程目录，我未验证是否存在独立的移动端构建，因此"远程端轮询"的表述限于 Web/浏览器，不含 iOS 客户端实现细节。
- 第 2 条的 `waitReason` 恒为 null 是把 `thread_runs.rs:161/:274` 的 schema 与赋值读出来后推断的"当前实现如此"，未检查是否有其他写入路径（如 web 层再填充）。
- 我没有查看 cospan 的 `tests/` 与 `src/job-store.mjs` 全量，关于 job 状态机、保留策略（`MAX_RETAINED_JOBS`）的细节不完整。

STATUS: DONE_AWAITING_APPROVAL

## movo@6ab51e9

## 研究结果

**项目定位**：`movo@6ab51e9` 是一个自托管的“企业级 Agent 平台”单体仓库：两个 Vue 3 前端（user-web 用户工作台、admin-web 管理台）+ 多个 FastAPI 服务（chat-api 对话/Agent/Skill 网关、admin-api 组织与平台管理、document-parser 解析检索）+ Node 的 DSH Runtime Host + MongoDB/Redis/Weaviate，由 Docker Compose 拉起 12 个服务；Web 端负责知识、文件与内容生成，Browser Agent / Code Agent 则由**闭源**的 MOVO Desktop 通过同一套服务端 API 接管，桌面端源码不在本文档树内（README「Browser Agent and Code Agent」表格）。

---

### 最值得 LOOM 学的前 5 条

#### 1. 移动端输入框“不抢焦点”——避免在手机上自动弹起软键盘

- **参考证据**：`movo@6ab51e9 apps/user-web/src/composables/composerFocusPolicy.ts:6`（`mobileDevice: boolean` 是环境入参）、`:20`（`if (!enabled || input.disabled || input.readOnly || environment.mobileDevice) return false`）；`apps/user-web/tests/composer-focus-policy.test.ts:35`（断言移动设备下不聚焦 → 注释“does not open a mobile keyboard”）。
- **LOOM 对照**：`LOOM@312bbb8 apps/desktop/src/renderer/src/SingleChatPanel.tsx:1177` 是无条件 `window.requestAnimationFrame(() => composerRef.current?.focus())`；`apps/desktop/src/renderer/src/MobileLayout.tsx:14-18` 已有 `useMobileViewport` / `useMobileLayout`、`:39` 已写入 `root.dataset.mobileWeb`，但聚焦路径完全没有消费这个信号——**LOOM 有移动视口，缺“移动端抑制聚焦”的规则**。
- **借鉴价值**：把“该不该聚焦”抽成一个纯函数，以环境对象（可见性/阻塞浮层/文本选中/移动设备/是否显式切换会话）作入参，用断言测试锁死行为，而不是散落在组件里。是移动 Web / iOS Safari 上最容易被忽略却体验代价最高的一条。**改动：小｜风险：低**。

#### 2. 审批从“逐次询问”升级为“按工具 + 参数的确定性会话授权”

- **参考证据**：`movo@6ab51e9 services/chat-api/app/enterprise_capabilities/tools/approval_scope.py:19-34`（`scope_key = sha256` 规范化后的 `{tool_version, tool_name, approval_dimensions}`，`approval_dimensions` 只取工具声明的 `approval_argument` 对应的实参值）；`services/chat-api/app/enterprise_capabilities/tools/contracts.py:38`（`grantScope: Literal["once","session"]`）、`:59-77`（`EnterpriseApproval` 含 `scope_key/scope_label` 与 pending/approved/rejected/cancelled/expired 五态）、`:80-95`（`EnterpriseSessionApprovalGrant` active/revoked）；`services/chat-api/app/enterprise_capabilities/tools/service.py:112-131`（先查 `active_session_grant`，命中则写审计 `approval.session_grant.used` 并直接放行，否则 `ensure_approval`）。
- **LOOM 对照**：`LOOM@312bbb8 crates/rovai-core/src/read_model.rs:730-752`（`ApprovalView` 是单次请求视图，无 scope 概念）、`crates/rovai-core/src/action.rs:957-983`（审批一律 `INSERT ... status='pending'`）、`:1590-1594`（`resolution_code` 仅 `user_selected_allow/deny/user_cancelled`）、`:1006`（唯一的“放宽”是 `bot_full_permission` 全权限总开关）；`crates/rovai-core/src/acp.rs:8855-8858` 更直接写着 `allow_always` 的作用域“由 Runtime 决定”——**平台侧没有可审计、可撤销、可收窄的会话级授权**。
- **借鉴价值**：不需要改 Runtime 协议，只在平台侧加一张 `(tool_name, tool_version, 声明式参数维度, profile 版本) → scope_key` 的 grant 表 + 一条审计事件；LOOM 已有 domain event、`version` 乐观锁与 approval 五态，落点清晰。关键是“参数维度由工具声明而非自由文本”，避免把授权做成模糊的“一直允许”。**改动：中｜风险：中**（授权面放宽必须同时有撤销入口与审计）。

#### 3. 检索候选 ≠ 用户可见证据：加一道“证据准入”闸

- **参考证据**：`movo@6ab51e9 services/chat-api/app/enterprise_capabilities/evidence/knowledge_admission.py:17-22`（`minimum_score=0.05`、`minimum_top_score_ratio=0.15`、连续性阈值 `0.02 / 0.05`）、`:58-100`（绝对噪声底 + 相对最优值双阈值；同一文档已有强命中时可按连续性阈值放行邻近片段；返回 `admitted` 与 `rejected` 两侧，`strategy="scored_adaptive"`；全无分数时退化为 `unscored_compatibility` 原样返回）。
- **LOOM 对照**：`LOOM@312bbb8 crates/rovai-core/src/memory_retrieval.rs:36-61`（`MemorySearchInput/Result/Output` 只有 `limit` 和 `snippet`，**没有 score，也没有 rejected 集合**）、`:267-271`（只校验 `limit` 在 `1..=6`）；`:1042-1090` 只写 `memory_access_evidence`，不区分“检索到了”与“可以当作证据呈现”。
- **借鉴价值**：给 memory search 输出补 `score + admitted/rejected + threshold`，引用层与 UI 只吃 `admitted`；同时保留“无分数时保持旧行为”的退化分支，避免破坏 FTS 路径。这是一条把“检索质量”与“引用可信度”解耦的干净切法。**改动：小｜风险：低**。

#### 4. 用户可见交付面收敛：只发布“显式呈现”的文件，中间产物永不上用户面

- **参考证据**：`movo@6ab51e9 services/chat-api/app/dsh_runtime/presented_output_selection.py:11-46`（只认 `native_event_type == 'deliverables/presented'`；路径必须落在会话根内，拒绝 `..`，`resolve(strict=True)` 后再校验 `is_relative_to` 与 `is_file`）；`services/chat-api/app/dsh_runtime/personal_output_delivery.py:17-23` 与 `:38-40`（50 个文件、单文件 50MB、总量 256MB 预算，且只在该绑定 `execution_location == "server"` 时投递）；`services/chat-api/app/enterprise_capabilities/artifacts/delivery_scope.py:8-18`（`intermediate → lifecycle=intermediate, visibility=internal`，否则 `final/user`，并 `pop` 掉 `url` / `signed_url`）。
- **LOOM 对照**：`LOOM@312bbb8 crates/rovai-core/src/camp_attachment_view.rs:149-165`（`ThreadAttachmentVisibilityMode` 只有 `live_append_v1` / `generation_fenced_v1`，这是**快照一致性**语义，不是“面向用户的生命周期/可见性”）；LOOM 全仓 `apps/` 下搜索 `signed_url|signedUrl` 无命中，说明它尚无“可直链 vs 仅内部”的区分。
- **借鉴价值**：把“工作产物”和“交付件”打成两个标签，只有交付件进 Changes/交付视图，能直接压掉 LOOM 长任务里的产物噪音；再叠加“路径包含校验 + 大小预算”两条硬约束。**改动：中｜风险：中**（标签一旦写进既有数据，历史产物需要默认归类，别做回填迁移）。

#### 5. 桌面执行的回合写回服务端“只读投影”，并以 device 归属拒答

- **参考证据**：`movo@6ab51e9 services/chat-api/app/dsh_runtime/desktop_binding.py:33`（“Commits all execution identity fields together; never accepts a filesystem path”）、`:104-118`（`resolve` 校验 `execution_location == "desktop"`、`user_id`、`device_id`，不符即 `ValueError("Code Session belongs to another desktop device")`）、`:182-215`（事件按 `event_id` 幂等合并、cursor 前进、由投影中 `item_kind == "approval"` 的事件**推导** `pending_approval_count`、terminal 事件收尾）。
- **LOOM 对照**：`LOOM@312bbb8` 中 Desktop 与 Server 各自持有独立 Core（`docs/guides/server-access.md:40`：安装器“不迁移 Desktop 数据”），device 只作为执行节点（`crates/rovai-core/src/device_presence.rs:1-14`、`:49-57`），读模型由本地 SQLite 拼接（`crates/rovai-core/src/read_model.rs:803-812`），**没有“外部设备写回一条回合”的入口**。
- **借鉴价值**：可借的是不变量——线上只传不透明 `workspace_id` 与 `device_id`、归属不符即拒答、单活动回合 claim（同一会话不允许两回合并发）、事件按 id 幂等合并、待审批数由服务端投影推导而非客户端上报。但“是否让另一实例的回合出现在本实例历史里”属于架构/产品决策，**需主管裁定**，不宜由实现工单直接落地。**改动：大｜风险：高**。

---

**许可证/来源提示**：该快照 `LICENSE:1-2` 实际是 MIT 全文，而 `NOTICE:4-6` 与 README 声称 “MOVO Community License（Apache-2.0 + 附加条件）”，两者不一致，属上游快照自身矛盾。本次只取设计思路、不搬任何代码或文案；若日后要复用具体表达式，须先向上游确认许可范围。

**READ_FILES（12）**
1. `movo@6ab51e9 services/chat-api/app/enterprise_capabilities/tools/approval_scope.py`
2. `movo@6ab51e9 services/chat-api/app/enterprise_capabilities/tools/contracts.py`
3. `movo@6ab51e9 services/chat-api/app/enterprise_capabilities/tools/service.py`
4. `movo@6ab51e9 services/chat-api/app/enterprise_capabilities/evidence/knowledge_admission.py`
5. `movo@6ab51e9 services/chat-api/app/dsh_runtime/presented_output_selection.py`
6. `movo@6ab51e9 services/chat-api/app/enterprise_capabilities/artifacts/delivery_scope.py`
7. `movo@6ab51e9 services/chat-api/app/dsh_runtime/desktop_binding.py`
8. `movo@6ab51e9 apps/user-web/src/composables/composerFocusPolicy.ts`
9. `LOOM@312bbb8 crates/rovai-core/src/read_model.rs`
10. `LOOM@312bbb8 crates/rovai-core/src/action.rs`
11. `LOOM@312bbb8 crates/rovai-core/src/memory_retrieval.rs`
12. `LOOM@312bbb8 apps/desktop/src/renderer/src/SingleChatPanel.tsx`

**LIMITS**
- 未列入上表但也已打开核对（用于单行取证）：`apps/user-web/tests/composer-focus-policy.test.ts`、`apps/desktop/src/renderer/src/MobileLayout.tsx`、`crates/rovai-core/src/acp.rs`、`crates/rovai-core/src/mcp.rs`、`crates/rovai-core/src/camp_attachment_view.rs`、`crates/rovai-core/src/device_presence.rs`、`docs/guides/server-access.md`、`services/chat-api/app/dsh_runtime/personal_output_delivery.py`、`movo LICENSE`/`NOTICE`、两个 README。
- 只读、未联网、未运行任何构建或测试；LOOM 侧的“缺失”判断基于定向 `grep` + 逐处 `read` 核对，不等于全仓语义穷举（例如我未逐条审阅 admin-api 与 document-parser 的全部治理接口）。
- movo 的 Desktop 端源码不在该快照内，第 5 条只能从服务端契约反推，桌面端实际实现未验证。
- 第 2、5 条涉及授权面放宽与跨实例数据可见性，属架构决策，需主管确认后再排期。

STATUS: DONE_AWAITING_APPROVAL

## mindfs-current@6768bc1

只读研究结果（mindfs-current@6768bc1 对照 LOOM@312bbb8）

一句话：MindFS 是一个 Go 单体内核（server/ 提供 HTTP+WS API，web/ 是构建期嵌入的 React SPA），并通过一条由本机主动外拨到公共 relay 的加密隧道，把本机的多 Agent CLI 会话、文件树和任务看板投到浏览器/PWA 上，即“AI Agent 远程访问网关”。

最值得 LOOM 学的前 5 条（移动相关在前）

1. PWA 安装壳 + Service Worker 双通路缓存（手机优先）
- 参考证据：`mindfs-current@6768bc1 web/index.html:7`、`web/index.html:40`（两个占位注释，由构建插件回填）；`web/vite.config.ts:212-229` 注入 manifest、apple-touch-icon 与 apple-mobile-web-app-* meta；`web/vite.config.ts:158-208` 的 SW 把“导航请求”和“静态请求”分开处理，导航失败回退已缓存的 index、再退离线页，静态资源失败返回 504 而不是白屏；`web/src/registerServiceWorker.ts:44-51` 用入口脚本路径当 `?v=` 版本号注册；`web/src/services/runtime.ts:143-149` 原生壳（Capacitor）下跳过 SW 与安装提示。
- LOOM 对照：`LOOM@312bbb8 apps/web/index.html:1` 只有 favicon 与 viewport，无 manifest、无 apple meta；全仓检索 `serviceWorker`/`webmanifest` 零匹配；`apps/web/src/mobile.css:1-3` 已有成体系的手机布局，但仍是“手机浏览器里的网页”。
- 借鉴价值：从“手机上能用”变成“装到主屏像 App”，且是第 2 条推送的前置条件。改动大小：中。风险：低。

2. Web Push（VAPID）作为“人不在页面上”的叫醒器
- 参考证据：`server/internal/webpush/service.go:76` 首次启动生成并持久化 VAPID 密钥；`:362-383` 状态暴露订阅数与平台分布；`:484-...` 的 `shouldSend` 按 eventID 做 30 分钟去重（同一事件不重复打扰）；`:517-521` 载荷超 3800 字节只截断正文；`:559-563` 收到 410/404 直接删除失效订阅；`server/internal/api/appcontext.go:1055-1065` 一个 `notifyPayload` 扇出到 WebPush 与外部脚本；`server/internal/api/http.go:424-427` 状态/订阅增删/测试四条受保护路由。
- LOOM 对照：`LOOM@312bbb8 docs/contracts/notification-episode-v11.md:37` 的未读只有侧栏蓝点与 in-app Episode；全仓检索 `web-push`/`vapid`/`PushManager`/`Notification.requestPermission` 零匹配 —— 用户离开页面就收不到。
- 借鉴价值：iOS 要求先添加到主屏再授权推送，和第 1 条天然配套；也可直接复用 LOOM 已有的 Episode 语义当事件源。改动大小：中。风险：中（订阅端点属凭证面，需按 LOOM 的票据规则不入日志；iOS 权限/用户手势限制需真机验收）。

3. 单条外拨连接 + 多路复用反向代理的访问网关
- 参考证据：`server/internal/relay/service.go:354-360` WebSocket 升级后在其上建 yamux 多路复用会话（keepalive 30s）；`:390-425` 每条流先 `http.ReadRequest`，再按是否 WS 升级分流，并用头部 slug 把同一隧道指到任意本地服务（`:410-425`）；`:427-447`、`:465-...` 分别代理 HTTP 与 WebSocket；`:162-180` 重连退避在“稳定连接满 1 分钟”后才清零；`server/internal/relay/manager.go:222` 生成 `/n/<nodeID>/` 访问前缀。
- LOOM 对照：`LOOM@312bbb8 crates/loom-node/src/session.rs:25-29` 已有 15s 心跳与 1–30s 全抖动重连，`:125-140` 已有配对码换凭据，且 `crates/loom-protocol/src/lib.rs:64-104` 是强类型控制协议、带能力版本协商——链路健康度比 MindFS 更好；但隧道里只有 Run/ProcessPipe/Computer 等 JSON 帧，无法把设备上的本地服务（dev server、Jupyter、预览站）透给手机浏览器。
- 借鉴价值：不新开防火墙端口，就能在手机上打开设备侧任意 HTTP/WS；只需给“可暴露的本地服务”加 slug 白名单 + 启用开关。改动大小：大。风险：高（越权代理与 SSRF 面，必须复用 LOOM 现有 Grant/租约而不是自建第二套授权）。

4. 编排槽位规则：非隔离任务全局串行、隔离任务按组计数
- 参考证据：`server/internal/kanban/service.go:795-819` 的 `hasSlot`：MaxConcurrency≤0 视为 1；`CreateWorktree=false` 时一律限 1（共享目录只能跑一个）；有 worktree 时按“同 group 或同模板”计数；`:821-841` 只在准入那一刻才建 worktree，建失败走受管失败并回报父会话；`server/internal/kanban/plan.go:51-77` 批量建计划时先把本地 ref 换成真实 ID 再做 ValidateDAG，整批同一事务。
- LOOM 对照：`LOOM@312bbb8 docs/loom/LOOM-ARCHITECTURE.md:42`、`:127` 把 Goal→Step DAG 写成目标；`crates/rovai-core` 检索无 `depends_on`/DAG 实现；目录隔离基建已存在（`CONTEXT.md:20` 的 MissionWorkspace）。
- 借鉴价值：把“能不能并行”变成可解释、可测试的槽位规则，避免两个 Run 抢同一工作目录；也让“没有 worktree 就只能排队”成为产品化说法而不是失败。改动大小：中。风险：中（准入与 worktree 创建必须同事务，否则会留下半建状态）。

5. 文件↔会话双向索引（打开文件就知道谁改的）
- 参考证据：`server/internal/fs/fs.go:932-940` 的 FileMetaEntry 以 `SourceSession` 为条目主键；`:995-1017` 写入时按 session 追加/更新时间，不覆盖他人记录；`server/internal/session/manager.go:585-614` 会话侧维护 `RelatedFiles` 反向清单并同步到父会话；`:701-...` 还把 worktree 记成会话关系；`server/internal/api/usecase/fs.go:664-689` 列文件时把来源会话名与 Agent 补齐。
- LOOM 对照：`LOOM@312bbb8 docs/contracts/runtime-file-change-observation-v8.md:12-13` 只有 Run 级 evidence；`docs/contracts/mission-v9.md:55-60` 的 changes 也是“当前 workspace 的变更清单”——都缺“从一个文件反查是哪个会话/哪个 Run 写的”的持久索引。
- 借鉴价值：成果浮层可直接从文件跳到会话、从会话跳到它碰过的全部文件，不需要按时间猜链路。改动大小：小。风险：低。

许可证/来源提醒：两个项目均为 MIT（`mindfs-current@6768bc1 LICENSE:1`、`LOOM@312bbb8 LICENSE:1`），思路可借鉴并保留版权与出处；但 MindFS 隧道实现依赖 hashicorp/yamux（MPL-2.0，文件级 copyleft），不应照搬该 Go 实现，LOOM 用 Rust 侧 MIT 许可的多路复用库等价实现即可。以上不复制代码，只取设计与边界。

READ_FILES（12）
1. refs/mindfs-current-6768bc1/README.md
2. refs/mindfs-current-6768bc1/web/index.html
3. refs/mindfs-current-6768bc1/web/vite.config.ts
4. refs/mindfs-current-6768bc1/web/src/registerServiceWorker.ts
5. refs/mindfs-current-6768bc1/web/src/services/runtime.ts
6. refs/mindfs-current-6768bc1/server/internal/webpush/service.go
7. refs/mindfs-current-6768bc1/server/internal/api/appcontext.go
8. refs/mindfs-current-6768bc1/server/internal/relay/service.go
9. refs/mindfs-current-6768bc1/server/internal/relay/manager.go
10. refs/mindfs-current-6768bc1/server/internal/kanban/service.go、server/internal/kanban/plan.go
11. refs/mindfs-current-6768bc1/server/internal/fs/fs.go、server/internal/session/manager.go、server/internal/api/usecase/fs.go
12. loom-ref-312bbb/apps/web/index.html、apps/web/src/mobile.css、apps/desktop/src/renderer/src/MobileLayout.tsx、crates/loom-protocol/src/lib.rs、crates/loom-node/src/session.rs、docs/loom/LOOM-ARCHITECTURE.md、docs/contracts/notification-episode-v11.md、docs/contracts/mission-v9.md、docs/contracts/runtime-file-change-observation-v8.md、CONTEXT.md

LIMITS
- 纯只读检索，未运行构建或测试，未做 iOS/Android 真机验证；“PWA 可安装”“推送可达”均为代码阅读结论，不是端到端证据。
- 引用行号全部来自本次实际打开的读取结果；但 relay/e2ee 只读了 service.go 与 manager.go 的主干，加密隧道（e2ee 目录）与 network.go 未评估，故未列为借鉴项。
- LOOM 侧的“缺失”结论以文本检索 + 契约文档为准（如 `serviceWorker`/`webmanifest`/`web-push`/`vapid`/`PushManager`/`depends_on` 全仓零匹配）；若相关能力由打包脚本或部署层注入，检索看不出来，需另行核对构建配置。
- LOOM 的 Mission/Step 部分只核对了文档与 rovai-core 的检索结果，未逐行审阅 mission 全实现，因此第 4 条的“缺失”应理解为“未发现实现”，而非已穷尽证明。
- 受字数限制，MindFS 的移动端底部操作栏、`/`、`@`、`#` 三类快捷输入、命令执行卡、插件式文件视图等未展开。
- 改动大小与风险为基于本次阅读的判断，不是工作量承诺。

STATUS: DONE_AWAITING_APPROVAL

## rakazo@51ff52e

**研究结果（只读）**

Rakazo（rakazo@51ff52e，MIT）是自托管的"AI 队友"产品：TypeScript monorepo，同一套 RPC 契约（packages/contracts）驱动 web、Electron、Expo 移动端、api/worker；每个 bot 有独立记忆、例行任务和一台可长时间存活的计算机。

**1. 手机锁屏/灵动岛就是"队友在工作"的常驻显示（移动优先）**
- 参考证据：`apps/mobile/lib/notifications/work-activity.ts:37-119`（原生 WorkActivity 桥、卡片 token 回传、按会话代际判断、退出登录即 endWorkActivity）；`apps/mobile/ios-widgets/WorkLiveActivity.swift:9-55`（单 bot 全量、多 bot 成行，compact 区直接写 "Needs you"）；服务端 `packages/adapters/src/runs/lifecycle/work-activity.ts:24-58`（状态只有 count/waiting/rows，带单调递增的 `at` 秒与每用户 5 张卡上限）、`:313-380`（按用户节流、state HMAC 去重、会话失效或 count=0 发 ended 并删 token）。
- LOOM 对照：`LOOM@312bbb8 docs/architecture/notification-episodes.md:34` 只有 "foreground-only transient heads-up"；`docs/guides/server-access.md:9` 手机＝浏览器访问；`apps/web/public/` 无 service worker，桌面端也搜不到 `new Notification`。即 LOOM 没有应用外到达。
- 借鉴价值：把"在跑/等你"变成不用打开应用的状态投影；每次推送是幂等快照而非增量事件，端上丢失可重发。改动大小：大（新增设备通道）；先做 Web Push 只做"投影+节流+结束"可降到中。风险：中（token 须加密存储、多账号同机、自托管无 APNs）。

**2. bot 可以主动请人接管，并把"屏幕没变"变成显式信号**
- 参考证据：`packages/adapters/src/tools/builtin-computer.tool-definition.ts:352-360`（request_takeover：CAPTCHA/支付/passkey，要求人接管而不是把受保护值贴进聊天）；`packages/adapters/src/computers/screens/computer-tools.ts:10-20` 与 `:222-251`（连续 3 次相同视觉动作后不再执行，返回 screenshotOmitted/previousScreenshotValid 并提示改用 browser_snapshot）；`packages/adapters/src/browser/browser-tools.ts:547-567`（失败注记只给下一步选项，禁止重放已完成或不确定的动作）。
- LOOM 对照：`crates/rovai-web/src/computer_agent.rs:35-40` 工具面固定五个（截图/点击/输入/按键/滚动），`crates/rovai-web/src/computer.rs:70-82` 已有 5 分钟接管租约与 15s 死手；但 `rovai-web/src` 搜不到 request_takeover，也没有重复截图守卫。
- 借鉴价值：把"卡住"变成一次结构化交接，并省掉重复截图的 token。改动大小：小。风险：低。

**3. "某个东西变了"作为例行任务触发器，检查器不调用模型**
- 参考证据：`packages/contracts/src/routines/routine-watch.ts:1-30`（kind=files/command/tool/http，指纹比对，track 只比所列字段，最小 5 分钟）；`packages/adapters/src/routines/routine-watch.ts:58-71`（不调模型、60s 检查超时、计算机忙则 60s 重试而不计失败、2000 条上限）；`docs/routines.md:36-42`（`{{today+2d}}` 日期参数、Post "No changes"、watch 不能与 cron 并存）。
- LOOM 对照：`crates/rovai-core/src/automation.rs:104-122` 只有 Daily/Weekdays/Weekly/Once/Cron/Manual，没有变化触发。
- 借鉴价值：省掉"为看有没有变就跑一次模型"的钱与日志噪音；首轮建基线、临时失败重试与永久暂停分离，刚好补这个空位。改动大小：中。风险：中（command watch 等于无人值守跑 shell，必须沿用 LOOM 的批准与隔离边界）。

**4. 记忆迁移：把别的 agent 的 MEMORY.md/SOUL.md 读成 LOOM 记忆**
- 参考证据：`packages/core/src/agent-import/openclaw.ts:5-12`（SOUL.md/AGENTS.md 只当身份与工作说明，MEMORY.md/USER.md 才是记忆，TOOLS/HEARTBEAT 等"无对应物"明确不导）；`packages/core/src/agent-import/grok-bot.ts:641-669`（条目按原顺序去重，按文件大小切成 MEMORY.md、MEMORY-2.md…）；`packages/core/src/agent-import/credentials.test.ts:58-78`（疑似密钥只标记 containsKey，绝不写进标题）。
- LOOM 对照：`crates/rovai-core/src/memory.rs:87-110` 只有 Hearth/Companion/Relationship 三 Scope 与 preference/agreement/lesson 三 Kind，未见外部档案导入入口（grep 未命中，见 LIMITS）。
- 借鉴价值：兑现"换机换工具但队友不丢"；去重、切分、跳过 stock 文件、密钥只标记都是低成本高体验。改动大小：中。风险：低-中（解析不可信文件、密钥误入库）。

**5. 长期在线队友的每日主动 check-in，但把动作权限钉死**
- 参考证据：`packages/adapters/src/routines/strategic-initiative.ts:14-22`（24h 间隔、失败退避 7 天、12h 才算 stale、14 天自动搁置、最多 5 条进提示）、`:54-96`（搁置用带条件的 updateMany，被 follow-up 覆盖的不动）、`:102-130`（先做免费过滤再查计费资格）、`:135-175`（每小时单飞扫描，先搁置再 check-in）；`packages/adapters/src/routines/strategic-initiative.prompt.ts:1-30`（未完成清单当不可信数据包裹，没高信号就整段回 NO_RESPONSE，本次只能问一个问题或写一条提醒）。
- LOOM 对照：`docs/architecture/missions.md:11-13` Mission 是绑定项目/工作区的重对象，automation 只有定时/手动；没有"轻量开放工作清单＋自动搁置＋主动但受限的问候"。
- 借鉴价值：解决"队友在线但不会主动想起没做完的事"，NO_RESPONSE 防刷屏，权限限制防半夜自己改代码。改动大小：中-大。风险：中（打扰、计费、模型乱做事）。

许可证：Rakazo 本体 MIT（`LICENSE:1`）；但 agent-import 源自 OpenMausBot（Apache-2.0）与 hermes-official-plugins（MIT），见 `NOTICE:3-12`——第 4 条需自研实现并遵守 Apache-2.0 的 NOTICE 义务；其余只学设计，不搬代码。

READ_FILES（12）
1. apps/mobile/lib/notifications/work-activity.ts
2. apps/mobile/ios-widgets/WorkLiveActivity.swift
3. packages/adapters/src/runs/lifecycle/work-activity.ts
4. packages/adapters/src/tools/builtin-computer.tool-definition.ts
5. packages/adapters/src/computers/screens/computer-tools.ts
6. packages/contracts/src/routines/routine-watch.ts
7. packages/adapters/src/routines/strategic-initiative.ts
8. packages/adapters/src/routines/strategic-initiative.prompt.ts
9. packages/core/src/agent-import/grok-bot.ts
10. docs/architecture/notification-episodes.md（LOOM）
11. crates/rovai-core/src/automation.rs（LOOM）
12. crates/rovai-web/src/computer_agent.rs（LOOM）

LIMITS
- 纯静态阅读，未构建/未跑测试，未验证 Expo 原生模块与 APNs/FCM 实际行为。
- 正文另已读但因 12 条上限未列：openclaw.ts、credentials.test.ts、adapters/routine-watch.ts、docs/routines.md、docs/memory.md、missions.md、memory.rs、computer.rs、push.ts、live-notifications.ts、mobile-app.md、server-access.md。
- LOOM"缺失"结论来自 grep（request_takeover、agent-import、service worker、new Notification 均无命中）与已读文档，不代表未跟踪分支也没有。
- 未覆盖 Rakazo 的 run 执行/steering、组聊、语音通话、pages、vault；也未细看 LOOM mobile-web UI。
- 改动大小/风险为基于代码形状的判断，非实测。

STATUS: DONE_AWAITING_APPROVAL

## pibot@6741737

【项目一句话】
pibot@6741737 是一个自托管的「中心服务器集中管理 + 设备本地执行」AI 助手平台：Center 集中管理模型凭据、设备与 Bot、插件，并提供 Relay；Windows、Linux、macOS、Android 各运行一个 Host，Bot 使用的工具、工作目录与会话主存储都留在这台设备上（`README.md:5-28`），桌面与移动端共用同一份 Bot 看板。LOOM 当前是「一个 Rust Core + 唯一 SQLite + loom-node 向外建立连接」的桌面/Web 形态，手机端尚未开始（`LOOM-ARCHITECTURE.md:37`）。

1）一次扫码就完成手机端配对（移动优先）
- 参考证据：`pibot@6741737 center-server/pairing.js:59-71`（私有 CA 直接嵌进每个配对码；明文密钥只返回一次，数据库只存哈希）、`center-server/pairing.js:113-137`（兑换接口以一次性密钥为凭据，不需要所有者会话或 CSRF；某次注册已发生后的重放，仅在凭据仍是该码创建的那一份时放行，码与设备不符则报 PAIRING_CODE_DEVICE_MISMATCH）；`app/src/main/java/com/example/launcherprobe/PairingCode.java:20-25,47-71`（原生侧是唯一解码点，web 只见不透明原文，地址只认 HTTPS origin）；`README.md:106`（关闭「添加设备」窗口后码立刻作废，且与超时过期分开报错；设备仍在使用时必须用「重新配对」的专属码）。
- LOOM 对照：`LOOM@312bbb8 scripts/node/README.md:24-34` 目前是 CLI 打印配对码、人工粘贴，地址另用 `-Server` 传入（`crates/rovai-host/src/node_cli.rs:228` 把 pairing_code 与 connect_url 分开返回），桌面只给码+命令（`apps/desktop/.impeccable/surfaces/settings-workspace.md:380`）；没有扫码，CA 不进码，没有专属重配码。
- 借鉴价值：手机端要免输地址、密码与证书，全靠这一份码；也避免把码写进命令行历史。改动大小：中。风险：中（短期凭据，必须有 TTL、重放语义与限流）。

2）手机双进程 + 两条前台服务 + 只读引导检查
- 参考证据：`mobile/README.md:42`（Tauri 的 Android 退出链路会走 std::process::exit，所以 UI 放 `:tauri_ui`，Host/前台服务与 Node 子进程留在默认进程）、`app/src/main/AndroidManifest.xml:54,66-80,122`（两条 specialUse 前台服务；UI 与扫码 Activity 同进程）、`mobile/README.md:76-81`（onboardingStatus 只读查询通知/电池不受限/Shizuku，onboardingAction 仅前台显式点击，`requested:true` ≠ 已授权）、`mobile/README.md:27`（完成/失败通知按 Bot 合并并持久去重，正在查看的聊天不弹，点击按设备+Bot 定位）。
- LOOM 对照：`LOOM-ARCHITECTURE.md:37` 仍写“未来 Mobile”，`apps/` 只有 desktop 与 web；无前台服务、无准入回执、无通知幂等。
- 借鉴价值：“UI 死、任务不死”和“通知不重复、点了能落到那个 Bot”是手机当节点的可用性门槛。改动大小：大。风险：中（FGS 类型、厂商后台冻结需真机验证）。

3）常驻=服务化，且“确认卸载才算停止”
- 参考证据：`desktop/README.md:23,27,31,33`（Linux systemd 用户单元+linger；Windows 受保护登录任务；macOS LaunchAgent 异常退出按 10 秒节流重启，只有 launchctl 确认任务已不在才算停止，否则返回 STOP_FAILED；App 换位置要重写登录项）、`desktop/README.md:25`（覆盖升级前保存启用/运行状态、装后恢复、失败留快照）、`README.md:58`（关窗不中断已受理任务）。
- LOOM 对照：Core 是 Electron 子进程（`apps/desktop/src/main/core-client.ts:457`，退出走 `core.shutdown`，`:21`），macOS 登录项已退役并关闭（`apps/desktop/src/main/index.ts:774-785`），节点脚本明确“前台运行、不自动重试、不注册服务”（`scripts/node/README.md:66`）。
- 借鉴价值：LOOM 要“永远在”，缺的正是把进程变成服务、并可回滚的状态机。改动大小：中。风险：中（卸载/升级/权限三平台差异）。

4）Bot 看板：按 Bot 的桶 + “已看过”水位
- 参考证据：`web/src/useBotBoard.ts:31-37`（纯函数优先级：stopping/interrupting→工作中；attention 或 failed→需要你；busy 或排队→工作中；idle 且有未看过结果→待查看；否则空闲）、`web/src/BotBoard.tsx:16-21`（需要你/工作中/待查看/空闲/离线）、`host-core/runtime-bot-board.js:259`（afterRun 已提交答案还不算空闲，队列/控制/失败优先）、`runtime-bot-board.js:50,68,158`（reset 使旧结果失效、崩溃后不复活结果、待确认计划不外泄未确认步骤）。
- LOOM 对照：有持久通知流水（`crates/rovai-core/src/notification_sources.rs:41-63`），但看板是任务维度六桶（`apps/desktop/src/renderer/src/LoomWorkspace.tsx:533-552`），没有按 Bot 的 activity/attention/lastResult 投影，也没有 seen 水位。
- 借鉴价值：一眼看出“谁等你”，且不会把已提交未落定的回答当完成。改动大小：小。风险：低。

5）Shower：一套协议三个后端 + 按会话虚拟屏
- 参考证据：`docs/shower-cross-platform.md:14-20`（同一套 ShowerTarget/Session/Frame/Input 协议，Android/Windows/Linux 三后端实现同一组方法）、`docs/shower-cross-platform.md:27-35`（Manager 管 Actor 绑定、首个 ensure 前分配随机 session id、按会话串行、取消可越过队列、300 秒空闲释放且状态/预览帧不续期、失败释放保留归属）、`:62`（Android 每个聊天一个会话）、`:82`（同一用户环境，明说不是沙箱也不是隔离边界）。
- LOOM 对照：电脑能力是真实桌面上的五工具闭集（`crates/rovai-web/src/computer_agent.rs:118-123`）加 grant/lease 授权（`computer_agent.rs:139-146`），与用户桌面共享，没有按会话的虚拟显示，也没有接管租约与空闲释放。
- 借鉴价值：Bot 干活不抢鼠标，人可随时接管；协议先定死才换得动后端。改动大小：大。风险：高（Android 需 Shizuku、Windows 每机只能一个子会话、Linux 需私有 Xvnc）。

许可证提示：pibot 根 LICENSE 是 MIT，但 Shower 的 Android 后端派生自 Operit Shower（LGPL-3.0，含 GPLv3 条款，`THIRD_PARTY_NOTICES.md:31-38`），不能当 MIT 代码整段照抄；参考锁里“全部参考快照许可已统一为 MIT”（`LOOM-V2-REFERENCE-LOCK.md:43`）对这条子树不成立。

READ_FILES
1. refs/pibot-6741737/README.md
2. refs/pibot-6741737/mobile/README.md
3. refs/pibot-6741737/desktop/README.md
4. refs/pibot-6741737/center-server/pairing.js
5. refs/pibot-6741737/app/src/main/java/com/example/launcherprobe/PairingCode.java
6. refs/pibot-6741737/app/src/main/AndroidManifest.xml
7. refs/pibot-6741737/host-core/runtime-bot-board.js
8. refs/pibot-6741737/web/src/useBotBoard.ts
9. refs/pibot-6741737/web/src/BotBoard.tsx
10. refs/pibot-6741737/docs/shower-cross-platform.md
11. loom-ref-312bbb/docs/loom/LOOM-ARCHITECTURE.md
12. loom-ref-312bbb/apps/desktop/src/renderer/src/LoomWorkspace.tsx

LIMITS
- 全程只读，未运行构建/测试，未在真机或模拟器复现任何行为；结论只来自源码与仓内文档。
- pibot 侧多条证据是作者文档（README/mobile/README/desktop/README），其中不少验收自述“父助手限定范围、未真机全量”，不能当已完成保证。
- 因 12 文件上限，以下已核对但未列入 READ_FILES：`pibot THIRD_PARTY_NOTICES.md`、`host-core/bot-board-protocol.js`、LOOM 的 `scripts/node/README.md`、`crates/rovai-host/src/node_cli.rs`、`apps/desktop/src/main/core-client.ts`、`apps/desktop/src/main/index.ts`、`crates/rovai-core/src/notification_sources.rs`、`crates/rovai-web/src/computer_agent.rs`、`apps/desktop/.impeccable/surfaces/settings-workspace.md`；上面引用的行号均来自这些文件的实读。
- 未展开但下一轮值得看：`host-core/turn-sync.js` 的每轮能力准入（prepare/confirm/restore、queued 回执 ≠ 已执行）、relay/Room 跨设备群聊、`bot-board-protocol.js` 的参数边界。
- 版本口径：pibot 用 6741737（LOOM 参考锁 pinned 为 8b9f3d7…，见 `LOOM-V2-REFERENCE-LOCK.md:6,22`），行号只对该 checkout 有效。
- LOOM 侧“缺失”均按“在这些文件里未见”表述；仓大，不排除别处已有等价实现，未做全仓穷举。

STATUS: DONE_AWAITING_APPROVAL

## rovai-ai@0461437fd

**项目一句话**：rovai-ai@0461437fd 是“Rovai AI”工作台（Electron Renderer + 统一 Rust Host + rovai-core 单 SQLite 事实源），把本机已装 Codex/Claude/Pi 编成长驻队友，以 Thread 为单位管理共享对话、可见执行、审批、使命与协作记忆。

**1. 手机端只做“展示上下文”，不复制业务状态（手机项优先）**
- 参考证据：`docs/ui/host-web-mobile.md:15`（768px 起启用手机布局）、`docs/ui/host-web-mobile.md:17`（MobileLayout 仅提供展示上下文，Host 能力仍由显式依赖区分）、`docs/ui/host-web-mobile.md:31`（触摸入口 ≥44px、输入 ≥16px）、`docs/ui/host-web-mobile.md:97`（手机审批沿用共享 Dock，翻页/展开/按钮 ≥44px）、`docs/ui/host-web-mobile.md:105`（执行弹层复用 ExecutionAvatarRail/ExecutionToolGroup 同一批组件）、`docs/ui/host-web-mobile.md:110`（Web 用 `agentRunExecution.changes` 增量读 command）、`docs/ui/host-web-mobile.md:182-183`（浏览器模拟不能替代实体 iOS Safari，缺真机证据不得宣称完成）。
- LOOM 对照：`LOOM@312bbb8 apps/web/src/main.tsx:235` 直接把 LoomApp 挂进认证壳；`loom-native` 目录内 grep 无 `useMobileLayout`/`ApprovalDock` 引用，`apps/desktop/src/renderer/src/loom-native/native.css:142-143` 只有 800/520px 的窗口窄化断点，整目录无 `safe-area`，即手机端跑的是桌面三栏。
- 借鉴价值：手机是同一投影的另一层壳，先补“判定+安全区+触摸尺寸”比重画 UI 划算。改动**中**；风险**低**（纯前端门控，但真机证据不能自证）。

**2. 电脑操作审批也要进“对话级单一队列”**
- 参考证据：`docs/ui/host-web-mobile.md:92`（审批仍在对话页，定位审批先收起执行/私聊面板）、`docs/ui/host-web-mobile.md:101-102`（580px 内原因/原始 JSON 可滚，不为布局改焦点准入与按钮顺序）、`ThreadWorkspace` 的会话级 `ApprovalDock`（`apps/desktop/src/renderer/src/ThreadWorkspace.tsx:9620` export 行）。
- LOOM 对照：会话里只有动作审批的等待时长提示（`loom-native/ConversationView.tsx:104`）；电脑操作审批卡只在 `loom-native/ComputerAgentAccess.tsx:15-16` 定义、由 `loom-native/ComputerPanel.tsx:226` 挂在电脑面板内——手机上必须先开检查器浮层。
- 借鉴价值：把“谁在等我批”收敛成一条队列并提供定位动作，手机上才批得动。改动**中**；风险**中**（approvals 提作用域时别把 grant/模式控制一起搬）。

**3. 原生问答/审批的期限、去重、迟到拒绝合同**
- 参考证据：`docs/contracts/native-interactions-v1.md:23-24`（每项含 createdAt/expiresAt/status/canSkip，Pi 每项只有一题）、`docs/contracts/native-interactions-v1.md:62`（同一请求只写入一次，重复提交回 alreadyHandled，不发第二个答案）、`docs/contracts/native-interactions-v1.md:75-76`（editor 无 timeout；不生成默认期限、不替 Runtime 发超时答案，过期移出待处理但保留 expired 拒绝迟到）。
- LOOM 对照：`LOOM@312bbb8 apps/desktop/src/renderer/src/loom-native/pi-questions.ts:8-20` 类型无 expiresAt/canSkip、选项仅 `string[]`，靠轮询；`loom-native/approval-aging.ts:1-2` 自认“审批合同没有 expiresAt，只做展示”。
- 借鉴价值：把“真到期”和“本地等久了”分开，禁止渲染层编造过期事实。改动**小**；风险**低**。

**4. 成果/文件变化只信 Runtime 报告，不扫盘、不依赖 Git**
- 参考证据：`docs/architecture/runtime-file-change-observation.md:12`（只消费 Runtime 明确报告的变化）、`:30-32`（Command Diff 与 AgentRun File Changes 同源 Evidence 两个投影）、`:34-35`（无 baseline/Git tree/checkpoint，Git 与非 Git root 同能力）、`:41-43`（失败、取消、字段不全退回普通 Tool Evidence，不伪造 Diff）。
- LOOM 对照：`LOOM@312bbb8 docs/loom/LOOM-ARCHITECTURE.md:28`、`:184` 把“运行前后 git 差异作为改动证据”写进 cospan 派活；`loom-native/artifact-diff.ts:1-8` 只做 Markdown 成果的字级版本对比，没有逐 Run 归约。
- 借鉴价值：非 git 目录/云主机上的设备侧改动目前无证据链。改动**大**；风险**中**（要各 Adapter 结构化回执，回执不全只能降级）。

**5. 协作记忆要有实例级开关 + 隔离审查 + Forget 闭环**
- 参考证据：`crates/rovai-core/src/memory_capability.rs:22-25`（设置缺行/非法属基础设施故障，绝不当作“用户已关闭”）、`:45`（`require_enabled` 统一拦截）；`docs/architecture/online-memory-capture.md:25-30`（关闭只暂停新业务，数据与审核项保留；缺行/非法/读失败保持拒绝）、`:82-85`（Hearth Review 与 User Memory Governance 才拥有 accept/Forget/Supersession，模型不能直写正式库）。
- LOOM 对照：`LOOM@312bbb8 docs/loom/LOOM-ARCHITECTURE.md:110` 记忆层仅“按 Workspace 隔离 + 账号级画像”，`crates/rovai-core/src` 有 memory.rs/memory_retrieval.rs 但无 memory_capability.rs（find 阴性结果，非行号）。
- 借鉴价值：一个总开关决定“新写入/新检索是否准入”，失败即拒绝，好审计。改动**小-中**；风险**中**（开关语义写不清会被误判为“用户关闭”）。

许可证：两仓 `LICENSE:1` 均为 MIT License，LOOM 参考锁第 43 行记 ROVAI 快照已统一 MIT；仍建议只学结构/判定顺序、逐行重写并保留版权与 NOTICE。

READ_FILES：rovai `docs/ui/host-web-mobile.md`、`docs/contracts/native-interactions-v1.md`、`docs/architecture/runtime-file-change-observation.md`、`docs/architecture/online-memory-capture.md`、`docs/architecture/camp-published-attachment-view.md`、`crates/rovai-core/src/memory_capability.rs`、`apps/web/src/main.tsx`、`apps/desktop/src/renderer/src/ThreadWorkspace.tsx`(grep)；LOOM `docs/loom/LOOM-ARCHITECTURE.md`、`apps/web/src/main.tsx`、`loom-native/{pi-questions.ts,approval-aging.ts,ComputerAgentAccess.tsx,ComputerPanel.tsx,artifact-diff.ts}`、`docs/ui/host-web-mobile.md`(目录核对)。

LIMITS：无 shell，未跑 diff/构建/测试，未修改任何文件；部分行号来自 grep 命中（ApprovalDock export、ComputerPanel 挂载、BusinessApp 的 MobileLayoutProvider），非全文精读；LOOM“缺失”多为 grep/find 阴性证据；未核对 rovai 0461437fd 与 LOOM 参考锁 f5f4cb26 的版本差异；`docs/architecture/notification-episodes.md` 仅 grep 片段，未纳入正文条目。

STATUS: DONE_AWAITING_APPROVAL

## agenteam@79debf3

agenteam@79debf3 是企业 AI 员工协作平台。按用户红线，企业微信/飞书接入与个人 IM 推送一律不学；因此本项目只保留 2 条非推送、可迁移到 LOOM 的设计。

1. 能力中心：一次发布原子提交“固定依赖 + 版本指针 + 授权 + 上架”
- 参考证据：`agenteam-server/src/main/java/com/stonewu/agenteam/service/resource/ResourcePublishService.java:26,61-83`（注释即契约：固定版本、依赖、发布指针、授权、上架一起提交，任一失败全回滚；顺序为配置发布→依赖解析→版本发布→资源指针→授权替换→上架→审计）；`.../resource/FixedDependencyService.java:26,48-58`（发布时冻结直接与间接依赖，执行时仍检查当前成员、授权、版本与停用）；`agenteam-web/src/features/workspace/lib/navigation.ts:64-70`（智能体/技能/插件/工作流/知识库/数据源共享同一目录与发布语义）。
- LOOM 对照：`CONTEXT.md:410-412` 已有不可变 SkillRevision，`CONTEXT.md:471-472` Assignment 会随新 Revision 前进；但缺少“多资源种类共享一次发布事务”、依赖图冻结与 view/use 级授权、企业内上架的组合。
- 借鉴价值：把“谁能用哪一版、该版依赖哪一版”变成一次可审计提交，避免逐个对象手工对齐。改动大小：大。风险：中（发布顺序与回滚、依赖循环）。

2. 定时任务：操作类型注册表 + 参数版本 + 触发时固定快照
- 参考证据：`agenteam-server/src/main/java/com/stonewu/agenteam/service/schedule/ScheduleActionHandler.java:22-52`（type/schemaVersions/usesAgent/snapshot/submit/reconcile 分离，约定提交只写库或排持久工作、禁止事务内联网）；`.../schedule/ScheduleActionRegistry.java:16-35,24`（类型与实现一一对应，重复 type 启动即失败，未知 type 或版本明确拒绝，缺省回落 agent.run:1）；`agenteam-server/docs/integration-scheduling.md:60`（新发生记录必须 `captured` 实际触发参数，旧记录 `legacy_unavailable`，禁止用当前计划填造历史）。
- LOOM 对照：`CONTEXT.md:86-87` Automation 只绑定一个 Prompt + Member + 工作区 + schedule，`docs/contracts/scheduled-automation-v5.md:30-34` occurrence 准入即生成标题与新 Camp；没有“动作类型/参数版本”层，因此做不出“只发通知、不烧模型额度”的定时项。
- 借鉴价值：定时任务从“跑一次智能体”扩成可插拔动作（通知、报表），同时保证历史不被新计划改写。改动大小：中大。风险：中（新增操作类型的权限与确认流程）。

以上只借设计约束与分层思路，不搬其 Java/TS 实现与文案；来源为 MIT（`LICENSE:1`），`NOTICE:1-4` 要求保留版权声明，若借鉴需在 THIRD_PARTY_NOTICES 注明来源。

LIMITS：全程只读，未运行构建/测试/真实网络；未验证真实飞书审批、企微扫码与真机移动浏览器；LOOM 对照基于 docs/contracts、CONTEXT.md 与 packages/contracts，未逐行读 Rust 实现（crates/rovai-core 内部），故 LOOM 侧“缺失”是文档级判断；未读 agenteam 的 ResourcePolicy/ResourceGrantService 细则，能力中心权限粒度结论较粗；本报告未评估 LOOM 现有 notification-episode 与 ChannelDelivery 的实测行为。


## accp@77f0577

只读研究完成（未写文件、未联网、未运行构建/测试）。以下为研究结果。

---

**一句话定位**：ACCP（Agent Collaboration Control Plane, accp@77f0577）是 Go 标准库 HTTP 单控制平面 + React 控制台的团队级 AI 协作平台——人类在浏览器里定义任务/发布项目资料/验收成果/审批工具操作，Agent 经 MCP Bridge 领取任务、读冻结的资料快照、提交证据，每项任务由人类负责人最终验收。

**最值得 LOOM 学的前 5 条（手机/移动相关优先）**

**1. 把“手机布局”变成可复现的浏览器断言，而不只是样式**
- 参考证据：`accp@77f0577 web/src/app/App.tsx:181` 同一棵 DOM 树里侧栏只是 `sticky top-0`，到 `lg:` 才变 `lg:fixed` 固定侧栏；`web/src/app/App.tsx:232-239` 移动端导航就是一条 `overflow-x-auto snap-x` 横滑条，`lg:flex-col` 回竖排，当前页靠 `aria-current` 标记。验收在 `web/tests/ui.spec.ts:1549-1576`：真实浏览器 390×844，断言 `documentElement.scrollWidth <= innerWidth`、逐页标题可见、导航按钮 `aria-current="page"`。`web/tests/console.spec.ts:116-137` 还断言手机视口登录后 localStorage/sessionStorage 不得出现凭据前缀。
- LOOM 对照：`LOOM@312bbb8 apps/web/src/mobile.css:1-3,20-24`（`data-mobile-web` 作用域、container query、`env(safe-area-inset-*)`）与 `apps/desktop/src/renderer/src/MobileLayout.tsx:8,37-51`（短横屏 + coarse pointer 查询、`visualViewport` 高度/偏移写 CSS 变量）在“做得细”上已超过 ACCP；但手机版验证多为 CSS 文本断言：`apps/desktop/src/renderer/src/execution-console-layout.test.ts:4-9,139-145` 用正则匹配 styleBlock 文本，不检查几何。
- 借鉴价值：LOOM 缺的不是样式而是“手机也是验收面”的检查方式——把“无横向溢出、44px 触控、`aria-current`、凭据不落盘”做成可跑断言。改动大小：小；风险：低。

**2. 验收前先清空“未决工具结果”，并让拒绝码说明原因**
- 参考证据：`accp@77f0577 internal/controlplane/delivery.go:196`（STALE_REVIEW：存在更新的执行则拒绝验收）、`:200-207`（ACCEPT 分支先用 EXISTS 查 `tool_invocations` 是否仍有 AWAITING_APPROVAL/READY/RUNNING/UNKNOWN，有则 409 `TOOL_OUTCOME_UNRESOLVED`）、`:211-215`（逐条 acceptance checks 数量必须相等且全为 true，否则 422 `ACCEPTANCE_INCOMPLETE`）、`:221-240`（每份证据必须 VERIFIED 且 ACCEPTED，版本/摘要不符给 412 `EVIDENCE_CHANGED`）。
- LOOM 对照：`crates/rovai-core/src/loom.rs:4280-4360` 的验收已很强（criteria 快照、按 id 全量覆盖、空集拒绝、只判最新 candidate、review 不可重复）；但该路径内没有对 approval/action_execution 的查询（`loom.rs` 内检索无 `approval`/`action_execution` 引用），而“未知结果”状态本身已存在：`crates/rovai-core/src/action.rs:1255`。
- 借鉴价值：把“还有未结算的工具调用，就不许把任务置 DONE”写成验收不变量，ACCP 只用一行 EXISTS。改动大小：小；风险：中（会拉长验收路径，UI 需解释为何不可接受）。

**3. 独立审批：职责分离 + 判定不可变 + 审计带执行维度**
- 参考证据：`accp@77f0577 internal/controlplane/governance.go:168-182`（审批绑定是 policy_version、resource_version、参数摘要、artifact_ids、30 分钟 `expires_at` 的规范化摘要 `binding_digest`，invocation 与 approval 共用同一摘要）；`:245-261`（同一自然人不得既申请又裁决 403 `SEPARATION_REQUIRED`；已裁决不可改 409 `APPROVAL_FINAL`；裁决必须回传 `binding_digest`，否则 412 `BINDING_CHANGED`）；`internal/controlplane/audit_execution.go:18`（审计列固定含 `actor_kind`、`task_run_id`、`owner_user_id`、`context_snapshot_id`、`task_id`）。
- LOOM 对照：`crates/rovai-core/src/action.rs:1353-1534` 的裁决在“冻结原生选项 id、run epoch 围栏、过期 fail-closed、重放幂等”上比 ACCP 更细；`crates/rovai-core/src/loom/control.rs:40-41,66-69` 已规定“只有真 Owner 能授权”“reviewer 不是独立观察者就拒绝”。缺的是 ACCP 那种“同一自然人不得既发起又裁决”的硬规则，以及审批/审计行挂 `context_snapshot_id` 的维度。
- 借鉴价值：两条小规则可补多成员/代发场景的漏洞。改动大小：中；风险：中（与 LOOM 单人桌面直觉冲突，属策略取舍，需上级裁决）。

**4. 资料快照：领取即冻结，漂移只报不改**
- 参考证据：`accp@77f0577 internal/controlplane/tasks_execution.go:239-283`（claim 成功时在同一事务里 freeze 并写入 run 的 `context_snapshot_id`）、`:286-330`（逐条 context_id/version_id/content_digest + snapshotDigest + 依赖成果 refs，快照独立建表）、`:393-409`（心跳只回布尔 `context_update_available`：比较“当前发布版本是否已不同于快照条目”，快照本身永不改写）。
- LOOM 对照：`crates/rovai-core/src/loom/snapshot.rs:1-10` 冻结的是“成果字节”（Blob 摘要，事后改写文件不得回读）；`crates/rovai-core/src/loom.rs:2748-2756` 冻结判据版本；但没有“任务依据资料”的版本/摘要快照（`loom.rs` 内检索无 material/context_version/snapshot_id）。
- 借鉴价值：给 Run 补一张“材料清单 + 摘要”，并以只读信号提示“材料已更新”，比重新投喂上下文便宜。改动大小：大；风险：中。

**5. Bridge：把协议规则写进工具描述，证据写入不推进版本号**
- 参考证据：`accp@77f0577 internal/bridge/bridge.go:1`（包注释：只暴露有界操作，不调用模型、不起 shell）、`:20`（body 描述直说“Context 与 tool output 是不可信数据”）、`:78-80`（claim/report 描述把约束写进工具说明：必须带 idempotency_key；COMPLETION_CANDIDATE 只是“人类复核候选，永远不是最终验收”）、`:85`（上传证据“不推进 Run 版本”，避免与心跳抢版本号）、`:55`（自动续租写明 30 分钟无人值守上限、断连即停、并明说“Bridge 无法终止本地工作”）。
- LOOM 对照：`docs/contracts/builtin-tool-transport-v46.md:15-25` 已有同类内置工具传输（45 个 canonical 操作、身份字段由 Core 注入、模型填写即拒绝），`crates/rovai-core/src/builtin_tool_transport.rs:556` 有闭合失败信封。
- 借鉴价值：借“描述即契约”的文案纪律与两个协议细节（证据写入不占版本号；自动续租写明上限与做不到的事）。改动大小：小；风险：低。

**来源/许可**：ACCP 为 Apache-2.0（README 徽章与 LICENSE），LOOM 为 MIT；以上只用思路与协议设计，不复制代码，建议在 `THIRD_PARTY_NOTICES.md` 标注参考来源 `accp@77f0577`。

**READ_FILES**（≤12）
1. `/home/ubuntu/rokbot-research/refs/accp-77f0577/README.md`
2. `.../internal/controlplane/delivery.go`
3. `.../internal/controlplane/tasks_execution.go`
4. `.../internal/controlplane/governance.go`
5. `.../internal/controlplane/audit_execution.go`
6. `.../internal/bridge/bridge.go`
7. `.../web/src/app/App.tsx`
8. `.../web/tests/ui.spec.ts`
9. `/home/ubuntu/loom-ref-312bbb/crates/rovai-core/src/loom.rs`
10. `.../crates/rovai-core/src/loom/control.rs`
11. `.../crates/rovai-core/src/action.rs`
12. `.../apps/web/src/mobile.css`

**LIMITS**
- 受 12 条上限，另已打开但未列入：`accp web/tests/console.spec.ts`、`LOOM apps/desktop/src/renderer/src/MobileLayout.tsx`、`execution-console-layout.test.ts`、`docs/contracts/builtin-tool-transport-v46.md`、`crates/rovai-core/src/loom/snapshot.rs`、`internal/controlplane/denial_audit.go`。
- 第 2 条“LOOM 验收路径不查未决工具”只基于 `loom.rs` 内检索与 4280-4360 阅读，未排查 TS 评估器或 UI 侧是否已前置拦截。
- 第 1 条未量化 LOOM 现有 CDP 脚本（如 `scripts/capture-camp-inspectors.mjs`）是否已覆盖手机视口，只确认其检查 `scrollWidth > innerWidth`；未运行任何测试，无法给出通过率。
- 行号为当前快照的人工阅读结果，未用 git blame 校验是否为引入行。

STATUS: DONE_AWAITING_APPROVAL

## pi-desktop@0ca811242

PI-Desktop（pi-desktop@0ca811242）是 Electron 外壳、Rust host-core 与 Node pi sidecar 三层组成的本地优先桌面智能体工作台：会话、工具、权限与密钥由 Rust 管理，Agent 循环在 Node 中运行，插件与工作面板在外层扩展；LOOM（312bbb8）则是同一 Host 同时服务 Desktop 与浏览器、由 Core 统一裁决协作事实与 Runtime 调度的多智能体工作台。

最值得 LOOM 学的前 5 条

1. 移动/远程控制先定义"角色 + 权限上限"，再谈多端并连
参考证据：`pi-desktop@0ca811242 docs/spec/02-architecture/05-remote-agent-control.md:314-336`——一个主体按会话获得 viewer/controller/approver/owner 角色，角色可叠加但不得越过 Host 策略，controller 不能批准自己的请求；同一会话只跑一个 turn，但允许多个 viewer，队列是 Host 状态、所有客户端共享，并发变更按 revision 冲突拒绝，经网关发起的 turn 受"远端权限上限"约束。`同文件:486-489`：本地审批无自动时限，但只要挂着远端订阅者，远端审批默认 30 分钟且可调。`同文件:494-505`：断连不停 turn，重连按游标重放或整份快照，Host 重启换 epoch，重复变更返回原幂等结果，审批过期则不执行。
LOOM 对照：`LOOM@312bbb8 docs/contracts/host-web-v2.md:99-114` 登录只区分 Owner 与每标签页一个编辑器身份，最多 32 个 Session、满则回收最久空闲者；`apps/web/src/client.ts:973-996` Core 是唯一命令/重放权威，只有用户显式重试才重放未知回执；`packages/contracts/src/index.ts:2480-2504` 审批已有 pending/approved/denied/cancelled/expired 与 requestedForUserId。即：单写者并发控制、幂等回执、审批过期状态已有；按会话授予的角色、以及"远端发起的操作不得高于某权限上限"缺失。
借鉴价值：手机加入后，"一台就是编辑器、另一台只能看"会立刻成为产品问题；先补角色与上限（而非先补协议），能让"手机上看、桌面端批"成为合法状态，短时限远端审批也贴合手机易失焦。改动大小：中；风险：中（触及 Core 授权判断与 Host Web 协议版本，需与既有 editor 语义并存）。

2. 插件权限用"开关 + 范围"两段表达，缺省即拒绝
参考证据：`pi-desktop@0ca811242 docs/spec/07-plugins/13-plugin-permissions-matrix.md:71-90`——权限名只回答"能不能做"，manifest 的 `net.domains`、`fs.read/write/delete` 回答"做到哪"；字段缺失或为空就是没有任何出口、没有常驻可达路径，整树写/删在校验期即失败。`同文件:58-69`——安装与升级复核列出全部声明权限，缺任一声明即 `PLUGIN_PERMISSION_DENIED`，自动更新遇新增权限直接跳过。`同文件:227-238`——运行期多道闸门顺序放行，"后面的闸门只能拒绝，不能放宽"（权限 → realpath → 保留/拒绝名单 → 作用域）。`同文件:92-107`——删除分 own/scope 两档，只走系统回收站、不递归、每 60 秒 50 次刹车。
LOOM 对照：`LOOM@312bbb8 docs/architecture/skills.md:11` Skills 只是模型可读的文件指南，不改变工具、权限与路由；`docs/architecture/runtime-catalog-boundaries.md:35-43` 四层权威是闭合产品目录、平台准入、机器状态、渲染层预览，没有"第三方声明能做什么"的位置；`packages/contracts/src/index.ts:4643-4658` Host Web 操作是闭合枚举 allowlist。缺失：没有贡献面，也就没有 (能力, 范围, 缺省拒绝) 这一结构。
借鉴价值：即使不做插件市场，把 Skill/MCP/自动化这类外来输入统一过一道 (capability, scope) 校验，能把散落在代码里的边界变成可校验字段；"后续闸门只能收窄"可直接当评审规则。改动大小：中；风险：中（只加权限名不加范围会变成假安全）。

3. Worker Session 用"真实会话 + 父级所有权 + 深度 1"约束委派
参考证据：`pi-desktop@0ca811242 docs/adr/0237-session-orchestrator-as-a-plugin.md:22-31`——spawn 走 `session/create` + `agent/prompt` 建一个不复制 transcript 的持久会话，继承父项目、provider/model、思考档位与权限模式；worker 的权威身份就是 `sessionId`；父会话只能控制记录在自己 session id 下的 worker，worker 不能再派生 worker，并发受插件自身设置限制。`apps/desktop/electron/main/services/session-collaboration.ts:119-126` 发送方身份必须来自 Host 认证的活跃 tool invocation，来源 sessionId/turnId 由 Host 注入；`同文件:146-176` 入队带 `idempotencyKey`，完成回执可插队但不抢占正在跑的 turn；`同文件:246-252` settle 幂等，可对旧 Host 的记录重放。
LOOM 对照：`LOOM@312bbb8 docs/architecture/public-a2a-message-delivery.md:17-32` CampMessage → Delivery → AgentRun 三类事实，Scheduler 按 FIFO 前缀 claim；`同文件:42-43` Core 明确不再维护 forward/return、root、depth、ancestor cycle 或 A2A 预算，只拒绝 self-send。即：投递/执行事实分层与 claim 排他比 PI 更强；缺少"由某次调用创建、只归该调用方控制"的 worker 边界与可判定的深度约束。
借鉴价值：LOOM 的 Delivery 是"一条消息的责任"，不是可回访的执行容器；把 worker 定义成持久会话、身份即会话 id、只允许一层，可在不引入 DAG 的前提下给出可审计的并行。改动大小：中；风险：中（与 Camp membership 显式目标寻址重叠，需先定"谁算 worker"）。

4. 模型选择写成"会话级绑定 + 思考档位夹紧"，而不是全局默认
参考证据：`pi-desktop@0ca811242 docs/spec/03-runtime/13-model-catalog-and-selection.md:240-262`——每个会话持久存 providerId、modelId、thinkingLevel；中途改模型或档位只影响后续 turn；切到别的 provider/model 时 thinkingLevel 重置为目标绑定的默认值并夹到其 enabled 集合，空绑定或只含 off 解析为 off。`docs/spec/03-runtime/11-provider-model-system.md:216-222`——不设固定模型白名单上限，发布元数据（上下文/模态/推理/价格）与用户显式覆盖分开，用户覆盖保持 pinned 且不回写。
LOOM 对照：`LOOM@312bbb8 packages/contracts/src/index.ts:444-456` 只暴露一个 Pi provider 段（providerId、baseUrl、api、modelIds、modelId、apiKeyEnv），无 per-model 上下文/推理能力、无思考档位；`docs/architecture/runtime-catalog-boundaries.md:277` 历史目录只能展示、不能证明当前 executable 支持某模型、不形成运行授权；`同文件:285-286` 成员配置只拥有模型策略，不拥有某次 Run 的实际模型。已有诚实的目录边界，缺会话级 binding 与档位落库。
借鉴价值：多端最易出现"一端切了模型，另一端解释不了历史"；把 binding 落在会话上并写明作用范围，可让多端与多 Runtime 自洽。改动大小：小-中；风险：低（实际模型仍归 Runtime，新增的只是策略层）。

5. 工作台把"新面板"设计成"同一资源集合里多一种资源"
参考证据：`pi-desktop@0ca811242 docs/spec/04-ux/09-interaction-patterns.md:547-563`——面板默认不显示，切换只显示/隐藏而不新建资源、不删标签、保留宽度；`+` 打开的 launcher 行里除 Browser 外还有"in-scope plugin view"；文件资源以规范化路径为身份，Browser 与 plugin view 都是单例，重复触发只激活已有资源。`packages/plugin-sdk/src/index.ts:176-177` `contributes.views` 就是把插件视图停靠进宿主工作面板的声明；`docs/spec/07-plugins/13-plugin-permissions-matrix.md:12` 该视图与面板同隔离：沙箱页、每插件分区、`net.domains` 出口、按激活作用域过滤。
LOOM 对照：`LOOM@312bbb8 docs/ui/components/file-preview.md:112-117` 右侧标签集合已把 Mission 活动与 Execution 当作非文件 Tab，共用关闭/键盘/阅读位置/末标签收起；`docs/ui/components/conversation-workspace.md:600-608` 执行台在右/浮层/底三位置间移动同一个已挂载 DOM，右侧与文件预览同级标签共用分栏比例。已有"多资源进同一标签集合 + 保状态移动"，缺的是新增资源种类的注册点与隔离（种类今天由共享 UI 硬编码）。
借鉴价值：LOOM 不必新建面板子系统，只需给现有标签集合加一张受权限约束的资源注册表，第三方视图就不会绕开比例记忆、键盘与保活规则。改动大小：中；风险：中（沙箱与激活作用域须先于注册表存在）。

取用边界：以上只取设计取舍，不搬代码。pi-desktop 以 LGPL-3.0 发布（`README.md` License 段），LOOM 为 MIT；直接复制源文件会带来 LGPL 传染与署名义务，故按字段/规则/角色重写，ADR 与 spec 仅作设计引用。

READ_FILES（12）
1. pi-desktop@0ca811242 README.md
2. pi-desktop@0ca811242 docs/spec/02-architecture/05-remote-agent-control.md
3. pi-desktop@0ca811242 docs/spec/07-plugins/13-plugin-permissions-matrix.md
4. pi-desktop@0ca811242 docs/adr/0237-session-orchestrator-as-a-plugin.md
5. pi-desktop@0ca811242 apps/desktop/electron/main/services/session-collaboration.ts
6. pi-desktop@0ca811242 apps/desktop/electron/main/session-collaboration-control.ts
7. pi-desktop@0ca811242 packages/plugin-sdk/src/index.ts
8. pi-desktop@0ca811242 docs/spec/03-runtime/13-model-catalog-and-selection.md
9. pi-desktop@0ca811242 docs/spec/03-runtime/11-provider-model-system.md
10. pi-desktop@0ca811242 docs/spec/04-ux/09-interaction-patterns.md
11. LOOM@312bbb8 docs/contracts/host-web-v2.md、apps/web/src/client.ts、packages/contracts/src/index.ts
12. LOOM@312bbb8 docs/architecture/public-a2a-message-delivery.md、runtime-catalog-boundaries.md、skills.md、docs/ui/components/file-preview.md、conversation-workspace.md、docs/contracts/single-chat-v1.md

LIMITS
- 纯只读：未运行构建、测试、typecheck，未联网，未修改两侧仓库；所有 LOOM 结论来自契约/UI 文档与少量源码片段，未做实现级追踪。
- LOOM 侧未逐行审计 Core 授权实现（`crates/rovai-core/src/action.rs` 仅关键词命中，未读取上下文），故"缺角色/缺上限"是按 Host Web 契约与共享契约判定，非代码级证明；`docs/contracts/single-chat-v1.md:18-19` 的"不为 runtime 原生 delegation 加 gate"也只按该段文字理解。
- pi-desktop 自身把 "Mobile clients"（`docs/spec/01-product/02-non-goals.md:11`）与 "Multi-user auth systems"（`同文件:10`）列为 MVP 非目标，第 1 条属 post-MVP 目标规格而非已发布行为。
- RACP 协议全文（`docs/spec/03-runtime/19-remote-agent-control-protocol.md`）只读了标题清单，未逐节核对，故未引用其具体操作字段。
- 未核对插件市场、签名更新与沙箱的实际实现，第 2、5 条的隔离描述仅依据权限矩阵与该行注释。

STATUS: DONE_AWAITING_APPROVAL

---

# 交付说明与限制

- 本报告是只读研究，不代表任何方案已实施；所有“改动大小/风险”是设计估算。
- 工兵行号由 glm 队长抽查 60+ 处：未发现伪造引用；pi-desktop 的部分证据是规格/ADR 文档行，不是实现行，报告中已标明。
- agenteam 因用户红线只保留 2 条非推送设计；其余项目保留前 5 条。
- 未运行参考项目构建/测试；未验证真实 APNs/Bark/Web Push；macOS Actions 验法是后续实施建议，不是已验结果。
- refs 包部分 local diff 因 CRLF 需 `git apply --ignore-whitespace`；rokbot diff 未包含两个 untracked license 新文件。

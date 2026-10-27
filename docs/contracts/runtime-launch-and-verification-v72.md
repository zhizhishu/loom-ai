---
document_type: contract
name: Runtime Launch and Verification
version: v72
status: accepted
source_version: v1.72
last_updated: 2026-10-25
---

# Runtime Launch and Verification v72

继承 [v71](runtime-launch-and-verification-v71.md)。本版替代 Command Code 的私有 HOME、原生配置
副本和配置兼容性摘要策略；其他 Runtime 保持既有策略。Command Code 的正式接入基线为官方 1.88.0。

## Command Code 所有权与连续性

Adapter 沿用共享启动环境的用户 HOME，不设置 HOME、不镜像或复制 `.commandcode`，不代建原生
projects/sessions、不读取认证/provider/settings/Mod/MCP 来计算兼容性摘要。用户的原生数据由 CLI 自己管理。

共享 Fleet 明确区分配置摘要策略与 Native Binding 身份策略。Command 只选择后者：Camp/Conversation
所属范围、成员、Native Binding ID、canonical execution root 必须一致，并满足既有进程健康、空闲和租约门槛。
缺失摘要或计算失败不会让其他 Runtime 进入身份策略。同 Run 复用仍校验 execution epoch、所属身份和附件执行根，
不比较 Runtime 或 MCP 投影摘要。Binding generation、Conversation version、Run/epoch 和已准备 Binding ID
继续防止跨会话及陈旧提交。

Command 新投影不生成 `hostConfigDigest`、`bindingCompatibilityDigest` 或带摘要的 Native Session key；
共享冻结结构的这两个字段允许 null。历史字符串继续反序列化，不清库、不回填、不因旧值不同换代。
Binding 提交根据冻结 Run 的 Runtime kind 明确选择此策略，忽略旧配置摘要相等条件；完整载荷、幂等请求、
凭据和共享 Context Evidence 的完整性校验保留，不能决定 Host 或 Session 选择。

Host 退出、应用重启或容量回收后，新 Host 用精确旧 Session ID 恢复，Bootstrap 由既有 Context 为本轮
准备并冻结；Command 不比较历史 Bootstrap，也不另建跨 Host 冻结恢复状态。直接调用原生
`session/load` 或 `session/resume`，不再前置 `session/list`、目录分页或 cwd 存在性证明。
这是原生尽力恢复：1.88.0 可静默接受不存在的 ID，RPC 成功不证明历史完整。不得将认证、网络、超时
解释为目标不存在，不改已有身份、输入接收及重试边界，也不以不确定连续性重复发送业务输入。

## 生效时机

- 模型 ID 原样传给标准 Session RPC，包括 `provider/model` 和 `@byok-…` 碰撞别名；不用 `acp --model`。
- 模型、权限通过原生动态 RPC 更新，保留 Host/Session。
- Rovai 启动设置、安装、成员启动环境与 MCP 分配/定义的显式成功修改，通过已有 Fleet invalidation 应用。
  空闲 Host 关闭，忙碌 Host 正常结束后退役；后继 Host 恢复原 ID，并传入当前 MCP。
  MCP Store 将本次有效工具发生变化的成员传给既有 Fleet：已启用 Server 的成员集合变更只影响增减成员，
  单成员分配只影响该成员；启用影响新分配成员，停用影响原分配成员。定义/删除/导入替换只影响已启用
  Server 的分配成员，关闭状态下的修改不退役。`setMembers` 的非空分配仍按原语义启用 Server。
  只匹配这些成员的 Command Host；无变化成功保存与失败操作均不退役。此事实仅在调用内传递，
  不成为配置快照或持久状态。
  启动设置与安装更新在释放配置/数据库锁后才等待 Fleet。字段目标已经等于当前值直接成功，不检查
  现存程序路径、不增加配置 revision 或安装 generation；命令网关 replay 不重复失效。
  成员环境保存复用该操作已读取、解析的旧/新值与继承选项，只有实际变化且命令首次提交成功才退役；
  JSON 排版、键顺序和命令重放不触发退役，不在执行前重新比较环境。
- 已运行 Host 保留启动环境；外部原生配置编辑按原生规则或用户显式重载生效，不触发 Rovai 扫描或隐式重建。
- Command dispatch 保留平台、权限、所属身份及显式禁用/删除安装的准入；磁盘入口、指纹及必要发现刷新
  只在 Fleet acquire 的 cold spawn 分支执行。入口暂时消失或安装观察 generation 改变不妨碍健康 Host
  继续执行。新进程使用当前安装证据和公共启动验证；不重绑已 claim 的 Run，不改变冻结的模型/权限意图
  或 Native Binding/Session。启动事件报告实际 Host 的版本。其他 Runtime 的预检策略不变。

## Bootstrap 交付

每个新 Host 只写一次 `rovai-bootstrap.mjs`，通过官方 `acp --mod <absolute-path>` 加载。
Mod 注册 `rovai-bootstrap` 控制命令和 System hook 后才写 ready。初始化局部 nonce 经环境传给 Mod；
initialize 后只校验一次 revision、nonce 和原生 PID 归属，删除 `ready.json` 并丢弃预期 nonce。
Windows 通过本次 Managed Process 的精确 Job handle 核对上报 PID 是仍存活的成员，允许 `.cmd` / `.bat`
包装进程启动的原生 Node 子进程；其他平台仍要求受管根 PID。零值、越界、已退出、无权查询或不属于
本次 Job 的 PID 均拒绝，不能仅凭 nonce、进程名或父 PID 放行。
没有 nonce 文件、逐轮探针或长期 nonce map/数据库字段；稳态材料只有该 Mod。

首次、warm、cold 都在建立／恢复 Session 后、发送业务输入前，经已有 ACP `session/prompt`
调用已注册的 `/rovai-bootstrap <JSON string>`。handler 先将参数解析到局部变量，确认非空字符串和
UTF-8 正文不超过共享 128 KiB 预算，再一次性替换 Mod 内存值；失败只返回固定
`command_code_bootstrap_invalid`，不转发输入片段或解析异常。命令不返回业务 prompt/message，
由原生直接回复 `end_turn`，不进入模型执行或聊天历史。Core 等控制成功后才发送原始 P；失败停止本轮
准备，不使用上一轮 B 继续执行，也不回退文件或 argv 路线。

控制请求沿既有普通 RPC waiter 返回；Session 准备阶段的 metadata 路由吸收状态／用量通知。
控制 `end_turn` 不生成业务输入接受、输出、终态或 Run 用量，不新增请求队列、锁或状态管理器。
共享 Context 为本轮冻结的 B 由 hook 原样追加到原生 System 一次，user 只含动态 P。
成员编辑不更新执行中的 Run；后继 Run 交付其已准备的新 B，同 Run 重试沿共享 Evidence 取回原冻结字节。
不比较历史正文，不因此更换 Host 或 Session，也不建立跨 Host／Session 的正文缓存。

内存正文沿现有 Native Binding 所属 Host 使用；该路径验证根 Session，未承诺多根 Session 共享或子代理
隔离。删除 bindings 目录、正文文件／临时写入／rename／读取、正文文件 SHA 与文件名专用 Session ID
限制；保留共享身份归属。此替换不改变 B/P 字节、选择规则、上下文版本、Evidence 权威或正文预算。

同一 Mod 在官方 `onSessionStart` 时使用 `getActiveTools` / `setActiveTools`，只移除
`ask_user_question`。保留当前启用的其他工具，不以硬编码白名单启用更多工具。1.88 ACP 已验证过滤器
同时移除模型 schema 并拒绝执行；不叠加 beforeToolCall fallback、运行时能力探测或问卷管理器。
真正需要 User 输入时使用 Rovai 已有消息渠道，不代选答案。

Skills 发现复用共享只读来源，同时包含 user/project 的 `.commandcode/skills` 和 `.agents/skills`；
不复制或链接。原生同名优先级为项目 `.commandcode`、项目 `.agents`、用户 `.commandcode`、用户 `.agents`。

状态检查沿共享 ACP 路径保留 RPC/进程错误并分类为认证、协议能力或临时故障，展示前使用公共脱敏。
不再用 Command 专属 provider 提示覆盖错误；这属于 health probe，不修改 Run 卡片或平台公开准入。

## ACP MCP

分配的 MCP 只经新建/恢复 Session 的标准 `mcpServers` 传入。用户原生 MCP 由 CLI 加载，1.88.0 已验证
原生同名定义优先；删除额外 `mcp list` 探测和私有 `mcp.json`，warm 不启动额外 CLI，也不构造不会发送的 MCP wire 参数。

1.88.0 的 ACP 原生 stdio 启动目录是 Session cwd，不取 CLI 最初的工作目录。投影 cwd 与 Session cwd
相同（包括共享路径比较已支持的 Windows 前缀差异）时直接传原 command/args；只有不同目录才使用已有
`node --eval` argv launcher。不增加目录探测、脚本文件或代理管理层。
1.88.0 的原生客户端即使从 ACP 接收 env/header pairs，仍调用 `resolveEnvPlaceholders`：字面 `$${x}`
会变成 `${x}`。因此只在 Command ACP wire 边界对已解析值中的 `${` 转义一次为 `$${`；真实 stdio/HTTP
回执须证明到达值与解析值一致。它不是原生文件格式序列化，禁止再叠加第二层转义。

## 失败材料

准备对象在创建进程前负责清理目录；进程创建后到 Host 接管前，局部启动 owner 同时持有进程和材料。
底层进程树初始化失败也必须返回仍持有实际 child 的失败对象。停止并 reap 后才可清理；无法确认完整进程树
结束时保留材料并记录诊断。Host 接管后复用既有 shutdown。共享 stdin、pending、Session、取消、退出排序
不改变；不新增专属锁、进程池、配置缓存、监听器或持久清理队列。

本结构变更不代替真实模型、MCP、App 与各平台资格验收，公开准入仍由现有资格流程决定。

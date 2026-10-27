---
document_type: implementation-plan
version: v1.72
lifecycle: current
authority: implementation-status
last_updated: 2026-10-22
---

# 通用环境配置实施与验收

User 于 2026-10-21 确认第三版交互稿并授权独立 worktree 实施。数据合同见
[Runtime Launch v68](../../contracts/runtime-launch-and-verification-v68.md)，界面合同见
[队员环境变量](../../ui/components/member-identity.md#队员环境变量)。

## 工作区

- 分支：`rovai/shared-runtime-environment`。
- Worktree：`/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-shared-runtime-environment`。
- 基线：`origin/main`，`52758245275b024122e4fd35414362f05298b646`。
- 无需前置治理提交。提交时状态：ready，本地实现及门禁完成；合入状态见 [PR #851](https://github.com/murray17/rovai-ai/pull/851)。原主工作区保持不动。
- 已合并主线 `1bcd9ba0a00b054886396c9e68ea7db5bdffbee6`，保留系统语言与纯文本粘贴修复。

## 实施范围

Core 新增独立加密通用版本和成员继承偏好，复用原有环境解析、掩码和私有 key。
路径及通用配置共同提交；正式检测、草稿检查和模型目录消费通用变量；新进程按三层合并。
保留健康 Warm、新进程读取、归档只读及原生文件不写入边界。

Renderer 共用正式启动设置和队员编辑器，通用非空才显示额外操作；只读预览不改动本地草稿。
进入对应设置保留成员页面，具名返回恢复滚动；中英文、日夜主题与窄屏使用同一组件。
Desktop 与 Web 的 Owner 方法白名单同步扩展，不向 Agent 工具开放配置入口。

## 验证归属

优先扩展既有 owner：

- `member_environment::tests::private_versions_preserve_credentials_and_new_launches_read_current_configuration`：
  三层合并、不同 Runtime、空值、覆盖删除、关闭继承、旧非空默认独立、密文和 revision 冲突；
  损坏通用记录不阻止 Host 配置加载或独立队员。
- `runtime_custom_api::tests::startup_saves_preserve_native_files_and_merge_only_local_preferences`：
  路径/通用保存事务、原生文件保留，以及首次通用保存不改变旧手动入口。
- `runtime_check_environment::tests::fresh_formal_and_draft_checks_preserve_program_selection_and_private_state`：
  实际合成子进程收到保存/草稿通用值，正式与草稿状态隔离和检查环境失效。
- `scripts/fixtures/member-editor`：生产组件的原地只读、格式保留、凭据掩码、草稿检查、失败重试、具名返回、
  保存不复制通用值、取消继承、放弃通用编辑和清空后恢复紧凑编辑器；保留原队员交互回归。

新增独立 Rust owner 仅为 `db::shared_environment::tests::shared_environment_upgrade_is_atomic_and_does_not_read_legacy_credentials`。
修复前 schema 160 无通用表，DDL/回执中途失败后需完整回滚；无旧 key、损坏旧 ciphertext 仍必须能升级，且
不能启用归档。原快照退役 owner 不拥有新增表事务，纯解析不足以证明 SQL 回滚及重开，因此复用最小隔离数据库，
进入 extended-tests。最小命令：`cargo test -p rovai-core --features extended-tests --lib environment`。

初轮 UI 验收暴露测试夹具没有正式 discovery 子对象，已补全；旧迁移 owner 在旧 schema 上调用新 getter，
已调整为完成新升级后读回；既有升级 helper 完成最新 migration 后再断言 current。保存成功后的 Profile 刷新
原先会二次清空环境编辑状态，已让运行配置与环境各自接受本次保存。没有删除或停用测试。

## 本地验证

- `pnpm typecheck`、`pnpm build:desktop`：通过。
- `pnpm test`：251 个 Vitest 文件、2,847 项测试通过；脚本层 357 项通过、2 项平台限定跳过；文档、Skill 及 sandbox 探针回归通过。
- `node --test scripts/lib/member-editor.test.mjs`：隔离 Electron 的 25 组场景通过，含并发通用修改拒绝、保留草稿与显式重新读取。
- `cargo test -p rovai-core --features slow-tests --lib environment`：20 项通过。
- 同参数 `startup_saves_preserve_native_files_and_merge_only_local_preferences`：1 项通过。
- `pnpm docs:test`、`pnpm docs:check`、以基线 SHA 为 `DOCS_BASE_REF` 的 `pnpm docs:check:ci`：通过。
- `pnpm test:rust:pr`：workspace 474 项通过、1 项既有忽略；`cargo check --workspace`、`cargo fmt --all --check` 通过。
- `--features slow-tests --lib -- --exact` 定向执行 6 个现有 owner：当前 migration admission matrix、current schema objects、database preflight、interruption admission、lightweight task、single chat bootstrap；全部通过。
- 合并主线后重新执行 typecheck、完整 `pnpm test`、25 组 Electron 验收、桌面构建、Rust check 与文档增量门禁；全部通过。

## 配置恢复与迟到回包修复

独立分支 `rovai/environment-state-recovery`，worktree 为
`/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-environment-state-recovery`，
基于 `origin/main` 的 `e4346bef3ff33cf259756ee55b38502c867ad5a3`；无需前置治理提交。

- 通用配置冲突后重新读取，再编辑并放弃更改，恢复到通用编辑器最近读取的保存基线；
  程序路径仍恢复到自己的保存基线，清除原有检查结果和冲突提示。
- 队员显示密钥请求的迟到回包仅更新队员变量，从 state 保留最新通用配置，避免合并预览倒退。
- 既有 `member-editor` owner 扩展冲突恢复场景，并增加可手动释放回包的确定性并发场景；
  两处修复前分别复现旧值回退，修复后 26 组隔离 Electron 场景通过，继续保存不再重复冲突，
  队员未保存草稿与合并预览掩码均保留。`pnpm typecheck`、`pnpm build:desktop` 通过。
- `pnpm test` 通过（2,847 项 Vitest、357 项脚本测试通过，2 项平台限定跳过）；文档测试、
  全量校验与以本次基线为 `DOCS_BASE_REF` 的增量门禁通过。

## 离开保护与检查结果修复

独立分支 `rovai/environment-navigation-guard`，worktree 为
`/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-environment-navigation-guard`，
基于 `origin/main` 的 `caf66a6eac581a62cb242b0c4037f60cb6855ed5`；无需前置治理提交。

- 启动设置注册应用内离开保护，左侧返回、页内返回共用原有放弃确认。设置分类仅隐藏表单，
  保留草稿、离开保护及确认弹窗；取消保留当前分类，确认后才离开。
- 通用配置的显式重新读取复用修改通知，立即清除旧检查结果，不自动触发检查。
- `member-editor` 既有场景覆盖“检查通过 → 外部更新 → 显示密钥冲突 → 重新读取”，
  断言新值显示、旧检查标签消失且检查次数不增加；修复前失败，修复后 26 组场景通过。
- 复用 `member-creation` 的真实 `BusinessApp` 夹具，新增 `environment-main.cjs` 验证全局返回的取消和放弃、
  队员草稿保留、分类切换后的离开保护、页内返回只确认一次及无草稿直接返回；原全局返回遗漏已复现，
  修复后 5 项导航行为通过。所有场景使用隔离 Electron 和合成运输数据，不连接日常 Core 或模型。
- `pnpm typecheck`、`pnpm build:desktop`、文档与 Skill 门禁通过；Vitest 全量 2,847 项及脚本层
  357 项通过，2 项平台限定跳过。本机并行全量曾出现 5 秒超时；改用 2 个 worker 完成全量，
  遗留的个人资料文件单独重跑 3 项通过（测试耗时 60ms），未更改断言或超时门槛。

## 保存反馈与真实运行验证

2026-10-21，分支 `rovai/runtime-save-feedback` 基于 `21f5855909652b89887034a7835a5e08f171a645`，
worktree 为 `/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-runtime-save-feedback`；无需前置治理提交。

- 移除队员变量编辑器下重复的“已保存。”及其专用展示状态。通用配置保存成功反馈复用队员信息页的
  `member-editor-save-row` / `member-editor-save-status`：左侧灰色文字、右侧操作，不再使用绿色检查结果样式。
- `pnpm typecheck`、`pnpm build:desktop`、26 组 `member-editor` 场景、`settings-workspace` 双主题及缩放验收通过。
  原有场景改为等待实际保存值，不再依赖已移除的提示节点。Impeccable 检测无新增问题。
- 文档、Skill、Electron sandbox 门禁通过；Vitest 使用 2 个 worker，252 文件 / 2,854 项全部通过；
  脚本测试 357 项通过、2 项平台限定跳过。`cargo test -p rovai-core --lib --features extended-tests member_environment::`
  的 4 项既有 owner 测试通过，覆盖并发子进程、合并、空值、作用域、加密与生命周期。
- 按 User 授权，从 cc-switch 的 PackyCode Claude 配置只读取得连接参数，在本 worktree 构建 Debug Core，
  用独立 Core data-dir、Skill Library、MCP、HOME 与 Claude 配置目录调用 Claude Code `2.1.304`。
  一个仅记录专用测试变量的启动观察器随后 `exec` 原生 CLI；每个场景建立新 Thread，观察到一个新原生进程，
  真实模型回复及 Core Run 均成功。没有复制日常数据库、切换 cc-switch 当前配置或更新日常 App。

| 场景 | 实际原生进程观察 |
| --- | --- |
| 队员继承通用配置，设置同名、独有和空字符串变量 | 队员同名值覆盖通用及 Host；Host 独有、通用独有、队员独有值均保留；空字符串仍为空 |
| 删除队员的同名及空字符串条目，另建 Thread | 同名值及原空值恢复到通用配置；队员独有值保留 |
| 第二位队员关闭继承，以自己的 PackyCode 参数调用 | 通用独有变量不存在；Host 值保留；第二位队员独有值生效，第一位队员配置未改变 |

额外核对不同 Runtime 的通用记录为空、公开 Core 事件无凭据、SQLite 中凭据未以明文存储。
三次真实调用结束后已停止本次隔离 Core 并删除临时数据；仅保留不含凭据的验收摘要。
旧 `configure-product-runtime.mjs` 辅助函数会等待成员 `ready`，与当前未执行前的 `installed_unverified`
状态不符；本次临时验收直接使用当前 Installation 检查结果及真实 Run 结果，没有修改产品准入逻辑。
- 复用的 `member-creation` 夹具显式固定初始中文，避免系统语言默认值使既有中文断言失效；
  同时将其旧的会话打开快照版本更新为当前合同的 9，并以运行配置表单替换已移除的标题选择器。
  原有中英文切换覆盖与协议准入校验保留；AI 队员创建、一键草稿和新增导航保护三个验收入口均通过。

## 未覆盖范围

本地确定性回归使用合成凭据、临时数据库和隔离 Electron，不读取日常用户数据或调用真实中转/模型。
Windows 大小写语义以纯边界测试覆盖；真实 Windows Runtime 与用户中转账户需要独立环境验收。

## 直接显示与标量输入

2026-10-21，分支 `rovai/environment-input` 基于 `77dad3838673914f1e12f633a7c5b70389ee065b`，
worktree 为 `/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-environment-input`；无需前置治理提交。
本节替代上文历史验收中的掩码行为。当前数据边界为 [Runtime Launch v69](../../contracts/runtime-launch-and-verification-v69.md)。

- 保留 JSON 编辑器，不增加添加变量入口。队员、通用及只读旧配置直接显示完整值，删除 reveal 请求、
  掩码、`<saved>` 特殊标记和相应验证；保留 Owner 访问、加密存储和公开输出脱敏。
- `parseMemberEnvironment` 统一接受 string/number/boolean，按 `String(value)` 转换。重复名检查仍针对
  原始文本；不支持的类型与不安全数字明确指出变量名。预览及提交使用字符串映射，输入和失败保持原稿。
  通用与队员保存成功都接受后端最新字符串快照；新队员创建后共用同一个运行配置编辑器。
- 前后端取消独立 128 项与 256 字符名称限制，保留名称、NUL、保留名、字节容量、模型及 revision 冲突。
- 复用既有 Rust owner：`runtime_startup::tests::environment_validation_preserves_values_and_rejects_ambiguous_or_reserved_names`
  覆盖放宽限制、保留 Core 字符串输入合同；`member_environment` 的私有版本、迁移和实际并行子进程 owner
  验证完整 Owner 读回、明文不落库、合并、空值及 `"0"`/`"false"`/`"00123"` 在真实进程中的结果。
  `runtime_check_environment` 保留正式/草稿检查与公开输出脱敏。没有新增、删除或禁用 Rust 测试函数。
  原掩码和保留标记断言因 v69 明确退役而改为完整值断言，密文与输出保护仍由原 owner 负责。
- `member-editor` 既有 Electron owner 扩展新队员、普通编辑和通用配置的规范化、失败草稿、非法值拒绝，
  原地预览、具名返回和独立模式继续验证。旧 reveal 并发路径已删除，原迟到回包场景改为普通队员读取，
  仍验证最新通用配置不会被迟到的旧快照覆盖。

2026-10-22 本轮验证：

- `pnpm typecheck`、`pnpm build:desktop`、`cargo fmt --all --check`、`cargo check --workspace` 通过。
- 全量 Vitest（2 workers）共 2,856 项，首轮 2,855 项通过；既有文件预览 watcher 一项未在等待时间内收到事件，
  该文件单独重跑 59 项全部通过，未修改断言或超时门槛。后续脚本 357 项通过、2 项平台限定跳过。
- `pnpm test:rust:pr`：474 项通过、1 项既有忽略；extended `member_environment::` 4 项通过；
  slow `fresh_formal_and_draft_checks_preserve_program_selection_and_private_state` 1 项通过。
- 隔离 Electron `member-editor` 26 组通过，包含新队员标量保存、完整凭据显示、草稿/保存/预览一致性、
  同名覆盖及迟到读取；`member-creation` 三个入口通过，其中环境导航 5 项；移动端英文 smoke 6 项通过。
  日夜、最小窗口截图检查无新增问题。
- 真实 Core `smoke-member-environment.mjs` 16 项通过，含 Owner 完整读回、命令重放、CAS、重启、密文、
  公开事件脱敏和归档只读/确认。旧脚本手工回退局部 schema 已不满足当前升级准入，改为当前 schema 加密归档夹具；
  真正的历史迁移、失败回滚与重开继续由已通过的既有 Rust migration owner 验证。
- 文档测试、全量及基于 `77dad3838` 的增量门禁、Skill 门禁通过。
- 本轮真实子进程验证字符串值及合并，未重复 LLM 调用；上文三次 PackyCode 真实调用属于此前验收。
  Windows 名称折叠由纯边界测试覆盖，本轮未在 Windows 真机启动 Runtime。

# LOOM

LOOM 是以 [Rovai AI](https://github.com/murray17/rovai-ai) 为 UI 与运行时底座的产品分支。
它保留 Rovai 的对话、团队、使命、执行卡片与 Diff，并在其上重建编排、验收与证据能力。

- 基线上游：`murray17/rovai-ai`，MIT，快照提交 `4ea9cac1122923176948803228df2abf11b6fa25`
- 上游远端：`upstream`（只读参考，用于比对与移植，不做常规合并）
- 本仓库：`origin`

## 架构总览

```
┌──────────── 主助手 / Rovai 持久队友 ────────────┐
│ Pi / DSH / Codex / Claude Code / 其他已接入 Agent │
│ 名字 + 角色 + Agent + 模型 + 权限 + 工作约定       │
└──────────────────┬──────────────────────────────┘
                   ▼
┌────────────── 接入与反馈层 ──────────────────────┐
│ A．事件回投 / 唤醒桥                              │
│ B．ACCP 式拉取：claim / report / artifact         │
│ C．Rovai 式托管：原生协议 / ACP / Runtime Host    │
└──────────────────┬──────────────────────────────┘
                   ▼
┌──────────────── 控制层 ──────────────────────────┐
│ 承担旧 orchestrate.py 的职责，实现参考 Rovai / ACCP │
│                                                   │
│ Rovai：Message / Delivery / AgentRun              │
│ 　　　冻结上下文 / Runtime 调度 / 恢复 / 定时       │
│ ACCP：Task / DAG / 依赖 / Run attempt             │
│ 　　　成果 / 验收 / 审批 / 上下文版本               │
└──────────────────┬──────────────────────────────┘
                   ▼
┌──────────── 可替换的执行层 ──────────────────────┐
│ Pi / Codex / Claude / DSH / ACP / ACCP-compatible │
│ pi-skill：其中一种 Pi 执行与管理能力，非唯一底座   │
└──────────────────┬──────────────────────────────┘
                   ▼
        Native Session / Host / 工具 / 工作区

旁路 UI：以 Rovai 为基础扩展
队友 / 对话 / Mission / 执行卡片 / Diff
＋ LOOM 风格 / archify 流程视图 / 验收与证据
```

## 不可混同的事实

这些区分决定实现是否正确，不能为了界面好看而合并：

- Agent 身份 ≠ 原生 Session ≠ AgentRun ≠ 操作系统进程
- 输入被接受 ≠ Run 完成 ≠ 证据已核验 ≠ 人工已验收
- 取消请求 ≠ 进程已静止或已隔离
- Mission 状态为 `completed` 不代表业务验收通过
- 无运行中队员 ≠ 工作已完成

## 当前状态

已落地（Renderer 纵向切片，未接控制层）：

- Mission 现有 Activity 预览中增加「编排 / 交付」视图，与原生「活动」共存
- 活动与交付共享同一个交付读取 owner，切换不重复请求、不丢阅读位置
- 无权威计划与验收合同时，明确显示「尚未配置编排」「独立验收尚未接入」，不提供假审批
- 隔离 Electron fixture（`pnpm test:loom-workspace`）覆盖三页、键盘、请求次数、滚动恢复与多主题截图

未落地（下一阶段）：

- 控制层：Task / DAG / 依赖 / Run attempt / 成果 / 验收 / 审批 / 上下文版本
- 接入层：事件回投、ACCP 式 claim/report、Runtime Host 托管
- 执行层适配清单与能力矩阵
- archify 式流程视图、LOOM 品牌视觉替换

## 开发与验证

```bash
pnpm install --frozen-lockfile
pnpm typecheck                 # Renderer / TS 类型
pnpm test:loom-workspace       # LOOM Mission 工作区隔离验收（Electron）
pnpm docs:check                # 仓库文档治理门禁
cargo check --workspace --all-targets   # Core / Host / Web（需 Rust 1.85+）
```

Rust 未安装时无法运行真实桌面 App；此时使用 `scripts/fixtures/loom-workspace` 与
`scripts/fixtures/mission-board` 的隔离内存适配器做 Renderer 验收，不接触真实 Core、
Runtime 或日常用户数据。

## 许可

继承上游 MIT 许可，保留 `LICENSE` 与上游版权声明。

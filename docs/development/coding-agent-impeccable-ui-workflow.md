---
document_type: development-workflow
authority: local-coding-agent-tooling-and-ui-document-routing
last_updated: 2026-10-25
---

# Coding Agent UI 与设计文档工作流

## 读取顺序

1. 读 `AGENTS.md`、[文档导航](../README.md)、[DESIGN.md](../../DESIGN.md)与[UI 索引](../ui/README.md)。
2. 按目标读取主题合同、组件合同和匹配的 surface brief；只在涉及产品用途、术语或品牌时读 `PRODUCT.md`。
3. 检查对应生产组件、CSS、Token 和测试。发现文档—实现漂移时，标明已确认规则、实际实现和本次修复范围。
4. 保持现有视觉系统；仅在用户明确要求重设计时更换方向。

## 内容归属

| 内容 | 唯一维护位置 |
|---|---|
| 产品用途、用户、术语、品牌承诺 | `PRODUCT.md` |
| 全局视觉、通用控件、色彩职责 | `DESIGN.md` |
| 配色注册、明暗解析、完整 Token | `docs/ui/themes/` |
| Rovai 特有复杂组件的结构、状态呈现与交互 | `docs/ui/components/` |
| 页面信息优先级、构图与局部约束 | `apps/desktop/.impeccable/surfaces/` |
| 主题、键盘、缩放和无障碍验收 | `docs/ui/qa/` |
| 领域、权限、持久化、Runtime 语义 | 当前 Architecture / Contract |
| 范围、进度、实施证据与历史理由 | 当前或对应历史版本文档 |

主题不能分叉组件树。Surface brief 不能重定义 Token 或覆盖全局设计、当前 Architecture/Contract。
文档的 `accepted` 不代表实现或验收完成。

## 写作与维护

- 写当前可执行规则：对象、条件、应有行为、必要边界；用短句、列表或表格。
- 删除重复说明、方案比较、会话 sequence、评审过程、旧名称解释和已完成迁移步骤。
- 全局规则只写一次；页面文档链接继承，仅写局部差异。必要的错误恢复和交互约束必须保留。
- 索引只放入口与读取边界，不承载功能流水账或实施状态。
- 不从遗留样式推导新规范；以已确认设计为准，单独记录未完成的实现修复。
- 更新所有受影响的当前引用和 fragment；不改写历史决定，不增加兼容空壳或重复权威。

`DESIGN.md` 使用以下章节顺序：Overview、Colors、Typography、Layout、Elevation & Depth、Shapes、
Components、Do's and Don'ts。Front matter 只保留真实复用的稳定值；不复制完整配色表。

主题文档保留稳定 ID、模式、必要的配色约束、完整 Token、实现入口与验收要求。
所有已注册配色覆盖同一组件和状态；`system` 只负责解析偏好。

仅为具有持久局部策略的页面建立 brief。保留 `version`、`slug`、`primary_target`、`related_targets`；
修改时核对目标路径和实际组件，不为每个基础控件创建独立文件。

## Impeccable 本地工具

- Impeccable 可选；共享规则不得依赖某个 Provider、Slash Command、Hook 或 Plugin。
- 使用当前 Agent 已发现的 Skill 路径。原生发现不可用时，直接读已安装的 `SKILL.md` 与所需 reference。
- 应用 Skill 时按其说明运行一次 context，并加载当前目标的参考流程；不要重复运行上下文提取。
- 文档维护采用现有设计的提取/整理流程；不重复创意访谈，不自行重设计或因 detector 偏好改变产品规则。
- 未获明确授权不安装或启用 Hook/Plugin。需要安装 Skill 时只安装实际使用的 Provider 完整 payload，并核对其来源和版本。
- 第三方 Skill、companion agents、缓存、评审结果及生成 comps 仅在本地保存，使用精确忽略规则。
- 不自动生成或启用 `design.json` sidecar；采用前须明确其同步维护责任。
- Provider 适配文件只链接共享入口并补充必要装载方式，不复制设计、架构或测试规则。

## 验证与交付

文档变更运行：

```bash
pnpm docs:test
pnpm docs:check
DOCS_BASE_REF=<真实目标 base SHA> pnpm docs:check:ci
```

新增或修改文档路由遵守[通用文档治理](../decisions/README.md#自动治理)，不添加按功能或 Skill 绕过检查的例外。
同时核对本次涉及的主题、组件和 brief，排除相互矛盾的规则及悬空链接。

修改 UI 代码时另按[最小验证矩阵](local-workflow.md#最小验证矩阵)和
[主题矩阵](../ui/qa/theme-matrix.md)执行相应验证；启动真实 App/Runtime 前读[隔离流程](local-workflow.md)。
报告改动、验证结果及尚未完成的实现项；文档变更不计作界面修复。

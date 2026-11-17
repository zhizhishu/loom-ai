---
name: LOOM
description: A calm, material-rich workspace for human and assistant collaboration.
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Microsoft YaHei, sans-serif'
    fontSize: '14px'
    fontWeight: 400
    lineHeight: 1.6
  mono:
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace'
rounded:
  control: '9px'
  surface: '14px'
  dialog: '21px'
spacing:
  xs: '4px'
  sm: '8px'
  md: '12px'
  lg: '16px'
  xl: '24px'
---

# LOOM 视觉与交互系统

## 已选方向

**用户已锁定 LOOM 官方品牌图**：粉发、绿眼、黑色猫耳角色，不是临时占位或机器人。使用 [已批准图片的 256px 本机副本](docs/loom/assets/loom-brand-user-approved-256.webp) 作为 Web/Desktop 标签图标及左侧品牌标识的共同来源；原图与工作副本不可混称同字节。用户自定义助手头像保持独立，不以品牌替代。具体实现和真机验收以当前代码、测试和 `LOOM-IMPLEMENTATION.md` 为准。

用户已确认 Mikka/PiBot 风格和当前 `loom-native` 主布局。后续属于这个方向的产品打磨，不重新发散，也不导入旧 Rovai 页面、主题变量、导航框架或品牌约束。底层权限、持久化与安全合同保留；视觉不被旧代码命名绑住。

当前视觉真源：

- `apps/desktop/src/renderer/src/loom-native/native.css`：独立基础几何与主界面。
- `apps/desktop/src/renderer/src/loom-native/product.css`：玻璃材料、助手配置、能力、群聊、工作区、关系图。
- `Controls.tsx`：有键盘语义的统一选择菜单/浮层。

## 几何

1605px 参考画布：42px 顶部、64px 窄图标栏、264px 会话栏、弹性中央阅读区、最多528px右检查器。小屏采用同一组件和数据，侧栏/检查器可覆盖显示，不硬压缩所有列。

聊天区白色偏暖中性阅读层；用户气泡蓝底白字、20px圆角；助手浅灰段落气泡与结构化正文分开。输入框两行、圆角20px，附件/接收者在底行，发送按钮右下。长文本、代码、图片和表格可局部滚动，不使整个窗口横向溢出。

## Colors

当前新界面的颜色由 `native.css` 的 `--ln-bg / --ln-side / --ln-card / --ln-text / --ln-muted / --ln-blue` 和 `product.css` 的 `--ln-glass / --ln-glass-raised / --ln-soft-line / --ln-soft-fill` 定义。深浅主题沿同一组件树切换，Portal 需携带对应主题。文字对比、危险/成功状态与可读禁用态优先于透明效果。

历史主题文档仍引用本节作为颜色原则入口，但其旧 `--conversation-*` 等 token 仅归历史表面，不导入新 `loom-native`。不能为统一颜色而改变权限、验收状态或头像身份色；新主题也不得用颜色单独表达状态。

## Material 层次

外窗是低饱和灰蓝/暖灰基底，不做鲜艳渐变背景。侧栏与右面板半透明，约24–28px blur；正文层保持高不透明度保证阅读。输入框、身份胶囊和菜单轻微浮起；任务卡以低对比填色区分，不依赖明显边框。

玻璃只用在有层级意义的 chrome、侧栏、检查器和浮层。不要给每个段落/卡片加 blur，不做霓虹、光晕、粒子或渐变文字。深色保持同一组件结构，以 token 切换。无 backdrop-filter 或 reduced-transparency 时回退为实色。

## 控件

负责人、运行端、模型等选择使用 `ChoiceMenu`：柔和填色、无原生硬外框、轻箭头、选中标记；可带真实头像。菜单通过 Radix 的键盘导航、角色和焦点管理实现，Portal 同样携带 `.ln-portal` 与当前 theme。

按钮只分必要的主要动作、安静动作与危险动作。不能为了“看起来能用”显示假的启用按钮。禁用态必须可读且有原因。持续权限不得默认选中或藏在一般保存中。

四类能力分区要清晰、计数真实；优先名称、简述和状态，来源/正文/范围可展开。正常界面不堆 JSON、hash、Run ID；审阅和诊断时允许查看精确内容。

## 助手与群聊

保留动态头像引擎、原身份颜色和用户自选头像。资料页主要是名称、职责、用途、沟通方式，补充约定可展开。模型和权限放在独立分区，不能用身份模板顺手改变。

新对话允许单聊/群聊，勾选成员并从中指定主助手。主助手是会话职责，不是高权限等级。工作区域应显示真实主机目录；浏览/取消不创建群聊或授权。

## 工作与成果

任务状态、运行完成、技术核验、独立审查、用户接受和发布分开。显示“等待你”要有真实依据，不从聊天口吻推断。

成果浮层是文档阅读＋相关上下文。版本和证据由后端提供，不按时间猜链路。打开文档不自动验收。未连接屏幕服务时用清楚的空状态，不放演示桌面。

工作/资产图只投影真实任务、依赖、候选、证据和版本关系。图不拥有第二份业务状态，也不通过拖拽绕过审核。

## 失败与恢复

Loading / Empty / Error / Unsupported / Unsaved / Submitting / Conflict / Unknown 都有独立表达。读取失败不画成空名单；保存失败不清空草稿；“已保存”“已生成下次配置”“设备已应用”“实际执行”不混用。

有未保存修改时切助手、分区或关闭，需要可返回编辑的提示。高风险 Hook 的确认绑定精确正文与范围，取消不产生授权。请求结果未知时保留原命令身份，不换新ID重复创建。

## 可访问性与验收

所有主操作使用 button、form、label 和明确 aria-label。保留 focus-visible、键盘导航、Tab 限制、Esc 关闭和焦点返回；色彩不是唯一状态信息。动画尊重 reduced-motion。

最小验收：1605/1440/1040/760/390宽度、深浅模式、真实资料与任务、菜单焦点、浮层、小屏无页面级横向溢出。每个可保存功能至少有隔离真实 Core 写入与读回证据，不能只靠静态截图或 mock 单测。

## 文档分工

产品定义归 `PRODUCT.md`；实施状态和用户纠偏归 `LOOM-IMPLEMENTATION.md`；接口/Runtime兼容归 `docs/loom/productization-interfaces-2026-11-13.md`；Core权限、数据、冻结和恢复归对应 Contracts。历史Rovai UI文档仅供尚未迁移表面的参考，不得推翻当前已选视觉世界。

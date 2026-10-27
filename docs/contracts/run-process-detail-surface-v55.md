---
document_type: protocol-contract
contract: run-process-detail-surface-v55
authority: conversation-run-presence-surface
status: accepted
version: 55
source_version: v1.72
last_updated: 2026-10-21
---

# Run Process Detail Surface v55

继承 [v54](run-process-detail-surface-v54.md) 的位置、身份／模型、执行详情、停止与重试边界。
本次在公开会话执行行的进展上方加入原消息引用，Desktop / Web 使用同一生产组件。

- 来源只使用该 Run 的 `inputMessageIds`，按记录顺序去重；第一条输入提供默认引用，多个输入增加数量入口。
  `anchorMessageId`、启动公开消息序号和执行行附近的消息只参与既有位置规则，不推断输入来源。
- 默认引用复用公开消息的引用样式，显示作者和单行摘要；数量入口展开作者、时间、摘要及逐条定位动作。
  用户消息、公开 A2A 消息、纯附件输入遵守同一规则。附件输入可用文件名作为摘要。
  进展更新或执行行移动不改变来源集合；紧接同 Run 回复省略身份时仍保留来源引用。
- 未载入输入可展示该 Run 已记录的首条 `inputSummary`；摘要不是消息身份。无 ID 的旧 Run 显示
  “来源未记录”；撤回或确认不存在的输入显示“原消息不可用”，不显示其旧正文或猜测替代来源。
- 点击引用定位精确消息并交接 DOM 焦点，不给消息正文增加描边或高亮，也不增加“返回执行位置”入口；
  回到底部统一使用会话已有的“回到最新”向下按钮。多输入浮层选择后将焦点交给原消息；
  Escape 关闭浮层并归还数量入口。执行条及来源控件保留键盘操作的可见焦点。
  这些动作不修改 Composer 草稿，也不打开执行详情或触发停止／续做。
- 可见消息直接定位；需要历史内容时只在用户操作后请求现有 `thread.messages.around`。
  Renderer 保留一个有界来源窗口，按消息版本合并到时间线，不建立新的后台扫描、Core 投影或持久缓存。
  校验 schema、Thread、锚点与来源可用性；较新的撤回状态优先，读取失败保留明确重试入口。
  新的定位、切换 Thread、切到其他导航目标或发送消息使旧请求失效，迟到结果不得挂载消息、滚动或抢焦点。
- 来源、批量数量、执行详情、停止／重试各自独立。已有消息 Footer、复制／回复动作、时间线产物分组及
  执行进展行高不变。遵守既有主题、窄宽度、省略、键盘、粗指针和 reduced-motion 规则。

验证由现有生产组件浏览器 owner `pnpm test:run-presence-ui` 承担，覆盖输入与位置分离、批量与 A2A、
历史读取、旧记录与撤回、失败重试、草稿／焦点／回到最新、迟到响应隔离，以及既有执行控制与主题布局。

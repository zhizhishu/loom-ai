---
document_type: protocol-contract
contract: member-avatar-v2
authority: member-avatar-assets
status: accepted
version: 2
last_updated: 2026-10-14
---

# Member Avatar v2

继承 [v1](member-avatar-v1.md) 的受控引用、资产 schema 1/2/3、导入、显示裁切、资源上限、渠道导出与历史兼容。
仅替代 Agent `member.get` 的旧双图片读取；完整结果见 [Built-in Transport v40](builtin-tool-transport-v40.md)。

## Agent 头像读取

每次授权的 get 从同一身份快照取得头像引用，返回一个必需的 `avatar` 对象。

| status | path | displayCrop |
| --- | --- | --- |
| available | 当前 Run 私有临时目录中的一个非空绝对文件路径 | 新 schema 3 为保存的取景；旧／内置头像为 null |
| absent | null | null |
| unavailable | null | null |

absent 仅表示没有设置图片引用；UI 继续使用默认首字头像。unavailable 表示引用、文件校验或物化失败，
不能替换为 absent，也不阻断身份及版本读取。显式选择的内置头像正常读取时为 available。
未知状态、额外字段、available 无路径以及失败状态携带路径／取景均不符合输出 Schema。

| 资产 | 唯一物化内容 | 取景 |
| --- | --- | --- |
| schema 3 | source.png／source.gif 的临时副本 | displayCrop 与保存的 iconCrop 相同 |
| schema 1/2 | 已有 icon-192.png／icon-192.gif 的临时副本 | 已烘焙在文件中，displayCrop 为 null |
| 内置 | 当前 UI 使用的 packaged icon | displayCrop 为 null |

displayCrop 是封闭三数值对象：centerX、centerY 相对方向处理后的宽高，范围 0–1；size 相对短边，
范围 0.12–1；源资产读取时仍验证裁切区域合法。元数据描述显示区域，path 不保证是物理裁切后的文件。

读取最多写一份头像副本，不再物化 portrait；GIF 原有动画内容保留，不逐帧裁切、缩放或编码。
文件写入失败清理本次未完成文件；生命周期继续绑定既有 Run lease，跨 Run 重新授权、重新物化。
受管引用、永久资产路径与 base64 不进入该 Agent 结果。

## 兼容

新输出不提供 icon/portrait 别名或双写。既有历史回执保留；不改变 Session 恢复、数据库或资产 schema。
内部 source、旧裁切与确定性重试入口继续保留；此处删除读取字段不授权删除旧源图。
Desktop/Web 资产读取、用户资料、导入与渠道静态导出沿用 v1；不生成新的持久派生图片。

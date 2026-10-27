---
document_type: protocol-contract
contract: member-avatar-v3
authority: member-avatar-assets
status: accepted
version: 3
last_updated: 2026-10-15
---

# Member Avatar v3

继承 [v2](member-avatar-v2.md) 的单一 avatar 结果和 v1 的受控资产、导入、资源限制与渠道职责。
本版只将 Agent 对旧上传头像的读取统一为源图与原取景；完整 shape 继承
[Built-in Transport v41](builtin-tool-transport-v41.md)。

## Agent 头像读取

每次授权的 get 从同一身份快照取得头像引用，返回一个必需的 `avatar` 对象。

| status | path | displayCrop |
| --- | --- | --- |
| available | 当前 Run 私有临时目录中的一个非空绝对文件路径 | 所有受管 schema 1/2/3 为保存的取景；内置为 null |
| absent | null | null |
| unavailable | null | null |

absent 仅表示没有设置图片引用；UI 继续使用默认首字头像。unavailable 表示引用、文件校验或物化失败，
不能替换为 absent，也不阻断身份及版本读取。显式选择的内置头像正常读取时为 available。
未知状态、额外字段、available 无路径以及失败状态携带路径／取景均不符合输出 Schema。

| 资产 | 唯一物化内容 | 取景 |
| --- | --- | --- |
| schema 1/2/3 | source.png／source.gif 的临时副本 | displayCrop 与该源图保存的 iconCrop 相同 |
| 内置 | 当前 UI 使用的 packaged icon | displayCrop 为 null |

displayCrop 是封闭三数值对象：centerX、centerY 相对方向处理后的宽高，范围 0–1；size 相对短边，
范围 0.12–1；源资产读取时仍验证裁切区域合法。元数据描述显示区域，path 不保证是物理裁切后的文件。

旧上传头像的取景不重置居中，读取和只改裁切参数的修改始终参照同一源图。旧源图仍按旧资源预算校验；
源图不可用时即使 icon 完好也返回 unavailable，不降级到坐标参照不同的小图。

读取最多写一份头像副本，不再物化 portrait；GIF 原有动画内容保留，不逐帧裁切、缩放或编码。
文件写入失败清理本次未完成文件；生命周期继续绑定既有 Run lease，跨 Run 重新授权、重新物化。
受管引用、永久资产路径与 base64 不进入该 Agent 结果。

## 兼容

新输出不提供 icon/portrait 别名或双写。既有历史回执保留；不改变 Session 恢复、数据库或资产 schema。
内部 source、旧裁切与确定性重试入口继续保留；此处删除读取字段不授权删除旧源图。
Desktop/Web 资产读取、用户资料、导入与渠道静态导出沿用 v1；旧 UI 与渠道继续读取已裁好的 icon，
不把 Agent 的 displayCrop 叠加在 icon 上。内置头像保持原读取／修改行为；不生成新的持久派生图片。

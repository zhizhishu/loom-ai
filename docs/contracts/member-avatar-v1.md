---
document_type: contract
name: Member Avatar
version: v1
status: accepted
source_version: v1.72
last_updated: 2026-10-14
---

# Member Avatar v1

本合同拥有队员头像的导入、受管资产、显示取景及静态渠道导出。界面见
[队员身份](../ui/components/member-identity.md)，决策见 [V1.72-D42](../versions/v1.72/decisions.md#v1-72-d42)。
不改变 Runtime、身份字段、Memory、成员关系、创建导航或当前用户个人资料的独立保存合同。

## 引用、资产与兼容

`avatarRef` 继续只接受 `rovai://member-avatar/builtin/{role}/v1` 与
`rovai://member-avatar/managed/{uuid}`，不能输入任意路径或远程 URL。Profile 不增加半身照字段。
先原子物化不可变受管资产，再由既有版本检查命令提交引用；未提交或替换资产不在本轮自动回收。

| 资产 | 读取与保存 |
| --- | --- |
| 新 schema 3 | `manifest.json`、一个 `source.png` 或 `source.gif`；无 `icon` 项或 icon 文件 |
| 旧 schema 1 静态 | 沿用已保存 `icon-192.png` 和原取景，source 保留 |
| 旧 schema 2 GIF | 沿用已保存 `icon-192.gif`，保留动画、原取景和 source |
| 内置 | 使用现有 packaged icon，UI 不加载独立半身照 |

schema 3 沿用 `source` 的尺寸、MIME、字节数、SHA-256、方向/隐私处理标记和 GIF 帧数；循环语义保存在文件内；
`iconCrop` 记录 `centerX`、`centerY`（相对宽高）和 `size`（相对短边，0.12–1）。字段命名保留读取兼容。
新资产的 icon rendition 返回同一文件和可选 `displayCrop`；旧资产不带 `displayCrop`，防止二次裁切。
缺失、损坏、hash/尺寸不符、安全路径失败均拒绝读取，UI 只显示身份 fallback。
Agent 的旧确定性创建/修改请求重试验证旧 source/crop 并返回同一 ref，不重写为新格式；
旧 GIF 显式取景先按旧规范化尺寸夹紧，避免缩放舍入导致相同请求冲突。

旧 `raster`、`gif`、`recrop` 保存协议和共享图片函数保留兼容；新 Desktop/Web/Agent 导入只走单文件路径。
旧 Agent `member.get` 的图像物化字段保留；新资产两种兼容读取均指向同一份头像内容。
历史入队回执仍读取创建快照引用，不改读当前 Profile，不删除历史源文件。

## 导入与限额

Desktop 与 Web 选择 PNG/JPEG/GIF；静态输入完成方向处理、隐私元数据清理和最大边 2048 的规范化，
经 `memberAvatars.save {kind: "image", sourceBase64, sourceWidth, sourceHeight, crop}` 提交。
TypeScript 桥对应 `source: Uint8Array`。Core 重新验证尺寸、内容和取景，输出规范 PNG。
Agent `--avatar-file` 由 Core 读取当前 Run 可访问文件，调用相同单文件发布器，默认居中最大正方形。
不要求生成渠道图、小头像或半身图；推荐 512/1024 方形头像仅为生成建议。

- 原始上传最大 10 MiB；尺寸至少 1×1，最大单边 8192、总像素 3200 万。PNG 拒绝 APNG；拒绝格式伪装和损坏。
- 静态受管输出最长边 2048，最大 16 MiB。PNG 的 IEND 尾部厂商数据仅上传入口兼容并清除，受管读取严格。
- 新 GIF 最大单边 1024、单帧 1,048,576 像素、最多 200 帧、逻辑画布像素×帧数不超过 3200 万，仍受 10 MiB 上限。
- GIF 必须扫描结构并逐帧有界解码验证；保存只复制允许的渲染块，清理评论/私有扩展，保留帧时长、透明度、处置和循环。
  不合成全部帧，不逐帧裁切或缩放，不重新编码动态图片。读取新资产核对 hash、结构和元数据，
  不重复完整解码；渠道导出只解码第一帧。超预算明确拒绝，不自动压缩或降帧。
- 旧 GIF 保持原有读取资源预算，不把新上传显示预算当迁移条件。资源测试证据见
  [当前实施记录](../versions/v1.72/implementation-plan.md#队员头像简化2026-10-14)。

## 取景与保存

取景默认 `centerX=centerY=0.5, size=1`；用户上传后在 Dialog 拖动、缩放、方向微调、重置并确认。
方形边长为 `min(width,height) * size`，左上为 `(centerX*width-edge/2, centerY*height-edge/2)`，
取景必须在图内。各内部头像按同一比例/偏移显示文件，再加圆形或圆角遮罩，不改写图像。
主保存才提交 Profile。取消未确认取景不修改原头像和已确认草稿；文字/头像部分成功沿用原有独立命令语义。

## 渠道静态导出与重试

`memberAvatars.read {avatarRef, rendition:"icon", staticPng:true, targetEdge?}` 从已验证文件生成 PNG。
`targetEdge` 默认 192，整数 1–512，只允许搭配 `staticPng:true`。新静态图直接解码；GIF 只取第一帧，
按帧偏移合成到完整透明画布，再使用保存取景。旧 icon 已有取景，不再次套用 crop。
取景几何四舍五入到像素并夹紧边界；按目标尺寸缩放，输出方形 PNG，不烘焙圆形遮罩、不落盘第二份动态文件。
飞书/Lark 使用 192；钉钉新受管头像直接生成 240，内置 192 继续沿用现有适配器缩放。

Main 在远端发布 mutation 前读取、验证和导出。按既有 publication intent ID 与尺寸将静态结果冻结到
Core data 下 `member-bot-avatar-exports` 私有目录；原子首次写入优先，记录内容、尺寸与摘要，重启重试直接读取。
飞书/Lark 的空 ref 冻结“使用渠道默认头像”的选择。钉钉要求图片，空 ref 在冻结前失败，补图后可在同一 intent 重试；
已有可用快照优先于当前 ref，即使当前已移除头像也不改变此次封面。
更换本地头像不替换正在发布的冻结封面；新发布意图才取当前图。
快照损坏/读取失败使此次发布失败，不回退读取较新的头像，也不改本地文件或引用。
沿用既有 Provider 发布/更新/重试边界，不新增自动同步、选帧或用户可见的快照管理；无数据库迁移。

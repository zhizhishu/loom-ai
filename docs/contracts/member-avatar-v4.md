---
document_type: protocol-contract
contract: member-avatar-v4
authority: member-avatar-assets
status: accepted
version: 4
last_updated: 2026-10-15
---

# Member Avatar v4

继承 [v3](member-avatar-v3.md) 的完整读取 shape、受管源图与取景、资源限制及兼容边界。
本版替代 v3 中“内置头像保持原修改行为”的条款，修复内置头像 crop-only 更新的坐标参照。

## 内置头像裁切

内置头像的 Agent get 仍返回当前 packaged `icon-192.png`，`displayCrop` 为 null，表示完整方形头像。
未提交新文件、仅提交裁切参数时，坐标必须作用于这张相同的 packaged icon，不能改读保留的大图。
修改产生一个 schema 3 受管资产：以该 icon 为源图，保存确认后的取景，不派生新的小头像。
再次读取、修改和静态导出均沿用该源图及取景；恢复完整取景显示原内置头像，不累积物理裁切。

裁切不改写共享内置文件，也不改变其他仍引用内置头像的队员。放大清晰度受 192px 源素材限制；
不通过切换到另一张大图补偿。未修改内置头像的显示与渠道发布、保留的大图、旧上传资产均保持。

## 版本与验证边界

输入、返回字段、CLI help、Skill、Bootstrap、Dynamic Context、授权、版本冲突与幂等回放不变。
Transport/CLI 41、Agent Output 14、IPC 3、Envelope 2 与资产 schema 1/2/3 保持；无需迁移或重建上下文。
这是裁切命令的底图选择修复；member get 的读取选择、结果序列化与字段解释保持。
回归须验证根据 get 返回图片选择的非居中区域与实际静态导出的像素一致，并覆盖再次修改和完整取景恢复。

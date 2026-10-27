---
document_type: contract
contract: file-preview
version: 17
status: accepted
authority: desktop-shared-workspace-tabs
last_updated: 2026-09-20
---

# File Preview v17

继承 [v16](file-preview-v16.md) 的文件来源、句柄、恢复、读取、路径授权和 Command View 规则。

Camp 右侧工作区的标签集合新增合成 `execution` 标签，与 Mission 的 `activity` 和普通文件标签共用同一
选择、关闭、键盘和分栏宿主。`execution` 只承载 [Run Process Detail Surface v35](run-process-detail-surface-v35.md)
的执行台 DOM，不创建文件 source、preview handle、restore candidate、Viewer 或文件搜索状态。

Activity、Execution 与文件内容共用一个 Camp 预览 pane 比例。切换当前标签、按进入规则自动打开 Execution，
或从标题入口在 Activity/Execution 间切换，均不得重置或改写比例。只有用户拖动、键盘调整或双击分隔线继续
按既有规则提交比例。关闭合成标签不关闭其他标签，也不清除文件 Tab、阅读位置或 Mission Activity。

Mission 先创建 Activity；有 running Run 且执行位置为 `right` 时再创建并选择 Execution，因此 Execution 的
当前显示优先于 Activity，但 Activity 仍可直接切回。普通 Camp 没有 Activity，Execution 与文件使用相同规则。

## 验收

- 合成 Execution 标签不调用文件解析、句柄或读取 API；
- Activity、Execution、普通文件来回切换时分栏宽度保持一致；
- 关闭或移走 Execution 不影响文件与 Activity 标签状态；
- Mission 进入时 Activity 仍存在，有 running Run 的右侧位置最终选择 Execution。

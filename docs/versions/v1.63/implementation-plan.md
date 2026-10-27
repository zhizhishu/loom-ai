---
document_type: implementation-plan
version: v1.63
lifecycle: historical
authority: version-implementation-plan
status: completed
last_updated: 2026-09-22
---

# v1.63 实施与验收

范围见[版本概览](README.md)，字段级行为见 [Durable Task v4](../../contracts/durable-task-v4.md)、
[Built-in Tool Transport v31](../../contracts/builtin-tool-transport-v31.md)和
[Host Web v3](../../contracts/host-web-v3.md)。

## Gate 0：版本与确认

- [x] 从最新 `origin/main` 建立 v1.63，冻结 v1.62 并完成九范围影响记录。
- [x] 发布模型输入前后全文，记录开发者对 revision 1 的二次确认。
- [x] 冻结 Durable Task v4、Built-in v31、Agent Output 4、Host Web v3（HTTP protocol 3）、Charter 12 与
  schema 117 的原子 cutover。

## Gate 1：Task 数据与领域语义

- [x] Migration 167 只把 Task description 上限从 8000 扩为 16000，保留历史列和所有 Task identity/version。
- [x] create 固定写空历史数组；所有当前 read model 合成公开正文且不写库、不增加版本。
- [x] 相同合成正文提交保持原始存储；不同或空正文在 expected-version CAS 中清旧列。
- [x] title/status/assignee/outcome-only 更新不触碰历史列；terminal 与权限约束不变。

## Gate 2：Transport、Host 与 UI

- [x] 当前 Rust/JSON/CLI/Tool/Desktop/Web 输入和输出删除旧字段，闭合 schema 明确拒绝旧字段。
- [x] `team.get_task` 只投影七个基础字段和匹配当前状态的说明。
- [x] `rovai task --help` 以 0 返回固定四项索引，其他 family 行为不变。
- [x] Host reconciliation 对旧 Task payload 直接拒绝且不 dispatch；当前请求、receipt 与 Replay 路径保持单一。
- [x] Renderer 只显示/编辑“责任范围与要求”，历史 Task 通过合成正文无损显示。

## Gate 3：Agent 指导与验证

- [x] Session Charter revision 12、bundled `cli-operations` Skill 与 Task reference 使用新的帮助路由和单正文语义。
- [x] Rust 定向/全量、Migration、CLI、Renderer/TypeScript、Node、Skill、文档、格式和 diff-aware 门禁通过。
- [x] 功能分支通过 PR 与 required checks 合入 `main`。

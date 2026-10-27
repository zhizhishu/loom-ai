---
document_type: implementation-plan
version: v1.66
authority: version-implementation-and-acceptance
status: completed
last_updated: 2026-09-22
---

# v1.66 实施与验收

## 实施切片

1. 在 Execution Evidence 规范化完成后建立 `PersistableResult`，按封闭来源优先级提取普通输出、错误与 digest，移除
   全文别名和 Core Envelope result，再按 7,680 UTF-8 字节保存。
2. 将 `CompleteSnapshot | OrderedDelta | MetadataOnly` 作为生命周期归约显式输入；完整快照替换并重算，连续 delta
   只追加剩余预算，元数据更新保留文本与标记。
3. Migration 170 新增 nullable `agent_run_execution_evidence.output_truncated`，贯通 read model、窗口、详情 RPC、实时事件和
   TypeScript 合同；历史 NULL 不默认成 false。
4. Renderer 对丢失输出使用“结果”读取文案，并在结果下显示“结果过长，部分内容已省略。”；结构化 diff、输入、附件与文件入口保持独立。
5. 以已有 `execution_evidence` owner 测试和 `ExecutionToolGroup` owner 测试扩展验证，不建立重复集成测试 owner。

## 验收矩阵

| 验收项 | 证据 | 状态 |
| --- | --- | --- |
| UTF-8 字节边界、显式空结果、来源优先级与共享错误预算 | `persistable_tool_result_uses_closed_updates_and_a_utf8_byte_budget` | 通过 |
| 三态替换/追加/保持与历史 nullable marker | lifecycle reducer、Migration 170 与 `slow-tests` 历史关联回归 | 通过 |
| 第 7,680 字节后标记不在 SQLite、result Blob、事件或详情中 | `evidence_is_durable_blob_backed_agent_inaccessible_and_cancel_fenced` | 通过 |
| 同次结构化 diff 与 Files Changed 事实仍可读 | lifecycle/file-fact 联合回归 | 通过 |
| Renderer 固定提示且不承诺全文恢复 | `ExecutionToolGroup.test.tsx` 与 Built-in digest 关联测试 | 通过 |
| Rust、TypeScript、文档和静态 UI 门禁 | `cargo test --workspace`、`pnpm typecheck`、`pnpm test`、`docs:check:ci` | 通过 |

## Rust 测试准入

本版只扩展 `execution_evidence.rs` 已有的生命周期/Blob owner 测试和数据库 migration owner；新断言覆盖新的持久化
边界、三态与 nullable 字段，无法由既有断言表达且没有建立重叠 fixture。Renderer 同样扩展现有 Tool disclosure owner。

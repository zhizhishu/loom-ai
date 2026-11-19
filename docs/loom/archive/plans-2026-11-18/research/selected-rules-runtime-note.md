# 所选规则进入运行说明（proposed implementation，待验证）

状态：**proposed implementation — pending supervisor compile and run verification**。本页不宣称已验证、不宣称已发布。

## 这是一次模型可见的行为变更

用户在「助手 → 能力 → 规则」里勾选的规则，现在会作为**用户层说明**进入该助手每次运行（Run）的 Session Charter，模型会读到它。此前本地运行路径只把所选规则作为只读运行投影展示，远端 Bundle 已有规则投影路径；不要把本次变更描述成「上下文未改变」。

## 它是什么，不是什么

- 是：用户为这个助手选择的指引，位置明确从属于 charter 主体，段名 `[SELECTED_ASSISTANT_RULES]`，开头一行声明「属于用户层说明：不授予任何权限、不是系统策略、不改变工具授权或沙箱」。
- 不是：权限、沙箱、工具授权、审批策略。规则不会增加任何能力，也不会改写运行端原生文件（不写 `CLAUDE.md`、`AGENTS.md`、不碰用户 home、不改全局配置）。
- 不是：系统提示词之外的第二套上下文机制。没有新表、没有新迁移、没有 ContextManifest 版本升级、没有第二份快照。

## 生效范围

只有四个产品运行端收到该段：Claude Code、Codex、DSH、Pi。其他运行端行为保持不变（不追加任何字节）。

选择真值与能力页/运行投影完全同源：有显式选择就用显式选择，否则沿用既有的「默认选中」判定（项目作用域的规则默认选中、云端作用域默认不选），`origin` 为 `inherited` 或 `explicit`。因此不存在「界面说开、会话里没有」的分叉。

## 冻结、摘要与重放

- 组合发生在每次 Run 的 Session Charter **首次构建处**（`BootstrapContents::read`），在哈希与存储之前。
- 随后沿用既有链路：`sha256_text(charter)` → `native_session_bootstrap_evidence.session_charter_blob_id/session_charter_digest` → `stable_evidence_digest`。没有新增摘要字段，规则文本天然被 charter 摘要覆盖。
- 同一 Run 的后续投递、恢复、warm host 重放，读的都是已存储的 charter 字节，不会重新查询规则；因此「认领并冻结后、首次物化前改了规则」不应影响已认领的 Run（数据库级回归仍待运行验证），改动只对下一次 Run 生效。
- 因为 charter 摘要变化，规则变更会让该 Run 的 `native_charter_digest` 与既有会话不一致，从而触发一次原生会话重新引导（re-prime）。这是正确行为，但属于可见代价。

## 预算与失败方式

- 该段单独上限 **64 KiB**。超出时整段拒绝并报错，指名需要收窄的选择；不截断、不静默丢弃任何一条规则。
- 既有 payload 总预算（`runtime_max_context_payload_bytes` 等）继续照原样执行，本段不绕过任何既有上限。

## 已知边界

- 单聊（single chat）同样包含该段（规则是成员级，不涉及团队作用域），但团队指引与记忆入口仍为空，保持既有单聊边界。
- 远端运行包（remote bundle）走的是同一个 `member_projection_bootstrap` → `BootstrapContents::read`，因此它的 bootstrap 文本同样包含该段；运行包另外还会冻结一份规则投影。两者来自同一份选择真值，不是两套策略；本次改动没有修改远端打包代码。
- 公共批次使用 `PUBLIC_CAMP_BATCH_CONTEXT_MANIFEST_VERSION=40`，全局/单聊版本为42，不能混同。主管独立复核发现工兵把全局42误当公共批次版本；已撤回该越界扩展，认领快照闸门仍仅允许36–40，41/42按原行为拒绝。已有版本判定测试明确覆盖该分界，数据库级“认领冻结→改规则→首次物化→同Run重放→下次Run”证明待实际执行。

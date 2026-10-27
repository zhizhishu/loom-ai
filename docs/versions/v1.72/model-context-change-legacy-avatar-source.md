---
document_type: model-context-change
version: v1.72
change_id: legacy-avatar-source
revision: 1
confirmation_status: confirmed
confirmed_revision: 1
confirmed_by: User
confirmed_at: 2026-10-15
confirmation_message_id: a35647ee-e584-406b-abbd-366501d3c5f6
authority: confirmed-model-input-change-statement
implementation_status: implemented
review_baseline: 50cbfdf98e2e387633677b4e1033c0181e1ceb45
last_updated: 2026-10-15
---

# 旧上传头像的读取与修改统一坐标参照

## 二次确认

User 消息 59 提议将旧上传头像统一为源图与裁切位置。公开回复
`3ca09cb7-ed40-4c3b-a464-32a536c613e1` 明确列出 path 为源图临时副本、
displayCrop 为原有取景、只调整 Agent 读取、界面及渠道保留旧显示、不迁移旧图片。
User 消息 61（上方 confirmation_message_id）随后明确要求“那你改完pr到main merge”。
本 R1 记录该已确认方案；不是以先前 R3 的确认代替本次授权。

## 变更前

`member get` 输入仍为封闭对象 `{agentId: string}`。成功输出全部字段必需，完整结构如下：

```typescript
type MemberGetResult = {
  agentId: string;
  displayName: string;
  teamRole: string;
  professionalResponsibilities: string;
  personalityTraits: string[];
  workingPrinciples: string;
  growthTopic: string;
  version: number;
  avatar: {
    path: string | null;
    status: "available" | "absent" | "unavailable";
    displayCrop: { centerX: number; centerY: number; size: number } | null;
  };
};
```

| 资产 | avatar.path 的文件内容 | avatar.displayCrop |
| --- | --- | --- |
| schema 3 | 受管 source.png / source.gif | 保存的 iconCrop |
| schema 1/2 | 已裁好的 icon-192.png / icon-192.gif | null |
| 内置 | packaged icon | null |

只提交裁切参数的修改以保存的 source 为参照；旧读取因此未提供同一底图和原取景。

## 变更后

完整输入与输出 shape 保持上文不变；只改变 schema 1/2 可用头像的文件内容与取景语义。

| 资产 | avatar.path 的文件内容 | avatar.displayCrop |
| --- | --- | --- |
| schema 1/2/3 | 受管 source.png / source.gif 的一个 Run 私有临时副本 | 该源图保存的 iconCrop |
| 内置 | 原 packaged icon | null |

centerX / centerY 相对源图方向处理后的宽高，size 相对短边（0.12–1）；
旧取景原样返回，不重置居中、不再按 192 小图解释坐标。
available 必有路径；源图缺失、损坏、验证失败或物化失败返回 unavailable、path/displayCrop 均为 null，
即使旧 icon 仍存在也不回退小图。无引用仍为 absent；两种失败均保留完整身份和版本。

每次最多写一个私有临时文件，GIF 保留源文件动画字节，不为读取裁切、缩放或重编码。
沿用旧源图的资源校验，不以新上传显示预算拒绝既有合法资产。

## 明确不变

Bootstrap、Dynamic Context、身份投影、member list、Skill、CLI help 文本和输入参数保持；
共享裁切、create/update 授权、CAS、幂等及事务保持。内置头像未纳入旧上传头像统一。
不更改 Desktop/Web 的 rendition 语义和渠道静态导出，不删除 source/icon，不重写历史或迁移资产。
同一身份快照、受管引用校验、Run lease 生命周期、路径脱敏及完整输出摘要规则保持。

Member Avatar v3 与 Built-in Tool Transport v41 记录后继语义。
Transport/CLI 40 → 41，Agent Output 13 → 14，capability 改为 builtin_cli.transport.v41；
IPC 3、Envelope 2、资产 schema 1/2/3、数据库与 Context 各轴保持。
原 v13 JSON golden 继续拥有未变化的字段 shape，不复制同一 fixture；旧结果字节保留。

## 验证计划与冻结标准

扩展既有 owner，不新增平行 Rust 测试：
- member_avatar 静态与 GIF owner：旧源图字节、非居中 crop、按返回坐标修改后的区域、动画、
  单个临时文件及源资产不改写；旧 UI / 渠道仍读取原 icon，避免二次裁切。
- member 读写 owner：旧头像通过 get 返回完整源图与取景；坏源图不回退 icon，
  身份仍可读；现有授权、版本冲突、幂等、部分失败和未配置状态继续验证。
- CLI / 输出合同 owner、默认 workspace、格式、文档治理。

模型专项冻结为四个成对场景：旧静态读取、旧 GIF 读取、旧静态按原图坐标再次调整、旧源图缺失。
使用 Claude Code → 当前 sub2api 配置，记录实际模型回执；每场景每版一次、每 Run 240 秒，
不更换模型以追求结果。期望候选读取完整源图和旧 crop，取景修改落在指定区域，
缺失源图诚实报告不可用；保留基线的所有失败，不将专项当作通用 Gate。

通用 Gate 沿用 qualification/context-regression 的 12 Case、每版一次、原规则与评分；
执行预算 14,400 秒，最多两次尝试。独立冻结 main 基线与候选产品；
先检查合同与环境，完整保留基线失败和未启动槽位。既有 Gate 缺口不算通过，
不修改无关数据库 owner 或冻结标准以取得绿色结果。当前已获 PR 与合并授权；
合并报告明确区分相关回归、真实模型专项、CI 与通用 Gate 结果。

## 实施与验证结果

实现仅改变 Agent 头像物化分支：受管 schema 1/2/3 读取 source 与保存的 crop，内置仍取 icon。
共享 UI/渠道读取与写入逻辑未修改；源图失败不回退到旧 icon。Transport/CLI 41、Output 14，IPC/Envelope 保持。
未新增、删除或禁用 Rust 测试，扩展原静态/GIF和成员读写 owner；v13 JSON golden 复用。

- 默认 workspace：471 通过、0 失败、1 原有 ignored。
- 定向 owner：头像 14、成员读写 1、CLI/lease/输出 29 全部通过；格式与文档治理通过，文档单测 10 通过。
- Claude Code 2.1.287 经 sub2api：新旧各四场景、共八个 Run，实际模型均为 gpt-6.1-sol，全部 succeeded 且工具证据完整。
  候选正确读取旧 PNG/GIF 的 400×500 源图和非居中取景；一次 crop-only 修改得到右下 200×200 区域，
  size=.5 保持，源图字节不变。缺源图时 unavailable，身份完整。
  基线返回 192×192/null，调整时先误设 size=1，随后从旧记录恢复再改为正确取景（两次写入）；
  第二次走既有静态规范化导致 PNG 字节变化，独立核对像素相同。缺源图但 icon 尚在时基线仍报告 available。
- 两处测试夹具错误（采集器的 source 文件属性、旧 GIF 的 RPC 参数名）已修复，保留原日志和已完成 Run，
  只续跑未启动场景；没有重跑模型挑选结果。缺源图场景会删除其内容寻址源文件，先前场景的哈希在各自 Run 后已采集。
- 通用 12 Case Gate：新旧各 25 条合同命令中 23 通过、相同两项失败：
  current_schema_contains_required_contract_objects、v172_preserves_historical_context_rows_and_gates_new_writes。
  report 为 degraded，candidate_contract_failure.newRegression=false；24 个模型槽位均未启动，56 项证据缺口，
  Judge 未配置，因此无完整语义评分。没有把专项、相关单测或 CI 视作完整 Gate 通过。

完整摘要见 [验证索引](legacy-avatar-source-verification.json)。原始对照、夹具失败日志与 Gate 报告保留于
Thread 附件 LegacyAvatarSource-ClaudeCode-sub2api-20261015.zip。日常数据未修改，隔离 Core 已退出，临时凭据副本已清理。



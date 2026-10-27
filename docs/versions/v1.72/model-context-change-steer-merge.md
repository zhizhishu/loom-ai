---
document_type: model-context-change
change_id: steer-merge
revision: 1
confirmation_status: confirmed
confirmed_revision: 1
confirmed_by: User
confirmed_at: 2026-10-15
confirmation_message_id: 39593972-ab12-40bd-9f4a-a62d6aaaacea
implementation_status: implemented
version: v1.72
authority: model-context-change-comparison
last_updated: 2026-10-15
---

# Steer 合并主线：紧邻前后对照

User seq40 已授权合并和收口。基线：Mission 064 `b8349985`，合入 main `d6ae891f`。
最终再同步 main `2d4c61af7` 的日期标记及锚点作者读取；这两项仅影响读取和界面，不改变以下模型投影。
本次新增的版本准入、TRAE 和恢复处理不增加提示词。唯一模型投影差异来自已经在主线确认的
[发送者统一](model-context-change-message-senders.md)，普通消息与 Steer 同步采用。

## 变更前

比较对象为上述两条已获授权实现的代码线；不是重新提出一套模型输入。

## 变更后

下面每项把前后紧邻放置，避免跨页对照。

### 1. 用户消息发送者

合并前（仅示意相关字段）：

```json
{"messageId":"msg-103","senderType":"user","senderId":"local_user","body":"请采用这条更正。"}
```

合并后：

```json
{"messageId":"msg-103","senderType":"user","senderId":"user","body":"请采用这条更正。"}
```

消息 ID、正文、提及、引用、附件及 Skill 链接继续用既有结构。内部 authorId 不改；只有模型投影
按主线统一 user 身份。普通发送和 Steer 不分叉。

### 2. 历史中的队员发送者

合并前：

```json
{"senderType":"agent","senderId":"agent_1","body":"已完成检查。"}
```

合并后：

```json
{"senderType":"agent","senderId":"agent_1","senderName":"爱丽丝","body":"已完成检查。"}
```

这是主线已有的名称投影；系统消息投影为 system／system／null。新生成上下文使用当前发送者规则，
已保存的历史上下文不补字段、不重算正文或摘要。Agent 消息仍不支持 Steer。

### 3. RUN_INPUT 消息选择

合并前：第一次投递只包含 msg-101；随后两次插话分别只包含 msg-103、msg-104。

合并后：第一次投递只包含 msg-101；随后两次插话分别只包含 msg-103、msg-104。

没有累计重发初始消息，也不夹带普通 waiting 队列。统一 Builder／Formatter、历史提示和动态区段
原文保持 [R3](model-context-change-steer-shared-input.md) 已确认内容。

### 4. 内部格式身份

合并前：分支 public 37／14／10；主线 public 38／13／9、non-batch 37／12／6。

合并后：新 public 39／14／10；non-batch 37／12／6；旧记录保持原元组。

这些版本不进入模型正文。最终合入使用 Migration 204，依据已知结构识别两种 199 及两种 203，不以新格式重新渲染旧输入。
没有快照教学、Steer 指导、技术标签或专属裁剪规则需要 Agent 理解。


## 明确不变

不新增 Steer 指导、快照解释、标签和裁剪规则；不改消息正文、授权、初始 claim 或历史最终载荷。

## 二次确认

发送者投影已由 User 在主线 R2（消息 `728a1602-fe39-4a19-b835-2344b1676f77`）确认；
Steer R3 已由 User 消息 `52de18ca-e5df-4c91-b2a7-ee998f8068b0` 确认。
本线程 User seq40“行 那你都开始做吧”授权合并及收口。本说明记录两项已确认语义的合并，
不借此次授权扩张新的模型提示词或投影内容。

## 验证

共同消息投影与初始 Manifest 不变性由 delivery_queue 的既有共享上下文测试验证；迁移保留所有原始字节。
合并后真实 Runtime 输入按每个 Delivery 的 raw_message_refs 核对。完整验收结果另列收口报告。

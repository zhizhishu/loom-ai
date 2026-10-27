---
document_type: protocol-contract
contract: builtin-tool-transport-v40
authority: builtin-tool-transport
status: accepted
version: 40
last_updated: 2026-10-14
---

# Built-in Tool Transport v40

继承 [v39](builtin-tool-transport-v39.md) 与 [Camp History v13](camp-history-v13.md) 的当前输出。
Transport/CLI **40**、Agent Output **13**、capability `builtin_cli.transport.v40`；IPC **3**、Envelope **2**
保持。Core/CLI 配套发布，旧 CLI 在 dispatch 前按现有版本门拒绝，不改变 Native Binding 恢复资格。

## 成员详情

`member get` 输入仍为封闭对象 `{agentId: string}`，agentId 非空；不增加头像读取参数。
成功结果为以下封闭结构，全部字段必需：

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

version 为至少 1 的整数。八个身份／版本字段保持完整，不截断职责，不删除已保存的可选设定。
移除 `images`、`imageStatus` 及 icon/portrait 双图片分类；头像状态和路径的组合约束见
[Member Avatar v2](member-avatar-v2.md)。旧历史结果保留原字节，新调用只接受新结构。

`member list` 仍为 v39 的当前 Thread 四字段列表，完整管理资料继续由 `rovai app member list` 提供。
目标授权、同 Thread 创建者例外、create/update 的确认、版本、幂等及事务边界不变。
有界操作证据投影仍只记录原有标识与版本，不记录头像文件路径；原始输出摘要绑定完整新结果。

## Help

list 保持：`List current Thread members, team roles and the default Lead.`

get 的完整说明为：

```text
Read a member's full identity, version and avatar file path.
Target a current Thread member or one you created in this Thread. The avatar path lasts for this Run; avatar.displayCrop describes its saved framing.
```

cli-operations 继续指导按需获取相关队员的完整身份，不默认遍历所有成员；使用单数 avatar。
Bootstrap、Dynamic Context、身份投影、Skill 触发和用户界面不因此变更。

---
document_type: protocol-contract
contract: builtin-tool-transport-v39
authority: builtin-tool-transport
status: accepted
version: 39
last_updated: 2026-10-13
---

# Built-in Tool Transport v39

继承 [v38](builtin-tool-transport-v38.md) 以及 [成员操作 v36](builtin-tool-transport-v36.md)。
Transport/CLI **39**、Agent Output **11**、capability `builtin_cli.transport.v39`；IPC **3**、Envelope **2**
保持。匹配的 Core/CLI 一起发布，版本不匹配在 dispatch 前失败。此版本不参与 Native Binding 恢复资格。

## 成员列表与详情

`member list` 保留原输入和当前 Thread 范围，返回：

```typescript
type MemberListResult = {
  threadId: string;
  items: Array<{
    agentId: string;
    displayName: string;
    teamRole: string;
    isDefaultLead: boolean;
  }>;
};
```

条目恰好四字段，Schema、SQL 投影、成功输出均不含职责或替代值。原排序、self/away、leave-requested/
left/removed 处理和 Lead 派生保持，不因读取设置 Lead。用户管理的 `rovai app member list` 仍返回完整资料。

`member get` 输入及完整结果保持 v36：agentId、displayName、teamRole、professionalResponsibilities、
personalityTraits、workingPrinciples、growthTopic、version、images、imageStatus。职责返回完整已保存文字；
不截断、摘要或改为文件引用。图片保留当前 Run 临时路径及三态语义，不暴露内部资产引用或永久路径。
原当前 Thread 目标范围、同 Thread 创建者例外、写入用户授权/版本/幂等/原子性不变，不新增字段级权限。

## 职责写入

UI、Core、member create/update、用户管理与既有复制/导入路径共用以下规则：先按 ECMAScript String.trim
去除首尾空白，再接受 0～10,000 Unicode scalar values；保留内部换行与格式，不做 Unicode 合并。
U+FEFF 属于首尾空白，U+0085 不属于；组合字符逐 scalar 计数。空字符串清空、null 非法。
超长整次失败，统一消息为 `专业职责最多 10,000 个字符。`，不部分更新、不自动截断。旧已存文字不迁移。
其他身份字段上限保持。create 默认空字符串；update 省略则保留，原本没有 default。

## Help

- list: `List current Thread members, team roles and the default Lead.`
- get: `Read a member's full identity, version and image paths.` 下一行为
  `Target a current Thread member or one you created here. Image paths last for this Run.`
- create/update 职责参数：`Up to 10,000 Unicode scalar values after trimming. Use "" to clear. For long or multiline text, use --input-file with a UTF-8 JSON file.`

按需 get 相关候选者的使用指导在 cli-operations；不默认逐个读取全部成员。member-studio 只调整职责上限、
团队角色说明和写法，保留原用户原文处理及职责 1～3 句生成建议。

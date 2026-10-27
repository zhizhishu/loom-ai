---
document_type: contract
contract: context-delivery-profile-v14
status: accepted
target_version: v1.72
last_updated: 2026-10-14
---

# Context Delivery Profile v14

继承 [Profile 13](context-delivery-profile-v13.md)，新 public 输入冻结
`{"profileVersion":14,"maxSelfActiveTasks":8}`，配对 [Manifest 39](context-manifest-evidence-v39.md)（历史分支配对 37 保留）。
非 batch Profile 12 和历史 Profile 不变。

普通启动的 FIFO 领取预算和 claim 快照保持。Steer 也使用相同动态 Builder、完整消息投影和最终
UTF-8 容量判断，只将本次 Delivery 作为来源；不合并已有普通 waiting 队列，不重新计算启动批次。
任务省略、单条超限、附件可达性、引用授权和 Skill 可用性沿普通规则，不删除正文或附件以强行投递。
实际 Bootstrap 补发条件保持，不因 Steer 强制补发；工具、权限、执行路径和 Bootstrap 不随新输入扩张。
已物化输入恢复原字节，新输入正常读取最新动态事实。

---
document_type: research-report
authority: observed-minimax-code-real-model-acceptance
status: partial-verification
last_updated: 2026-10-16
---

# MiniMax Code：真实模型、开发 App 与最新差异

User seq10/11 授权使用真实 MiniMax 额度、官方 Provider 配置接 Sub2API，并保留开发界面。
本轮为 **mcode 0.6.12 / macOS arm64 / 生产 Core + 真实 Electron 开发 App**；不是脚本模型。
分支 `rovai/minimax-code-acp`，实现基线 `02e38cfbf55c230b72007931025f252b3f8310fe`。
本报告覆盖前轮“真实账号未生成”“图片理解未验”“Renderer 未验”等缺口；前轮
[19 Runtime 全量审计](full-parity-2026-10-16.md)仍保留当时的固定事实，不把旧结果改写成新测试。

**结果：Preview 接入可用。真实主路径、文本/图片 Steer、原生文件操作、MCP、手动 compact 后冷恢复已通过。
仍不晋升 First-Class；自动阈值/overflow 压缩、跨 Session 并发/LRU、完整故障与平台矩阵未全部完成。**

## 本轮环境与认证

- 独立 `pnpm dev`，独立 `userData`、Skill Library、MCP 文件；日常 Rovai App 保持运行。
- 原生免费账号使用官方 `~/.minimax`，模型为 `MiniMax-M3.1-Flash-Preview`。只复制登录文件到临时 Home
  的初次尝试失败：官方凭据命名空间包含 authHome 摘要。随后使用真正的原生 Home，生成成功。
  认证刷新由 mcode 执行；没有重写或伪造 OAuth 命名空间。
- 在本机既有 Sub2API 配置中读取 endpoint/key，经官方 `mcode provider add --api-key-env` 配置
  `custom_provider:sub2api-rovai`，协议 `openai-responses`、模型 `gpt-6`。先在独立 native profile
  做 connection test 和真实生成，再保存到原生配置；未使用 `--use` 修改日常默认模型。
  原 managed provider 内容不变，配置权限 `0600`；Rovai 产品仍只读取 MiniMax 原生配置。
- 开发 App 中也完成该 Provider 的显式选模和真实工具执行；不是只测 HTTP 连通性。
- 后续显式切回官方模型收到 `insufficient balance (1008)`，Core 正确归类为
  `runtime_quota_exceeded`。此后停止该账号测试，使用已验证的 Sub2API 完成剩余验收。
  保留失败 Run；开发界面最终选择 Sub2API，可继续交互。

官方配置依据：[MiniMax Provider 与中转说明](https://github.com/MiniMax-AI/minimax-code/blob/main/docs/examples.md)、
[Sub2API 官方项目](https://github.com/Wei-Shaw/sub2api)。密钥值没有进入仓库、报告或截图。

## 按接入清单更新结果

| 比较项 | 本轮真实结果 | 与其他 Runtime 的区别/边界 |
| --- | --- | --- |
| Auth/Provider/Model | 官方账号生成；Sub2API CLI + App 生成；显式模型由 Run 结构化事实核对 | 原生 `custom_provider`，不是另造 Rovai Provider；model ID 保留 provider/model/variant |
| System Prompt | `--append-system-prompt-file`；压缩与冷恢复后系统层 Charter 仍恰好一份，Bootstrap 内容摘要不变 | 接近 Claude 的原生 append 文件；Codex 在 start/resume 投递 developerInstructions；Pi/DSH 使用各自正式 System 接缝 |
| Host/冻结 | 普通连续 Run 观察到相同 Host instance；输入变化不更换 Host | 共享 Fleet，未添加私有池或冻结层；实际 Steer 后沿共享 `retire_after_steer` 回收 Host |
| Native Session | 开发 App/Core 重启、compact、Provider 选模和 MCP 撤销/恢复均保留精确原 Session ID、generation 1 | 与共享 ACP 精确 resume 一致；不按“最近会话”恢复，不因 Run 摘要变化建新 Session |
| 模型默认 | 从 Sub2API 切回 `runtime_default` 后，原 Session 仍选择 gpt-6；显式选 MiniMax 才真正切换 | 默认是原生 Session 决策，不是“重置为配置文件全局默认”。遵循共享实际模型观测合同，不推测或偷偷重置 |
| Compact | 官方 ACP `/compact` 成功：97→1 条消息，71,311→17,827 tokens；随后 App/Core 冷恢复，身份、历史、Skill、MCP 与 send 成功 | 手动命令由独立 native ACP probe 对同一闲置 Session 执行，不宣称 Rovai 已有 MiniMax 压缩按钮/执行台卡片；threshold、overflow+retry、失败/取消未验 |
| Skills | 实际 read 项目 `.agents/skills/.../SKILL.md`；更新 marker 后下一 Run 读到新内容，冷恢复也可读 | 证明项目发现/读取和更新子集；同名、删除、多根优先级与邻 Session 隔离仍待验，不把 shell 读取冒充完整 Skills v2 |
| MCP | 真实 stdio echo；compact/cold 后再次成功；撤销后 Manifest 不投影且模型报告工具缺席；重新分配后 echo 成功 | ACP per-Session 投影，不写用户 MCP 配置；完整 HTTP/同名/故障矩阵未验 |
| Command | 六次独立 bash：stdout、stderr、mixed、empty、nonzero 7、100 KB 输出 | 非零 Action 为 failed；大输出 Evidence 标注 truncated，持久化预览有限，不声称保存了全部 100 KB 或 stdout/stderr 独立通道 |
| Read | 原生 read、相对中文空格路径、Skill 与图片读取成功 | 路径观察不产生 Files Changed；图片走授权路径→原生 read→模型图像输入 |
| Write/Add | 原生新建、覆盖非空、写已有空文件；文件真实内容核对 | 新建为 add/operation-only；已有空文件是 update +1/-0；缺原生 patch 不编造 Diff |
| Edit/Diff | 40 行文件只改第 20 行；原生 patch +1/-1；点击 Files Changed，重启后再次打开核对 | 结果 patch 路线类似 Pi；不等同 Codex whole-turn 或 DSH 完整 before/after；不把行号预览当完整文件 |
| Narration/Final | 多轮实际 bundled `rovai send --public-only`，Core 读回消息与空 Agent recipients/deliveries | 遵循共享公开发送与终态归属，不能以模型回复出现 marker 代替脚本退出码或真实工具回执 |
| Steer | 文本和图片均为同一 Run/epoch，Runtime input accepted；图片数字与颜色/形状正确 | MiniMax 使用 `mcode/session/steer`；Pi 原生 `images[]`，其余已接图片 Steer 多为授权路径读取；其他 Runtime 本轮未重跑 |
| Usage | 长 Run 取得输入、输出、cache；短 Run 仍可能没有逐调用值；Context gauge 可读 | 原生 journal 异步采样，不拼造缺值/费用；不能将本报告 token 值当账单 |
| 权限/取消/故障 | 本轮账号额度错误正确归类；前轮受控 allow/deny/cancel 证据继续有效 | 不把本轮 bypassPermissions 下的工具成功算作真实交互审批完整验收 |
| Built-in CLI | Sub2API 真实模型完成既有 21 项；三条发送精确重读、旧 lease 拒绝、新 lease 与原 Session 续接通过 | 明确为既有 operation 回归子集，不再称旧版 22 项为当前全集；新 member/mission 等项不被该子集覆盖 |
| 平台/Fast | macOS arm64 Preview，其他平台未晋升；不接 Fast | highspeed 是原生模型名，不映射 Fast 开关 |

## 具体证据

- 开发 Thread：`rvcamp_01m52cmtmsfbgbwe4reaxpc759`，显示名 **MiniMax · 真实模型与文件验收**。
- Native Session：`mvs_5f813aaad46b4c14930d3a76c9b0bbce`，本开发 Thread 的所有成功恢复/选模保持该 ID。
- 原生文件 + 文本 Steer：Run `ab95e481-5ffa-4bc8-9270-f598125aa4b5`。
- 六类命令 + 真实 MCP：Run `52fea1ef-2a25-41da-9820-5507facdd020`。
- 图片 Steer：Run `dbba6fc5-5620-4353-8d08-2f53d87eabe7`；accepted 后 native read，
  正确答案 **731 / 蓝色正方形 / 红色圆形**，答案未写入输入提示。
- compact 后冷恢复：Run `5dd359fd-0334-4ab0-a843-21c7c2435fd1`。
- App/Sub2API + Skill 更新 + MCP 撤销：Run `3ddb2c79-4de0-4a29-85f7-6f14ee86532f`。
- MCP 恢复：Run `56d31568-23a8-4f08-a255-7ee3f330ee18`，实际模型仍为 gpt-6，不能把其
  `NATIVE_RESTORED_REAL_OK` 文本 marker 当作已切回官方模型的证据。
- 官方额度失败：Run `e4cf422b-d17d-41a4-b29e-ea58f08d6854`；Sub2API 恢复：
  Run `28549ad6-f79d-41a5-b66b-77cd68793275`。
- 结构化结果：[本轮脱敏 JSON](live-acceptance-2026-10-16.evidence.json)。界面截图作为 Thread 附件交付，
  本地开发 App 保留运行。历史失败与修正分开保存，不用重跑成功覆盖原始尝试。

## 失败尝试与归因

1. 复制 OAuth 文件到新 Home 失败，改用官方 native Home 后成功；没有要求 User 再登录。
2. MCP 初轮夹具忘记启用服务器；启用后的第一次模型回答仍称缺工具，随后真实调用成功。
   未仅凭“工具不在列表”的模型自述宣判 Adapter 不支持 MCP。
3. 两次图片尝试遗漏 intake 的 execution 字段，只发出了公共消息，没有 Steer Delivery；不计通过。
   修正后有 requestedMode=steer、accepted 回执、同 Run 原生读图与视觉答案。
4. 旧 CLI 脚本依赖已退役 composerDraft/Gather、旧 User 命名、冻结历史列表、旧发送文件语义及
   旧 Evidence Envelope。按当前合同修正；失败阶段、真实运行和最终结果单独记录。
5. 冷启动日志曾记录旧 Attachment View 完整性检查 incident；当前空 legacy View 已恢复 ready，
   generation 2、entryCount=0、lastError=null。SourceRef 图片读取与随后执行正常；不把该观察扩大成
   所有历史附件冷恢复均已通过。
6. 官方额度不足为真实服务失败，保留到 UI；没有自动重试、切换模型或新建 Native Session 来掩盖。
   后续 Sub2API 切换是本轮明确配置的验收操作。

## 回归与交付

真实 Built-in CLI 使用 contract-v41/ipc-v3，共 21 项既有子集，35 条 Core Evidence；
当前 29 项中其余 member list/get/update、thread runs、mission list/get/update/status 未由本脚本验收。
旧 Gather 已退役，不能继续计入操作全集。脚本要求自身退出与完成文件，不再凭模型复述 marker 判成功。
3 条 Send locator 在后继 Run 精确读回，两个 lease 均在结束后拒绝使用，逻辑及 Native Session 延续。

文档测试 10 项、全仓治理与 diff-aware 文档门禁通过；兼容性登记摘要校验通过。
Rust 默认库回归 427 项通过、0 失败、1 忽略。既有其他 18 款 Runtime 未再次消耗模型额度跑验收。

## 尚未闭合的完整资格

仍需按 [Runtime Integration Checklist](../../development/runtime-integration-checklist.md)补齐自动压缩阈值、
overflow/retry、并发与 LRU、多 Session 隔离、权限交互、MCP HTTP/冲突、Skills 完整矩阵、完整 CLI operation 集、
原生外部凭据热更新和其余平台。上述主路径成功不替代这些资格。

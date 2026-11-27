# LOOM 验收证据索引（2026-11-28 rebase 后，当前基线 `1ea3bff`（`m/integrate`），parent/base 链项 `2843cbe`）

> 目的：给 Hark 抽查用，索引现行 `LOOM-ACCEPTANCE.md` 与 `LOOM-IMPLEMENTATION.md` 最终验收表的证据。只列已在证据或交接中可定位的事实；无法确认的 commit/包不补齐、不猜测。
>
> 口径（2026-11-28 rebase 后）：`当前基线` 只有一条 —— `m/integrate` 已 rebase 到并正好等于 `1ea3bff821ec84e77d4f82a29b15aff5d1b957fa`（记 `1ea3bff`），它是今后 `cand/*` 分支的唯一基线；`2843cbe6fbed7c0b401dc39b375b8fa2911056f8`（记 `2843cbe`）只是它的 **parent/base 链项**，**不再与 `1ea3bff` 并列当当前候选**。原 `最新版` 的 `a4ea6da` / `loom/trial-a4ea6da`，以及 `8dc3366`、`9ba97a5`、`429ecd7`、`0f2fa68`、`aa6de92` 一律降为 `旧版`。
>
> `最终候选等同` 指在某候选验收且后续差异只涉及无关修复或文档；这不是逐比特同版重验。`旧版` 表示只在更早候选或源码树验过。证据路径多为验收执行机路径，非当前仓库文件。
>
> 判定规则：本轮只改文档，**没有在 `1ea3bff`（parent/base 链项 `2843cbe`）上重跑任何验收**，也没有重算任何 sha、没有打开回执正文；下表“是否当前基线验”按证据自身或交接声明里的 commit 归属判定，归属不清就写在“缺口”里。

## 1.6 收口补充：Win11 真机验收第 9 遍（Hark 交接）

> 记录日期按本索引口径记为 **2026-11-28**；交接未给出第 9 遍自身的执行时间戳，故不写运行时间。本小节只记录 Hark 交接的汇总事实，**没有新增回执文件、没有重算任何 sha、没有打开回执正文**。

| 项 | 交接事实（照抄口径，不外推） |
|---|---|
| 执行人 / 机器 | Hark / **Win11 真机** |
| 被验收包 | **`2843cbe` 的 Windows 包**（`2843cbe` 是当前基线 `1ea3bff` 的 parent/base 链项；**不是** `1ea3bff` 包） |
| 验收脚本 | `2954ed5`（第 9 遍所用的真机安装验收脚本 commit；与 1.3 里只新增 draft 脚本的 `d35f070` 不是同一提交） |
| 结果 | **14 PASS / 1 SKIP / 0 FAIL** |

- **PASS 14 项**：`CREDENTIAL`、`EXTRACT`、`INSTALL`、`START`、`LOGIN`、`MEMBER_MODEL`（`agent_5` → `pi` / `deepseek-v4.1-flash`）、`CAMP`、`REAL_MODEL_IDENTITY`、`REAL_MODEL`、`DOCX_MARKER`、`PPTX_UPLOAD`、`PPTX_PREVIEW_INTERFACE`、`STOP`、`STOP_CONSOLE`。
- **SKIP 1 项**：`SKIP_LIBREOFFICE`（该机未装 LibreOffice 时跳过；**不能**当作“装好 LibreOffice 后逐页预览成功”的正向证据，1.1 那条正向缺口照旧存在）。
- **FAIL 0 项**。
- **证据缺口（显式标记，不补齐）**：交接**没有提供** ①原始回执文件路径 ②回执 sha256 ③截图 sha256 ④GitHub Actions run id。这四项在本索引里**保持空白、不得编造任何路径或哈希**；抽查时只能引用“Hark 在 Win11 真机跑出第 9 遍、14 PASS / 1 SKIP / 0 FAIL”这条交接声明本身，不能当成可复核回执。
- **归属边界**：本遍被验收包是 `2843cbe`，所以它**不证明**当前基线 `1ea3bff`，**也不证明**本索引所在 worktree 的 `748e193`；不能与 `a4ea6da` 的 Windows 流水线 run `45974025818`（Hark 汇总 PASS、非用户机运行）互换，也不能把 1.1 里 `1ea3bff` trial 的 Windows artifact `15226860608` 当成本遍的包。

## 抽查优先级（2026-11-28 指定顺序）

| 优先级 | 条目 / 功能 | commit / 包 SHA | 证据回执 sha256 · 截图 sha256 · run id | 当前基线 `1ea3bff` 验过？（parent/base 链项 `2843cbe`） | 缺口（显式标记，不补齐） |
|---|---|---|---|---|---|
| **1.2** | SWE-1 两轮全链：个人版主链 建群 → Goal → 双受控工兵 → 独立 Review → 可打开成果 → SIGTERM 后恢复 | 轮 1 `429ecd7`；轮 2 `9ba97a5`（**两轮不是同一 commit**） | 轮 1 `/home/ubuntu/final-acc-taskscope/report.json` sha256 `05a61efaa9fba74439908b9adf261656f7082677dca12dae2aac75f8ec74402a`；轮 2 `/tmp/sec5-9ba-sigterm/evidence/report.json` sha256 `5ab99de30862a189ae140f8f278f36a8fdc282acd836568d601570d6d0f0c17e`；另有一次对 `429ecd7` 的独立 SIGTERM 复验 `/tmp/sec5-429-sigterm4/evidence/report.json` sha256 `ec6a01a5ae712f99198e3f3ae43256da025658392d8271fecec0b4a5538ae5e5`；**无截图 sha，无 run id** | **否** —— 两轮都在 `429ecd7`/`9ba97a5`，早于 `a4ea6da`，更早于当前基线 `1ea3bff`（parent/base 链项 `2843cbe`） | ①“两轮”是跨两个旧候选各一轮，不是同 commit 两次独立全链；②从 `a4ea6da` 起再没跑过 §5；③无截图回执；④都在 Devin VM，无 Windows 侧全链；⑤当前基线 `1ea3bff` 重跑结果：无 |
| **1.1** | LibreOffice / 个人版包：①pptx 多页 missing-LibreOffice 浮层 ②Linux 从零装包真模型冒烟（建群→回复→docx→停止）③双平台包产物 | `a4ea6da`（pptx-preview-detect）/ `loom/trial-a4ea6da`；Office 三件读取另在 `aa6de92` | pptx 结果 `/tmp/final-a4-smoke/evidence/pptx-preview-result.json` sha256 `1a021b1b944b4c55537f39132a21a8f21596c89278be93ded55d534555c9a670`；截图 `/tmp/final-a4-smoke/evidence/pptx-overlay.png` sha256 `153fc86bcbe88072c83dcc75be4c25ea704a054218fd6a87b70b3b1def2a833e`；smoke `/tmp/final-a4-smoke/evidence/smoke-result.json` sha256 `f02fe57f23b4ad80921d8c048388fb9ec95fce0b108d6e0a2ff5965ac4b999c4`；Linux run `45974031213` success / artifact `15186233054` / tar sha256 `b109d240bed87b209a3918b46e0b11898b5645dd6fa47738c9abad972a15f7b6`；Windows run `45974025818`（Hark 汇总 PASS，非用户机运行） | **否** —— 全部 `a4ea6da` 及以前；`1ea3bff` trial 两条 run 都 **success**（Linux `46052485873` / artifact `15225925980` / tar sha256 `737925180f805d780a50cf56c0413a1e739de476c2bbb46d5e610474129bd103`；Windows `46052481730` / personal artifact `15226860608`，解包文件树无单一包 sha），但只到打包流水线与产物存在，**没有任何 LibreOffice 或从零冒烟回执** | ①只有“缺 LibreOffice”的**负例**浮层，**没有任何版本“装好 LibreOffice 后逐页预览成功”的正向证据**；②Windows 包只做流水线/产物静态核验，未在用户机跑；③`a4ea6da` smoke 只重验 docx，三件 Office 读取仍只在 `aa6de92`；④tar/artifact sha 属 `a4ea6da`，不能平移到 `1ea3bff`；⑤`1ea3bff` Linux artifact `15225925980` 是**自己的 tar**，sha256 记 `737925180f805d780a50cf56c0413a1e739de476c2bbb46d5e610474129bd103`，不能与 `a4ea6da` 的 tar sha 互换；Windows artifact `15226860608` 是解包文件树、**没有单一包 sha**，静态产物证据只到 `candidate-manifest.json` sha256 `e2e6d251537a9db01fa43be2d62f3c9068fe7cc1640f6207e8048571f8a01b04` |
| **1.3** | Windows 超时 / 真机安装验收脚本：①验收脚本执行时限 30s→60s ②真机安装验收脚本草稿 | `2bd71a8`（timeout 30s→60s）；`d35f070`（**仅**新增 `scripts/acceptance/windows-real-install-acceptance.draft.ps1`）。两者原本都是 `a4ea6da` 之上的提交，diff 已分别以 `dd8b9b9` 和最终树的形式 cherry-pick 进 `1ea3bff` 候选 | `2bd71a8` PASS run `46048772023`（本轮**未提供**该 run 的名称、回执文件、截图 sha）；`d35f070` 本身无回执、无截图、无 run id；**Windows 真机安装的第 9 遍已由 Hark 在 Win11 真机跑出（被验收包 `2843cbe` 的 Windows 包、脚本 `2954ed5`、14 PASS / 1 SKIP / 0 FAIL，见 §1.6），但没有回执原文路径、没有回执 sha256、没有截图 sha256、没有 run id** | **否** —— 两项代码在 `1ea3bff` 内，但它们的测试**未在 `1ea3bff` 上重跑**，按“候选内代码、测试未复验”记账 | ①draft 脚本对应的 Windows 真机安装验收**已有人工记录**（Hark 第 9 遍，§1.6），不再是“没跑过”；但该遍**原始回执/截图/sha256/run id 仍缺**，只能按 Hark 汇总口径引用；②`d35f070` 只加脚本，不是功能或被测代码变更；③`2bd71a8` 只拿到 run id，没有回执正文；④`46048772023` 跑在旧 `a4ea6da` 基线上，不能平移到候选 PASS；⑤第 9 遍的包是 parent/base 链项 `2843cbe`，**不证明** `1ea3bff`、**不证明** `748e193` |
| **2.0** | 云上链接 flight：链接在线 → 断链 → 重连（online / offline / reonline），重连后经链接执行命令并落一个文件 | **旧 `a4ea6da` Linux 包二进制**（`/tmp/final-a4-smoke/pkg`），**不是** `1ea3bff` 基线包；`1ea3bff` 上未跑 | online `ff6a9551efb1bd7b6fb7499c265c37936a9ec504677867d9cd17409fa636f470`；offline `412cd83200c2737b8b9b308d193930f92a98d20aef991757fd8e4ae8ab658505`；reonline `da63e1b0812c1369b0119588719efc4aaad1e2441a27e0ea4f712082d3bf4600`；exec output `73c878906f0593d5f10f014b8b5044485e8069151f06c9ab5c5f8258c7e5426b`；created file `a10b3027833c149b081b9d0e764005f46a6cbc06d126ef41df16715b3fe8fc19`（逐步拆表见下）；**无截图 sha、无 flight run/session id** | **否** —— 该 flight 跑的是旧 `a4ea6da` 包二进制，只是**既有链接通路 + 旧 `a4ea6da` 包**的证据；**未在 `1ea3bff` 上验证**，不证明当前基线 | ①隔离方式是 **Devin VM 进程隔离，不是容器**，按现行 E5/容器口径不能当跨设备证据；②只跑了一轮 flight，无重复；③只有 VM/Linux 侧，Windows 侧无 flight；④`1ea3bff` 基线包未跑 flight；⑤回执原文路径未提供，抽查须回执行机/原会话取证；⑥trial：Linux `46052485873` success / artifact `15225925980` / tar sha256 `737925180f805d780a50cf56c0413a1e739de476c2bbb46d5e610474129bd103`；Windows `46052481730` success / artifact `15226860608`（解包文件树，无单一包 sha，静态产物只到 `candidate-manifest.json` sha256 `e2e6d251537a9db01fa43be2d62f3c9068fe7cc1640f6207e8048571f8a01b04`）；两条 trial 只证明打包流水线与产物存在/可哈希，不补跑 flight，也不算本行证据 |

### 2.0 云上链接 flight 回执清单（旧 `a4ea6da` 包二进制·未在 `1ea3bff` 上验证）

| 步骤 | 回执 sha256 | 索引口径（只按交接标签记录，未打开正文） |
|---|---|---|
| online | `ff6a9551efb1bd7b6fb7499c265c37936a9ec504677867d9cd17409fa636f470` | 链接在线阶段的回执摘要 |
| offline | `412cd83200c2737b8b9b308d193930f92a98d20aef991757fd8e4ae8ab658505` | 断链（offline）阶段的回执摘要 |
| reonline | `da63e1b0812c1369b0119588719efc4aaad1e2441a27e0ea4f712082d3bf4600` | 重连（reonline）阶段的回执摘要 |
| exec output | `73c878906f0593d5f10f014b8b5044485e8069151f06c9ab5c5f8258c7e5426b` | 重连后经链接执行命令的输出摘要 |
| created file | `a10b3027833c149b081b9d0e764005f46a6cbc06d126ef41df16715b3fe8fc19` | 该命令新建文件的摘要 |

- 执行位置：**Devin VM**，隔离手段为该 VM 内的进程隔离；**没有使用容器**，因此不能与 E3 容器 / E5 DE-BERO 容器证据互换。
- 包归属：该次 flight 的包二进制来自 `/tmp/final-a4-smoke/pkg`，即**旧 `a4ea6da` 的 Linux 包**；**不是 `1ea3bff` 基线包**，因此仅是**既有链接通路 + 旧 `a4ea6da` 包**的证据，**未在 `1ea3bff` 上验证**。
- 缺口（不补齐）：无截图 sha；无 flight run id / session id / 文件路径；trial（`1ea3bff` 自己的打包流水线，不是本 flight 的重跑）：Linux run `46052485873` **success** / artifact `15225925980` / tar sha256 `737925180f805d780a50cf56c0413a1e739de476c2bbb46d5e610474129bd103`；Windows run `46052481730` **success** / personal artifact `15226860608`，但该 artifact 是**解包后的文件树、不是单个包归档**，所以**不记 Windows 包 sha**，静态产物证据只到 `candidate-manifest.json` sha256 `e2e6d251537a9db01fa43be2d62f3c9068fe7cc1640f6207e8048571f8a01b04`。

## 总览

| 类别 | 数量 | 说明 |
|---|---:|---|
| 与当前基线同源的验收（带保留） | 0 | 无。2.0 云上链接 flight 跑的是旧 `a4ea6da` 包二进制（`/tmp/final-a4-smoke/pkg`），**未在 `1ea3bff` 上验证**，不算当前基线证据；`1ea3bff` 的两条 trial run（Linux `46052485873` / Windows `46052481730`）虽双 success，也只证明打包流水线与产物存在/可哈希，**不证明** LibreOffice 行为、从零安装冒烟、Windows 真机验收，也不等于 `1ea3bff` 的云上链接 flight |
| 只在 `a4ea6da` 验过、未在 `1ea3bff` 重跑 | 5 | 双平台个人版包、Linux 从零冒烟、pptx missing-LibreOffice 浮层、§5/T28 主链、2.0 云上链接 flight（旧 `a4ea6da` 包二进制） |
| 旧版/源码树证据 | 26+ | 多数 T 系列、UX、接口、权限、安全证据早于 `a4ea6da` |
| 明确缺证据 | 8 | T22 全矩阵、T22c、T35、E4-E/E4-F、E5-B、E6-B、E7、Windows 真机安装验收（已有 Hark Win11 真机第 9 遍的人工汇总口径 `2843cbe` / 脚本 `2954ed5` / 14 PASS / 1 SKIP / 0 FAIL，但**回执路径、回执 sha256、截图 sha256、run id 仍缺**，见 §1.6） |
| 不适用 / 范围外 / 暂停 | 3 | 假凭据到期清理（不做）、Codex 个人版（不适用）、DSH（暂停） |

## 现行验收条目索引

| 条目 | 结论 | commit / 包 | 证据路径 + sha256 | 验收人 | 是否当前基线（`1ea3bff`，parent/base 链项 `2843cbe`）验 | 缺口/备注 |
|---|---|---|---|---|---|---|
| §5 个人版主链 | 实质 PASS（旧版） | 轮 1 `429ecd7` 全链；轮 2 `9ba97a5` SIGTERM 全链（两轮不同 commit）；非当前候选 | `/home/ubuntu/final-acc-taskscope/report.json` sha256 `05a61efaa9fba74439908b9adf261656f7082677dca12dae2aac75f8ec74402a`；`/tmp/sec5-429-sigterm4/evidence/report.json` sha256 `ec6a01a5ae712f99198e3f3ae43256da025658392d8271fecec0b4a5538ae5e5` | SWE-1 初验，SWE-4 独立复验 | 否，旧版（`1ea3bff` 未重跑） | `9ba97a5` SIGTERM 也 PASS，report `/tmp/sec5-9ba-sigterm/evidence/report.json` sha256 `5ab99de30862a189ae140f8f278f36a8fdc282acd836568d601570d6d0f0c17e`；`a4ea6da` 及当前候选均未重跑 §5；无截图 sha |
| T28 上下文恢复 / handoff recovery | PASS_WITH_CAVEATS | `429ecd7` 恢复修复；`9ba97a5` unknown-handoff UX | `/home/ubuntu/final-acc-handoff-recovery/report.json` sha256 `a895b2ae1b8b5e119ff75dd1e6473627ee65443f1f16fb5502c3bf3e86c5d6e0`；SIGTERM `/tmp/sec5-429-sigterm4/evidence/report.json` sha256 `ec6a01a5ae712f99198e3f3ae43256da025658392d8271fecec0b4a5538ae5e5`；kill -9 `/tmp/sec5-429-kill9/evidence/report.json` sha256 `1835dce27caf4b5b4ea0a38b7703c529ad39b5c89c3f47798a66831678e08af7` | SWE-1/SWE-4 | 否，旧版（当前候选未重跑） | 验收偏向进程重启/handoff recovery；`LOOM-ACCEPTANCE` 的 Checkpoint 后恢复真实 Goal 与来源引用没有单独当前候选证据。kill -9 unknown 是 fail-closed 设计 |
| T19 群聊 @ 路由 | PASS | 证据未固定 commit；在 `perm-rerun` 当轮主线 | `/home/ubuntu/perm-rerun/evidence/report.json` sha256 `f7940f4153f883c2ce27d866cc1647a1334ca3db5974376a751df399c9755b05`；`/home/ubuntu/perm-rerun/evidence/snapshots-final.json` sha256 `2468b9d7caffedb866674e9a39ee573f55b85bcda9eb963cf8f9c7885caaf206` | SWE-2/SWE-1 汇总，SWE-4 索引 | 否，旧版 | commit 未写入证据，抽查需回看当轮分支/数据库 |
| T20 Assignment DAG | PASS | 同上 | `/home/ubuntu/perm-rerun/evidence/t20-execution.json` sha256 `af7667a91d25430d8dc8888a7635e281e9f7642f8f4c7e8177f5a95ff98b7b05`；汇总 sha256 `f7940f4153f883c2ce27d866cc1647a1334ca3db5974376a751df399c9755b05` | SWE-2/SWE-1 | 否，旧版 | 无跨任务错接管证据；旧版（未入当前候选） |
| T21 迟到回复 | PASS | 同上 | `/home/ubuntu/perm-rerun/evidence/t21-execution.json` sha256 `d752eac6ebb2d895f45eddc98901e66b88764a47337452eff3f655f41a05c756` | SWE-2/SWE-1 | 否，旧版 | 过期 lease/旧 fence 均拒绝 |
| T22 能力跨运行端完整矩阵 | 未完整验收 | — | — | — | 否 | `LOOM-ACCEPTANCE` 要 Pi/DSH/Codex 四能力 native/adapted/unsupported 完整正反例；当前只有分项与暂停/不适用说明 |
| T22b Claude 禁用 | PASS | 证据未固定 commit | `/home/ubuntu/final-acc-swe3/artifacts/t22b-claude-disabled.json` sha256 `3f8ab1058676625593a0183b9ed59f730d394b772741f6104f28f3888e19e2e6` | SWE-3 | 否，旧版 | Claude 进程计数 0；旧版（未入当前候选） |
| T22c 派活走 cospan | 缺证据 | — | — | — | 否 | 未见 Codex/DSH cospan observe/result/continue/cancel 与文件差异证据 |
| T23 Markdown 人格导入 | PASS | `fb366c0` fix-persona-import；另有回归 | `/home/ubuntu/final-acc-ext/artifacts/t23-persona-import-validation.json` sha256 `6d79f5a608f595a04d1a0e08e7cb3d92832f354c89fd317f05bc1e2a511ddf76`；回归 sha256 `399f06865e23c1ea32353d72993f18a80b368d2f440724d03f85ac1b17b183b2` | SWE-3/回归执行人 | 否，旧版 | 修复 commit 已知，但最新版未重跑 |
| T24 提示词模式/hash | PASS | 证据未固定 commit | `/home/ubuntu/final-acc-swe3-r2/artifacts/t30-append-r2.json` sha256 `558f06afad4651959f59587b251c79b3ee97222022b911278bef8211ca6c9543`；回归 `/home/ubuntu/final-regress/artifacts/t26-purge-append-fixed.json` sha256 `adb2cf117b99e2d87fdde9f3777deba9a17c493c0f00e63b97aeb2b2ccbdcd80` | SWE-3 | 否，旧版 | Replace 不适用 |
| T25 记忆隔离与记忆库 | PASS | 证据未固定 commit | `/home/ubuntu/final-acc-swe3/artifacts/t25-memory-isolation-final.json` sha256 `57508b7503e86b4356fc3b5b9915f787092c4c1146813c7a98e909b38f314987`；回归 `/home/ubuntu/final-regress/artifacts/t19-memory-fixed.json` sha256 `e964739ebb6afbc52b48c68b85d493bf3d4a1deb9f354be8e43f830787ba3311` | SWE-3 | 否，旧版 | W1/W2 不串 |
| T26 恶意扩展 | PASS | `9fb6d45` fix-ext-allowlist；另有原始/回归证据 | `/home/ubuntu/final-acc-ext/artifacts/t26-malicious-plugin-fixed.json` sha256 `b30e1d3afd061003f52a6ab45b5a30e8b7c909684c85fad1aa0beec3b96dbb8c`；回归 sha256 `3256cb2904b05d4c9a896ddce1839e33877dfcb72ce81cca876ccd90a3c91977` | SWE-3/回归执行人 | 否，旧版 | `--no-extensions` 后自动发现关闭 |
| 提示注入 | PASS | 证据未固定 commit | `/home/ubuntu/final-acc-ext/artifacts/t27-prompt-injection-stealth.json` sha256 `9a2b6267a4aa986e06d1f2c71f00a4f55ccd5ad6680d092e6bba386acfc9b306`；回归 sha256 `db51c30253cf2a70a3465620a1e33f9f8a7c36dc18dff5a99ca396e8cb7924d2` | SWE-3 | 否，旧版 | 无秘密外泄、无 marker、删除目标幸存 |
| 换人格不提权 | PASS | 证据未固定 commit | `/home/ubuntu/final-acc-ext/artifacts/t27-persona-privilege.json` sha256 `13359421fa67049f30d1c3f4834cd7055ca400b7d6a83f7c274c74a855d28992` | SWE-3 | 否，旧版 | Grant 冻结不变 |
| 假凭据到期清理 | 不做 | — | `/home/ubuntu/final-acc-ext/artifacts/t27-security-summary.json` sha256 `9b6718104ceffe1daef7b08cf8055cd1a05fad8e0f4ff039127fa404cf6aae78` | SWE-3 | 不适用 | 本地 Mikka/PiBot 参考无此机制，按用户规矩不自造 |
| T29 Pi Purge 关闭 | PASS | 证据未固定 commit | `/home/ubuntu/final-acc-swe3-r2/artifacts/t29-off-r2.json` sha256 `fb7eef30627111dd986fecee6e8e9d031d376cd0794c4219605b175ed329db83` | SWE-3 | 否，旧版 | Off 无 PromptReceipt 属预期 |
| T30 Pi Purge 激活 | PASS | 证据未固定 commit | `/home/ubuntu/final-acc-swe3-r2/artifacts/t30-append-r2.json` sha256 `558f06afad4651959f59587b251c79b3ee97222022b911278bef8211ca6c9543`；receipt sha256 `a07d0d6e74652f12b6fdbd0f2dfebd9cca7ae763f4830167ee5e8d8f1d93acad` | SWE-3 | 否，旧版 | Append 实证 |
| T31 Pi Purge 模式 | PASS（Append） | 证据未固定 commit | 同 T30；receipt `/home/ubuntu/final-acc-swe3-r2/artifacts/t30-pi-purge-receipt.jsonl` sha256 `a07d0d6e74652f12b6fdbd0f2dfebd9cca7ae763f4830167ee5e8d8f1d93acad` | SWE-3 | 否，旧版 | Replace 个人版不适用 |
| T32 多 Bot 隔离 | PASS | 证据未固定 commit | `/home/ubuntu/final-acc-swe3/artifacts/t32-after-restart-final.json` sha256 `beb02a0bdeac7f4d9bbefa1c1031f0e0910f01bb358777f243b454dbd9fb2899` | SWE-3 | 否，旧版 | 并行与重启均不串 |
| T33 实验室与 Grant 围栏 | PASS | 验收时 `46777342` 系列；SWE-4 汇总 | `/tmp/final-acc-swe4/report.json` sha256 `dcba688f703d336e9f973dc38057aecba05419bb9ed81b0f51fe5a83821996f9`；`/tmp/final-acc-swe4/evidence/security-negative.json` sha256 `dc63066a41945f5f8a8933c8905070e4c2ae77944737bdadc75c2c574d1eab98` | SWE-4 | 否，旧版 | 无 token/坏 token 401，未知 tool 400，网络能力拒绝 loom 写操作 |
| T34 先领后写 | PASS | 证据未固定 commit | `/home/ubuntu/perm-rerun/evidence/t34-execution.json` sha256 `da4dff93d469a2a280d5ae60be412ff382c284a99f48f813b240e35001833940` | SWE-2/SWE-1 | 否，旧版 | 10/10 claim 前拒绝，10/10 claim 后成功 |
| T35 主助手操控 B / LOOM Node | 缺独立当前候选证据 | — | — | — | 否 | 没有单独“只装 LOOM Node 设备完成文件操作，有 DeviceInvocation 回执”的最终版索引；§5 用 Linux `loom-node` 子进程替代 Windows node，平台替代需注明 |
| 重试 3 次 | PASS | `4e4a38e` fix-retry；证据在 `9711b0c` 轮 | `/home/ubuntu/retry-9711/artifacts/retry-9711-report.json` sha256 `81cbcc450c9f749c4f53beddaf3d1a409898e0786c12ec88d92dd060356ba38a` | SWE-2/SWE-1 | 否，旧版 | 前三次禁用自动重试，第四次后手动出现 |
| 双平台个人版包核验 | PASS（`a4ea6da` 旧版） | `loom/trial-a4ea6da` / commit `a4ea6da`（已降为旧版基线）；此前 `0f2fa68` 也 PASS | 旧版基线最新：Windows run `45974025818` success（Hark 汇总双平台 PASS），Linux run `45974031213` success、artifact `15186233054`、tar sha256 `b109d240bed87b209a3918b46e0b11898b5645dd6fa47738c9abad972a15f7b6`；Linux smoke `/tmp/final-a4-smoke/evidence/smoke-result.json` sha256 `f02fe57f23b4ad80921d8c048388fb9ec95fce0b108d6e0a2ff5965ac4b999c4` | SWE-4 Linux；SWE-3 Windows 静态 | 否，`a4ea6da` 旧版；`1ea3bff` 未重跑 | Windows 不在用户机运行，只流水线/静态核验；`1ea3bff` trial（两条都 success）：Linux `46052485873` / artifact `15225925980` / tar sha256 `737925180f805d780a50cf56c0413a1e739de476c2bbb46d5e610474129bd103`；Windows `46052481730` / personal artifact `15226860608`，是**解包文件树、不是单个包归档**，所以不记 Windows 包 sha，静态产物只到 `candidate-manifest.json` sha256 `e2e6d251537a9db01fa43be2d62f3c9068fe7cc1640f6207e8048571f8a01b04`；这些不是本表的包核验，tar/artifact sha 也不能平移到 `1ea3bff` 的新行为结论 |
| Linux 从零冒烟 | PASS（`a4ea6da` 旧版） | `loom/trial-a4ea6da` artifact `15186233054` | `/tmp/final-a4-smoke/evidence/smoke-result.json` sha256 `f02fe57f23b4ad80921d8c048388fb9ec95fce0b108d6e0a2ff5965ac4b999c4` | SWE-4 | 否，`a4ea6da` 旧版；`1ea3bff` 未重跑 | 建群→回复→docx→停止；observed model `deepseek-v4.1-flash`；`1ea3bff` trial Linux `46052485873` 已 **success** / artifact `15225925980` / tar sha256 `737925180f805d780a50cf56c0413a1e739de476c2bbb46d5e610474129bd103`，但这只证明 Linux 打包流水线与产物存在，从零冒烟仍未在 `1ea3bff` 重跑 |
| pptx 多页 missing-LibreOffice 浮层 | PASS（负例，`a4ea6da` 旧版） | `a4ea6da` pptx-preview-detect；`loom/trial-a4ea6da` | `/tmp/final-a4-smoke/evidence/pptx-preview-result.json` sha256 `1a021b1b944b4c55537f39132a21a8f21596c89278be93ded55d534555c9a670`；截图 `/tmp/final-a4-smoke/evidence/pptx-overlay.png` sha256 `153fc86bcbe88072c83dcc75be4c25ea704a054218fd6a87b70b3b1def2a833e` | SWE-4 | 否，`a4ea6da` 旧版；当前候选未重跑 | 本机无 `soffice/pdftoppm`；Core 返回 `missing_dependency/soffice,pdftoppm`，浮层显示「安装 LibreOffice 后可逐页预览」；**“装好 LibreOffice 后逐页预览成功”没有任何版本的正向证据**（缺口） |
| Windows 验收脚本超时 30s→60s | 该 run PASS（非当前候选） | `2bd71a8`（原本基于 `a4ea6da`；diff 已以 `dd8b9b9` cherry-pick 进 `1ea3bff` 候选） | run id `46048772023` PASS；本轮**未提供** run 名称、回执文件、截图 sha | 交接记录 | 否 —— 代码在 `1ea3bff` 内，但该 run 跑在旧基线上，测试**未在 `1ea3bff` 上重跑** | 只能说明该 run 在当时源码上通过；无回执正文，不能平移成候选 PASS |
| Windows 真机安装验收脚本（草稿） | 人工真机验收 14 PASS / 1 SKIP / 0 FAIL（Hark 第 9 遍，见 §1.6；无回执/截图/sha/run id） | 脚本 `d35f070` **仅**新增 `scripts/acceptance/windows-real-install-acceptance.draft.ps1`（原本基于 `a4ea6da`，diff 已以最终树形式进 `1ea3bff` 候选）；第 9 遍真机验收所用脚本是 `2954ed5`，被验收包是 **`2843cbe` 的 Windows 包** | 无回执文件路径、无回执 sha256、无截图 sha256、无 run id（交接未提供，不补齐）；结果口径只有 `14 PASS / 1 SKIP / 0 FAIL`，逐项见 §1.6 | Hark（Win11 真机） | 否（严格）—— 代码在候选内，但第 9 遍的包是 parent/base 链项 `2843cbe`，不是 `1ea3bff` 包，**不证明** `1ea3bff` 或 `748e193`；也没有在 `1ea3bff` 上重跑 | ①已有人工真机验收记录（第 9 遍），不再写成“脚本存在 ≠ 跑过”；②但**原始回执/截图/sha256/run id 仍缺**，只能按 Hark 汇总口径引用，不能当可复核回执；③`SKIP_LIBREOFFICE` 是跳过项，不构成 LibreOffice 正向证据 |
| 电脑审批卡 | PASS | `fd9db5e` fix-computer-tools | `/home/ubuntu/fixcomp-acc/final-report.json` sha256 `4fda14ae76771041ddfe41a13f49977d10b7b4ad37103783a7cb62a607d34fc3`；后端 sha256 `f83853b92026337c66ac6f4123f93c1fac4d3073043b3ccaabde030c6438e519`；截图 sha256 `9214979d92374b217cd177f85ee5e4e3c8a7613c553394a84f2ae384d19aacf7` | SWE-4/SWE-2 | 否，旧版 | Xvfb 实证原因、rect、「本任务内都允许」；未在新候选重验 |
| docx/xlsx/pptx 读取 | PASS | `aa6de92` fix-office-attach；真包 run `45935854270` artifact `15170363505` | `/tmp/office-fix-acc/evidence/office-fix-result.json` sha256 `1e23b96d9f4459a7e980337c2936f051b075df3354c3d57214baef18fcb17540`；回归 `/home/ubuntu/final-regress/artifacts/misc-regression.json` sha256 `612561fba3eb373617dd28d7100788e55862f837da2215084835761c863b6cbf` | SWE-4 | 否，旧版但真包 | 三 marker 均命中；`a4ea6da` smoke 只重验 docx，未三件全重验 |
| xlsx 预览/引用/版本对比 | PASS | 证据未固定 commit | `/home/ubuntu/perm-rerun/evidence-ux/report.json` sha256 `283c2dd3f731d4be28b32e007664df75a78361a7ec920ca92a08a0e4d1ccc200` | SWE-2 | 否，旧版 | 逐项截图 sha 在报告内 |
| 第二批 UX/Webhook 回归 | 8/8 最终 PASS | Webhook `1cb18c0` base `aa6de92`；电脑修复 `fd9db5e` | UX `/home/ubuntu/perm-rerun/evidence-ux/report.json` sha256 `283c2dd3f731d4be28b32e007664df75a78361a7ec920ca92a08a0e4d1ccc200`；manifest sha256 `b4789e31a25d5f0c20887b724796f1da0bb919ae9db5baacd79ca9a5f637f69f`；Webhook `/tmp/webhook-control-fixture/report.json` sha256 `1177edccb447d0b03ae9a79f781f8425042e7a4307ad15833a3cd305d5b7398c` | SWE-2/SWE-4 | 否，旧版 | Webhook Bero diff sha `4a3801f8bbd6af51e771bbba488121c1259446c5486d726f3190968bf5ad044a` |
| 视频播放/预览 | PASS | `6962929` fix-video | `/home/ubuntu/final-regress/artifacts/video-preview-regression.json` sha256 `a35a30bc4918208948999b5bc60a6199fccc445a4eea7cac10950123342c9a48` | 回归执行人 | 否，旧版 | 使用 seeded artifact 验证预览/播放数据路 |
| chat/responses/claude(messages) 三接口 | PASS | 验收时 `46777342` 系列；SWE-4 汇总 | `/tmp/final-acc-swe4/evidence/model-interfaces.json` sha256 `9f5b4ffdb931816033844a2575a69aedeefc0240da1f69a62d6e6598334b7ad7`；chat sha256 `583eea479bd9cbf08c71772fc5b2c19187ff3d391736db625b75ebdaa9c25ba9`；responses sha256 `74b0457987a99d11dc5d1485c855ea4b9c9937d46019a8904f0e1c91ee1fb46e`；claude sha256 `5a2cc2f60aecba2e330f3921e40ab2159c7d4c0d8a6023af800aff49cba6e2d3` | SWE-4 | 否，旧版 | 三接口真实 Pi 派活成功，observed model `deepseek-v4.1-flash` |
| 单 Bot 全权限 + Mikka 对齐 | PASS | `3a1fd02` owner-auto-approve；`9711b0c` perm-align-mikka | `/home/ubuntu/final-ownerauto/behavior-evidence.json` sha256 `b809170292489bafe687dec6ea31dce4dd41aa11b14c674aa3dcbc210be84c5a`；`/home/ubuntu/perm-acc/validate.log` sha256 `ecc3780c2e9a626c15f083d1c2d63b4d0b7ec029e94553d44fe7076164ce4627`；截图 sha256 `618cab2aef80eee97b18f6fa007662981b2d2bbbc5eb2a853cdf465a8ba2d0a2` / `c91a9380bc298fae664ffcd505e642f32c076ab92a9f8c58806d6a4ac627711f` | SWE-1/SWE-2 | 否，旧版 | agent_1 全权限不弹卡，agent_2 ask pending；五项档位/默认值 PASS |
| Codex 个人版 | 不适用 | — | — | Hark/用户范围决定 | 不适用 | 个人版只打 Pi，不计入门禁 |
| DSH | 暂停 | — | — | Hark/用户范围决定 | 不适用 | 不计入当前门禁 |

## E0–E7 门禁与旧缺口

| 门禁/子项 | 当前索引结论 | 证据/缺口 |
|---|---|---|
| E0 参考与复用边界 | 文档层面有约束，无单独运行时证据 | `LOOM-ACCEPTANCE` §3 是审查规矩；未见逐项“复制出处/THIRD_PARTY_NOTICES/架构范围”最终审计证据 |
| E4-A 双 Pi Worker、claim/fence、artifact | 旧版 PASS | `8310fcd`，`_artifacts/loom-personal-delivery-20261116/dual-supervisor-verification.json`；后续 §5/T34 有更强证据但非同一旧项重跑 |
| E4-B Core→Codex workspace-write | 旧版 PASS 但个人版不适用 | `6150aed`，`codex-supervisor-verification.json`；Codex 个人版当前不适用 |
| E4-C DSH 原生专项 | 旧版 PASS 但暂停 | `dsh-supervisor-verification.json`，`CoreIntegrated=false`；DSH 当前暂停 |
| E4-D 生产 Web Artifact 只读展示 | 旧版 PASS | `production-ui-verification.json`；后续成果浮层已有新版多处证据 |
| E4-E 正式 UI 发起全旅程/自动返工 | 已被 §5 主链部分覆盖，仍需按口径确认 | §5 最近证据在 `429ecd7/9ba97a5`（均为旧版）；是否完全覆盖旧 E4-E 需 Hark 抽查判定 |
| E4-F 四 Runtime × 四能力完整矩阵 | 缺证据 | 完整 16 格未验；Claude 禁用、Codex/DSH 不适用或暂停 |
| E5-A Linux Host/Web 登录与持久化 | 旧版分项 PASS | `e4a0aea`，`bero-container-supervisor-verification.json` |
| E5-B Device Node pairing/Grant/跨机工具/Artifact | 缺证据 | 真 pairing/跨机专项未完成；§5 的 Linux loom-node 替代不等于完整 E5-B；云上链接 flight 跑的是旧 `a4ea6da` 包二进制、Devin VM 进程隔离，既非候选证据也不补 E5-B |
| E6-A 已完成 Artifact 与 Host 重启持久化 | 旧版分项 PASS | 3/3 已完成 Pi 成果恢复和 Linux 重启证据 |
| E6-B 执行途中掉线/旧 fence/未知副作用 | 部分覆盖 | `429ecd7` SIGTERM/kill -9 覆盖一部分；Checkpoint/跨机续执仍非完整覆盖 |
| E7 Owner 真人 Review/正式 Release/升级回滚 | 缺证据 | Owner Review=0 历史缺口；不得脚本代签 |

## 抽查优先级建议（2026-11-28 指定顺序）

1. **1.2 §5/T28 两轮全链**：主线价值最高；注意两轮分属 `429ecd7` 与 `9ba97a5`（不是同一 commit 两次全链），且 kill -9 是 fail-closed 而非完工；两轮都早于当前基线 `1ea3bff`（parent/base 链项 `2843cbe`），按旧版证据抽查。
2. **1.1 LibreOffice / 个人版包**：抽查时只能验“缺 LibreOffice 的浮层提示”与 `a4ea6da` 包 sha（Linux run `45974031213` / Windows run `45974025818`）；**“装好后逐页预览成功”无任何版本证据**，不得写成已验；`1ea3bff` trial 双 success（Linux `46052485873` / artifact `15225925980` / tar sha256 `737925180f805d780a50cf56c0413a1e739de476c2bbb46d5e610474129bd103`；Windows `46052481730` / 解包文件树 artifact `15226860608`，无单一包 sha）也只到打包流水线与产物存在，不补 LibreOffice 行为或从零冒烟。
3. **1.3 Windows 超时 / 验收脚本**：`2bd71a8` 只有 run id `46048772023`、`d35f070` 只有 draft 脚本，两项都缺回执正文/截图；Windows 真机安装这一项现有 **Hark 第 9 遍（Win11 真机、包 `2843cbe`、脚本 `2954ed5`、14 PASS / 1 SKIP / 0 FAIL，见 §1.6）**，可写“人工真机验收（汇总口径）”，但**缺回执路径/sha256/截图/run id**，不得写成带回执的可复核证据，也不得写成已覆盖 `1ea3bff` 或 `748e193`；两条 diff 已 cherry-pick 进 `1ea3bff`（`dd8b9b9` / 最终树），代码在 `1ea3bff` 内但测试**没在 `1ea3bff` 重跑**。
4. **2.0 云上链接 flight**：五项 sha 已列，但它跑的是**旧 `a4ea6da` Linux 包二进制**（`/tmp/final-a4-smoke/pkg`），**未在 `1ea3bff` 上验证**，只能当**既有链接通路（旧 `a4ea6da` 包）**回执抽查，不得当基线证据；执行环境是 Devin VM **进程隔离而非容器**，且缺截图/run id。`1ea3bff` 自己的 trial 只到打包流水线与产物 sha（Linux `46052485873` + tar sha256 `737925180f805d780a50cf56c0413a1e739de476c2bbb46d5e610474129bd103`；Windows `46052481730` + 解包文件树 artifact `15226860608`，无单一包 sha）。
5. 对 `T22` 全矩阵、`T22c`、`T35`、`E5-B`、`E7` 不要当作已验收；这些是当前最明显缺口或范围外项。
6. `T22b`/`T23`–`T26`/`T29`–`T34` 仍是 `a4ea6da` 以前的旧版证据（commit 多数未写入回执），不要读成当前候选已验。

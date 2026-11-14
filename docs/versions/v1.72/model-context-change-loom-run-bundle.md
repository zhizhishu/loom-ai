---
document_type: model-context-change
version: v1.72
revision: 2
confirmation_status: implementation_authorized_by_current_session
confirmed_revision: null
confirmed_by: null
confirmed_at: null
technical_review_status: approved
technical_review_by: root_supervisor
technical_review_scope: revision_2
last_updated: 2026-11-04
---

# LOOM B7/B8：远端 Run 的已选能力快照（revision 2）

## 授权与复核记录

当前用户明确要求持续完成云端与本地双向控制，以及独立选择 Skill、MCP、规则和 hooks；上级监督者于本轮授权 B7/B8 实施，并要求保留具体前后内容供技术复核。本文件如实记录此实现授权，不声称用户已经另行阅读或二次确认本文件，也不由 Pi 或 Coding Agent 代签人类确认。旧治理文档要求再次询问的工作流程在本轮遵从当前用户的持续实施指令；这不等于抹去文档门禁的实际结果。

基线为本地 integration 分支 `7ba65b3ebfdd0660fd87bd7031f8414439d27858`。Pi 仅编写白名单内的纯协议、纯 builder 与不可变快照 store；模型上下文、权限、原生参数、数据冻结和验证由监督者负责审查。

## 变更前

远端 `ServerMessage::Start` 完整 shape：

```json
{
  "type": "start",
  "runId": "run_<hex>",
  "attempt": 1,
  "adapterKind": "claude-code",
  "program": "<node-reported-cli>",
  "args": ["-p", "<user-task>"],
  "cwd": "<node-workspace>",
  "env": [],
  "shimToken": "<per-run-credential>"
}
```

该路径只传递参数与环境，没有成员已选资产快照。成员预览 `member.runProjection` 使用原有 renderer，但 MCP 为脱敏预览，不能执行；Skill 的 catalog body 为介绍文案，不能当作 SKILL.md。B6/B9 不改变这一事实。

现有 Bootstrap renderer 的段序为：

```text
[SESSION_CHARTER]
<existing charter text>
[/SESSION_CHARTER]

[MEMBER_IDENTITY]
<existing six-field identity JSON>
[/MEMBER_IDENTITY]

[TEAM_GUIDANCE]
<existing team guidance, when present>
[/TEAM_GUIDANCE]

[ROVAI_PLATFORM_SKILLS]
{"root":"<A managed root>","skills":[{"name":"cli-operations","desc":"<existing description>"},{"name":"memory-stewardship","desc":"<existing description>"}]}
[/ROVAI_PLATFORM_SKILLS]

<MEMORY_ENTRYPOINT bytes from the existing renderer>
```

上述尖括号为已有运行数据，未在本次重写。六项身份字段来自同一个成员投影。原有本地 additional skills 格式：

```text
[ROVAI_ADDITIONAL_SKILLS]
Current for this run; replaces any earlier Rovai Additional Skills.
{"root":"<managed root>","skills":[{"name":"<selected toolbox name>","desc":"<real skill description>"}]}
[/ROVAI_ADDITIONAL_SKILLS]
```

## 变更后

### 线协议和省略规则

`Hello` 新增可选 `runBundleVersions: number[]`，缺省为空。只在对端声明包含 `1` 后发带包的 Start。旧节点仍可接收没有包的原有 plain Start；不得向旧节点发其拒绝的未知字段来探测能力。

Start 新增 `bundle?: RunBundleV1`，None 必须序列化省略，不能写成 null。类型完整 shape：

```json
{
  "version": 1,
  "bundleId": "<runId>-<attempt>",
  "runId": "run_<hex>",
  "attempt": 1,
  "agentId": "<selected-member-id>",
  "adapterKind": "claude-code",
  "selectionRevision": "<frozen selection/content evidence revision>",
  "sourceSkillRoot": "<A managed root, or null>",
  "digest": "sha256:<canonical-payload-digest>",
  "files": [
    {
      "artifact": "bootstrapPrompt",
      "label": "bootstrap",
      "path": "bootstrap.txt",
      "bytes": 123,
      "content": "<base64 exact frozen bytes>"
    },
    {
      "artifact": "mcpConfig",
      "label": "mcp",
      "path": "mcp.json",
      "bytes": 123,
      "content": "<base64 native runtime JSON>"
    },
    {
      "artifact": "runtimeSettings",
      "label": "settings",
      "path": "settings.json",
      "bytes": 123,
      "content": "<base64 native hooks JSON>"
    },
    {
      "artifact": "skillFile",
      "label": "<skill-name>/<relative-file>",
      "path": "skills/<skill-name>/<relative-file>",
      "bytes": 123,
      "content": "<base64 real source bytes>"
    }
  ]
}
```

- Only `bootstrapPrompt` is required for a member bundle. No selected MCP/hooks means those artifacts are absent. Optional toolbox files include only selected names; independently stored but unselected catalog entries remain independent.
- Existing platform skills are a pre-existing Bootstrap dependency, separately identified from optional selections; no extra toolbox capability is inferred from them. Their source files are frozen only to keep the existing platform index usable on B.
- Files are sorted canonically. Digest covers all fields and file bytes, with the digest field blanked during hashing. A change to serialized bundle selection evidence, identity, run, attempt or source bytes changes the digest. Start.args and the user task are outside this digest; immutable dispatch evidence separately stores a launch digest over runtime, cwd and args.
- Limits: 128 files; 256 KiB per decoded file; 768 KiB total decoded; 1536 KiB serialized bundle. The existing 2 MiB transport frame cap remains authoritative.
- Only canonical ASCII relative path segments are admitted, with case-insensitive collisions and Windows reserved names rejected. Base64, declared sizes, singleton duplicates, version, runtime and run identity are checked before filesystem writes.
- There is no wire field for arbitrary launch flags.

### 模型可见内容

A calls the existing `member_projection_bootstrap` and `render_session_bootstrap` as-is. It freezes that result. B relocates only the JSON `root` value inside the established platform/additional-skill sections after checking the source root and index shape. All other Bootstrap bytes and field order remain unchanged.

The remote additive instruction payload is exactly:

```text
<existing renderer Bootstrap, with only the two known skill-index root values relocated>

<existing ROVAI_ADDITIONAL_SKILLS section, only when selected toolbox index is non-empty>

<selected rule body 1>

<selected rule body 2>
```

No new marker or Bootstrap section is invented. Rule bodies are the exact selected catalog source content, separated by two newlines in deterministic catalog order. Rule files alone do not count as applied. Source edits or deselection cannot mutate an already-created bundle.

When every optional asset is unselected, no optional Skill, rule body, MCP definition, hook definition or additional-skills section is added. The original Bootstrap and its two existing mandatory platform Skills remain separately identified. A real R1 Claude Run also carries the existing Core policy settings that force `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`; this settings file is required even when no hook is selected. These existing policies are not user-selected hooks or newly added optional assets. The legacy catalog-only freeze path may omit a settings file when hooks are empty.

### 原生交付

| Runtime | Instruction delivery | MCP delivery | Hooks delivery |
| --- | --- | --- | --- |
| Claude Code | `--append-system-prompt-file <private/bootstrap.txt>` | `--mcp-config <private/mcp.json>`, built with the existing native additive helper | `--settings <private/settings.json>` merges only selected hook definitions with the existing two forced Core policy environment values for a real Run |
| Codex CLI | Legacy Start uses additive `-c developer_instructions=<proper TOML string>`; the persistent Core driver sends the frozen bootstrap through the existing native thread instructions after validating the Node materialization receipt and relocating its Skill root | Legacy Start uses native `-c mcp_servers=<inline TOML table>`. The persistent process pipe validates/materializes the same frozen MCP bytes without a startup MCP override; the existing native config/read, NativeWins resolution and thread configuration own injection | Selected hooks fail with `bundle_hooks_trust_required` before filesystem writes or spawn; native definition-hash trust registration is not implemented |

These are new per-process values. No global native configuration is written. They do not claim to erase independently configured host-global or managed native assets. Conflicting caller-provided flags that could override the frozen bundle are refused, rather than silently replacing selected content.

Claude hook items must be strict native JSON objects with only a `hooks` top-level key. This initial contract supports common lifecycle events and command handlers only, with strict schema validation. Invalid/unsupported selected hooks fail the Run with a stable code. Empty hook selection emits no hook definitions. The real R1 Claude settings file still contains the existing forced Core policy values described above; the catalog-only legacy bundle can omit this file. Native runtime/version mismatch also fails explicitly before process spawn. Codex hooks are not reported as applied: no global trust is changed, and no bypass-hook-trust flag is added. This does not prevent bootstrap or MCP-only Codex bundles. Arbitrary model/env/permission settings cannot be smuggled through this surface.

Example allowed selected hook body:

```json
{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo bundle-fixture","timeout":10}]}]}}
```

The fixture is data for validation, not a command to execute during this implementation.

### MCP 的执行配置与秘密边界

The builder never uses redacted preview JSON. It uses the selected member definitions after the existing projection checks. In this first package, any nonempty env/header credential value, unresolved environment placeholder, masked preview token, credential-like argument, URL userinfo or token query is refused. A readable configuration failure reports a code and item/field name, never its value. No automatic secret pass-through is added.

A-side absolute cwd cannot be sent as a valid B-side directory. The current source capture admits only an absent MCP cwd or the literal `.` to inherit the selected node workspace; other cwd mappings are refused. Selected key-free literal command/args/URL configuration is materialized using existing runtime document builders.

## 冻结、证据与恢复

A records the immutable snapshot/digest for a dispatched Run and uses it again for retries rather than rereading current selections. Attempt identity may be rebound with a newly computed envelope digest while the source asset snapshot stays the same. A new Run captures the latest selection and content.

Migration 229 implements the bundle snapshot/digest evidence and projection schema 179, after existing migration 228 (task execution host). Existing applied migrations are not edited. Existing runs have no snapshot; they remain plain runs and are not backfilled. No current Native Binding, AgentRun formatter or ContextManifest is invalidated.

Node storage is a newly created private per-run directory. Linux/macOS creation uses 0700/0600. Windows reuses the existing protected-DACL, local-NTFS, no-reparse and file-identity contract extracted into a small shared storage crate; node does not depend on Core/SQLite. Only the owner directory is cleaned on failure/exit. Reconnect preserves the existing running process and its current bundle.

## 明确不变

Existing Bootstrap renderer sections and bytes, the local AgentRun formatter, ContextManifest, native global configuration, and the default execution host are unchanged by this package. The two existing mandatory platform Skills retain their original role; unselected optional catalog entries are not inferred as dependencies.

## 版本轴与权威边界

- New wire/bundle version: `RUN_BUNDLE_VERSION = 1`.
- Existing Bootstrap contract/renderer, AgentRun formatter, ContextManifest and local runtime delivery profiles remain unchanged.
- Optional selections remain owned by the existing member catalog and assignment stores.
- The remote bundle is execution evidence, not a new capability library or a preview-derived authorization.
- This change does not implement R1 claim-to-AgentRun linkage, R2 tool RPC, persistent session control, deployment or a default-host change.
- User acceptance/review authority is unchanged.

## 验证计划与关键负向输入

1. Pure protocol owner: exact round trip, deterministic digest, identity/version/runtime mismatch, content tamper, oversized base64, duplicate/case-colliding paths, Windows device names, traversal and unknown artifacts.
2. Pure builder owner: both native document shapes, real supplied skill bytes, selected rule content actually in additive instructions, empty hook omission, strict hook merge/refusal, no redacted/secret values in a valid bundle or error.
3. Catalog integration owner: freeze selected-only source bytes; change/unselect a source afterwards; current snapshot unchanged, next Run changed. Retry reuses original snapshot after restart.
4. Node owner: known-section root relocation only, TOML escaping and caller-flag collision rejection, private permissions, failure/drop cleanup, no workspace/global file writes.
5. Existing NodeStore/web owners: owner identity checks, unsupported bundle version before dispatch, no partial process launch on invalid bundle.
6. Windows tests run natively; POSIX-only mode/symlink and B1–B6 shell fixtures must be labeled NOT RUN on Windows.
7. Keep source commit and working diff evidence with tests. External model/provider calls, actual secrets and deployment are outside test scope. Native CLI checks use isolated homes, fixture credentials and local deterministic HTTP providers.
8. Run docs gate and report its actual result; do not forge confirmation metadata to make a gate pass.

## 二次确认

Current-session user instructions explicitly authorize continued implementation of selectable Skill/MCP/rules/hooks and cloud/local control without stopping for repeated permission. Root supervisor reviewed the concrete before/after proposal and approved revision 2 technically. No separate human review of this document was observed; `confirmed_revision`, `confirmed_by` and `confirmed_at` therefore remain null. The existing documentation gate requires those human confirmation fields and its failure is recorded honestly, without changing the checker or claiming it passed.

## 技术复核

Root supervisor approved revision 1 with recorded conditions on 2026-11-04: keep the two existing platform Skills separate from optional selections; distinguish bundle and launch digests; validate native Windows flags/PATHEXT/ACL; disclose independent host configuration; reject unsupported Codex hook trust; and reject unsupported credential-dependent MCP definitions. Revision 2 makes those approved boundaries explicit in the delivery table and cwd policy, corrects the implemented migration status, and records the actual native flag shape. It adds no new model-visible section or permission bypass. Root supervisor reviewed the complete revision 2 before/after shape, asset ownership, native flags, freeze and evidence sections on 2026-11-04 and technically approved revision 2; human second-confirmation fields remain unset.

### Verification evidence recorded on 2026-11-04

- `target/loom-integration-20261104-evidence/bundle_core_integrated.json`: 12 actual Core tests passed, including immutable store, source selection freeze/new Run change, builder and preview agreement.
- `target/loom-integration-20261104-evidence/native-bundle-claude-9dcad563/result.json`: real Claude 2.1.241, 10/10 checks passed; frozen instructions/rule/index, selected Skill Read, MCP initialize/tools/list, selected SessionStart/PreToolUse/PostToolUse/Stop hooks.
- `target/loom-integration-20261104-evidence/native-bundle-codex-33bfbd86/result.json`: real Codex 0.166.0, 6/6 checks passed; frozen instructions/rule/index and MCP initialize/tools/list/resources/list. No Codex hook trust bypass was used. The earlier short fixture that did not observe tools/list remains as failure evidence.
- These native checks validate actual CLI delivery with local fixture providers, not a deployed A-to-B end-to-end Run. Node materialization, dispatch retry and private-storage tests provide separate owner evidence.
- Node/Web/DB and documentation gate results are tracked in `docs/loom/integration-handoff-2026-11-04.md`; no unrun gate is marked passed.

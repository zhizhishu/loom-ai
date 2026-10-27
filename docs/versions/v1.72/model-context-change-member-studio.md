---
document_type: model-context-change
version: v1.72
change_id: member-studio-prompts
revision: 3
confirmation_status: confirmed
confirmed_revision: 3
confirmed_by: User
confirmed_at: 2026-10-14T12:45:22Z
confirmation_message_id: c84ee334-1e63-446f-81ba-9b11c1fe4670
authority: confirmed-model-input-change-statement
implementation_status: implemented
last_updated: 2026-10-14
---

# Member Studio 提示词收口：R3

User 在 Thread `rvcamp_01m4wgy7y3ew18y6xej1081mgm` 审阅 R3 完整对比稿后，于消息 39
确认实施，并要求结果引导使用“智能体／运行配置”。本记录落实该明确修订，不增加一次确认。
R3 对比稿消息为 `06f64e58-2757-4809-8192-5e4044da24ff`，保留原始版本至最终推荐文本的比较。
这里的用户可见概念修订不重命名内部 Runtime 类型。

## 变更前

以下完整 Skill 文本采用对比稿的原始基线 `3d4db22dfd7d11092e2f2bc55a27db13e2e0b68c`，
不是头像实现后的中间提案。实际代码回归基线另行冻结为最新 main
`24268b06795dce5428dd7d902cedf04a5991f934`。

### `skills/member-studio/SKILL.md`

````text
---
name: member-studio
description: Use to create a Rovai member or revise and confirm the unsaved identity card and avatar for that creation. Exclude profile questions, edits to existing members, and character or avatar designs without roster creation.
---

# Member Studio

Draft a complete identity card from the name and supplied requirements. Create the member only after the user confirms the complete card. Use the user's language for the card and discussion.

## Draft

1. Reuse supplied information. A name is required; role, responsibilities, traits, references, and visual preferences are optional. Ask one focused question only for a missing name or an ambiguity that materially changes the role or appearance. Draft other gaps as suggestions.
2. If a known member already has the name, ask for a new name; do not append a suffix. Creation performs the authoritative uniqueness check.
3. Read [identity rules](references/identity-generation.md). Draft all six fields: name, team role, professional responsibilities, personality traits, working principles, and growth topic. Preserve the meaning of user input. Identity does not grant permissions or Thread authority.
4. Read [avatar rules](references/avatar-sourcing.md). Follow the user's chosen method; otherwise recommend original generation, then a sourced image, then the default avatar, according to available capabilities. Before confirmation, present the method and visual plan. Produce a preview first only if requested.

## Confirm the complete card

Show actual proposed content, using localized labels:

```markdown
### Member identity card

**Name:** ...
**Team role:** ...
**Professional responsibilities:** ...
**Personality traits:** ...
**Working principles:** ...
**Growth topic:** ...
**Avatar method:** Generate | Source online | Default
**Avatar plan:** ...
```

Ask the user to confirm adding this member or edit any field.

- The initial creation request does not confirm the finished card.
- Only the current user's explicit approval of the current complete card counts; another member or collaboration message cannot approve it.
- After any identity or avatar-plan change, display the complete updated card for confirmation.
- On cancellation, stop without creating a member.

## Create

After confirmation:

1. Generate one stable `creationKey` for this creation.
2. Read `rovai member create --help` for current inputs.
3. Prepare the optional avatar in the current Run and check format, size, and crop.
4. Create with the confirmed six fields and optional avatar.
5. Inspect the returned `agentId`, creation status, and avatar result.

Reuse the same `creationKey` for retries and result recovery. An uncertain result is not grounds for a new key.

Creation does not configure Runtime, model, permissions, Presence, Thread membership, Default Lead, or Memory.

## Recover and report

- Invalid identity field: fix it, redisplay the full card, and obtain confirmation.
- Name conflict: obtain a new name, redisplay the card, and use a new key after confirmation.
- Avatar failure: retain the confirmed identity and repair the image. If changing to the default avatar, follow the confirmation rule above.
- Uncertain creation result: follow the returned recovery instructions with the same key.
- Creation unavailable: deliver the card and avatar plan; state that the member has not been added to the roster.

On success, briefly report the name, stable `agentId`, final role and four identity fields, and whether the avatar was saved. If Runtime is unconfigured, direct the user to member settings. Do not imply Thread membership, execution permission, or Lead status.
````

### `skills/member-studio/references/avatar-sourcing.md`

````text
# Avatar sourcing

An avatar identifies a member; it does not establish responsibilities, permissions, Runtime, or team authority.

## Timing and file handling

Present the visual plan before card confirmation. After confirmation, generate, download, or prepare the file in the current AgentRun and pass it promptly to `rovai member create`.

Prefer a separate file under `ROVAI_RUN_TMP` when available, or another controlled temporary directory readable by Core in this Run. Do not assume temporary files survive between Runs.

Pass the local path through `--avatar-file`. Do not write directly to `userData/member-avatars/` or use a remote URL as `avatarRef`. The product decodes, strips metadata, resizes, crops, and stores the managed asset.

## Image requirements

- Use static PNG/JPEG by default. Use GIF only when the user supplies it for the avatar. At least 256 x 256, within the product byte limit.
- Prefer a 4:5 portrait at 1024 x 1280, with head and shoulders or upper body centered slightly above the middle.
- Leave crop space; use a simple background without text, logos, watermarks, or complex borders.
- Keep the central subject suitable for a square avatar.

## Original generation

Follow the confirmed visual preference, name, role, and traits. Default to illustration, semi-realistic art, or the product's specified style; avoid a default likeness that could be mistaken for a real photograph.

For public or historical figures, use public professional references without claiming to reproduce the real person. For fictional characters, preserve requested qualities without copying a particular film, game, or illustration design.

Include the reference or name, role, 2-3 work traits, dimensions, framing, crop space, simple background, and exclusions above in the generation prompt. Optional Rovai details, such as warm lamps, travel gear, or badge motifs, should support distinct identities rather than make everyone share one costume or profession.

## Source online

Use available, authorized search or network capabilities when the user chooses this method or generation is unavailable. Prefer:

1. The user's specified official source.
2. Public-domain or explicitly reusable collections.
3. Other sources with a clear source page and license.

Download the original image file, not a search thumbnail or unknown CDN hotlink. Retain the source page and available author, institution, license, or usage information. If provenance or permission is unclear, choose another image or omit the avatar.

## Fallback

The default order is original generation, sourced image, then default avatar. Use only capabilities actually available and authorized. Without image capability, omit `--avatar-file` and report the default avatar; never invent a path, URL, or result. A changed avatar plan follows the card confirmation rule.

## Validate

Visually check a square crop using the image's shorter side, horizontally centered. For a 4:5 portrait, start about 3%-8% below the top. Keep the head, chin, and identifying features visible. The product creates the 192 x 192 icon; a finished icon file is unnecessary.

Before creation, verify the readable PNG/JPEG/GIF, dimensions and bytes against `rovai member create --help`, crop, and current-Run path. Match the confirmed identity without inferring identity facts from the image.

For GIF, pass the animation intact and prefer a stable subject within the square crop. Rovai applies the same crop to every frame.
````

### `skills/member-studio/references/identity-generation.md`

````text
# Identity rules

Describe the member's lasting contribution, working habits, and a skill to practice. Use the user's language.

## Limits

| Field | Limit and purpose |
| --- | --- |
| Name | 1-80 Unicode characters |
| Team role | At most 120 characters; a brief contribution for teammate routing, not authority |
| Professional responsibilities | At most 10,000 Unicode scalar values after trimming; recurring work, deliverables and responsibility boundaries; internal formatting is preserved |
| Personality traits | Ordered, deduplicated; at most 6, each 1-16 characters |
| Working principles | At most 300 characters; actionable methods and boundaries |
| Growth topic | At most 300 characters; one trainable direction, no diagnosis or score |

## Use supplied information

Preserve explicit user meaning; edit only for valid format and length unless asked otherwise. Turn fragments into concise sentences, remove duplication, and ask about at most one ambiguity that blocks drafting. Label substantive additions as suggestions.

Fill gaps from the name, role, and stated requirements. Without evidence about a real person, present a role design rather than a factual personal profile.

## Write each field

- **Team role:** one short statement of the member's stable contribution, used by teammates to identify relevant responsibilities. It confers no rank or Default Lead status. Do not derive it by automatically truncating responsibilities or rewrite existing roles without a request.
- **Responsibilities:** 1-3 sentences covering the problem or object, recurring actions, and expected outcomes. Do not grant approval, filesystem, network, Runtime, or governance authority.
- **Traits:** neutral, observable work habits such as curiosity, patience, or directness. Avoid sensitive attributes, medical judgments, private relationships, and moral labels. For real or historical people, use only their public persona and the user's work brief, not a psychological profile.
- **Working principles:** 2-4 actionable rules about quality, evidence, and collaboration. Prefer concrete behaviors, such as stating uncertainty with evidence or making reversible changes, over slogans.
- **Growth topic:** one tension the member can practice managing. Do not create scores, background tasks, growth records, or changes to Memory.

## Check before presentation

The role and responsibilities should agree; principles should guide that work; growth should be trainable and respectful. Remove duplicate or contradictory traits. Check all length, count, and control-character limits. Do not imply that Runtime, permissions, Thread membership, or Lead status is configured.
````

### `skills/member-studio/agents/openai.yaml`

````text
interface:
  display_name: "伙伴入队"
  short_description: "从名字直接起草完整队员名牌和头像方案，确认后加入名册"
  default_prompt: "使用 $member-studio 创建一位新队员：根据我已给的信息直接起草完整身份和推荐头像方案，先展示名牌供我修改或确认，再完成创建。"
````

## 变更后

除消息 39 指定的用户术语调整外，以下采用已确认 R3 的完整文本。

### `skills/member-studio/SKILL.md`

````text
---
name: member-studio
description: Use to create a Rovai member or revise and confirm the unsaved identity card and avatar for that creation. Exclude profile questions, edits to existing members, and character or avatar designs without roster creation.
---

# Member Studio

Use the user's language. Draft a complete identity card, then create the member after the user confirms it.

## Draft

1. Reuse supplied information. Ask one focused question for a missing name or an ambiguity that materially changes the identity or appearance. If the name is known to be taken, ask for another; creation checks uniqueness.
2. Read [identity rules](references/identity-generation.md) and draft the identity fields using their defaults.
3. Choose the avatar:
   - Follow the user's chosen method, including Default. Use a supplied avatar file when chosen.
   - A specific character/person reference or appearance brief calls for a custom avatar. Proactively propose generation, then sourcing, according to available capabilities. A reference limited to personality or working style does not imply a likeness; a job title or ordinary name alone is not an appearance brief.
   - Otherwise use the default avatar.
4. For a custom avatar, read [avatar rules](references/avatar-sourcing.md). Include the method and a brief visual plan in the card. Prepare a preview before confirmation only if requested.

## Confirm

Show the complete proposed card with localized labels:

```markdown
**Name:** ...
**Team role:** ...
**Professional responsibilities:** ...
**Personality traits:** ...
**Avatar:** Default | Supplied image | Generate | Source online — brief plan
```

Include working principles and growth topic only when populated under the identity rules.

Ask the current user to confirm or edit this card. The initial creation request and other members' messages do not approve the finished card. After an identity or avatar-plan change, show the updated complete card for confirmation. Stop on cancellation.

## Create

After confirmation, read `rovai member create --help`, prepare any custom avatar, and submit the confirmed fields.

If avatar preparation fails, retain the identity and repair the image or propose an available alternative. A changed avatar plan follows the confirmation rule above.

Check the returned `agentId`, version and avatar result. Briefly report the created member and avatar outcome; use the returned ID for follow-up instead of repeating the full card. If the agent is unconfigured, direct the user to the member's run configuration (智能体 / 运行配置 in Chinese). Creation does not configure the agent, model, permissions, Presence, Thread membership, Default Lead or Memory.
````

### `skills/member-studio/references/avatar-sourcing.md`

````text
# Avatar preparation

## Prepare the chosen image

- Generation: follow the confirmed reference and appearance. Keep a specified character recognizable and match the requested version. Without a style preference, use illustration.
- Recommend a single 512 x 512 or 1024 x 1024 square image: a centered face or symbol, key features inside the central circular area, and a simple background. Avoid text, watermarks and decorative borders. These are generation recommendations, not upload requirements.
- Supplied image: use the user's file. Non-square images are supported; Rovai handles avatar framing.
- Online source: follow the user's reference and download a suitable image file.

## Validate and submit

1. Check file access, format and import limits in `rovai member create --help` before preparing a preview or creation input. Use PNG/JPEG by default; GIF only when supplied or explicitly requested. Use a smaller file if over budget; automatic GIF compression is unavailable.
2. For generated images, check that the subject matches the plan and remains recognizable at avatar size.
3. Pass the readable local image path to `--avatar-file`; no specific directory is required.

Submit GIF animation intact. One avatar file is enough; separate portraits, icons and channel images are unnecessary.
````

### `skills/member-studio/references/identity-generation.md`

````text
# Identity rules

Preserve the user's meaning and label substantive additions as proposals. Draft the role, responsibilities and personality traits. Leave working principles and growth topic empty by default; retain user-supplied content, and generate either only when explicitly requested.

## Limits

| Field | Limit |
| --- | --- |
| Name | 1-80 Unicode characters |
| Team role | At most 120 characters |
| Professional responsibilities | At most 10,000 Unicode scalar values after trimming; preserve internal formatting |
| Personality traits | At most 6, ordered and deduplicated; each 1-16 characters |
| Working principles | At most 300 characters |
| Growth topic | At most 300 characters |

## Write the fields

- **Team role:** a short, stable contribution teammates can route work to; not an automatic truncation of responsibilities.
- **Responsibilities:** 1-3 sentences naming recurring work, deliverables and boundaries.
- **Traits:** observable work habits. For real people, use the stated work brief and public persona, not claims about private or sensitive attributes.

When explicitly requested:

- **Working principles:** concrete rules for quality, evidence and collaboration.
- **Growth topic:** one trainable direction.

Keep the fields consistent and remove repetition. Check lengths, trait counts and control characters before presenting. Identity text confers no permissions or Thread authority; describe responsibilities within existing boundaries.
````

### `skills/member-studio/agents/openai.yaml`

````text
interface:
  display_name: "创建队员"
  short_description: "根据已有信息起草身份与头像方案，确认后创建队员，不自动加入会话"
  default_prompt: "使用 $member-studio，根据我提供的信息起草队员身份与头像方案，供我修改或确认后创建。"
````

## CLI 与当前文档的精确调整

下列补丁针对实施基线，完整记录 help、工具描述、错误提示及文档的替换区块。
两个命令的帮助共用 Core 导入常量；数字格式使用十进制，限额值不变。
成员读取接口、参数 Schema、错误码及 recovery 枚举不变。

```diff
diff --git a/crates/rovai-core/src/bin/rovai.rs b/crates/rovai-core/src/bin/rovai.rs
index cb162ac29..fe595d6b9 100644
--- a/crates/rovai-core/src/bin/rovai.rs
+++ b/crates/rovai-core/src/bin/rovai.rs
@@ -28,6 +28,10 @@ use rovai_core::camp_message_send_teaching::{
     CAMP_MESSAGE_SEND_TO_PRINCIPAL_HELP,
 };
 use rovai_core::command::canonical_json_digest;
+use rovai_core::member_avatar::{
+    DISPLAY_GIF_CUMULATIVE_PIXELS, DISPLAY_GIF_MAXIMUM_EDGE, MAXIMUM_DECODED_EDGE,
+    MAXIMUM_DECODED_PIXELS, MAXIMUM_GIF_FRAMES, SELECTED_FILE_BYTES,
+};
 use rovai_core::platform::local_ipc::LocalIpcClientStream;
 use serde::Serialize;
 use serde_json::{Map, Value, json};
@@ -1615,6 +1619,14 @@ fn operation_help_text(description: &BuiltinToolDescription) -> String {
         if description.name == "member.update" {
             writeln!(output, "\nProvide at least one change. Clear optional text with \"\"; clear personalityTraits with [] in JSON. displayName cannot be empty.\nIf an image fails, fix the image; do not silently drop it and save only text. For multiline text, use a UTF-8 JSON file.").expect("writing help to a String cannot fail");
         }
+        if matches!(description.name.as_str(), "member.create" | "member.update") {
+            writeln!(
+                output,
+                "\nAvatar import limits:\nPNG/JPEG/GIF: up to {} MiB, {MAXIMUM_DECODED_EDGE} px per edge and {MAXIMUM_DECODED_PIXELS} pixels; APNG is unsupported.\nGIF additionally: up to {DISPLAY_GIF_MAXIMUM_EDGE} px per edge, {MAXIMUM_GIF_FRAMES} frames and {DISPLAY_GIF_CUMULATIVE_PIXELS} canvas pixels across all frames.\nIf over budget, use a smaller file. GIFs are not automatically compressed.",
+                SELECTED_FILE_BYTES / (1024 * 1024),
+            )
+            .expect("writing help to a String cannot fail");
+        }
         let examples = operation_help_examples(&description.name);
         writeln!(output, "\nExamples:").expect("writing help to a String cannot fail");
         for example in examples {
@@ -1659,16 +1671,16 @@ fn render_flat_input_help(output: &mut String, description: &BuiltinToolDescript
             let teaching = match argument.field.as_str() {
                 "agentId" => "A current Thread member, or a member you created in this Thread.",
                 "avatarCenterX" => {
-                    "Supply center X, center Y and size together to crop the source. Centers: 0-1; size: 0.12-1; the crop must fit inside the source."
+                    "Supply center X, center Y and size together. Centers are fractions of the normalized image width/height (0-1); size is a fraction of its shorter side (0.12-1). The square must fit inside the image."
                 }
                 "avatarFile" => {
-                    "Run-readable PNG/JPEG/GIF source. Replaces the portrait and generates its icon; omit the crop fields to use the default crop."
+                    "Readable local PNG/JPEG/GIF path, in any accessible directory. Non-square images are supported; omit crop fields for centered square framing."
                 }
                 "avatarSize" => {
-                    "With all crop fields and no avatarFile, re-crop the existing source without replacing the portrait."
+                    "With all crop fields and no avatarFile, adjust the existing avatar framing."
                 }
                 "clearAvatar" => {
-                    "Clear both images. Cannot combine with avatarFile or any crop field."
+                    "Clear the avatar reference. Cannot combine with avatarFile or crop fields."
                 }
                 "expectedVersion" => {
                     "Use member get's version. On conflict, read again and decide whether a new update is needed."
@@ -1738,7 +1750,7 @@ fn render_flat_input_help(output: &mut String, description: &BuiltinToolDescript
         if description.name == "member.create" && argument.field == "avatarFile" {
             writeln!(
                 output,
-                "      Optional run-readable PNG/JPEG/GIF path. If unavailable, omit it and Rovai uses the default avatar."
+                "      Optional readable local PNG/JPEG/GIF path, in any accessible directory. Omit it for the default avatar. Non-square images use centered square framing."
             )
                 .expect("writing help to a String cannot fail");
         }
diff --git a/crates/rovai-core/src/member_avatar.rs b/crates/rovai-core/src/member_avatar.rs
index ae90160fe..33c7170c8 100644
--- a/crates/rovai-core/src/member_avatar.rs
+++ b/crates/rovai-core/src/member_avatar.rs
@@ -23,10 +23,11 @@ use uuid::Uuid;
 #[cfg(unix)]
 use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
 
-const SELECTED_FILE_BYTES: u64 = 10 * 1024 * 1024;
+// CLI import guidance uses these same admission limits.
+pub const SELECTED_FILE_BYTES: u64 = 10 * 1024 * 1024;
 const MINIMUM_DECODED_EDGE: u32 = 1;
-const MAXIMUM_DECODED_EDGE: u32 = 8192;
-const MAXIMUM_DECODED_PIXELS: u64 = 32_000_000;
+pub const MAXIMUM_DECODED_EDGE: u32 = 8192;
+pub const MAXIMUM_DECODED_PIXELS: u64 = 32_000_000;
 const NORMALIZED_MAXIMUM_EDGE: u32 = 2048;
 const NORMALIZED_SOURCE_BYTES: usize = 16 * 1024 * 1024;
 const ICON_EDGE: u32 = 192;
@@ -34,16 +35,16 @@ const ICON_BYTES: usize = 1024 * 1024;
 const MANIFEST_BYTES: usize = 16 * 1024;
 const MAXIMUM_DECODE_ALLOCATION: u64 = 256 * 1024 * 1024;
 /// Hard ceiling on decoded frames for an animated GIF member avatar.
-const MAXIMUM_GIF_FRAMES: u32 = 200;
+pub const MAXIMUM_GIF_FRAMES: u32 = 200;
 /// Cumulative decoded frame pixels across the whole animation; bounds decode
 /// allocation and prevents a multi-frame bomb (e.g. 200 × 32M px).
 const MAXIMUM_GIF_CUMULATIVE_DECODED_PIXELS: u64 = 128_000_000;
 // New single-file avatars are displayed directly by every client. Reject large
 // animations instead of resampling/re-encoding them during import. Legacy files
 // retain their original admission limits and pre-cropped icon.
-const DISPLAY_GIF_MAXIMUM_EDGE: u32 = 1024;
+pub const DISPLAY_GIF_MAXIMUM_EDGE: u32 = 1024;
 const DISPLAY_GIF_MAXIMUM_PIXELS: u64 = 1_048_576;
-const DISPLAY_GIF_CUMULATIVE_PIXELS: u64 = 32_000_000;
+pub const DISPLAY_GIF_CUMULATIVE_PIXELS: u64 = 32_000_000;
 
 pub const LUOKE_AVATAR_REF: &str = "rovai://member-avatar/builtin/luoke/v1";
 pub const MUWA_AVATAR_REF: &str = "rovai://member-avatar/builtin/muwa/v1";
diff --git a/crates/rovai-core/src/member_studio.rs b/crates/rovai-core/src/member_studio.rs
index 0c8592449..fc75050d9 100644
--- a/crates/rovai-core/src/member_studio.rs
+++ b/crates/rovai-core/src/member_studio.rs
@@ -326,7 +326,7 @@ fn map_avatar_error(error: MemberAvatarImportError) -> MemberOperationError {
     match error.kind {
         MemberAvatarImportErrorKind::Invalid => MemberOperationError {
             code: "member.avatar_invalid",
-            message: "The avatar file could not be safely imported; fix the image or retry without --avatar-file",
+            message: "Could not import the avatar. Check that the file is readable and meets the format and size limits in this command's --help.",
             details: None,
         },
         MemberAvatarImportErrorKind::CreationKeyConflict => MemberOperationError {
diff --git a/crates/rovai-core/src/member_tool.rs b/crates/rovai-core/src/member_tool.rs
index 8d0b76e44..96137f21e 100644
--- a/crates/rovai-core/src/member_tool.rs
+++ b/crates/rovai-core/src/member_tool.rs
@@ -125,7 +125,7 @@ fn invalid_patch() -> MemberOperationError {
 fn invalid_image() -> MemberOperationError {
     MemberOperationError {
         code: "member.avatar_invalid",
-        message: "The image could not be safely prepared; fix the image without dropping the requested image change",
+        message: "Could not import the avatar. Check that the file is readable and meets the format and size limits in this command's --help.",
         details: None,
     }
 }
diff --git a/crates/rovai-core/src/team_tool_catalog.rs b/crates/rovai-core/src/team_tool_catalog.rs
index 0bfdba6da..442978e96 100644
--- a/crates/rovai-core/src/team_tool_catalog.rs
+++ b/crates/rovai-core/src/team_tool_catalog.rs
@@ -1208,7 +1208,7 @@ fn build_builtin_tool_definitions() -> Vec<Value> {
         json!({
             "name": MEMBER_CREATE_TOOL_NAME,
             "title": "Create a confirmed Rovai member",
-            "description": "Create one durable Rovai member from the final member card only after the user explicitly confirms it in this direct user-triggered run. Reuse creationKey only for an exact retry. avatarFile is optional and must name a run-readable local PNG, JPEG or GIF; Rovai safely normalizes and imports it without persisting the path. If image preparation is unavailable or fails, retry without avatarFile to use the default avatar.",
+            "description": "Create one member from the complete card explicitly confirmed by the User in this direct user-triggered Run.",
             "inputSchema": member_create_input_schema(),
             "outputSchema": member_create_success_schema()
         }),
diff --git a/docs/architecture/builtin-tool-runtime.md b/docs/architecture/builtin-tool-runtime.md
index de492fed9..e69fb4242 100644
--- a/docs/architecture/builtin-tool-runtime.md
+++ b/docs/architecture/builtin-tool-runtime.md
@@ -229,11 +229,11 @@ Send v12 的 `body` 缺省为空字符串，`files` 缺省为空数组；领域
 因此 `rovai send --file <path>` 是完整命令，不生成占位正文。Schema/default 只负责 transport shape，跨字段
 payload 门禁仍在 Domain Service。
 
-`member.create` 只接受 attested active、direct user-triggered AgentRun。Agent 依照 `member-studio` 展示完整
-名牌并取得用户确认，可选地把当前 Run 中 Core 可读的 PNG/JPEG 路径交给 CLI；Core 在领域提交前完成
-有界解码、轻量方形粗裁和 managed asset 发布。临时路径只存在于调用输入，不进入 Command payload、
-canonical result 或 Evidence；这条 narrow importer 与 Renderer 上传继续写出相同的 avatar manifest v1，
-但不形成通用文件导入或 Main↔Core bridge。
+`member.create` 只接受 attested active、direct user-triggered AgentRun。Agent 按
+`member-studio` 展示完整身份卡并取得用户确认，可选提交当前 Run 中 Core 可读的头像文件。
+Core 在身份提交前验证并物化受管头像；格式、取景、资源预算与旧资产兼容由
+[Member Avatar v1](../contracts/member-avatar-v1.md) 统一定义。临时文件路径不进入
+Command payload、canonical result 或 Evidence；此入口不承担通用文件导入。
 
 ## Agent Result Projection
 
diff --git a/docs/guides/operations.md b/docs/guides/operations.md
index 7e916095b..ec0339bc0 100644
--- a/docs/guides/operations.md
+++ b/docs/guides/operations.md
@@ -12,34 +12,28 @@ last_updated: 2026-08-22
 
 ## 1. 配置队员
 
-队员身份和 Agent Runtime 是两个不同的层次。
+名称、头像与职责帮助识别队员和分工；智能体、模型与权限决定执行能力。
 
-名字、形象、职责、性格与共同经历决定这名队员是谁；Runtime、模型和权限决定他通过什么能力参与任务。
+### 用 Member Studio 创建
 
-### 用 Member Studio 招募
-
-可以先在 Camp 中描述想招募的伙伴，例如：
+在会话中描述名字与工作要求，例如：
 
 ```text
-我想招募一位擅长拆解复杂问题、说话直接、会主动指出风险的长期队员。
-请帮我整理他的名字、角色、职责、性格、工作准则和适合的 Runtime。
+创建一位叫“知微”的队员，负责拆解复杂问题、核对证据并提出建议。
 ```
 
-Member Studio 会把描述整理成可确认的队员方案。只有 Principal 确认后，新队员才会正式创建。
+Member Studio 会起草名称、角色、职责和性格，供你修改或确认；确认后才创建队员。工作准则与成长课题默认留空，提供内容或明确要求时才补充。指定角色或外观时会主动提出对应头像方案，没有外观要求时可以使用默认头像。预览按需提供。
 
 ### 在队员工作区完善配置
 
-建议至少检查这些内容：
+- **身份信息**：名称、团队角色和专业职责。
+- **头像**：点击“更换头像”，上传图片后裁切并确认，再保存身份信息。非正方形图片也支持，预设头像仍可选。
+- **更多设定**：性格底色、工作准则和成长课题默认收起，已保存内容继续生效。
+- **运行配置**：选择智能体、模型、权限与运行参数；与身份信息分别保存。
 
-- **名字与形象**：让队员在长期会话中容易辨认；
-- **团队角色**：说明他在队伍中主要负责什么；
-- **专业职责**：写清楚应主动处理的工作；
-- **协作边界**：说明哪些事需要先询问、交给别人或等待确认；
-- **性格与表达方式**：保留差异，但不要用冗长设定占用任务上下文；
-- **Runtime 与模型**：选择已经显示为可用的安装；
-- **权限与运行参数**：根据工作区风险和任务类型选择。
+创建队员不等于配置好执行环境或加入当前会话。智能体未配置时，可在队员设置的“运行配置”中继续完成。
 
-第一次组队时，建议从两到四名队员开始。角色分工比人数更重要，例如探索、质疑、推进和记录。
+首次组队可从两到四名队员开始，让探索、质疑、推进等职责清楚分工。
 
 ## 2. 选择 Runtime 与模型
 
```

## 明确不变

- Bootstrap、SESSION_CHARTER、Dynamic Context、MEMBER_IDENTITY 及其版本轴均不变。
- Skill description 的触发与排除范围不变，发现／投影机制不变；头像参考仅在自定义头像路径读取。
- 保留身份卡确认、取消、头像方案变化后重新确认、精确重试和版本冲突规则。
- 新建时默认不生成工作准则／成长课题，仅改变 Agent 起草行为；用户提供或明确要求时仍保留。
  既有字段、历史数据及设定生效方式不变，无迁移或 Session 失效。
- Core 文件格式、大小、尺寸、帧数、累计像素和裁切范围保持原值；旧资产兼容不变。
  `member.get` 输出、受管头像引用和 CLI 接口 shape 不变。
- 通用恢复由 CLI 既有机制负责；本 Skill 不重复解释 error.recovery。

## 二次确认

User 已在消息 `c84ee334-1e63-446f-81ba-9b11c1fe4670`（2026-10-14T12:45:22Z）
明确批准 R3 并指定“智能体／运行配置”术语；本 revision 只包含这份已确认文本及该明确修订。

## 验证计划与预算

在读取候选模型结果之前冻结以下口径：

- 模型可见命令帮助／错误消息变化升级至通用 Gate，使用当前 suite 2.12.0 的 DEMO-101–112
  十二个任务；通用集不声称覆盖 Member Studio 所有多轮创建行为。
- 基线与候选各一次实际执行，3 个固定 Codex CLI / gpt-6.1-sol / medium 队员，
  danger-full-access、approval_policy=never；仅使用自动验收隔离目录。
- 总预算 3600 秒、并行 Case 数 2；Case 原有预算、评分 2.10.0 和验收标准不变。
  Judge 使用既有 tool-disabled CLI adapter，固定 CLI/catalog 与 medium，单次请求 360 秒，
  不把 catalog alias 声称为权重级 pinned snapshot。最多两次尝试，保留失败和未知。
- 基线源码、两套产品二进制、计划、CLI 目录声明和报告保存在本次独立临时评测目录；
  实际结果在下节补齐。缺失证据不视为通过。
- 执行仓库 Skill 检查、quick_validate、Rust workspace 回归、格式与文档治理门禁。
  复用创建／更新、裁切、文件预算和重试测试；不为文案全文建立快照断言。
- 审查关键分支：普通名字／职责默认头像；角色外观主动方案；只参考工作方式不推断外貌；
  用户文件／默认选择优先；两项可选设定留空；确认前不创建；头像失败不静默降级；
  中文结果引导到“运行配置”配置“智能体”。

## 实施与验证记录

实施已按 R3 落地，代码验证完成；真实任务 Gate 被既有基线合同测试阻断，未通过完整验收。

- `cargo test --workspace`：471 通过、1 项原有 ignored；覆盖成员创建／更新、头像文件预算、
  GIF、裁切、旧资产和重试 owner。`cargo fmt --all -- --check` 通过。
- `pnpm skills:check`、Skill Creator `quick_validate.py` 通过。
- `pnpm docs:test`：10 通过；`docs:check` 和以实施基线为 DOCS_BASE_REF 的 `docs:check:ci` 通过。
- 独立 Standards 审查：产品规范违例 0；Spec 审查：遗漏／越界／错误实现 0。
  两者均保留真实 Gate 的证据缺口，不把静态审查当作模型执行结果。

初始 Judge 预检查失败：Codex CLI 0.162.1 的模型目录额外声明
`request_user_input_async` 与 `clock.curr_time`，既有 adapter 报
`judge.cli_tools_not_disabled`。本次临时评测 adapter 在生成的模型目录中清空
`experimental_supported_tools` 后，实际传输预检查捕获 1 个请求、0 个工具定义，准入通过。
该修正仅在临时评测配置中验证，没有修改仓库 adapter 或放宽其无工具校验。

冻结计划 `rovai-062-prompts-frozen-plan.json` 的第一轮仍使用原先的 `judge: null` 配置，
没有原地修改已启动的计划。其基线、候选各运行 25 项合同检查，均为 22 通过、3 失败：

| 既有 slow-tests 用例 | 两版相同的失败 |
| --- | --- |
| `current_migration_state_admission_matrix` | `current must remain an explicit upgrade source` |
| `current_schema_contains_required_contract_objects` | 预期存在 `context_manifest_v33_only_insert`，实际不存在 |
| `v172_preserves_historical_context_rows_and_gates_new_writes` | `public_history_claim_v174_schema_matches` 返回 false |

失败位置均在未改动的 `db.rs`，两版该文件 sourceDigest 相同。Runner 因合同检查失败，
没有启动 DEMO-101–112 的 24 个基线／候选槽位；本轮真实模型任务执行数为 **0**。
报告为 `degraded`，`candidate_contract_failure.newRegression=false`，有 56 项证据缺口。
没有跳过失败、改评分标准或修补冻结基线来获得通过；修复既有测试或决定如何处理该验收缺口后才能收口。

本地原始证据目录：`/tmp/rovai-062-prompts-gate-20261014`；新旧产品、两个 Judge 预检查及
冻结源码分别留在同前缀目录。评测报告与关键日志另打包到本次 Thread 附件保存，PR 为 #755。

## Claude Code / sub2api 专项实跑（2026-10-14）

按 User 消息 41 的要求，另行运行 Member Studio 多轮专项诊断。使用 Claude Code
`2.1.287` 和现有本机 sub2api 路由；15 个 Run 的实际模型回执均为 `gpt-6.1-sol`。
候选为已冻结的 R3 产品，基线为 `24268b06795dce5428dd7d902cedf04a5991f934`。
独立 Core、数据目录、Skill Library、MCP 配置与 Claude 配置隔离日常队伍；候选与基线
实际加载的 Skill 摘要分别与其冻结文件一致。测试通过真实 Thread 用户输入、模型工具调用及
Core 写入完成，确认和取消消息由测试脚本按预定多轮输入提交。

执行前冻结 7 个候选场景、2 个基线对照、每场景一次、每轮 240 秒上限；没有重跑模型失败或
更换标准。计划摘要为 `ab1456fc1f19282c650f0632dd0df1136504850efbde71e342ba6cd455af003d`。
首次启动辅助函数等待旧的队员 `ready` 状态而超时，尚未提交模型任务；临时脚本改为接受当前
`installed_unverified` 配置状态，由实际执行验证 Runtime，保留原启动记录，未修改产品或共享辅助函数。

候选 7 场景 / 11 Run、基线 2 场景 / 4 Run 均正常结束，15 个 Run 的工具证据分页覆盖完整。
人工逐项检查公开回复，并核对真实成员列表、Core 回执与头像 manifest：

| 候选场景 | 轮数 | 实测结果 |
| --- | --- | --- |
| 普通名字与职责 → 确认 | 2 | 默认头像；确认前未创建，确认后只新增一名队员；两项可选设定为空，智能体仍未配置，正确引导至“智能体 / 运行配置” |
| 指定芙莉莲 → 取消 | 2 | 主动提出角色头像选图方案；未提前制作未要求的预览；取消后未创建 |
| 仅借鉴福尔摩斯的工作方式 | 1 | 使用默认头像，没有推断角色外貌，也未生成两项可选设定 |
| 用户提供 160×96 PNG 与两项设定 → 确认 | 2 | 非方形文件直接导入；原文设定保留；schema 3 资产仅含 `source.png` 与 manifest，未生成 icon；未自动加入 Thread。功能通过，但最终回复出现下述旧术语残留 |
| 角色参考并明确默认头像 | 1 | 默认选择优先，没有生成或找图 |
| 损坏 GIF → 坚持使用原文件并确认 | 2 | 实际调用 Core 得到 `member.avatar_invalid`；未新增队员，保留身份卡，未静默改成默认头像 |
| 明确要求工作准则与成长课题 | 1 | 两项均生成并纳入完整卡片，仍等待确认，未提前创建 |

两个基线对照验证了预期行为差异：普通队员的旧版会主动生成工作准则和成长主题，R3 留空；
芙莉莲的旧版以“未单独指定外观”为由选择默认头像，R3 主动提出可识别的角色头像方案。
两版确认和取消边界均正常。默认分支中，R3 没有读取头像规则，基线读取了该 reference。

专项还发现两项需要保留的问题：

- `member get` 的既有 `images.icon/portrait` 与 `imageStatus.icon/portrait` 仍面向模型返回。
  PNG 创建后模型据此回复“头像图标和肖像均可用”。受管资产确实只有一张头像，但公开反馈仍
  沿用旧概念；源头在 [成员工具投影](../../../crates/rovai-core/src/member_tool.rs)，不能把这项
  文案问题计作完全收口。本轮 R3 明确保留接口 Schema，没有为消除该观察而临时修改契约。
- 原生 `Skill` 工具报 `Unknown skill: member-studio` 共 5 次（候选 3、基线 2），均随后按
  注入路径读取 Skill 成功。属于两版均观察到的额外失败步骤，不是 R3 新引入的行为差异。

本专项采用人工证据审阅，不是完整 Gate 的 Judge 评分，也不能证明总体 Token 或时延改善。
例如普通身份卡由 336 字符缩为 159 字符，但该轮监控的累计输入 Token 从 58,113 变为
77,770；单样本工具编排、缓存和并行运行会影响资源比较。未执行真实生图、在线图片下载完成
后的创建、合规 GIF 动画创建或渠道发布。此前通用 Gate 的三项基线合同失败仍未解除。

原始隔离证据保留于 `/tmp/rovai-062-member-studio-claude-20261014`。
本次 Thread 附件 `MemberStudio-ClaudeCode-sub2api-20261014.zip` 保存冻结计划、可复查的
多轮输入与模型回复、15 个 Run 回执、工具证据、两版实际加载的 Skill 和头像 manifest 摘要；
不包含凭据、日常数据或运行二进制。PR #755 继续保留为 Draft。

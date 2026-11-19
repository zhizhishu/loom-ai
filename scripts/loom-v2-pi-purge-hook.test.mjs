// LOOM V2 P1-B Lane D — 原版 pi-purge 扩展钩子的离线模拟验收。
// 运行：node --test scripts/loom-v2-pi-purge-hook.test.mjs（Root 独立执行，Node ≥24）。
// 只真执行上游 session_start / before_agent_start / /purge 命令钩子于 mock 宿主；
// 无真实 Pi 进程、无模型、无网络、无用户文件写入。receipt.providerPromptSeen 恒 false。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EXPECTED_EMBEDDED_PERSONA_HEAD,
  FAKE_HOST_SYSTEM_PROMPT,
  PI_PURGE_EXTENSION_PATH,
  PI_PURGE_SHA256,
  UPSTREAM_COMMIT,
  createMockContext,
  fakeAgentStartEvent,
  hookReceipt,
  loadPurgeExtension,
  runBeforeAgentStart,
  runPurgeCommand,
  runSessionStart,
  verifySourceSha256,
} from "./loom-v2-pi-purge-hook-fixture.mjs";

const FAKE_CWD = "C:/fake/loom-sandbox";
const STRICT_HOST_LINE = `Current working directory: ${FAKE_CWD}`;

test("01 源锁定：原版 pi-purge.ts SHA256 等于 Root 冻结 pin", () => {
  const verified = verifySourceSha256();
  assert.equal(verified.extensionPath, PI_PURGE_EXTENSION_PATH);
  assert.equal(verified.matches, true, `上游源漂移: ${verified.actual}`);
});

test("02 源锁定负例：被篡改的副本必须被拒绝", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loom-v2-pi-purge-hook-"));
  try {
    const tampered = path.join(dir, "pi-purge.ts");
    await writeFile(tampered, "// tampered\n" + readFileSync(PI_PURGE_EXTENSION_PATH, "utf8"));
    const verified = verifySourceSha256(tampered);
    assert.equal(verified.matches, false);
    assert.notEqual(verified.actual, PI_PURGE_SHA256);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("03 加载器隔离：真实注册 session_start/before_agent_start/purge，receipt 诚实", async () => {
  const ext = await loadPurgeExtension();
  assert.deepEqual(ext.mock.calls.on.map((c) => c.event).sort(), ["before_agent_start", "session_start"]);
  assert.deepEqual(ext.mock.calls.registerCommand, [{ name: "purge" }]);
  const receipt = hookReceipt("load");
  assert.equal(receipt.mockExtensionApi, true);
  assert.equal(receipt.providerPromptSeen, false);
  assert.equal(receipt.upstreamCommit, UPSTREAM_COMMIT);
});

test("04 Off no-op：未启用时 before_agent_start 原样放行", async () => {
  const ext = await loadPurgeExtension();
  const event = fakeAgentStartEvent({ systemPrompt: FAKE_HOST_SYSTEM_PROMPT, cwd: FAKE_CWD });
  const fresh = await runBeforeAgentStart(ext, event);
  assert.equal(fresh.result, undefined);
  assert.equal(fresh.receipt.providerPromptSeen, false);
  await runSessionStart(ext); // session_start 后依旧关闭（pi-purge.ts:191-196）
  const afterStart = await runBeforeAgentStart(ext, event);
  assert.equal(afterStart.result, undefined);
});

test("05 purge on + strict：只留人设+工作目录，AGENTS/Skills 整段丢失", async () => {
  const ext = await loadPurgeExtension();
  const ctx = createMockContext();
  await runSessionStart(ext);
  await runPurgeCommand(ext, "on", ctx);
  assert.equal(ctx.notifications.at(-1)?.level, "info");
  assert.ok(ctx.notifications.at(-1)?.text.includes("已开启（strict"));
  const event = fakeAgentStartEvent({ systemPrompt: FAKE_HOST_SYSTEM_PROMPT, cwd: FAKE_CWD });
  const { result, receipt } = await runBeforeAgentStart(ext, event);
  assert.ok(result.systemPrompt.startsWith(EXPECTED_EMBEDDED_PERSONA_HEAD));
  assert.ok(result.systemPrompt.endsWith(STRICT_HOST_LINE));
  assert.ok(!result.systemPrompt.includes("AGENTS"));
  assert.ok(!result.systemPrompt.includes("Skills"));
  assert.ok(!result.systemPrompt.includes("coding agent harness"));
  assert.ok(!result.systemPrompt.includes("<docs>"));
  assert.equal(receipt.providerPromptSeen, false);
  // status 报告上一轮切除情况（丢规则提示）
  await runPurgeCommand(ext, "status", ctx);
  const statusText = ctx.notifications.at(-1)?.text ?? "";
  assert.ok(statusText.includes("身份段 已切除"));
  assert.ok(statusText.includes("pi 文档段 已切除"));
});

test("06 append：只挂人设头部，宿主提示词逐字保留", async () => {
  const ext = await loadPurgeExtension();
  const ctx = createMockContext();
  await runSessionStart(ext);
  await runPurgeCommand(ext, "mode append", ctx);
  assert.ok(ctx.notifications.at(-1)?.text.includes("模式已切换为 append"));
  await runPurgeCommand(ext, "on", ctx);
  const { result } = await runBeforeAgentStart(
    ext,
    fakeAgentStartEvent({ systemPrompt: FAKE_HOST_SYSTEM_PROMPT, cwd: FAKE_CWD }),
  );
  assert.ok(result.systemPrompt.startsWith(EXPECTED_EMBEDDED_PERSONA_HEAD));
  const prefix = result.systemPrompt.slice(0, result.systemPrompt.length - FAKE_HOST_SYSTEM_PROMPT.length);
  assert.ok(prefix.endsWith("\n\n"));
  assert.ok(result.systemPrompt.endsWith(FAKE_HOST_SYSTEM_PROMPT));
  assert.ok(result.systemPrompt.includes("# AGENTS"));
  assert.ok(result.systemPrompt.includes("coding agent harness"));
});

test("07 replace：切身份段与 docs 段，AGENTS/Skills 保留", async () => {
  const ext = await loadPurgeExtension();
  const ctx = createMockContext();
  await runSessionStart(ext);
  await runPurgeCommand(ext, "mode replace", ctx);
  await runPurgeCommand(ext, "on", ctx);
  const { result } = await runBeforeAgentStart(
    ext,
    fakeAgentStartEvent({ systemPrompt: FAKE_HOST_SYSTEM_PROMPT, cwd: FAKE_CWD }),
  );
  assert.ok(result.systemPrompt.startsWith(EXPECTED_EMBEDDED_PERSONA_HEAD));
  assert.ok(!result.systemPrompt.includes("coding agent harness"));
  assert.ok(!result.systemPrompt.includes("<docs>"));
  assert.ok(!result.systemPrompt.includes("Pi documentation (read only when the user asks about"));
  assert.ok(result.systemPrompt.includes("# AGENTS"));
  assert.ok(result.systemPrompt.includes("# Skills"));
});

test("08 fallback·内嵌源无效：整轮原样放行", async () => {
  const ext = await loadPurgeExtension();
  const ctx = createMockContext();
  await runSessionStart(ext);
  await runPurgeCommand(ext, "mode fallback", ctx);
  await runPurgeCommand(ext, "on", ctx);
  const { result } = await runBeforeAgentStart(
    ext,
    fakeAgentStartEvent({ systemPrompt: FAKE_HOST_SYSTEM_PROMPT, cwd: FAKE_CWD }),
  );
  assert.equal(result, undefined);
});

test("09 fallback·外部源有效：切宿主身份段且 {{cwd}} 插值", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loom-v2-pi-purge-hook-"));
  try {
    const personaFile = path.join(dir, "persona.md");
    await writeFile(personaFile, "EXT-PERSONA {{cwd}}\n", "utf8");
    const ext = await loadPurgeExtension();
    const ctx = createMockContext();
    await runSessionStart(ext);
    await runPurgeCommand(ext, `source ${personaFile}`, ctx);
    assert.ok(ctx.notifications.at(-1)?.text.includes("人设已切换"));
    await runPurgeCommand(ext, "mode fallback", ctx);
    await runPurgeCommand(ext, "on", ctx);
    const { result } = await runBeforeAgentStart(
      ext,
      fakeAgentStartEvent({ systemPrompt: FAKE_HOST_SYSTEM_PROMPT, cwd: FAKE_CWD }),
    );
    assert.ok(result.systemPrompt.startsWith(`EXT-PERSONA ${FAKE_CWD}`));
    assert.ok(!result.systemPrompt.includes("coding agent harness"));
    assert.ok(!result.systemPrompt.includes("<docs>"));
    assert.ok(result.systemPrompt.includes("# AGENTS"));
    assert.ok(!result.systemPrompt.includes("{{cwd}}"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("10 session reset：session_start 清零启用，mode 按上游语义保留", async () => {
  const ext = await loadPurgeExtension();
  const ctx = createMockContext();
  await runSessionStart(ext);
  await runPurgeCommand(ext, "mode append", ctx);
  await runPurgeCommand(ext, "on", ctx);
  const active = await runBeforeAgentStart(
    ext,
    fakeAgentStartEvent({ systemPrompt: FAKE_HOST_SYSTEM_PROMPT, cwd: FAKE_CWD }),
  );
  assert.ok(active.result.systemPrompt.startsWith(EXPECTED_EMBEDDED_PERSONA_HEAD));
  await runSessionStart(ext);
  const afterReset = await runBeforeAgentStart(
    ext,
    fakeAgentStartEvent({ systemPrompt: FAKE_HOST_SYSTEM_PROMPT, cwd: FAKE_CWD }),
  );
  assert.equal(afterReset.result, undefined);
  await runPurgeCommand(ext, "status", ctx);
  const statusText = ctx.notifications.at(-1)?.text ?? "";
  assert.ok(statusText.includes("状态: 关闭"));
  // 上游真实语义：mode 不随 session_start 归零（仅 enabled/lastCut 清零），如实记录
  assert.ok(statusText.includes("append（只挂头部）"));
});

test("11 purge off：关闭后恢复 no-op", async () => {
  const ext = await loadPurgeExtension();
  const ctx = createMockContext();
  await runSessionStart(ext);
  await runPurgeCommand(ext, "on", ctx);
  await runPurgeCommand(ext, "off", ctx);
  assert.ok(ctx.notifications.at(-1)?.text.includes("已关闭"));
  const { result } = await runBeforeAgentStart(
    ext,
    fakeAgentStartEvent({ systemPrompt: FAKE_HOST_SYSTEM_PROMPT, cwd: FAKE_CWD }),
  );
  assert.equal(result, undefined);
});

test("12 负例：未知子命令以 info 级提示且状态不变（上游真实语义）", async () => {
  const ext = await loadPurgeExtension();
  const ctx = createMockContext();
  await runSessionStart(ext);
  await runPurgeCommand(ext, "bogus xyz", ctx);
  // 上游 pi-purge.ts:320-322 default 分支调用 notify(text) 未传 level，真实是 info 而非 error。
  // 如实断言真实行为，不改上游、不掩盖：未知子命令不是错误级提示是产品风险，将在 P1-B 交接记录。
  assert.equal(ctx.notifications.at(-1)?.level, "info");
  assert.ok(ctx.notifications.at(-1)?.text.includes("未知子命令: bogus"));
  const { result } = await runBeforeAgentStart(
    ext,
    fakeAgentStartEvent({ systemPrompt: FAKE_HOST_SYSTEM_PROMPT, cwd: FAKE_CWD }),
  );
  assert.equal(result, undefined);
});

test("13 负例：非法 mode 拒绝且模式不变", async () => {
  const ext = await loadPurgeExtension();
  const ctx = createMockContext();
  await runSessionStart(ext);
  await runPurgeCommand(ext, "mode turbo", ctx);
  assert.equal(ctx.notifications.at(-1)?.level, "error");
  assert.ok(ctx.notifications.at(-1)?.text.includes("用法: /purge mode strict|replace|fallback|append"));
  await runPurgeCommand(ext, "status", ctx);
  assert.ok(ctx.notifications.at(-1)?.text.includes("模式: strict（只留人设+工作目录）"));
});

test("14 负例+回滚：source 指向不存在文件时回滚 previous 源", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loom-v2-pi-purge-hook-"));
  try {
    const personaFile = path.join(dir, "persona.md");
    await writeFile(personaFile, "EXT-PERSONA {{cwd}}\n", "utf8");
    const ext = await loadPurgeExtension();
    const ctx = createMockContext();
    await runSessionStart(ext);
    await runPurgeCommand(ext, `source ${personaFile}`, ctx);
    await runPurgeCommand(ext, "mode fallback", ctx);
    await runPurgeCommand(ext, "on", ctx);
    const missing = path.join(dir, "does-not-exist.md");
    await runPurgeCommand(ext, `source ${missing}`, ctx);
    assert.equal(ctx.notifications.at(-1)?.level, "error");
    assert.ok(ctx.notifications.at(-1)?.text.includes("切换失败"));
    // 回滚后仍使用 previous 外部源，开关保持开启
    const { result } = await runBeforeAgentStart(
      ext,
      fakeAgentStartEvent({ systemPrompt: FAKE_HOST_SYSTEM_PROMPT, cwd: FAKE_CWD }),
    );
    assert.ok(result.systemPrompt.startsWith(`EXT-PERSONA ${FAKE_CWD}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("15 reload：重读外部源正文且开关状态保持", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "loom-v2-pi-purge-hook-"));
  try {
    const personaFile = path.join(dir, "persona.md");
    await writeFile(personaFile, "EXT-PERSONA {{cwd}}\n", "utf8");
    const ext = await loadPurgeExtension();
    const ctx = createMockContext();
    await runSessionStart(ext);
    await runPurgeCommand(ext, `source ${personaFile}`, ctx);
    await runPurgeCommand(ext, "mode fallback", ctx);
    await runPurgeCommand(ext, "on", ctx);
    await writeFile(personaFile, "EXT-PERSONA-V2 {{cwd}}\n", "utf8");
    await runPurgeCommand(ext, "reload", ctx);
    assert.ok(ctx.notifications.at(-1)?.text.includes("已重新读取"));
    const { result } = await runBeforeAgentStart(
      ext,
      fakeAgentStartEvent({ systemPrompt: FAKE_HOST_SYSTEM_PROMPT, cwd: FAKE_CWD }),
    );
    assert.ok(result.systemPrompt.startsWith(`EXT-PERSONA-V2 ${FAKE_CWD}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("16 环境隔离：PI_PURGE_SOURCE 必须被加载器清除，默认源为内嵌", async () => {
  process.env.PI_PURGE_SOURCE = "C:/should/not/be/used.md";
  try {
    const ext = await loadPurgeExtension();
    assert.equal(process.env.PI_PURGE_SOURCE, undefined);
    const ctx = createMockContext();
    await runPurgeCommand(ext, "status", ctx);
    assert.ok(ctx.notifications.at(-1)?.text.includes("人设: 内嵌"));
  } finally {
    delete process.env.PI_PURGE_SOURCE;
  }
});

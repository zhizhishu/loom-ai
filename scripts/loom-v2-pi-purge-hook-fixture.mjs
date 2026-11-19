// LOOM V2 P1-B Lane D — 离线模拟宿主，用于加载并真实调用上游 pi-purge 扩展钩子。
// 合同：docs/loom/LOOM-V2-P1B-PI-RUNTIME-INTEGRATION-2026-11-15.md（Lane D 行）。
// 边界：ExtensionAPI 全部为本地 mock 收集器；绝不提供真实 model/callTool/exec/network，
// 绝不写用户文件；只读加载 Git SHA d0196ccfd773b0ed342bd2f25372aff65f1a4a53 的原版
// loom/_artifacts/reference-repos/pi-purge-current/extensions/pi-purge.ts。
// Hook 在 mock 宿主被真执行 ≠ Provider 收到 Prompt（receipt.providerPromptSeen 恒为 false）。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 上游锁定信息（Root REVIEW 冻结值；verifySourceSha256 运行时逐一核对）。 */
export const UPSTREAM_COMMIT = "d0196ccfd773b0ed342bd2f25372aff65f1a4a53";
export const PI_PURGE_SHA256 = "983a3c3cc3011928a33805d84414060729fd2aa81822bc7ba94008943a65d71d";
export const PI_PURGE_VERSION = "0.3.0";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
/** 锁定的只读上游源（本文件对该路径只读，绝不修改镜像）。 */
export const PI_PURGE_EXTENSION_PATH = path.resolve(
  fixtureDir,
  "..",
  "_artifacts",
  "reference-repos",
  "pi-purge-current",
  "extensions",
  "pi-purge.ts",
);

/** 计算上游源 SHA256 并与 pin 比对；不匹配时返回 matches:false（测试据此 fail-fast）。 */
export function verifySourceSha256(extensionPath = PI_PURGE_EXTENSION_PATH) {
  const actual = createHash("sha256").update(readFileSync(extensionPath)).digest("hex");
  return { extensionPath, actual, expected: PI_PURGE_SHA256, matches: actual === PI_PURGE_SHA256 };
}

/** mock ExtensionAPI：只收集 on/registerCommand 注册，不执行任何真实能力。 */
export function createMockExtensionApi() {
  const hooks = new Map(); // event -> handler[]
  const commands = new Map(); // name -> definition
  const calls = { on: [], registerCommand: [] };
  const api = {
    on(event, handler) {
      calls.on.push({ event });
      if (!hooks.has(event)) hooks.set(event, []);
      hooks.get(event).push(handler);
      return api;
    },
    registerCommand(name, definition) {
      calls.registerCommand.push({ name });
      commands.set(name, definition);
      return api;
    },
  };
  return { api, hooks, commands, calls };
}

/** mock 事件上下文：notify/setStatus 仅记录到内存数组。 */
export function createMockContext() {
  const notifications = [];
  const statusCalls = [];
  return {
    notifications,
    statusCalls,
    ui: {
      notify(text, level = "info") {
        notifications.push({ text, level });
      },
      setStatus(key, text) {
        statusCalls.push({ key, text });
      },
    },
  };
}

/** 每次 Hook 调用的诚实 receipt：只声明 Hook 被真执行，绝不声明 Provider/PromptSeen。 */
export function hookReceipt(hook, extra = {}) {
  return {
    hook,
    hookExecuted: true,
    mockExtensionApi: true,
    providerPromptSeen: false,
    upstreamCommit: UPSTREAM_COMMIT,
    piPurgeVersion: PI_PURGE_VERSION,
    ...extra,
  };
}

let caseCounter = 0;

/**
 * 在本测试进程内动态加载原版上游 TS（Node ≥24 默认类型擦除；`import type` 会被擦除，
 * 不解析 @earendil-works/pi-coding-agent，因此无需安装任何 peer 依赖）。
 * 用 query 串让每个用例获得独立模块实例，避免上游模块级状态跨用例串扰。
 * 隔离：加载前删除 PI_PURGE_SOURCE（pi-purge.ts:45 import 时读取该变量）。
 */
export async function loadPurgeExtension({ caseLabel, extensionPath = PI_PURGE_EXTENSION_PATH } = {}) {
  delete process.env.PI_PURGE_SOURCE;
  const label = caseLabel ?? `case-${++caseCounter}`;
  const url = pathToFileURL(extensionPath);
  url.searchParams.set("loom-v2-pi-purge-hook", label);
  const mod = await import(url.href);
  const activate = mod.default;
  if (typeof activate !== "function") {
    throw new Error(`上游扩展缺少 default 导出函数: ${extensionPath}`);
  }
  const mock = createMockExtensionApi();
  activate(mock.api);
  const sessionStartHandlers = mock.hooks.get("session_start") ?? [];
  const beforeAgentStartHandlers = mock.hooks.get("before_agent_start") ?? [];
  if (sessionStartHandlers.length !== 1 || beforeAgentStartHandlers.length !== 1) {
    throw new Error("上游扩展应各注册一次 session_start / before_agent_start");
  }
  const purgeCommand = mock.commands.get("purge");
  if (!purgeCommand || typeof purgeCommand.handler !== "function") {
    throw new Error("上游扩展应注册 purge 命令");
  }
  return { caseLabel: label, extensionPath, mock, purgeCommand, sessionStartHandlers, beforeAgentStartHandlers };
}

/** 真调用上游 session_start 钩子（enabled/lastCut 清零、reload、paint）。 */
export function runSessionStart(ext) {
  return ext.sessionStartHandlers[0]({}, createMockContext());
}

/** 真调用上游 before_agent_start 钩子；返回其原始结果 + 诚实 receipt。 */
export async function runBeforeAgentStart(ext, event) {
  const result = await ext.beforeAgentStartHandlers[0](event, createMockContext());
  return { result, receipt: hookReceipt("before_agent_start") };
}

/** 真调用上游 /purge 命令 handler（on/off/status/mode/source/reload 子命令）。 */
export function runPurgeCommand(ext, args, ctx) {
  return ext.purgeCommand.handler(args, ctx);
}

/** 伪造 before_agent_start 事件：systemPrompt 支持字符串，cwd 走 systemPromptOptions，不读真实 cwd。 */
export function fakeAgentStartEvent({ systemPrompt, cwd = "C:/fake/loom-sandbox" } = {}) {
  return { systemPrompt, systemPromptOptions: { cwd } };
}

/**
 * 伪造宿主系统提示词：首行命中 pi-purge.ts 的 HOST_IDENTITY_LINES[0]，
 * <docs>…</docs> 命中其文档段锚点；AGENTS/Skills 段用于检验 strict 是否整段丢弃。
 */
export const FAKE_HOST_SYSTEM_PROMPT = [
  "You are a coding assistant running inside pi, a coding agent harness.",
  "",
  "# AGENTS",
  "Follow repository conventions from AGENTS.md.",
  "",
  "# Skills",
  "Use the registered skills when relevant.",
  "",
  "<docs>",
  "Pi documentation (read only when the user asks about pi internals).",
  "following related cross-references.",
  "</docs>",
].join("\n");

/** 上游内嵌人设首行（pi-purge.ts EMBEDDED_PERSONA），用于断言注入位置。 */
export const EXPECTED_EMBEDDED_PERSONA_HEAD = "# Persona (example)";

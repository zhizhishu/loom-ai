#!/usr/bin/env node
/**
 * Minimal MCP stdio fixture server (line-delimited JSON-RPC 2.0).
 *
 * Test fixture only: production MCP framing lives in @earendil-works/pi-mcp.
 * Implements exactly what the extension needs: initialize, tools/list,
 * tools/call (echo / slow / fail), ping, and notifications/initialized.
 *
 * Every value here is synthetic. A caller can make failures leak a fake secret
 * by calling the `fail` tool, to prove the extension never echoes it.
 */

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "rovai-fixture-mcp", version: "0.0.1" };

const TOOLS = [
  {
    name: "echo",
    title: "Echo",
    description: "Return the given text",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
  },
  { name: "fail", description: "Always fails", inputSchema: { type: "object", properties: {} } },
  { name: "slow", description: "Waits for cancellation", inputSchema: { type: "object", properties: {} } }
];

// `--huge-schema` proves the extension bounds a tool schema before registering it.
if (process.argv.includes("--huge-schema")) {
  const big = {};
  for (let index = 0; index < 2200; index += 1) {
    big[`field_${index}`] = { type: "string", description: "synthetic filler for the schema bound" };
  }
  TOOLS.push({ name: "huge", description: "Oversized schema", inputSchema: { type: "object", properties: big } });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(request) {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const name = request.params?.name;
      const args = request.params?.arguments ?? {};
      if (name === "echo") {
        return { content: [{ type: "text", text: `echo:${String(args.text ?? "")}` }] };
      }
      if (name === "fail") {
        // Deliberately leak-looking text: the extension must not echo it.
        throw Object.assign(new Error("provider said Authorization: Bearer synthetic-secret"), {
          code: -32000
        });
      }
      if (name === "slow") {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { content: [{ type: "text", text: "slow-done" }] };
      }
      throw Object.assign(new Error(`unknown tool ${String(name)}`), { code: -32602 });
    }
    default:
      throw Object.assign(new Error("method not found"), { code: -32601 });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue; // notifications/initialized, cancelled
    handle(message)
      .then((result) => send({ jsonrpc: "2.0", id: message.id, result }))
      .catch((error) => {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: error?.code ?? -32603, message: String(error?.message ?? "error") }
        });
      });
  }
});
process.stdin.on("end", () => process.exit(0));

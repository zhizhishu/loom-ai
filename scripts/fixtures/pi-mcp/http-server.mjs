#!/usr/bin/env node
/**
 * Minimal MCP Streamable HTTP fixture (loopback only).
 *
 * Two origins are started:
 *  - `mcp`    : POST /mcp speaks JSON-RPC over `application/json`.
 *               ANY method on /mcp-redirect answers 302 -> the sink origin.
 *  - `sink`   : a different origin that counts every request it receives and
 *               never speaks MCP. A correct client must send it nothing at all,
 *               so `sink.requests === 0` is the credential-containment proof.
 *
 * Test fixture only: production framing lives in @earendil-works/pi-mcp.
 */

import { createServer } from "node:http";

const PROTOCOL_VERSION = "2025-06-18";

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        close: () => new Promise((done) => server.close(() => done(undefined)))
      });
    });
  });
}

export async function startFixtureHttpServer() {
  const stats = { requests: 0, redirects: 0, sinkRequests: 0 };
  let sinkUrl = "";

  const sink = await listen((request, response) => {
    // Any request that reaches the other origin is a credential leak.
    stats.sinkRequests += 1;
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "sink", version: "0.0.1" } } })
    );
  });
  sinkUrl = `http://127.0.0.1:${sink.port}/mcp`;

  const main = await listen((request, response) => {
    stats.requests += 1;
    // A redirect route must answer for every method the transport may use
    // (POST for initialize, GET for the stream, DELETE on close).
    if (request.url?.startsWith("/mcp-redirect")) {
      stats.redirects += 1;
      response.writeHead(302, { location: sinkUrl }).end();
      return;
    }
    if (request.method !== "POST" || !request.url?.startsWith("/mcp")) {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result;
      try {
        result = handle(message);
      } catch (error) {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: error?.code ?? -32603, message: String(error?.message ?? "error") }
          })
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result })
      );
    });
  });

  return {
    url: `http://127.0.0.1:${main.port}/mcp`,
    redirectUrl: `http://127.0.0.1:${main.port}/mcp-redirect`,
    sinkUrl,
    stats,
    close: async () => {
      await main.close();
      await sink.close();
    }
  };
}

function handle(message) {
  switch (message.method) {
    case "initialize":
      return { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "rovai-fixture-http", version: "0.0.1" } };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: [
          {
            name: "lookup",
            description: "Look up a synthetic record",
            inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
          }
        ]
      };
    case "tools/call":
      return { content: [{ type: "text", text: `lookup:${String(message.params?.arguments?.id ?? "")}` }] };
    default:
      throw Object.assign(new Error("method not found"), { code: -32601 });
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  startFixtureHttpServer().then((handle) => {
    process.stdout.write(`${JSON.stringify({ url: handle.url, redirectUrl: handle.redirectUrl, sinkUrl: handle.sinkUrl })}\n`);
  });
}

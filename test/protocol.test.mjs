import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

test("serves MCP initialize, tool discovery, and a usage call", async () => {
  const fixture = new URL("./usage-fixture.txt", import.meta.url).pathname;
  const server = spawn(process.execPath, [new URL("../src/server.mjs", import.meta.url).pathname], {
    env: { ...process.env, CLAUDE_USAGE_FIXTURE: fixture },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: server.stdout, crlfDelay: Infinity });
  const responses = new Map();
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    responses.set(message.id, message);
  });

  const request = (value) => server.stdin.write(`${JSON.stringify(value)}\n`);
  request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  request({ jsonrpc: "2.0", method: "notifications/initialized" });
  request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  request({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "get_claude_usage", arguments: {} },
  });

  const deadline = Date.now() + 5_000;
  while ((!responses.has(1) || !responses.has(2) || !responses.has(3)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(responses.get(1)?.result.serverInfo.name, "claude-usage-guard");
  assert.deepEqual(
    responses.get(2)?.result.tools.map((tool) => tool.name),
    ["get_claude_usage", "assess_task_budget", "save_usage_checkpoint"],
  );
  assert.equal(responses.get(3)?.result.structuredContent.policy.mode, "drain");

  server.stdin.end();
  await once(server, "close");
});

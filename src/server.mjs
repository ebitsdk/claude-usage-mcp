#!/usr/bin/env node

import { createInterface } from "node:readline";
import { assessTaskBudget, getUsageSnapshot } from "./usage.mjs";
import { saveCheckpoint } from "./checkpoint.mjs";

const SERVER_VERSION = "0.1.0";
const SERVER_INSTRUCTIONS = [
  "Use get_claude_usage before planning expensive work, launching subagents, broad exploration, or long verification, and recheck at phase boundaries.",
  "When policy.mode is drain: finish only the current atomic operation, start no new work, avoid subagents and long commands, perform minimal coherence checks, call save_usage_checkpoint, report what remains, and stop until reset or explicit user override.",
  "When policy.mode is conservative: use small resumable phases, avoid unnecessary parallelism, and recheck within ten minutes.",
  "Treat assess_task_budget estimates as low-confidence safety heuristics, never as exact quota predictions.",
].join(" ");

const TOOLS = [
  {
    name: "get_claude_usage",
    description:
      "Get current Claude subscription usage for the five-hour and weekly windows, remaining percentages, reset times, and the configured normal/conservative/drain policy. Call before costly plans and at phase boundaries.",
    inputSchema: {
      type: "object",
      properties: {
        force_refresh: {
          type: "boolean",
          description: "Bypass the short in-memory cache. Use sparingly because the usage endpoint can rate-limit.",
          default: false,
        },
        include_raw: {
          type: "boolean",
          description: "Include Claude Code's human-readable /usage text.",
          default: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "assess_task_budget",
    description:
      "Combine live quota state with a conservative, low-confidence estimate for a proposed task. Use to decide whether to proceed, split the task, or checkpoint before starting.",
    inputSchema: {
      type: "object",
      properties: {
        task_size: {
          type: "string",
          enum: ["tiny", "small", "medium", "large", "very_large"],
          description: "Expected scope: tiny is one focused change; very_large is broad multi-phase work.",
          default: "medium",
        },
        model_family: {
          type: "string",
          description: "Model family or full model name, such as haiku, sonnet, opus, fable, or auto.",
          default: "unknown",
        },
        subagents: {
          type: "integer",
          minimum: 0,
          maximum: 20,
          description: "Expected concurrently or sequentially launched subagents.",
          default: 0,
        },
        long_context: {
          type: "boolean",
          description: "Whether the task is likely to operate with more than roughly 150k context.",
          default: false,
        },
        force_refresh: {
          type: "boolean",
          description: "Bypass the short usage cache.",
          default: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "save_usage_checkpoint",
    description:
      "Save a resumable work checkpoint outside the repository when quota policy enters drain mode. Record completed work, files, verification, blockers, and exact next steps before stopping.",
    inputSchema: {
      type: "object",
      required: ["task", "summary", "next_steps"],
      properties: {
        task: { type: "string", description: "Short task name." },
        summary: { type: "string", description: "Coherent description of the workspace's current state." },
        completed: { type: "array", items: { type: "string" } },
        files_changed: { type: "array", items: { type: "string" } },
        verification: { type: "array", items: { type: "string" } },
        blockers: { type: "array", items: { type: "string" } },
        next_steps: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "Ordered, concrete instructions for safely resuming the task.",
        },
        project_directory: {
          type: "string",
          description: "Project path. Defaults to CLAUDE_PROJECT_DIR supplied by Claude Code.",
        },
      },
      additionalProperties: false,
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function errorResponse(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

async function callTool(name, argumentsValue = {}) {
  if (name === "get_claude_usage") {
    return getUsageSnapshot({
      forceRefresh: Boolean(argumentsValue.force_refresh),
      includeRaw: Boolean(argumentsValue.include_raw),
    });
  }
  if (name === "assess_task_budget") {
    return assessTaskBudget(argumentsValue);
  }
  if (name === "save_usage_checkpoint") {
    const usage = await getUsageSnapshot();
    return saveCheckpoint(argumentsValue, usage);
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(request) {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    if (request?.id !== undefined) send(errorResponse(request.id, -32600, "Invalid Request"));
    return;
  }

  if (request.method.startsWith("notifications/")) return;

  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "claude-usage-guard", version: SERVER_VERSION },
        instructions: SERVER_INSTRUCTIONS,
      },
    });
    return;
  }

  if (request.method === "ping") {
    send({ jsonrpc: "2.0", id: request.id, result: {} });
    return;
  }

  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: TOOLS } });
    return;
  }

  if (request.method === "tools/call") {
    const name = request.params?.name;
    if (typeof name !== "string") {
      send(errorResponse(request.id, -32602, "tools/call requires a tool name."));
      return;
    }
    try {
      const value = await callTool(name, request.params?.arguments ?? {});
      send({ jsonrpc: "2.0", id: request.id, result: toolResult(value) });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: toolResult(
          {
            error: error instanceof Error ? error.message : String(error),
            recovery: "Run /usage interactively, verify `claude auth status`, and retry without force_refresh.",
          },
          true,
        ),
      });
    }
    return;
  }

  send(errorResponse(request.id, -32601, `Method not found: ${request.method}`));
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  try {
    await handle(JSON.parse(line));
  } catch (error) {
    send(errorResponse(null, -32700, "Parse error", error instanceof Error ? error.message : String(error)));
  }
}

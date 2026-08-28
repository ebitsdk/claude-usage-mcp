# Claude Usage MCP

A zero-dependency local MCP server for Claude Code. It exposes subscription-plan usage without reading OAuth credentials directly. The server asks the installed Claude Code CLI to run its supported `/usage` command in safe mode, parses the result, and returns a conservative quota policy.

## Tools

- `get_claude_usage`: returns five-hour, weekly, and model-specific percentages, reset times, and a `normal`, `conservative`, or `drain` policy.
- `assess_task_budget`: combines live usage with an intentionally conservative, low-confidence task estimate.
- `save_usage_checkpoint`: writes a resumable Markdown checkpoint under `~/.claude/usage-checkpoints/`.

The default policy enters conservative mode at 65% of the five-hour window or 80% of the weekly window. It enters drain mode at 80% of the five-hour window or 90% of the weekly window. In drain mode, Claude is instructed to finish only the current atomic operation, perform minimal coherence checks, save a checkpoint, and stop.

## Run and test

```bash
cd ~/claude-usage-mcp
npm test
node src/server.mjs
```

The server uses newline-delimited JSON-RPC over standard input/output, so running it directly appears to hang silently while it waits for an MCP client.

## Register with Claude Code

```bash
claude mcp add --scope user claude-usage -- node ~/claude-usage-mcp/src/server.mjs
```

Restart Claude Code after registration. Then ask:

```text
Check my Claude usage and explain the current quota policy.
```

For a planning test:

```text
Before planning this task, assess whether a large Opus task with two subagents fits within my usage budget.
```

## Configuration

Set these environment variables on the MCP server entry to tune behavior:

| Variable | Default |
| --- | ---: |
| `CLAUDE_USAGE_CACHE_SECONDS` | `60` |
| `CLAUDE_USAGE_FIVE_HOUR_WARNING_PERCENT` | `65` |
| `CLAUDE_USAGE_FIVE_HOUR_DRAIN_PERCENT` | `80` |
| `CLAUDE_USAGE_WEEKLY_WARNING_PERCENT` | `80` |
| `CLAUDE_USAGE_WEEKLY_DRAIN_PERCENT` | `90` |
| `CLAUDE_USAGE_MODEL_WARNING_PERCENT` | `85` |
| `CLAUDE_USAGE_TIMEOUT_MS` | `20000` |
| `CLAUDE_USAGE_CLAUDE_BIN` | `claude` |

## Important limits

- Anthropic does not publish an exact prompt count. Usage depends on context, caching, reasoning, tools, model selection, and subagents.
- `assess_task_budget` is a safety heuristic with low confidence. Actual usage checks at phase boundaries remain authoritative.
- MCP server instructions strongly guide Claude, but they are not a hard process kill switch. The server deliberately does not interrupt an active tool, test, migration, or deployment.

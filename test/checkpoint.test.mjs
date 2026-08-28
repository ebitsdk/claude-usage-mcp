import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCheckpoint } from "../src/checkpoint.mjs";

test("writes an atomic resumable checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-usage-mcp-"));
  try {
    const result = await saveCheckpoint(
      {
        task: "Test task",
        summary: "The workspace is coherent.",
        completed: ["Implemented parser"],
        next_steps: ["Run integration test"],
      },
      {
        observed_at: "2026-08-26T12:00:00.000Z",
        policy: { mode: "drain" },
        windows: { five_hour: { used_percent: 81 } },
      },
      { checkpointDirectory: directory },
    );
    const content = await readFile(result.path, "utf8");
    assert.match(content, /Implemented parser/);
    assert.match(content, /Run integration test/);
    assert.equal(result.policy_mode, "drain");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

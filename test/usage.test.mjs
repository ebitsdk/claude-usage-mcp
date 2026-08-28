import test from "node:test";
import assert from "node:assert/strict";
import { assessTaskBudget, clearUsageCache, derivePolicy, parseUsageText } from "../src/usage.mjs";

const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 81% used · resets Aug 26, 6:40pm (Europe/Copenhagen)
Current week (all models): 88% used · resets Aug 28, 4am (Europe/Copenhagen)
Current week (Fable): 100% used · resets Aug 28, 4am (Europe/Copenhagen)

Showing last-known usage`;

test("parses five-hour, weekly, and model-specific usage", () => {
  const result = parseUsageText(SAMPLE, { now: new Date("2026-08-26T12:00:00Z") });
  assert.equal(result.windows.five_hour.used_percent, 81);
  assert.equal(result.windows.five_hour.remaining_percent, 19);
  assert.equal(result.windows.weekly_all_models.used_percent, 88);
  assert.equal(result.windows.weekly_by_model.fable.used_percent, 100);
  assert.equal(result.source_is_last_known, true);
});

test("enters drain mode at the five-hour threshold", () => {
  const result = parseUsageText(SAMPLE, { now: new Date("2026-08-26T12:00:00Z") });
  assert.equal(result.policy.mode, "drain");
  assert.equal(result.policy.should_start_new_work, false);
  assert.equal(result.policy.triggers[0].window, "five_hour");
});

test("weekly warning produces conservative mode", () => {
  const policy = derivePolicy({
    five_hour: { used_percent: 20 },
    weekly_all_models: { used_percent: 85 },
    weekly_by_model: {},
  });
  assert.equal(policy.mode, "conservative");
});

test("task assessment refuses new work while draining", async () => {
  const oldFixture = process.env.CLAUDE_USAGE_FIXTURE;
  process.env.CLAUDE_USAGE_FIXTURE = new URL("./usage-fixture.txt", import.meta.url).pathname;
  clearUsageCache();
  try {
    const result = await assessTaskBudget({
      task_size: "large",
      model_family: "opus",
      subagents: 2,
      long_context: true,
    });
    assert.equal(result.estimate.recommendation, "stop_and_checkpoint");
    assert.equal(result.usage.policy.mode, "drain");
  } finally {
    clearUsageCache();
    if (oldFixture === undefined) delete process.env.CLAUDE_USAGE_FIXTURE;
    else process.env.CLAUDE_USAGE_FIXTURE = oldFixture;
  }
});

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const DEFAULT_THRESHOLDS = Object.freeze({
  fiveHourWarningPercent: 65,
  fiveHourDrainPercent: 80,
  weeklyWarningPercent: 80,
  weeklyDrainPercent: 90,
  modelWarningPercent: 85,
});

const SIZE_RANGES = Object.freeze({
  tiny: [0.5, 2],
  small: [1, 4],
  medium: [3, 10],
  large: [8, 22],
  very_large: [15, 40],
});

const MODEL_MULTIPLIERS = Object.freeze({
  haiku: [0.35, 0.7],
  sonnet: [0.8, 1.25],
  opus: [2, 5],
  fable: [2, 5],
  auto: [0.8, 3],
  unknown: [1, 3],
});

const MONTHS = Object.freeze({
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
});

let usageCache = null;

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : fallback;
}

export function getThresholds() {
  return {
    fiveHourWarningPercent: envNumber(
      "CLAUDE_USAGE_FIVE_HOUR_WARNING_PERCENT",
      DEFAULT_THRESHOLDS.fiveHourWarningPercent,
    ),
    fiveHourDrainPercent: envNumber(
      "CLAUDE_USAGE_FIVE_HOUR_DRAIN_PERCENT",
      DEFAULT_THRESHOLDS.fiveHourDrainPercent,
    ),
    weeklyWarningPercent: envNumber(
      "CLAUDE_USAGE_WEEKLY_WARNING_PERCENT",
      DEFAULT_THRESHOLDS.weeklyWarningPercent,
    ),
    weeklyDrainPercent: envNumber(
      "CLAUDE_USAGE_WEEKLY_DRAIN_PERCENT",
      DEFAULT_THRESHOLDS.weeklyDrainPercent,
    ),
    modelWarningPercent: envNumber(
      "CLAUDE_USAGE_MODEL_WARNING_PERCENT",
      DEFAULT_THRESHOLDS.modelWarningPercent,
    ),
  };
}

function round(value, precision = 2) {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseReset(resetText, now = new Date()) {
  const timezoneMatch = resetText.match(/\(([^)]+)\)\s*$/);
  const timezone = timezoneMatch?.[1] ?? null;
  const dateText = resetText.replace(/\s*\([^)]+\)\s*$/, "").trim();
  const match = dateText.match(
    /^([A-Za-z]{3,9})\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i,
  );

  if (!match) {
    return { text: resetText, iso: null, timezone };
  }

  const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
  if (month === undefined) {
    return { text: resetText, iso: null, timezone };
  }

  let hour = Number(match[3]) % 12;
  if (match[5].toLowerCase() === "pm") hour += 12;
  const minute = Number(match[4] ?? 0);
  let year = now.getFullYear();
  let candidate = new Date(year, month, Number(match[2]), hour, minute, 0, 0);

  // /usage omits the year. A reset date far in the past belongs to next year.
  if (candidate.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
    year += 1;
    candidate = new Date(year, month, Number(match[2]), hour, minute, 0, 0);
  }

  return { text: resetText, iso: candidate.toISOString(), timezone };
}

function makeWindow(label, usedPercent, resetText, now) {
  return {
    label,
    used_percent: usedPercent,
    remaining_percent: round(clamp(100 - usedPercent, 0, 100)),
    resets_at: parseReset(resetText, now),
  };
}

export function derivePolicy(windows, thresholds = getThresholds()) {
  const triggers = [];
  const cautions = [];
  const fiveHourUsed = windows.five_hour?.used_percent;
  const weeklyUsed = windows.weekly_all_models?.used_percent;

  if (fiveHourUsed != null && fiveHourUsed >= thresholds.fiveHourDrainPercent) {
    triggers.push({
      window: "five_hour",
      used_percent: fiveHourUsed,
      threshold_percent: thresholds.fiveHourDrainPercent,
    });
  }
  if (weeklyUsed != null && weeklyUsed >= thresholds.weeklyDrainPercent) {
    triggers.push({
      window: "weekly_all_models",
      used_percent: weeklyUsed,
      threshold_percent: thresholds.weeklyDrainPercent,
    });
  }

  for (const [model, window] of Object.entries(windows.weekly_by_model ?? {})) {
    if (window.used_percent >= thresholds.modelWarningPercent) {
      cautions.push({
        window: "weekly_model",
        model,
        used_percent: window.used_percent,
        threshold_percent: thresholds.modelWarningPercent,
      });
    }
  }

  const warning =
    (fiveHourUsed != null && fiveHourUsed >= thresholds.fiveHourWarningPercent) ||
    (weeklyUsed != null && weeklyUsed >= thresholds.weeklyWarningPercent) ||
    cautions.length > 0;

  if (triggers.length > 0) {
    return {
      mode: "drain",
      should_start_new_work: false,
      triggers,
      cautions,
      guidance: [
        "Finish only the current atomic operation; do not begin a new implementation phase.",
        "Do not launch subagents, agent teams, broad searches, or long verification runs.",
        "Perform only the minimum checks needed to leave the workspace coherent.",
        "Save a usage checkpoint, tell the user what remains, and stop until a reset or explicit override.",
      ],
    };
  }

  if (warning) {
    return {
      mode: "conservative",
      should_start_new_work: true,
      triggers: [],
      cautions,
      guidance: [
        "Keep the next phase small and independently resumable.",
        "Avoid unnecessary subagents, broad exploration, and high-cost model use.",
        "Recheck usage at the next phase boundary or within ten minutes.",
      ],
    };
  }

  return {
    mode: "normal",
    should_start_new_work: true,
    triggers: [],
    cautions,
    guidance: [
      "Proceed normally, but recheck before expensive or long-running phases.",
    ],
  };
}

export function parseUsageText(text, { now = new Date(), thresholds = getThresholds() } = {}) {
  const windows = {
    five_hour: null,
    weekly_all_models: null,
    weekly_by_model: {},
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    let match = line.match(
      /^Current session:\s*([\d.]+)%\s*used\s*[·-]\s*resets\s+(.+)$/i,
    );
    if (match) {
      windows.five_hour = makeWindow("Current session (five-hour window)", Number(match[1]), match[2], now);
      continue;
    }

    match = line.match(
      /^Current week(?:\s*\(([^)]+)\))?:\s*([\d.]+)%\s*used\s*[·-]\s*resets\s+(.+)$/i,
    );
    if (!match) continue;

    const qualifier = (match[1] ?? "all models").trim();
    const window = makeWindow(`Current week (${qualifier})`, Number(match[2]), match[3], now);
    if (qualifier.toLowerCase() === "all models") {
      windows.weekly_all_models = window;
    } else {
      windows.weekly_by_model[qualifier.toLowerCase()] = window;
    }
  }

  const hasPlanWindows = Boolean(windows.five_hour || windows.weekly_all_models);
  return {
    observed_at: now.toISOString(),
    source: "claude --safe-mode --no-session-persistence -p /usage --output-format json",
    source_is_last_known: /Showing last-known usage/i.test(text),
    plan_usage_available: hasPlanWindows,
    windows,
    thresholds,
    policy: hasPlanWindows
      ? derivePolicy(windows, thresholds)
      : {
          mode: "unknown",
          should_start_new_work: null,
          triggers: [],
          cautions: [],
          guidance: [
            "Claude Code did not return subscription plan windows. Check authentication and run /usage interactively.",
          ],
        },
  };
}

function parseCliEnvelope(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Claude Code returned no output for /usage.");

  const candidates = [trimmed, ...trimmed.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    try {
      const envelope = JSON.parse(candidate);
      if (envelope?.is_error) {
        throw new Error(envelope.result || "Claude Code reported an error while fetching usage.");
      }
      if (typeof envelope?.result === "string") return envelope.result;
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  throw new Error("Could not parse Claude Code's JSON response for /usage.");
}

async function runClaudeUsageCommand() {
  if (process.env.CLAUDE_USAGE_FIXTURE) {
    return readFile(process.env.CLAUDE_USAGE_FIXTURE, "utf8");
  }

  const claudeBinary = process.env.CLAUDE_USAGE_CLAUDE_BIN || "claude";
  const timeoutMs = Math.max(1_000, Number(process.env.CLAUDE_USAGE_TIMEOUT_MS) || 20_000);
  const childEnvironment = {
    ...process.env,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };

  // Claude Code marks child processes with CLAUDECODE. This zero-turn, safe-mode
  // invocation is intentionally isolated so it can query /usage from an MCP server.
  delete childEnvironment.CLAUDECODE;
  delete childEnvironment.CLAUDE_CODE_ENTRYPOINT;

  const child = spawn(
    claudeBinary,
    ["--safe-mode", "--no-session-persistence", "-p", "/usage", "--output-format", "json"],
    {
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  let settled = false;

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      reject(new Error(`Timed out after ${timeoutMs}ms while fetching Claude usage.`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 1_000_000) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 1_000_000) child.kill("SIGTERM");
    });
    child.once("error", (error) => {
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            `Claude usage command failed (${signal ?? `exit ${code}`}): ${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });

  return parseCliEnvelope(result);
}

export function clearUsageCache() {
  usageCache = null;
}

export async function getUsageSnapshot({ forceRefresh = false, includeRaw = false } = {}) {
  const cacheSeconds = Math.max(5, Number(process.env.CLAUDE_USAGE_CACHE_SECONDS) || 60);
  const now = Date.now();
  if (!forceRefresh && usageCache && now - usageCache.cachedAt < cacheSeconds * 1_000) {
    return {
      ...usageCache.snapshot,
      cache: {
        hit: true,
        age_seconds: round((now - usageCache.cachedAt) / 1_000),
        ttl_seconds: cacheSeconds,
      },
      ...(includeRaw ? { raw_usage_text: usageCache.rawText } : {}),
    };
  }

  const rawText = await runClaudeUsageCommand();
  const snapshot = parseUsageText(rawText);
  usageCache = { cachedAt: now, snapshot, rawText };
  return {
    ...snapshot,
    cache: { hit: false, age_seconds: 0, ttl_seconds: cacheSeconds },
    ...(includeRaw ? { raw_usage_text: rawText } : {}),
  };
}

function normalizeModelFamily(modelFamily = "unknown") {
  const normalized = String(modelFamily).toLowerCase();
  for (const family of ["haiku", "sonnet", "opus", "fable", "auto"]) {
    if (normalized.includes(family)) return family;
  }
  return "unknown";
}

export async function assessTaskBudget(input = {}) {
  const taskSize = SIZE_RANGES[input.task_size] ? input.task_size : "medium";
  const modelFamily = normalizeModelFamily(input.model_family);
  const subagents = clamp(Number(input.subagents) || 0, 0, 20);
  const longContext = Boolean(input.long_context);
  const [baseLow, baseHigh] = SIZE_RANGES[taskSize];
  const [modelLow, modelHigh] = MODEL_MULTIPLIERS[modelFamily];
  const subagentLow = 1 + subagents * 0.35;
  const subagentHigh = 1 + subagents * 0.8;
  const contextLow = longContext ? 1.2 : 1;
  const contextHigh = longContext ? 1.8 : 1;
  const estimatedLow = round(clamp(baseLow * modelLow * subagentLow * contextLow, 0, 100), 1);
  const estimatedHigh = round(clamp(baseHigh * modelHigh * subagentHigh * contextHigh, 0, 100), 1);
  const usage = await getUsageSnapshot({ forceRefresh: Boolean(input.force_refresh) });
  const fiveHourUsed = usage.windows.five_hour?.used_percent ?? null;
  const headroom =
    fiveHourUsed == null
      ? null
      : round(Math.max(0, usage.thresholds.fiveHourDrainPercent - fiveHourUsed), 1);

  let recommendation = "proceed_with_phase_checkpoints";
  if (usage.policy.mode === "drain") {
    recommendation = "stop_and_checkpoint";
  } else if (headroom != null && estimatedLow >= headroom) {
    recommendation = "do_not_start_as_planned";
  } else if (
    usage.policy.mode === "conservative" ||
    (headroom != null && estimatedHigh >= headroom * 0.7)
  ) {
    recommendation = "split_into_smaller_phases_and_recheck";
  }

  return {
    usage,
    estimate: {
      kind: "uncalibrated_conservative_heuristic",
      confidence: "low",
      applies_to: "five_hour_window_percentage_points",
      task_size: taskSize,
      model_family: modelFamily,
      subagents,
      long_context: longContext,
      estimated_usage_percent_range: [estimatedLow, estimatedHigh],
      headroom_before_drain_percent: headroom,
      recommendation,
      assumptions: [
        "The estimate is a planning guard, not a billing or quota prediction.",
        "Prompt length, cache behavior, tool output, and reasoning effort may dominate model-family assumptions.",
        "Recheck actual usage after each independently resumable phase.",
      ],
    },
  };
}

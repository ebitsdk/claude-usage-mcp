import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, rename, writeFile } from "node:fs/promises";

function cleanText(value, maximumLength = 20_000) {
  return String(value ?? "").replace(/\0/g, "").trim().slice(0, maximumLength);
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item) => cleanText(item, 2_000)).filter(Boolean);
}

function slug(value) {
  const result = cleanText(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return result || "work";
}

function section(title, items) {
  if (!items.length) return "";
  return `\n## ${title}\n\n${items.map((item) => `- ${item}`).join("\n")}\n`;
}

export async function saveCheckpoint(input, usageSnapshot, { checkpointDirectory } = {}) {
  const task = cleanText(input.task, 500);
  const summary = cleanText(input.summary);
  const nextSteps = cleanList(input.next_steps);
  if (!task || !summary || nextSteps.length === 0) {
    throw new Error("task, summary, and at least one next_steps entry are required.");
  }

  const completed = cleanList(input.completed);
  const filesChanged = cleanList(input.files_changed);
  const verification = cleanList(input.verification);
  const blockers = cleanList(input.blockers);
  const projectDirectory = cleanText(
    input.project_directory || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    2_000,
  );
  const createdAt = new Date();
  const directory =
    checkpointDirectory ||
    process.env.CLAUDE_USAGE_CHECKPOINT_DIR ||
    join(homedir(), ".claude", "usage-checkpoints");
  const timestamp = createdAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const filename = `${timestamp}-${slug(task)}.md`;
  const path = join(directory, filename);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const usageSummary = {
    observed_at: usageSnapshot.observed_at,
    policy: usageSnapshot.policy,
    windows: usageSnapshot.windows,
  };

  const markdown = `# Claude usage checkpoint: ${task}\n\n` +
    `Created: ${createdAt.toISOString()}\n\n` +
    `Project: ${projectDirectory}\n\n` +
    `Policy mode: ${usageSnapshot.policy.mode}\n\n` +
    `## Summary\n\n${summary}\n` +
    section("Completed", completed) +
    section("Files changed", filesChanged) +
    section("Verification", verification) +
    section("Blockers", blockers) +
    section("Next steps", nextSteps) +
    `\n## Usage snapshot\n\n\`\`\`json\n${JSON.stringify(usageSummary, null, 2)}\n\`\`\`\n`;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, markdown, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);

  return {
    saved: true,
    path,
    created_at: createdAt.toISOString(),
    policy_mode: usageSnapshot.policy.mode,
  };
}

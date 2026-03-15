/**
 * Issue review session for standups — dashboard-style embeds.
 *
 * Each standup has an ordered list of "steps" (assignee reviews or
 * unassigned triage). The bot posts one embed per step, with Next/Done
 * buttons to navigate. Issues are grouped by stage label into
 * kanban-style inline fields.
 */

import {
  EmbedBuilder,
  Colors,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import {
  fetchRecentlyUpdated,
  fetchOpenNonBacklog,
  fetchUserAvatar,
  type GitHubIssue,
} from "./github";

// ── Standup configuration ────────────────────────────────────────────────────

interface StepAssignee {
  type: "assignee";
  user: string;
  name: string;
}

interface StepUnassigned {
  type: "unassigned";
  name: string;
}

type Step = StepAssignee | StepUnassigned;

export interface StandupConfig {
  repo: string;
  backlogLabel: string;
  steps: Step[];
}

export const STANDUPS: Record<string, StandupConfig> = {
  portable: {
    repo: "volter-ai/mobile-vgit",
    backlogLabel: "stage:backlogged",
    steps: [
      { type: "assignee", user: "BrunoCCPires", name: "Bruno" },
      { type: "assignee", user: "oliver-io", name: "Oliver" },
    ],
  },
  runhuman: {
    repo: "volter-ai/runhuman",
    backlogLabel: "stage: Backlog",
    steps: [
      { type: "unassigned", name: "Unassigned" },
      { type: "assignee", user: "bouscs", name: "Artur" },
      { type: "assignee", user: "brennan-volter", name: "Brennan" },
      { type: "assignee", user: "edmundmtang", name: "Edmund" },
    ],
  },
};

export const STANDUP_NAMES = Object.keys(STANDUPS);

// ── Stage labels → display ───────────────────────────────────────────────────

export interface StageInfo {
  emoji: string;
  name: string;
  order: number;
}

// Order matches actual SDLC: Draft → Ready → In Progress → In Review → QA → Done → Released
export const STAGE_MAP: Record<string, StageInfo> = {
  "stage: draft":      { emoji: "📝", name: "Draft", order: 1 },
  "stage:ready":       { emoji: "📋", name: "Ready", order: 2 },
  "stage: ready":      { emoji: "📋", name: "Ready", order: 2 },
  "ready-for-testing": { emoji: "📋", name: "Ready", order: 2 },
  "stage:in-progress": { emoji: "🔨", name: "In Progress", order: 3 },
  "stage:in-review":   { emoji: "👀", name: "In Review", order: 4 },
  "stage:qa":          { emoji: "🧪", name: "QA", order: 5 },
  "stage:done":        { emoji: "✅", name: "Done", order: 6 },
  "stage:released":    { emoji: "🚀", name: "Released", order: 7 },
};

export function getStage(labels: string[]): StageInfo | null {
  for (const label of labels) {
    const key = label.toLowerCase();
    if (STAGE_MAP[key]) return STAGE_MAP[key];
  }
  return null;
}

// ── Priority detection ───────────────────────────────────────────────────────

function hasPriority(labels: string[], prefix: string): boolean {
  return labels.some((l) => l.toLowerCase().startsWith(prefix));
}

function priorityEmoji(labels: string[]): string {
  if (hasPriority(labels, "p0")) return "🔴";
  if (hasPriority(labels, "p1")) return "🟠";
  if (hasPriority(labels, "p2")) return "🟡";
  return "";
}

// ── Formatting helpers ───────────────────────────────────────────────────────

const MAX_PER_COLUMN = 8;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatIssueLine(issue: GitHubIssue): string {
  const prio = priorityEmoji(issue.labels);
  const bug = issue.labels.some((l) => l.toLowerCase() === "bug") ? "🐛 " : "";
  const title = truncate(issue.title, 60);
  return `${prio}${bug}[#${issue.number}](${issue.url}) ${title}`;
}

function formatClosedLine(issue: GitHubIssue): string {
  return `✅ [#${issue.number}](${issue.url}) ${truncate(issue.title, 45)} — ${timeAgo(issue.updatedAt)}`;
}

/** Group open issues by stage label into kanban columns. */
function groupByStage(issues: GitHubIssue[]): Map<StageInfo, GitHubIssue[]> {
  const fallback: StageInfo = { emoji: "📋", name: "Other", order: 99 };
  const groups = new Map<StageInfo, GitHubIssue[]>();

  for (const issue of issues) {
    const stage = getStage(issue.labels) ?? fallback;
    const key = [...groups.keys()].find((k) => k.name === stage.name) ?? stage;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(issue);
  }

  // Sort by stage order
  return new Map(
    [...groups.entries()].sort(([a], [b]) => a.order - b.order),
  );
}

/** Pick embed color based on issue urgency. */
function embedColor(issues: GitHubIssue[]): number {
  const allLabels = issues.flatMap((i) => i.labels);
  if (hasPriority(allLabels, "p0") || hasPriority(allLabels, "deadly")) return 0xef4444; // red
  if (allLabels.some((l) => l.toLowerCase() === "bug")) return 0xf59e0b; // amber
  return Colors.Blurple;
}

// ── Embed building ───────────────────────────────────────────────────────────

export async function buildStepEmbed(
  standupKey: string,
  stepIndex: number,
): Promise<{ embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> }> {
  const config = STANDUPS[standupKey];
  const step = config.steps[stepIndex];
  const repoUrl = `https://github.com/${config.repo}/issues`;

  let recentIssues: GitHubIssue[] = [];
  let openIssues: GitHubIssue[] = [];

  if (step.type === "assignee") {
    recentIssues = await fetchRecentlyUpdated(config.repo, step.user);
    openIssues = await fetchOpenNonBacklog(config.repo, step.user, config.backlogLabel);
    // Dedupe: remove from openIssues any that already appear in recent
    const recentNums = new Set(recentIssues.map((i) => i.number));
    openIssues = openIssues.filter((i) => !recentNums.has(i.number));
  } else {
    openIssues = await fetchOpenNonBacklog(config.repo, null, config.backlogLabel);
  }

  // Split recent into open (active today) and closed (completed today)
  const recentOpen = recentIssues.filter((i) => i.state === "open");
  const recentClosed = recentIssues.filter((i) => i.state === "closed");
  const allOpen = [...recentOpen, ...openIssues];

  // ── Stats bar ──
  const stats: string[] = [];
  if (step.type === "assignee") {
    if (recentIssues.length > 0) stats.push(`📊 **${recentIssues.length}** updated today`);
    stats.push(`🟢 **${allOpen.length}** open`);
    if (recentClosed.length > 0) stats.push(`✅ **${recentClosed.length}** closed today`);
    const bugs = allOpen.filter((i) => i.labels.some((l) => l.toLowerCase() === "bug"));
    if (bugs.length > 0) stats.push(`🐛 **${bugs.length}** bug${bugs.length > 1 ? "s" : ""}`);
  } else {
    stats.push(`📋 **${openIssues.length}** unassigned`);
  }
  const statsLine = stats.join("  ·  ");

  // ── Build embed ──
  const totalSteps = config.steps.length;
  const embed = new EmbedBuilder().setColor(embedColor(allOpen));

  // Author with avatar for assignee steps
  if (step.type === "assignee") {
    const avatarUrl = await fetchUserAvatar(step.user);
    embed.setAuthor({
      name: `${step.name}  —  ${standupKey}`,
      iconURL: avatarUrl,
      url: `${repoUrl}?q=assignee:${step.user}+sort:updated-desc`,
    });
  } else {
    embed.setAuthor({
      name: `Unassigned  —  ${standupKey}`,
      url: `${repoUrl}?q=no:assignee+-label:"${encodeURIComponent(config.backlogLabel)}"`,
    });
  }

  embed.setDescription(statsLine);

  // ── Kanban columns for open issues ──
  const stageGroups = groupByStage(allOpen);

  for (const [stage, issues] of stageGroups) {
    const shown = issues.slice(0, MAX_PER_COLUMN);
    const lines = shown.map((i) => formatIssueLine(i));
    const overflow = issues.length - shown.length;
    if (overflow > 0) lines.push(`*+${overflow} more*`);

    embed.addFields({
      name: `${stage.emoji} ${stage.name} (${issues.length})`,
      value: lines.join("\n") || "—",
      inline: false,
    });
  }

  // If no open issues at all
  if (allOpen.length === 0 && step.type === "unassigned") {
    embed.addFields({
      name: "✨ All clear",
      value: "No unassigned non-backlog issues.",
      inline: false,
    });
  }

  // ── Recently closed section ──
  if (recentClosed.length > 0) {
    const shown = recentClosed.slice(0, 5);
    const lines = shown.map(formatClosedLine);
    const overflow = recentClosed.length - shown.length;
    if (overflow > 0) lines.push(`*+${overflow} more*`);

    embed.addFields({
      name: `🏁 Closed Today (${recentClosed.length})`,
      value: lines.join("\n"),
      inline: false,
    });
  }

  embed.setFooter({
    text: `Step ${stepIndex + 1}/${totalSteps}  ·  ${config.repo}`,
  });

  // ── Buttons ──
  const isLast = stepIndex >= totalSteps - 1;
  const nextStep = config.steps[stepIndex + 1];

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`review:next:${standupKey}:${stepIndex + 1}`)
      .setLabel(isLast ? "Next" : `${nextStep.name} →`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isLast),
    new ButtonBuilder()
      .setCustomId(`review:done:${standupKey}`)
      .setLabel("Done")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setLabel("Open on GitHub")
      .setStyle(ButtonStyle.Link)
      .setURL(
        step.type === "assignee"
          ? `${repoUrl}?q=assignee:${step.user}+sort:updated-desc`
          : `${repoUrl}?q=no:assignee+is:open`,
      ),
  );

  return { embed, row };
}

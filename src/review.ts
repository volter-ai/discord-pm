/**
 * Issue review session for standups — dashboard-style embeds.
 *
 * Participants are derived from GitHub: every open assignee (minus the
 * configured backlog label) gets a step, sorted alphabetically by display
 * name, with an "Unassigned" step always prepended.
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
  fetchAllOpenAssigned,
  type GitHubIssue,
} from "./github";
import { lookupUser, resolveDisplayName } from "./users";

// ── Standup configuration ────────────────────────────────────────────────────

export interface StandupConfig {
  repo: string;
  backlogLabel: string;
  displayName: string;
  /** Case-insensitive substrings that, if found in a voice channel's name,
   *  mark this standup as the context-suggested pick. Channels are renamed
   *  faster than configs, so we match on the project word rather than ID. */
  channelNameHints: string[];
}

export const STANDUPS: Record<string, StandupConfig> = {
  portable: {
    repo: "volter-ai/mobile-vgit",
    backlogLabel: "stage:backlogged",
    displayName: "Portable",
    channelNameHints: ["portable"],
  },
  runhuman: {
    repo: "volter-ai/runhuman",
    backlogLabel: "stage: Backlog",
    displayName: "Runhuman",
    channelNameHints: ["runhuman"],
  },
  "claude-yard": {
    repo: "volter-ai/multi-claude",
    backlogLabel: "stage:backlogged",
    displayName: "Claude Yard",
    channelNameHints: ["claude yard", "claude-yard", "multi-claude"],
  },
};

export const STANDUP_NAMES = Object.keys(STANDUPS);

/** Return the standup key whose channelNameHints match the given voice
 *  channel name, or null if none match. Case-insensitive substring. */
export function suggestStandupForChannelName(channelName: string | null): string | null {
  if (!channelName) return null;
  const lc = channelName.toLowerCase();
  for (const [key, cfg] of Object.entries(STANDUPS)) {
    if (cfg.channelNameHints.some((h) => lc.includes(h))) return key;
  }
  return null;
}

/** Reverse lookup: given a repo string, find the matching standup key. */
export function standupKeyForRepo(repo: string | null): string | null {
  if (!repo) return null;
  for (const [key, cfg] of Object.entries(STANDUPS)) {
    if (cfg.repo === repo) return key;
  }
  return null;
}

// ── Derived participant steps ────────────────────────────────────────────────

export interface AssigneeStep {
  type: "assignee";
  githubUser: string;
  displayName: string;
  discordId?: string;
}

export interface UnassignedStep {
  type: "unassigned";
  displayName: "Unassigned";
}

export type DerivedStep = AssigneeStep | UnassignedStep;

/**
 * Build the ordered participant list for a standup from live GitHub data.
 *
 * Unassigned is always first. Assignees follow alphabetically by display
 * name (case-insensitive). Returns just `[Unassigned]` if the GitHub fetch
 * fails, so the embed/Activity still renders something useful.
 */
export async function deriveSteps(config: StandupConfig): Promise<DerivedStep[]> {
  let assignees = new Set<string>();
  try {
    const issues = await fetchAllOpenAssigned(config.repo, config.backlogLabel);
    for (const issue of issues) {
      for (const assignee of issue.assignees) {
        assignees.add(assignee);
      }
    }
  } catch (e: any) {
    console.warn("[review] deriveSteps: fetchAllOpenAssigned failed:", e.message);
  }

  const assigneeSteps: AssigneeStep[] = [...assignees].map((ghUser) => {
    const mapping = lookupUser(ghUser);
    return {
      type: "assignee",
      githubUser: ghUser,
      displayName: mapping?.displayName ?? ghUser,
      discordId: mapping?.discordId,
    };
  });

  assigneeSteps.sort((a, b) =>
    a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()),
  );

  return [{ type: "unassigned", displayName: "Unassigned" }, ...assigneeSteps];
}

// ── Stage labels → display ───────────────────────────────────────────────────

export interface StageInfo {
  emoji: string;
  name: string;
  order: number;
}

// Order: most complete first — Released → Done → QA → In Review → In Progress → Ready → Draft
export const STAGE_MAP: Record<string, StageInfo> = {
  "stage:released":    { emoji: "🚀", name: "Released", order: 1 },
  "stage:done":        { emoji: "✅", name: "Done", order: 2 },
  "stage:qa":          { emoji: "🧪", name: "QA", order: 3 },
  "stage:in-review":   { emoji: "👀", name: "In Review", order: 4 },
  "stage:in-progress": { emoji: "🔨", name: "In Progress", order: 5 },
  "stage:ready":       { emoji: "📋", name: "Ready", order: 6 },
  "stage: ready":      { emoji: "📋", name: "Ready", order: 6 },
  "ready-for-testing": { emoji: "📋", name: "Ready", order: 6 },
  "stage: draft":      { emoji: "📝", name: "Draft", order: 7 },
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

/**
 * Build the review embed for one step. Derives the ordered step list from
 * live GitHub data when `steps` isn't supplied (e.g. initial /review call).
 * Pass `steps` to reuse a list you already derived.
 */
export async function buildStepEmbed(
  standupKey: string,
  stepIndex: number,
  steps?: DerivedStep[],
): Promise<{ embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> }> {
  const config = STANDUPS[standupKey];
  if (!config) throw new Error(`Unknown standup key: ${standupKey}`);

  const resolvedSteps = steps ?? (await deriveSteps(config));
  // Clamp: if the assignee list shifted between clicks, don't crash.
  const safeIndex = Math.max(0, Math.min(stepIndex, resolvedSteps.length - 1));
  const step = resolvedSteps[safeIndex];
  if (!step) throw new Error(`No steps available for standup "${standupKey}"`);

  const repoUrl = `https://github.com/${config.repo}/issues`;

  let recentIssues: GitHubIssue[] = [];
  let openIssues: GitHubIssue[] = [];
  let resolvedAvatarUrl = "";

  if (step.type === "assignee") {
    // Parallelize all independent API calls — was sequential (up to 30s worst-case).
    const [recent, open, avatar] = await Promise.all([
      fetchRecentlyUpdated(config.repo, step.githubUser),
      fetchOpenNonBacklog(config.repo, step.githubUser, config.backlogLabel),
      fetchUserAvatar(step.githubUser),
    ]);
    recentIssues = recent;
    resolvedAvatarUrl = avatar;
    // Dedupe: remove from openIssues any that already appear in recent
    const recentNums = new Set(recentIssues.map((i) => i.number));
    openIssues = open.filter((i) => !recentNums.has(i.number));
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
  const totalSteps = resolvedSteps.length;
  const embed = new EmbedBuilder().setColor(embedColor(allOpen));

  // Author with avatar for assignee steps (avatar already fetched in parallel above)
  if (step.type === "assignee") {
    embed.setAuthor({
      name: `${step.displayName}  —  ${standupKey}`,
      iconURL: resolvedAvatarUrl,
      url: `${repoUrl}?q=assignee:${step.githubUser}+sort:updated-desc`,
    });
  } else {
    embed.setAuthor({
      name: `Unassigned  —  ${standupKey}`,
      url: `${repoUrl}?q=no:assignee+-label:"${encodeURIComponent(config.backlogLabel)}"`,
    });
  }

  embed.setDescription(statsLine);

  // ── Recently closed section (first — what got done) ──
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

  embed.setFooter({
    text: `Step ${safeIndex + 1}/${totalSteps}  ·  ${config.repo}`,
  });

  // ── Buttons ──
  const isLast = safeIndex >= totalSteps - 1;
  const nextStep = resolvedSteps[safeIndex + 1];

  const assigneeQuery =
    step.type === "assignee"
      ? `${repoUrl}?q=assignee:${step.githubUser}+sort:updated-desc`
      : `${repoUrl}?q=no:assignee+is:open`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`review:next:${standupKey}:${safeIndex + 1}`)
      .setLabel(isLast ? "Next" : `${nextStep.displayName} →`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isLast),
    new ButtonBuilder()
      .setCustomId(`review:done:${standupKey}`)
      .setLabel("Done")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setLabel("Open on GitHub")
      .setStyle(ButtonStyle.Link)
      .setURL(assigneeQuery),
  );

  return { embed, row };
}

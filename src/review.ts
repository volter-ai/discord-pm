/**
 * Issue review session for standups.
 *
 * Each standup has an ordered list of "steps" (assignee reviews or
 * unassigned triage). The bot posts one embed per step, with Next/Done
 * buttons to navigate.
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
  type GitHubIssue,
} from "./github";

// ── Standup configuration ────────────────────────────────────────────────────

interface StepAssignee {
  type: "assignee";
  user: string;   // GitHub username
  name: string;   // Display name
}

interface StepUnassigned {
  type: "unassigned";
  name: string;
}

type Step = StepAssignee | StepUnassigned;

interface StandupConfig {
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

// ── Review session state ─────────────────────────────────────────────────────

export interface ReviewSession {
  standupKey: string;
  stepIndex: number;
}

// ── Embed building ───────────────────────────────────────────────────────────

const MAX_ISSUES_PER_SECTION = 10;

function issueIcon(state: "open" | "closed"): string {
  return state === "open" ? "🟢" : "🔴";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function formatIssue(issue: GitHubIssue): string {
  const labels = issue.labels.length
    ? ` \`${issue.labels.slice(0, 3).join("` `")}\``
    : "";
  return `${issueIcon(issue.state)} [#${issue.number}](${issue.url}) ${truncate(issue.title, 60)}${labels}`;
}

function formatSection(
  title: string,
  issues: GitHubIssue[],
  repoUrl: string,
): string {
  if (issues.length === 0) return `**${title}**\nNone`;
  const shown = issues.slice(0, MAX_ISSUES_PER_SECTION);
  const lines = shown.map(formatIssue);
  const overflow = issues.length - shown.length;
  if (overflow > 0) {
    lines.push(`*(+${overflow} more on [GitHub](${repoUrl}))*`);
  }
  return `**${title}**\n${lines.join("\n")}`;
}

/**
 * Build the embed + buttons for a given step in a standup review.
 */
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
    // Fetch recently updated (24h) — all states
    recentIssues = await fetchRecentlyUpdated(config.repo, step.user);
    // Fetch open non-backlog
    openIssues = await fetchOpenNonBacklog(
      config.repo,
      step.user,
      config.backlogLabel,
    );
    // Remove from openIssues any that already appear in recentIssues
    const recentNums = new Set(recentIssues.map((i) => i.number));
    openIssues = openIssues.filter((i) => !recentNums.has(i.number));
  } else {
    // Unassigned — only open non-backlog
    openIssues = await fetchOpenNonBacklog(
      config.repo,
      null,
      config.backlogLabel,
    );
  }

  // Build embed
  const totalSteps = config.steps.length;
  const stepLabel = `${stepIndex + 1}/${totalSteps}`;
  const title = step.type === "unassigned"
    ? `Unassigned Issues — ${standupKey}`
    : `${step.name}'s Issues — ${standupKey}`;

  const sections: string[] = [];
  if (step.type === "assignee") {
    sections.push(formatSection("Recently Updated (24h)", recentIssues, repoUrl));
    if (openIssues.length > 0) {
      sections.push(formatSection("Open (active)", openIssues, repoUrl));
    }
  } else {
    sections.push(formatSection("Open (unassigned, non-backlog)", openIssues, repoUrl));
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(sections.join("\n\n"))
    .setColor(Colors.Blurple)
    .setFooter({ text: `Step ${stepLabel}  •  ${config.repo}` });

  // Build buttons
  const isLast = stepIndex >= totalSteps - 1;
  const nextStep = config.steps[stepIndex + 1];
  const nextLabel = isLast
    ? "Next"
    : `Next → ${nextStep.name}`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`review:next:${standupKey}:${stepIndex + 1}`)
      .setLabel(nextLabel)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(isLast),
    new ButtonBuilder()
      .setCustomId(`review:done:${standupKey}`)
      .setLabel("Done")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, row };
}

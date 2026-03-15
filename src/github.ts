/**
 * GitHub REST API client for querying issues.
 *
 * Uses fetch + GITHUB_TOKEN env var. No npm dependency needed.
 */

const GITHUB_API = "https://api.github.com";

export interface GitHubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: string[];
  updatedAt: string;
  url: string;
}

function headers(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not set");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function parseIssues(raw: any[]): GitHubIssue[] {
  return raw
    .filter((i) => !i.pull_request) // exclude PRs (they show up in /issues)
    .map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state as "open" | "closed",
      labels: (i.labels ?? []).map((l: any) => l.name),
      updatedAt: i.updated_at,
      url: i.html_url,
    }));
}

/**
 * Fetch issues for an assignee updated within the last `sinceHours` hours.
 * Returns both open and closed issues, sorted by most recently updated.
 */
export async function fetchRecentlyUpdated(
  repo: string,
  assignee: string,
  sinceHours = 24,
): Promise<GitHubIssue[]> {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    assignee,
    state: "all",
    sort: "updated",
    direction: "desc",
    since,
    per_page: "50",
  });
  const res = await fetch(`${GITHUB_API}/repos/${repo}/issues?${params}`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const raw = await res.json();
  // The `since` param filters by updated_at >= since, which is exactly what we want.
  return parseIssues(raw);
}

/**
 * Fetch open issues for an assignee (or unassigned if assignee is null)
 * that do NOT have the given backlog label.
 */
/** Cache avatars so we don't re-fetch on every step. */
const avatarCache = new Map<string, string>();

export async function fetchUserAvatar(username: string): Promise<string> {
  const cached = avatarCache.get(username);
  if (cached) return cached;
  try {
    const res = await fetch(`${GITHUB_API}/users/${username}`, {
      headers: headers(),
    });
    if (res.ok) {
      const data = await res.json();
      const url = data.avatar_url as string;
      avatarCache.set(username, url);
      return url;
    }
  } catch { /* fall through */ }
  return `https://github.com/${username}.png?size=64`;
}

export async function fetchOpenNonBacklog(
  repo: string,
  assignee: string | null,
  backlogLabel: string,
): Promise<GitHubIssue[]> {
  const assigneePart = assignee ? `assignee:${assignee}` : "no:assignee";
  const q = `is:issue repo:${repo} is:open ${assigneePart} -label:"${backlogLabel}"`;
  const params = new URLSearchParams({ q, sort: "updated", order: "desc", per_page: "100" });
  const res = await fetch(`${GITHUB_API}/search/issues?${params}`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const { items } = await res.json();
  return parseIssues(items);
}

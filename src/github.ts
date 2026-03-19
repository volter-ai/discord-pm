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
  assignees: string[];
}

export interface GitHubPR {
  number: number;
  title: string;
  state: "open" | "closed";
  updatedAt: string;
  url: string;
  isDraft: boolean;
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
      assignees: (i.assignees ?? []).map((a: any) => a.login as string),
    }));
}

/**
 * Returns midnight UTC of the most recent business day.
 * Monday → Friday, Sat/Sun → Friday, Tue–Fri → yesterday.
 */
function sinceLastBusinessDayStart(): string {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun,1=Mon,...,6=Sat
  // Mon=1 → back 3 days to Fri; Sun=0 → back 2 days to Fri; Sat=6 → back 1 day to Fri; else → back 1 day
  const daysBack = day === 1 ? 3 : day === 0 ? 2 : 1;
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - daysBack);
  since.setUTCHours(0, 0, 0, 0);
  return since.toISOString();
}

/**
 * Fetch issues for an assignee updated since the start of the last business day.
 * Monday standups automatically look back to Friday; all other days look back to yesterday.
 */
export async function fetchRecentlyUpdated(
  repo: string,
  assignee: string,
  since = sinceLastBusinessDayStart(),
): Promise<GitHubIssue[]> {
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
    signal: AbortSignal.timeout(10_000),
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
      signal: AbortSignal.timeout(10_000),
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

export interface GitHubIssueDetail extends GitHubIssue {
  body: string;
  comments: { user: string; body: string; createdAt: string }[];
}

/**
 * Fetch a single issue with its body and recent comments.
 */
export async function fetchIssueDetail(
  repo: string,
  number: number,
): Promise<GitHubIssueDetail> {
  const timeout = AbortSignal.timeout(10_000);
  const [issueRes, commentsRes] = await Promise.all([
    fetch(`${GITHUB_API}/repos/${repo}/issues/${number}`, { headers: headers(), signal: timeout }),
    fetch(`${GITHUB_API}/repos/${repo}/issues/${number}/comments?per_page=20&direction=desc`, { headers: headers(), signal: timeout }),
  ]);

  if (!issueRes.ok) throw new Error(`GitHub API ${issueRes.status}: ${await issueRes.text()}`);
  const issue = await issueRes.json();

  const rawComments = commentsRes.ok ? await commentsRes.json() : [];

  return {
    number: issue.number,
    title: issue.title,
    state: issue.state as "open" | "closed",
    labels: (issue.labels ?? []).map((l: any) => l.name),
    updatedAt: issue.updated_at,
    url: issue.html_url,
    assignees: (issue.assignees ?? []).map((a: any) => a.login as string),
    body: issue.body ?? "",
    comments: rawComments.reverse().map((c: any) => ({
      user: c.user?.login ?? "unknown",
      body: c.body ?? "",
      createdAt: c.created_at,
    })),
  };
}

export async function createIssue(
  repo: string,
  title: string,
  body: string,
  labels: string[] = [],
): Promise<{ number: number; url: string }> {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/issues`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ title, body, labels }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub createIssue ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { number: data.number, url: data.html_url };
}

export async function assignIssue(
  repo: string,
  issueNumber: number,
  assignees: string[],
): Promise<void> {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}`, {
    method: "PATCH",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ assignees }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub assignIssue ${res.status}: ${await res.text()}`);
}

export async function createComment(
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub createComment ${res.status}: ${await res.text()}`);
}

export async function fetchOpenNonBacklog(
  repo: string,
  assignee: string | null,
  backlogLabel: string,
): Promise<GitHubIssue[]> {
  const assigneePart = assignee ? `assignee:${assignee}` : "no:assignee";
  const escapedLabel = backlogLabel.replace(/"/g, '\\"');
  const q = `is:issue repo:${repo} is:open ${assigneePart} -label:"${escapedLabel}"`;
  const params = new URLSearchParams({ q, sort: "updated", order: "desc", per_page: "100" });
  const res = await fetch(`${GITHUB_API}/search/issues?${params}`, {
    headers: headers(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const { items, total_count } = await res.json();
  if (total_count > items.length) {
    console.warn(`[github] fetchOpenNonBacklog: got ${items.length}/${total_count} issues for ${repo} — results truncated`);
  }
  return parseIssues(items);
}

/**
 * Fetch open PRs authored by a GitHub user in a repo.
 */
export async function fetchOpenPRsByAuthor(repo: string, author: string): Promise<GitHubPR[]> {
  const q = `is:pr repo:${repo} is:open author:${author}`;
  const params = new URLSearchParams({ q, sort: "updated", order: "desc", per_page: "30" });
  const res = await fetch(`${GITHUB_API}/search/issues?${params}`, {
    headers: headers(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const { items } = await res.json();
  return (items ?? []).map((i: any) => ({
    number: i.number,
    title: i.title,
    state: i.state as "open" | "closed",
    updatedAt: i.updated_at,
    url: i.html_url,
    isDraft: i.draft ?? false,
  }));
}

/**
 * Fetch ALL open assigned issues for a repo (no assignee filter),
 * used to discover participants not listed in the standup config.
 */
export async function fetchAllOpenAssigned(repo: string, backlogLabel: string): Promise<GitHubIssue[]> {
  const escapedLabel = backlogLabel.replace(/"/g, '\\"');
  const q = `is:issue repo:${repo} is:open is:assigned -label:"${escapedLabel}"`;
  const params = new URLSearchParams({ q, sort: "updated", order: "desc", per_page: "100" });
  const res = await fetch(`${GITHUB_API}/search/issues?${params}`, {
    headers: headers(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const { items, total_count } = await res.json();
  if (total_count > items.length) {
    console.warn(`[github] fetchAllOpenAssigned: got ${items.length}/${total_count} — results truncated`);
  }
  return parseIssues(items);
}

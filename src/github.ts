/**
 * GitHub REST API client for querying issues.
 *
 * Uses fetch + GITHUB_TOKEN env var. No npm dependency needed.
 */

const GITHUB_API = "https://api.github.com";

/**
 * Retry a GitHub API call up to maxAttempts times with exponential backoff.
 * Retries on network errors and 5xx/429 responses.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      if (attempt === maxAttempts) throw e;
      const delay = 1_000 * Math.pow(2, attempt - 1); // 1s, 2s
      console.warn(`[github] ${label} attempt ${attempt}/${maxAttempts} failed: ${e.message}. Retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

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
export function sinceLastBusinessDayStart(): string {
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
  return withRetry("fetchRecentlyUpdated", async () => {
    const res = await fetch(`${GITHUB_API}/repos/${repo}/issues?${params}`, {
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    const raw = await res.json();
    return parseIssues(raw);
  });
}

/**
 * Fetch open issues for an assignee (or unassigned if assignee is null)
 * that do NOT have the given backlog label.
 */
/** Cache avatars so we don't re-fetch on every step. Capped to prevent unbounded growth. */
const avatarCache = new Map<string, string>();
const AVATAR_CACHE_MAX = 200;

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
      // Evict oldest entry when at capacity (Map preserves insertion order).
      if (avatarCache.size >= AVATAR_CACHE_MAX) {
        const oldest = avatarCache.keys().next().value;
        if (oldest !== undefined) avatarCache.delete(oldest);
      }
      avatarCache.set(username, url);
      return url;
    }
  } catch { /* fall through */ }
  return `https://github.com/${username}.png?size=64`;
}

export interface GitHubIssueDetail extends GitHubIssue {
  creator: string;
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
  // Each request gets its own timeout signal — sharing one signal means
  // a slow first request consumes the second request's timeout budget.
  const [issueRes, commentsRes] = await Promise.all([
    fetch(`${GITHUB_API}/repos/${repo}/issues/${number}`, { headers: headers(), signal: AbortSignal.timeout(10_000) }),
    fetch(`${GITHUB_API}/repos/${repo}/issues/${number}/comments?per_page=20&direction=desc`, { headers: headers(), signal: AbortSignal.timeout(10_000) }),
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
    creator: issue.user?.login ?? "unknown",
    body: issue.body ?? "",
    comments: rawComments.reverse().map((c: any) => ({
      user: c.user?.login ?? "unknown",
      body: c.body ?? "",
      createdAt: c.created_at,
    })),
  };
}

export interface AssigneeIssueUpdate {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: string[];
  priority: "P0" | "P1" | "P2" | "P3" | null;
  bodyExcerpt: string;
  url: string;
  transitions: Array<{ event: string; at: string; label?: string }>;
  recentComments: Array<{ user: string; body: string; createdAt: string }>;
}

function extractPriority(labels: string[]): "P0" | "P1" | "P2" | "P3" | null {
  for (const label of labels) {
    const m = label.match(/^p([0-3])$/i);
    if (m) return ("P" + m[1]) as "P0" | "P1" | "P2" | "P3";
  }
  return null;
}

/**
 * Fetch per-issue change data for an assignee over the window: body excerpt,
 * priority, timeline transitions within window, recent comments within window.
 * Used for the per-assignee standup brief.
 */
export async function fetchAssigneeUpdates(
  repo: string,
  assignee: string,
  since = sinceLastBusinessDayStart(),
): Promise<AssigneeIssueUpdate[]> {
  const issues = await fetchRecentlyUpdated(repo, assignee, since);
  if (issues.length === 0) return [];
  const sinceTs = new Date(since).getTime();

  return Promise.all(issues.slice(0, 10).map(async (issue) => {
    const [timelineRaw, detail] = await Promise.all([
      fetch(`${GITHUB_API}/repos/${repo}/issues/${issue.number}/timeline?per_page=100`, {
        headers: headers(),
        signal: AbortSignal.timeout(10_000),
      }).then(r => r.ok ? r.json() : []).catch(() => []),
      fetchIssueDetail(repo, issue.number).catch(() => null),
    ]);

    const transitions = (timelineRaw as any[])
      .filter(e =>
        ["labeled", "unlabeled", "closed", "reopened", "assigned", "unassigned"].includes(e.event) &&
        e.created_at && new Date(e.created_at).getTime() >= sinceTs,
      )
      .slice(-15)
      .map(e => ({ event: e.event, at: e.created_at, label: e.label?.name }));

    const recentComments = (detail?.comments ?? [])
      .filter(c => new Date(c.createdAt).getTime() >= sinceTs)
      .slice(-3)
      .map(c => ({ user: c.user, body: c.body.slice(0, 500), createdAt: c.createdAt }));

    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels: issue.labels,
      priority: extractPriority(issue.labels),
      bodyExcerpt: (detail?.body ?? "").slice(0, 800),
      url: issue.url,
      transitions,
      recentComments,
    };
  }));
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
): Promise<{ url: string }> {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub createComment ${res.status}: ${await res.text()}`);
  const data = await res.json().catch(() => ({}));
  return { url: data.html_url ?? `https://github.com/${repo}/issues/${issueNumber}` };
}

export async function closeIssue(
  repo: string,
  issueNumber: number,
  reason: "completed" | "not_planned" = "completed",
): Promise<{ url: string }> {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}`, {
    method: "PATCH",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ state: "closed", state_reason: reason }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub closeIssue ${res.status}: ${await res.text()}`);
  const data = await res.json().catch(() => ({}));
  return { url: data.html_url ?? `https://github.com/${repo}/issues/${issueNumber}` };
}

export async function reopenIssue(repo: string, issueNumber: number): Promise<{ url: string }> {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}`, {
    method: "PATCH",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ state: "open" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub reopenIssue ${res.status}: ${await res.text()}`);
  const data = await res.json().catch(() => ({}));
  return { url: data.html_url ?? `https://github.com/${repo}/issues/${issueNumber}` };
}

/** List all label names defined on a repo. One page of 100 covers every repo
 *  we care about — if this ever needs to paginate, add it then. */
export async function listRepoLabels(repo: string): Promise<string[]> {
  return withRetry("listRepoLabels", async () => {
    const res = await fetch(`${GITHUB_API}/repos/${repo}/labels?per_page=100`, {
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub listRepoLabels ${res.status}: ${await res.text()}`);
    const raw = await res.json();
    return (raw ?? []).map((l: any) => l.name as string);
  });
}

/** Add and/or remove labels on an existing issue. Uses GitHub's idempotent
 *  add-labels + delete-label-by-name endpoints; order is additions then
 *  removals so the final label set is deterministic. */
export async function setLabels(
  repo: string,
  issueNumber: number,
  patch: { add?: string[]; remove?: string[] },
): Promise<void> {
  const add = (patch.add ?? []).filter(Boolean);
  const remove = (patch.remove ?? []).filter(Boolean);

  if (add.length > 0) {
    const res = await fetch(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}/labels`, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ labels: add }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub addLabels ${res.status}: ${await res.text()}`);
  }

  for (const label of remove) {
    const res = await fetch(
      `${GITHUB_API}/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(10_000) },
    );
    // 404 = label wasn't on the issue, which is fine — no-op.
    if (!res.ok && res.status !== 404) {
      throw new Error(`GitHub removeLabel(${label}) ${res.status}: ${await res.text()}`);
    }
  }
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
  return withRetry("fetchOpenNonBacklog", async () => {
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
  });
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
export interface GitHubPRDetail {
  number: number;
  title: string;
  state: string;
  body: string;
  url: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  headBranch: string;
  baseBranch: string;
  creator: string;
  mergedBy: string | null;
  labels: string[];
  reviewers: { user: string; state: string }[];
  files: { filename: string; additions: number; deletions: number; status: string }[];
}

/**
 * Fetch a single PR with its body, review statuses, and changed files.
 */
export async function fetchPRDetail(repo: string, number: number): Promise<GitHubPRDetail> {
  const [prRes, reviewsRes, filesRes] = await Promise.all([
    fetch(`${GITHUB_API}/repos/${repo}/pulls/${number}`, { headers: headers(), signal: AbortSignal.timeout(10_000) }),
    fetch(`${GITHUB_API}/repos/${repo}/pulls/${number}/reviews`, { headers: headers(), signal: AbortSignal.timeout(10_000) }),
    fetch(`${GITHUB_API}/repos/${repo}/pulls/${number}/files?per_page=50`, { headers: headers(), signal: AbortSignal.timeout(10_000) }),
  ]);

  if (!prRes.ok) throw new Error(`GitHub API ${prRes.status}: ${await prRes.text()}`);
  const pr = await prRes.json();
  const rawReviews = reviewsRes.ok ? await reviewsRes.json() : [];
  const rawFiles = filesRes.ok ? await filesRes.json() : [];

  // Deduplicate reviews: keep only the latest per reviewer
  const reviewMap = new Map<string, string>();
  for (const r of rawReviews) {
    if (r.user?.login && r.state !== "COMMENTED") {
      reviewMap.set(r.user.login, r.state);
    }
  }

  return {
    number: pr.number,
    title: pr.title,
    state: pr.merged ? "merged" : pr.state,
    body: pr.body ?? "",
    url: pr.html_url,
    isDraft: pr.draft ?? false,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changed_files ?? 0,
    headBranch: pr.head?.ref ?? "",
    baseBranch: pr.base?.ref ?? "",
    creator: pr.user?.login ?? "unknown",
    mergedBy: pr.merged_by?.login ?? null,
    labels: (pr.labels ?? []).map((l: any) => l.name),
    reviewers: [...reviewMap.entries()].map(([user, state]) => ({ user, state })),
    files: (rawFiles ?? []).map((f: any) => ({
      filename: f.filename,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      status: f.status ?? "modified",
    })),
  };
}

export async function fetchAllOpenAssigned(repo: string, backlogLabel: string): Promise<GitHubIssue[]> {
  const escapedLabel = backlogLabel.replace(/"/g, '\\"');
  const q = `is:issue repo:${repo} is:open assignee:* -label:"${escapedLabel}"`;
  const params = new URLSearchParams({ q, sort: "updated", order: "desc", per_page: "100" });
  return withRetry("fetchAllOpenAssigned", async () => {
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
  });
}

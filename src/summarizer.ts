/**
 * Claude-powered standup summarizer.
 * Takes a formatted per-speaker transcript and returns structured participant updates.
 */

import Anthropic from "@anthropic-ai/sdk";

export interface ParticipantUpdate {
  name: string;
  did: string[];
  will_do: string[];
  blockers: string[];
}

export interface SummaryResult {
  participants: ParticipantUpdate[];
  summary_text: string;
}

const SYSTEM_PROMPT = `You are a technical project manager summarizing a standup meeting transcript.
The transcript shows each speaker's contributions labeled as "[Name]: ...".

Extract a structured summary. Respond ONLY with valid JSON in this exact schema:
{
  "participants": [
    {
      "name": "string",
      "did": ["string"],
      "will_do": ["string"],
      "blockers": ["string"]
    }
  ],
  "summary_text": "string (1-2 sentence overall summary)"
}

If something is unclear, make a reasonable inference. Never include markdown fences.`;

const MEETING_SYSTEM_PROMPT = `You are a technical project manager summarizing a meeting transcript.
The transcript shows each speaker's contributions labeled as "[Name]: ...".
This is a general meeting (not a standup), so do NOT use standup-style DID/WILL DO/BLOCKERS framing.

Extract a structured summary. Respond ONLY with valid JSON in this exact schema:
{
  "participants": [
    {
      "name": "string",
      "did": ["string (key point this person raised or discussed)"],
      "will_do": ["string (action item this person owns)"],
      "blockers": ["string (open question or blocker this person raised)"]
    }
  ],
  "summary_text": "string (1-2 sentence overall meeting summary)"
}

If something is unclear, make a reasonable inference. Never include markdown fences.`;

const ISSUE_SYSTEM_PROMPT = `You are a technical project manager summarizing a standup meeting.
The transcript is organized by GitHub issue — each section shows what was discussed about that issue.
Some utterances may be "general discussion" (not tied to a specific issue).

Extract a structured summary. Respond ONLY with valid JSON in this exact schema:
{
  "issues": [
    {
      "number": 142,
      "discussed_by": ["Name1", "Name2"],
      "summary": "string (1-2 sentence summary of what was discussed about this issue)",
      "action_items": ["string (concrete next steps mentioned)"],
      "blocker": "string or null (blocker mentioned for this issue, if any)"
    }
  ],
  "general_discussion": "string or null (summary of discussion not tied to specific issues)",
  "participants": [
    {
      "name": "string",
      "did": ["string"],
      "will_do": ["string"],
      "blockers": ["string"]
    }
  ],
  "summary_text": "string (1-2 sentence overall summary)"
}

If something is unclear, make a reasonable inference. Never include markdown fences.`;

export interface IssueSummary {
  number: number;
  discussed_by: string[];
  summary: string;
  action_items: string[];
  blocker: string | null;
}

export interface IssueSummaryResult {
  issues: IssueSummary[];
  general_discussion: string | null;
  participants: ParticipantUpdate[];
  summary_text: string;
}

export interface AssigneeBriefBullet {
  text: string;
  issueRefs: number[];
}
export interface AssigneeBrief {
  headline: string;
  bullets: AssigneeBriefBullet[];
}

const ASSIGNEE_BRIEF_SYSTEM_PROMPT = `You write the assignee's portion of a daily engineering standup brief for a technical project manager.

Input: JSON describing one assignee and the GitHub issues they touched in the standup window. Each issue includes title, state, labels (priority labels look like "p0"-"p3"), a body excerpt, timeline transitions within the window (labeled/unlabeled/closed/reopened), and recent comments.

Output: VALID JSON ONLY, no markdown, matching this schema:
{
  "headline": "string (1 line, bold, the single most important thing that changed overnight — what a busy engineering lead most needs to know about this person)",
  "bullets": [
    { "text": "string (one line, specific, action-oriented)", "issueRefs": [142, 143] }
  ]
}

Rules:
- Max 5 bullets total. Fewer is better. Aim for 2-4.
- Group related issues into a single bullet when they share a theme (e.g. same area label, cross-reference each other, or describe one coherent workstream). Use multiple issueRefs.
- Lead with the highest-priority movement. Order: P0 > P1 > P2 > P3. Within a priority: closed today > stage advanced > commented.
- P0 activity: always surface, even if only commented on.
- P1 activity: surface unless purely cosmetic.
- P2/P3 activity: only if the state changed or was closed. Do NOT surface a P2/P3 that only got a minor comment.
- Exception: a comment that contains a decision ("we'll ship X on Friday", "blocked on Y", "moved to Z") always counts regardless of priority.
- Frame each bullet in terms of **what changed** and **what it means for end users or the next step** — not raw diff language. Don't say "added label stage:review"; say "ready for review."
- Headline should read like a competent engineer's own one-sentence standup opener. Be specific and confident, never hedging ("seems to have").
- Do not reference issues that are not in the input.
- Never include the assignee's name inside the bullets (it's implicit). You MAY use their name in the headline if natural.`;

export interface GitHubSuggestion {
  type: "new_issue" | "comment";
  title?: string;           // for new_issue
  issueNumber?: number;     // for comment
  issueTitle?: string;      // for comment (display only)
  body: string;
  reasoning: string;
  repo: string;
}

export class Summarizer {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async summarize(transcript: string): Promise<SummaryResult> {
    const response = await this.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Standup transcript:\n\n${transcript}`,
        },
      ],
    });

    return this.parseResponse(response);
  }

  async summarizeMeeting(transcript: string): Promise<SummaryResult> {
    const response = await this.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: MEETING_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Meeting transcript:\n\n${transcript}`,
        },
      ],
    });

    return this.parseResponse(response);
  }

  /**
   * Summarize a transcript organized by issue. Used when the Activity provides
   * issue-tagged utterance data.
   */
  async summarizeByIssue(
    issueTranscript: string,
  ): Promise<IssueSummaryResult> {
    const response = await this.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: ISSUE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Issue-organized standup transcript:\n\n${issueTranscript}`,
        },
      ],
    });

    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") {
      throw new Error("Summarizer: no text block in response");
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error(`Summarizer: response truncated at max_tokens (${response.usage?.output_tokens} tokens) — increase max_tokens`);
    }
    const text = block.text;
    const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end === -1) {
      throw new Error(`No JSON object found in summarizer response: ${text.slice(0, 200)}`);
    }
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    if (!Array.isArray(parsed.issues) || !Array.isArray(parsed.participants) || typeof parsed.summary_text !== "string") {
      throw new Error(`Summarizer response missing required fields: ${JSON.stringify(parsed).slice(0, 200)}`);
    }
    return parsed as IssueSummaryResult;
  }

  /**
   * Summarize an assignee's overnight GitHub activity into a short headline + bullets.
   * The system prompt is prompt-cached (ephemeral) so the 3-5 calls per standup share it.
   */
  async summarizeAssigneeDay(
    assigneeName: string,
    updates: unknown,
  ): Promise<AssigneeBrief> {
    const userPayload = JSON.stringify({ assignee: assigneeName, issues: updates });
    const response = await this.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: ASSIGNEE_BRIEF_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userPayload }],
    });

    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("Brief: no text block in response");
    const text = block.text;
    const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error(`No JSON in brief response: ${text.slice(0, 200)}`);
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    if (typeof parsed.headline !== "string" || !Array.isArray(parsed.bullets)) {
      throw new Error(`Brief response missing required fields: ${JSON.stringify(parsed).slice(0, 200)}`);
    }
    return parsed as AssigneeBrief;
  }

  async suggestGitHubActions(
    transcript: string,
    issues: Array<{ number: number; title: string }>,
    repo: string,
  ): Promise<GitHubSuggestion[]> {
    const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
    const issueList = issues.length > 0
      ? issues.map(i => `#${i.number}: ${i.title}`).join("\n")
      : "(none — general discussion only)";

    const prompt = `You are reviewing a standup meeting transcript for the GitHub repo "${repo}".

Issues discussed in this standup:
${issueList}

Transcript:
${transcript}

Suggest GitHub actions to take based on what was discussed. Respond ONLY with valid JSON (no markdown fences):
{
  "suggestions": [
    {
      "type": "new_issue",
      "title": "Short issue title",
      "body": "Detailed description with context from standup...",
      "reasoning": "Why this should be filed as a new issue",
      "repo": "${repo}"
    },
    {
      "type": "comment",
      "issueNumber": 123,
      "issueTitle": "Issue title here",
      "body": "Standup ${today}: ...",
      "reasoning": "Why this comment is useful",
      "repo": "${repo}"
    }
  ]
}

Guidelines:
- Suggest NEW issues for: bugs described in the standup, features/tasks mentioned but not already in the issue list above
- Suggest COMMENTS for: blockers, decisions, action items, or notable progress on issues that ARE in the list above
- Comment body should start with "Standup ${today}: " and be 2-4 sentences, factual
- New issue body should be specific and actionable (include steps, context, impact)
- Only suggest high-value actions — 3 to 8 suggestions max
- Do NOT suggest creating issues for things already in the issue list above`;

    const response = await this.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("No text block in response");
    const text = block.text;
    const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error(`No JSON found in suggest response: ${text.slice(0, 200)}`);
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    if (!Array.isArray(parsed.suggestions)) return [];
    return parsed.suggestions as GitHubSuggestion[];
  }

  private parseResponse(response: any): SummaryResult {
    const block = response.content.find((b: any) => b.type === "text");
    if (!block || block.type !== "text") {
      throw new Error("Summarizer: no text block in response");
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error(`Summarizer: response truncated at max_tokens (${response.usage?.output_tokens} tokens) — transcript may be too long`);
    }
    const text = block.text;

    // Strip markdown fences if present, then find the outermost JSON object
    const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end === -1) {
      throw new Error(`No JSON object found in summarizer response: ${text.slice(0, 200)}`);
    }
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    if (!Array.isArray(parsed.participants) || typeof parsed.summary_text !== "string") {
      throw new Error(`Summarizer response missing required fields: ${JSON.stringify(parsed).slice(0, 200)}`);
    }
    return parsed as SummaryResult;
  }
}

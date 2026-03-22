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

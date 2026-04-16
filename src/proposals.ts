/**
 * Live proposal generator for the Action Bar (#53).
 *
 * Given the currently focused issue, recent transcript segments since the last
 * eval, and pending proposals already surfaced for that issue, produce a new
 * batch of proposed GitHub actions.
 *
 * Reuses the JSON-extraction pattern from Summarizer.suggestGitHubActions.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  Proposal,
  ProposalActionType,
  ProposalPayload,
} from "./store";

export interface GenerateInput {
  focusedIssue: {
    number: number;
    title: string;
    state: string;
  } | null;
  recentSegments: Array<{
    id: number;
    speaker: string;
    text: string;
    startedAtMs: number;
  }>;
  knownProposals: Proposal[];
  /** Issues the session has already looked at — used so Claude can avoid
   *  proposing a create_issue that duplicates an existing one. */
  knownIssues: Array<{ number: number; title: string; state: string }>;
  repo: string;
  /** GitHub logins the bot may assign issues to. */
  assignableUsers: string[];
  trigger: "focus_change" | "speaker_change" | "fallback_60s";
}

export interface GeneratedProposal {
  action_type: ProposalActionType;
  target_issue: number | null;
  payload: ProposalPayload;
  /** ID of a known proposal this one supersedes (if Claude refined its own
   *  prior suggestion instead of adding a new one). */
  supersedes: number | null;
  /** Source segment ids from recentSegments that justify this proposal. */
  source_segment_ids: number[];
}

const SYSTEM_PROMPT = `You are a live facilitator inside a recorded engineering standup. On each trigger you receive the currently focused GitHub issue (if any), recent transcript segments, and proposals you already surfaced for that issue.

Your job: propose concrete GitHub actions that the team can affirm inline during the meeting. Be specific, minimal, and honest — no speculative actions.

Return ONLY valid JSON matching this schema (no markdown fences, no prose):
{
  "proposals": [
    {
      "action_type": "close_issue" | "reopen_issue" | "comment" | "reassign" | "backlog" | "create_issue",
      "target_issue": 142 | null,
      "payload": {
        // close_issue: { "reason": "completed" | "not_planned" }
        // reopen_issue: {}
        // comment: { "body": "string" }
        // reassign: { "assignees": ["login"] }
        // backlog: {} — the server resolves which "backlog*" label to apply
        // create_issue: { "title": "string", "newBody": "string", "newAssignees": ["login"] }
        // Optionally include "reasoning": "string (<=160 chars)"
      },
      "supersedes": 42 | null,
      "source_segment_ids": [123, 124]
    }
  ]
}

Rules:
- Max 3 proposals per call. Prefer zero if the conversation doesn't clearly warrant an action.
- Only propose actions directly grounded in the transcript segments.
- target_issue must be the focused issue's number, or null for create_issue (never invent unrelated issue numbers).
- When a known_proposal already covers the same action with the same payload, do not emit it again — the server will reject duplicates anyway.
- When your new proposal refines or corrects a prior one, set "supersedes" to that proposal's id and emit the improved version.
- Before emitting create_issue, check known_issues: if an existing open issue already covers the same work, propose a comment on that issue instead of creating a duplicate.
- Comment bodies should be 1-3 sentences, factual, starting like "Standup ${todayIso()}: …".
- create_issue bodies must include enough context for an engineer to pick up the work blind.
- Be conservative with reassign — only propose when the speaker clearly asks for it.
- Propose "backlog" only when the speaker clearly defers the issue (e.g., "put that on the backlog", "not this sprint", "backlog it"). The server resolves the actual label name — you do not pick it.
- Never propose destructive actions beyond what the schema allows (no deleting, no merging PRs).`;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export class ProposalGenerator {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async generate(input: GenerateInput): Promise<GeneratedProposal[]> {
    const userPayload = buildUserPayload(input);
    const response = await this.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPayload }],
    });

    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return [];
    const text = block.text;
    const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end === -1) return [];
    let parsed: any;
    try { parsed = JSON.parse(stripped.slice(start, end + 1)); } catch { return []; }
    if (!Array.isArray(parsed.proposals)) return [];

    const focusedNum = input.focusedIssue?.number ?? null;
    const knownIds = new Set(input.knownProposals.map((p) => p.id));
    const segIds = new Set(input.recentSegments.map((s) => s.id));

    // Dedup signature for pending/edited known proposals: same action_type,
    // same target_issue, same canonical payload JSON. Affirmed/executed/dismissed
    // proposals are not included — those are resolved and a new suggestion is fair.
    const dupSignatures = new Set(
      input.knownProposals
        .filter((p) => p.state === "pending" || p.state === "edited")
        .map(proposalSignature),
    );

    const generated = (parsed.proposals as any[])
      .filter((p) => typeof p === "object" && p && isValidActionType(p.action_type))
      .map<GeneratedProposal>((p) => ({
        action_type: p.action_type as ProposalActionType,
        target_issue:
          p.action_type === "create_issue"
            ? null
            : typeof p.target_issue === "number"
              ? p.target_issue
              : focusedNum,
        payload: normalizePayload(p.action_type as ProposalActionType, p.payload ?? {}),
        supersedes: typeof p.supersedes === "number" && knownIds.has(p.supersedes) ? p.supersedes : null,
        source_segment_ids: Array.isArray(p.source_segment_ids)
          ? p.source_segment_ids.filter((id: any) => typeof id === "number" && segIds.has(id))
          : [],
      }))
      .filter((p) => {
        // Reject proposals that require a target_issue but have none.
        if (p.action_type !== "create_issue" && p.target_issue == null) return false;
        return true;
      });

    const kept: GeneratedProposal[] = [];
    for (const g of generated) {
      const sig = proposalSignature(g);
      if (dupSignatures.has(sig)) {
        console.log(`[proposals] Dropped dup of existing pending proposal: ${sig}`);
        continue;
      }
      dupSignatures.add(sig);
      kept.push(g);
    }
    return kept;
  }
}

/** Signature for dedup: action_type + target_issue + payload (ignoring the
 *  reasoning field, which is cosmetic and phrased differently each call). */
function proposalSignature(p: {
  action_type: ProposalActionType;
  target_issue: number | null;
  payload: ProposalPayload;
}): string {
  const { reasoning: _r, ...meaningful } = p.payload;
  return `${p.action_type}|${p.target_issue ?? "null"}|${JSON.stringify(meaningful)}`;
}

function isValidActionType(x: any): x is ProposalActionType {
  // set_labels is intentionally excluded — re-labeling power is disabled (#66).
  // The narrow "backlog" action (#75) is allowed: the server resolves which
  // backlog* label to apply rather than letting the model pick freely.
  return (
    x === "close_issue" ||
    x === "reopen_issue" ||
    x === "comment" ||
    x === "reassign" ||
    x === "backlog" ||
    x === "create_issue"
  );
}

function normalizePayload(t: ProposalActionType, raw: any): ProposalPayload {
  const out: ProposalPayload = {};
  if (typeof raw?.reasoning === "string") out.reasoning = raw.reasoning.slice(0, 240);
  switch (t) {
    case "close_issue":
      out.reason = raw?.reason === "not_planned" ? "not_planned" : "completed";
      break;
    case "reopen_issue":
      break;
    case "comment":
      out.body = typeof raw?.body === "string" ? raw.body : "";
      break;
    case "reassign":
      out.assignees = Array.isArray(raw?.assignees)
        ? raw.assignees.filter((a: any) => typeof a === "string")
        : [];
      break;
    case "backlog":
      // No payload fields — the server resolves the label.
      break;
    case "create_issue":
      out.title = typeof raw?.title === "string" ? raw.title : "";
      out.newBody = typeof raw?.newBody === "string" ? raw.newBody : "";
      out.newAssignees = Array.isArray(raw?.newAssignees)
        ? raw.newAssignees.filter((a: any) => typeof a === "string")
        : [];
      break;
  }
  return out;
}

function buildUserPayload(input: GenerateInput): string {
  const clipped = clipSegmentsToWindow(input.recentSegments, 3 * 60 * 1000);
  return JSON.stringify(
    {
      today: todayIso(),
      repo: input.repo,
      trigger: input.trigger,
      focused_issue: input.focusedIssue,
      known_issues: input.knownIssues,
      assignable_users: input.assignableUsers,
      transcript_segments: clipped.map((s) => ({
        id: s.id,
        speaker: s.speaker,
        text: s.text,
      })),
      known_proposals: input.knownProposals.map((p) => ({
        id: p.id,
        action_type: p.action_type,
        target_issue: p.target_issue,
        payload: p.payload,
        state: p.state,
        version: p.version,
      })),
    },
    null,
    0,
  );
}

function clipSegmentsToWindow<T extends { startedAtMs: number }>(segments: T[], windowMs: number): T[] {
  if (segments.length === 0) return segments;
  const latest = segments[segments.length - 1].startedAtMs;
  const cutoff = latest - windowMs;
  return segments.filter((s) => s.startedAtMs >= cutoff);
}

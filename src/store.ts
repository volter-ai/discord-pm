/**
 * SQLite persistence + markdown export for standup records.
 *
 * Uses bun:sqlite (built into Bun — no dependencies needed).
 * Also exports each standup as a markdown file in ./transcripts/ so
 * future Claude sessions can easily read them.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { ParticipantUpdate, SummaryResult } from "./summarizer";

export interface StandupRecord {
  id?: number;
  guild_id: string;
  channel_id: string;
  started_at: string; // ISO 8601
  ended_at: string;
  participants: ParticipantUpdate[];
  raw_transcript: string;
  summary_text: string;
}

export interface UtteranceSegment {
  speaker: string;
  user_id: string;
  issue_number: number | null;
  issue_repo: string | null;
  issue_title: string | null;
  issue_state: string | null;
  text: string;
  started_at: number; // epoch ms
}

/** Snapshot of an in-flight session — written on start and mutated in place
 *  during the meeting so a process restart can resume from disk. */
export interface ActiveSessionRow {
  guild_id: string;
  type: "standup" | "meeting";
  channel_id: string;         // voice channel
  text_channel_id: string;    // where to post summary / banner
  started_at: string;         // ISO
  issue_repo: string | null;
  focused_issue: number | null;
  focused_detail_issue: number | null;
  presenter: string | null;
  active_participant_index: number;
  resumed_count: number;
  /** For standups: the pre-inserted standups.id so live proposals can FK it.
   *  null for meetings and for legacy rows. */
  standup_id: number | null;
}

export type ProposalActionType =
  | "close_issue"
  | "reopen_issue"
  | "comment"
  | "reassign"
  | "set_labels"
  | "backlog"
  | "create_issue";

export type ProposalState =
  | "pending"
  | "edited"
  | "affirmed"
  | "dismissed"
  | "executed"
  | "failed";

export type ProposalTriggerReason = "focus_change" | "speaker_change" | "fallback_60s";

export interface ProposalPayload {
  // close_issue
  reason?: "completed" | "not_planned";
  // comment
  body?: string;
  // reassign
  assignees?: string[];
  // set_labels
  addLabels?: string[];
  removeLabels?: string[];
  // create_issue
  title?: string;
  newBody?: string;
  newAssignees?: string[];
  // free-form reasoning from Claude (display only)
  reasoning?: string;
  // For comment / create_issue Claude may reference the issue title for display
  issueTitle?: string;
}

export interface ProposalRow {
  id: number;
  standup_id: number;
  guild_id: string;
  created_at: string;
  trigger_reason: ProposalTriggerReason;
  focused_issue: number | null;
  action_type: ProposalActionType;
  repo: string;
  target_issue: number | null;
  payload_json: string;
  original_payload_json: string;
  state: ProposalState;
  version: number;
  executed_at: string | null;
  executed_by: string | null;
  execution_result_json: string | null;
  superseded_by: number | null;
  source_segment_ids: string;
}

export interface Proposal {
  id: number;
  standup_id: number;
  guild_id: string;
  created_at: string;
  trigger_reason: ProposalTriggerReason;
  focused_issue: number | null;
  action_type: ProposalActionType;
  repo: string;
  target_issue: number | null;
  payload: ProposalPayload;
  original_payload: ProposalPayload;
  state: ProposalState;
  version: number;
  executed_at: string | null;
  executed_by: string | null;
  execution_result: { ok?: boolean; url?: string; error?: string } | null;
  superseded_by: number | null;
  source_segment_ids: number[];
}

export interface ActiveSessionLine {
  speaker: string;
  user_id: string;
  text: string;
  started_at: number;
  issue_number: number | null;
}

export interface ActiveSessionIssueMeta {
  issue_number: number;
  title: string;
  state: string;
}

const TRANSCRIPTS_DIR = "./transcripts";
const DB_PATH = "./data/standups.db";

function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try { return JSON.parse(json) as T; } catch { return fallback; }
}

export class StandupStore {
  private db: Database;

  constructor() {
    mkdirSync("./data", { recursive: true });
    mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

    this.db = new Database(DB_PATH);
    // WAL mode: allows concurrent reads during writes (web server + bot share the file).
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA foreign_keys=ON");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS standups (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        started_at  TEXT NOT NULL,
        ended_at    TEXT NOT NULL,
        participants TEXT NOT NULL,
        transcript  TEXT NOT NULL,
        summary     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_guild ON standups (guild_id, started_at DESC);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS utterance_segments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        standup_id   INTEGER NOT NULL,
        speaker      TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        issue_number INTEGER,
        issue_repo   TEXT,
        issue_title  TEXT,
        issue_state  TEXT,
        text         TEXT NOT NULL,
        started_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_segments_standup ON utterance_segments (standup_id);
    `);

    // Migrate existing tables that may lack the new columns
    for (const col of ["issue_title TEXT", "issue_state TEXT"]) {
      try { this.db.run(`ALTER TABLE utterance_segments ADD COLUMN ${col}`); } catch { /* already exists */ }
    }

    // Per-channel migration (#61): rekey session-state tables from guild_id
    // to channel_id so multiple voice channels in the same guild can host
    // concurrent standups. Only in-flight session state lives here, so
    // dropping any rows that would be lost is acceptable — completed
    // recordings are in `standups`, not `active_sessions`.
    const existingActive = this.db
      .query(`SELECT sql FROM sqlite_master WHERE type='table' AND name='active_sessions'`)
      .get() as { sql?: string } | undefined;
    if (existingActive?.sql && /guild_id\s+TEXT\s+PRIMARY KEY/i.test(existingActive.sql)) {
      console.warn("[store] Migrating active_sessions to channel_id PK (#61). Any in-flight session state will be dropped.");
      this.db.run(`DROP TABLE IF EXISTS active_sessions`);
      this.db.run(`DROP TABLE IF EXISTS active_session_lines`);
      this.db.run(`DROP TABLE IF EXISTS active_session_issue_meta`);
    }

    // In-flight session state — survives process restart. Keyed by channel_id
    // so two channels in the same guild can run concurrent standups (#61).
    this.db.run(`
      CREATE TABLE IF NOT EXISTS active_sessions (
        channel_id               TEXT PRIMARY KEY,
        guild_id                 TEXT NOT NULL,
        type                     TEXT NOT NULL,
        text_channel_id          TEXT NOT NULL,
        started_at               TEXT NOT NULL,
        issue_repo               TEXT,
        focused_issue            INTEGER,
        focused_detail_issue     INTEGER,
        presenter                TEXT,
        active_participant_index INTEGER NOT NULL DEFAULT 0,
        resumed_count            INTEGER NOT NULL DEFAULT 0,
        standup_id               INTEGER
      );
      CREATE TABLE IF NOT EXISTS active_session_lines (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id          TEXT NOT NULL,
        session_started_at  TEXT NOT NULL,
        speaker             TEXT NOT NULL,
        user_id             TEXT NOT NULL,
        text                TEXT NOT NULL,
        started_at          INTEGER NOT NULL,
        issue_number        INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_active_lines_session
        ON active_session_lines (channel_id, session_started_at, started_at);
      CREATE TABLE IF NOT EXISTS active_session_issue_meta (
        channel_id   TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        title        TEXT,
        state        TEXT,
        PRIMARY KEY (channel_id, issue_number)
      );
    `);

    // Live proposals surfaced during the meeting (#53).
    this.db.run(`
      CREATE TABLE IF NOT EXISTS proposals (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        standup_id              INTEGER NOT NULL,
        guild_id                TEXT NOT NULL,
        created_at              TEXT NOT NULL,
        trigger_reason          TEXT NOT NULL,
        focused_issue           INTEGER,
        action_type             TEXT NOT NULL,
        repo                    TEXT NOT NULL,
        target_issue            INTEGER,
        payload_json            TEXT NOT NULL,
        original_payload_json   TEXT NOT NULL,
        state                   TEXT NOT NULL DEFAULT 'pending',
        version                 INTEGER NOT NULL DEFAULT 1,
        executed_at             TEXT,
        executed_by             TEXT,
        execution_result_json   TEXT,
        superseded_by           INTEGER,
        source_segment_ids      TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (standup_id)    REFERENCES standups(id),
        FOREIGN KEY (superseded_by) REFERENCES proposals(id)
      );
      CREATE INDEX IF NOT EXISTS idx_proposals_standup ON proposals (standup_id);
      CREATE INDEX IF NOT EXISTS idx_proposals_guild_state ON proposals (guild_id, state);
    `);
  }

  // ── Active-session persistence ────────────────────────────────────────────

  saveActiveSession(row: ActiveSessionRow): void {
    this.db.prepare(`
      INSERT INTO active_sessions (
        channel_id, guild_id, type, text_channel_id, started_at,
        issue_repo, focused_issue, focused_detail_issue, presenter,
        active_participant_index, resumed_count, standup_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        guild_id = excluded.guild_id,
        type = excluded.type,
        text_channel_id = excluded.text_channel_id,
        started_at = excluded.started_at,
        issue_repo = excluded.issue_repo,
        focused_issue = excluded.focused_issue,
        focused_detail_issue = excluded.focused_detail_issue,
        presenter = excluded.presenter,
        active_participant_index = excluded.active_participant_index,
        resumed_count = excluded.resumed_count,
        standup_id = excluded.standup_id
    `).run(
      row.channel_id, row.guild_id, row.type, row.text_channel_id, row.started_at,
      row.issue_repo, row.focused_issue, row.focused_detail_issue, row.presenter,
      row.active_participant_index, row.resumed_count, row.standup_id,
    );
  }

  updateActiveSessionState(
    channelId: string,
    patch: Partial<Pick<ActiveSessionRow,
      "issue_repo" | "focused_issue" | "focused_detail_issue" | "presenter" | "active_participant_index"
    >>,
  ): void {
    const fields: string[] = [];
    const values: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      fields.push(`${k} = ?`);
      values.push(v ?? null);
    }
    if (fields.length === 0) return;
    values.push(channelId);
    this.db.prepare(`UPDATE active_sessions SET ${fields.join(", ")} WHERE channel_id = ?`).run(...values);
  }

  /** Delete this session's row + its lines. Row delete is identity-scoped
   *  (channel_id AND started_at), so a concurrent re-start in the same
   *  channel keeps its row. Issue meta is cleared whenever the matching
   *  session row goes away. */
  deleteActiveSession(channelId: string, sessionStartedAt: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM active_session_lines WHERE channel_id = ? AND session_started_at = ?`
      ).run(channelId, sessionStartedAt);
      const { changes } = this.db.prepare(
        `DELETE FROM active_sessions WHERE channel_id = ? AND started_at = ?`
      ).run(channelId, sessionStartedAt);
      if (Number(changes) > 0) {
        this.db.prepare(`DELETE FROM active_session_issue_meta WHERE channel_id = ?`).run(channelId);
      }
    });
    tx();
  }

  listActiveSessions(): ActiveSessionRow[] {
    return this.db.query(`SELECT * FROM active_sessions`).all() as ActiveSessionRow[];
  }

  appendActiveSessionLine(channelId: string, sessionStartedAt: string, line: ActiveSessionLine): void {
    this.db.prepare(`
      INSERT INTO active_session_lines (channel_id, session_started_at, speaker, user_id, text, started_at, issue_number)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(channelId, sessionStartedAt, line.speaker, line.user_id, line.text, line.started_at, line.issue_number);
  }

  getActiveSessionLines(channelId: string, sessionStartedAt: string): ActiveSessionLine[] {
    return this.db
      .query(
        `SELECT speaker, user_id, text, started_at, issue_number
         FROM active_session_lines
         WHERE channel_id = ? AND session_started_at = ?
         ORDER BY started_at`
      )
      .all(channelId, sessionStartedAt) as ActiveSessionLine[];
  }

  upsertActiveSessionIssueMeta(channelId: string, meta: ActiveSessionIssueMeta): void {
    this.db.prepare(`
      INSERT INTO active_session_issue_meta (channel_id, issue_number, title, state)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(channel_id, issue_number) DO UPDATE SET
        title = excluded.title,
        state = excluded.state
    `).run(channelId, meta.issue_number, meta.title, meta.state);
  }

  getActiveSessionIssueMeta(channelId: string): ActiveSessionIssueMeta[] {
    return this.db
      .query(`SELECT issue_number, title, state FROM active_session_issue_meta WHERE channel_id = ?`)
      .all(channelId) as ActiveSessionIssueMeta[];
  }

  /** Pre-insert a standup row at /standup start so live proposals (#53) can
   *  FK it from the moment they're created. ended_at/participants/transcript/
   *  summary are left empty — finishStandup() fills them in at /standup stop. */
  startStandup(args: { guild_id: string; channel_id: string; started_at: string }): number {
    const result = this.db
      .prepare(
        `INSERT INTO standups (guild_id, channel_id, started_at, ended_at, participants, transcript, summary)
         VALUES (?, ?, ?, '', '[]', '', '')`
      )
      .run(args.guild_id, args.channel_id, args.started_at);
    return result.lastInsertRowid as number;
  }

  /** Fill in the finished fields on a standup row that was pre-inserted at start,
   *  and write the markdown artifact. Mirrors save() for the post-meeting path. */
  finishStandup(id: number, record: {
    guild_id: string;
    channel_id: string;
    started_at: string;
    ended_at: string;
    participants: ParticipantUpdate[];
    raw_transcript: string;
    summary_text: string;
  }): { id: number; transcriptPath: string } {
    this.db
      .prepare(
        `UPDATE standups
            SET ended_at = ?, participants = ?, transcript = ?, summary = ?
          WHERE id = ?`
      )
      .run(
        record.ended_at,
        JSON.stringify(record.participants),
        record.raw_transcript,
        record.summary_text,
        id,
      );
    const transcriptPath = this.exportMarkdown({ ...record, id });
    return { id, transcriptPath };
  }

  /** Delete a pre-inserted standup row whose meeting produced no speech.
   *  Only safe to call if nothing else references the row (no segments, no
   *  proposals). Caller should check. */
  deleteStandup(id: number): void {
    this.db.prepare(`DELETE FROM standups WHERE id = ?`).run(id);
  }

  // ── Proposals (#53) ────────────────────────────────────────────────────────

  insertProposal(p: {
    standup_id: number;
    guild_id: string;
    created_at: string;
    trigger_reason: ProposalTriggerReason;
    focused_issue: number | null;
    action_type: ProposalActionType;
    repo: string;
    target_issue: number | null;
    payload: ProposalPayload;
    source_segment_ids: number[];
  }): Proposal {
    const payloadJson = JSON.stringify(p.payload);
    const result = this.db.prepare(`
      INSERT INTO proposals (
        standup_id, guild_id, created_at, trigger_reason, focused_issue,
        action_type, repo, target_issue, payload_json, original_payload_json,
        source_segment_ids
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      p.standup_id, p.guild_id, p.created_at, p.trigger_reason, p.focused_issue,
      p.action_type, p.repo, p.target_issue, payloadJson, payloadJson,
      JSON.stringify(p.source_segment_ids),
    );
    const id = result.lastInsertRowid as number;
    return this.getProposal(id)!;
  }

  getProposal(id: number): Proposal | null {
    const row = this.db.query(`SELECT * FROM proposals WHERE id = ?`).get(id) as ProposalRow | undefined;
    return row ? this.hydrateProposal(row) : null;
  }

  listProposalsForStandup(standupId: number): Proposal[] {
    const rows = this.db
      .query(`SELECT * FROM proposals WHERE standup_id = ? ORDER BY created_at ASC, id ASC`)
      .all(standupId) as ProposalRow[];
    return rows.map((r) => this.hydrateProposal(r));
  }

  listActiveProposalsForStandup(standupId: number): Proposal[] {
    const rows = this.db
      .query(
        `SELECT * FROM proposals
           WHERE standup_id = ?
             AND state IN ('pending','edited','affirmed','executed','failed')
             AND superseded_by IS NULL
           ORDER BY created_at ASC, id ASC`
      )
      .all(standupId) as ProposalRow[];
    return rows.map((r) => this.hydrateProposal(r));
  }

  /** Patch a proposal's payload. Returns the new row, or null if the row is gone
   *  or if expectedVersion doesn't match. Version bumps monotonically (#53 edits). */
  editProposal(id: number, expectedVersion: number, payload: ProposalPayload): Proposal | null {
    const current = this.getProposal(id);
    if (!current) return null;
    if (current.version !== expectedVersion) {
      // Stale edit — canonical row wins, caller should rebroadcast.
      return current;
    }
    this.db.prepare(
      `UPDATE proposals
          SET payload_json = ?,
              version = version + 1,
              state = CASE WHEN state = 'pending' THEN 'edited' ELSE state END
        WHERE id = ?`
    ).run(JSON.stringify(payload), id);
    return this.getProposal(id);
  }

  dismissProposal(id: number): Proposal | null {
    this.db.prepare(`UPDATE proposals SET state = 'dismissed' WHERE id = ?`).run(id);
    return this.getProposal(id);
  }

  /** Transition to affirmed immediately before execution, so broadcast shows a
   *  spinner state. Only pending/edited rows are eligible. */
  markProposalAffirmed(id: number, executedBy: string): Proposal | null {
    this.db.prepare(
      `UPDATE proposals
          SET state = 'affirmed',
              executed_by = ?
        WHERE id = ? AND state IN ('pending','edited')`
    ).run(executedBy, id);
    return this.getProposal(id);
  }

  completeProposal(
    id: number,
    ok: boolean,
    result: { url?: string; error?: string },
  ): Proposal | null {
    this.db.prepare(
      `UPDATE proposals
          SET state = ?,
              executed_at = ?,
              execution_result_json = ?
        WHERE id = ?`
    ).run(
      ok ? "executed" : "failed",
      new Date().toISOString(),
      JSON.stringify(result),
      id,
    );
    return this.getProposal(id);
  }

  supersedeProposal(oldId: number, newId: number): void {
    this.db.prepare(
      `UPDATE proposals SET superseded_by = ? WHERE id = ?`
    ).run(newId, oldId);
  }

  private hydrateProposal(row: ProposalRow): Proposal {
    return {
      id: row.id,
      standup_id: row.standup_id,
      guild_id: row.guild_id,
      created_at: row.created_at,
      trigger_reason: row.trigger_reason,
      focused_issue: row.focused_issue,
      action_type: row.action_type,
      repo: row.repo,
      target_issue: row.target_issue,
      payload: safeParse(row.payload_json, {}),
      original_payload: safeParse(row.original_payload_json, {}),
      state: row.state,
      version: row.version,
      executed_at: row.executed_at,
      executed_by: row.executed_by,
      execution_result: row.execution_result_json ? safeParse(row.execution_result_json, null) : null,
      superseded_by: row.superseded_by,
      source_segment_ids: safeParse(row.source_segment_ids, []),
    };
  }

  save(record: StandupRecord): { id: number; transcriptPath: string } {
    const stmt = this.db.prepare(`
      INSERT INTO standups (guild_id, channel_id, started_at, ended_at, participants, transcript, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      record.guild_id,
      record.channel_id,
      record.started_at,
      record.ended_at,
      JSON.stringify(record.participants),
      record.raw_transcript,
      record.summary_text
    );

    const id = result.lastInsertRowid as number;
    const transcriptPath = this.exportMarkdown({ ...record, id });
    return { id, transcriptPath };
  }

  /** Save utterance segments linked to a standup record. */
  saveSegments(standupId: number, segments: UtteranceSegment[]): void {
    if (segments.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT INTO utterance_segments (standup_id, speaker, user_id, issue_number, issue_repo, issue_title, issue_state, text, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertAll = this.db.transaction(() => {
      for (const seg of segments) {
        stmt.run(
          standupId,
          seg.speaker,
          seg.user_id,
          seg.issue_number,
          seg.issue_repo,
          seg.issue_title,
          seg.issue_state,
          seg.text,
          seg.started_at,
        );
      }
    });

    insertAll();
    console.log(`[store] Saved ${segments.length} utterance segment(s) for standup #${standupId}`);
  }

  recent(guildId: string, limit = 10): StandupRecord[] {
    const rows = this.db
      .query(
        `SELECT * FROM standups WHERE guild_id = ? ORDER BY started_at DESC LIMIT ?`
      )
      .all(guildId, limit) as any[];
    return rows.map((r) => ({
      ...r,
      participants: JSON.parse(r.participants),
    }));
  }

  private exportMarkdown(record: StandupRecord & { id: number }): string {
    const date = new Date(record.started_at);
    const dateStr = date.toISOString().slice(0, 10);
    const timeStr = date.toISOString().slice(11, 16);
    const filename = `${dateStr}-standup-${record.id}.md`;
    const path = join(TRANSCRIPTS_DIR, filename);

    const participantsMd = record.participants
      .map((p) => {
        const lines: string[] = [`### ${p.name}`];
        if (p.did.length) lines.push("**Did:**\n" + p.did.map((d) => `- ${d}`).join("\n"));
        if (p.will_do.length) lines.push("**Will do:**\n" + p.will_do.map((d) => `- ${d}`).join("\n"));
        if (p.blockers.length) lines.push("**Blockers:**\n" + p.blockers.map((d) => `- ${d}`).join("\n"));
        return lines.join("\n");
      })
      .join("\n\n");

    const endDate = new Date(record.ended_at);
    const durationMin = Math.round((endDate.getTime() - date.getTime()) / 60000);

    const proposalsSection = this.buildProposalsMarkdown(record.id);

    const md = `# Standup — ${dateStr} ${timeStr} UTC (${durationMin}m)

> Record #${record.id} | Guild: ${record.guild_id} | Channel: ${record.channel_id}

## Summary

${record.summary_text}

## Per-Participant

${participantsMd}
${proposalsSection}
## Full Transcript

\`\`\`
${record.raw_transcript}
\`\`\`
`;

    writeFileSync(path, md, "utf8");
    console.log(`[store] Transcript saved → ${path}`);
    return path;
  }

  /** Render proposals grouped by state for the markdown artifact. Shows an
   *  edit diff when payload diverges from the original AI output. */
  private buildProposalsMarkdown(standupId: number): string {
    const proposals = this.listProposalsForStandup(standupId);
    if (proposals.length === 0) return "";

    const order: ProposalState[] = ["executed", "affirmed", "failed", "edited", "pending", "dismissed"];
    const stateTitle: Record<ProposalState, string> = {
      executed: "Executed",
      affirmed: "Affirmed",
      failed: "Failed",
      edited: "Edited (not affirmed)",
      pending: "Pending at stop",
      dismissed: "Dismissed",
    };

    const grouped = new Map<ProposalState, Proposal[]>();
    for (const p of proposals) {
      if (p.superseded_by != null) continue; // skip superseded intermediate versions
      const list = grouped.get(p.state) ?? [];
      list.push(p);
      grouped.set(p.state, list);
    }

    const sections: string[] = ["", "## Proposed Actions", ""];
    for (const state of order) {
      const list = grouped.get(state);
      if (!list || list.length === 0) continue;
      sections.push(`### ${stateTitle[state]} (${list.length})`, "");
      for (const p of list) {
        sections.push(this.renderProposalMarkdown(p));
      }
    }
    return sections.join("\n") + "\n";
  }

  private renderProposalMarkdown(p: Proposal): string {
    const targetRef = p.target_issue != null
      ? `[#${p.target_issue}](https://github.com/${p.repo}/issues/${p.target_issue})`
      : `(new issue)`;
    const head = `**${p.action_type}** ${targetRef}`;
    const reasoning = p.payload.reasoning ? `\n_${p.payload.reasoning}_` : "";
    const payloadSerialized = JSON.stringify(p.payload, null, 2);
    const diff = JSON.stringify(p.payload) !== JSON.stringify(p.original_payload)
      ? `\n\nOriginal (AI):\n\`\`\`json\n${JSON.stringify(p.original_payload, null, 2)}\n\`\`\`\n\nEdited:\n\`\`\`json\n${payloadSerialized}\n\`\`\`\n`
      : `\n\n\`\`\`json\n${payloadSerialized}\n\`\`\`\n`;
    const result = p.execution_result
      ? (p.execution_result.url ? `\n\nResult: ${p.execution_result.url}` : p.execution_result.error ? `\n\nError: ${p.execution_result.error}` : "")
      : "";
    return `- ${head}${reasoning}${diff}${result}`;
  }
}

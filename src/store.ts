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

    // In-flight session state — survives process restart.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS active_sessions (
        guild_id                 TEXT PRIMARY KEY,
        type                     TEXT NOT NULL,
        channel_id               TEXT NOT NULL,
        text_channel_id          TEXT NOT NULL,
        started_at               TEXT NOT NULL,
        issue_repo               TEXT,
        focused_issue            INTEGER,
        focused_detail_issue     INTEGER,
        presenter                TEXT,
        active_participant_index INTEGER NOT NULL DEFAULT 0,
        resumed_count            INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS active_session_lines (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id            TEXT NOT NULL,
        session_started_at  TEXT,
        speaker             TEXT NOT NULL,
        user_id             TEXT NOT NULL,
        text                TEXT NOT NULL,
        started_at          INTEGER NOT NULL,
        issue_number        INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_active_lines_session
        ON active_session_lines (guild_id, session_started_at, started_at);
      CREATE TABLE IF NOT EXISTS active_session_issue_meta (
        guild_id     TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        title        TEXT,
        state        TEXT,
        PRIMARY KEY (guild_id, issue_number)
      );
    `);

    // Migration: add session_started_at to active_session_lines for installs
    // that predate #58. Old rows without a session_started_at are orphaned
    // (no longer loadable on resume) and safe to drop.
    try { this.db.run(`ALTER TABLE active_session_lines ADD COLUMN session_started_at TEXT`); } catch { /* already exists */ }
    try { this.db.run(`DELETE FROM active_session_lines WHERE session_started_at IS NULL`); } catch { /* noop */ }
  }

  // ── Active-session persistence ────────────────────────────────────────────

  saveActiveSession(row: ActiveSessionRow): void {
    this.db.prepare(`
      INSERT INTO active_sessions (
        guild_id, type, channel_id, text_channel_id, started_at,
        issue_repo, focused_issue, focused_detail_issue, presenter,
        active_participant_index, resumed_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        type = excluded.type,
        channel_id = excluded.channel_id,
        text_channel_id = excluded.text_channel_id,
        started_at = excluded.started_at,
        issue_repo = excluded.issue_repo,
        focused_issue = excluded.focused_issue,
        focused_detail_issue = excluded.focused_detail_issue,
        presenter = excluded.presenter,
        active_participant_index = excluded.active_participant_index,
        resumed_count = excluded.resumed_count
    `).run(
      row.guild_id, row.type, row.channel_id, row.text_channel_id, row.started_at,
      row.issue_repo, row.focused_issue, row.focused_detail_issue, row.presenter,
      row.active_participant_index, row.resumed_count,
    );
  }

  updateActiveSessionState(
    guildId: string,
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
    values.push(guildId);
    this.db.prepare(`UPDATE active_sessions SET ${fields.join(", ")} WHERE guild_id = ?`).run(...values);
  }

  /** Delete this session's row + its lines. Row delete is identity-scoped
   *  (guild_id AND started_at), so a concurrent new session for the same
   *  guild keeps its row. Issue meta is only cleared if we successfully
   *  dropped our row — otherwise the newer session owns it. */
  deleteActiveSession(guildId: string, sessionStartedAt: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `DELETE FROM active_session_lines WHERE guild_id = ? AND session_started_at = ?`
      ).run(guildId, sessionStartedAt);
      const { changes } = this.db.prepare(
        `DELETE FROM active_sessions WHERE guild_id = ? AND started_at = ?`
      ).run(guildId, sessionStartedAt);
      if (Number(changes) > 0) {
        this.db.prepare(`DELETE FROM active_session_issue_meta WHERE guild_id = ?`).run(guildId);
      }
    });
    tx();
  }

  listActiveSessions(): ActiveSessionRow[] {
    return this.db.query(`SELECT * FROM active_sessions`).all() as ActiveSessionRow[];
  }

  appendActiveSessionLine(guildId: string, sessionStartedAt: string, line: ActiveSessionLine): void {
    this.db.prepare(`
      INSERT INTO active_session_lines (guild_id, session_started_at, speaker, user_id, text, started_at, issue_number)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(guildId, sessionStartedAt, line.speaker, line.user_id, line.text, line.started_at, line.issue_number);
  }

  getActiveSessionLines(guildId: string, sessionStartedAt: string): ActiveSessionLine[] {
    return this.db
      .query(
        `SELECT speaker, user_id, text, started_at, issue_number
         FROM active_session_lines
         WHERE guild_id = ? AND session_started_at = ?
         ORDER BY started_at`
      )
      .all(guildId, sessionStartedAt) as ActiveSessionLine[];
  }

  upsertActiveSessionIssueMeta(guildId: string, meta: ActiveSessionIssueMeta): void {
    this.db.prepare(`
      INSERT INTO active_session_issue_meta (guild_id, issue_number, title, state)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id, issue_number) DO UPDATE SET
        title = excluded.title,
        state = excluded.state
    `).run(guildId, meta.issue_number, meta.title, meta.state);
  }

  getActiveSessionIssueMeta(guildId: string): ActiveSessionIssueMeta[] {
    return this.db
      .query(`SELECT issue_number, title, state FROM active_session_issue_meta WHERE guild_id = ?`)
      .all(guildId) as ActiveSessionIssueMeta[];
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

    const md = `# Standup — ${dateStr} ${timeStr} UTC (${durationMin}m)

> Record #${record.id} | Guild: ${record.guild_id} | Channel: ${record.channel_id}

## Summary

${record.summary_text}

## Per-Participant

${participantsMd}

## Full Transcript

\`\`\`
${record.raw_transcript}
\`\`\`
`;

    writeFileSync(path, md, "utf8");
    console.log(`[store] Transcript saved → ${path}`);
    return path;
  }
}

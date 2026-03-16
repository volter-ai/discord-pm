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

const TRANSCRIPTS_DIR = "./transcripts";
const DB_PATH = "./data/standups.db";

export class StandupStore {
  private db: Database;

  constructor() {
    mkdirSync("./data", { recursive: true });
    mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

    this.db = new Database(DB_PATH);
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

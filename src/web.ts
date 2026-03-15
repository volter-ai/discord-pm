/**
 * Transcript web UI + JSON API.
 *
 * Serves password-protected HTML pages for humans and JSON endpoints for
 * programmatic access (e.g. Claude reading transcripts directly).
 *
 * Routes:
 *   GET /                       → paginated transcript list (HTML)
 *   GET /transcripts/:id        → full transcript detail (HTML)
 *   GET /api/transcripts        → transcript list (JSON, last 50)
 *   GET /api/transcripts/:id    → single transcript (JSON)
 *
 * Required env: WEB_PASSWORD
 */

import { Hono } from "hono";
import { Database } from "bun:sqlite";

const PASSWORD = process.env.WEB_PASSWORD ?? "";
const DB_PATH = "./data/standups.db";

// ── Auth ────────────────────────────────────────────────────────────────────

function unauthorized() {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Standups"' },
  });
}

function checkAuth(req: Request): boolean {
  if (!PASSWORD) return false; // block all if no password configured
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Basic ")) return false;
  const decoded = atob(auth.slice(6));
  const colon = decoded.indexOf(":");
  const pass = colon >= 0 ? decoded.slice(colon + 1) : decoded;
  return pass === PASSWORD;
}

// ── DB helpers ───────────────────────────────────────────────────────────────

interface Row {
  id: number;
  guild_id: string;
  channel_id: string;
  started_at: string;
  ended_at: string;
  participants: string; // JSON
  transcript: string;
  summary: string;
}

interface SegmentRow {
  id: number;
  standup_id: number;
  speaker: string;
  user_id: string;
  issue_number: number | null;
  issue_repo: string | null;
  text: string;
  started_at: number;
}

function openDb(): Database | null {
  try {
    return new Database(DB_PATH, { readonly: true });
  } catch {
    return null;
  }
}

function listStandups(limit = 50, offset = 0): Row[] {
  const db = openDb();
  if (!db) return [];
  try {
    return db
      .query(`SELECT * FROM standups ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as Row[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function countStandups(): number {
  const db = openDb();
  if (!db) return 0;
  try {
    const row = db.query(`SELECT COUNT(*) as n FROM standups`).get() as { n: number } | null;
    return row?.n ?? 0;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

function getStandup(id: number): Row | null {
  const db = openDb();
  if (!db) return null;
  try {
    return (db.query(`SELECT * FROM standups WHERE id = ?`).get(id) as Row) ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function getSegments(standupId: number): SegmentRow[] {
  const db = openDb();
  if (!db) return [];
  try {
    return db
      .query(`SELECT * FROM utterance_segments WHERE standup_id = ? ORDER BY started_at`)
      .all(standupId) as SegmentRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function parseParticipants(json: string) {
  try {
    return JSON.parse(json) as Array<{
      name: string;
      did: string[];
      will_do: string[];
      blockers: string[];
    }>;
  } catch {
    return [];
  }
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function fmtDuration(start: string, end: string) {
  const s = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec}s`;
}

// ── HTML templates ───────────────────────────────────────────────────────────

const CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem;max-width:1100px;margin:0 auto}
  h1{color:#818cf8;margin-bottom:1.5rem;font-size:1.5rem}
  h2{color:#94a3b8;font-size:1rem;margin:1.5rem 0 .75rem;text-transform:uppercase;letter-spacing:.05em}
  a{color:#818cf8;text-decoration:none}
  a:hover{text-decoration:underline}
  table{width:100%;border-collapse:collapse;font-size:.9rem}
  th{color:#64748b;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;padding:.5rem .75rem;text-align:left;border-bottom:1px solid #1e293b}
  td{padding:.6rem .75rem;border-bottom:1px solid #1e293b;vertical-align:top}
  tr:hover td{background:#1e293b}
  .tag{display:inline-block;padding:.1rem .45rem;border-radius:.25rem;font-size:.75rem;margin:.1rem}
  .name-tag{background:#1e1b4b;color:#a5b4fc}
  .blocker-tag{background:#450a0a;color:#fca5a5}
  pre{background:#1e293b;padding:1.25rem;border-radius:.5rem;overflow-x:auto;font-size:.82rem;line-height:1.6;white-space:pre-wrap;word-break:break-word}
  .summary-box{background:#1e293b;padding:1rem;border-radius:.5rem;line-height:1.6;font-size:.92rem}
  .participant{background:#0f172a;border:1px solid #1e293b;border-radius:.5rem;padding:1rem;margin-bottom:.75rem}
  .participant h3{color:#c7d2fe;margin-bottom:.5rem}
  ul{list-style:disc;padding-left:1.25rem;line-height:1.8}
  li{font-size:.88rem}
  .back{display:inline-block;margin-bottom:1.5rem;font-size:.85rem;color:#64748b}
  .back:hover{color:#818cf8}
  .meta{color:#64748b;font-size:.82rem;margin-bottom:1rem}
  .empty{color:#64748b;padding:2rem 0;text-align:center}
  .warn{background:#451a03;color:#fdba74;padding:.75rem 1rem;border-radius:.5rem;margin-bottom:1.5rem;font-size:.88rem}
  .issue-section{background:#0f172a;border:1px solid #1e293b;border-radius:.5rem;padding:1rem;margin-bottom:.75rem}
  .issue-section h3{color:#c7d2fe;margin-bottom:.5rem}
  .issue-section h3 a{color:#818cf8}
  .issue-speakers{color:#64748b;font-size:.82rem;margin-bottom:.5rem}
  .issue-snippet{font-size:.88rem;line-height:1.6;color:#cbd5e1}
`;

function page(title: string, body: string) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — Standup Transcripts</title>
  <style>${CSS}</style>
</head>
<body>${body}</body>
</html>`;
}

function listPage(rows: Row[], limit: number, offset: number, total: number) {
  const dbMissing = openDb() === null;
  const warning = dbMissing
    ? `<div class="warn">Database not found at <code>${DB_PATH}</code>. Run the bot first to generate transcripts.</div>`
    : "";

  const prevOffset = Math.max(0, offset - limit);
  const nextOffset = offset + limit;
  const hasPrev = offset > 0;
  const hasNext = nextOffset < total;
  const pagination = (hasPrev || hasNext)
    ? `<div style="margin-top:1.25rem;display:flex;gap:1rem;font-size:.85rem">
        ${hasPrev ? `<a href="/?limit=${limit}&offset=${prevOffset}">← Newer</a>` : `<span style="color:#334155">← Newer</span>`}
        <span style="color:#64748b">${offset + 1}–${Math.min(offset + rows.length, total)} of ${total}</span>
        ${hasNext ? `<a href="/?limit=${limit}&offset=${nextOffset}">Older →</a>` : `<span style="color:#334155">Older →</span>`}
      </div>`
    : "";

  const tableRows = rows.map((r) => {
    const parts = parseParticipants(r.participants);
    const names = parts.map((p) => `<span class="tag name-tag">${esc(p.name)}</span>`).join(" ");
    const blockers = parts.flatMap((p) => p.blockers);
    const blockerBadge = blockers.length
      ? `<span class="tag blocker-tag">${blockers.length} blocker${blockers.length > 1 ? "s" : ""}</span>`
      : "";
    const snippet = r.summary.length > 120 ? r.summary.slice(0, 120) + "…" : r.summary;
    return `<tr>
      <td><a href="/transcripts/${r.id}">#${r.id}</a></td>
      <td>${fmtDate(r.started_at)}</td>
      <td>${fmtDuration(r.started_at, r.ended_at)}</td>
      <td>${names} ${blockerBadge}</td>
      <td style="color:#94a3b8">${esc(snippet)}</td>
    </tr>`;
  }).join("\n");

  const table = rows.length
    ? `<table>
        <thead><tr>
          <th>#</th><th>Date</th><th>Duration</th><th>Participants</th><th>Summary</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>`
    : `<div class="empty">No standups recorded yet.</div>`;

  return page("Transcripts", `
    <h1>Standup Transcripts</h1>
    ${warning}
    ${table}
    ${pagination}
  `);
}

function detailPage(r: Row, segments: SegmentRow[]) {
  const parts = parseParticipants(r.participants);

  const participantBlocks = parts.map((p) => {
    const did = p.did?.length
      ? `<p style="color:#64748b;font-size:.78rem;margin-bottom:.25rem">DID</p><ul>${p.did.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`
      : "";
    const willDo = p.will_do?.length
      ? `<p style="color:#64748b;font-size:.78rem;margin:0.5rem 0 .25rem">WILL DO</p><ul>${p.will_do.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`
      : "";
    const blockers = p.blockers?.length
      ? `<p style="color:#fca5a5;font-size:.78rem;margin:0.5rem 0 .25rem">BLOCKERS</p><ul style="color:#fca5a5">${p.blockers.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`
      : "";
    return `<div class="participant"><h3>${esc(p.name)}</h3>${did}${willDo}${blockers}</div>`;
  }).join("\n");

  // Issue-aware transcript sections (if segments exist)
  let issueTranscriptHtml = "";
  if (segments.length > 0) {
    const byIssue = new Map<number | null, SegmentRow[]>();
    for (const seg of segments) {
      const key = seg.issue_number;
      if (!byIssue.has(key)) byIssue.set(key, []);
      byIssue.get(key)!.push(seg);
    }

    const issueSections: string[] = [];
    for (const [issueNum, segs] of byIssue) {
      const speakers = [...new Set(segs.map(s => s.speaker))].join(", ");
      const snippets = segs.map(s => `<div class="issue-snippet"><strong>${esc(s.speaker)}:</strong> ${esc(s.text)}</div>`).join("\n");
      const repo = segs[0]?.issue_repo ?? "";
      const title = issueNum
        ? `<a href="https://github.com/${repo}/issues/${issueNum}" target="_blank">#${issueNum}</a>`
        : "General Discussion";
      issueSections.push(`<div class="issue-section">
        <h3>${title}</h3>
        <div class="issue-speakers">${esc(speakers)}</div>
        ${snippets}
      </div>`);
    }

    issueTranscriptHtml = `
      <h2>By Issue</h2>
      ${issueSections.join("\n")}
    `;
  }

  return page(`#${r.id}`, `
    <a class="back" href="/">← All transcripts</a>
    <h1>Standup #${r.id}</h1>
    <p class="meta">${fmtDate(r.started_at)} &nbsp;·&nbsp; ${fmtDuration(r.started_at, r.ended_at)} &nbsp;·&nbsp; Channel ${r.channel_id}</p>

    <h2>Summary</h2>
    <div class="summary-box">${esc(r.summary)}</div>

    <h2>Per Participant</h2>
    ${participantBlocks || '<p class="empty">No participant data.</p>'}

    ${issueTranscriptHtml}

    <h2>Full Transcript</h2>
    <pre>${esc(r.transcript)}</pre>
  `);
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── App factory ─────────────────────────────────────────────────────────────

export function createWebApp(): Hono {
  const app = new Hono();

  // Auth middleware
  app.use("*", async (c, next) => {
    if (!checkAuth(c.req.raw)) {
      console.log(`[web] Auth DENIED for ${c.req.method} ${new URL(c.req.url).pathname}`);
      return unauthorized();
    }
    await next();
  });

  // HTML routes
  app.get("/", (c) => {
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50") || 50, 1), 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0") || 0, 0);
    const rows = listStandups(limit, offset);
    const total = countStandups();
    return c.html(listPage(rows, limit, offset, total));
  });

  app.get("/transcripts/:id", (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.notFound();
    const row = getStandup(id);
    if (!row) return c.notFound();
    const segments = getSegments(id);
    return c.html(detailPage(row, segments));
  });

  // JSON API routes
  app.get("/api/transcripts", (c) => {
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50") || 50, 1), 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0") || 0, 0);
    const rows = listStandups(limit, offset).map((r) => ({
      id: r.id,
      guild_id: r.guild_id,
      channel_id: r.channel_id,
      started_at: r.started_at,
      ended_at: r.ended_at,
      duration_seconds: Math.round(
        (new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000
      ),
      participants: parseParticipants(r.participants),
      summary: r.summary,
    }));
    return c.json(rows);
  });

  app.get("/api/transcripts/:id", (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
    const row = getStandup(id);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({
      id: row.id,
      guild_id: row.guild_id,
      channel_id: row.channel_id,
      started_at: row.started_at,
      ended_at: row.ended_at,
      duration_seconds: Math.round(
        (new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 1000
      ),
      participants: parseParticipants(row.participants),
      summary: row.summary,
      transcript: row.transcript,
    });
  });

  return app;
}

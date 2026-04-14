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
import { Summarizer, type GitHubSuggestion } from "./summarizer";
import { createIssue, createComment } from "./github";
import type { StandupBot } from "./bot";

const PASSWORD = process.env.WEB_PASSWORD ?? "";
const DB_PATH = "./data/standups.db";

let _summarizer: Summarizer | null = null;
function getSummarizer(): Summarizer | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!_summarizer) _summarizer = new Summarizer(key);
  return _summarizer;
}

const suggestionsCache = new Map<number, GitHubSuggestion[]>();

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
  let decoded: string;
  try {
    decoded = atob(auth.slice(6));
  } catch {
    return false; // malformed Base64 → 401 not 500
  }
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
  issue_title: string | null;
  issue_state: string | null;
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
    // Filter out pre-inserted (#53) rows whose meeting hasn't ended yet.
    return db
      .query(`SELECT * FROM standups WHERE ended_at != '' ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as Row[];
  } catch (e: any) {
    console.error("[web] listStandups error:", e.message);
    return [];
  } finally {
    db.close();
  }
}

function countStandups(): number {
  const db = openDb();
  if (!db) return 0;
  try {
    const row = db.query(`SELECT COUNT(*) as n FROM standups WHERE ended_at != ''`).get() as { n: number } | null;
    return row?.n ?? 0;
  } catch (e: any) {
    console.error("[web] countStandups error:", e.message);
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
  } catch (e: any) {
    console.error("[web] getStandup error:", e.message);
    return null;
  } finally {
    db.close();
  }
}

interface ProposalDbRow {
  id: number;
  standup_id: number;
  created_at: string;
  trigger_reason: string;
  focused_issue: number | null;
  action_type: string;
  repo: string;
  target_issue: number | null;
  payload_json: string;
  original_payload_json: string;
  state: string;
  version: number;
  executed_at: string | null;
  executed_by: string | null;
  execution_result_json: string | null;
  superseded_by: number | null;
}

function getProposalsFor(standupId: number): ProposalDbRow[] {
  const db = openDb();
  if (!db) return [];
  try {
    return db
      .query(`SELECT * FROM proposals WHERE standup_id = ? AND superseded_by IS NULL ORDER BY created_at ASC, id ASC`)
      .all(standupId) as ProposalDbRow[];
  } catch (e: any) {
    // Table may not exist on older databases — treat as empty.
    return [];
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
  } catch (e: any) {
    console.error("[web] getSegments error:", e.message);
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

// ── Analytics helpers ────────────────────────────────────────────────────────

/**
 * Estimate ms spent per issue using inter-segment gaps (capped at 2 min).
 * Segments must be ordered by started_at.
 */
function computeIssueTimes(segments: SegmentRow[]): Map<number | null, number> {
  const times = new Map<number | null, number>();
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const next = segments[i + 1];
    const durationMs = next
      ? Math.min(next.started_at - seg.started_at, 120_000)
      : 30_000;
    times.set(seg.issue_number, (times.get(seg.issue_number) ?? 0) + durationMs);
  }
  return times;
}

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

const CHART_COLORS = ["#818cf8", "#34d399", "#f87171", "#fbbf24", "#a78bfa", "#60a5fa", "#fb923c", "#e879f9"];

function svgPieChart(slices: { value: number; color: string }[], size = 120): string {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total === 0) return "";
  const cx = size / 2, cy = size / 2, r = size / 2 - 4;
  let angle = -Math.PI / 2;
  const paths = slices.map(({ value, color }) => {
    const sweep = (value / total) * 2 * Math.PI;
    const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
    angle += sweep;
    const x2 = cx + r * Math.cos(angle), y2 = cy + r * Math.sin(angle);
    const large = sweep > Math.PI ? 1 : 0;
    return `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large},1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${color}"/>`;
  }).join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${paths}</svg>`;
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
  .issue-section h3{color:#c7d2fe;margin-bottom:.25rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
  .issue-section h3 a{color:#818cf8}
  .issue-title-text{color:#e2e8f0;font-size:.9rem;font-weight:400;margin-bottom:.4rem}
  .issue-meta-row{display:flex;align-items:center;gap:.75rem;margin-bottom:.5rem;flex-wrap:wrap}
  .status-badge{display:inline-block;padding:.1rem .45rem;border-radius:.75rem;font-size:.72rem;font-weight:600;letter-spacing:.02em}
  .status-open{background:#14532d;color:#86efac}
  .status-closed{background:#1c1917;color:#a8a29e}
  .issue-gh-link{color:#818cf8;font-size:.8rem;text-decoration:none}
  .issue-gh-link:hover{text-decoration:underline}
  .issue-speakers{color:#64748b;font-size:.82rem;margin-bottom:.5rem}
  .issue-snippet{font-size:.88rem;line-height:1.6;color:#cbd5e1}
  .toc{background:#1e293b;border-radius:.5rem;padding:.75rem 1rem;margin-bottom:1rem;font-size:.875rem}
  .toc-title{color:#94a3b8;font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.4rem}
  .toc-table{width:100%;border-collapse:collapse;font-size:.83rem}
  .toc-table th{color:#64748b;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;padding:.3rem .5rem;text-align:left;border-bottom:1px solid #334155}
  .toc-table td{padding:.3rem .5rem;border-bottom:1px solid #2d3748;vertical-align:top}
  .toc-table tr:hover td{background:#334155}
  .toc-table td:last-child{color:#94a3b8;white-space:nowrap;text-align:right}
  .toc-general{color:#64748b;font-size:.8rem;margin-left:.4rem}

  /* Speaker distribution */
  .speaker-row{display:flex;align-items:center;gap:1.5rem;background:#1e293b;border-radius:.5rem;padding:1rem;flex-wrap:wrap}
  .speaker-legend{display:flex;flex-direction:column;gap:.35rem;min-width:160px}
  .speaker-legend-item{display:flex;align-items:center;gap:.5rem;font-size:.85rem}
  .speaker-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
  .speaker-name{color:#e2e8f0;flex:1}
  .speaker-count{color:#64748b;white-space:nowrap}

  /* Top 3 issues */
  .top-issues{display:flex;gap:.75rem;margin-bottom:1rem;flex-wrap:wrap}
  .top-issue-card{background:#1e293b;border:1px solid #334155;border-radius:.5rem;padding:.75rem 1rem;flex:1;min-width:160px}
  .top-issue-rank{color:#64748b;font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.25rem}
  .top-issue-num{color:#818cf8;font-size:.95rem;font-weight:700;text-decoration:none;display:block}
  .top-issue-num:hover{text-decoration:underline}
  .top-issue-title{color:#cbd5e1;font-size:.82rem;margin:.2rem 0 .4rem;line-height:1.4}
  .top-issue-time{color:#4ade80;font-size:.85rem;font-weight:600}

  /* AI Suggestions */
  .suggest-section{margin-top:2rem}
  .suggest-btn{background:#4f46e5;color:white;border:none;padding:.5rem 1.25rem;border-radius:.375rem;cursor:pointer;font-size:.88rem;transition:background .15s}
  .suggest-btn:hover:not(:disabled){background:#4338ca}
  .suggest-btn:disabled{opacity:.6;cursor:not-allowed}
  .suggestion-card{background:#1e293b;border:1px solid #334155;border-radius:.5rem;padding:1rem;margin-bottom:.75rem}
  .sug-type{color:#94a3b8;font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-bottom:.4rem}
  .sug-title{color:#e2e8f0;font-size:.95rem;font-weight:600;margin-bottom:.5rem}
  .sug-body{background:#0f172a;border-radius:.375rem;padding:.75rem;font-size:.82rem;line-height:1.6;color:#cbd5e1;white-space:pre-wrap;word-break:break-word;margin-bottom:.5rem}
  .sug-reasoning{color:#64748b;font-size:.8rem;font-style:italic;margin-bottom:.75rem}
  .sug-actions{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
  .sug-btn{border:none;padding:.35rem .9rem;border-radius:.375rem;cursor:pointer;font-size:.82rem;transition:all .15s}
  .sug-apply{background:#1e3a1e;color:#86efac;border:1px solid #166534}
  .sug-apply:hover:not(:disabled){background:#14532d}
  .sug-dismiss{background:#1c1917;color:#a8a29e;border:1px solid #292524}
  .sug-dismiss:hover{background:#292524;color:#e2e8f0}
  .sug-empty{color:#64748b;padding:.75rem 0;font-size:.88rem}
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
  // Probe for DB existence without leaking the handle.
  const _probe = openDb();
  const dbMissing = _probe === null;
  _probe?.close();
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

function suggestionsSection(id: number): string {
  return `
    <div class="suggest-section" id="suggest-box" data-id="${id}">
      <h2>AI Suggested GitHub Actions</h2>
      <button class="suggest-btn" id="btn-suggest">Generate Suggestions</button>
      <div id="suggestion-list" style="margin-top:1rem"></div>
    </div>
    <script>
(function() {
  var transcriptId = ${JSON.stringify(Number(id))};
  var _sugg = [];
  function h(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/\x3c/g,'&lt;').replace(/\x3e/g,'&gt;').replace(/"/g,'&quot;');
  }
  function generateSuggestions() {
    var btn = document.getElementById('btn-suggest');
    btn.disabled = true; btn.textContent = 'Generating\u2026 (10\u201315s)';
    fetch('/transcripts/' + transcriptId + '/suggestions').then(function(res) {
      if (!res.ok) throw new Error('Server error: ' + res.status);
      return res.json();
    }).then(function(data) {
      _sugg = data;
      var list = document.getElementById('suggestion-list');
      btn.style.display = 'none';
      if (!_sugg.length) { list.innerHTML = '<p class="sug-empty">No suggestions generated.</p>'; return; }
      list.innerHTML = _sugg.map(function(s,i) {
        var ghLink = 'https://github.com/' + h(s.repo) + '/issues/' + s.issueNumber;
        var issueAnchor = '<a href="' + ghLink + '" target="_blank" style="color:#818cf8">#' + s.issueNumber + (s.issueTitle ? ' \u2014 ' + h(s.issueTitle) : '') + '</a>';
        var type = s.type === 'new_issue' ? '&#128221; New Issue' : '&#128172; Comment on ' + issueAnchor;
        var titleRow = s.title ? '<div class="sug-title">' + h(s.title) + '</div>' : '';
        return '<div class="suggestion-card" id="sug-'+i+'">'+
          '<div class="sug-type">'+type+'</div>'+
          titleRow+
          '<pre class="sug-body">'+h(s.body)+'</pre>'+
          '<div class="sug-reasoning">'+h(s.reasoning)+'</div>'+
          '<div class="sug-actions">'+
            '<button class="sug-btn sug-apply" data-idx="'+i+'">&#10003; Apply to GitHub</button> '+
            '<button class="sug-btn sug-dismiss" data-idx="'+i+'">&#10007; Dismiss</button>'+
          '</div>'+
        '</div>';
      }).join('');
    }).catch(function() { btn.textContent = '! Failed \u2014 retry'; btn.disabled = false; });
  }
  function applySugg(i) {
    var s = _sugg[i];
    var card = document.getElementById('sug-'+i);
    var btn = card.querySelector('.sug-apply');
    btn.disabled = true; btn.textContent = 'Applying\u2026';
    fetch('/transcripts/' + transcriptId + '/suggestions/apply', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(s)
    }).then(function(res) {
      if (!res.ok) throw new Error('Error: ' + res.status);
      return res.json();
    }).then(function(result) {
      btn.textContent = '&#10003; Applied'; btn.style.background='#14532d'; btn.style.color='#86efac';
      if (result.url) {
        var a = document.createElement('a'); a.href=result.url; a.target='_blank';
        a.style.cssText='color:#818cf8;font-size:.8rem;margin-left:.5rem'; a.textContent='View on GitHub \u2197';
        btn.parentNode.insertBefore(a, btn.nextSibling);
      }
    }).catch(function() { btn.textContent='! Failed'; btn.disabled=false; btn.style.background='#450a0a'; });
  }
  document.getElementById('btn-suggest').addEventListener('click', generateSuggestions);
  document.getElementById('suggestion-list').addEventListener('click', function(e) {
    var t = e.target;
    if (t.classList.contains('sug-apply')) { applySugg(parseInt(t.dataset.idx)); }
    if (t.classList.contains('sug-dismiss')) { document.getElementById('sug-'+t.dataset.idx).remove(); }
  });
})();
    </script>
  `;
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
  let speakerChartHtml = "";
  let issueTranscriptHtml = "";

  if (segments.length > 0) {
    // ── Speaker distribution pie chart ──────────────────────────────────────
    const speakerCounts = new Map<string, number>();
    for (const seg of segments) {
      speakerCounts.set(seg.speaker, (speakerCounts.get(seg.speaker) ?? 0) + 1);
    }
    if (speakerCounts.size >= 2) {
      const sorted = [...speakerCounts.entries()].sort((a, b) => b[1] - a[1]);
      const total = segments.length;
      const slices = sorted.map(([, count], i) => ({ value: count, color: CHART_COLORS[i % CHART_COLORS.length] }));
      const legend = sorted.map(([name, count], i) => {
        const pct = Math.round(count / total * 100);
        return `<div class="speaker-legend-item">
          <span class="speaker-dot" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></span>
          <span class="speaker-name">${esc(name)}</span>
          <span class="speaker-count">${count} utterances (${pct}%)</span>
        </div>`;
      }).join("");
      speakerChartHtml = `
        <h2>Speaker Distribution</h2>
        <div class="speaker-row">
          ${svgPieChart(slices)}
          <div class="speaker-legend">${legend}</div>
        </div>
      `;
    }

    // ── Build byIssue map (preserving transcript order) ─────────────────────
    const byIssue = new Map<number | null, SegmentRow[]>();
    for (const seg of segments) {
      const key = seg.issue_number;
      if (!byIssue.has(key)) byIssue.set(key, []);
      byIssue.get(key)!.push(seg);
    }

    const issueTimes = computeIssueTimes(segments);

    // ── Top 3 issues by time (excluding general discussion) ─────────────────
    const rankedIssues = [...byIssue.entries()]
      .filter(([k]) => k !== null)
      .sort((a, b) => (issueTimes.get(b[0]) ?? 0) - (issueTimes.get(a[0]) ?? 0));

    const top3Html = rankedIssues.slice(0, 3).map(([issueNum, segs], rank) => {
      const ms = issueTimes.get(issueNum) ?? 0;
      const title = segs[0]?.issue_title ?? null;
      const medals = ["🥇", "🥈", "🥉"];
      return `<div class="top-issue-card">
        <div class="top-issue-rank">${medals[rank]} #${rank + 1} by time</div>
        <a class="top-issue-num" href="#issue-${issueNum}">#${issueNum}</a>
        <div class="top-issue-title">${title ? esc(title) : "—"}</div>
        <div class="top-issue-time">${fmtMs(ms)}</div>
      </div>`;
    }).join("");

    // ── ToC as table, sorted by time descending ──────────────────────────────
    const tocRows = [...byIssue.entries()]
      .sort((a, b) => (issueTimes.get(b[0]) ?? 0) - (issueTimes.get(a[0]) ?? 0))
      .map(([issueNum, segs]) => {
        const ms = issueTimes.get(issueNum);
        const timeStr = ms !== undefined ? fmtMs(ms) : "—";
        if (issueNum === null) {
          const speakers = [...new Set(segs.map(s => s.speaker))].join(", ");
          return `<tr><td colspan="2"><a href="#general-discussion">General Discussion</a> <span class="toc-general">${esc(speakers)}</span></td><td>${timeStr}</td></tr>`;
        }
        const title = segs[0]?.issue_title ?? "";
        return `<tr>
          <td style="white-space:nowrap"><a href="#issue-${issueNum}">#${issueNum}</a></td>
          <td>${esc(title)}</td>
          <td>${timeStr}</td>
        </tr>`;
      }).join("");

    const toc = `<div class="toc">
      <div class="toc-title">Contents</div>
      <table class="toc-table">
        <thead><tr><th>#</th><th>Issue</th><th>Time</th></tr></thead>
        <tbody>${tocRows}</tbody>
      </table>
    </div>`;

    // ── Issue sections (in transcript order) ────────────────────────────────
    const issueSections: string[] = [];

    for (const [issueNum, segs] of byIssue) {
      const segRepo = segs[0]?.issue_repo ?? "";
      const issueTitle = segs[0]?.issue_title ?? null;
      const issueState = segs[0]?.issue_state ?? "open";
      const speakers = [...new Set(segs.map(s => s.speaker))].join(", ");
      const snippets = segs.map(s =>
        `<div class="issue-snippet"><strong>${esc(s.speaker)}:</strong> ${esc(s.text)}</div>`
      ).join("\n");
      const timeSpent = issueTimes.get(issueNum);
      const timeBadge = timeSpent !== undefined
        ? `<span style="color:#4ade80;font-size:.8rem;font-weight:600">${fmtMs(timeSpent)}</span>`
        : "";

      if (issueNum) {
        const anchorId = `issue-${issueNum}`;
        const ghUrl = `https://github.com/${segRepo}/issues/${issueNum}`;
        const stateCls = issueState === "closed" ? "status-closed" : "status-open";
        const stateLabel = issueState === "closed" ? "closed" : "open";
        const titleLine = issueTitle
          ? `<div class="issue-title-text">${esc(issueTitle)}</div>`
          : "";
        const metaRow = `<div class="issue-meta-row">
          <span class="status-badge ${stateCls}">${stateLabel}</span>
          ${timeBadge}
          <a class="issue-gh-link" href="${esc(ghUrl)}" target="_blank">View on GitHub ↗</a>
        </div>`;
        issueSections.push(`<div class="issue-section" id="${anchorId}">
          <h3><a href="${esc(ghUrl)}" target="_blank">#${issueNum}</a></h3>
          ${titleLine}
          ${metaRow}
          <div class="issue-speakers">${esc(speakers)}</div>
          ${snippets}
        </div>`);
      } else {
        issueSections.unshift(`<div class="issue-section" id="general-discussion">
          <h3>General Discussion ${timeBadge}</h3>
          <div class="issue-speakers">${esc(speakers)}</div>
          ${snippets}
        </div>`);
      }
    }

    issueTranscriptHtml = `
      <h2>By Issue</h2>
      ${top3Html ? `<div class="top-issues">${top3Html}</div>` : ""}
      ${toc}
      ${issueSections.join("\n")}
    `;
  }

  const suggestionsHtml = suggestionsSection(r.id);
  const proposalsHtml = renderProposalsPane(r.id);

  return page(`#${r.id}`, `
    <a class="back" href="/">← All transcripts</a>
    <h1>Standup #${r.id}</h1>
    <p class="meta">${fmtDate(r.started_at)} &nbsp;·&nbsp; ${fmtDuration(r.started_at, r.ended_at)} &nbsp;·&nbsp; Channel ${esc(r.channel_id)}</p>

    <h2>Summary</h2>
    <div class="summary-box">${esc(r.summary)}</div>

    ${speakerChartHtml}

    <h2>Per Participant</h2>
    ${participantBlocks || '<p class="empty">No participant data.</p>'}

    ${proposalsHtml}

    ${issueTranscriptHtml}

    ${suggestionsHtml}

    <h2>Full Transcript</h2>
    <pre>${esc(r.transcript)}</pre>
  `);
}

function renderProposalsPane(standupId: number): string {
  const rows = getProposalsFor(standupId);
  if (rows.length === 0) return "";

  const order = ["executed", "affirmed", "failed", "edited", "pending", "dismissed"];
  const label: Record<string, string> = {
    executed: "Executed",
    affirmed: "Affirmed",
    failed: "Failed",
    edited: "Edited (not affirmed)",
    pending: "Pending at stop",
    dismissed: "Dismissed",
  };
  const grouped = new Map<string, ProposalDbRow[]>();
  for (const p of rows) {
    const list = grouped.get(p.state) ?? [];
    list.push(p);
    grouped.set(p.state, list);
  }

  const sections = order.map((state) => {
    const list = grouped.get(state);
    if (!list || list.length === 0) return "";
    const cards = list.map(renderProposalDbCard).join("");
    return `<h3 style="color:#94a3b8;font-size:.85rem;margin-top:1rem">${label[state] ?? state} (${list.length})</h3>${cards}`;
  }).join("");

  return `<h2>Proposed Actions</h2>${sections}`;
}

function renderProposalDbCard(p: ProposalDbRow): string {
  let payload: any = {};
  let original: any = {};
  let result: any = null;
  try { payload = JSON.parse(p.payload_json); } catch {}
  try { original = JSON.parse(p.original_payload_json); } catch {}
  try { if (p.execution_result_json) result = JSON.parse(p.execution_result_json); } catch {}

  const target = p.target_issue != null
    ? `<a href="https://github.com/${esc(p.repo)}/issues/${p.target_issue}" target="_blank">#${p.target_issue}</a>`
    : "new issue";
  const edited = JSON.stringify(payload) !== JSON.stringify(original);
  const reasoning = payload?.reasoning
    ? `<div style="color:#64748b;font-size:.8rem;font-style:italic;margin-bottom:.4rem">${esc(String(payload.reasoning))}</div>`
    : "";
  const payloadBlock = edited
    ? `<details><summary style="cursor:pointer;color:#a5b4fc;font-size:.82rem">Edited from original</summary>
         <pre style="font-size:.75rem">${esc(JSON.stringify(original, null, 2))}</pre>
         <div style="color:#fbbf24;font-size:.75rem">→ Edited to:</div>
         <pre style="font-size:.75rem">${esc(JSON.stringify(payload, null, 2))}</pre>
       </details>`
    : `<pre style="font-size:.75rem">${esc(JSON.stringify(payload, null, 2))}</pre>`;
  const resultBlock = result?.url
    ? `<div style="font-size:.82rem;margin-top:.35rem">Result: <a href="${esc(String(result.url))}" target="_blank">${esc(String(result.url))}</a></div>`
    : result?.error
      ? `<div style="font-size:.82rem;color:#fca5a5;margin-top:.35rem">Error: ${esc(String(result.error))}</div>`
      : "";
  return `<div class="suggestion-card">
    <div class="sug-type">${esc(p.action_type)} → ${target}</div>
    ${reasoning}
    ${payloadBlock}
    ${resultBlock}
  </div>`;
}

function esc(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── App factory ─────────────────────────────────────────────────────────────

export function createWebApp(bot?: StandupBot): Hono {
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

  // Deploy-safety check: list in-memory sessions a restart would drop.
  app.get("/internal/active-sessions", (c) => {
    if (!bot) return c.json({ sessions: [] });
    return c.json(bot.getActiveSessionsInfo());
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

  // AI-suggested GitHub actions for a transcript
  app.get("/transcripts/:id/suggestions", async (c) => {
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "invalid id" }, 400);

    const cached = suggestionsCache.get(id);
    if (cached) return c.json(cached);

    const row = getStandup(id);
    if (!row) return c.json({ error: "not found" }, 404);

    const summarizer = getSummarizer();
    if (!summarizer) return c.json({ error: "ANTHROPIC_API_KEY not configured" }, 500);

    const segments = getSegments(id);
    const repo = segments.find(s => s.issue_repo)?.issue_repo ?? null;
    if (!repo) return c.json({ error: "Cannot determine repo from transcript" }, 400);

    const issueSet = new Map<number, string>();
    for (const seg of segments) {
      if (seg.issue_number && seg.issue_title) {
        issueSet.set(seg.issue_number, seg.issue_title);
      }
    }
    const issues = [...issueSet.entries()].map(([number, title]) => ({ number, title }));

    try {
      const suggestions = await summarizer.suggestGitHubActions(row.transcript, issues, repo);
      suggestionsCache.set(id, suggestions);
      return c.json(suggestions);
    } catch (e: any) {
      console.error("[web] suggestGitHubActions error:", e.message);
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // Apply a suggestion to GitHub
  app.post("/transcripts/:id/suggestions/apply", async (c) => {
    // CSRF: reject cross-origin requests.
    const origin = c.req.header("origin");
    const host = c.req.header("host");
    try {
      if (origin && host && new URL(origin).host !== host) {
        return c.json({ error: "Forbidden" }, 403);
      }
    } catch {
      return c.json({ error: "Forbidden" }, 403);
    }

    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "invalid id" }, 400);

    const body = await c.req.json() as GitHubSuggestion;
    const { type, title, issueNumber, repo, body: content } = body;
    if (!type || !content || !repo) return c.json({ error: "Missing required fields" }, 400);

    try {
      if (type === "new_issue") {
        if (!title) return c.json({ error: "Missing title" }, 400);
        const result = await createIssue(repo, title, content);
        return c.json({ ok: true, url: result.url, number: result.number });
      } else if (type === "comment") {
        if (!issueNumber) return c.json({ error: "Missing issueNumber" }, 400);
        await createComment(repo, issueNumber, content);
        return c.json({ ok: true, url: `https://github.com/${repo}/issues/${issueNumber}` });
      }
      return c.json({ error: "Unknown type" }, 400);
    } catch (e: any) {
      console.error("[web] apply suggestion error:", e.message);
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  return app;
}

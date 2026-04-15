/**
 * Discord Activity server — Hono sub-app for the standup Activity.
 *
 * Routes (mounted at /activity):
 *   GET  /              → Activity HTML shell
 *   GET  /bundle.js     → Bundled client-side JS
 *   POST /api/token           → OAuth2 code→token exchange
 *   GET  /api/standups        → Available standups (key + displayName)
 *   GET  /api/picker-context  → Suggested standup for the landing channel
 *   GET  /api/issues          → GitHub issues grouped by participant
 *   GET  /ws                  → WebSocket for real-time session state
 */

import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import {
  STANDUPS,
  STANDUP_NAMES,
  getStage,
  deriveSteps,
  suggestStandupForChannelName,
  standupKeyForRepo,
  type StandupConfig,
} from "./review";
import {
  fetchRecentlyUpdated,
  fetchOpenNonBacklog,
  fetchUserAvatar,
  fetchIssueDetail,
  assignIssue,
  fetchOpenPRsByAuthor,
  fetchPRDetail,
  fetchAssigneeUpdates,
  sinceLastBusinessDayStart,
  type GitHubIssue,
  type GitHubPR,
} from "./github";
import { Summarizer, type AssigneeBrief } from "./summarizer";
import type { StandupBot } from "./bot";
import { serializeProposal } from "./bot";

const CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? "";

// ── Client bundle (built once at import time) ───────────────────────────────

let clientBundle = "console.error('Bundle not built yet');";

async function buildClientBundle(): Promise<void> {
  try {
    const result = await Bun.build({
      entrypoints: ["./src/activity-client.ts"],
      minify: true,
      target: "browser",
    });
    if (result.success && result.outputs.length > 0) {
      clientBundle = await result.outputs[0].text();
      console.log(`[activity] Client bundle built: ${clientBundle.length} bytes`);
    } else {
      console.error("[activity] Bundle build failed:", result.logs);
    }
  } catch (e: any) {
    console.error("[activity] Bundle build error:", e.message);
  }
}

// Build immediately — store promise so /bundle.js can await it on cold start
const bundleReady = buildClientBundle();

// Per-process version stamp — appended to bundle.js in the HTML so each deploy
// forces a fresh fetch even when caches (Discord's proxy, browser heuristic)
// would otherwise serve a stale copy.
const BUNDLE_VERSION = Date.now().toString(36);

// ── Activity HTML shell ─────────────────────────────────────────────────────

function activityHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Standup Activity</title>
  <style>${ACTIVITY_CSS}</style>
  <script>window.__DISCORD_CLIENT_ID__ = ${JSON.stringify(CLIENT_ID)};</script>
</head>
<body>
  <div id="app"><div class="loading">Loading...</div></div>
  <script src="bundle.js?v=${BUNDLE_VERSION}"></script>
</body>
</html>`;
}

const ACTIVITY_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;overflow-x:hidden}
  #app{min-height:100vh;display:flex;flex-direction:column}

  /* Loading / Error */
  .loading{display:flex;align-items:center;justify-content:center;min-height:100vh;color:#64748b;font-size:1rem}
  .error{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:1rem;text-align:center;padding:2rem}
  .error h2{color:#f87171}
  .error p{color:#94a3b8;max-width:400px}
  .error button{background:#4f46e5;color:white;border:none;padding:.5rem 1.5rem;border-radius:.375rem;cursor:pointer;font-size:.9rem}
  .error button:hover{background:#4338ca}
  .error-text{color:#f87171}

  /* Standup Picker */
  .picker{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:1rem;padding:1rem}
  .picker h1{color:#818cf8;font-size:1.5rem}
  .picker-subtitle{color:#64748b;font-size:.9rem;text-align:center;max-width:320px}
  .picker-primary{display:flex;flex-direction:column;align-items:center;gap:.5rem}
  .picker-others{display:flex;flex-direction:column;align-items:center;gap:.5rem;width:100%;max-width:280px}
  .picker-others-toggle{background:none;border:none;color:#94a3b8;font-size:.85rem;cursor:pointer;padding:.25rem .5rem;display:flex;align-items:center;gap:.25rem}
  .picker-others-toggle:hover{color:#e2e8f0}
  .picker-others-toggle .caret{display:inline-block;transition:transform .15s}
  .picker-others[data-open="true"] .picker-others-toggle .caret{transform:rotate(90deg)}
  .picker-others-list{display:none;flex-direction:column;gap:.5rem;width:100%;align-items:center}
  .picker-others[data-open="true"] .picker-others-list{display:flex}
  .standup-btn{background:#1e293b;color:#e2e8f0;border:1px solid #334155;padding:.75rem 2rem;border-radius:.5rem;cursor:pointer;font-size:1rem;min-width:200px;transition:all .15s}
  .standup-btn:hover{background:#334155;border-color:#818cf8}
  .standup-btn-primary{background:#4338ca;border-color:#818cf8;color:#fff;font-size:1.1rem;font-weight:600;padding:1rem 2.5rem;min-width:240px;box-shadow:0 4px 12px rgba(129,140,248,.25)}
  .standup-btn-primary:hover{background:#4f46e5;border-color:#a5b4fc}
  .picker-reason{color:#64748b;font-size:.75rem;font-style:italic}

  /* Header */
  .header{display:flex;align-items:center;justify-content:space-between;padding:.75rem 1rem;background:#1e293b;border-bottom:1px solid #334155;flex-shrink:0}
  .header-left{display:flex;align-items:center;gap:.5rem}
  .header-title{color:#818cf8;font-weight:600;font-size:1rem}
  .header-right{display:flex;align-items:center;gap:.75rem;color:#94a3b8;font-size:.85rem}
  .refresh-btn{background:none;border:none;color:#64748b;cursor:pointer;font-size:.85rem;padding:.2rem .4rem;border-radius:.25rem;transition:color .15s}
  .refresh-btn:hover{color:#e2e8f0}
  .refresh-btn.spinning{animation:spin .7s linear infinite}
  @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
  .rec-dot{width:10px;height:10px;border-radius:50%;background:#ef4444;animation:pulse 1.5s infinite}
  .speaking-active{border-bottom-color:#818cf8}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .utterance-count{color:#64748b}

  /* Tabs */
  .tabs{display:flex;gap:.25rem;padding:.5rem 1rem;background:#0f172a;border-bottom:1px solid #1e293b;flex-shrink:0;overflow-x:auto}
  .tab{display:flex;align-items:center;gap:.35rem;background:#1e293b;color:#94a3b8;border:1px solid #334155;padding:.4rem 1rem;border-radius:.375rem;cursor:pointer;font-size:.85rem;white-space:nowrap;transition:all .15s}
  .tab:hover{background:#334155;color:#e2e8f0}
  .tab-active{background:#4f46e5;color:white;border-color:#4f46e5}
  .tab-speaking{box-shadow:0 0 0 2px rgba(129,140,248,.5)}
  .tab-name{}
  .tab-time{font-size:.7rem;color:#4ade80;font-family:monospace;min-width:2.2rem;text-align:right}
  .tab-active .tab-time{color:#a5f3c8}
  .tab-not-present{opacity:.45;filter:grayscale(.6)}
  .tab-not-present:hover{opacity:.7}
  .tab-absent-tag{font-size:.65rem;color:#94a3b8;font-style:italic;margin-left:.15rem}

  /* Board */
  .board{flex:1;overflow-y:auto;padding:1rem}
  .board-participant{display:flex;align-items:center;gap:.75rem;margin-bottom:1rem}
  .board-avatar{width:32px;height:32px;border-radius:50%}
  .board-name{font-size:1.1rem;font-weight:600;color:#c7d2fe}
  .empty-board{display:flex;align-items:center;justify-content:center;flex:1;color:#64748b}

  /* Stage Groups */
  .stages{display:flex;flex-direction:column;gap:.75rem}
  .stage-group{margin-bottom:.25rem}
  .stage-header{color:#94a3b8;font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-bottom:.35rem;padding-left:.25rem}

  /* Issue Cards */
  .issue-card{display:flex;align-items:flex-start;justify-content:space-between;background:#1e293b;border:1px solid #334155;border-radius:.375rem;padding:.5rem .75rem;cursor:pointer;transition:all .15s;margin-bottom:.25rem;gap:.5rem}
  .issue-card:hover{background:#334155}
  .issue-focused{border-color:#818cf8;background:#1e1b4b;box-shadow:0 0 0 1px rgba(129,140,248,.3)}
  .issue-header{display:flex;align-items:flex-start;gap:.5rem;min-width:0;flex:1}
  .issue-number{color:#818cf8;font-size:.82rem;font-weight:600;flex-shrink:0;padding-top:.05rem}
  .issue-title{color:#cbd5e1;font-size:.85rem;word-break:break-word;line-height:1.4}
  .issue-badges{display:flex;gap:.25rem;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;padding-top:.05rem}
  .badge{font-size:.7rem;padding:.1rem .35rem;border-radius:.25rem;font-weight:600}
  .badge-p0{background:#450a0a;color:#fca5a5}
  .badge-p1{background:#431407;color:#fdba74}
  .badge-p2{background:#422006;color:#fde68a}
  .badge-bug{background:#1c1917;color:#a8a29e}

  /* Navigation */
  .board-nav{display:flex;gap:.5rem;margin-top:1rem;padding-top:1rem;border-top:1px solid #1e293b}
  .nav-btn{background:#1e293b;color:#94a3b8;border:1px solid #334155;padding:.5rem 1rem;border-radius:.375rem;cursor:pointer;font-size:.85rem;flex:1;transition:all .15s}
  .nav-btn:hover:not(:disabled){background:#334155;color:#e2e8f0}
  .nav-btn:disabled{opacity:.3;cursor:not-allowed}
  .nav-btn-primary{background:#4f46e5;color:white;border-color:#4f46e5}
  .nav-btn-primary:hover{background:#4338ca}

  /* Standup brief card (auto-generated per-assignee) */
  .brief-card{background:linear-gradient(135deg,#1e1b4b 0%,#1e293b 100%);border:1px solid #4338ca;border-radius:.5rem;padding:.9rem 1rem;margin-bottom:1rem;position:relative}
  .brief-header{display:flex;align-items:flex-start;justify-content:space-between;gap:.5rem;margin-bottom:.55rem}
  .brief-headline{font-size:.95rem;font-weight:600;color:#c7d2fe;line-height:1.35;flex:1}
  .brief-refresh{background:none;border:none;color:#818cf8;cursor:pointer;font-size:.8rem;padding:.15rem .35rem;border-radius:.25rem;flex-shrink:0}
  .brief-refresh:hover{background:#312e81;color:#e0e7ff}
  .brief-refresh.spinning{animation:spin .7s linear infinite}
  .brief-bullets{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.35rem}
  .brief-bullet{font-size:.85rem;color:#cbd5e1;line-height:1.45;display:flex;align-items:flex-start;gap:.4rem}
  .brief-bullet::before{content:"•";color:#818cf8;font-weight:700;flex-shrink:0;margin-top:.05rem}
  .brief-bullet .bullet-text{flex:1}
  .brief-bullet .live-issue{cursor:pointer}
  .brief-skeleton{background:#1e293b;border:1px solid #334155;border-radius:.5rem;padding:.9rem 1rem;margin-bottom:1rem}
  .brief-skeleton-line{height:.65rem;background:linear-gradient(90deg,#334155 25%,#475569 50%,#334155 75%);background-size:200% 100%;animation:brief-shimmer 1.4s ease-in-out infinite;border-radius:.2rem;margin-bottom:.5rem}
  .brief-skeleton-line:nth-child(1){width:72%}
  .brief-skeleton-line:nth-child(2){width:55%}
  .brief-skeleton-line:nth-child(3){width:62%}
  .brief-skeleton-line:last-child{margin-bottom:0}
  @keyframes brief-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
  .brief-error{font-size:.78rem;color:#fca5a5;font-style:italic}

  /* Live Feed — sticky at bottom of viewport so it stays visible while scrolling tabs */
  .live-feed{position:sticky;bottom:0;z-index:5;padding:.75rem 1rem .75rem 2.25rem;border-top:1px solid #1e293b;max-height:180px;overflow-y:auto;flex-shrink:0;background:rgba(15,23,42,.92);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
  .live-feed-collapsed{max-height:2.4rem;overflow:hidden}
  .live-feed-collapsed .live-entry:not(:first-child){display:none}
  .live-feed-toggle{position:absolute;top:.35rem;left:.5rem;background:none;border:none;color:#64748b;cursor:pointer;font-size:.85rem;padding:.15rem .3rem;border-radius:.25rem;line-height:1}
  .live-feed-toggle:hover{color:#e2e8f0;background:#1e293b}
  .live-entry{font-size:.82rem;color:#94a3b8;padding:.25rem 0;border-bottom:1px solid #0f172a;line-height:1.4}
  .live-entry strong{color:#c7d2fe}
  .live-issue{background:#1e1b4b;color:#a5b4fc;padding:.05rem .3rem;border-radius:.2rem;font-size:.75rem;margin-right:.25rem}

  /* Freshness indicators */
  .issue-age{font-size:.7rem;margin-left:.25rem;flex-shrink:0}
  .fresh-today{color:#4ade80}
  .fresh-week{color:#fbbf24}
  .fresh-stale{color:#64748b}

  /* Per-issue timer */
  .issue-timer{font-family:monospace;font-size:.7rem;background:#1e1b4b;color:#a5b4fc;padding:.1rem .35rem;border-radius:.25rem;margin-right:.25rem}

  /* Discussed count in header */
  .discussed-count{background:#1e1b4b;color:#a5b4fc;padding:.15rem .5rem;border-radius:.25rem;font-size:.78rem}

  /* Issue number clickable */
  .issue-number{cursor:pointer;text-decoration:underline;text-decoration-color:transparent;transition:text-decoration-color .15s}
  .issue-number:hover{text-decoration-color:#818cf8}

  /* Detail overlay */
  .detail-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:100;display:flex;align-items:center;justify-content:center;padding:1rem}
  .detail-panel{background:#1e293b;border:1px solid #334155;border-radius:.5rem;max-width:640px;width:100%;max-height:80vh;overflow-y:auto;padding:1.25rem}
  .detail-header{display:flex;align-items:flex-start;gap:.5rem;margin-bottom:.75rem}
  .detail-number{color:#818cf8;font-weight:700;font-size:1.1rem;flex-shrink:0}
  .detail-title{color:#e2e8f0;font-size:1rem;font-weight:600;flex:1}
  .detail-close{background:none;border:none;color:#64748b;cursor:pointer;font-size:1rem;padding:.25rem .5rem;margin-left:auto;flex-shrink:0}
  .detail-close:hover{color:#e2e8f0}
  /* Issue meta (creator / assignees / state) */
  .detail-meta{display:flex;align-items:center;flex-wrap:wrap;gap:.35rem .5rem;margin-bottom:.6rem;font-size:.78rem;color:#94a3b8}
  .detail-meta strong{color:#c7d2fe}
  .detail-meta-sep{color:#475569}
  .detail-meta-state-open{color:#4ade80}
  .detail-meta-state-closed{color:#94a3b8}

  .detail-labels{display:flex;gap:.25rem;flex-wrap:wrap;margin-bottom:.75rem}
  .detail-label{font-size:.72rem;padding:.15rem .4rem;background:#0f172a;color:#94a3b8;border-radius:.25rem}
  .detail-body{font-size:.85rem;line-height:1.6;color:#cbd5e1;border-top:1px solid #334155;padding-top:.75rem;margin-bottom:.75rem;word-break:break-word}
  .detail-comments-header{color:#94a3b8;font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-bottom:.5rem;padding-top:.5rem;border-top:1px solid #334155}
  .detail-comment{background:#0f172a;border-radius:.375rem;padding:.75rem;margin-bottom:.5rem}
  .comment-meta{font-size:.78rem;color:#94a3b8;margin-bottom:.35rem}
  .comment-meta strong{color:#c7d2fe}
  .comment-date{color:#64748b;margin-left:.5rem}
  .comment-body{font-size:.82rem;line-height:1.5;color:#cbd5e1;word-break:break-word}
  .detail-link{display:inline-block;margin-top:.75rem;color:#818cf8;font-size:.85rem;text-decoration:none}
  .detail-link:hover{text-decoration:underline}

  /* Closed issue cards */
  .issue-card-closed{opacity:.7}
  .issue-card-closed .issue-title{text-decoration:line-through;text-decoration-color:#64748b}

  /* Reassign section in detail panel */
  .detail-reassign{display:flex;gap:.5rem;align-items:center;margin-top:.75rem;padding-top:.75rem;border-top:1px solid #334155}
  .detail-reassign-label{color:#94a3b8;font-size:.78rem;white-space:nowrap}
  .assign-select{background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:.375rem;padding:.35rem .5rem;font-size:.82rem;flex:1;min-width:0}
  .assign-select option{background:#0f172a}
  .btn-assign{background:#4f46e5;color:white;border:none;padding:.35rem .75rem;border-radius:.375rem;cursor:pointer;font-size:.82rem;flex-shrink:0;transition:background .15s}
  .btn-assign:hover:not(:disabled){background:#4338ca}
  .btn-assign:disabled{opacity:.5;cursor:not-allowed}

  /* Sync / Freestyle badge */
  .sync-badge{font-size:.72rem;padding:.15rem .45rem;border-radius:.25rem;font-weight:600;margin-left:.5rem}
  .sync-badge-presenter{background:#1e3a1e;color:#4ade80}
  .sync-badge-synced{background:#3b0000;color:#fca5a5}
  .sync-badge-freestyle{background:#1c1917;color:#a8a29e;cursor:pointer}
  .sync-badge-freestyle:hover{background:#292524}

  /* Nav center button variants */
  .nav-btn-presenter{background:#1e3a1e;color:#4ade80;border-color:#166534;opacity:.9}
  .nav-btn-synced{background:#3b0000;color:#fca5a5;border-color:#7f1d1d}
  .nav-btn-synced:hover{background:#450a0a;color:#fca5a5}
  .nav-btn-sync{background:#1e1b4b;color:#a5b4fc;border-color:#3730a3}
  .nav-btn-sync:hover{background:#2e27a0;color:#c7d2fe}

  /* Direct GitHub link icon on cards */
  .gh-link{color:#475569;font-size:.78rem;text-decoration:none;padding:.05rem .25rem;border-radius:.2rem;flex-shrink:0;transition:color .15s;line-height:1;align-self:center}
  .gh-link:hover{color:#818cf8}

  /* PR cards */
  .pr-card{display:flex;align-items:flex-start;justify-content:space-between;background:#1e293b;border:1px solid #334155;border-radius:.375rem;padding:.5rem .75rem;margin-bottom:.25rem;gap:.5rem;cursor:pointer;transition:all .15s}
  .pr-card:hover{background:#334155}
  .pr-card-draft{opacity:.65;border-style:dashed}
  .badge-draft{background:#292524;color:#a8a29e}
  .badge-merged{background:#2d1b69;color:#a78bfa}

  /* PR detail modal */
  .pr-stats{display:flex;gap:.75rem;align-items:center;margin:.5rem 0;padding:.5rem .75rem;background:#0f172a;border-radius:.375rem}
  .pr-stat{font-size:.82rem;font-family:monospace;font-weight:600}
  .pr-stat-add{color:#4ade80}
  .pr-stat-del{color:#f87171}
  .pr-stat-files{color:#94a3b8}
  .pr-branch{font-family:monospace;font-size:.75rem;background:#0f172a;color:#94a3b8;padding:.1rem .35rem;border-radius:.2rem}
  .pr-reviews{display:flex;flex-wrap:wrap;gap:.5rem;margin:.5rem 0;font-size:.82rem}
  .pr-review{color:#94a3b8}
  .pr-review strong{color:#c7d2fe}
  .pr-files{display:flex;flex-direction:column;gap:.15rem;max-height:200px;overflow-y:auto}
  .pr-file{display:flex;align-items:center;gap:.5rem;font-size:.78rem;padding:.25rem .5rem;background:#0f172a;border-radius:.25rem}
  .pr-file-status{font-weight:700;font-family:monospace;width:1rem;text-align:center;flex-shrink:0}
  .pr-file-added{color:#4ade80}
  .pr-file-removed{color:#f87171}
  .pr-file-modified{color:#fbbf24}
  .pr-file-renamed{color:#818cf8}
  .pr-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#cbd5e1}
  .pr-file-diff{flex-shrink:0;font-family:monospace;font-size:.72rem}
  .detail-meta-state-merged{color:#a78bfa}

  /* Live Action Bar (#53) — default-collapsed, slides up from bottom */
  .action-bar{position:fixed;left:0;right:0;bottom:0;z-index:20;pointer-events:none;display:flex;flex-direction:column;align-items:stretch}
  .action-bar .action-bar-inner{pointer-events:auto;background:rgba(15,23,42,.98);border-top:1px solid #312e81;box-shadow:0 -6px 24px rgba(0,0,0,.45)}
  .action-bar-handle{display:flex;align-items:center;gap:.5rem;width:100%;padding:.45rem .75rem;background:#1e1b4b;color:#c7d2fe;border:none;border-top:1px solid #312e81;cursor:pointer;font-size:.82rem;font-weight:600;letter-spacing:.02em}
  .action-bar-handle:hover{background:#2e27a0}
  .action-bar-handle.has-pending{background:#312e81;color:#e0e7ff}
  .action-bar-badge{min-width:1.1rem;padding:.05rem .35rem;background:#4f46e5;color:white;border-radius:999px;font-size:.72rem;text-align:center;display:inline-block}
  .action-bar-badge[data-count="0"]{display:none}
  .action-bar-label{flex:1;text-align:left}
  .action-bar-chevron{font-size:.7rem;color:#a5b4fc}
  .action-bar-drawer{max-height:0;overflow:hidden;transition:max-height .18s ease}
  .action-bar-drawer.open{max-height:60vh;overflow-y:auto}
  .action-bar-drawer-inner{padding:.6rem .75rem .9rem;display:flex;flex-direction:column;gap:.5rem}
  .action-bar-empty{color:#64748b;font-size:.82rem;text-align:center;padding:.75rem}
  .proposal-card{background:#1e293b;border:1px solid #334155;border-radius:.4rem;display:flex;flex-direction:column}
  .proposal-card.state-affirmed{border-color:#6366f1}
  .proposal-card.state-executed{border-color:#166534;background:#052e16}
  .proposal-card.state-failed{border-color:#7f1d1d;background:#2b0505}
  .proposal-card.state-edited{border-color:#a16207}
  .proposal-summary{display:flex;align-items:center;gap:.45rem;padding:.45rem .65rem;font-size:.8rem;cursor:pointer;min-width:0}
  .proposal-summary:hover{background:rgba(129,140,248,.05)}
  .proposal-chevron{color:#64748b;font-size:.7rem;flex-shrink:0;width:.8rem;text-align:center}
  .proposal-type{font-weight:700;color:#a5b4fc;text-transform:uppercase;letter-spacing:.04em;font-size:.7rem;flex-shrink:0}
  .proposal-target{color:#94a3b8;font-family:monospace}
  .proposal-target a{color:#c7d2fe;text-decoration:none}
  .proposal-target a:hover{text-decoration:underline}
  .proposal-target-link{color:#c7d2fe;font-family:monospace;text-decoration:none;flex-shrink:0}
  .proposal-target-link:hover{text-decoration:underline}
  .proposal-summary-text{color:#cbd5e1;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .proposal-summary-spacer{flex-shrink:0}
  .proposal-reasoning{color:#94a3b8;font-size:.75rem;font-style:italic;padding:0 .65rem .35rem}
  .proposal-reasoning:empty{display:none}
  .proposal-body{padding:.1rem .65rem .6rem;display:flex;flex-direction:column;gap:.4rem}
  .proposal-card[data-expanded="0"] .proposal-body{display:none}
  .proposal-field{display:flex;flex-direction:column;gap:.15rem}
  .proposal-field label{font-size:.7rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.03em}
  .proposal-field input,.proposal-field textarea,.proposal-field select{background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:.3rem;padding:.35rem .45rem;font-size:.82rem;font-family:inherit}
  .proposal-field textarea{min-height:3.2rem;resize:vertical}
  .proposal-actions{display:flex;gap:.4rem;align-items:center;justify-content:flex-end}
  .proposal-status{font-size:.72rem;color:#94a3b8;flex-shrink:0}
  .proposal-status.ok{color:#4ade80}
  .proposal-status.err{color:#fca5a5}
  .proposal-status a{color:inherit;text-decoration:underline}
  .proposal-btn{background:#1e1b4b;color:#c7d2fe;border:1px solid #312e81;padding:.3rem .7rem;border-radius:.3rem;cursor:pointer;font-size:.78rem;transition:background .1s}
  .proposal-btn:hover:not(:disabled){background:#2e27a0}
  .proposal-btn:disabled{opacity:.5;cursor:not-allowed}
  .proposal-btn-primary{background:#4f46e5;color:white;border-color:#4f46e5}
  .proposal-btn-primary:hover:not(:disabled){background:#4338ca}
  .proposal-btn-spinner::after{content:"…";margin-left:.25rem}
  .proposal-dismiss{background:none;border:none;color:#64748b;cursor:pointer;font-size:1rem;padding:0 .25rem}
  .proposal-dismiss:hover{color:#f87171}
  .proposal-card.state-executed .proposal-actions,
  .proposal-card.state-dismissed .proposal-actions{display:none}
  .proposal-card[data-locked="1"] .proposal-field input,
  .proposal-card[data-locked="1"] .proposal-field textarea,
  .proposal-card[data-locked="1"] .proposal-field select{pointer-events:none;opacity:.7}

  /* Extra (unlisted) participant badge on board header */
  .board-extra-badge{font-size:.7rem;padding:.15rem .4rem;background:#292524;color:#a8a29e;border-radius:.25rem;margin-left:.5rem}
  /* All-PRs tab distinct styling */
  .tab-pr{border-left:1px solid #334155;margin-left:.25rem}
  .tab-pr.tab-active{background:#1e1b4b;color:#a5b4fc;border-bottom-color:#6366f1}
`;

// ── Issues TTL cache ────────────────────────────────────────────────────────

/** Cache /api/issues responses per standup key for 2 minutes to avoid hammering GitHub. */
const issuesCache = new Map<string, { data: object; expiresAt: number }>();
const ISSUES_CACHE_TTL_MS = 2 * 60 * 1_000;

/**
 * Cache per-assignee briefs keyed by `${standupKey}:${assignee}:${windowStart}`.
 * TTL = 1h. Everyone in the same standup window shares the same brief so
 * facilitators see consistent text. `refresh=1` busts the entry.
 */
const briefCache = new Map<string, { brief: AssigneeBrief | null; expiresAt: number }>();
const BRIEF_CACHE_TTL_MS = 60 * 60 * 1_000;
/** Coalesce in-flight brief requests so concurrent callers share one Claude call. */
const briefInflight = new Map<string, Promise<AssigneeBrief | null>>();

// ── Issue data helpers ──────────────────────────────────────────────────────

interface StageGroupOutput {
  emoji: string;
  name: string;
  issues: GitHubIssue[];
}

function groupByStage(issues: GitHubIssue[]): StageGroupOutput[] {
  const fallback = { emoji: "📋", name: "Other", order: 99 };
  const groups = new Map<string, { emoji: string; name: string; order: number; issues: GitHubIssue[] }>();

  for (const issue of issues) {
    const stage = getStage(issue.labels) ?? fallback;
    if (!groups.has(stage.name)) {
      groups.set(stage.name, { ...stage, issues: [] });
    }
    groups.get(stage.name)!.issues.push(issue);
  }

  return [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ emoji, name, issues }) => ({ emoji, name, issues }));
}

async function fetchParticipantData(config: StandupConfig) {
  // Participants are derived from GitHub: Unassigned first, then every open
  // assignee (sorted by display name). deriveSteps handles the GitHub fetch
  // and graceful fallback to just [Unassigned] if the API call fails.
  const steps = await deriveSteps(config);

  return await Promise.all(steps.map(async (step) => {
    let allOpen: GitHubIssue[] = [];
    let recentClosed: GitHubIssue[] = [];
    let avatarUrl = "";
    let prs: GitHubPR[] = [];

    if (step.type === "assignee") {
      const [recent, open, fetchedPRs] = await Promise.all([
        fetchRecentlyUpdated(config.repo, step.githubUser),
        fetchOpenNonBacklog(config.repo, step.githubUser, config.backlogLabel),
        fetchOpenPRsByAuthor(config.repo, step.githubUser),
      ]);
      avatarUrl = `/avatar?user=${encodeURIComponent(step.githubUser)}`;
      prs = fetchedPRs;
      const recentNums = new Set(recent.map(i => i.number));
      const recentOpen = recent.filter(i => i.state === "open");
      recentClosed = recent.filter(i => i.state === "closed");
      const openDeduped = open.filter(i => !recentNums.has(i.number));
      allOpen = [...recentOpen, ...openDeduped];
    } else {
      allOpen = await fetchOpenNonBacklog(config.repo, null, config.backlogLabel);
    }

    const stages: StageGroupOutput[] = [];
    if (recentClosed.length > 0) {
      stages.push({ emoji: "🏁", name: "Closed Today", issues: recentClosed });
    }
    stages.push(...groupByStage(allOpen));

    return {
      name: step.displayName,
      githubUser: step.type === "assignee" ? step.githubUser : null,
      discordId: step.type === "assignee" ? step.discordId ?? null : null,
      avatarUrl,
      stages,
      prs,
    };
  }));
}

// ── App factory ─────────────────────────────────────────────────────────────

export function createActivityApp(
  bot: StandupBot,
  upgradeWebSocket: UpgradeWebSocket,
): Hono {
  const app = new Hono();

  // Serve Activity HTML shell
  app.get("/", (c) => {
    console.log("[activity] Serving HTML shell");
    return c.html(activityHtml());
  });

  // Serve bundled client JS — await build completion on cold starts
  app.get("/bundle.js", async (c) => {
    await bundleReady;
    console.log(`[activity] Serving bundle.js (${clientBundle.length} bytes)`);
    return new Response(clientBundle, {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  });

  // OAuth2 token exchange
  app.post("/api/token", async (c) => {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      return c.json({ error: "Activity not configured (missing CLIENT_ID or CLIENT_SECRET)" }, 500);
    }

    const { code } = await c.req.json();
    if (!code) return c.json({ error: "Missing code" }, 400);

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: `https://${CLIENT_ID}.discordsays.com`,
    });

    const tokenRes = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error("[activity] Token exchange failed:", tokenRes.status, text);
      return c.json({ error: "Token exchange failed" }, 400);
    }

    const tokenData = await tokenRes.json();
    return c.json({ access_token: tokenData.access_token });
  });

  // Available standups (key + displayName). Clients render displayName
  // but send key back on selection.
  app.get("/api/standups", (c) => {
    const out = STANDUP_NAMES.map((key) => ({
      key,
      displayName: STANDUPS[key].displayName,
    }));
    return c.json(out);
  });

  // Picker context: given the voice channel the Activity was launched in,
  // return the suggested standup (active session > channel-name match > none)
  // so the client can pre-highlight one project and collapse the others.
  app.get("/api/picker-context", async (c) => {
    const channelId = c.req.query("channelId") || null;
    // Active session in *this* voice channel (per-channel keying, #61). With
    // multiple concurrent standups in one guild, only the one in the user's
    // channel should drive the picker.
    const session = bot.getSessionForChannel(channelId);
    const activeStandup = session ? standupKeyForRepo(session.meta.issueRepo) : null;
    const activeSession = session && activeStandup
      ? {
          standupKey: activeStandup,
          watcherCount: session.meta.connectedUsers.size,
        }
      : null;

    let channelName: string | null = null;
    if (channelId) {
      channelName = await bot.getChannelName(channelId);
    }
    const channelSuggestion = suggestStandupForChannelName(channelName);

    let suggestedStandup: string | null = null;
    let reason: "active-session" | "channel-name" | null = null;
    if (activeStandup) {
      suggestedStandup = activeStandup;
      reason = "active-session";
    } else if (channelSuggestion) {
      suggestedStandup = channelSuggestion;
      reason = "channel-name";
    }

    return c.json({ suggestedStandup, reason, channelName, activeSession });
  });

  // GitHub issues grouped by participant
  app.get("/api/issues", async (c) => {
    const standupKey = c.req.query("standup");
    if (!standupKey || !STANDUPS[standupKey]) {
      return c.json({ error: `Unknown standup. Choose from: ${STANDUP_NAMES.join(", ")}` }, 400);
    }

    // Serve cached response if still fresh — prevents hammering GitHub Search API
    // when multiple Activity clients load simultaneously.
    const cached = issuesCache.get(standupKey);
    if (cached && Date.now() < cached.expiresAt) {
      console.log(`[activity] /api/issues cache hit for "${standupKey}"`);
      return c.json(cached.data);
    }

    const config = STANDUPS[standupKey];
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Issues fetch timed out after 25s")), 25_000)
      );
      const participants = await Promise.race([fetchParticipantData(config), timeout]);
      const responseData = { standupKey, repo: config.repo, participants };
      issuesCache.set(standupKey, { data: responseData, expiresAt: Date.now() + ISSUES_CACHE_TTL_MS });
      return c.json(responseData);
    } catch (e: any) {
      console.error("[activity] Issues fetch error:", e.message);
      return c.json({ error: e.message }, 500);
    }
  });

  // Auto-generated per-assignee standup brief (lazy, cached per standup window)
  app.get("/api/assignee-brief", async (c) => {
    const standupKey = c.req.query("standup");
    const assignee = c.req.query("assignee");
    const refresh = c.req.query("refresh") === "1";

    if (!standupKey || !STANDUPS[standupKey]) {
      return c.json({ error: `Unknown standup` }, 400);
    }
    if (!assignee || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(assignee)) {
      return c.json({ error: "Missing or invalid assignee" }, 400);
    }

    const config = STANDUPS[standupKey];
    const windowStart = sinceLastBusinessDayStart();
    const cacheKey = `${standupKey}:${assignee}:${windowStart}`;

    if (!refresh) {
      const cached = briefCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        return c.json({ brief: cached.brief, cached: true });
      }
    } else {
      briefCache.delete(cacheKey);
      briefInflight.delete(cacheKey);
    }

    const inflight = briefInflight.get(cacheKey);
    if (inflight) {
      try {
        const brief = await inflight;
        return c.json({ brief, cached: true });
      } catch (e: any) {
        return c.json({ error: e.message || "Brief generation failed" }, 500);
      }
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return c.json({ error: "ANTHROPIC_API_KEY not configured" }, 500);

    const promise = (async (): Promise<AssigneeBrief | null> => {
      const updates = await fetchAssigneeUpdates(config.repo, assignee, windowStart);
      if (updates.length === 0) return null;
      const summarizer = new Summarizer(apiKey);
      return summarizer.summarizeAssigneeDay(assignee, updates);
    })();

    briefInflight.set(cacheKey, promise);
    try {
      const brief = await promise;
      briefCache.set(cacheKey, { brief, expiresAt: Date.now() + BRIEF_CACHE_TTL_MS });
      return c.json({ brief });
    } catch (e: any) {
      console.error("[activity] Brief error:", e.message);
      return c.json({ error: "Brief generation failed" }, 500);
    } finally {
      briefInflight.delete(cacheKey);
    }
  });

  // Proxy GitHub avatars to avoid CORS/CSP issues inside Discord's Activity sandbox
  app.get("/avatar", async (c) => {
    const user = c.req.query("user") ?? "";
    if (!user || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(user)) {
      return c.json({ error: "Invalid user" }, 400);
    }
    try {
      const avatarUrl = await fetchUserAvatar(user);
      const res = await fetch(avatarUrl, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return c.json({ error: "Avatar fetch failed" }, 502);
      return new Response(res.body, {
        headers: {
          "Content-Type": res.headers.get("Content-Type") ?? "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      });
    } catch (e: any) {
      console.error("[activity] Avatar proxy error:", e.message);
      return c.json({ error: "Avatar unavailable" }, 502);
    }
  });

  // Single issue detail (body + comments)
  app.get("/api/issues/:repo/:number", async (c) => {
    const repo = decodeURIComponent(c.req.param("repo"));
    const number = parseInt(c.req.param("number"));
    if (!repo || isNaN(number)) return c.json({ error: "Invalid params" }, 400);

    // Validate repo is one configured in STANDUPS — prevents probing arbitrary repos.
    const validRepos = new Set(Object.values(STANDUPS).map(s => s.repo));
    if (!validRepos.has(repo)) return c.json({ error: "Unknown repository" }, 403);

    try {
      const detail = await fetchIssueDetail(repo, number);
      return c.json(detail);
    } catch (e: any) {
      console.error("[activity] Issue detail error:", e.message);
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // Single PR detail (body + reviews + changed files)
  app.get("/api/prs/:repo/:number", async (c) => {
    const repo = decodeURIComponent(c.req.param("repo"));
    const number = parseInt(c.req.param("number"));
    if (!repo || isNaN(number)) return c.json({ error: "Invalid params" }, 400);

    const validRepos = new Set(Object.values(STANDUPS).map(s => s.repo));
    if (!validRepos.has(repo)) return c.json({ error: "Unknown repository" }, 403);

    try {
      const detail = await fetchPRDetail(repo, number);
      return c.json(detail);
    } catch (e: any) {
      console.error("[activity] PR detail error:", e.message);
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // CSRF guard — reject cross-origin POSTs from anywhere except our own host
  // or Discord's Activity proxy (*.discordsays.com).
  const csrfOk = (c: any): boolean => {
    const origin = c.req.header("origin");
    const host = c.req.header("host");
    if (!origin || !host) return true; // same-origin fetches often omit Origin
    try {
      const originHost = new URL(origin).host;
      if (originHost === host) return true;
      if (originHost.endsWith(".discordsays.com")) return true;
      return false;
    } catch {
      return false;
    }
  };

  // Authenticate a caller via their Discord access token; returns the verified
  // user id or null on failure. Used by HTTP proposal routes that need actor id.
  const verifyDiscordUser = async (c: any): Promise<string | null> => {
    const auth = c.req.header("authorization");
    const match = auth?.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    try {
      const res = await fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: `Bearer ${match[1]}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null;
      const u = await res.json();
      return typeof u?.id === "string" ? u.id : null;
    } catch {
      return null;
    }
  };

  // ── Live proposals (#53) ────────────────────────────────────────────────

  app.post("/api/proposals/:id/edit", async (c) => {
    if (!csrfOk(c)) return c.json({ error: "Forbidden" }, 403);
    const userId = await verifyDiscordUser(c);
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.version !== "number" || typeof body.payload !== "object" || typeof body.channelId !== "string") {
      return c.json({ error: "Missing channelId/version/payload" }, 400);
    }
    const result = bot.handleProposalEdit(body.channelId, userId, id, body.version, body.payload);
    if ("error" in result) return c.json({ error: result.error }, result.status as any);
    return c.json(result);
  });

  app.post("/api/proposals/:id/dismiss", async (c) => {
    if (!csrfOk(c)) return c.json({ error: "Forbidden" }, 403);
    const userId = await verifyDiscordUser(c);
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.channelId !== "string") return c.json({ error: "Missing channelId" }, 400);
    const result = bot.handleProposalDismiss(body.channelId, userId, id);
    if ("error" in result) return c.json({ error: result.error }, result.status as any);
    return c.json(result);
  });

  app.post("/api/proposals/:id/affirm", async (c) => {
    if (!csrfOk(c)) return c.json({ error: "Forbidden" }, 403);
    const userId = await verifyDiscordUser(c);
    if (!userId) return c.json({ error: "Unauthorized" }, 401);
    const id = parseInt(c.req.param("id"));
    if (isNaN(id)) return c.json({ error: "Invalid id" }, 400);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.version !== "number" || typeof body.channelId !== "string") {
      return c.json({ error: "Missing channelId/version" }, 400);
    }
    const result = await bot.handleProposalAffirm(body.channelId, userId, id, body.version);
    if ("error" in result) return c.json({ error: result.error }, result.status as any);
    return c.json(result);
  });

  // Reassign issue to a different contributor
  app.post("/api/issues/:repo/:number/assign", async (c) => {
    // CSRF: reject cross-origin requests that are not from our server or Discord's Activity proxy.
    if (!csrfOk(c)) return c.json({ error: "Forbidden" }, 403);

    const repo = decodeURIComponent(c.req.param("repo"));
    const number = parseInt(c.req.param("number"));
    if (!repo || isNaN(number)) return c.json({ error: "Invalid params" }, 400);

    // Validate repo is configured.
    const validRepos = new Set(Object.values(STANDUPS).map(s => s.repo));
    if (!validRepos.has(repo)) return c.json({ error: "Unknown repository" }, 403);

    const { assignee } = await c.req.json();
    if (!assignee || typeof assignee !== "string") return c.json({ error: "Missing assignee" }, 400);

    try {
      await assignIssue(repo, number, [assignee]);
      return c.json({ ok: true });
    } catch (e: any) {
      console.error("[activity] Assign issue error:", e.message);
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // WebSocket for real-time session state
  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      let channelId: string | null = null;
      let clientUserId: string | null = null;
      let clientUsername: string | null = null;
      let authenticated = false;
      let capturedWs: any = null;

      return {
        onOpen(_event, ws) {
          capturedWs = ws;
          console.log("[activity] WebSocket client connected");
        },

        onMessage(event, ws) {
          try {
            const msg = JSON.parse(typeof event.data === "string" ? event.data : "{}");

            if (msg.type === "ready") {
              // Verify Discord access token before registering the client.
              const token: string | undefined = msg.token;
              if (token) {
                fetch("https://discord.com/api/v10/users/@me", {
                  headers: { Authorization: `Bearer ${token}` },
                  signal: AbortSignal.timeout(5_000),
                }).then(async (res) => {
                  if (!res.ok) {
                    console.warn("[activity] WebSocket auth failed — closing connection");
                    ws.close();
                    return;
                  }
                  const user = await res.json();
                  clientUserId = user.id ?? msg.userId ?? null;
                  clientUsername = user.global_name ?? user.username ?? msg.username ?? null;
                  authenticated = true;
                  registerClient(ws);
                }).catch((e: any) => {
                  console.warn("[activity] WebSocket token verification error:", e.message);
                  // Fail open on network errors to avoid blocking legitimate clients
                  clientUserId = msg.userId ?? null;
                  clientUsername = msg.username ?? null;
                  authenticated = true;
                  registerClient(ws);
                });
              } else {
                // No token — allow connection but mark as unauthenticated (legacy/dev)
                clientUserId = msg.userId ?? null;
                authenticated = true;
                registerClient(ws);
              }

              function registerClient(ws: any) {
                // Bind to the session running in the Activity's voice channel
                // (per-channel keying, #61). No fallback: if the client doesn't
                // send a recognised channelId we leave them unbound rather than
                // risk attaching them to the wrong session (#62).
                const requestedChannelId = typeof msg.channelId === "string" ? msg.channelId : null;
                const session = bot.getSessionForChannel(requestedChannelId);
                console.log(
                  `[activity] WS bind: requestedChannelId=${requestedChannelId ?? "null"} ` +
                  `→ ${session ? `session.channelId=${session.channelId} guild=${session.meta.guildId} type=${session.meta.type}` : "no session"} ` +
                  `userId=${clientUserId ?? "null"}`,
                );
                if (session) {
                  channelId = session.channelId;
                  bot.addActivityClient(channelId, ws, clientUserId, clientUsername);
                  // Bind the standup's repo so live proposals (#53) can target
                  // GitHub. This is idempotent — cheap to call on every ready.
                  const pickedKey = typeof msg.standupKey === "string" ? msg.standupKey : null;
                  if (pickedKey && STANDUPS[pickedKey]) {
                    bot.setIssueRepo(channelId, STANDUPS[pickedKey].repo);
                  }
                  // addActivityClient already broadcasts updated state; send a personal
                  // initial state so the client has all fields before the broadcast arrives.
                  const presenterName = session.meta.presenter
                    ? (session.meta.connectedUsers.get(session.meta.presenter) ?? null)
                    : null;
                  const watcherNames = [...session.meta.connectedUsers.entries()]
                    .filter(([uid]) => uid !== session.meta.presenter)
                    .map(([, name]) => name);
                  const voiceMembers = [...session.meta.voiceMembers.entries()].map(([id, name]) => ({ id, name }));
                  const proposals = bot.getActiveProposals(channelId).map(serializeProposal);
                  ws.send(JSON.stringify({
                    type: "state",
                    focusedIssue: session.meta.focusedIssue,
                    focusedDetailIssue: session.meta.focusedDetailIssue,
                    presenter: session.meta.presenter,
                    presenterName,
                    watcherNames,
                    voiceMembers,
                    activeParticipantIndex: session.meta.activeParticipantIndex,
                    recording: true,
                    elapsed: Math.round((Date.now() - session.meta.startedAt.getTime()) / 1000),
                    utteranceCount: session.meta.lines.length,
                    proposals,
                  }));
                } else {
                  ws.send(JSON.stringify({
                    type: "state",
                    focusedIssue: null,
                    focusedDetailIssue: null,
                    presenter: null,
                    presenterName: null,
                    watcherNames: [],
                    voiceMembers: [],
                    activeParticipantIndex: 0,
                    recording: false,
                    elapsed: 0,
                    utteranceCount: 0,
                    proposals: [],
                  }));
                }
              }
            }

            if (!authenticated) return;

            // Freestyle mode (#63): navigation messages (focus/tab/detail/
            // scroll/detailScroll) only relay when the sender is the current
            // presenter. With no presenter, every participant's view is
            // independent. Take-control ("controls") is the exception — it
            // promotes the sender into the presenter role.
            const isPresenter = (() => {
              if (!channelId || !clientUserId) return false;
              const s = bot.getSessionForChannel(channelId);
              return !!s && s.meta.presenter === clientUserId;
            })();

            if (msg.type === "focus" && channelId && isPresenter) {
              bot.setFocusedIssue(channelId, msg.issueNumber ?? null, msg.issueTitle, msg.issueState);
            }

            if (msg.type === "tab" && channelId && isPresenter && typeof msg.participantIndex === "number") {
              bot.setActiveTab(channelId, msg.participantIndex);
            }

            if (msg.type === "detail" && channelId && isPresenter) {
              bot.setDetailPanel(channelId, msg.issueNumber ?? null);
            }

            // Use server-verified clientUserId — never trust client-supplied userId.
            if (msg.type === "controls" && channelId && clientUserId) {
              bot.setPresenter(channelId, clientUserId);
            }

            if (msg.type === "scroll" && channelId && isPresenter && typeof msg.scrollY === "number") {
              bot.relayScroll(channelId, msg.scrollY);
            }

            if (msg.type === "detailScroll" && channelId && isPresenter && typeof msg.scrollTop === "number") {
              bot.relayDetailScroll(channelId, msg.scrollTop);
            }

            if (msg.type === "proposal-edit" && channelId && clientUserId &&
                typeof msg.id === "number" && typeof msg.version === "number" &&
                typeof msg.payload === "object") {
              const res = bot.handleProposalEdit(channelId, clientUserId, msg.id, msg.version, msg.payload);
              if ("error" in res) {
                try { ws.send(JSON.stringify({ type: "proposal-error", id: msg.id, error: res.error })); } catch {}
              }
            }

            if (msg.type === "proposal-dismiss" && channelId && clientUserId && typeof msg.id === "number") {
              const res = bot.handleProposalDismiss(channelId, clientUserId, msg.id);
              if ("error" in res) {
                try { ws.send(JSON.stringify({ type: "proposal-error", id: msg.id, error: res.error })); } catch {}
              }
            }

            if (msg.type === "proposal-affirm" && channelId && clientUserId &&
                typeof msg.id === "number" && typeof msg.version === "number") {
              bot.handleProposalAffirm(channelId, clientUserId, msg.id, msg.version).then((res) => {
                if ("error" in res) {
                  try { ws.send(JSON.stringify({ type: "proposal-error", id: msg.id, error: res.error })); } catch {}
                }
              });
            }
          } catch (e: any) {
            console.error("[activity] WebSocket message error:", e.message);
          }
        },

        onClose() {
          if (channelId) {
            bot.clearPresenterIfDisconnected(channelId, clientUserId);
            if (capturedWs) bot.removeActivityClient(channelId, capturedWs);
            if (clientUserId) bot.removeActivityUser(channelId, clientUserId);
          }
          console.log("[activity] WebSocket client disconnected");
        },
      };
    }),
  );

  return app;
}

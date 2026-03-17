/**
 * Discord Activity server — Hono sub-app for the standup Activity.
 *
 * Routes (mounted at /activity):
 *   GET  /              → Activity HTML shell
 *   GET  /bundle.js     → Bundled client-side JS
 *   POST /api/token     → OAuth2 code→token exchange
 *   GET  /api/standups  → Available standup names
 *   GET  /api/issues    → GitHub issues grouped by participant
 *   GET  /ws            → WebSocket for real-time session state
 */

import { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import {
  STANDUPS,
  STANDUP_NAMES,
  STAGE_MAP,
  getStage,
  type StandupConfig,
} from "./review";
import {
  fetchRecentlyUpdated,
  fetchOpenNonBacklog,
  fetchUserAvatar,
  fetchIssueDetail,
  type GitHubIssue,
} from "./github";
import type { StandupBot } from "./bot";

const CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? "";

// ── Client bundle (built once at import time) ───────────────────────────────

let clientBundle = "console.error('Bundle not built yet');";

async function buildClientBundle() {
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

// Build immediately
buildClientBundle();

// ── Activity HTML shell ─────────────────────────────────────────────────────

function activityHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Standup Activity</title>
  <style>${ACTIVITY_CSS}</style>
  <script>window.__DISCORD_CLIENT_ID__ = "${CLIENT_ID}";</script>
</head>
<body>
  <div id="app"><div class="loading">Loading...</div></div>
  <script src="bundle.js"></script>
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
  .picker{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:1rem}
  .picker h1{color:#818cf8;font-size:1.5rem}
  .picker-subtitle{color:#64748b;font-size:.9rem}
  .standup-btn{background:#1e293b;color:#e2e8f0;border:1px solid #334155;padding:.75rem 2rem;border-radius:.5rem;cursor:pointer;font-size:1rem;min-width:200px;transition:all .15s}
  .standup-btn:hover{background:#334155;border-color:#818cf8}

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
  .tab{background:#1e293b;color:#94a3b8;border:1px solid #334155;padding:.4rem 1rem;border-radius:.375rem;cursor:pointer;font-size:.85rem;white-space:nowrap;transition:all .15s}
  .tab:hover{background:#334155;color:#e2e8f0}
  .tab-active{background:#4f46e5;color:white;border-color:#4f46e5}
  .tab-speaking{box-shadow:0 0 0 2px rgba(129,140,248,.5)}

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

  /* Live Feed */
  .live-feed{padding:.75rem 1rem;border-top:1px solid #1e293b;max-height:180px;overflow-y:auto;flex-shrink:0}
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

  /* Sync / Freestyle badge */
  .sync-badge{font-size:.72rem;padding:.15rem .45rem;border-radius:.25rem;font-weight:600;margin-left:.5rem}
  .sync-badge-presenter{background:#1e3a1e;color:#4ade80}
  .sync-badge-synced{background:#3b0000;color:#fca5a5}
  .sync-badge-freestyle{background:#1c1917;color:#a8a29e}

  /* Nav center button variants */
  .nav-btn-presenter{background:#1e3a1e;color:#4ade80;border-color:#166534;opacity:.9}
  .nav-btn-synced{background:#3b0000;color:#fca5a5;border-color:#7f1d1d}
  .nav-btn-synced:hover{background:#450a0a;color:#fca5a5}
  .nav-btn-sync{background:#1e1b4b;color:#a5b4fc;border-color:#3730a3}
  .nav-btn-sync:hover{background:#2e27a0;color:#c7d2fe}
`;

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
  const results = [];

  for (const step of config.steps) {
    let allOpen: GitHubIssue[] = [];
    let recentClosed: GitHubIssue[] = [];

    if (step.type === "assignee") {
      const recent = await fetchRecentlyUpdated(config.repo, step.user);
      const open = await fetchOpenNonBacklog(config.repo, step.user, config.backlogLabel);
      const recentNums = new Set(recent.map(i => i.number));
      const recentOpen = recent.filter(i => i.state === "open");
      recentClosed = recent.filter(i => i.state === "closed");
      const openDeduped = open.filter(i => !recentNums.has(i.number));
      allOpen = [...recentOpen, ...openDeduped];
    } else {
      allOpen = await fetchOpenNonBacklog(config.repo, null, config.backlogLabel);
    }

    const avatarUrl = step.type === "assignee"
      ? await fetchUserAvatar(step.user)
      : "";

    // Build stage groups: recently closed first, then open by stage
    const stages: StageGroupOutput[] = [];
    if (recentClosed.length > 0) {
      stages.push({ emoji: "🏁", name: "Closed Today", issues: recentClosed });
    }
    stages.push(...groupByStage(allOpen));

    results.push({
      name: step.name,
      githubUser: step.type === "assignee" ? step.user : null,
      avatarUrl,
      stages,
    });
  }

  return results;
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

  // Serve bundled client JS
  app.get("/bundle.js", (c) => {
    console.log(`[activity] Serving bundle.js (${clientBundle.length} bytes)`);
    return new Response(clientBundle, {
      headers: { "Content-Type": "application/javascript; charset=utf-8" },
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

  // Available standup names
  app.get("/api/standups", (c) => {
    return c.json(STANDUP_NAMES);
  });

  // GitHub issues grouped by participant
  app.get("/api/issues", async (c) => {
    const standupKey = c.req.query("standup");
    if (!standupKey || !STANDUPS[standupKey]) {
      return c.json({ error: `Unknown standup. Choose from: ${STANDUP_NAMES.join(", ")}` }, 400);
    }

    const config = STANDUPS[standupKey];
    try {
      const participants = await fetchParticipantData(config);
      return c.json({
        standupKey,
        repo: config.repo,
        participants,
      });
    } catch (e: any) {
      console.error("[activity] Issues fetch error:", e.message);
      return c.json({ error: e.message }, 500);
    }
  });

  // Single issue detail (body + comments)
  app.get("/api/issues/:repo/:number", async (c) => {
    const repo = decodeURIComponent(c.req.param("repo"));
    const number = parseInt(c.req.param("number"));
    if (!repo || isNaN(number)) return c.json({ error: "Invalid params" }, 400);

    try {
      const detail = await fetchIssueDetail(repo, number);
      return c.json(detail);
    } catch (e: any) {
      console.error("[activity] Issue detail error:", e.message);
      return c.json({ error: e.message }, 500);
    }
  });

  // WebSocket for real-time session state
  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      let guildId: string | null = null;

      return {
        onOpen(_event, ws) {
          console.log("[activity] WebSocket client connected");
        },

        onMessage(event, ws) {
          try {
            const msg = JSON.parse(typeof event.data === "string" ? event.data : "{}");

            if (msg.type === "ready") {
              // Client is ready — register with bot and send current state
              // For now, register to the first active session we can find
              const session = bot.getFirstActiveSession();
              if (session) {
                guildId = session.guildId;
                bot.addActivityClient(guildId, ws);
                ws.send(JSON.stringify({
                  type: "state",
                  focusedIssue: session.meta.focusedIssue,
                  presenter: session.meta.presenter,
                  activeParticipantIndex: session.meta.activeParticipantIndex,
                  recording: true,
                  elapsed: Math.round((Date.now() - session.meta.startedAt.getTime()) / 1000),
                  utteranceCount: session.meta.lines.length,
                }));
              } else {
                ws.send(JSON.stringify({
                  type: "state",
                  focusedIssue: null,
                  presenter: null,
                  activeParticipantIndex: 0,
                  recording: false,
                  elapsed: 0,
                  utteranceCount: 0,
                }));
              }
            }

            if (msg.type === "focus" && guildId) {
              bot.setFocusedIssue(guildId, msg.issueNumber ?? null, msg.issueTitle, msg.issueState);
            }

            if (msg.type === "tab" && guildId && typeof msg.participantIndex === "number") {
              bot.setActiveTab(guildId, msg.participantIndex);
            }

            if (msg.type === "controls" && guildId) {
              bot.setPresenter(guildId, msg.userId);
            }
          } catch (e: any) {
            console.error("[activity] WebSocket message error:", e.message);
          }
        },

        onClose() {
          if (guildId) {
            bot.removeActivityClient(guildId);
          }
          console.log("[activity] WebSocket client disconnected");
        },
      };
    }),
  );

  return app;
}

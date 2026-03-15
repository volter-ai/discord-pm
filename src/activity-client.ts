/**
 * Client-side JavaScript for the Discord Activity iframe.
 *
 * Built into a single bundle at server startup via Bun.build().
 * Runs inside the Discord Activity iframe — initializes the Embedded App SDK,
 * authenticates via OAuth2, connects WebSocket for real-time state,
 * fetches GitHub issues, and renders the standup board UI.
 */

import { DiscordSDK } from "@discord/embedded-app-sdk";

// ── Types ───────────────────────────────────────────────────────────────────

interface Issue {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: string[];
  updatedAt: string;
  url: string;
}

interface StageGroup {
  emoji: string;
  name: string;
  issues: Issue[];
}

interface Participant {
  name: string;
  githubUser: string | null;
  avatarUrl: string;
  stages: StageGroup[];
}

interface IssuesResponse {
  standupKey: string;
  repo: string;
  participants: Participant[];
}

// Server → Client WebSocket messages
type ServerMessage =
  | { type: "speaker"; userId: string; name: string; speaking: boolean }
  | { type: "utterance"; speaker: string; issueNumber: number | null; text: string; startedAt: number }
  | { type: "session"; recording: boolean; elapsed: number; utteranceCount: number }
  | { type: "state"; focusedIssue: number | null; presenter: string | null; recording: boolean; elapsed: number; utteranceCount: number };

// ── Globals ─────────────────────────────────────────────────────────────────

const CLIENT_ID = (window as any).__DISCORD_CLIENT_ID__;
const app = document.getElementById("app")!;

let sdk: DiscordSDK;
let ws: WebSocket | null = null;
let currentUser: { id: string; username: string } | null = null;
let participants: Participant[] = [];
let activeTabIndex = 0;
let focusedIssue: number | null = null;
let isRecording = false;
let elapsedSeconds = 0;
let utteranceCount = 0;
let speakingUsers = new Set<string>();
let standupKey = "";
let timerInterval: ReturnType<typeof setInterval> | null = null;

// ── Initialization ──────────────────────────────────────────────────────────

async function init() {
  app.innerHTML = `<div class="loading">Connecting to Discord...</div>`;

  try {
    sdk = new DiscordSDK(CLIENT_ID);
    await sdk.ready();

    app.innerHTML = `<div class="loading">Authenticating...</div>`;

    // OAuth2 authorize
    const { code } = await sdk.commands.authorize({
      client_id: CLIENT_ID,
      response_type: "code",
      state: "",
      prompt: "none",
      scope: ["identify", "guilds"],
    });

    // Exchange code for token on our backend
    const tokenRes = await fetch("/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${tokenRes.status}`);
    }

    const { access_token } = await tokenRes.json();

    // Authenticate with Discord SDK
    const auth = await sdk.commands.authenticate({ access_token });
    currentUser = auth.user ? { id: auth.user.id, username: auth.user.username } : null;

    app.innerHTML = `<div class="loading">Loading standup data...</div>`;

    // Determine standup key — try to get from URL or default
    const params = new URLSearchParams(window.location.search);
    standupKey = params.get("standup") || "";

    if (!standupKey) {
      // Show standup picker
      renderStandupPicker();
      return;
    }

    await loadStandup(standupKey);
  } catch (e: any) {
    console.error("Activity init error:", e);
    app.innerHTML = `<div class="error">
      <h2>Failed to initialize</h2>
      <p>${escapeHtml(e.message)}</p>
      <p style="color:#64748b;font-size:.8rem;margin-top:.5rem">Stack: ${escapeHtml(e.stack ?? "none")}</p>
      <button onclick="location.reload()">Retry</button>
    </div>`;
  }
}

// ── Standup Picker ──────────────────────────────────────────────────────────

function renderStandupPicker() {
  app.innerHTML = `
    <div class="picker">
      <h1>Standup Activity</h1>
      <p class="picker-subtitle">Choose a standup to review</p>
      <div id="standup-buttons"></div>
    </div>
  `;

  // Fetch available standups
  fetch("/api/standups")
    .then((r) => r.json())
    .then((standups: string[]) => {
      const container = document.getElementById("standup-buttons")!;
      for (const name of standups) {
        const btn = document.createElement("button");
        btn.className = "standup-btn";
        btn.textContent = name;
        btn.onclick = () => {
          standupKey = name;
          loadStandup(name);
        };
        container.appendChild(btn);
      }
    })
    .catch((e) => {
      document.getElementById("standup-buttons")!.innerHTML =
        `<p class="error-text">Failed to load standups: ${escapeHtml(e.message)}</p>`;
    });
}

// ── Load Standup Data ───────────────────────────────────────────────────────

async function loadStandup(key: string) {
  app.innerHTML = `<div class="loading">Loading issues for ${escapeHtml(key)}...</div>`;

  const res = await fetch(`/api/issues?standup=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`Failed to fetch issues: ${res.status}`);

  const data: IssuesResponse = await res.json();
  participants = data.participants;
  activeTabIndex = 0;

  connectWebSocket();
  render();
}

// ── WebSocket ───────────────────────────────────────────────────────────────

function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    ws!.send(JSON.stringify({ type: "ready", standupKey }));
  };

  ws.onmessage = (event) => {
    const msg: ServerMessage = JSON.parse(event.data);
    handleServerMessage(msg);
  };

  ws.onclose = () => {
    // Reconnect after 3s
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (e) => {
    console.error("WebSocket error:", e);
  };
}

function sendWs(msg: object) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function handleServerMessage(msg: ServerMessage) {
  switch (msg.type) {
    case "speaker":
      if (msg.speaking) {
        speakingUsers.add(msg.userId);
      } else {
        speakingUsers.delete(msg.userId);
      }
      updateSpeakerIndicators();
      break;

    case "utterance":
      utteranceCount++;
      updateHeader();
      addLiveUtterance(msg.speaker, msg.text, msg.issueNumber);
      break;

    case "session":
      isRecording = msg.recording;
      elapsedSeconds = msg.elapsed;
      utteranceCount = msg.utteranceCount;
      updateHeader();
      break;

    case "state":
      focusedIssue = msg.focusedIssue;
      isRecording = msg.recording;
      elapsedSeconds = msg.elapsed;
      utteranceCount = msg.utteranceCount;
      updateHeader();
      updateFocusHighlight();
      break;
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

function render() {
  const headerHtml = renderHeader();
  const tabsHtml = renderTabs();
  const boardHtml = renderBoard();
  const liveHtml = `<div id="live-feed" class="live-feed"></div>`;

  app.innerHTML = `
    ${headerHtml}
    ${tabsHtml}
    ${boardHtml}
    ${liveHtml}
  `;

  startTimer();
}

function renderHeader(): string {
  const elapsed = formatTime(elapsedSeconds);
  const recDot = isRecording ? `<span class="rec-dot"></span>` : "";
  return `
    <div class="header" id="header">
      <div class="header-left">
        <span class="header-title">Standup — ${escapeHtml(standupKey)}</span>
      </div>
      <div class="header-right">
        <span class="timer" id="timer">${elapsed}</span>
        ${recDot}
        <span class="utterance-count" id="utt-count">${utteranceCount} utterances</span>
      </div>
    </div>
  `;
}

function renderTabs(): string {
  const tabs = participants.map((p, i) => {
    const active = i === activeTabIndex ? "tab-active" : "";
    const speakingClass = speakingUsers.size > 0 ? "tab-speaking" : "";
    return `<button class="tab ${active} ${speakingClass}" data-index="${i}">${escapeHtml(p.name)}</button>`;
  }).join("");

  return `<div class="tabs" id="tabs">${tabs}</div>`;
}

function renderBoard(): string {
  const participant = participants[activeTabIndex];
  if (!participant) return `<div class="empty-board">No participants found</div>`;

  const stagesHtml = participant.stages.map((stage) => {
    const issuesHtml = stage.issues.map((issue) => {
      const focused = focusedIssue === issue.number ? "issue-focused" : "";
      const prio = priorityBadge(issue.labels);
      const bug = issue.labels.some(l => l.toLowerCase() === "bug") ? `<span class="badge badge-bug">bug</span>` : "";
      return `
        <div class="issue-card ${focused}" data-issue="${issue.number}" data-url="${escapeHtml(issue.url)}">
          <div class="issue-header">
            <span class="issue-number">#${issue.number}</span>
            <span class="issue-title">${escapeHtml(truncate(issue.title, 55))}</span>
          </div>
          <div class="issue-badges">${prio}${bug}</div>
        </div>
      `;
    }).join("");

    return `
      <div class="stage-group">
        <div class="stage-header">${stage.emoji} ${escapeHtml(stage.name)} (${stage.issues.length})</div>
        ${issuesHtml}
      </div>
    `;
  }).join("");

  const prevIdx = activeTabIndex - 1;
  const nextIdx = activeTabIndex + 1;
  const prevName = prevIdx >= 0 ? participants[prevIdx].name : null;
  const nextName = nextIdx < participants.length ? participants[nextIdx].name : null;

  const navHtml = `
    <div class="board-nav">
      <button class="nav-btn" id="btn-prev" ${!prevName ? "disabled" : ""}>${prevName ? `← ${escapeHtml(prevName)}` : "←"}</button>
      <button class="nav-btn nav-btn-primary" id="btn-controls">Take Controls</button>
      <button class="nav-btn" id="btn-next" ${!nextName ? "disabled" : ""}>${nextName ? `${escapeHtml(nextName)} →` : "→"}</button>
    </div>
  `;

  return `
    <div class="board" id="board">
      <div class="board-participant">
        ${participant.avatarUrl ? `<img class="board-avatar" src="${escapeHtml(participant.avatarUrl)}" alt="">` : ""}
        <span class="board-name">${escapeHtml(participant.name)}</span>
      </div>
      <div class="stages">${stagesHtml}</div>
      ${navHtml}
    </div>
  `;
}

// ── Event Delegation ────────────────────────────────────────────────────────

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;

  // Tab click
  const tab = target.closest(".tab") as HTMLElement | null;
  if (tab) {
    activeTabIndex = parseInt(tab.dataset.index!);
    focusedIssue = null;
    sendWs({ type: "focus", issueNumber: null });
    render();
    return;
  }

  // Issue card click
  const card = target.closest(".issue-card") as HTMLElement | null;
  if (card) {
    const issueNum = parseInt(card.dataset.issue!);
    if (focusedIssue === issueNum) {
      // Unfocus
      focusedIssue = null;
      sendWs({ type: "focus", issueNumber: null });
    } else {
      focusedIssue = issueNum;
      sendWs({ type: "focus", issueNumber: issueNum });
    }
    updateFocusHighlight();
    return;
  }

  // Navigation buttons
  if (target.id === "btn-prev" && activeTabIndex > 0) {
    activeTabIndex--;
    focusedIssue = null;
    sendWs({ type: "focus", issueNumber: null });
    render();
    return;
  }
  if (target.id === "btn-next" && activeTabIndex < participants.length - 1) {
    activeTabIndex++;
    focusedIssue = null;
    sendWs({ type: "focus", issueNumber: null });
    render();
    return;
  }
  if (target.id === "btn-controls" && currentUser) {
    sendWs({ type: "controls", userId: currentUser.id });
    return;
  }

  // Issue link — open in new window via SDK
  if (card) {
    const url = card.dataset.url;
    if (url) {
      window.open(url, "_blank");
    }
  }
});

// Double-click issue to open on GitHub
document.addEventListener("dblclick", (e) => {
  const card = (e.target as HTMLElement).closest(".issue-card") as HTMLElement | null;
  if (card?.dataset.url) {
    window.open(card.dataset.url, "_blank");
  }
});

// ── UI Updates ──────────────────────────────────────────────────────────────

function updateHeader() {
  const timer = document.getElementById("timer");
  if (timer) timer.textContent = formatTime(elapsedSeconds);
  const uttCount = document.getElementById("utt-count");
  if (uttCount) uttCount.textContent = `${utteranceCount} utterances`;
}

function updateFocusHighlight() {
  document.querySelectorAll(".issue-card").forEach((el) => {
    const num = parseInt((el as HTMLElement).dataset.issue!);
    el.classList.toggle("issue-focused", num === focusedIssue);
  });
}

function updateSpeakerIndicators() {
  // For now, pulse the header when anyone is speaking
  const header = document.getElementById("header");
  if (header) {
    header.classList.toggle("speaking-active", speakingUsers.size > 0);
  }
}

function addLiveUtterance(speaker: string, text: string, issueNumber: number | null) {
  const feed = document.getElementById("live-feed");
  if (!feed) return;

  const entry = document.createElement("div");
  entry.className = "live-entry";
  const issueTag = issueNumber ? `<span class="live-issue">#${issueNumber}</span> ` : "";
  entry.innerHTML = `${issueTag}<strong>${escapeHtml(speaker)}:</strong> ${escapeHtml(text)}`;
  feed.prepend(entry);

  // Keep max 10 entries
  while (feed.children.length > 10) {
    feed.removeChild(feed.lastChild!);
  }
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (isRecording) {
      elapsedSeconds++;
      updateHeader();
    }
  }, 1000);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function priorityBadge(labels: string[]): string {
  for (const l of labels) {
    const low = l.toLowerCase();
    if (low.startsWith("p0")) return `<span class="badge badge-p0">P0</span>`;
    if (low.startsWith("p1")) return `<span class="badge badge-p1">P1</span>`;
    if (low.startsWith("p2")) return `<span class="badge badge-p2">P2</span>`;
  }
  return "";
}

// ── Start ───────────────────────────────────────────────────────────────────

init();

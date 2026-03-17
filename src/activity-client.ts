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
  | { type: "state"; focusedIssue: number | null; presenter: string | null; activeParticipantIndex: number; recording: boolean; elapsed: number; utteranceCount: number };

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
let repo = "";
let timerInterval: ReturnType<typeof setInterval> | null = null;
let issueTimers = new Map<number, number>(); // issue# → accumulated ms
let focusStartTime: number | null = null;
let detailCache = new Map<string, any>(); // "repo/number" → detail

// ── Sync / Freestyle state ──────────────────────────────────────────────────
/** Whether this client is following the presenter (synced mode). Default true. */
let syncMode = true;
/** Discord user ID of the current presenter, or null if nobody has controls. */
let presenterUserId: string | null = null;
/** Server's canonical focused issue (applied to local state when syncing). */
let serverFocusedIssue: number | null = null;
/** Server's canonical active participant tab index. */
let serverActiveTabIndex = 0;

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
  repo = data.repo;
  activeTabIndex = 0;

  connectWebSocket();
  render();
}

async function refreshIssues() {
  const btn = document.getElementById("btn-refresh");
  if (btn) btn.classList.add("spinning");

  try {
    const res = await fetch(`/api/issues?standup=${encodeURIComponent(standupKey)}`);
    if (!res.ok) throw new Error(`Failed to fetch issues: ${res.status}`);
    const data: IssuesResponse = await res.json();
    participants = data.participants;
    repo = data.repo;
    detailCache.clear();
    if (btn) btn.classList.remove("spinning");
    render();
  } catch (e: any) {
    console.error("Refresh error:", e);
    if (btn) {
      btn.classList.remove("spinning");
      btn.textContent = "!";
      btn.title = "Refresh failed — click to retry";
      btn.style.color = "#f87171";
      setTimeout(() => {
        btn.textContent = "↻";
        btn.title = "Refresh issues";
        btn.style.color = "";
      }, 3000);
    }
  }
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

    case "state": {
      // Track who the presenter is — needed for sync badge + permission checks
      presenterUserId = msg.presenter;
      // Save server's canonical state
      serverFocusedIssue = msg.focusedIssue;
      serverActiveTabIndex = msg.activeParticipantIndex ?? 0;
      isRecording = msg.recording;
      elapsedSeconds = msg.elapsed;
      utteranceCount = msg.utteranceCount;

      if (syncMode) {
        // Apply server state to local view
        const tabChanged = activeTabIndex !== serverActiveTabIndex;
        const focusChanged = focusedIssue !== serverFocusedIssue;
        activeTabIndex = serverActiveTabIndex;
        focusedIssue = serverFocusedIssue;
        if (tabChanged) {
          render();
        } else if (focusChanged) {
          updateFocusHighlight();
          updateHeader();
          updateSyncBadge();
        } else {
          updateHeader();
          updateSyncBadge();
        }
      } else {
        // Not synced — just update timer/counts and the badge
        updateHeader();
        updateSyncBadge();
      }
      break;
    }
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
  const discussed = issueTimers.size;
  const discussedBadge = discussed > 0 ? `<span class="discussed-count" id="discussed-count">${discussed} issue${discussed !== 1 ? "s" : ""}</span>` : "";
  const syncBadge = renderSyncBadge();
  return `
    <div class="header" id="header">
      <div class="header-left">
        <span class="header-title">Standup — ${escapeHtml(standupKey)}</span>
        <span id="sync-badge">${syncBadge}</span>
        <button class="refresh-btn" id="btn-refresh" title="Refresh issues">↻</button>
      </div>
      <div class="header-right">
        ${discussedBadge}
        <span class="timer" id="timer">${elapsed}</span>
        ${recDot}
        <span class="utterance-count" id="utt-count">${utteranceCount} utterances</span>
      </div>
    </div>
  `;
}

function renderSyncBadge(): string {
  if (isPresenter()) {
    return `<span class="sync-badge sync-badge-presenter">🎤 Presenting</span>`;
  }
  if (syncMode && presenterUserId) {
    return `<span class="sync-badge sync-badge-synced">🔴 Live</span>`;
  }
  if (!syncMode) {
    return `<span class="sync-badge sync-badge-freestyle">🔓 Freestyle</span>`;
  }
  return ""; // no presenter, no badge needed
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
    const isClosed = stage.name === "Closed Today";
    const issuesHtml = stage.issues.map((issue) => {
      const focused = focusedIssue === issue.number ? "issue-focused" : "";
      const closedClass = isClosed ? "issue-card-closed" : "";
      const prio = priorityBadge(issue.labels);
      const bug = issue.labels.some(l => l.toLowerCase() === "bug") ? `<span class="badge badge-bug">bug</span>` : "";
      const age = `<span class="issue-age ${freshnessClass(issue.updatedAt)}">${relativeTime(issue.updatedAt)}</span>`;
      const timer = focusedIssue === issue.number ? `<span class="issue-timer" id="issue-timer-${issue.number}">${formatTime(Math.floor((issueTimers.get(issue.number) ?? 0) / 1000))}</span>` : "";
      return `
        <div class="issue-card ${focused} ${closedClass}" data-issue="${issue.number}" data-url="${escapeHtml(issue.url)}" data-title="${escapeHtml(issue.title)}" data-state="${escapeHtml(issue.state)}">
          <div class="issue-header">
            <span class="issue-number" data-detail="${issue.number}">#${issue.number}</span>
            <span class="issue-title">${escapeHtml(issue.title)}</span>
          </div>
          <div class="issue-badges">${timer}${age}${prio}${bug}</div>
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

  const centerBtn = renderNavCenterButton();
  const navHtml = `
    <div class="board-nav">
      <button class="nav-btn" id="btn-prev" ${!prevName ? "disabled" : ""}>${prevName ? `← ${escapeHtml(prevName)}` : "←"}</button>
      ${centerBtn}
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

// ── Sync / Freestyle helpers ────────────────────────────────────────────────

function isPresenter(): boolean {
  return currentUser !== null && currentUser.id === presenterUserId;
}

function renderNavCenterButton(): string {
  if (isPresenter()) {
    return `<button class="nav-btn nav-btn-presenter" id="btn-controls" disabled>🎤 Presenting</button>`;
  }
  if (syncMode && presenterUserId) {
    // Following presenter — offer to go freestyle
    return `<button class="nav-btn nav-btn-synced" id="btn-freestyle">🔓 Go Freestyle</button>`;
  }
  if (!syncMode && presenterUserId) {
    // In freestyle while presenter exists — offer to sync back
    return `<button class="nav-btn nav-btn-sync" id="btn-sync">↩ Sync</button>`;
  }
  // No presenter — collaborative navigation, offer to take controls
  return `<button class="nav-btn nav-btn-primary" id="btn-controls">Take Controls</button>`;
}

/** Enter freestyle mode (stop following presenter). */
function enterFreestyle() {
  syncMode = false;
  updateSyncBadge();
  updateNavCenter();
}

/** Snap to server state and re-enter sync mode. */
function snapToSync() {
  syncMode = true;
  flushFocusTimer();
  const tabChanged = activeTabIndex !== serverActiveTabIndex;
  activeTabIndex = serverActiveTabIndex;
  focusedIssue = serverFocusedIssue;
  focusStartTime = null;
  if (tabChanged) {
    render();
  } else {
    updateFocusHighlight();
    updateHeader();
    updateSyncBadge();
    updateNavCenter();
  }
}

/** Update just the sync badge in the header (without full re-render). */
function updateSyncBadge() {
  const el = document.getElementById("sync-badge");
  if (el) el.innerHTML = renderSyncBadge();
}

/** Update just the center nav button (without full re-render). */
function updateNavCenter() {
  const existing = document.getElementById("btn-controls")
    ?? document.getElementById("btn-freestyle")
    ?? document.getElementById("btn-sync");
  if (existing) {
    const tmp = document.createElement("div");
    tmp.innerHTML = renderNavCenterButton();
    const newBtn = tmp.firstElementChild!;
    existing.replaceWith(newBtn);
  }
}

// ── Event Delegation ────────────────────────────────────────────────────────

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;

  // Tab click
  const tab = target.closest(".tab") as HTMLElement | null;
  if (tab) {
    const newIdx = parseInt(tab.dataset.index!);
    if (syncMode && !isPresenter() && presenterUserId) enterFreestyle();
    activeTabIndex = newIdx;
    flushFocusTimer();
    focusedIssue = null;
    focusStartTime = null;
    if (isPresenter() || !presenterUserId) {
      sendWs({ type: "tab", participantIndex: newIdx });
      sendWs({ type: "focus", issueNumber: null });
    }
    render();
    return;
  }

  // Issue number click → open detail panel
  const issueNumEl = target.closest(".issue-number[data-detail]") as HTMLElement | null;
  if (issueNumEl) {
    const issueNum = parseInt(issueNumEl.dataset.detail!);
    openDetailPanel(issueNum);
    return;
  }

  // Detail panel close
  if (target.closest(".detail-close") || target.classList.contains("detail-overlay")) {
    closeDetailPanel();
    return;
  }

  // Issue card click → toggle focus
  const card = target.closest(".issue-card") as HTMLElement | null;
  if (card) {
    if (syncMode && !isPresenter() && presenterUserId) enterFreestyle();
    const issueNum = parseInt(card.dataset.issue!);
    if (focusedIssue === issueNum) {
      flushFocusTimer();
      focusedIssue = null;
      focusStartTime = null;
      if (isPresenter() || !presenterUserId) sendWs({ type: "focus", issueNumber: null });
    } else {
      flushFocusTimer();
      focusedIssue = issueNum;
      focusStartTime = Date.now();
      if (!issueTimers.has(issueNum)) issueTimers.set(issueNum, 0);
      if (isPresenter() || !presenterUserId) {
        const meta = findIssue(issueNum);
        sendWs({ type: "focus", issueNumber: issueNum, issueTitle: meta?.title ?? null, issueState: meta?.state ?? null });
      }
    }
    updateFocusHighlight();
    updateHeader();
    return;
  }

  // Navigation buttons
  if (target.id === "btn-prev" && activeTabIndex > 0) {
    if (syncMode && !isPresenter() && presenterUserId) enterFreestyle();
    activeTabIndex--;
    flushFocusTimer();
    focusedIssue = null;
    focusStartTime = null;
    if (isPresenter() || !presenterUserId) {
      sendWs({ type: "tab", participantIndex: activeTabIndex });
      sendWs({ type: "focus", issueNumber: null });
    }
    render();
    return;
  }
  if (target.id === "btn-next" && activeTabIndex < participants.length - 1) {
    if (syncMode && !isPresenter() && presenterUserId) enterFreestyle();
    activeTabIndex++;
    flushFocusTimer();
    focusedIssue = null;
    focusStartTime = null;
    if (isPresenter() || !presenterUserId) {
      sendWs({ type: "tab", participantIndex: activeTabIndex });
      sendWs({ type: "focus", issueNumber: null });
    }
    render();
    return;
  }
  if (target.id === "btn-controls" && currentUser) {
    sendWs({ type: "controls", userId: currentUser.id });
    return;
  }
  if (target.id === "btn-freestyle") {
    enterFreestyle();
    return;
  }
  if (target.id === "btn-sync") {
    snapToSync();
    return;
  }

  if (target.id === "btn-refresh") {
    refreshIssues();
    return;
  }

});

// Escape key closes detail panel
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDetailPanel();
});

// ── UI Updates ──────────────────────────────────────────────────────────────

function updateHeader() {
  const timer = document.getElementById("timer");
  if (timer) timer.textContent = formatTime(elapsedSeconds);
  const uttCount = document.getElementById("utt-count");
  if (uttCount) uttCount.textContent = `${utteranceCount} utterances`;
  const disc = document.getElementById("discussed-count");
  if (disc) {
    const n = issueTimers.size;
    disc.textContent = `${n} issue${n !== 1 ? "s" : ""}`;
  }
  // Update focused issue timer display
  if (focusedIssue !== null) {
    const el = document.getElementById(`issue-timer-${focusedIssue}`);
    if (el) {
      const accumulated = issueTimers.get(focusedIssue) ?? 0;
      const live = focusStartTime ? Date.now() - focusStartTime : 0;
      el.textContent = formatTime(Math.floor((accumulated + live) / 1000));
    }
  }
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
    }
    updateHeader();
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

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function freshnessClass(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = ms / (1000 * 60 * 60);
  if (hours < 24) return "fresh-today";
  if (hours < 168) return "fresh-week";
  return "fresh-stale";
}

function findIssue(num: number): Issue | null {
  for (const p of participants) {
    for (const stage of p.stages) {
      for (const issue of stage.issues) {
        if (issue.number === num) return issue;
      }
    }
  }
  return null;
}

function flushFocusTimer() {
  if (focusedIssue !== null && focusStartTime !== null) {
    const elapsed = Date.now() - focusStartTime;
    issueTimers.set(focusedIssue, (issueTimers.get(focusedIssue) ?? 0) + elapsed);
  }
}

// ── Issue Detail Panel ─────────────────────────────────────────────────────

async function openDetailPanel(issueNumber: number) {
  const cacheKey = `${repo}/${issueNumber}`;
  let detail = detailCache.get(cacheKey);

  if (!detail) {
    // Show loading overlay
    const overlay = document.createElement("div");
    overlay.className = "detail-overlay";
    overlay.innerHTML = `<div class="detail-panel"><div class="loading" style="min-height:200px">Loading issue #${issueNumber}...</div></div>`;
    document.body.appendChild(overlay);

    try {
      const res = await fetch(`/api/issues/${encodeURIComponent(repo)}/${issueNumber}`);
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
      detail = await res.json();
      detailCache.set(cacheKey, detail);
    } catch (e: any) {
      overlay.remove();
      console.error("Detail fetch error:", e);
      return;
    }
    overlay.remove();
  }

  renderDetailOverlay(detail);
}

function renderDetailOverlay(detail: any) {
  const existing = document.querySelector(".detail-overlay");
  if (existing) existing.remove();

  const labelsHtml = (detail.labels ?? []).map((l: string) => `<span class="detail-label">${escapeHtml(l)}</span>`).join(" ");
  const bodyHtml = detail.body ? formatPlainText(detail.body) : "<em>No description</em>";
  const commentsHtml = (detail.comments ?? []).map((c: any) => `
    <div class="detail-comment">
      <div class="comment-meta"><strong>${escapeHtml(c.user)}</strong> <span class="comment-date">${relativeTime(c.createdAt)}</span></div>
      <div class="comment-body">${formatPlainText(c.body)}</div>
    </div>
  `).join("");

  const overlay = document.createElement("div");
  overlay.className = "detail-overlay";
  overlay.innerHTML = `
    <div class="detail-panel">
      <div class="detail-header">
        <span class="detail-number">#${detail.number}</span>
        <span class="detail-title">${escapeHtml(detail.title)}</span>
        <button class="detail-close">X</button>
      </div>
      <div class="detail-labels">${labelsHtml}</div>
      <div class="detail-body">${bodyHtml}</div>
      ${commentsHtml ? `<div class="detail-comments-header">Comments (${detail.comments?.length ?? 0})</div>${commentsHtml}` : ""}
      <a class="detail-link" href="${escapeHtml(detail.url)}" target="_blank">View on GitHub</a>
    </div>
  `;
  document.body.appendChild(overlay);
}

function closeDetailPanel() {
  const overlay = document.querySelector(".detail-overlay");
  if (overlay) overlay.remove();
}

function formatPlainText(text: string): string {
  return escapeHtml(text)
    .replace(/\n/g, "<br>")
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" style="color:#818cf8">$1</a>');
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

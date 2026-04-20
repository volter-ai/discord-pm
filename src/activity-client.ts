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

interface PR {
  number: number;
  title: string;
  state: "open" | "closed";
  updatedAt: string;
  url: string;
  isDraft: boolean;
}

interface StageGroup {
  emoji: string;
  name: string;
  issues: Issue[];
}

interface Participant {
  name: string;
  githubUser: string | null;
  /** Discord user ID from the USERS registry, used to match against voice-channel presence. Null for Unassigned and for contributors without a registry entry. */
  discordId: string | null;
  avatarUrl: string;
  stages: StageGroup[];
  prs: PR[];
}

interface VoiceMember { id: string; name: string }

interface IssuesResponse {
  standupKey: string;
  repo: string;
  participants: Participant[];
}

// Live proposal types (#53) — mirror the server's serializeProposal shape.
type ProposalActionType =
  | "close_issue" | "reopen_issue" | "comment"
  | "reassign" | "set_labels" | "backlog" | "create_issue";
type ProposalState =
  | "pending" | "edited" | "affirmed"
  | "dismissed" | "executed" | "failed";
interface ProposalPayload {
  reason?: "completed" | "not_planned";
  body?: string;
  assignees?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  title?: string;
  newBody?: string;
  newAssignees?: string[];
  reasoning?: string;
  issueTitle?: string;
}
interface ProposalWire {
  id: number;
  standupId: number;
  createdAt: string;
  triggerReason: "focus_change" | "speaker_change" | "fallback_60s";
  focusedIssue: number | null;
  actionType: ProposalActionType;
  repo: string;
  targetIssue: number | null;
  payload: ProposalPayload;
  originalPayload: ProposalPayload;
  state: ProposalState;
  version: number;
  executedAt: string | null;
  executedBy: string | null;
  executionResult: { ok?: boolean; url?: string; error?: string } | null;
  supersededBy: number | null;
}

// Server → Client WebSocket messages
type ServerMessage =
  | { type: "speaker"; userId: string; name: string; speaking: boolean }
  | { type: "utterance"; speaker: string; issueNumber: number | null; text: string; startedAt: number }
  | { type: "session"; recording: boolean; elapsed: number; utteranceCount: number }
  | { type: "state"; focusedIssue: number | null; focusedDetailIssue: number | null; presenter: string | null; presenterName: string | null; watcherNames: string[]; voiceMembers: VoiceMember[]; activeParticipantIndex: number; recording: boolean; elapsed: number; utteranceCount: number; proposals?: ProposalWire[] }
  | { type: "scroll"; scrollY: number }
  | { type: "detailScroll"; scrollTop: number }
  | { type: "proposal-upsert"; proposal: ProposalWire }
  | { type: "proposal-remove"; id: number }
  | { type: "proposal-error"; id: number; error: string };

// ── Globals ─────────────────────────────────────────────────────────────────

const CLIENT_ID = (window as any).__DISCORD_CLIENT_ID__;
const app = document.getElementById("app")!;

let sdk: DiscordSDK;
let ws: WebSocket | null = null;
let accessToken: string | null = null;
let currentUser: { id: string; username: string } | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY_MS = 30_000;
let participants: Participant[] = [];
let activeTabIndex = 0;
let focusedIssue: number | null = null;
let isRecording = false;
let elapsedSeconds = 0;
let utteranceCount = 0;
let speakingUsers = new Set<string>();
let speakingNames = new Set<string>();
let participantTimers = new Map<string, number>(); // name → accumulated ms
let speakerStartTimes = new Map<string, number>();  // name → start timestamp
/** Voice-channel members from the server (discord_id + display name). */
let voiceMembers: VoiceMember[] = [];
let standupKey = "";
let repo = "";
/** Discord voice channel ID for this Activity instance. Captured from
 *  sdk.channelId once auth completes; sent on the WS ready handshake so the
 *  server binds us to the right per-channel session (#61). */
let activityChannelId: string | null = null;
let timerInterval: ReturnType<typeof setInterval> | null = null;
let issueTimers = new Map<number, number>(); // issue# → accumulated ms
let focusStartTime: number | null = null;
const DETAIL_CACHE_MAX = 30;
let detailCache = new Map<string, any>(); // "repo/number" → detail
let detailFetchInFlight = false;

// ── Live proposals (#53) ───────────────────────────────────────────────────
let proposals: ProposalWire[] = [];
let actionBarOpen = false;
/** Per-proposal client-side error shown on the card after a server error. */
const proposalErrors = new Map<number, string>();
/** Per-proposal ephemeral "affirming" spinner flag. */
const proposalInFlight = new Set<number>();
/** Proposal IDs whose edit form is expanded. Default is collapsed — cards
 *  show a one-line summary + affirm/dismiss until the user clicks to edit. */
const expandedProposals = new Set<number>();

// ── Standup brief state (per-assignee, lazy, server-cached) ────────────────
interface BriefBullet { text: string; issueRefs: number[] }
interface Brief { headline: string; bullets: BriefBullet[] }
type BriefState =
  | { status: "loading" }
  | { status: "ok"; brief: Brief | null }
  | { status: "error"; message: string };
const briefByAssignee = new Map<string, BriefState>();

// ── Speaker name resolver ────────────────────────────────────────────────────
// Discord display names may not exactly match config names (e.g. "Brennan Volter" vs "Brennan").
// This resolves a Discord display name to the canonical config participant name.
const nameResolverCache = new Map<string, string>();

function resolveParticipantName(discordName: string, discordId?: string): string {
  // Discord ID match wins — the display name can be a server nickname that
  // doesn't resemble the GitHub-derived participant name (e.g. alt account).
  if (discordId) {
    const byId = participants.find(p => p.discordId === discordId);
    if (byId) return byId.name;
  }
  const cached = nameResolverCache.get(discordName);
  if (cached !== undefined) return cached;
  // 1. Exact match
  let match = participants.find(p => p.name === discordName);
  // 2. Case-insensitive
  if (!match) match = participants.find(p => p.name.toLowerCase() === discordName.toLowerCase());
  // 3. First word (handles "Brennan Volter" → "Brennan", "oliver-io" → "Oliver" etc.)
  if (!match) {
    const first = discordName.split(/[\s_-]+/)[0];
    match = participants.find(p => p.name.toLowerCase() === first.toLowerCase());
  }
  const resolved = match ? match.name : discordName;
  nameResolverCache.set(discordName, resolved);
  return resolved;
}

/**
 * Is this participant in (or was in) the voice call?
 *
 * Unassigned and participants without any identifying info are always "present"
 * (no sensible way to be absent). For assignees:
 *   - exact match by discordId against voiceMembers wins
 *   - else fuzzy display-name match against voiceMembers (exact → ci → first word)
 *   - else check if they've spoken at some point (participantTimers has an entry)
 */
function isParticipantPresent(p: Participant): boolean {
  if (p.githubUser === null) return true; // Unassigned
  if (p.discordId && voiceMembers.some(m => m.id === p.discordId)) return true;
  const lower = p.name.toLowerCase();
  const first = p.name.split(/[\s_-]+/)[0].toLowerCase();
  for (const m of voiceMembers) {
    const mLower = m.name.toLowerCase();
    if (mLower === lower) return true;
    const mFirst = m.name.split(/[\s_-]+/)[0].toLowerCase();
    if (mFirst === first) return true;
  }
  if ((participantTimers.get(p.name) ?? 0) > 0) return true;
  return false;
}

function cacheDetail(key: string, value: any) {
  if (detailCache.size >= DETAIL_CACHE_MAX) {
    detailCache.delete(detailCache.keys().next().value!);
  }
  detailCache.set(key, value);
}

// ── Sync / Freestyle state ──────────────────────────────────────────────────
/** Whether this client is following the presenter (synced mode). Defaults to
 *  freestyle (#63) — sync only engages when a presenter actually exists, and
 *  is auto-applied the first time we observe one. */
let syncMode = false;
/** Set true once we've observed a presenter at least once, so we don't
 *  re-auto-engage sync after the user manually enters freestyle. */
let presenterObserved = false;
/** Discord user ID of the current presenter, or null if nobody has controls. */
let presenterUserId: string | null = null;
/** Display name of the current presenter. */
let presenterName: string | null = null;
/** Display names of all other connected users (watchers when this client is presenting). */
let watcherNames: string[] = [];
/** Server's canonical focused issue (applied to local state when syncing). */
let serverFocusedIssue: number | null = null;
/** Server's canonical active participant tab index. */
let serverActiveTabIndex = 0;
/** Server's canonical detail panel issue (applied when syncing). */
let serverFocusedDetailIssue: number | null = null;
/** Issue number currently shown in the local detail panel, or null. */
let currentDetailIssue: number | null = null;
/** Last scroll position broadcast by the presenter (applied when syncing). */
let serverScrollY = 0;
/** Throttle timer for outbound scroll messages. */
let scrollThrottleTimer: ReturnType<typeof setTimeout> | null = null;
/** Throttle timer for outbound detail panel scroll messages. */
let detailScrollThrottleTimer: ReturnType<typeof setTimeout> | null = null;
/** Last detail panel scroll position from the presenter. */
let serverDetailScrollTop = 0;

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
    accessToken = access_token;

    // Authenticate with Discord SDK
    const auth = await sdk.commands.authenticate({ access_token });
    currentUser = auth.user ? { id: auth.user.id, username: auth.user.username } : null;

    app.innerHTML = `<div class="loading">Loading standup data...</div>`;

    // Capture the voice channel this Activity was launched in. Sent on the WS
    // ready handshake so the server can bind us to the per-channel session (#61).
    activityChannelId = (sdk as any).channelId ?? null;

    // Determine standup key — try to get from URL or default
    const params = new URLSearchParams(window.location.search);
    standupKey = params.get("standup") || "";

    if (!standupKey) {
      // Show standup picker — pass the Discord channelId so the server can
      // suggest a standup based on the voice channel the Activity launched in.
      renderStandupPicker(activityChannelId);
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

interface StandupOption {
  key: string;
  displayName: string;
}

interface PickerContext {
  suggestedStandup: string | null;
  reason: "active-session" | "channel-name" | null;
  channelName: string | null;
  activeSession: { standupKey: string; watcherCount: number } | null;
}

function renderStandupPicker(channelId: string | null) {
  app.innerHTML = `
    <div class="picker">
      <h1>Standup Activity</h1>
      <p class="picker-subtitle" id="picker-subtitle">Choose a standup to review</p>
      <div id="standup-buttons"></div>
    </div>
  `;

  const pickerCtxUrl = channelId
    ? `/api/picker-context?channelId=${encodeURIComponent(channelId)}`
    : "/api/picker-context";

  Promise.all([
    fetch("/api/standups").then((r) => r.json()) as Promise<StandupOption[]>,
    fetch(pickerCtxUrl)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null) as Promise<PickerContext | null>,
  ])
    .then(([standups, ctx]) => {
      const container = document.getElementById("standup-buttons")!;
      const subtitle = document.getElementById("picker-subtitle")!;

      const suggested = ctx?.suggestedStandup ?? null;
      const options: StandupOption[] = Array.isArray(standups)
        ? standups
        : [];
      const primary = suggested
        ? options.find((o) => o.key === suggested) ?? null
        : null;
      const others = primary
        ? options.filter((o) => o.key !== primary.key)
        : options;

      if (ctx?.reason === "active-session" && ctx.activeSession) {
        const n = ctx.activeSession.watcherCount;
        subtitle.textContent = n > 0
          ? `${n} ${n === 1 ? "person is" : "people are"} already reviewing ${primary?.displayName ?? "this standup"} — jump in?`
          : `A ${primary?.displayName ?? "standup"} session is active — jump in?`;
      } else if (ctx?.reason === "channel-name" && ctx.channelName && primary) {
        subtitle.textContent = `You're in #${ctx.channelName} — start the ${primary.displayName} standup?`;
      }

      if (primary) {
        const primaryWrap = document.createElement("div");
        primaryWrap.className = "picker-primary";
        primaryWrap.appendChild(makeStandupButton(primary, true));
        container.appendChild(primaryWrap);

        if (others.length > 0) {
          const othersWrap = document.createElement("div");
          othersWrap.className = "picker-others";
          othersWrap.dataset.open = "false";

          const toggle = document.createElement("button");
          toggle.className = "picker-others-toggle";
          toggle.type = "button";
          toggle.innerHTML = `<span class="caret">▸</span> Other projects`;
          toggle.onclick = () => {
            const open = othersWrap.dataset.open === "true";
            othersWrap.dataset.open = open ? "false" : "true";
          };
          othersWrap.appendChild(toggle);

          const list = document.createElement("div");
          list.className = "picker-others-list";
          for (const opt of others) list.appendChild(makeStandupButton(opt, false));
          othersWrap.appendChild(list);
          container.appendChild(othersWrap);
        }
      } else {
        // No suggestion — equal-weight list.
        for (const opt of options) container.appendChild(makeStandupButton(opt, false));
      }
    })
    .catch((e) => {
      document.getElementById("standup-buttons")!.innerHTML =
        `<p class="error-text">Failed to load standups: ${escapeHtml(e.message)}</p>`;
    });
}

function makeStandupButton(opt: StandupOption, primary: boolean): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = primary ? "standup-btn standup-btn-primary" : "standup-btn";
  btn.textContent = opt.displayName;
  btn.onclick = () => {
    standupKey = opt.key;
    loadStandup(opt.key).catch((e: any) => {
      app.innerHTML = `<div class="error">
        <h2>Failed to load standup</h2>
        <p>${escapeHtml(e.message)}</p>
        <button onclick="location.reload()">Retry</button>
      </div>`;
    });
  };
  return btn;
}

// ── Load Standup Data ───────────────────────────────────────────────────────

async function loadStandup(key: string) {
  app.innerHTML = `<div class="loading">Loading issues for ${escapeHtml(key)}...</div>`;

  const res = await fetch(`/api/issues?standup=${encodeURIComponent(key)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Failed to fetch issues: ${res.status}`);

  const data: IssuesResponse = await res.json();
  participants = data.participants;
  repo = data.repo;
  activeTabIndex = 0;
  nameResolverCache.clear();

  connectWebSocket();
  render();
  startTimer();
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
    nameResolverCache.clear();
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
  // Close existing socket before opening a new one to prevent duplicate connections.
  if (ws) {
    ws.onclose = null; // Prevent old onclose from triggering another reconnect
    ws.onerror = null;
    if (ws.readyState < WebSocket.CLOSING) ws.close();
    ws = null;
  }

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const newWs = new WebSocket(`${protocol}//${location.host}/ws`);
  ws = newWs;

  newWs.onopen = () => {
    reconnectAttempts = 0;
    newWs.send(JSON.stringify({
      type: "ready",
      standupKey,
      channelId: activityChannelId,
      userId: currentUser?.id ?? null,
      username: currentUser?.username ?? null,
      token: accessToken,
    }));
  };

  newWs.onmessage = (event) => {
    const msg: ServerMessage = JSON.parse(event.data);
    handleServerMessage(msg);
  };

  newWs.onclose = () => {
    if (ws !== newWs) return; // Stale handler — a newer socket already took over
    const delay = Math.min(3000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY_MS);
    reconnectAttempts++;
    console.log(`[ws] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
    setTimeout(connectWebSocket, delay);
  };

  newWs.onerror = (e) => {
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
    case "speaker": {
      const resolvedName = resolveParticipantName(msg.name, msg.userId);
      if (msg.speaking) {
        speakingUsers.add(msg.userId);
        speakingNames.add(resolvedName);
        speakerStartTimes.set(resolvedName, Date.now());
      } else {
        speakingUsers.delete(msg.userId);
        speakingNames.delete(resolvedName);
        const start = speakerStartTimes.get(resolvedName);
        if (start !== undefined) {
          participantTimers.set(resolvedName, (participantTimers.get(resolvedName) ?? 0) + (Date.now() - start));
          speakerStartTimes.delete(resolvedName);
        }
      }
      updateSpeakerIndicators();
      break;
    }

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

    case "proposal-upsert": {
      const incoming = msg.proposal;
      const idx = proposals.findIndex((p) => p.id === incoming.id);
      const prev = idx !== -1 ? proposals[idx] : null;
      if (idx === -1) proposals.push(incoming);
      else proposals[idx] = incoming;
      // Auto-expand on transition to affirmed/executed/failed so the user sees
      // the spinner or result. They can still collapse manually afterwards.
      if (prev && prev.state !== incoming.state &&
          (incoming.state === "affirmed" || incoming.state === "executed" || incoming.state === "failed")) {
        expandedProposals.add(incoming.id);
      }
      proposalErrors.delete(incoming.id);
      if (incoming.state !== "pending" && incoming.state !== "edited" && incoming.state !== "affirmed") {
        proposalInFlight.delete(incoming.id);
      }
      renderActionBar();
      break;
    }
    case "proposal-remove": {
      proposals = proposals.filter((p) => p.id !== msg.id);
      proposalErrors.delete(msg.id);
      proposalInFlight.delete(msg.id);
      expandedProposals.delete(msg.id);
      renderActionBar();
      break;
    }
    case "proposal-error": {
      proposalErrors.set(msg.id, msg.error);
      proposalInFlight.delete(msg.id);
      renderActionBar();
      break;
    }

    case "state": {
      // Track who the presenter is — needed for sync badge + permission checks
      const prevPresenterUserId = presenterUserId;
      presenterUserId = msg.presenter;
      presenterName = msg.presenterName ?? null;
      watcherNames = msg.watcherNames ?? [];
      // Freestyle default (#63): auto-engage sync the first time a presenter
      // appears for non-presenter clients. After that, the user is in charge —
      // entering freestyle (clicking around, etc.) sticks.
      if (presenterUserId && !prevPresenterUserId && !presenterObserved && !isPresenter()) {
        syncMode = true;
      }
      if (presenterUserId) presenterObserved = true;
      if (Array.isArray((msg as any).proposals)) {
        proposals = (msg as any).proposals as ProposalWire[];
        renderActionBar();
      }
      // Track voice-channel membership — drives "not present" tab styling.
      // Diff against previous so we only re-render tabs when it actually changes.
      const incomingVM = msg.voiceMembers ?? [];
      const voiceChanged =
        incomingVM.length !== voiceMembers.length ||
        incomingVM.some((m, i) => voiceMembers[i]?.id !== m.id || voiceMembers[i]?.name !== m.name);
      voiceMembers = incomingVM;
      // Save server's canonical state
      serverFocusedIssue = msg.focusedIssue;
      serverActiveTabIndex = msg.activeParticipantIndex ?? 0;
      isRecording = msg.recording;
      elapsedSeconds = msg.elapsed;
      utteranceCount = msg.utteranceCount;

      // Track detail panel state changes for sync
      const prevServerDetail = serverFocusedDetailIssue;
      serverFocusedDetailIssue = msg.focusedDetailIssue ?? null;

      if (syncMode) {
        // Apply server state to local view
        const tabChanged = activeTabIndex !== serverActiveTabIndex;
        const focusChanged = focusedIssue !== serverFocusedIssue;
        activeTabIndex = serverActiveTabIndex;
        focusedIssue = serverFocusedIssue;

        // Sync detail panel to presenter if watching (not the presenter)
        if (!isPresenter() && serverFocusedDetailIssue !== prevServerDetail) {
          if (serverFocusedDetailIssue !== null) {
            openDetailPanel(serverFocusedDetailIssue);
          } else {
            closeDetailPanel();
          }
        }

        if (tabChanged) {
          render();
          // After re-render, apply presenter's scroll position
          window.scrollTo({ top: serverScrollY, behavior: "instant" });
        } else if (voiceChanged && participants.length > 0) {
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
        if (voiceChanged && participants.length > 0) render();
        else {
          updateHeader();
          updateSyncBadge();
        }
      }
      break;
    }

    case "scroll": {
      serverScrollY = msg.scrollY;
      if (syncMode && !isPresenter()) {
        window.scrollTo({ top: msg.scrollY, behavior: "instant" });
      }
      break;
    }

    case "detailScroll": {
      serverDetailScrollTop = msg.scrollTop;
      if (syncMode && !isPresenter()) {
        const panel = document.querySelector(".detail-panel");
        if (panel) panel.scrollTop = msg.scrollTop;
      }
      break;
    }
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

function render() {
  const bannerHtml = renderNoSessionBanner();
  const headerHtml = renderHeader();
  const tabsHtml = renderTabs();
  const boardHtml = renderBoard();
  const collapsed = localStorage.getItem("dpm.liveFeed.collapsed") === "1";
  const feedClass = `live-feed${collapsed ? " live-feed-collapsed" : ""}`;
  const toggleIcon = collapsed ? "▲" : "▼";
  const liveHtml = `<div id="live-feed" class="${feedClass}"><button id="live-feed-toggle" class="live-feed-toggle" title="Collapse/expand transcript">${toggleIcon}</button></div>`;

  app.innerHTML = `
    ${bannerHtml}
    ${headerHtml}
    ${tabsHtml}
    ${boardHtml}
    ${liveHtml}
  `;
  updateTabTimes();
  setupLiveFeedToggle();
  wireBriefCard();
  maybeLoadBrief();
}

function renderNoSessionBanner(): string {
  if (isRecording) return "";
  return `
    <div class="no-session-banner" id="no-session-banner">
      <span class="no-session-banner-icon">⚠️</span>
      <span>No standup is recording in this channel — run <code>/standup start</code> in Discord to begin.</span>
    </div>
  `;
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
    const watcherInfo = watcherNames.length > 0
      ? ` · ${watcherNames.length} watching`
      : "";
    return `<span class="sync-badge sync-badge-presenter">🎤 Presenting${escapeHtml(watcherInfo)}</span>`;
  }
  if (syncMode && presenterUserId) {
    const nameTag = presenterName ? ` · ${escapeHtml(presenterName)}` : "";
    return `<span class="sync-badge sync-badge-synced">🔴 Live${nameTag}</span>`;
  }
  if (!syncMode) {
    return `<span class="sync-badge sync-badge-freestyle" id="btn-sync-badge" title="Click to sync back to presenter">🔓 Freestyle</span>`;
  }
  return ""; // no presenter, no badge needed
}

function renderTabs(): string {
  const tabs = participants.map((p, i) => {
    const active = i === activeTabIndex ? "tab-active" : "";
    const speakingClass = speakingNames.has(p.name) ? "tab-speaking" : "";
    const present = isParticipantPresent(p);
    const absentClass = present ? "" : "tab-not-present";
    const absentSuffix = present ? "" : `<span class="tab-absent-tag">(not present)</span>`;
    return `<button class="tab ${active} ${speakingClass} ${absentClass}" data-index="${i}"><span class="tab-name">${escapeHtml(p.name)}</span>${absentSuffix}<span class="tab-time" id="tab-time-${i}"></span></button>`;
  }).join("");

  const allPRCount = participants.reduce((n, p) => n + (p.prs?.length ?? 0), 0);
  const prTabIdx = participants.length;
  const prTab = allPRCount > 0
    ? `<button class="tab tab-pr ${activeTabIndex === prTabIdx ? "tab-active" : ""}" data-index="${prTabIdx}"><span class="tab-name">🔀 PRs</span><span class="tab-time">${allPRCount}</span></button>`
    : "";

  return `<div class="tabs" id="tabs">${tabs}${prTab}</div>`;
}

function updateTabTimes() {
  participants.forEach((p, i) => {
    const el = document.getElementById(`tab-time-${i}`);
    if (!el) return;
    const totalMs = participantTimers.get(p.name) ?? 0;
    const isSpeaking = speakingNames.has(p.name);
    const liveMs = isSpeaking ? (Date.now() - (speakerStartTimes.get(p.name) ?? Date.now())) : 0;
    const totalSec = Math.floor((totalMs + liveMs) / 1000);
    el.textContent = formatTime(totalSec);
  });
}

function renderBoard(): string {
  // Virtual "All PRs" tab
  if (activeTabIndex === participants.length) return renderAllPRsBoard();

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
      const ghLink = `<a class="gh-link" href="${escapeHtml(issue.url)}" target="_blank" title="Open on GitHub">↗</a>`;
      return `
        <div class="issue-card ${focused} ${closedClass}" data-issue="${issue.number}" data-url="${escapeHtml(issue.url)}" data-title="${escapeHtml(issue.title)}" data-state="${escapeHtml(issue.state)}">
          <div class="issue-header">
            <span class="issue-number" data-detail="${issue.number}">#${issue.number}</span>
            <span class="issue-title">${escapeHtml(issue.title)}</span>
          </div>
          <div class="issue-badges">${timer}${age}${prio}${bug}${ghLink}</div>
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
  const allPRCount = participants.reduce((n, p) => n + (p.prs?.length ?? 0), 0);
  const prevName = prevIdx >= 0 ? participants[prevIdx].name : null;
  const nextName = nextIdx < participants.length
    ? participants[nextIdx].name
    : (nextIdx === participants.length && allPRCount > 0 ? "🔀 PRs" : null);

  const centerBtn = renderNavCenterButton();
  const navHtml = `
    <div class="board-nav">
      <button class="nav-btn" id="btn-prev" ${!prevName ? "disabled" : ""}>${prevName ? `← ${escapeHtml(prevName)}` : "←"}</button>
      ${centerBtn}
      <button class="nav-btn" id="btn-next" ${!nextName ? "disabled" : ""}>${nextName ? `${escapeHtml(nextName)} →` : "→"}</button>
    </div>
  `;

  // ── PR section ──────────────────────────────────────────────────────────
  const prsHtml = participant.prs?.length > 0 ? (() => {
    const prCards = participant.prs.map(pr => {
      const draftClass = pr.isDraft ? " pr-card-draft" : "";
      const draftBadge = pr.isDraft ? `<span class="badge badge-draft">draft</span>` : "";
      const age = `<span class="issue-age ${freshnessClass(pr.updatedAt)}">${relativeTime(pr.updatedAt)}</span>`;
      const ghLink = `<a class="gh-link" href="${escapeHtml(pr.url)}" target="_blank" title="Open PR on GitHub">↗</a>`;
      return `
        <div class="pr-card${draftClass}" data-pr="${pr.number}" data-url="${escapeHtml(pr.url)}">
          <div class="issue-header">
            <span class="issue-number">#${pr.number}</span>
            <span class="issue-title">${escapeHtml(pr.title)}</span>
          </div>
          <div class="issue-badges">${age}${draftBadge}${ghLink}</div>
        </div>
      `;
    }).join("");
    return `
      <div class="stage-group">
        <div class="stage-header">🔀 Pull Requests (${participant.prs.length})</div>
        ${prCards}
      </div>
    `;
  })() : "";

  // Mark participants discovered dynamically (their name equals their GitHub username)
  const extraBadge = participant.githubUser && participant.name === participant.githubUser
    ? `<span class="board-extra-badge">unlisted</span>` : "";

  const briefSlot = participant.githubUser ? `<div id="brief-slot">${renderBriefCardHtml()}</div>` : "";

  return `
    <div class="board" id="board">
      <div class="board-participant">
        ${participant.avatarUrl ? `<img class="board-avatar" src="${escapeHtml(participant.avatarUrl)}" alt="">` : ""}
        <span class="board-name">${escapeHtml(participant.name)}</span>${extraBadge}
      </div>
      ${briefSlot}
      <div class="stages">${stagesHtml}${prsHtml}</div>
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
    const watcherInfo = watcherNames.length > 0
      ? ` (${watcherNames.map(n => escapeHtml(n)).join(", ")})`
      : "";
    return `<button class="nav-btn nav-btn-presenter" id="btn-controls" disabled>🎤 Presenting${watcherInfo}</button>`;
  }
  if (syncMode && presenterUserId) {
    // Following presenter — offer to go freestyle
    return `<button class="nav-btn nav-btn-synced" id="btn-freestyle">🔓 Go Freestyle</button>`;
  }
  if (!syncMode && presenterUserId) {
    // In freestyle while presenter exists — offer to take control
    return `<button class="nav-btn nav-btn-primary" id="btn-controls">Take Control</button>`;
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
  // Snap scroll to match presenter's current position
  window.scrollTo({ top: serverScrollY, behavior: "instant" });
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

  // GitHub links — must use sdk.openExternalLink inside Discord Activity sandbox
  const ghLinkEl = target.closest(".gh-link, .detail-link") as HTMLAnchorElement | null;
  if (ghLinkEl) {
    e.preventDefault();
    const url = ghLinkEl.href;
    if (url && sdk) {
      sdk.commands.openExternalLink({ url }).catch((err: any) => {
        console.warn("[gh-link] openExternalLink failed:", err);
      });
    }
    return;
  }

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
    // Broadcast to watchers if we are presenter (or no presenter — collaborative mode)
    if (isPresenter() || !presenterUserId) {
      sendWs({ type: "detail", issueNumber: issueNum });
    }
    return;
  }

  // Detail panel close
  if (target.closest(".detail-close") || target.classList.contains("detail-overlay")) {
    closeDetailPanel();
    // Broadcast close to watchers
    if (isPresenter() || !presenterUserId) {
      sendWs({ type: "detail", issueNumber: null });
    }
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

  // PR card click → open PR detail modal
  const prCard = target.closest(".pr-card") as HTMLElement | null;
  if (prCard && prCard.dataset.pr) {
    e.preventDefault();
    const prNum = parseInt(prCard.dataset.pr);
    openPRDetailPanel(prNum);
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
  if (target.id === "btn-next") {
    const allPRCount = participants.reduce((n, p) => n + (p.prs?.length ?? 0), 0);
    const maxIdx = participants.length - 1 + (allPRCount > 0 ? 1 : 0);
    if (activeTabIndex < maxIdx) {
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
  }
  if (target.id === "btn-controls" && currentUser) {
    // If taking control from freestyle, snap to server state first so we
    // start from the same position the previous presenter left off.
    if (!syncMode) snapToSync();
    sendWs({ type: "controls", userId: currentUser.id });
    return;
  }
  if (target.id === "btn-freestyle") {
    enterFreestyle();
    return;
  }
  if (target.id === "btn-sync-badge") {
    snapToSync();
    return;
  }

  if (target.id === "btn-refresh") {
    refreshIssues();
    return;
  }

  if (target.id === "btn-assign") {
    const assignRepo = (target as HTMLElement).dataset.repo!;
    const assignIssueNum = (target as HTMLElement).dataset.issue!;
    const select = document.getElementById("assign-select") as HTMLSelectElement | null;
    const value = select?.value;
    // "__none__" is the placeholder; empty string means unassign.
    if (value === undefined || value === "__none__") return;
    const isUnassign = value === "";
    const originalLabel = isUnassign ? "Unassign" : "Assign";

    const btn = target as HTMLButtonElement;
    btn.textContent = isUnassign ? "Unassigning..." : "Assigning...";
    btn.disabled = true;

    fetch(`/api/issues/${encodeURIComponent(assignRepo)}/${assignIssueNum}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignee: value }),
    }).then(async (res) => {
      if (res.ok) {
        btn.textContent = isUnassign ? "✓ Unassigned" : "✓ Assigned";
        // Invalidate cached detail so next open shows fresh assignees
        detailCache.delete(`${assignRepo}/${assignIssueNum}`);
      } else {
        const data = await res.json().catch(() => ({}));
        btn.textContent = "Failed";
        btn.style.color = "#f87171";
        console.error("[assign] Error:", data.error);
        setTimeout(() => {
          btn.textContent = originalLabel;
          btn.style.color = "";
          btn.disabled = false;
        }, 3000);
      }
    }).catch((err) => {
      console.error("[assign] Fetch error:", err);
      btn.textContent = "Failed";
      btn.style.color = "#f87171";
      setTimeout(() => {
        btn.textContent = originalLabel;
        btn.style.color = "";
        btn.disabled = false;
      }, 3000);
    });
    return;
  }

  if (target.id === "btn-close-issue" || target.id === "btn-reopen-issue") {
    const isReopen = target.id === "btn-reopen-issue";
    const actionRepo = (target as HTMLElement).dataset.repo!;
    const actionIssueNum = (target as HTMLElement).dataset.issue!;
    const reasonSelect = document.getElementById("close-reason-select") as HTMLSelectElement | null;
    const reason = reasonSelect?.value === "not_planned" ? "not_planned" : "completed";

    const btn = target as HTMLButtonElement;
    const originalLabel = isReopen ? "Reopen issue" : "Close issue";
    btn.textContent = isReopen ? "Reopening..." : "Closing...";
    btn.disabled = true;

    const path = isReopen ? "reopen" : "close";
    fetch(`/api/issues/${encodeURIComponent(actionRepo)}/${actionIssueNum}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(isReopen ? {} : { reason }),
    }).then(async (res) => {
      if (res.ok) {
        btn.textContent = isReopen ? "✓ Reopened" : "✓ Closed";
        detailCache.delete(`${actionRepo}/${actionIssueNum}`);
      } else {
        const data = await res.json().catch(() => ({}));
        btn.textContent = "Failed";
        btn.style.color = "#f87171";
        console.error("[close] Error:", data.error);
        setTimeout(() => {
          btn.textContent = originalLabel;
          btn.style.color = "";
          btn.disabled = false;
        }, 3000);
      }
    }).catch((err) => {
      console.error("[close] Fetch error:", err);
      btn.textContent = "Failed";
      btn.style.color = "#f87171";
      setTimeout(() => {
        btn.textContent = originalLabel;
        btn.style.color = "";
        btn.disabled = false;
      }, 3000);
    });
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
  const header = document.getElementById("header");
  if (header) {
    header.classList.toggle("speaking-active", speakingUsers.size > 0);
  }
  // Pulse only the specific participant tab that's speaking
  document.querySelectorAll<HTMLElement>(".tab[data-index]").forEach((el) => {
    const idx = parseInt(el.dataset.index!);
    const name = participants[idx]?.name ?? "";
    el.classList.toggle("tab-speaking", speakingNames.has(name));
  });
}

function addLiveUtterance(speaker: string, text: string, issueNumber: number | null) {
  const feed = document.getElementById("live-feed");
  if (!feed) return;

  const entry = document.createElement("div");
  entry.className = "live-entry";
  const issueTag = issueNumber ? `<span class="live-issue">#${issueNumber}</span> ` : "";
  entry.innerHTML = `${issueTag}<strong>${escapeHtml(speaker)}:</strong> ${escapeHtml(text)}`;
  feed.prepend(entry);

  // Keep max 10 .live-entry elements (toggle button is a sibling child — ignored).
  const entries = feed.querySelectorAll(".live-entry");
  for (let i = 10; i < entries.length; i++) entries[i].remove();
}

async function fetchAssigneeBrief(assignee: string, refresh = false): Promise<void> {
  briefByAssignee.set(assignee, { status: "loading" });
  if (assignee === currentBriefAssignee()) renderBriefCard();
  try {
    const qs = new URLSearchParams({ standup: standupKey, assignee });
    if (refresh) qs.set("refresh", "1");
    const res = await fetch(`/api/assignee-brief?${qs.toString()}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({} as any));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const data = await res.json() as { brief: Brief | null };
    briefByAssignee.set(assignee, { status: "ok", brief: data.brief });
  } catch (e: any) {
    briefByAssignee.set(assignee, { status: "error", message: e.message || "Unknown error" });
  }
  if (assignee === currentBriefAssignee()) renderBriefCard();
}

function currentBriefAssignee(): string | null {
  const p = participants[activeTabIndex];
  if (!p || !p.githubUser) return null;
  return p.githubUser;
}

function maybeLoadBrief() {
  const assignee = currentBriefAssignee();
  if (!assignee) return;
  if (!briefByAssignee.has(assignee)) void fetchAssigneeBrief(assignee, false);
}

function renderBriefCardHtml(): string {
  const assignee = currentBriefAssignee();
  if (!assignee) return "";
  const state = briefByAssignee.get(assignee);
  if (!state) return "";
  if (state.status === "loading") {
    return `<div class="brief-skeleton" id="brief-card"><div class="brief-skeleton-line"></div><div class="brief-skeleton-line"></div><div class="brief-skeleton-line"></div></div>`;
  }
  if (state.status === "error") {
    return `<div class="brief-card" id="brief-card"><div class="brief-header"><span class="brief-error">Brief unavailable: ${escapeHtml(state.message)}</span><button class="brief-refresh" id="brief-refresh" title="Retry">↻</button></div></div>`;
  }
  if (!state.brief) return ""; // no updates → hide entirely
  const bulletsHtml = state.brief.bullets.slice(0, 5).map(b => {
    const chips = b.issueRefs.map(n => `<span class="live-issue" data-detail="${n}">#${n}</span>`).join("");
    return `<li class="brief-bullet"><span class="bullet-text">${chips}${escapeHtml(b.text)}</span></li>`;
  }).join("");
  return `
    <div class="brief-card" id="brief-card">
      <div class="brief-header">
        <div class="brief-headline">${escapeHtml(state.brief.headline)}</div>
        <button class="brief-refresh" id="brief-refresh" title="Regenerate brief">↻</button>
      </div>
      <ul class="brief-bullets">${bulletsHtml}</ul>
    </div>
  `;
}

function renderBriefCard() {
  const slot = document.getElementById("brief-slot");
  if (!slot) return;
  slot.innerHTML = renderBriefCardHtml();
  wireBriefCard();
}

function wireBriefCard() {
  const refresh = document.getElementById("brief-refresh");
  const assignee = currentBriefAssignee();
  if (refresh && assignee) {
    refresh.addEventListener("click", () => {
      refresh.classList.add("spinning");
      void fetchAssigneeBrief(assignee, true);
    });
  }
  // #N issue chips inside bullets open the detail modal (reuse data-detail handler)
  document.querySelectorAll<HTMLElement>("#brief-card .live-issue[data-detail]").forEach(el => {
    el.addEventListener("click", () => {
      const n = parseInt(el.dataset.detail!);
      if (!isNaN(n)) openDetailPanel(n);
    });
  });
}

function setupLiveFeedToggle() {
  const toggle = document.getElementById("live-feed-toggle");
  const feed = document.getElementById("live-feed");
  if (!toggle || !feed) return;
  toggle.addEventListener("click", () => {
    const collapsed = feed.classList.toggle("live-feed-collapsed");
    toggle.textContent = collapsed ? "▲" : "▼";
    localStorage.setItem("dpm.liveFeed.collapsed", collapsed ? "1" : "0");
  });
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (isRecording) {
      elapsedSeconds++;
    }
    updateHeader();
    updateTabTimes();
  }, 1000);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
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

function getAllPRs(): { pr: PR; author: string }[] {
  const result: { pr: PR; author: string }[] = [];
  for (const p of participants) {
    for (const pr of (p.prs ?? [])) {
      result.push({ pr, author: p.name });
    }
  }
  return result.sort((a, b) => new Date(b.pr.updatedAt).getTime() - new Date(a.pr.updatedAt).getTime());
}

function renderAllPRsBoard(): string {
  const allPRs = getAllPRs();

  if (allPRs.length === 0) {
    return `<div class="board" id="board"><div class="empty-board">No open pull requests</div></div>`;
  }

  // Group by participant name, preserving participant order
  const byAuthor = new Map<string, PR[]>();
  for (const p of participants) {
    const prs = allPRs.filter(e => e.author === p.name).map(e => e.pr);
    if (prs.length > 0) byAuthor.set(p.name, prs);
  }

  const groupsHtml = [...byAuthor.entries()].map(([author, prs]) => {
    const prCards = prs.map(pr => {
      const draftClass = pr.isDraft ? " pr-card-draft" : "";
      const draftBadge = pr.isDraft ? `<span class="badge badge-draft">draft</span>` : "";
      const age = `<span class="issue-age ${freshnessClass(pr.updatedAt)}">${relativeTime(pr.updatedAt)}</span>`;
      const ghLink = `<a class="gh-link" href="${escapeHtml(pr.url)}" target="_blank" title="Open PR on GitHub">↗</a>`;
      return `
        <div class="pr-card${draftClass}" data-pr="${pr.number}" data-url="${escapeHtml(pr.url)}">
          <div class="issue-header">
            <span class="issue-number">#${pr.number}</span>
            <span class="issue-title">${escapeHtml(pr.title)}</span>
          </div>
          <div class="issue-badges">${age}${draftBadge}${ghLink}</div>
        </div>
      `;
    }).join("");
    return `
      <div class="stage-group">
        <div class="stage-header">👤 ${escapeHtml(author)} (${prs.length})</div>
        ${prCards}
      </div>
    `;
  }).join("");

  const prevName = participants.length > 0 ? participants[participants.length - 1].name : null;
  const navHtml = `
    <div class="board-nav">
      <button class="nav-btn" id="btn-prev" ${!prevName ? "disabled" : ""}>${prevName ? `← ${escapeHtml(prevName)}` : "←"}</button>
      <button class="nav-btn" disabled>🔀 All PRs</button>
      <button class="nav-btn" id="btn-next" disabled>→</button>
    </div>
  `;

  return `
    <div class="board" id="board">
      <div class="board-participant">
        <span class="board-name">🔀 Pull Requests</span>
        <span class="board-extra-badge">${allPRs.length} open</span>
      </div>
      <div class="stages">${groupsHtml}</div>
      ${navHtml}
    </div>
  `;
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
  currentDetailIssue = issueNumber;
  if (detailFetchInFlight) return;

  const cacheKey = `${repo}/${issueNumber}`;
  let detail = detailCache.get(cacheKey);

  if (!detail) {
    detailFetchInFlight = true;

    // Show loading overlay
    const overlay = document.createElement("div");
    overlay.className = "detail-overlay";
    overlay.innerHTML = `<div class="detail-panel"><div class="loading" style="min-height:200px">Loading issue #${issueNumber}...</div></div>`;
    document.body.appendChild(overlay);

    try {
      const res = await fetch(`/api/issues/${encodeURIComponent(repo)}/${issueNumber}`);
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
      detail = await res.json();
      cacheDetail(cacheKey, detail);
    } catch (e: any) {
      overlay.remove();
      detailFetchInFlight = false;
      console.error("Detail fetch error:", e);
      return;
    } finally {
      detailFetchInFlight = false;
    }
    overlay.remove();
    detailFetchInFlight = false;
  }

  renderDetailOverlay(detail);
}

function renderDetailOverlay(detail: any) {
  const existing = document.querySelector(".detail-overlay");
  if (existing) existing.remove();

  const labelsHtml = (detail.labels ?? []).map((l: string) => `<span class="detail-label">${escapeHtml(l)}</span>`).join(" ");
  const bodyHtml = detail.body ? formatPlainText(detail.body) : "<em>No description</em>";

  // Creator, assignees, state meta row
  const stateClass = detail.state === "open" ? "detail-meta-state-open" : "detail-meta-state-closed";
  const stateText = detail.state === "open" ? "🟢 open" : "⚫ closed";
  const assigneesText = detail.assignees?.length > 0
    ? detail.assignees.map((a: string) => `<strong>@${escapeHtml(a)}</strong>`).join(", ")
    : "<em>unassigned</em>";
  const metaHtml = `
    <div class="detail-meta">
      <span>by <strong>@${escapeHtml(detail.creator ?? "unknown")}</strong></span>
      <span class="detail-meta-sep">·</span>
      <span>assigned to ${assigneesText}</span>
      <span class="detail-meta-sep">·</span>
      <span class="${stateClass}">${stateText}</span>
    </div>
  `;
  const commentsHtml = (detail.comments ?? []).map((c: any) => `
    <div class="detail-comment">
      <div class="comment-meta"><strong>${escapeHtml(c.user)}</strong> <span class="comment-date">${relativeTime(c.createdAt)}</span></div>
      <div class="comment-body">${formatPlainText(c.body)}</div>
    </div>
  `).join("");

  // Build reassign dropdown from participants with a GitHub user
  const assignable = participants.filter(p => p.githubUser !== null);
  const reassignHtml = assignable.length > 0 ? `
    <div class="detail-reassign">
      <span class="detail-reassign-label">Reassign to:</span>
      <select id="assign-select" class="assign-select">
        <option value="__none__">Select contributor...</option>
        <option value="">— Unassign —</option>
        ${assignable.map(p => `<option value="${escapeHtml(p.githubUser!)}">${escapeHtml(p.name)} (@${escapeHtml(p.githubUser!)})</option>`).join("")}
      </select>
      <button class="btn-assign" id="btn-assign" data-repo="${escapeHtml(repo)}" data-issue="${detail.number}">Assign</button>
    </div>
  ` : "";

  const closeActionHtml = `
    <div class="detail-close-action">
      ${detail.state === "open" ? `
        <span class="detail-reassign-label">Close as:</span>
        <select id="close-reason-select" class="assign-select">
          <option value="completed">Completed</option>
          <option value="not_planned">Not planned</option>
        </select>
        <button class="btn-close-issue" id="btn-close-issue" data-repo="${escapeHtml(repo)}" data-issue="${detail.number}">Close issue</button>
      ` : `
        <span class="detail-reassign-label">This issue is closed.</span>
        <button class="btn-reopen-issue" id="btn-reopen-issue" data-repo="${escapeHtml(repo)}" data-issue="${detail.number}">Reopen issue</button>
      `}
    </div>
  `;

  const overlay = document.createElement("div");
  overlay.className = "detail-overlay";
  overlay.innerHTML = `
    <div class="detail-panel">
      <div class="detail-header">
        <span class="detail-number">#${detail.number}</span>
        <span class="detail-title">${escapeHtml(detail.title)}</span>
        <button class="detail-close">X</button>
      </div>
      ${metaHtml}
      <div class="detail-labels">${labelsHtml}</div>
      <div class="detail-body">${bodyHtml}</div>
      ${commentsHtml ? `<div class="detail-comments-header">Comments (${detail.comments?.length ?? 0})</div>${commentsHtml}` : ""}
      <a class="detail-link" href="${escapeHtml(detail.url)}" target="_blank">View on GitHub</a>
      ${reassignHtml}
      ${closeActionHtml}
    </div>
  `;
  document.body.appendChild(overlay);

  // Detail panel scroll sync
  const panelEl = overlay.querySelector(".detail-panel") as HTMLElement | null;
  if (panelEl) {
    if (isPresenter() || !presenterUserId) {
      // Presenter: broadcast scroll position to watchers
      panelEl.addEventListener("scroll", () => {
        if (detailScrollThrottleTimer !== null) return;
        detailScrollThrottleTimer = setTimeout(() => {
          detailScrollThrottleTimer = null;
          sendWs({ type: "detailScroll", scrollTop: panelEl.scrollTop });
        }, 100);
      }, { passive: true });
    } else if (syncMode && serverDetailScrollTop > 0) {
      // Watcher: apply presenter's current scroll position
      panelEl.scrollTop = serverDetailScrollTop;
    }
  }
}

function closeDetailPanel() {
  currentDetailIssue = null;
  serverDetailScrollTop = 0;
  const overlay = document.querySelector(".detail-overlay");
  if (overlay) overlay.remove();
}

// ── PR Detail Panel ─────────────────────────────────────────────────────

async function openPRDetailPanel(prNumber: number) {
  const existing = document.querySelector(".detail-overlay");
  if (existing) existing.remove();
  serverDetailScrollTop = 0;

  const cacheKey = `pr:${repo}/${prNumber}`;
  let detail = detailCache.get(cacheKey);

  if (!detail) {
    const overlay = document.createElement("div");
    overlay.className = "detail-overlay";
    overlay.innerHTML = `<div class="detail-panel"><div class="loading" style="min-height:200px">Loading PR #${prNumber}...</div></div>`;
    document.body.appendChild(overlay);

    try {
      const res = await fetch(`/api/prs/${encodeURIComponent(repo)}/${prNumber}`);
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
      detail = await res.json();
      cacheDetail(cacheKey, detail);
    } catch (e: any) {
      overlay.remove();
      console.error("PR detail fetch error:", e);
      return;
    }
    overlay.remove();
  }

  renderPRDetailOverlay(detail);
}

function renderPRDetailOverlay(detail: any) {
  const existing = document.querySelector(".detail-overlay");
  if (existing) existing.remove();

  const stateLabel = detail.isDraft ? "📝 draft" : detail.state === "merged" ? "🟣 merged" : "🟢 open";
  const stateClass = detail.state === "merged" ? "detail-meta-state-merged" : detail.state === "open" ? "detail-meta-state-open" : "detail-meta-state-closed";
  const branchInfo = detail.headBranch ? `<span class="pr-branch">${escapeHtml(detail.headBranch)}</span> → <span class="pr-branch">${escapeHtml(detail.baseBranch)}</span>` : "";

  const statsHtml = `
    <div class="pr-stats">
      <span class="pr-stat pr-stat-add">+${detail.additions}</span>
      <span class="pr-stat pr-stat-del">-${detail.deletions}</span>
      <span class="pr-stat pr-stat-files">${detail.changedFiles} file${detail.changedFiles !== 1 ? "s" : ""}</span>
    </div>
  `;

  const metaHtml = `
    <div class="detail-meta">
      <span>by <strong>@${escapeHtml(detail.creator)}</strong></span>
      <span class="detail-meta-sep">·</span>
      <span>${branchInfo}</span>
      <span class="detail-meta-sep">·</span>
      <span class="${stateClass}">${stateLabel}</span>
    </div>
  `;

  const labelsHtml = (detail.labels ?? []).map((l: string) => `<span class="detail-label">${escapeHtml(l)}</span>`).join(" ");
  const bodyHtml = detail.body ? formatPlainText(detail.body) : "<em>No description</em>";

  const reviewsHtml = detail.reviewers?.length > 0 ? `
    <div class="pr-reviews">
      ${detail.reviewers.map((r: any) => {
        const icon = r.state === "APPROVED" ? "✅" : r.state === "CHANGES_REQUESTED" ? "❌" : "💬";
        return `<span class="pr-review">${icon} <strong>@${escapeHtml(r.user)}</strong></span>`;
      }).join(" ")}
    </div>
  ` : "";

  const filesHtml = detail.files?.length > 0 ? `
    <div class="detail-comments-header">Changed Files (${detail.files.length})</div>
    <div class="pr-files">
      ${detail.files.map((f: any) => {
        const statusIcon = f.status === "added" ? "+" : f.status === "removed" ? "−" : "~";
        return `<div class="pr-file"><span class="pr-file-status pr-file-${f.status}">${statusIcon}</span><span class="pr-file-name">${escapeHtml(f.filename)}</span><span class="pr-file-diff"><span class="pr-stat-add">+${f.additions}</span> <span class="pr-stat-del">-${f.deletions}</span></span></div>`;
      }).join("")}
    </div>
  ` : "";

  const overlay = document.createElement("div");
  overlay.className = "detail-overlay";
  overlay.innerHTML = `
    <div class="detail-panel">
      <div class="detail-header">
        <span class="detail-number">#${detail.number}</span>
        <span class="detail-title">${escapeHtml(detail.title)}</span>
        <button class="detail-close">X</button>
      </div>
      ${metaHtml}
      ${statsHtml}
      ${reviewsHtml}
      <div class="detail-labels">${labelsHtml}</div>
      <div class="detail-body">${bodyHtml}</div>
      ${filesHtml}
      <a class="detail-link" href="${escapeHtml(detail.url)}" target="_blank">View on GitHub</a>
    </div>
  `;
  document.body.appendChild(overlay);

  // Detail panel scroll sync
  const panelEl = overlay.querySelector(".detail-panel") as HTMLElement | null;
  if (panelEl) {
    if (isPresenter() || !presenterUserId) {
      panelEl.addEventListener("scroll", () => {
        if (detailScrollThrottleTimer !== null) return;
        detailScrollThrottleTimer = setTimeout(() => {
          detailScrollThrottleTimer = null;
          sendWs({ type: "detailScroll", scrollTop: panelEl.scrollTop });
        }, 100);
      }, { passive: true });
    } else if (syncMode && serverDetailScrollTop > 0) {
      panelEl.scrollTop = serverDetailScrollTop;
    }
  }
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

// ── Scroll sync ──────────────────────────────────────────────────────────────
// When this client is the presenter, broadcast scroll position (throttled) so
// watchers in sync mode can follow along.

window.addEventListener("scroll", () => {
  if (!isPresenter()) return;
  if (scrollThrottleTimer !== null) return;
  scrollThrottleTimer = setTimeout(() => {
    scrollThrottleTimer = null;
    sendWs({ type: "scroll", scrollY: window.scrollY });
  }, 100);
}, { passive: true });

// ── Live Action Bar (#53) ───────────────────────────────────────────────────

function getActionBarRoot(): HTMLElement {
  let root = document.getElementById("action-bar-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "action-bar-root";
    root.className = "action-bar";
    root.innerHTML = `
      <div class="action-bar-inner">
        <div id="action-bar-drawer" class="action-bar-drawer" aria-hidden="true">
          <div id="action-bar-drawer-inner" class="action-bar-drawer-inner"></div>
        </div>
        <button id="action-bar-handle" class="action-bar-handle" aria-expanded="false">
          <span class="action-bar-label">Action Bar</span>
          <span id="action-bar-badge" class="action-bar-badge" data-count="0">0</span>
          <span id="action-bar-chevron" class="action-bar-chevron">▲</span>
        </button>
      </div>
    `;
    document.body.appendChild(root);
    const handle = root.querySelector("#action-bar-handle") as HTMLButtonElement;
    handle.addEventListener("click", () => {
      actionBarOpen = !actionBarOpen;
      renderActionBar();
    });
  }
  return root;
}

function liveProposals(): ProposalWire[] {
  // set_labels is disabled (#66); filter stale historical rows out of the UI.
  return proposals.filter(
    (p) =>
      p.state !== "dismissed" &&
      p.supersededBy == null &&
      p.actionType !== "set_labels",
  );
}

function pendingCount(): number {
  return liveProposals().filter(
    (p) => p.state === "pending" || p.state === "edited",
  ).length;
}

function renderActionBar() {
  const root = getActionBarRoot();
  const drawer = root.querySelector("#action-bar-drawer") as HTMLElement;
  const drawerInner = root.querySelector("#action-bar-drawer-inner") as HTMLElement;
  const handle = root.querySelector("#action-bar-handle") as HTMLButtonElement;
  const badge = root.querySelector("#action-bar-badge") as HTMLElement;
  const chevron = root.querySelector("#action-bar-chevron") as HTMLElement;
  const label = root.querySelector(".action-bar-label") as HTMLElement;

  const live = liveProposals();
  const pend = pendingCount();
  badge.textContent = String(pend);
  badge.setAttribute("data-count", String(pend));
  handle.classList.toggle("has-pending", pend > 0);
  chevron.textContent = actionBarOpen ? "▼" : "▲";
  handle.setAttribute("aria-expanded", actionBarOpen ? "true" : "false");
  drawer.classList.toggle("open", actionBarOpen);
  drawer.setAttribute("aria-hidden", actionBarOpen ? "false" : "true");

  // Collapsed → bottom-right pill showing just the count; Expanded → full-width drawer (#71).
  root.classList.toggle("expanded", actionBarOpen);
  root.classList.toggle("collapsed", !actionBarOpen);
  if (label) label.textContent = actionBarOpen ? "Action Bar" : "⚡";
  const pillTitle = `${pend} pending proposal${pend === 1 ? "" : "s"} — click to open Action Bar`;
  handle.setAttribute("title", actionBarOpen ? "Collapse Action Bar" : pillTitle);

  if (!actionBarOpen) return;

  if (live.length === 0) {
    drawerInner.innerHTML = `<div class="action-bar-empty">No live proposals yet. They will appear here as the bot listens.</div>`;
    return;
  }

  drawerInner.innerHTML = live.map(renderProposalCard).join("");
  wireProposalCards(drawerInner);
}

function actionTypeLabel(t: ProposalActionType): string {
  switch (t) {
    case "close_issue": return "Close issue";
    case "reopen_issue": return "Reopen issue";
    case "comment": return "Comment";
    case "reassign": return "Reassign";
    case "set_labels": return "Labels";
    case "backlog": return "Backlog";
    case "create_issue": return "Create issue";
  }
}

function renderProposalCard(p: ProposalWire): string {
  const locked = p.state === "affirmed" || p.state === "executed" || p.state === "failed";
  const inFlight = proposalInFlight.has(p.id) || p.state === "affirmed";
  const err = proposalErrors.get(p.id);
  const execUrl = p.executionResult?.url;
  const execErr = p.executionResult?.error;
  // Freshly-transitioned locked cards are auto-added to expandedProposals in
  // the upsert handler so the result is visible; the user can then collapse.
  const expanded = expandedProposals.has(p.id);

  let status = "";
  if (p.state === "executed") {
    status = `<span class="proposal-status ok">✓ Executed${execUrl ? ` <a href="${escapeHtml(execUrl)}" target="_blank">↗</a>` : ""}</span>`;
  } else if (p.state === "failed") {
    status = `<span class="proposal-status err">✗ ${escapeHtml(execErr ?? "Failed")}</span>`;
  } else if (err) {
    status = `<span class="proposal-status err">${escapeHtml(err)}</span>`;
  } else if (inFlight) {
    status = `<span class="proposal-status">Running…</span>`;
  } else if (p.state === "edited") {
    status = `<span class="proposal-status">Edited</span>`;
  }

  const summary = proposalSummary(p);
  const chevron = expanded ? "▾" : "▸";
  const affirmBtn = locked
    ? ""
    : `<button class="proposal-btn proposal-btn-primary" data-action="affirm" ${inFlight ? "disabled" : ""}>Affirm</button>`;
  const dismissBtn = locked
    ? ""
    : `<button class="proposal-dismiss" data-action="dismiss" title="Dismiss">×</button>`;

  const targetLink =
    p.targetIssue != null
      ? `<a class="proposal-target-link" href="https://github.com/${escapeHtml(p.repo)}/issues/${p.targetIssue}" target="_blank" rel="noopener">#${p.targetIssue}</a>`
      : "";
  const targetTitle =
    p.targetIssue != null
      ? (findIssue(p.targetIssue)?.title ?? "")
      : "";
  const targetTitleSpan = targetTitle
    ? `<span class="proposal-target-title" title="${escapeHtml(targetTitle)}">${escapeHtml(targetTitle)}</span>`
    : "";

  return `
    <div class="proposal-card state-${p.state}" data-proposal-id="${p.id}" data-version="${p.version}" data-locked="${locked ? 1 : 0}" data-expanded="${expanded ? 1 : 0}">
      <div class="proposal-summary" data-action="toggle">
        <span class="proposal-chevron">${chevron}</span>
        <span class="proposal-type">${escapeHtml(actionTypeLabel(p.actionType))}</span>
        ${targetLink}
        ${targetTitleSpan}
        <span class="proposal-summary-text">${escapeHtml(summary)}</span>
        <span class="proposal-summary-spacer"></span>
        ${status}
        ${affirmBtn}
        ${dismissBtn}
      </div>
      <div class="proposal-body">
        ${p.payload.reasoning ? `<div class="proposal-reasoning">${escapeHtml(p.payload.reasoning)}</div>` : ""}
        ${renderProposalBody(p)}
      </div>
    </div>
  `;
}

/** One-line human-readable preview of a proposal's payload. The target issue
 *  number is rendered separately as a link in renderProposalCard — don't
 *  prefix it here. */
function proposalSummary(p: ProposalWire): string {
  const pay = p.payload;
  switch (p.actionType) {
    case "close_issue":
      return pay.reason === "not_planned" ? "(not planned)" : "";
    case "reopen_issue":
      return "";
    case "comment": {
      const body = (pay.body ?? "").replace(/\s+/g, " ").trim();
      return body.length > 90 ? body.slice(0, 90) + "…" : body;
    }
    case "reassign": {
      const who = (pay.assignees ?? []).map((a) => "@" + a).join(", ");
      return `→ ${who || "(none)"}`;
    }
    case "set_labels": {
      const adds = (pay.addLabels ?? []).map((l) => "+" + l);
      const removes = (pay.removeLabels ?? []).map((l) => "−" + l);
      return [...adds, ...removes].join(", ") || "(no changes)";
    }
    case "backlog":
      return "";
    case "create_issue":
      return pay.title ? pay.title : "(untitled)";
  }
}

function renderProposalBody(p: ProposalWire): string {
  const pay = p.payload;
  switch (p.actionType) {
    case "close_issue":
      return `
        <div class="proposal-field">
          <label>Reason</label>
          <select data-field="reason">
            <option value="completed" ${pay.reason !== "not_planned" ? "selected" : ""}>Completed</option>
            <option value="not_planned" ${pay.reason === "not_planned" ? "selected" : ""}>Not planned</option>
          </select>
        </div>`;
    case "reopen_issue":
      return "";
    case "comment":
      return `
        <div class="proposal-field">
          <label>Comment</label>
          <textarea data-field="body">${escapeHtml(pay.body ?? "")}</textarea>
        </div>`;
    case "reassign":
      return `
        <div class="proposal-field">
          <label>Assignees (comma-separated GitHub logins)</label>
          <input type="text" data-field="assignees" value="${escapeHtml((pay.assignees ?? []).join(", "))}">
        </div>`;
    case "set_labels":
      return `
        <div class="proposal-field">
          <label>Add labels (comma-separated)</label>
          <input type="text" data-field="addLabels" value="${escapeHtml((pay.addLabels ?? []).join(", "))}">
        </div>
        <div class="proposal-field">
          <label>Remove labels (comma-separated)</label>
          <input type="text" data-field="removeLabels" value="${escapeHtml((pay.removeLabels ?? []).join(", "))}">
        </div>`;
    case "backlog":
      return "";
    case "create_issue":
      return `
        <div class="proposal-field">
          <label>Title</label>
          <input type="text" data-field="title" value="${escapeHtml(pay.title ?? "")}">
        </div>
        <div class="proposal-field">
          <label>Body</label>
          <textarea data-field="newBody">${escapeHtml(pay.newBody ?? "")}</textarea>
        </div>
        <div class="proposal-field">
          <label>Assignees (comma-separated GitHub logins)</label>
          <input type="text" data-field="newAssignees" value="${escapeHtml((pay.newAssignees ?? []).join(", "))}">
        </div>`;
  }
}

function readProposalPayloadFromCard(card: HTMLElement, p: ProposalWire): ProposalPayload {
  const out: ProposalPayload = { ...p.payload };
  const field = (name: string): string | null => {
    const el = card.querySelector(`[data-field="${name}"]`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    return el ? el.value : null;
  };
  const csv = (v: string | null): string[] =>
    (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  switch (p.actionType) {
    case "close_issue": {
      const r = field("reason");
      if (r === "not_planned" || r === "completed") out.reason = r;
      break;
    }
    case "comment": {
      const b = field("body");
      if (b !== null) out.body = b;
      break;
    }
    case "reassign": {
      const v = field("assignees");
      if (v !== null) out.assignees = csv(v);
      break;
    }
    case "set_labels": {
      const a = field("addLabels");
      const r = field("removeLabels");
      if (a !== null) out.addLabels = csv(a);
      if (r !== null) out.removeLabels = csv(r);
      break;
    }
    case "create_issue": {
      const t = field("title");
      const b = field("newBody");
      const a = field("newAssignees");
      if (t !== null) out.title = t;
      if (b !== null) out.newBody = b;
      if (a !== null) out.newAssignees = csv(a);
      break;
    }
  }
  return out;
}

function payloadEqual(a: ProposalPayload, b: ProposalPayload): boolean {
  return JSON.stringify(normalizeForCompare(a)) === JSON.stringify(normalizeForCompare(b));
}

function normalizeForCompare(p: ProposalPayload): ProposalPayload {
  const out: ProposalPayload = {};
  if (p.reason !== undefined) out.reason = p.reason;
  if (p.body !== undefined) out.body = p.body;
  if (p.assignees !== undefined) out.assignees = [...p.assignees].sort();
  if (p.addLabels !== undefined) out.addLabels = [...p.addLabels].sort();
  if (p.removeLabels !== undefined) out.removeLabels = [...p.removeLabels].sort();
  if (p.title !== undefined) out.title = p.title;
  if (p.newBody !== undefined) out.newBody = p.newBody;
  if (p.newAssignees !== undefined) out.newAssignees = [...p.newAssignees].sort();
  return out;
}

function wireProposalCards(container: HTMLElement) {
  container.querySelectorAll(".proposal-card").forEach((cardEl) => {
    const card = cardEl as HTMLElement;
    const idStr = card.getAttribute("data-proposal-id");
    if (!idStr) return;
    const id = parseInt(idStr);
    const p = proposals.find((x) => x.id === id);
    if (!p) return;

    // Inline edits fire on blur — avoid thrashing WS on each keystroke.
    card.querySelectorAll("[data-field]").forEach((el) => {
      el.addEventListener("blur", () => {
        const fresh = readProposalPayloadFromCard(card, p);
        if (!payloadEqual(fresh, p.payload)) {
          sendWs({ type: "proposal-edit", id, version: p.version, payload: fresh });
        }
      });
    });

    const summary = card.querySelector('[data-action="toggle"]') as HTMLElement | null;
    if (summary) {
      summary.addEventListener("click", (e) => {
        // Ignore clicks that land on an interactive child (buttons, links).
        const t = e.target as HTMLElement;
        if (t.closest("button") || t.closest("a")) return;
        if (expandedProposals.has(id)) expandedProposals.delete(id);
        else expandedProposals.add(id);
        renderActionBar();
      });
    }

    const affirmBtn = card.querySelector('[data-action="affirm"]') as HTMLButtonElement | null;
    if (affirmBtn) {
      affirmBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        // Flush any pending edit before affirming.
        const fresh = readProposalPayloadFromCard(card, p);
        if (!payloadEqual(fresh, p.payload)) {
          sendWs({ type: "proposal-edit", id, version: p.version, payload: fresh });
          // Defer affirm a tick so server processes the edit first and bumps version.
          proposalInFlight.add(id);
          renderActionBar();
          setTimeout(() => {
            const latest = proposals.find((x) => x.id === id);
            if (latest) sendWs({ type: "proposal-affirm", id, version: latest.version });
          }, 250);
          return;
        }
        proposalInFlight.add(id);
        renderActionBar();
        sendWs({ type: "proposal-affirm", id, version: p.version });
      });
    }

    const dismissBtn = card.querySelector('[data-action="dismiss"]') as HTMLButtonElement | null;
    if (dismissBtn) {
      dismissBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        sendWs({ type: "proposal-dismiss", id });
      });
    }
  });
}

// ── Start ───────────────────────────────────────────────────────────────────

init();

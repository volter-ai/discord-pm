/**
 * Main bot class — sets up the Discord client, registers slash commands,
 * and handles /standup start | stop | status | history and /review.
 *
 * Utterances are transcribed incrementally as speakers finish talking,
 * keeping memory usage low even during long meetings.
 */

import {
  Client,
  GatewayIntentBits,
  Interaction,
  VoiceChannel,
  EmbedBuilder,
  Colors,
  REST,
  Routes,
  InviteTargetType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { Recorder, type Utterance } from "./recorder";
import { Transcriber } from "./transcriber";
import { Summarizer } from "./summarizer";
import {
  StandupStore,
  type UtteranceSegment,
  type Proposal,
  type ProposalPayload,
  type ProposalTriggerReason,
  type StandupRecord,
} from "./store";
import { STANDUPS, STANDUP_NAMES, buildStepEmbed } from "./review";
import { ProposalGenerator } from "./proposals";
import {
  closeIssue,
  reopenIssue,
  createComment,
  createIssue,
  assignIssue,
  setLabels,
} from "./github";
import { USERS } from "./users";

const GUILD_ID = process.env.DISCORD_GUILD_ID ?? "1219420218233847878";

/** Max concurrent transcription API calls to avoid rate limits + memory spikes. */
const MAX_CONCURRENT_TRANSCRIPTIONS = 3;

/** Network-safe projection of a Proposal for the Activity WebSocket. */
export function serializeProposal(p: Proposal) {
  return {
    id: p.id,
    standupId: p.standup_id,
    createdAt: p.created_at,
    triggerReason: p.trigger_reason,
    focusedIssue: p.focused_issue,
    actionType: p.action_type,
    repo: p.repo,
    targetIssue: p.target_issue,
    payload: p.payload,
    originalPayload: p.original_payload,
    state: p.state,
    version: p.version,
    executedAt: p.executed_at,
    executedBy: p.executed_by,
    executionResult: p.execution_result,
    supersededBy: p.superseded_by,
  };
}

interface TranscribedLine {
  speaker: string;
  userId: string;
  text: string;
  startedAt: number;
  /** GitHub issue # that was focused in the Activity when this was spoken. */
  issueNumber: number | null;
}

interface SessionMeta {
  guildId: string;
  type: "standup" | "meeting";
  startedAt: Date;
  channelId: string;
  /** Text channel ID stored at start — used to post results when interaction token expires. */
  textChannelId: string;
  /** Lines transcribed incrementally during the meeting. */
  lines: TranscribedLine[];
  /** Number of transcriptions currently in-flight. */
  inflight: number;
  /** Queued utterances waiting for a concurrency slot. */
  queue: Utterance[];
  /** Resolves when the queue is fully drained (used at stop time). */
  drainPromise: Promise<void> | null;
  drainResolve: (() => void) | null;

  // ── Activity state ──
  /** GitHub issue # currently focused in the Activity UI. */
  focusedIssue: number | null;
  /** Discord user ID of who has presenter controls. */
  presenter: string | null;
  /** Which participant tab is active in the Activity UI (index into standup steps). */
  activeParticipantIndex: number;
  /** Connected Activity WebSocket clients. */
  activityClients: Set<any>;
  /** Map of connected userId → display name for presence info. */
  connectedUsers: Map<string, string>;
  /**
   * Map of Discord user IDs → display names for everyone currently in the
   * voice channel. Seeded at session start from voiceChannel.members,
   * kept fresh via voiceStateUpdate. Used by the Activity to mark
   * GitHub-assigned people "not present" if they never joined the call.
   */
  voiceMembers: Map<string, string>;
  /** Issue number currently open in the detail panel, or null. */
  focusedDetailIssue: number | null;
  /** Repo string for issue-aware transcripts (e.g. "volter-ai/runhuman"). */
  issueRepo: string | null;
  /** Whether an Activity client was ever connected during this session. */
  hadActivity: boolean;
  /** Cached issue metadata (title + state) keyed by issue number. */
  issueMeta: Map<number, { title: string; state: string }>;
  /** For standups: pre-inserted standups.id so live proposals (#53) can FK it.
   *  Null for meetings and sessions that pre-date the lifecycle change. */
  standupId: number | null;
  /** Live-proposal trigger state (#53). Null for meetings. */
  proposalTrigger: {
    lastEvalAtByIssue: Map<number, number>;
    lastSegmentCountByIssue: Map<number, number>;
    evalInFlight: Set<number>;
    /** Per-issue last generated proposals — lets the generator supersede its
     *  own outputs instead of duplicating on re-eval. */
    activeByIssue: Map<number, number[]>;
  } | null;
  /** Fallback-60s scanner interval handle (cleared at stop). */
  proposalFallbackTimer: ReturnType<typeof setInterval> | null;
}

/** Drain timeout: 5 minutes max wait for transcriptions after stop. */
const DRAIN_TIMEOUT_MS = 300_000;

/** Min gap between proposal evaluations for the same issue. Prevents rapid-fire
 *  calls when users browse the board. */
const PROPOSAL_MIN_DEBOUNCE_MS = 8_000;
/** Fallback eval cadence: re-evaluate any focused issue whose eval is older than
 *  this threshold (handles long monologues on one issue). */
const PROPOSAL_FALLBACK_STALE_MS = 60_000;
/** Chris's always-affirm admin Discord ID (from src/users.ts USERS.careid). */
const ADMIN_DISCORD_ID = "913513159329980447";
/** Map sentinel for the "general discussion" proposal bucket (focusedIssue=null). */
const GENERAL_BUCKET_KEY = -1;

export class StandupBot {
  private client: Client;
  private recorder = new Recorder();
  private transcriber = new Transcriber();
  private summarizer: Summarizer;
  private store = new StandupStore();
  private proposalGenerator: ProposalGenerator | null = null;
  private activeSessions = new Map<string, SessionMeta>();
  /** Guards against concurrent finishRecording calls for the same guild. */
  private stoppingGuilds = new Set<string>();

  constructor() {
    this.summarizer = new Summarizer(process.env.ANTHROPIC_API_KEY!);
    if (process.env.ANTHROPIC_API_KEY) {
      this.proposalGenerator = new ProposalGenerator(process.env.ANTHROPIC_API_KEY);
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
      ],
    });

    this.client.once("clientReady", async () => {
      console.log(`[bot] Logged in as ${this.client.user?.tag}`);
      await this.registerCommands();
      await this.resumeActiveSessions().catch((e) =>
        console.error("[bot] resumeActiveSessions crashed:", e),
      );
    });

    this.client.on("interactionCreate", (i) => this.handleInteraction(i));
    this.client.on("voiceStateUpdate", (oldState, newState) => {
      this.handleVoiceStateUpdate(oldState, newState);
    });
  }

  /**
   * Keep each active session's voiceMembers map in sync with the voice channel.
   * Broadcasts the updated state so Activity tabs can re-evaluate "not present".
   */
  private handleVoiceStateUpdate(oldState: any, newState: any) {
    const guildId = newState.guild?.id ?? oldState.guild?.id;
    if (!guildId) return;
    const session = this.activeSessions.get(guildId);
    if (!session) return;

    const userId: string | undefined = newState.id ?? oldState.id;
    if (!userId) return;

    const joinedThisChannel = newState.channelId === session.channelId;
    const leftThisChannel =
      oldState.channelId === session.channelId && newState.channelId !== session.channelId;

    let changed = false;
    if (joinedThisChannel) {
      const name =
        newState.member?.displayName ?? newState.member?.user?.username ?? userId;
      if (session.voiceMembers.get(userId) !== name) {
        session.voiceMembers.set(userId, name);
        changed = true;
      }
    } else if (leftThisChannel) {
      if (session.voiceMembers.delete(userId)) changed = true;
    }

    if (changed) this.broadcastActivityState(guildId);
  }

  /** Seed voiceMembers from the current voice channel membership. */
  private snapshotVoiceMembers(session: SessionMeta, voiceChannel: VoiceChannel) {
    session.voiceMembers.clear();
    for (const [id, member] of voiceChannel.members) {
      if (member.user.bot) continue;
      session.voiceMembers.set(id, member.displayName ?? member.user.username ?? id);
    }
  }

  async start(token: string) {
    await this.client.login(token);
  }

  // ── Activity integration ────────────────────────────────────────────────

  /** Get the first active recording session (used by Activity to connect). */
  getFirstActiveSession(): { guildId: string; meta: SessionMeta } | null {
    for (const [guildId, meta] of this.activeSessions) {
      return { guildId, meta };
    }
    return null;
  }

  /** Resolve a channel's display name via Discord API. Used by the Activity
   *  picker to map voice channel → suggested standup. Returns null if the
   *  channel can't be fetched (unknown ID, permissions, bot not ready). */
  async getChannelName(channelId: string): Promise<string | null> {
    try {
      const channel = await this.client.channels.fetch(channelId).catch(() => null);
      if (!channel) return null;
      const name = (channel as any).name;
      return typeof name === "string" ? name : null;
    } catch {
      return null;
    }
  }

  /** Summary of in-memory sessions that would be lost on restart. Review
   *  walkthroughs are state-free (encoded in Discord button customIds) and
   *  are not reported here. */
  getActiveSessionsInfo(): {
    sessions: Array<{
      guildId: string;
      type: "standup" | "meeting";
      channelId: string;
      startedAt: string;
      lineCount: number;
    }>;
  } {
    const sessions = [...this.activeSessions.entries()].map(([guildId, meta]) => ({
      guildId,
      type: meta.type,
      channelId: meta.channelId,
      startedAt: meta.startedAt.toISOString(),
      lineCount: meta.lines.length,
    }));
    return { sessions };
  }

  /** Register an Activity WebSocket client for a guild session. */
  addActivityClient(guildId: string, ws: any, userId: string | null, username: string | null) {
    const session = this.activeSessions.get(guildId);
    if (session) {
      session.activityClients.add(ws);
      if (userId && username) session.connectedUsers.set(userId, username);
      session.hadActivity = true;
      console.log(`[bot] Activity client added (${session.activityClients.size} total)`);
      this.broadcastActivityState(guildId);
    }
  }

  /** Remove a connected user from presence tracking. */
  removeActivityUser(guildId: string, userId: string) {
    const session = this.activeSessions.get(guildId);
    if (session) {
      session.connectedUsers.delete(userId);
      this.broadcastActivityState(guildId);
    }
  }

  /** Bind the GitHub repo for this session's proposals. Called from the
   *  Activity's `ready` handler so the proposal generator knows what repo to
   *  target even before any issue gets focused. */
  setIssueRepo(guildId: string, repo: string) {
    const session = this.activeSessions.get(guildId);
    if (!session) return;
    if (session.issueRepo === repo) return;
    session.issueRepo = repo;
    this.store.updateActiveSessionState(guildId, { issue_repo: repo });
    console.log(`[bot] Session ${guildId} issueRepo set → ${repo}`);
  }

  /** Set the detail panel issue from Activity. Broadcasts state to all clients. */
  setDetailPanel(guildId: string, issueNumber: number | null) {
    const session = this.activeSessions.get(guildId);
    if (session) {
      session.focusedDetailIssue = issueNumber;
      this.store.updateActiveSessionState(guildId, { focused_detail_issue: issueNumber });
      this.broadcastActivityState(guildId);
    }
  }

  /** Relay a scroll position from the presenter to all connected Activity clients. */
  relayScroll(guildId: string, scrollY: number) {
    this.broadcastToActivity(guildId, { type: "scroll", scrollY });
  }

  /** Relay a detail panel scroll position from the presenter to all connected Activity clients. */
  relayDetailScroll(guildId: string, scrollTop: number) {
    this.broadcastToActivity(guildId, { type: "detailScroll", scrollTop });
  }

  /** Remove a specific Activity WebSocket client by reference. */
  removeActivityClient(guildId: string, ws: any) {
    const session = this.activeSessions.get(guildId);
    if (session) {
      session.activityClients.delete(ws);
    }
  }

  /** Set the currently focused issue from Activity. Broadcasts state to all clients. */
  setFocusedIssue(guildId: string, issueNumber: number | null, issueTitle?: string, issueState?: string) {
    const session = this.activeSessions.get(guildId);
    if (session) {
      const outgoingIssue = session.focusedIssue;
      session.focusedIssue = issueNumber;
      if (issueNumber && issueTitle) {
        const state = issueState ?? "open";
        session.issueMeta.set(issueNumber, { title: issueTitle, state });
        this.store.upsertActiveSessionIssueMeta(guildId, { issue_number: issueNumber, title: issueTitle, state });
      }
      this.store.updateActiveSessionState(guildId, { focused_issue: issueNumber });
      this.broadcastActivityState(guildId);
      // Eval the OUTGOING bucket's proposals before switching context.
      // Null bucket (general discussion) is valid too.
      if (outgoingIssue !== issueNumber) {
        this.maybeEvaluateProposals(session, outgoingIssue, "focus_change");
      }
    }
  }

  /** Set the active participant tab index from Activity. Broadcasts state to all clients. */
  setActiveTab(guildId: string, participantIndex: number) {
    const session = this.activeSessions.get(guildId);
    if (session) {
      session.activeParticipantIndex = participantIndex;
      this.store.updateActiveSessionState(guildId, { active_participant_index: participantIndex });
      this.broadcastActivityState(guildId);
    }
  }

  /** Clear the presenter if the disconnecting client was the one holding the role. */
  clearPresenterIfDisconnected(guildId: string, userId: string | null) {
    const session = this.activeSessions.get(guildId);
    if (session && userId && session.presenter === userId) {
      session.presenter = null;
      this.store.updateActiveSessionState(guildId, { presenter: null });
      this.broadcastActivityState(guildId);
      console.log(`[bot] Presenter ${userId} disconnected — presenter role cleared`);
    }
  }

  /** Set the current presenter from Activity. Broadcasts state so all clients learn the new presenter. */
  setPresenter(guildId: string, userId: string) {
    const session = this.activeSessions.get(guildId);
    if (session) {
      session.presenter = userId;
      this.store.updateActiveSessionState(guildId, { presenter: userId });
      this.broadcastActivityState(guildId);
    }
  }

  /** Broadcast current session state to all connected Activity clients. */
  private broadcastActivityState(guildId: string) {
    const session = this.activeSessions.get(guildId);
    if (!session) return;
    const presenterName = session.presenter ? (session.connectedUsers.get(session.presenter) ?? null) : null;
    const watcherNames = [...session.connectedUsers.entries()]
      .filter(([userId]) => userId !== session.presenter)
      .map(([, name]) => name);
    const voiceMembers = [...session.voiceMembers.entries()].map(([id, name]) => ({ id, name }));
    this.broadcastToActivity(guildId, {
      type: "state",
      focusedIssue: session.focusedIssue,
      focusedDetailIssue: session.focusedDetailIssue,
      presenter: session.presenter,
      presenterName,
      watcherNames,
      voiceMembers,
      activeParticipantIndex: session.activeParticipantIndex,
      recording: true,
      elapsed: Math.round((Date.now() - session.startedAt.getTime()) / 1000),
      utteranceCount: session.lines.length,
    });
  }

  /** Broadcast a message to the clients of a specific session (used by the
   *  old session's in-flight drain to avoid bleeding into a newer session
   *  that has taken over the guildId slot). */
  private broadcastToSession(session: SessionMeta, message: object) {
    const json = JSON.stringify(message);
    const closed: any[] = [];

    for (const ws of session.activityClients) {
      if (ws.readyState !== undefined && ws.readyState !== 1 /* OPEN */) {
        closed.push(ws);
        continue;
      }
      try {
        ws.send(json);
      } catch {
        closed.push(ws);
      }
    }

    for (const ws of closed) {
      session.activityClients.delete(ws);
    }
  }

  /** Broadcast to the CURRENT session of a guild. External API setters
   *  (setFocusedIssue, setActiveTab, …) call this so the message reaches
   *  whichever session owns the guildId slot right now. */
  private broadcastToActivity(guildId: string, message: object) {
    const session = this.activeSessions.get(guildId);
    if (!session) return;
    this.broadcastToSession(session, message);
  }

  // ── Command registration ───────────────────────────────────────────────

  private async registerCommands() {
    const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
      {
        name: "standup",
        description: "Standup meeting commands",
        options: [
          {
            type: 1,
            name: "start",
            description: "Join your voice channel and start recording the standup",
          },
          {
            type: 1,
            name: "stop",
            description: "Stop recording, transcribe, and post a summary",
          },
          {
            type: 1,
            name: "status",
            description: "Show whether a standup is currently being recorded",
          },
          {
            type: 1,
            name: "history",
            description: "Show recent standup summaries",
            options: [
              {
                type: 4,
                name: "count",
                description: "Number of recent standups to show (default 5, max 10)",
                required: false,
                min_value: 1,
                max_value: 10,
              },
            ],
          },
        ],
      },
      {
        name: "meeting",
        description: "Meeting transcription commands",
        options: [
          {
            type: 1,
            name: "start",
            description: "Join your voice channel and start recording a meeting",
          },
          {
            type: 1,
            name: "stop",
            description: "Stop recording, transcribe, and post a summary",
          },
        ],
      },
      {
        name: "review",
        description: "Walk through GitHub Issues for a standup",
        options: [
          {
            type: 3, // STRING
            name: "standup",
            description: "Which standup to review",
            required: true,
            choices: STANDUP_NAMES.map((name) => ({ name, value: name })),
          },
        ],
      },
    ];

    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN!);
    await rest.put(Routes.applicationGuildCommands(this.client.user!.id, GUILD_ID), {
      body: commands,
    });
    console.log("[bot] Slash commands synced to guild.");
  }

  private async handleInteraction(interaction: Interaction) {
    try {
      await this._handleInteractionInner(interaction);
    } catch (e: any) {
      console.error("[bot] Unhandled interaction error:", e);
      try {
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "An internal error occurred.", ephemeral: true });
        }
      } catch { /* best-effort */ }
    }
  }

  private async _handleInteractionInner(interaction: Interaction) {
    // Button interactions (review:next, review:done)
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith("review:")) {
        await this.handleReviewButton(interaction);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    // Guard: guild-only commands (guildId is always present for guild commands, but be defensive)
    if (!interaction.guildId) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }

    if (interaction.commandName === "standup") {
      const sub = interaction.options.getSubcommand();
      if (sub === "start") await this.handleStart(interaction);
      else if (sub === "stop") await this.handleStop(interaction);
      else if (sub === "status") await this.handleStatus(interaction);
      else if (sub === "history") await this.handleHistory(interaction);
    } else if (interaction.commandName === "meeting") {
      const sub = interaction.options.getSubcommand();
      if (sub === "start") await this.handleMeetingStart(interaction);
      else if (sub === "stop") await this.handleMeetingStop(interaction);
    } else if (interaction.commandName === "review") {
      await this.handleReview(interaction);
    }
  }

  // ── Resume after restart ───────────────────────────────────────────────

  /** Rehydrate in-memory sessions that were persisted before the last
   *  process restart. Rejoins the voice channel and continues recording
   *  into the same DB row (resumed_count is bumped). Stale rows whose
   *  voice channel is gone or empty are deleted. */
  private async resumeActiveSessions() {
    const rows = this.store.listActiveSessions();
    if (rows.length === 0) return;
    console.log(`[bot] Resuming ${rows.length} active session(s) from disk…`);

    for (const row of rows) {
      try {
        const guild = await this.client.guilds.fetch(row.guild_id).catch(() => null);
        if (!guild) {
          console.warn(`[bot] Resume: guild ${row.guild_id} not accessible — dropping row.`);
          this.store.deleteActiveSession(row.guild_id, row.started_at);
          continue;
        }

        const channel = await guild.channels.fetch(row.channel_id).catch(() => null);
        const voiceChannel = channel && "members" in channel ? (channel as VoiceChannel) : null;
        if (!voiceChannel) {
          console.warn(`[bot] Resume: voice channel ${row.channel_id} gone — dropping row.`);
          this.store.deleteActiveSession(row.guild_id, row.started_at);
          continue;
        }

        const humans = [...voiceChannel.members.values()].filter((m) => !m.user.bot);
        if (humans.length === 0) {
          console.log(`[bot] Resume: voice channel is empty — session ended while down. Dropping row.`);
          this.store.deleteActiveSession(row.guild_id, row.started_at);
          continue;
        }

        const textChannel = await this.client.channels
          .fetch(row.text_channel_id)
          .catch(() => null);

        const session: SessionMeta = {
          guildId: row.guild_id,
          type: row.type,
          startedAt: new Date(row.started_at),
          channelId: row.channel_id,
          textChannelId: row.text_channel_id,
          lines: [],
          inflight: 0,
          queue: [],
          drainPromise: null,
          drainResolve: null,
          focusedIssue: row.focused_issue,
          presenter: row.presenter,
          activeParticipantIndex: row.active_participant_index,
          activityClients: new Set(),
          connectedUsers: new Map(),
          voiceMembers: new Map(),
          focusedDetailIssue: row.focused_detail_issue,
          issueRepo: row.issue_repo,
          hadActivity: false,
          issueMeta: new Map(),
          standupId: row.standup_id,
          proposalTrigger: row.type === "standup" && row.standup_id != null ? {
            lastEvalAtByIssue: new Map(),
            lastSegmentCountByIssue: new Map(),
            evalInFlight: new Set(),
            activeByIssue: new Map(),
          } : null,
          proposalFallbackTimer: null,
        };
        for (const l of this.store.getActiveSessionLines(row.guild_id, row.started_at)) {
          session.lines.push({
            speaker: l.speaker,
            userId: l.user_id,
            text: l.text,
            startedAt: l.started_at,
            issueNumber: l.issue_number,
          });
        }
        for (const m of this.store.getActiveSessionIssueMeta(row.guild_id)) {
          session.issueMeta.set(m.issue_number, { title: m.title, state: m.state });
        }
        this.activeSessions.set(row.guild_id, session);
        this.snapshotVoiceMembers(session, voiceChannel);

        // Synthetic interaction used by auto-stop paths — no followUp, just
        // a channel reference so summary/banner messages can fall through
        // to textChannelId-based posting.
        const resumedShim: any = {
          guildId: row.guild_id,
          channelId: row.text_channel_id,
          channel: textChannel,
        };

        await this.recorder.start(voiceChannel, {
          onUtterance: (u) => this.enqueueUtterance(session, u),
          onTimeout: () => {
            console.warn("[bot] Auto-stop triggered by timeout (resumed session).");
            this.autoStop(resumedShim, row.guild_id);
          },
          onDisconnect: (reason) => {
            console.error(`[bot] Voice disconnected (resumed session): ${reason}`);
            this.autoStop(resumedShim, row.guild_id);
          },
          onSpeakingChange: (userId, displayName, speaking) => {
            this.broadcastToActivity(row.guild_id, {
              type: "speaker",
              userId,
              name: displayName,
              speaking,
            });
            this.onSpeakerChangeForProposals(session, userId, speaking);
          },
        });
        this.startProposalFallbackTimer(session);

        this.store.saveActiveSession({ ...row, resumed_count: row.resumed_count + 1 });

        const elapsedMin = Math.round((Date.now() - session.startedAt.getTime()) / 60_000);
        const kind = row.type === "meeting" ? "meeting" : "standup";
        const banner =
          `🔄 Recording resumed in **${voiceChannel.name}** after restart ` +
          `(${elapsedMin}m elapsed, ${session.lines.length} lines preserved). ` +
          `A few seconds of audio may have been lost. Use \`/${kind} stop\` when done.`;
        if (textChannel && "send" in textChannel) {
          try { await (textChannel as any).send(banner); } catch { /* best-effort */ }
        }
        console.log(`[bot] Resumed ${row.type} session for guild ${row.guild_id}.`);
      } catch (e: any) {
        console.error(`[bot] Resume failed for guild ${row.guild_id}:`, e.message);
        this.activeSessions.delete(row.guild_id);
        this.store.deleteActiveSession(row.guild_id, row.started_at);
      }
    }
  }

  // ── Session persistence helpers ────────────────────────────────────────

  private persistSessionStart(guildId: string, session: SessionMeta) {
    this.store.saveActiveSession({
      guild_id: guildId,
      type: session.type,
      channel_id: session.channelId,
      text_channel_id: session.textChannelId,
      started_at: session.startedAt.toISOString(),
      issue_repo: session.issueRepo,
      focused_issue: session.focusedIssue,
      focused_detail_issue: session.focusedDetailIssue,
      presenter: session.presenter,
      active_participant_index: session.activeParticipantIndex,
      resumed_count: 0,
      standup_id: session.standupId,
    });
  }

  // ── Concurrency-limited transcription queue ────────────────────────────
  //
  // The pipeline operates on a SessionMeta reference captured at start time,
  // NOT on a guildId lookup. This keeps an in-progress drain after a
  // `/standup stop` correctly scoped to the old session even if a new
  // session for the same guild has been registered in the activeSessions
  // map (see #58).

  private enqueueUtterance(session: SessionMeta, utterance: Utterance) {
    session.queue.push(utterance);
    this.drainQueue(session);
  }

  private drainQueue(session: SessionMeta) {
    while (session.inflight < MAX_CONCURRENT_TRANSCRIPTIONS && session.queue.length > 0) {
      const utterance = session.queue.shift()!;
      session.inflight++;
      this.transcribeOne(session, utterance).finally(() => {
        session.inflight--;
        this.drainQueue(session);
        if (session.inflight === 0 && session.queue.length === 0 && session.drainResolve) {
          session.drainResolve();
          session.drainResolve = null;
          session.drainPromise = null;
        }
      });
    }
  }

  private async transcribeOne(session: SessionMeta, utterance: Utterance) {
    const issueAtTime = session.focusedIssue;

    try {
      const mono = Recorder.toMono16k(utterance.pcmSamples);
      const durationSec = (mono.length / 16000).toFixed(2);
      console.log(`[bot] Transcribing ${utterance.member.displayName} utterance: ${mono.length} samples (${durationSec}s)`);

      const text = await this.transcriber.transcribe(mono);
      console.log(`[bot] → "${text.slice(0, 100)}"`);

      if (text.trim()) {
        const line: TranscribedLine = {
          speaker: utterance.member.displayName,
          userId: utterance.userId,
          text: text.trim(),
          startedAt: utterance.startedAt,
          issueNumber: issueAtTime,
        };
        session.lines.push(line);
        this.store.appendActiveSessionLine(session.guildId, session.startedAt.toISOString(), {
          speaker: line.speaker,
          user_id: line.userId,
          text: line.text,
          started_at: line.startedAt,
          issue_number: line.issueNumber,
        });

        this.broadcastToSession(session, {
          type: "utterance",
          speaker: line.speaker,
          issueNumber: line.issueNumber,
          text: line.text,
          startedAt: line.startedAt,
        });
      }
    } catch (e: any) {
      console.error(`[bot] Transcription error for ${utterance.member.displayName}:`, e.message);
    }
    // PCM data is now unreferenced → eligible for GC
  }

  /** Wait for all queued and in-flight transcriptions to finish. */
  private waitForDrain(session: SessionMeta): Promise<void> {
    if (session.inflight === 0 && session.queue.length === 0) return Promise.resolve();

    if (!session.drainPromise) {
      session.drainPromise = new Promise<void>((resolve) => {
        session.drainResolve = resolve;
      });
    }
    return session.drainPromise;
  }

  // ── /standup start ──────────────────────────────────────────────────────

  private async handleStart(interaction: any) {
    await interaction.deferReply();

    const member = interaction.member;
    const voiceChannel = member?.voice?.channel as VoiceChannel | null;

    if (!voiceChannel) {
      return interaction.followUp("You must be in a voice channel to start the standup.");
    }

    if (this.recorder.isRecording) {
      return interaction.followUp("A recording is already in progress. Stop it first.");
    }

    const guildId = interaction.guildId!;
    const startedAt = new Date();
    const standupId = this.store.startStandup({
      guild_id: guildId,
      channel_id: voiceChannel.id,
      started_at: startedAt.toISOString(),
    });
    const session: SessionMeta = {
      guildId,
      type: "standup",
      startedAt,
      channelId: voiceChannel.id,
      textChannelId: interaction.channelId,
      lines: [],
      inflight: 0,
      queue: [],
      drainPromise: null,
      drainResolve: null,
      focusedIssue: null,
      presenter: null,
      activeParticipantIndex: 0,
      activityClients: new Set(),
      connectedUsers: new Map(),
      voiceMembers: new Map(),
      focusedDetailIssue: null,
      issueRepo: null,
      hadActivity: false,
      issueMeta: new Map(),
      standupId,
      proposalTrigger: {
        lastEvalAtByIssue: new Map(),
        lastSegmentCountByIssue: new Map(),
        evalInFlight: new Set(),
        activeByIssue: new Map(),
      },
      proposalFallbackTimer: null,
    };
    this.activeSessions.set(guildId, session);
    this.snapshotVoiceMembers(session, voiceChannel);
    this.persistSessionStart(guildId, session);
    this.startProposalFallbackTimer(session);

    try {
      await this.recorder.start(voiceChannel, {
        onUtterance: (utterance) => {
          this.enqueueUtterance(session, utterance);
        },
        onTimeout: () => {
          console.warn("[bot] Auto-stop triggered by timeout.");
          this.autoStop(interaction, guildId);
        },
        onDisconnect: (reason) => {
          console.error(`[bot] Voice disconnected: ${reason}`);
          this.autoStop(interaction, guildId);
        },
        onSpeakingChange: (userId, displayName, speaking) => {
          this.broadcastToActivity(guildId, {
            type: "speaker",
            userId,
            name: displayName,
            speaking,
          });
          this.onSpeakerChangeForProposals(session, userId, speaking);
        },
      });

      // Try to create an Activity invite button for one-click launch
      let components: ActionRowBuilder<ButtonBuilder>[] | undefined;
      try {
        const invite = await voiceChannel.createInvite({
          targetType: InviteTargetType.EmbeddedApplication,
          targetApplication: this.client.application!.id,
          maxAge: 3600,
        });
        components = [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setLabel("Open Standup Activity")
              .setStyle(ButtonStyle.Link)
              .setURL(invite.url)
          ),
        ];
      } catch (e: any) {
        console.warn("[bot] Could not create Activity invite:", e.message);
      }

      await interaction.followUp({
        content: `Recording standup in **${voiceChannel.name}**. Use \`/standup stop\` when done.`,
        ...(components ? { components } : {}),
      });
    } catch (e: any) {
      if (this.activeSessions.get(guildId) === session) {
        this.activeSessions.delete(guildId);
      }
      this.stopProposalFallbackTimer(session);
      this.store.deleteActiveSession(guildId, session.startedAt.toISOString());
      if (session.standupId != null) {
        try { this.store.deleteStandup(session.standupId); } catch { /* best-effort */ }
      }
      await interaction.followUp(`Failed to start recording: ${e.message}`);
    }
  }

  /** Auto-stop triggered by timeout or disconnect — posts results to the original channel. */
  private async autoStop(interaction: any, guildId: string) {
    if (!this.activeSessions.has(guildId)) return;

    try {
      const channel = interaction.channel;
      await channel?.send("Recording auto-stopped (timeout or disconnection). Processing...");
      await this.finishRecording(interaction, guildId);
    } catch (e: any) {
      console.error("[bot] Auto-stop error:", e);
    }
  }

  // ── /standup stop ───────────────────────────────────────────────────────

  private async handleStop(interaction: any) {
    await interaction.deferReply();

    const guildId = interaction.guildId!;
    const session = this.activeSessions.get(guildId);
    if (!session) {
      return interaction.followUp("No active recording found.");
    }
    if (session.type === "meeting") {
      return interaction.followUp("A meeting is being recorded. Use `/meeting stop` to stop it.");
    }

    await interaction.followUp("Recording stopped — processing…");
    await this.finishRecording(interaction, guildId);
  }

  // ── /meeting start ────────────────────────────────────────────────────

  private async handleMeetingStart(interaction: any) {
    await interaction.deferReply();

    const member = interaction.member;
    const voiceChannel = member?.voice?.channel as VoiceChannel | null;

    if (!voiceChannel) {
      return interaction.followUp("You must be in a voice channel to start recording.");
    }

    if (this.recorder.isRecording) {
      return interaction.followUp("A recording is already in progress. Stop it first.");
    }

    const guildId = interaction.guildId!;
    const session: SessionMeta = {
      guildId,
      type: "meeting",
      startedAt: new Date(),
      channelId: voiceChannel.id,
      textChannelId: interaction.channelId,
      lines: [],
      inflight: 0,
      queue: [],
      drainPromise: null,
      drainResolve: null,
      focusedIssue: null,
      presenter: null,
      activeParticipantIndex: 0,
      activityClients: new Set(),
      connectedUsers: new Map(),
      voiceMembers: new Map(),
      focusedDetailIssue: null,
      issueRepo: null,
      hadActivity: false,
      issueMeta: new Map(),
      standupId: null,
      proposalTrigger: null,
      proposalFallbackTimer: null,
    };
    this.activeSessions.set(guildId, session);
    this.snapshotVoiceMembers(session, voiceChannel);
    this.persistSessionStart(guildId, session);

    try {
      await this.recorder.start(voiceChannel, {
        onUtterance: (utterance) => {
          this.enqueueUtterance(session, utterance);
        },
        onTimeout: () => {
          console.warn("[bot] Auto-stop triggered by timeout.");
          this.autoStop(interaction, guildId);
        },
        onDisconnect: (reason) => {
          console.error(`[bot] Voice disconnected: ${reason}`);
          this.autoStop(interaction, guildId);
        },
        onSpeakingChange: (userId, displayName, speaking) => {
          this.broadcastToActivity(guildId, {
            type: "speaker",
            userId,
            name: displayName,
            speaking,
          });
        },
      });

      await interaction.followUp(
        `Recording meeting in **${voiceChannel.name}**. Use \`/meeting stop\` when done.`
      );
    } catch (e: any) {
      if (this.activeSessions.get(guildId) === session) {
        this.activeSessions.delete(guildId);
      }
      this.store.deleteActiveSession(guildId, session.startedAt.toISOString());
      await interaction.followUp(`Failed to start recording: ${e.message}`);
    }
  }

  // ── /meeting stop ─────────────────────────────────────────────────────

  private async handleMeetingStop(interaction: any) {
    await interaction.deferReply();

    const guildId = interaction.guildId!;
    const session = this.activeSessions.get(guildId);
    if (!session) {
      return interaction.followUp("No active recording found.");
    }
    if (session.type === "standup") {
      return interaction.followUp("A standup is being recorded. Use `/standup stop` to stop it.");
    }

    await interaction.followUp("Recording stopped — processing…");
    await this.finishRecording(interaction, guildId);
  }

  /** Shared stop logic: drain transcription queue, summarize, post results. */
  private async finishRecording(interaction: any, guildId: string) {
    // Prevent concurrent stop calls for the same guild.
    if (this.stoppingGuilds.has(guildId)) return;
    this.stoppingGuilds.add(guildId);

    try {
      await this._finishRecordingInner(interaction, guildId);
    } finally {
      this.stoppingGuilds.delete(guildId);
    }
  }

  private async _finishRecordingInner(interaction: any, guildId: string) {
    const session = this.activeSessions.get(guildId);
    const endedAt = new Date();
    const startedAt = session?.startedAt ?? endedAt;

    // Stop recorder — returns any utterances still in-progress.
    const remaining = this.recorder.stop();

    // Transcribe remaining utterances (people who were mid-sentence at stop).
    if (session) {
      for (const utterance of remaining) {
        this.enqueueUtterance(session, utterance);
      }
    }

    // Wait for ALL transcriptions (incremental + remaining) to complete.
    const totalPending = (session?.inflight ?? 0) + (session?.queue.length ?? 0);
    if (totalPending > 0) {
      console.log(`[bot] Waiting for ${totalPending} pending transcription(s)…`);
      try {
        await interaction.followUp?.(`Finishing ${totalPending} remaining transcription(s)…`);
      } catch { /* interaction may be expired */ }
    }
    if (session) {
      try {
        await Promise.race([
          this.waitForDrain(session),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("Drain timed out")), DRAIN_TIMEOUT_MS)
          ),
        ]);
      } catch (e: any) {
        console.error(`[bot] ${e.message} — proceeding with available transcriptions.`);
      }
    }

    // Close Activity WebSocket clients for THIS session only.
    if (session) {
      for (const ws of session.activityClients) {
        try { ws.close(); } catch { /* ignore */ }
      }
      this.stopProposalFallbackTimer(session);
    }

    // Identity-guarded cleanup: only evict the map entry if it still points
    // to the session we're finishing. A fast /standup start during our
    // drain window may have replaced the entry — leave that new session
    // alone (#58). The DB-side delete is scoped to this session's
    // started_at, so it's always safe to call.
    if (session && this.activeSessions.get(guildId) === session) {
      this.activeSessions.delete(guildId);
    }
    if (session) {
      this.store.deleteActiveSession(guildId, session.startedAt.toISOString());
    }

    if (!session || session.lines.length === 0) {
      // Clean up empty pre-inserted standup row if no proposals were generated.
      if (session?.standupId != null) {
        const proposals = this.store.listProposalsForStandup(session.standupId);
        if (proposals.length === 0) {
          try { this.store.deleteStandup(session.standupId); } catch { /* best-effort */ }
        } else {
          // Proposals exist — close out the row with an empty-meeting marker.
          this.store.finishStandup(session.standupId, {
            guild_id: session.guildId,
            channel_id: session.channelId,
            started_at: session.startedAt.toISOString(),
            ended_at: endedAt.toISOString(),
            participants: [],
            raw_transcript: "",
            summary_text: "(No speech captured)",
          });
        }
      }
      try {
        await interaction.followUp?.("No speech was captured — meeting may have been silent or too short.");
      } catch {
        await interaction.channel?.send("No speech was captured — meeting may have been silent or too short.");
      }
      return;
    }

    // Sort lines chronologically and build transcript.
    session.lines.sort((a, b) => a.startedAt - b.startedAt);
    const transcript = session.lines.map(l => `[${l.speaker}]: ${l.text}`).join("\n\n");

    // Debug summary
    const byUser = new Map<string, { name: string; count: number }>();
    for (const l of session.lines) {
      const e = byUser.get(l.userId) ?? { name: l.speaker, count: 0 };
      e.count++;
      byUser.set(l.userId, e);
    }
    for (const [userId, { name, count }] of byUser) {
      console.log(`[bot]   ${name} (${userId}): ${count} transcribed utterance(s)`);
    }

    const webUrl = process.env.WEB_URL ?? "https://discord-pm.fly.dev";

    // Check if we have issue-tagged data from the Activity
    const hasIssueData = session.lines.some(l => l.issueNumber !== null);

    let summaryResult;
    try {
      if (hasIssueData) {
        // Build issue-organized transcript for the summarizer
        const issueTranscript = this.buildIssueTranscript(session.lines);
        summaryResult = await this.summarizer.summarizeByIssue(issueTranscript);
      } else if (session.type === "meeting") {
        summaryResult = await this.summarizer.summarizeMeeting(transcript);
      } else {
        summaryResult = await this.summarizer.summarize(transcript);
      }
    } catch (e: any) {
      console.error("[bot] Summarization failed:", e);
      const { id: recordId } = this.persistFinalRecord(session, {
        guild_id: guildId,
        channel_id: session.channelId,
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        participants: [],
        raw_transcript: transcript,
        summary_text: "(Summarization failed)",
      });
      // Still save utterance segments so the issue-grouped web view renders correctly
      if (hasIssueData) {
        const segments: UtteranceSegment[] = session.lines
          .filter(l => l.text.trim())
          .map(l => {
            const meta = l.issueNumber != null ? session.issueMeta.get(l.issueNumber) : null;
            return {
              speaker: l.speaker,
              user_id: l.userId,
              issue_number: l.issueNumber,
              issue_repo: session.issueRepo,
              issue_title: meta?.title ?? null,
              issue_state: meta?.state ?? null,
              text: l.text,
              started_at: l.startedAt,
            };
          });
        this.store.saveSegments(recordId, segments);
      }
      const failMsg = `Summarization failed — transcript saved. View at: ${webUrl}/transcripts/${recordId}`;
      try {
        await interaction.followUp?.(failMsg);
      } catch {
        const channel = session.textChannelId
          ? this.client.channels.cache.get(session.textChannelId)
          : interaction.channel;
        if (channel && "send" in channel) await (channel as any).send(failMsg);
      }
      return;
    }

    const { id: recordId } = this.persistFinalRecord(session, {
      guild_id: guildId,
      channel_id: session.channelId,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      participants: summaryResult.participants,
      raw_transcript: transcript,
      summary_text: summaryResult.summary_text,
    });

    // Save utterance segments if we have issue data
    if (hasIssueData) {
      const segments: UtteranceSegment[] = session.lines
        .filter(l => l.text.trim())
        .map(l => {
          const meta = l.issueNumber != null ? session.issueMeta.get(l.issueNumber) : null;
          return {
            speaker: l.speaker,
            user_id: l.userId,
            issue_number: l.issueNumber,
            issue_repo: session.issueRepo,
            issue_title: meta?.title ?? null,
            issue_state: meta?.state ?? null,
            text: l.text,
            started_at: l.startedAt,
          };
        });
      this.store.saveSegments(recordId, segments);
    }

    const label = session.type === "meeting" ? "Meeting" : "Standup";
    await this.postSummaryEmbed(interaction, summaryResult, startedAt, endedAt, recordId, webUrl, label, session.textChannelId);
  }

  /** Build an issue-organized transcript string for the issue-aware summarizer. */
  private buildIssueTranscript(lines: TranscribedLine[]): string {
    const byIssue = new Map<number | null, TranscribedLine[]>();
    for (const line of lines) {
      const key = line.issueNumber;
      if (!byIssue.has(key)) byIssue.set(key, []);
      byIssue.get(key)!.push(line);
    }

    const sections: string[] = [];

    for (const [issueNum, issueLines] of byIssue) {
      const header = issueNum ? `## Issue #${issueNum}` : `## General Discussion`;
      const body = issueLines.map(l => `[${l.speaker}]: ${l.text}`).join("\n\n");
      sections.push(`${header}\n\n${body}`);
    }

    return sections.join("\n\n---\n\n");
  }

  private async postSummaryEmbed(
    interaction: any,
    result: any,
    startedAt: Date,
    endedAt: Date,
    recordId: number,
    webUrl: string,
    label = "Standup",
    textChannelId?: string,
  ) {
    const duration = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
    const min = Math.floor(duration / 60);
    const sec = duration % 60;

    const names = result.participants.map((p: any) => p.name).join(", ");

    const embed = new EmbedBuilder()
      .setTitle(`${label} Summary`)
      .setDescription(result.summary_text)
      .setColor(Colors.Green)
      .setFooter({ text: `${names}  •  ${min}m ${sec}s  •  #${recordId}` })
      .setTimestamp(endedAt);

    const content = `Full transcript: ${webUrl}/transcripts/${recordId}`;

    try {
      await interaction.followUp({ content, embeds: [embed] });
    } catch {
      // Interaction token expired (long meeting) — send directly via stored channel ID.
      const channel = textChannelId
        ? this.client.channels.cache.get(textChannelId)
        : interaction.channel;
      if (channel && "send" in channel) {
        await (channel as any).send({ content, embeds: [embed] });
      } else {
        console.error("[bot] Could not find text channel to post summary.");
      }
    }
  }

  // ── /standup status ─────────────────────────────────────────────────────

  private async handleStatus(interaction: any) {
    const session = this.activeSessions.get(interaction.guildId!);
    if (session && this.recorder.isRecording) {
      const elapsed = Math.round((Date.now() - session.startedAt.getTime()) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      const transcribed = session.lines.length;
      const pending = session.inflight + session.queue.length;
      const issueTag = session.focusedIssue ? ` Focused: #${session.focusedIssue}.` : "";
      await interaction.reply({
        content: `Recording in progress — ${min}m ${sec}s elapsed. ${transcribed} utterance(s) transcribed${pending > 0 ? `, ${pending} pending` : ""}.${issueTag}`,
        ephemeral: true,
      });
    } else {
      await interaction.reply({ content: "No standup recording in progress.", ephemeral: true });
    }
  }

  // ── /standup history ────────────────────────────────────────────────────

  private async handleHistory(interaction: any) {
    const count = interaction.options.getInteger("count") ?? 5;
    const summaries = this.store.recent(interaction.guildId!, count);

    if (!summaries.length) {
      return interaction.reply({ content: "No standup records found.", ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle(`Last ${summaries.length} Standup(s)`)
      .setColor(Colors.Blurple);

    for (const s of summaries) {
      const dateStr = new Date(s.started_at).toISOString().slice(0, 16).replace("T", " ") + " UTC";
      const names = s.participants.map((p: any) => p.name).join(", ") || "unknown";
      const blockers = s.participants.flatMap((p: any) => p.blockers ?? []);
      const blockerLine = blockers.length ? `\n⚠️ ${blockers.join(", ")}` : "";
      embed.addFields({
        name: dateStr,
        value: `${s.summary_text.slice(0, 200)}\n👥 ${names}${blockerLine}`,
        inline: false,
      });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // ── /review ─────────────────────────────────────────────────────────────

  private async handleReview(interaction: any) {
    const standupKey = interaction.options.getString("standup");
    if (!standupKey || !STANDUPS[standupKey]) {
      return interaction.reply({
        content: `Unknown standup. Choose from: ${STANDUP_NAMES.join(", ")}`,
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    try {
      const { embed, row } = await buildStepEmbed(standupKey, 0);
      await interaction.followUp({ embeds: [embed], components: [row] });
    } catch (e: any) {
      console.error("[bot] Review error:", e);
      await interaction.followUp(`Failed to fetch issues: ${e.message}`);
    }
  }

  /** Finalize the standup row using the lifecycle's finishStandup when we
   *  pre-inserted at /standup start; otherwise fall back to store.save (meetings
   *  and legacy standups without a pre-insert). */
  private persistFinalRecord(session: SessionMeta, record: StandupRecord): { id: number; transcriptPath: string } {
    if (session.standupId != null) {
      return this.store.finishStandup(session.standupId, record);
    }
    return this.store.save(record);
  }

  // ── Live action-bar proposals (#53) ────────────────────────────────────

  /** Current proposals for a session's standup, filtered to live ones. */
  getActiveProposals(guildId: string): Proposal[] {
    const session = this.activeSessions.get(guildId);
    if (!session || session.standupId == null) return [];
    return this.store.listActiveProposalsForStandup(session.standupId);
  }

  /** Start the 10s fallback scanner that re-evaluates long-monologue issues.
   *  Also fires on the "general discussion" bucket (focusedIssue null) so
   *  create_issue proposals surface even when nobody clicked a card. */
  private startProposalFallbackTimer(session: SessionMeta) {
    if (session.type !== "standup" || session.standupId == null) return;
    if (session.proposalFallbackTimer) return;
    session.proposalFallbackTimer = setInterval(() => {
      const bucket = session.focusedIssue;
      const key = bucket ?? GENERAL_BUCKET_KEY;
      const lastEval = session.proposalTrigger?.lastEvalAtByIssue.get(key) ?? 0;
      if (Date.now() - lastEval >= PROPOSAL_FALLBACK_STALE_MS) {
        this.maybeEvaluateProposals(session, bucket, "fallback_60s");
      }
    }, 10_000);
  }

  private stopProposalFallbackTimer(session: SessionMeta) {
    if (session.proposalFallbackTimer) {
      clearInterval(session.proposalFallbackTimer);
      session.proposalFallbackTimer = null;
    }
  }

  /** Speaker hand-off triggers eval of the current bucket (focused issue or
   *  general discussion). Edge trigger only (speaking=true). */
  private onSpeakerChangeForProposals(
    session: SessionMeta,
    _userId: string,
    speaking: boolean,
  ) {
    if (!speaking) return;
    this.maybeEvaluateProposals(session, session.focusedIssue, "speaker_change");
  }

  /** Debounced, stampede-guarded entry point for producing proposals. Pass
   *  null for the general-discussion bucket (no focused issue). */
  private maybeEvaluateProposals(
    session: SessionMeta,
    bucket: number | null,
    trigger: ProposalTriggerReason,
  ) {
    if (!this.proposalGenerator) {
      if (!session.proposalTrigger) return;
      return;
    }
    if (session.type !== "standup" || session.standupId == null) return;
    const trig = session.proposalTrigger;
    if (!trig) return;
    if (!session.issueRepo) {
      console.warn(`[bot] Skipping proposal eval (bucket=${bucket}) — issueRepo not set yet`);
      return;
    }
    const key = bucket ?? GENERAL_BUCKET_KEY;
    if (trig.evalInFlight.has(key)) return;

    const lastAt = trig.lastEvalAtByIssue.get(key) ?? 0;
    if (Date.now() - lastAt < PROPOSAL_MIN_DEBOUNCE_MS) return;

    // Only eval if there are new segments since the last eval.
    const bucketLines = session.lines.filter((l) => l.issueNumber === bucket);
    const lastCount = trig.lastSegmentCountByIssue.get(key) ?? 0;
    if (bucketLines.length <= lastCount) return;

    trig.evalInFlight.add(key);
    trig.lastEvalAtByIssue.set(key, Date.now());
    trig.lastSegmentCountByIssue.set(key, bucketLines.length);

    console.log(`[bot] Evaluating proposals bucket=${bucket ?? "general"} trigger=${trigger} segs=${bucketLines.length}`);

    this.evaluateProposals(session, bucket, trigger).finally(() => {
      trig.evalInFlight.delete(key);
    });
  }

  private async evaluateProposals(
    session: SessionMeta,
    bucket: number | null,
    trigger: ProposalTriggerReason,
  ) {
    if (!this.proposalGenerator || session.standupId == null) return;
    const repo = session.issueRepo;
    if (!repo) return;

    const meta = bucket != null ? session.issueMeta.get(bucket) : null;
    const bucketLines = session.lines.filter((l) => l.issueNumber === bucket);
    if (bucketLines.length === 0) return;

    const recentSegments = bucketLines.map((l) => ({
      id: l.startedAt,
      speaker: l.speaker,
      text: l.text,
      startedAtMs: l.startedAt,
    }));

    const known = this.store
      .listActiveProposalsForStandup(session.standupId)
      .filter((p) => p.focused_issue === bucket);

    const assignableUsers = Object.keys(USERS);

    let generated;
    try {
      generated = await this.proposalGenerator.generate({
        focusedIssue: bucket != null
          ? (meta
              ? { number: bucket, title: meta.title, state: meta.state }
              : { number: bucket, title: "", state: "open" })
          : null,
        recentSegments,
        knownProposals: known,
        repo,
        assignableUsers,
        trigger,
      });
    } catch (e: any) {
      console.error(`[bot] ProposalGenerator error for bucket=${bucket ?? "general"}:`, e.message);
      return;
    }

    console.log(`[bot] ProposalGenerator returned ${generated.length} for bucket=${bucket ?? "general"}`);
    if (generated.length === 0) return;

    for (const g of generated) {
      try {
        const proposal = this.store.insertProposal({
          standup_id: session.standupId,
          guild_id: session.guildId,
          created_at: new Date().toISOString(),
          trigger_reason: trigger,
          focused_issue: bucket,
          action_type: g.action_type,
          repo,
          target_issue: g.target_issue,
          payload: g.payload,
          source_segment_ids: g.source_segment_ids,
        });
        if (g.supersedes != null) {
          this.store.supersedeProposal(g.supersedes, proposal.id);
          this.broadcastToActivity(session.guildId, {
            type: "proposal-remove",
            id: g.supersedes,
          });
        }
        this.broadcastToActivity(session.guildId, {
          type: "proposal-upsert",
          proposal: serializeProposal(proposal),
        });
      } catch (e: any) {
        console.error("[bot] insertProposal failed:", e.message);
      }
    }
  }

  /** Server-side authorization for proposal write actions. Voice-channel
   *  members (by Discord ID) + Chris (admin override). */
  private authorizeProposalActor(session: SessionMeta, userId: string | null): boolean {
    if (!userId) return false;
    if (userId === ADMIN_DISCORD_ID) return true;
    return session.voiceMembers.has(userId);
  }

  /** Edit a proposal's payload (last-write-wins via monotonic version). */
  handleProposalEdit(
    guildId: string,
    userId: string | null,
    id: number,
    expectedVersion: number,
    payload: ProposalPayload,
  ): { ok: true } | { error: string; status: number } {
    const session = this.activeSessions.get(guildId);
    if (!session) return { error: "No active session", status: 404 };
    if (!this.authorizeProposalActor(session, userId)) return { error: "Forbidden", status: 403 };

    const updated = this.store.editProposal(id, expectedVersion, payload);
    if (!updated) return { error: "Proposal not found", status: 404 };
    // Always rebroadcast — stale edits receive canonical version back.
    this.broadcastToActivity(guildId, {
      type: "proposal-upsert",
      proposal: serializeProposal(updated),
    });
    return { ok: true };
  }

  /** Dismiss a proposal (soft delete — row kept for post-meeting audit). */
  handleProposalDismiss(
    guildId: string,
    userId: string | null,
    id: number,
  ): { ok: true } | { error: string; status: number } {
    const session = this.activeSessions.get(guildId);
    if (!session) return { error: "No active session", status: 404 };
    if (!this.authorizeProposalActor(session, userId)) return { error: "Forbidden", status: 403 };
    const updated = this.store.dismissProposal(id);
    if (!updated) return { error: "Proposal not found", status: 404 };
    this.broadcastToActivity(guildId, { type: "proposal-remove", id });
    return { ok: true };
  }

  /** Affirm and execute a proposal against GitHub. No retry — failures surface
   *  in the card UI. */
  async handleProposalAffirm(
    guildId: string,
    userId: string | null,
    id: number,
    expectedVersion: number,
  ): Promise<{ ok: true; url?: string } | { error: string; status: number }> {
    const session = this.activeSessions.get(guildId);
    if (!session) return { error: "No active session", status: 404 };
    if (!this.authorizeProposalActor(session, userId)) return { error: "Forbidden", status: 403 };

    const current = this.store.getProposal(id);
    if (!current) return { error: "Proposal not found", status: 404 };
    if (current.version !== expectedVersion) {
      // Stale — rebroadcast canonical so the client picks up the newer payload.
      this.broadcastToActivity(guildId, {
        type: "proposal-upsert",
        proposal: serializeProposal(current),
      });
      return { error: "Proposal version is stale — payload was edited. Refresh and try again.", status: 409 };
    }
    if (current.state !== "pending" && current.state !== "edited") {
      return { error: `Proposal state is ${current.state}; already actioned`, status: 409 };
    }

    const affirmed = this.store.markProposalAffirmed(id, userId!);
    if (!affirmed) return { error: "Could not affirm proposal", status: 409 };
    this.broadcastToActivity(guildId, {
      type: "proposal-upsert",
      proposal: serializeProposal(affirmed),
    });

    let result: { url?: string; error?: string };
    let ok = false;
    try {
      result = await this.executeProposal(affirmed);
      ok = true;
    } catch (e: any) {
      result = { error: e.message ?? String(e) };
    }

    const completed = this.store.completeProposal(id, ok, result);
    if (completed) {
      this.broadcastToActivity(guildId, {
        type: "proposal-upsert",
        proposal: serializeProposal(completed),
      });
    }

    if (!ok) return { error: result.error ?? "Execution failed", status: 502 };
    return { ok: true, url: result.url };
  }

  /** Dispatch a proposal to the right GitHub helper. */
  private async executeProposal(p: Proposal): Promise<{ url?: string }> {
    const repo = p.repo;
    switch (p.action_type) {
      case "close_issue": {
        if (p.target_issue == null) throw new Error("close_issue: missing target_issue");
        const reason = p.payload.reason === "not_planned" ? "not_planned" : "completed";
        return closeIssue(repo, p.target_issue, reason);
      }
      case "reopen_issue": {
        if (p.target_issue == null) throw new Error("reopen_issue: missing target_issue");
        return reopenIssue(repo, p.target_issue);
      }
      case "comment": {
        if (p.target_issue == null) throw new Error("comment: missing target_issue");
        const body = (p.payload.body ?? "").trim();
        if (!body) throw new Error("comment: empty body");
        return createComment(repo, p.target_issue, body);
      }
      case "reassign": {
        if (p.target_issue == null) throw new Error("reassign: missing target_issue");
        const assignees = p.payload.assignees ?? [];
        if (assignees.length === 0) throw new Error("reassign: no assignees");
        await assignIssue(repo, p.target_issue, assignees);
        return { url: `https://github.com/${repo}/issues/${p.target_issue}` };
      }
      case "set_labels": {
        if (p.target_issue == null) throw new Error("set_labels: missing target_issue");
        await setLabels(repo, p.target_issue, { add: p.payload.addLabels ?? [], remove: p.payload.removeLabels ?? [] });
        return { url: `https://github.com/${repo}/issues/${p.target_issue}` };
      }
      case "create_issue": {
        const title = (p.payload.title ?? "").trim();
        if (!title) throw new Error("create_issue: empty title");
        const created = await createIssue(repo, title, p.payload.newBody ?? "", []);
        if ((p.payload.newAssignees ?? []).length > 0) {
          try { await assignIssue(repo, created.number, p.payload.newAssignees ?? []); } catch { /* best-effort */ }
        }
        return { url: created.url };
      }
    }
  }

  private async handleReviewButton(interaction: any) {
    const parts = interaction.customId.split(":");
    // Format: review:next:standupKey:stepIndex  or  review:done:standupKey
    const action = parts[1];
    const standupKey = parts[2];

    if (action === "done") {
      await interaction.update({
        content: `Review of **${standupKey}** complete.`,
        embeds: [],
        components: [],
      });
      return;
    }

    if (action === "next") {
      const stepIndex = parseInt(parts[3]);
      if (!STANDUPS[standupKey] || isNaN(stepIndex)) {
        await interaction.reply({ content: "Invalid review state.", ephemeral: true });
        return;
      }

      await interaction.deferUpdate();

      try {
        const { embed, row } = await buildStepEmbed(standupKey, stepIndex);
        await interaction.editReply({ embeds: [embed], components: [row] });
      } catch (e: any) {
        console.error("[bot] Review step error:", e);
        await interaction.editReply({
          content: `Failed to fetch issues for step ${stepIndex + 1}: ${e.message}`,
          embeds: [],
          components: [],
        });
      }
    }
  }
}

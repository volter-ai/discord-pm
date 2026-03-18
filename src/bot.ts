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
import { StandupStore, type UtteranceSegment } from "./store";
import { STANDUPS, STANDUP_NAMES, buildStepEmbed } from "./review";

const GUILD_ID = process.env.DISCORD_GUILD_ID ?? "1219420218233847878";

/** Max concurrent transcription API calls to avoid rate limits + memory spikes. */
const MAX_CONCURRENT_TRANSCRIPTIONS = 3;

interface TranscribedLine {
  speaker: string;
  userId: string;
  text: string;
  startedAt: number;
  /** GitHub issue # that was focused in the Activity when this was spoken. */
  issueNumber: number | null;
}

interface SessionMeta {
  type: "standup" | "meeting";
  startedAt: Date;
  channelId: string;
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
  /** Repo string for issue-aware transcripts (e.g. "volter-ai/runhuman"). */
  issueRepo: string | null;
  /** Whether an Activity client was ever connected during this session. */
  hadActivity: boolean;
  /** Cached issue metadata (title + state) keyed by issue number. */
  issueMeta: Map<number, { title: string; state: string }>;
}

export class StandupBot {
  private client: Client;
  private recorder = new Recorder();
  private transcriber = new Transcriber();
  private summarizer: Summarizer;
  private store = new StandupStore();
  private activeSessions = new Map<string, SessionMeta>();

  constructor() {
    this.summarizer = new Summarizer(process.env.ANTHROPIC_API_KEY!);

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
    });

    this.client.on("interactionCreate", (i) => this.handleInteraction(i));
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

  /** Register an Activity WebSocket client for a guild session. */
  addActivityClient(guildId: string, ws: any) {
    const session = this.activeSessions.get(guildId);
    if (session) {
      session.activityClients.add(ws);
      session.hadActivity = true;
      console.log(`[bot] Activity client added (${session.activityClients.size} total)`);
    }
  }

  /** Remove an Activity WebSocket client. */
  removeActivityClient(guildId: string) {
    const session = this.activeSessions.get(guildId);
    if (session) {
      // Remove any closed connections
      for (const ws of session.activityClients) {
        try {
          if (ws.readyState !== undefined && ws.readyState > 1) {
            session.activityClients.delete(ws);
          }
        } catch {
          session.activityClients.delete(ws);
        }
      }
    }
  }

  /** Set the currently focused issue from Activity. Broadcasts state to all clients. */
  setFocusedIssue(guildId: string, issueNumber: number | null, issueTitle?: string, issueState?: string) {
    const session = this.activeSessions.get(guildId);
    if (session) {
      session.focusedIssue = issueNumber;
      if (issueNumber && issueTitle) {
        session.issueMeta.set(issueNumber, { title: issueTitle, state: issueState ?? "open" });
      }
      this.broadcastActivityState(guildId);
    }
  }

  /** Set the active participant tab index from Activity. Broadcasts state to all clients. */
  setActiveTab(guildId: string, participantIndex: number) {
    const session = this.activeSessions.get(guildId);
    if (session) {
      session.activeParticipantIndex = participantIndex;
      this.broadcastActivityState(guildId);
    }
  }

  /** Clear the presenter if the disconnecting client was the one holding the role. */
  clearPresenterIfDisconnected(guildId: string, userId: string | null) {
    const session = this.activeSessions.get(guildId);
    if (session && userId && session.presenter === userId) {
      session.presenter = null;
      this.broadcastActivityState(guildId);
      console.log(`[bot] Presenter ${userId} disconnected — presenter role cleared`);
    }
  }

  /** Set the current presenter from Activity. Broadcasts state so all clients learn the new presenter. */
  setPresenter(guildId: string, userId: string) {
    const session = this.activeSessions.get(guildId);
    if (session) {
      session.presenter = userId;
      this.broadcastActivityState(guildId);
    }
  }

  /** Broadcast current session state to all connected Activity clients. */
  private broadcastActivityState(guildId: string) {
    const session = this.activeSessions.get(guildId);
    if (!session) return;
    this.broadcastToActivity(guildId, {
      type: "state",
      focusedIssue: session.focusedIssue,
      presenter: session.presenter,
      activeParticipantIndex: session.activeParticipantIndex,
      recording: true,
      elapsed: Math.round((Date.now() - session.startedAt.getTime()) / 1000),
      utteranceCount: session.lines.length,
    });
  }

  /** Broadcast a message to all connected Activity clients for a guild. */
  private broadcastToActivity(guildId: string, message: object) {
    const session = this.activeSessions.get(guildId);
    if (!session) return;

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
    // Button interactions (review:next, review:done)
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith("review:")) {
        await this.handleReviewButton(interaction);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

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

  // ── Concurrency-limited transcription queue ────────────────────────────

  private enqueueUtterance(guildId: string, utterance: Utterance) {
    const session = this.activeSessions.get(guildId);
    if (!session) return;
    session.queue.push(utterance);
    this.drainQueue(guildId);
  }

  private drainQueue(guildId: string) {
    const session = this.activeSessions.get(guildId);
    if (!session) return;

    while (session.inflight < MAX_CONCURRENT_TRANSCRIPTIONS && session.queue.length > 0) {
      const utterance = session.queue.shift()!;
      session.inflight++;
      this.transcribeOne(guildId, utterance).finally(() => {
        session.inflight--;
        // Continue draining
        this.drainQueue(guildId);
        // Resolve drain promise if queue is empty and nothing in-flight
        if (session.inflight === 0 && session.queue.length === 0 && session.drainResolve) {
          session.drainResolve();
          session.drainResolve = null;
          session.drainPromise = null;
        }
      });
    }
  }

  private async transcribeOne(guildId: string, utterance: Utterance) {
    const session = this.activeSessions.get(guildId);
    if (!session) return;

    // Capture the focused issue at the time this utterance started
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

        // Broadcast to Activity clients
        this.broadcastToActivity(guildId, {
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
  private waitForDrain(guildId: string): Promise<void> {
    const session = this.activeSessions.get(guildId);
    if (!session) return Promise.resolve();
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
    const session: SessionMeta = {
      type: "standup",
      startedAt: new Date(),
      channelId: voiceChannel.id,
      lines: [],
      inflight: 0,
      queue: [],
      drainPromise: null,
      drainResolve: null,
      focusedIssue: null,
      presenter: null,
      activeParticipantIndex: 0,
      activityClients: new Set(),
      issueRepo: null,
      hadActivity: false,
      issueMeta: new Map(),
    };
    this.activeSessions.set(guildId, session);

    try {
      await this.recorder.start(voiceChannel, {
        onUtterance: (utterance) => {
          this.enqueueUtterance(guildId, utterance);
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
      this.activeSessions.delete(guildId);
      await interaction.followUp(`Failed to start recording: ${e.message}`);
    }
  }

  /** Auto-stop triggered by timeout or disconnect — posts results to the original channel. */
  private async autoStop(interaction: any, guildId: string) {
    if (!this.recorder.isRecording) return;

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

    if (!this.recorder.isRecording) {
      return interaction.followUp("No active recording found.");
    }

    const session = this.activeSessions.get(interaction.guildId!);
    if (session?.type === "meeting") {
      return interaction.followUp("A meeting is being recorded. Use `/meeting stop` to stop it.");
    }

    await interaction.followUp("Recording stopped — processing…");
    await this.finishRecording(interaction, interaction.guildId!);
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
      type: "meeting",
      startedAt: new Date(),
      channelId: voiceChannel.id,
      lines: [],
      inflight: 0,
      queue: [],
      drainPromise: null,
      drainResolve: null,
      focusedIssue: null,
      presenter: null,
      activeParticipantIndex: 0,
      activityClients: new Set(),
      issueRepo: null,
      hadActivity: false,
      issueMeta: new Map(),
    };
    this.activeSessions.set(guildId, session);

    try {
      await this.recorder.start(voiceChannel, {
        onUtterance: (utterance) => {
          this.enqueueUtterance(guildId, utterance);
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
      this.activeSessions.delete(guildId);
      await interaction.followUp(`Failed to start recording: ${e.message}`);
    }
  }

  // ── /meeting stop ─────────────────────────────────────────────────────

  private async handleMeetingStop(interaction: any) {
    await interaction.deferReply();

    if (!this.recorder.isRecording) {
      return interaction.followUp("No active recording found.");
    }

    const session = this.activeSessions.get(interaction.guildId!);
    if (session?.type === "standup") {
      return interaction.followUp("A standup is being recorded. Use `/standup stop` to stop it.");
    }

    await interaction.followUp("Recording stopped — processing…");
    await this.finishRecording(interaction, interaction.guildId!);
  }

  /** Shared stop logic: drain transcription queue, summarize, post results. */
  private async finishRecording(interaction: any, guildId: string) {
    const session = this.activeSessions.get(guildId);
    const endedAt = new Date();
    const startedAt = session?.startedAt ?? endedAt;

    // Stop recorder — returns any utterances still in-progress.
    const remaining = this.recorder.stop();

    // Transcribe remaining utterances (people who were mid-sentence at stop).
    for (const utterance of remaining) {
      this.enqueueUtterance(guildId, utterance);
    }

    // Wait for ALL transcriptions (incremental + remaining) to complete.
    const totalPending = (session?.inflight ?? 0) + (session?.queue.length ?? 0);
    if (totalPending > 0) {
      console.log(`[bot] Waiting for ${totalPending} pending transcription(s)…`);
      try {
        await interaction.followUp?.(`Finishing ${totalPending} remaining transcription(s)…`);
      } catch { /* interaction may be expired */ }
    }
    await this.waitForDrain(guildId);

    // Close Activity WebSocket clients
    if (session) {
      for (const ws of session.activityClients) {
        try { ws.close(); } catch { /* ignore */ }
      }
    }

    this.activeSessions.delete(guildId);

    if (!session || session.lines.length === 0) {
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
      } else {
        summaryResult = await this.summarizer.summarize(transcript);
      }
    } catch (e: any) {
      console.error("[bot] Summarization failed:", e);
      const { id: recordId } = this.store.save({
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
      try {
        await interaction.followUp?.(
          `Summarization failed — transcript saved. View at: ${webUrl}/transcripts/${recordId}`
        );
      } catch {
        await interaction.channel?.send(
          `Summarization failed — transcript saved. View at: ${webUrl}/transcripts/${recordId}`
        );
      }
      return;
    }

    const { id: recordId } = this.store.save({
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
    await this.postSummaryEmbed(interaction, summaryResult, startedAt, endedAt, recordId, webUrl, label);
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
    label = "Standup"
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

    try {
      await interaction.followUp({
        content: `Full transcript: ${webUrl}/transcripts/${recordId}`,
        embeds: [embed],
      });
    } catch {
      // Interaction expired (auto-stop after long meeting) — send to channel directly.
      await interaction.channel?.send({
        content: `Full transcript: ${webUrl}/transcripts/${recordId}`,
        embeds: [embed],
      });
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

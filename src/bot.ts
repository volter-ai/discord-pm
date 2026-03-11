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
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { Recorder, type Utterance } from "./recorder";
import { Transcriber } from "./transcriber";
import { Summarizer } from "./summarizer";
import { StandupStore } from "./store";
import { STANDUPS, STANDUP_NAMES, buildStepEmbed } from "./review";

const GUILD_ID = process.env.DISCORD_GUILD_ID ?? "1219420218233847878";

/** Max concurrent transcription API calls to avoid rate limits + memory spikes. */
const MAX_CONCURRENT_TRANSCRIPTIONS = 3;

interface TranscribedLine {
  speaker: string;
  userId: string;
  text: string;
  startedAt: number;
}

interface SessionMeta {
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
    } else if (interaction.commandName === "review") {
      await this.handleReview(interaction);
    }
  }

  // ── Concurrency-limited transcription queue ────────────────────────────────

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

    try {
      const mono = Recorder.toMono16k(utterance.pcmSamples);
      const durationSec = (mono.length / 16000).toFixed(2);
      console.log(`[bot] Transcribing ${utterance.member.displayName} utterance: ${mono.length} samples (${durationSec}s)`);

      const text = await this.transcriber.transcribe(mono);
      console.log(`[bot] → "${text.slice(0, 100)}"`);

      if (text.trim()) {
        session.lines.push({
          speaker: utterance.member.displayName,
          userId: utterance.userId,
          text: text.trim(),
          startedAt: utterance.startedAt,
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

  // ── /standup start ──────────────────────────────────────────────────────────

  private async handleStart(interaction: any) {
    await interaction.deferReply();

    const member = interaction.member;
    const voiceChannel = member?.voice?.channel as VoiceChannel | null;

    if (!voiceChannel) {
      return interaction.followUp("You must be in a voice channel to start the standup.");
    }

    if (this.recorder.isRecording) {
      return interaction.followUp("A recording is already in progress. Use `/standup stop` first.");
    }

    const guildId = interaction.guildId!;
    const session: SessionMeta = {
      startedAt: new Date(),
      channelId: voiceChannel.id,
      lines: [],
      inflight: 0,
      queue: [],
      drainPromise: null,
      drainResolve: null,
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
      });

      await interaction.followUp(
        `Recording standup in **${voiceChannel.name}**. Use \`/standup stop\` when done.`
      );
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

  // ── /standup stop ───────────────────────────────────────────────────────────

  private async handleStop(interaction: any) {
    await interaction.deferReply();

    if (!this.recorder.isRecording) {
      return interaction.followUp("No active recording found.");
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

    let summaryResult;
    try {
      summaryResult = await this.summarizer.summarize(transcript);
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

    await this.postSummaryEmbed(interaction, summaryResult, startedAt, endedAt, recordId, webUrl);
  }

  private async postSummaryEmbed(
    interaction: any,
    result: any,
    startedAt: Date,
    endedAt: Date,
    recordId: number,
    webUrl: string
  ) {
    const duration = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
    const min = Math.floor(duration / 60);
    const sec = duration % 60;

    const names = result.participants.map((p: any) => p.name).join(", ");

    const embed = new EmbedBuilder()
      .setTitle("Standup Summary")
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

  // ── /standup status ─────────────────────────────────────────────────────────

  private async handleStatus(interaction: any) {
    const session = this.activeSessions.get(interaction.guildId!);
    if (session && this.recorder.isRecording) {
      const elapsed = Math.round((Date.now() - session.startedAt.getTime()) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      const transcribed = session.lines.length;
      const pending = session.inflight + session.queue.length;
      await interaction.reply({
        content: `Recording in progress — ${min}m ${sec}s elapsed. ${transcribed} utterance(s) transcribed${pending > 0 ? `, ${pending} pending` : ""}.`,
        ephemeral: true,
      });
    } else {
      await interaction.reply({ content: "No standup recording in progress.", ephemeral: true });
    }
  }

  // ── /standup history ────────────────────────────────────────────────────────

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

  // ── /review ─────────────────────────────────────────────────────────────────

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

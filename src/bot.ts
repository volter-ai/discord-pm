/**
 * Main bot class — sets up the Discord client, registers slash commands,
 * and handles /standup start | stop | status | history.
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
import { Recorder } from "./recorder";
import { Transcriber } from "./transcriber";
import { Summarizer } from "./summarizer";
import { StandupStore } from "./store";

const GUILD_ID = "1219420218233847878"; // volter.ai — syncs immediately

interface SessionMeta {
  startedAt: Date;
  channelId: string;
}

export class StandupBot {
  private client: Client;
  private recorder = new Recorder();
  private transcriber = new Transcriber();
  private summarizer: Summarizer;
  private store = new StandupStore();
  private activeSessions = new Map<string, SessionMeta>(); // guildId → meta

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
            type: 1, // SUB_COMMAND
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
                type: 4, // INTEGER
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
    ];

    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN!);
    await rest.put(Routes.applicationGuildCommands(this.client.user!.id, GUILD_ID), {
      body: commands,
    });
    console.log("[bot] Slash commands synced to guild.");
  }

  private async handleInteraction(interaction: Interaction) {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "standup") return;

    const sub = interaction.options.getSubcommand();

    if (sub === "start") await this.handleStart(interaction);
    else if (sub === "stop") await this.handleStop(interaction);
    else if (sub === "status") await this.handleStatus(interaction);
    else if (sub === "history") await this.handleHistory(interaction);
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

    try {
      await this.recorder.start(voiceChannel);
      this.activeSessions.set(interaction.guildId!, {
        startedAt: new Date(),
        channelId: voiceChannel.id,
      });
      await interaction.followUp(
        `Recording standup in **${voiceChannel.name}**. Use \`/standup stop\` when done.`
      );
    } catch (e: any) {
      await interaction.followUp(`Failed to start recording: ${e.message}`);
    }
  }

  // ── /standup stop ───────────────────────────────────────────────────────────

  private async handleStop(interaction: any) {
    await interaction.deferReply();

    if (!this.recorder.isRecording) {
      return interaction.followUp("No active recording found.");
    }

    const session = this.activeSessions.get(interaction.guildId!);
    const endedAt = new Date();
    const startedAt = session?.startedAt ?? endedAt;

    await interaction.followUp("Recording stopped — transcribing each speaker (this may take a minute)…");

    const speakerData = this.recorder.stop();
    this.activeSessions.delete(interaction.guildId!);

    if (speakerData.size === 0) {
      return interaction.followUp("No audio was captured.");
    }

    // Transcribe each speaker in parallel
    const segments: { speaker: string; userId: string; text: string }[] = [];

    const results = await Promise.allSettled(
      [...speakerData.entries()]
        .filter(([, audio]) => audio.pcmSamples.length > 0)
        .map(async ([userId, audio]) => {
          const mono = Recorder.toMono16k(audio.pcmSamples);
          console.log(`[bot] Speaker ${audio.member.displayName}: ${audio.pcmSamples.length} opus chunks, ${mono.length} mono samples (${(mono.length / 16000).toFixed(1)}s)`);
          const text = await this.transcriber.transcribe(mono);
          console.log(`[bot] Transcription for ${audio.member.displayName}: "${text.slice(0, 100)}"`);
          return { speaker: audio.member.displayName, userId, text };
        })
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value.text.trim()) {
        segments.push(r.value);
      } else if (r.status === "rejected") {
        console.error("[bot] Transcription error:", r.reason);
      }
    }

    if (segments.length === 0) {
      return interaction.followUp("Transcription returned no speech — maybe the meeting was silent?");
    }

    // Format transcript with speaker labels
    const transcript = segments
      .map((s) => `[${s.speaker}]: ${s.text}`)
      .join("\n\n");

    await interaction.followUp("Transcription complete — summarizing with Claude…");

    let summaryResult;
    try {
      summaryResult = await this.summarizer.summarize(transcript);
    } catch (e: any) {
      console.error("[bot] Summarization failed:", e);
      // Post raw transcript on failure
      await interaction.followUp(
        `Summarization failed. Raw transcript:\n\`\`\`\n${transcript.slice(0, 1800)}\n\`\`\``
      );
      return;
    }

    const recordId = this.store.save({
      guild_id: interaction.guildId!,
      channel_id: session?.channelId ?? "unknown",
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      participants: summaryResult.participants,
      raw_transcript: transcript,
      summary_text: summaryResult.summary_text,
    });

    await this.postSummaryEmbed(interaction, summaryResult, startedAt, endedAt, recordId);
  }

  private async postSummaryEmbed(
    interaction: any,
    result: any,
    startedAt: Date,
    endedAt: Date,
    recordId: number
  ) {
    const embed = new EmbedBuilder()
      .setTitle("Standup Summary")
      .setDescription(result.summary_text)
      .setColor(Colors.Green)
      .setTimestamp(endedAt);

    for (const p of result.participants) {
      const lines: string[] = [];
      if (p.did?.length) lines.push("**Did:**\n" + p.did.map((d: string) => `• ${d}`).join("\n"));
      if (p.will_do?.length) lines.push("**Will do:**\n" + p.will_do.map((d: string) => `• ${d}`).join("\n"));
      if (p.blockers?.length) lines.push("**Blockers:**\n" + p.blockers.map((d: string) => `• ${d}`).join("\n"));
      embed.addFields({ name: p.name, value: lines.join("\n") || "No updates", inline: false });
    }

    const duration = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
    const min = Math.floor(duration / 60);
    const sec = duration % 60;
    embed.setFooter({ text: `Duration: ${min}m ${sec}s  •  Record #${recordId}` });

    await interaction.followUp({ embeds: [embed] });
  }

  // ── /standup status ─────────────────────────────────────────────────────────

  private async handleStatus(interaction: any) {
    const session = this.activeSessions.get(interaction.guildId!);
    if (session && this.recorder.isRecording) {
      const elapsed = Math.round((Date.now() - session.startedAt.getTime()) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      await interaction.reply({ content: `Recording in progress — ${min}m ${sec}s elapsed.`, ephemeral: true });
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
}

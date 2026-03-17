/**
 * Per-speaker voice recording using @discordjs/voice.
 *
 * Each speaking burst (speaking.start → speaking.end) is recorded as a
 * separate Utterance with a timestamp. Completed utterances are delivered
 * to the caller via an onUtterance callback so they can be transcribed
 * incrementally — keeping peak memory to ~1 utterance instead of the
 * entire meeting.
 */

import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceReceiver,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";
import { VoiceChannel, GuildMember } from "discord.js";
import { OpusEncoder } from "@discordjs/opus";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;

/** Default auto-stop after 60 minutes to prevent runaway memory usage. */
const DEFAULT_MAX_DURATION_MS = 60 * 60 * 1000;

/** Max reconnection attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 3;

/** One contiguous speaking burst from a single user. */
export interface Utterance {
  userId: string;
  member: GuildMember;
  /** Decoded Float32 PCM samples, stereo interleaved, 48kHz */
  pcmSamples: Float32Array[];
  /** Epoch ms when this burst started — used to sort the transcript */
  startedAt: number;
}

export interface RecorderCallbacks {
  /** Called when an utterance completes (speaking.end). Transcribe it now. */
  onUtterance: (utterance: Utterance) => void;
  /** Called when auto-stop timer fires. Caller should run stop logic. */
  onTimeout: () => void;
  /** Called when voice connection is permanently lost. */
  onDisconnect: (reason: string) => void;
  /** Called when a user starts or stops speaking (for Activity live indicators). */
  onSpeakingChange?: (userId: string, displayName: string, speaking: boolean) => void;
}

export class Recorder {
  private connection: VoiceConnection | null = null;
  private decoders = new Map<string, OpusEncoder>();
  private activeStreams = new Set<string>();
  private memberCache = new Map<string, GuildMember>();
  private activeUtterances = new Map<string, Utterance>();
  private guildId: string | null = null;
  private channelId: string | null = null;
  private stopping = false;
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  private callbacks: RecorderCallbacks | null = null;

  get isRecording() {
    return this.connection !== null;
  }

  async start(
    channel: VoiceChannel,
    callbacks: RecorderCallbacks,
    maxDurationMs = DEFAULT_MAX_DURATION_MS,
  ): Promise<void> {
    if (this.connection) throw new Error("Already recording.");

    this.stopping = false;
    this.guildId = channel.guild.id;
    this.channelId = channel.id;
    this.callbacks = callbacks;
    this.decoders.clear();
    this.activeStreams.clear();
    this.memberCache.clear();
    this.activeUtterances.clear();

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    console.log("[recorder] Voice connection ready.");

    // Auto-stop safety net
    this.autoStopTimer = setTimeout(() => {
      console.warn(`[recorder] Auto-stop: max duration (${maxDurationMs / 60_000}m) reached.`);
      callbacks.onTimeout();
    }, maxDurationMs);

    const receiver = this.connection.receiver;

    // Pre-subscribe to members already in the channel
    const membersInChannel = [...channel.members.values()].filter(m => !m.user.bot);
    console.log(`[recorder] Members already in channel: ${membersInChannel.map(m => m.displayName).join(", ") || "(none cached)"}`);
    for (const member of membersInChannel) {
      this.memberCache.set(member.id, member);
      this.subscribeToUser(receiver, member.id, member);
    }

    // speaking.start: open a new utterance for this user.
    this.connection.receiver.speaking.on("start", (userId) => {
      const member = channel.guild.members.cache.get(userId);
      console.log(`[recorder] speaking.start for userId=${userId} member=${member?.displayName ?? "(not cached)"}`);
      if (member?.user.bot) return;
      const effectiveMember = member ?? ({
        user: { id: userId, bot: false },
        displayName: `User-${userId.slice(-4)}`,
        id: userId,
      } as any);

      this.memberCache.set(userId, effectiveMember);

      this.activeUtterances.set(userId, {
        userId,
        member: effectiveMember,
        pcmSamples: [],
        startedAt: Date.now(),
      });

      this.subscribeToUser(receiver, userId, effectiveMember);
      callbacks.onSpeakingChange?.(userId, effectiveMember.displayName, true);

      if (!member) {
        channel.guild.members.fetch(userId).then(m => {
          this.memberCache.set(userId, m);
          const active = this.activeUtterances.get(userId);
          if (active) active.member = m;
        }).catch((e) => {
          console.warn(`[recorder] Could not resolve member for userId=${userId}: ${e.message}`);
        });
      }
    });

    // speaking.end: deliver the completed utterance via callback.
    this.connection.receiver.speaking.on("end", (userId) => {
      const utterance = this.activeUtterances.get(userId);
      const member = this.memberCache.get(userId);
      callbacks.onSpeakingChange?.(userId, member?.displayName ?? `User-${userId.slice(-4)}`, false);
      if (utterance && utterance.pcmSamples.length > 0) {
        console.log(`[recorder] speaking.end for userId=${userId} — ${utterance.pcmSamples.length} chunks this burst`);
        callbacks.onUtterance(utterance);
      } else {
        console.log(`[recorder] speaking.end for userId=${userId} — empty burst (no audio)`);
      }
      this.activeUtterances.delete(userId);
    });

    // Voice connection recovery
    this.connection.on("stateChange" as any, async (oldState: any, newState: any) => {
      console.log(`[recorder] connection state: ${oldState.status} → ${newState.status}`);

      if (newState.status === VoiceConnectionStatus.Disconnected) {
        // Attempt reconnection
        let reconnected = false;
        for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
          console.warn(`[recorder] Disconnected — reconnection attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}`);
          try {
            await entersState(this.connection!, VoiceConnectionStatus.Connecting, 5_000);
            await entersState(this.connection!, VoiceConnectionStatus.Ready, 10_000);
            console.log("[recorder] Reconnected successfully.");
            reconnected = true;
            break;
          } catch (e) {
            console.warn(`[recorder] Reconnection attempt ${attempt} failed:`, e);
          }
        }
        if (!reconnected && this.connection) {
          console.error("[recorder] All reconnection attempts failed.");
          callbacks.onDisconnect("Voice connection lost after 3 reconnection attempts.");
        }
      }
    });

    this.connection.on("error" as any, (err: Error) => {
      console.error("[recorder] VoiceConnection error (non-fatal):", err.message);
    });

    this.connection.on("debug" as any, (msg: string) => {
      if (
        msg.includes("DAVE") ||
        msg.includes("dave") ||
        msg.includes("ssrc") ||
        msg.includes("SSRC") ||
        msg.includes("decrypt") ||
        msg.includes("Speaking") ||
        msg.includes("speaking") ||
        msg.includes("ready") ||
        msg.includes("Ready")
      ) {
        console.log(`[recorder:debug] ${msg}`);
      }
    });
  }

  private subscribeToUser(
    receiver: VoiceReceiver,
    userId: string,
    member: GuildMember
  ) {
    if (this.activeStreams.has(userId)) return;
    this.activeStreams.add(userId);

    this.decoders.get(userId)?.destroy();
    const decoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
    this.decoders.set(userId, decoder);

    console.log(`[recorder] Subscribing to ${member.displayName} (${userId})`);

    const stream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    let packetCount = 0;
    let decodeErrors = 0;

    stream.on("data", (opusPacket: Buffer) => {
      if (this.stopping) return;
      packetCount++;
      if (packetCount === 1) {
        console.log(`[recorder] First Opus packet from ${member.displayName} — size=${opusPacket.length}B`);
      }
      if (packetCount % 500 === 0) {
        console.log(`[recorder] ${member.displayName}: ${packetCount} packets received`);
      }
      try {
        const pcmBuf: Buffer = decoder.decode(opusPacket);
        const numSamples = pcmBuf.length / 2;
        const float32 = new Float32Array(numSamples);
        for (let i = 0; i < numSamples; i++) {
          float32[i] = pcmBuf.readInt16LE(i * 2) / 0x8000;
        }
        let utterance = this.activeUtterances.get(userId);
        if (!utterance) {
          const m = this.memberCache.get(userId) ?? member;
          utterance = { userId, member: m, pcmSamples: [], startedAt: Date.now() };
          this.activeUtterances.set(userId, utterance);
        } else if (utterance.pcmSamples.length === 0) {
          utterance.startedAt = Date.now();
        }
        utterance.pcmSamples.push(float32);
      } catch (e: any) {
        decodeErrors++;
        if (decodeErrors <= 3) {
          console.warn(`[recorder] Decode error #${decodeErrors} for ${member.displayName}: ${e.message}`);
        }
      }
    });

    stream.on("error", (e) => {
      console.error(`[recorder] Stream error for ${member.displayName}:`, e);
    });

    stream.on("close", () => {
      this.activeStreams.delete(userId);
      console.log(`[recorder] Stream closed for ${member.displayName} — ${packetCount} pkts, ${decodeErrors} errs`);
    });
  }

  /**
   * Inject pre-loaded PCM samples for a speaker (used in testing).
   */
  injectAudio(userId: string, member: GuildMember, pcmSamples: Float32Array[]): void {
    this.callbacks?.onUtterance({ userId, member, pcmSamples, startedAt: Date.now() });
  }

  /**
   * Stop recording and return any utterances still in progress (speakers who
   * hadn't stopped talking when stop was called). Already-completed utterances
   * were delivered via the onUtterance callback during the meeting.
   */
  stop(): Utterance[] {
    this.stopping = true;

    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }

    // Finalize any utterances still in progress.
    const remaining: Utterance[] = [];
    for (const utterance of this.activeUtterances.values()) {
      if (utterance.pcmSamples.length > 0) {
        remaining.push(utterance);
      }
    }
    this.activeUtterances.clear();

    for (const decoder of this.decoders.values()) {
      try { decoder.destroy(); } catch { /* ignore */ }
    }
    this.decoders.clear();

    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }

    remaining.sort((a, b) => a.startedAt - b.startedAt);

    this.activeStreams.clear();
    this.memberCache.clear();
    this.callbacks = null;
    this.guildId = null;
    this.channelId = null;
    return remaining;
  }

  /**
   * Convert a speaker's accumulated PCM chunks into a mono 16kHz Float32Array
   * suitable for Whisper.
   */
  static toMono16k(chunks: Float32Array[]): Float32Array {
    if (chunks.length === 0) return new Float32Array(0);

    const totalLen = chunks.reduce((a, c) => a + c.length, 0);
    const stereo = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      stereo.set(chunk, offset);
      offset += chunk.length;
    }

    const monoLen = Math.floor(stereo.length / (CHANNELS * 3));
    const mono = new Float32Array(monoLen);
    for (let i = 0; i < monoLen; i++) {
      const base = i * CHANNELS * 3;
      mono[i] = (stereo[base] + stereo[base + 1]) / 2;
    }
    return mono;
  }
}

/**
 * Per-speaker voice recording using @discordjs/voice.
 *
 * Each speaking burst (speaking.start → speaking.end) is recorded as a
 * separate Utterance with a timestamp, so the transcript can be assembled
 * in chronological order rather than grouped by speaker.
 *
 * Packets are accumulated in memory; silence between speakers is handled
 * by Whisper (it handles silence and gaps well).
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

/** One contiguous speaking burst from a single user. */
export interface Utterance {
  userId: string;
  member: GuildMember;
  /** Decoded Float32 PCM samples, stereo interleaved, 48kHz */
  pcmSamples: Float32Array[];
  /** Epoch ms when this burst started — used to sort the transcript */
  startedAt: number;
}

export class Recorder {
  private connection: VoiceConnection | null = null;
  // One Opus decoder per user (stateful)
  private decoders = new Map<string, OpusEncoder>();
  // Tracks which userIds have an *active* (non-destroyed) stream.
  private activeStreams = new Set<string>();
  // Member cache so speaking-event handlers can look up display names.
  private memberCache = new Map<string, GuildMember>();
  // Utterance currently being built for each user (reset on speaking.end).
  private activeUtterances = new Map<string, Utterance>();
  // Finalized utterances — appended on speaking.end or stop().
  private completedUtterances: Utterance[] = [];
  private guildId: string | null = null;
  private channelId: string | null = null;
  // Set to true during stop() teardown so data handlers skip decode.
  private stopping = false;

  get isRecording() {
    return this.connection !== null;
  }

  async start(channel: VoiceChannel): Promise<void> {
    if (this.connection) throw new Error("Already recording.");

    this.stopping = false;
    this.guildId = channel.guild.id;
    this.channelId = channel.id;
    this.decoders.clear();
    this.activeStreams.clear();
    this.memberCache.clear();
    this.activeUtterances.clear();
    this.completedUtterances = [];

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // Must be false to receive audio
      selfMute: true,
    });

    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    console.log("[recorder] Voice connection ready.");

    const receiver = this.connection.receiver;

    // Pre-subscribe to members already in the channel so we don't miss their
    // audio while waiting for a speaking.start event.
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

      // Start a fresh utterance for this burst.
      this.activeUtterances.set(userId, {
        userId,
        member: effectiveMember,
        pcmSamples: [],
        startedAt: Date.now(),
      });

      // Subscribe to the audio stream if not already.
      this.subscribeToUser(receiver, userId, effectiveMember);

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

    // speaking.end: finalize the current utterance.
    this.connection.receiver.speaking.on("end", (userId) => {
      const utterance = this.activeUtterances.get(userId);
      if (utterance && utterance.pcmSamples.length > 0) {
        this.completedUtterances.push(utterance);
      }
      this.activeUtterances.delete(userId);
      const totalChunks = this.completedUtterances
        .filter(u => u.userId === userId)
        .reduce((s, u) => s + u.pcmSamples.length, 0);
      console.log(`[recorder] speaking.end for userId=${userId} — ${utterance?.pcmSamples.length ?? 0} chunks this burst, ${totalChunks} total`);
    });

    // Log connection state changes
    this.connection.on("stateChange" as any, (oldState: any, newState: any) => {
      console.log(`[recorder] connection state: ${oldState.status} → ${newState.status}`);
    });

    // Prevent unhandled 'error' events from crashing the process
    this.connection.on("error" as any, (err: Error) => {
      console.error("[recorder] VoiceConnection error (non-fatal):", err.message);
    });

    // Pipe internal debug events so we can see DAVE handshake + SSRC mapping
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

    // Recreate decoder on each (re-)subscription so it starts fresh.
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
        // @discordjs/opus decode() returns a Buffer of Int16 LE PCM samples.
        // Native bindings have isolated memory per instance — a bad packet
        // throws a catchable JS exception without corrupting other decoders.
        const pcmBuf: Buffer = decoder.decode(opusPacket);
        // Convert Int16 → Float32 (range -1..1), keeping stereo interleaving.
        const numSamples = pcmBuf.length / 2;
        const float32 = new Float32Array(numSamples);
        for (let i = 0; i < numSamples; i++) {
          float32[i] = pcmBuf.readInt16LE(i * 2) / 0x8000;
        }
        // Route to the active utterance. If speaking.start hasn't fired yet
        // (pre-subscribed member starts speaking), create an implicit utterance.
        let utterance = this.activeUtterances.get(userId);
        if (!utterance) {
          const m = this.memberCache.get(userId) ?? member;
          utterance = { userId, member: m, pcmSamples: [], startedAt: Date.now() };
          this.activeUtterances.set(userId, utterance);
        } else if (utterance.pcmSamples.length === 0) {
          // Pin startedAt to the moment the first actual packet arrives rather
          // than when speaking.start fired — gives more accurate ordering when
          // two speakers start within the same event-loop tick.
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
    this.completedUtterances.push({ userId, member, pcmSamples, startedAt: Date.now() });
  }

  /**
   * Stop recording and return utterances sorted chronologically.
   */
  stop(): Utterance[] {
    // Set flag first so any in-flight data events are ignored.
    this.stopping = true;

    // Finalize any utterances still in progress when stop() was called.
    for (const utterance of this.activeUtterances.values()) {
      if (utterance.pcmSamples.length > 0) {
        this.completedUtterances.push(utterance);
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

    // Sort by start time to get chronological conversation order.
    this.completedUtterances.sort((a, b) => a.startedAt - b.startedAt);
    const result = this.completedUtterances;

    this.completedUtterances = [];
    this.activeStreams.clear();
    this.memberCache.clear();
    this.guildId = null;
    this.channelId = null;
    return result;
  }

  /**
   * Convert a speaker's accumulated PCM chunks into a mono 16kHz Float32Array
   * suitable for Whisper.
   */
  static toMono16k(chunks: Float32Array[]): Float32Array {
    if (chunks.length === 0) return new Float32Array(0);

    // Concatenate all chunks
    const totalLen = chunks.reduce((a, c) => a + c.length, 0);
    const stereo = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      stereo.set(chunk, offset);
      offset += chunk.length;
    }

    // Stereo → mono (average L and R), then downsample 48kHz → 16kHz (keep every 3rd frame)
    const monoLen = Math.floor(stereo.length / (CHANNELS * 3));
    const mono = new Float32Array(monoLen);
    for (let i = 0; i < monoLen; i++) {
      const base = i * CHANNELS * 3;
      mono[i] = (stereo[base] + stereo[base + 1]) / 2;
    }
    return mono;
  }
}

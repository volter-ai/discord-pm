/**
 * Per-speaker voice recording using @discordjs/voice.
 *
 * Each user in the voice channel gets their own Opus stream.
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

export interface SpeakerAudio {
  member: GuildMember;
  /** Decoded Float32 PCM samples, stereo interleaved, 48kHz */
  pcmSamples: Float32Array[];
  /** Epoch ms of first packet — used for rough ordering */
  startedAt: number;
}

export class Recorder {
  private connection: VoiceConnection | null = null;
  private speakers = new Map<string, SpeakerAudio>();
  // One Opus decoder per user (stateful)
  private decoders = new Map<string, OpusEncoder>();
  // Tracks which userIds have an *active* (non-destroyed) stream.
  // Separate from speakers so a destroyed stream can be re-created on the
  // next speaking event without losing already-accumulated PCM data.
  private activeStreams = new Set<string>();
  private guildId: string | null = null;
  private channelId: string | null = null;
  // Set to true during stop() teardown so data handlers skip decode on deleted decoders
  private stopping = false;

  get isRecording() {
    return this.connection !== null;
  }

  async start(channel: VoiceChannel): Promise<void> {
    if (this.connection) throw new Error("Already recording.");

    this.stopping = false;
    this.guildId = channel.guild.id;
    this.channelId = channel.id;
    this.speakers.clear();
    this.decoders.clear();
    this.activeStreams.clear();

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

    // Subscribe to members already in the channel
    const membersInChannel = [...channel.members.values()].filter(m => !m.user.bot);
    console.log(`[recorder] Members already in channel: ${membersInChannel.map(m => m.displayName).join(", ") || "(none cached)"}`);
    for (const member of membersInChannel) {
      this.subscribeToUser(receiver, member.id, member);
    }

    // Subscribe to members who join after recording starts (or start speaking).
    // If the member isn't in cache (GuildMembers intent not enabled, or race),
    // we still subscribe using a minimal stub so audio isn't silently dropped.
    this.connection.receiver.speaking.on("start", (userId) => {
      const member = channel.guild.members.cache.get(userId);
      console.log(`[recorder] speaking.start event for userId=${userId} member=${member?.displayName ?? "(not in cache — will still subscribe)"}`);
      // Bots never send audio we want; skip known bots.  Unknown users subscribe.
      if (member?.user.bot) return;
      const effectiveMember = member ?? ({
        user: { id: userId, bot: false },
        displayName: `User-${userId.slice(-4)}`,
        id: userId,
      } as any);
      this.subscribeToUser(receiver, userId, effectiveMember);
      // Try to resolve the real member asynchronously for better display names
      if (!member) {
        channel.guild.members.fetch(userId).then(m => {
          const entry = this.speakers.get(userId);
          if (entry) entry.member = m;
        }).catch((e) => {
          console.warn(`[recorder] Could not resolve member for userId=${userId}: ${e.message}`);
        });
      }
    });

    this.connection.receiver.speaking.on("end", (userId) => {
      const chunks = this.speakers.get(userId)?.pcmSamples.length ?? 0;
      console.log(`[recorder] speaking.end for userId=${userId} — ${chunks} chunks so far`);
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
      // Filter to only the most useful debug lines to avoid noise
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
    // Guard: only one live stream per user at a time.
    // We do NOT check speakers.has() here so that a re-subscription after
    // DAVE-induced stream destruction is allowed (preserving pcmSamples).
    if (this.activeStreams.has(userId)) return;
    this.activeStreams.add(userId);

    // Preserve existing pcmSamples if re-subscribing after stream destruction.
    if (!this.speakers.has(userId)) {
      this.speakers.set(userId, {
        member,
        pcmSamples: [],
        startedAt: Date.now(),
      });
    }

    // Recreate decoder on each (re-)subscription so it starts fresh.
    this.decoders.get(userId)?.destroy();
    const decoder = new OpusEncoder(SAMPLE_RATE, CHANNELS);
    this.decoders.set(userId, decoder);

    const existing = this.speakers.get(userId)!.pcmSamples.length;
    console.log(`[recorder] Subscribing to ${member.displayName} (${userId}) — existing chunks: ${existing}`);

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
        this.speakers.get(userId)?.pcmSamples.push(float32);
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
      // Mark stream as inactive so the next speaking event re-creates it.
      this.activeStreams.delete(userId);
      console.log(`[recorder] Stream closed for ${member.displayName} — ${packetCount} pkts, ${decodeErrors} errs, ${this.speakers.get(userId)?.pcmSamples.length ?? 0} chunks total`);
    });
  }

  /**
   * Inject pre-loaded PCM samples for a speaker (used in testing to bypass
   * Discord self-echo restriction).
   */
  injectAudio(userId: string, member: GuildMember, pcmSamples: Float32Array[]): void {
    this.speakers.set(userId, { member, pcmSamples, startedAt: Date.now() });
  }

  /** Stop recording and return the per-speaker audio data. */
  stop(): Map<string, SpeakerAudio> {
    // Set flag first so any in-flight data events skip decode on deleted decoders
    this.stopping = true;
    for (const decoder of this.decoders.values()) {
      try { decoder.destroy(); } catch { /* ignore */ }
    }
    this.decoders.clear();

    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }

    const data = new Map(this.speakers);
    this.speakers.clear();
    this.activeStreams.clear();
    this.guildId = null;
    this.channelId = null;
    return data;
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

    // Stereo → mono (average L and R), then downsample 48kHz → 16kHz (keep every 3rd sample)
    const monoLen = Math.floor(stereo.length / (CHANNELS * 3));
    const mono = new Float32Array(monoLen);
    for (let i = 0; i < monoLen; i++) {
      const base = i * CHANNELS * 3;
      mono[i] = (stereo[base] + stereo[base + 1]) / 2;
    }
    return mono;
  }
}

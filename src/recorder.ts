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
// @ts-ignore - opusscript has no types
import OpusScript from "opusscript";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_SIZE = 960; // 20ms at 48kHz

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
  // One OpusScript decoder per user (stateful)
  private decoders = new Map<string, InstanceType<typeof OpusScript>>();
  private guildId: string | null = null;
  private channelId: string | null = null;

  get isRecording() {
    return this.connection !== null;
  }

  get recordingChannelId() {
    return this.channelId;
  }

  async start(channel: VoiceChannel): Promise<void> {
    if (this.connection) throw new Error("Already recording.");

    this.guildId = channel.guild.id;
    this.channelId = channel.id;
    this.speakers.clear();
    this.decoders.clear();

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // Must be false to receive audio
      selfMute: true,
    });

    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);

    const receiver = this.connection.receiver;

    // Subscribe to members already in the channel
    for (const [userId, member] of channel.members) {
      if (!member.user.bot) {
        this.subscribeToUser(receiver, userId, member);
      }
    }

    // Subscribe to members who join after recording starts
    this.connection.receiver.speaking.on("start", (userId) => {
      const member = channel.guild.members.cache.get(userId);
      if (member && !member.user.bot) {
        this.subscribeToUser(receiver, userId, member);
      }
    });
  }

  private subscribeToUser(
    receiver: VoiceReceiver,
    userId: string,
    member: GuildMember
  ) {
    if (this.speakers.has(userId)) return; // already subscribed

    const decoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP);
    this.decoders.set(userId, decoder);
    this.speakers.set(userId, {
      member,
      pcmSamples: [],
      startedAt: Date.now(),
    });

    const stream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    stream.on("data", (opusPacket: Buffer) => {
      try {
        // decodeFloat returns Float32Array of interleaved stereo samples
        const decoded: Float32Array = decoder.decodeFloat(opusPacket, FRAME_SIZE);
        this.speakers.get(userId)?.pcmSamples.push(decoded);
      } catch {
        // Drop malformed packets silently
      }
    });

    stream.on("error", () => {
      // Ignore stream errors; user may have left
    });
  }

  /** Stop recording and return the per-speaker audio data. */
  stop(): Map<string, SpeakerAudio> {
    for (const decoder of this.decoders.values()) {
      try { decoder.delete(); } catch { /* ignore */ }
    }
    this.decoders.clear();

    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }

    const data = new Map(this.speakers);
    this.speakers.clear();
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

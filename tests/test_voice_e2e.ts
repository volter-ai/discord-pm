/**
 * End-to-end voice transcription test.
 *
 * Flow:
 *  1. Bot connects to a Discord voice channel (real Discord connection).
 *  2. Downloads a known speech WAV file (LibriSpeech public domain sample).
 *  3. Parses the WAV into raw Float32 PCM samples.
 *  4. Injects those samples into the Recorder as a fake "speaker" — necessary
 *     because Discord does NOT echo a bot's own transmitted audio back to itself.
 *  5. Stops recording, runs the full transcription pipeline.
 *  6. Verifies the transcription contains expected keywords.
 *
 * Success criteria: transcription output contains at least one expected word
 * from the known speech clip.
 */

import { config } from "dotenv";
config();

import {
  Client,
  GatewayIntentBits,
  VoiceChannel,
} from "discord.js";
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
} from "@discordjs/voice";
import { Recorder } from "../src/recorder";
import { Transcriber } from "../src/transcriber";

const GUILD_ID = "1219420218233847878";
// Use "Internal Lab" voice channel (internal/testing channel)
const VOICE_CHANNEL_ID = "1471900965345955901";
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN!;

// The JFK "ask not what your country can do for you" clip from OpenAI Whisper tests
// This is the canonical Whisper test audio — mono 16kHz, ~11 seconds.
const TEST_AUDIO_URL = "https://github.com/openai/whisper/raw/main/tests/jfk.flac";

// Expected words/phrases that should appear in the transcription
const EXPECTED_WORDS = ["country", "american", "ask", "fellow"];

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[test] ${msg}`);
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${msg}`);
}

/**
 * Parse a 16-bit PCM WAV buffer into a Float32Array.
 * Returns null if the format is not supported.
 */
function parseWav(buf: ArrayBuffer): { samples: Float32Array; sampleRate: number; channels: number } | null {
  const view = new DataView(buf);
  const decoder = new TextDecoder();

  const riff = decoder.decode(new Uint8Array(buf, 0, 4));
  const wave = decoder.decode(new Uint8Array(buf, 8, 4));
  if (riff !== "RIFF" || wave !== "WAVE") return null;

  // Find fmt chunk
  let offset = 12;
  let audioFormat = 0, channels = 0, sampleRate = 0, bitsPerSample = 0;
  let dataOffset = 0, dataSize = 0;

  while (offset < buf.byteLength - 8) {
    const chunkId = decoder.decode(new Uint8Array(buf, offset, 4));
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === "fmt ") {
      audioFormat = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === "data") {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize;
  }

  if (audioFormat !== 1 || bitsPerSample !== 16) return null; // Only PCM 16-bit

  const numSamples = dataSize / 2;
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const int16 = view.getInt16(dataOffset + i * 2, true);
    samples[i] = int16 / 0x8000;
  }

  return { samples, sampleRate, channels };
}

/**
 * Resample from srcRate to dstRate (integer ratio, nearest neighbour).
 */
function resample(samples: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return samples;
  const ratio = srcRate / dstRate;
  const len = Math.floor(samples.length / ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = samples[Math.floor(i * ratio)];
  }
  return out;
}

/**
 * Convert mono PCM at 16kHz to stereo interleaved 48kHz Float32 chunks,
 * as if received from Discord (48kHz stereo, 960-frame chunks).
 */
function monoTo48kStereoChunks(mono16k: Float32Array): Float32Array[] {
  // Upsample 16kHz → 48kHz
  const mono48k = resample(mono16k, 16000, 48000);

  const FRAME = 960; // 20ms at 48kHz
  const stereoFrameLen = FRAME * 2; // 2 channels interleaved
  const numFrames = Math.ceil(mono48k.length / FRAME);
  const chunks: Float32Array[] = [];

  for (let f = 0; f < numFrames; f++) {
    const frame = new Float32Array(stereoFrameLen);
    for (let i = 0; i < FRAME; i++) {
      const s = mono48k[f * FRAME + i] ?? 0;
      frame[i * 2] = s;     // L
      frame[i * 2 + 1] = s; // R
    }
    chunks.push(frame);
  }

  return chunks;
}

/**
 * Download a known speech WAV/FLAC.  Falls back to generating a synthetic
 * mono 16kHz WAV sample if the download fails.
 *
 * We first try to fetch the JFK FLAC via the GitHub raw CDN.  If the format
 * is FLAC (not parseable as WAV here), we fall back to a LibriSpeech WAV
 * that GitHub hosts, and if that too fails we fall through to the synthetic.
 */
async function downloadTestAudio(): Promise<{ samples: Float32Array; sampleRate: number; channels: number; source: string }> {
  // Try known public WAV samples (redirect-following fetch is required)
  const candidates = [
    {
      // JFK "ask not" clip — stereo 44.1 kHz 16-bit, ~11 s, ~1.9 MB
      url: "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav",
      label: "jfk-wav-xenova",
    },
    {
      // Fallback: try the FLAC version (will fail WAV parse; triggers synthetic)
      url: "https://github.com/openai/whisper/raw/main/tests/jfk.flac",
      label: "jfk-flac-openai",
    },
  ];

  for (const { url, label } of candidates) {
    try {
      log(`Downloading test audio from ${label} …`);
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      const parsed = parseWav(buf);
      if (parsed) {
        log(`Downloaded ${label}: ${parsed.sampleRate}Hz ${parsed.channels}ch ${parsed.samples.length} samples`);
        return { ...parsed, source: label };
      }
    } catch (e: any) {
      log(`Download failed for ${label}: ${e.message}`);
    }
  }

  // Last resort: generate a synthetic speech-like signal using a voiced vowel
  // approximation (F0=120Hz, formants at 700/1220/2600 Hz — rough /a/ vowel).
  // Whisper won't reliably transcribe this, but it tests the pipeline plumbing.
  log("Using synthetic fallback audio (results may not contain expected words)");
  const sampleRate = 16000;
  const duration = 5; // seconds
  const n = sampleRate * duration;
  const samples = new Float32Array(n);
  const f0 = 120, f1 = 700, f2 = 1220, f3 = 2600;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    samples[i] =
      0.4 * Math.sin(2 * Math.PI * f0 * t) +
      0.3 * Math.sin(2 * Math.PI * f1 * t) +
      0.2 * Math.sin(2 * Math.PI * f2 * t) +
      0.1 * Math.sin(2 * Math.PI * f3 * t);
  }
  return { samples, sampleRate, channels: 1, source: "synthetic" };
}

// ── Main test ─────────────────────────────────────────────────────────────────

async function runTest() {
  const results: { step: string; passed: boolean; detail: string }[] = [];

  function record(step: string, passed: boolean, detail: string) {
    results.push({ step, passed, detail });
    console.log(`  [${passed ? "PASS" : "FAIL"}] ${step}: ${detail}`);
  }

  // ── Step 1: Connect Discord client ────────────────────────────────────────
  log("Connecting Discord client…");
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
    ],
  });

  await new Promise<void>((res, rej) => {
    client.once("ready", () => res());
    client.once("error", rej);
    client.login(BOT_TOKEN).catch(rej);
  });
  record("Discord login", true, `Logged in as ${client.user!.tag}`);

  // ── Step 2: Fetch voice channel ───────────────────────────────────────────
  const channel = await client.channels.fetch(VOICE_CHANNEL_ID) as VoiceChannel;
  assert(channel?.isVoiceBased(), "Channel is not a voice channel");
  record("Fetch voice channel", true, `#${channel.name}`);

  // ── Step 3: Join voice channel ────────────────────────────────────────────
  let connectionOk = false;
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: GUILD_ID,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    connectionOk = true;
    record("Join voice channel", true, `Connected to "${channel.name}"`);
  } catch (e: any) {
    record("Join voice channel", false, e.message);
  }

  // ── Step 4: Download test audio ───────────────────────────────────────────
  const audioData = await downloadTestAudio();
  record(
    "Download test audio",
    audioData.source !== "synthetic",
    `source=${audioData.source} ${audioData.sampleRate}Hz ${audioData.channels}ch`
  );

  // ── Step 5: Convert to mono 16kHz ─────────────────────────────────────────
  // If stereo, average channels; if not 16kHz, resample
  let mono16k: Float32Array;
  if (audioData.channels === 2) {
    const half = audioData.samples.length / 2;
    mono16k = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      mono16k[i] = (audioData.samples[i * 2] + audioData.samples[i * 2 + 1]) / 2;
    }
  } else {
    mono16k = audioData.samples;
  }
  if (audioData.sampleRate !== 16000) {
    mono16k = resample(mono16k, audioData.sampleRate, 16000);
  }
  record(
    "Prepare mono 16kHz",
    mono16k.length > 1600,
    `${mono16k.length} samples (${(mono16k.length / 16000).toFixed(2)}s)`
  );

  // ── Step 6: Inject audio into Recorder ───────────────────────────────────
  // Convert mono 16kHz → stereo 48kHz chunks (format Recorder expects)
  const recorder = new Recorder();

  // Start a "mock" recording — we need a VoiceConnection for the recorder but
  // we'll bypass the Discord receiver by injecting audio directly.
  if (connectionOk) {
    // Simulate starting the recorder by making it aware of a mock member
    const guild = channel.guild;
    // Create a mock member (bot itself)
    const botMember = guild.members.cache.get(client.user!.id) ?? {
      user: client.user!,
      displayName: "amp-test",
    } as any;

    const stereoChunks = monoTo48kStereoChunks(mono16k);
    recorder.injectAudio("test-user-001", botMember, stereoChunks);
    record(
      "Inject audio into Recorder",
      stereoChunks.length > 0,
      `${stereoChunks.length} chunks (${(stereoChunks.length * 960 / 48000).toFixed(2)}s of audio)`
    );
  }

  // ── Step 7: Simulate "few seconds in channel" then stop ───────────────────
  log("Simulating recording period (3 seconds)…");
  await new Promise((r) => setTimeout(r, 3000));

  // ── Step 8: Disconnect from voice channel ─────────────────────────────────
  if (connectionOk) {
    connection.destroy();
    record("Leave voice channel", true, "Disconnected cleanly");
  }

  // ── Step 9: Transcribe ────────────────────────────────────────────────────
  log("Running transcription pipeline…");
  const transcriber = new Transcriber();

  let transcription = "";
  const speakers = recorder.stop();

  if (speakers.size === 0) {
    record("Transcribe", false, "No speakers captured");
  } else {
    try {
      for (const [userId, audio] of speakers) {
        const processed = Recorder.toMono16k(audio.pcmSamples);
        log(`  Transcribing ${audio.member.displayName}: ${processed.length} samples (${(processed.length / 16000).toFixed(2)}s)`);
        const text = await transcriber.transcribe(processed);
        transcription += text + " ";
        log(`  → "${text}"`);
      }
      transcription = transcription.trim();
      record(
        "Transcribe",
        transcription.length > 0,
        `"${transcription.slice(0, 200)}"`
      );
    } catch (e: any) {
      record("Transcribe", false, e.message);
    }
  }

  // ── Step 10: Verify content ───────────────────────────────────────────────
  const lower = transcription.toLowerCase();
  const found = EXPECTED_WORDS.filter((w) => lower.includes(w));

  if (audioData.source !== "synthetic") {
    const contentOk = found.length >= 1;
    record(
      "Verify transcription keywords",
      contentOk,
      contentOk
        ? `Found: [${found.join(", ")}] in transcription`
        : `None of [${EXPECTED_WORDS.join(", ")}] found in: "${transcription.slice(0, 150)}"`
    );
  } else {
    record(
      "Verify transcription keywords",
      true, // synthetic audio is expected to not match keywords
      "Skipped — used synthetic fallback audio (no real speech)"
    );
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════");
  console.log("  VOICE TRANSCRIPTION TEST RESULTS");
  console.log("═══════════════════════════════════════════════");
  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    console.log(`  ${icon} ${r.step}`);
    if (!r.passed) console.log(`      → ${r.detail}`);
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const allPassed = results.every((r) => r.passed);
  console.log(`\n  ${passed}/${total} steps passed`);
  console.log(`  Overall: ${allPassed ? "PASS ✓" : "FAIL ✗"}`);
  console.log("═══════════════════════════════════════════════\n");

  await client.destroy();
  process.exit(allPassed ? 0 : 1);
}

runTest().catch((e) => {
  console.error("[test] Fatal error:", e);
  process.exit(1);
});

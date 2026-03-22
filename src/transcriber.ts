/**
 * Transcription service with API backends.
 *
 * Priority:
 *   1. OpenAI Whisper API  (if OPENAI_API_KEY set)
 *   2. Replicate Whisper   (if REPLICATE_API_TOKEN set)
 *
 * Local Whisper was removed — the ONNX fp32 model uses ~300-500MB of RAM,
 * which OOM-kills the process on a 1GB VM when combined with audio recording.
 * If both API backends are unavailable, the utterance is silently skipped
 * rather than crashing the entire meeting.
 *
 * Input: mono 16kHz Float32Array PCM from Recorder.toMono16k()
 * Output: transcribed string
 */

export interface TranscriptSegment {
  speaker: string;
  userId: string;
  text: string;
}

export class Transcriber {
  /**
   * Transcribe a single speaker's audio.
   * @param mono16k - Float32Array mono 16kHz PCM
   */
  async transcribe(mono16k: Float32Array, timeoutMs = 120_000): Promise<string> {
    if (mono16k.length < 8000) return ""; // < 0.5s — skip (reduces hallucinations on short clips)

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Transcription timed out")), timeoutMs)
    );
    const text = await Promise.race([this.doTranscribe(mono16k), timeout]);
    return filterHallucinations(text);
  }

  private async doTranscribe(mono16k: Float32Array): Promise<string> {

    // --- OpenAI backend ---
    if (process.env.OPENAI_API_KEY) {
      try {
        return await this.transcribeOpenAI(mono16k);
      } catch (e) {
        console.warn("[transcriber] OpenAI failed, falling back:", e);
      }
    }

    // --- Replicate backend ---
    if (process.env.REPLICATE_API_TOKEN) {
      try {
        return await this.transcribeReplicate(mono16k);
      } catch (e) {
        console.warn("[transcriber] Replicate failed:", e);
      }
    }

    // No backends available — skip this utterance rather than OOM with local model
    console.warn("[transcriber] All backends unavailable — skipping utterance");
    return "";
  }

  private async transcribeOpenAI(mono16k: Float32Array): Promise<string> {
    const wavBytes = float32ToWav(mono16k, 16000);
    const blob = new Blob([wavBytes], { type: "audio/wav" });
    const file = new File([blob], "audio.wav", { type: "audio/wav" });

    const fd = new FormData();
    fd.append("file", file);
    fd.append("model", "whisper-1");
    fd.append("language", "en");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: fd,
    });
    if (!res.ok) throw new Error(await res.text());
    const json = (await res.json()) as { text: string };
    return json.text?.trim() ?? "";
  }

  private async transcribeReplicate(mono16k: Float32Array): Promise<string> {
    const wavBytes = float32ToWav(mono16k, 16000);
    const b64 = Buffer.from(wavBytes).toString("base64");
    const dataUri = `data:audio/wav;base64,${b64}`;

    const res = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "3ab86df6c8f54c11309d4d1f930ac292bad43ace52d10c80d87eb258b3c9f79c",
        input: { audio: dataUri, language: "english" },
      }),
    });
    if (!res.ok) throw new Error(await res.text());

    // Poll for result (max 80 attempts = 2 minutes)
    let prediction = (await res.json()) as any;
    let attempts = 0;
    while (["starting", "processing"].includes(prediction.status)) {
      if (++attempts > 80) throw new Error("Replicate prediction timed out after 2 minutes");
      await new Promise((r) => setTimeout(r, 1500));
      const poll = await fetch(prediction.urls.get, {
        headers: { Authorization: `Token ${process.env.REPLICATE_API_TOKEN}` },
      });
      prediction = await poll.json();
    }
    if (prediction.status === "failed" || prediction.status === "canceled") {
      throw new Error(`Replicate prediction ${prediction.status}: ${prediction.error ?? "unknown error"}`);
    }
    return (prediction.output?.text ?? prediction.output?.transcription ?? "").trim();
  }
}

/**
 * Whisper-tiny commonly outputs these strings on silent/noisy/very-short clips.
 * Return empty string for any of these so they don't pollute the transcript.
 */
const HALLUCINATIONS = new Set([
  "thank you.",
  "thanks.",
  "thank you very much.",
  "thanks for watching.",
  "thank you for watching.",
  "thanks for listening.",
  "thank you for listening.",
  "you.",
  "you",
  ".",
  "...",
  "okay.",
  "ok.",
  "hmm.",
  "hm.",
  "uh.",
  "um.",
  "mhm.",
  "[music]",
  "[applause]",
  "[laughter]",
  "[ Silence ]",
  "[silence]",
]);

function filterHallucinations(text: string): string {
  const normalized = text.trim().toLowerCase();
  if (HALLUCINATIONS.has(normalized)) return "";
  return text.trim();
}

/** Encode a Float32Array of mono PCM samples into a 16-bit WAV buffer. */
function float32ToWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const numSamples = samples.length;
  const dataLen = numSamples * 2; // 16-bit = 2 bytes per sample
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);        // subchunk1 size
  view.setUint16(20, 1, true);         // PCM
  view.setUint16(22, 1, true);         // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);         // block align
  view.setUint16(34, 16, true);        // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataLen, true);

  // Convert float → int16
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Uint8Array(buf);
}

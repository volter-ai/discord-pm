/**
 * Transcription service with multiple backends.
 *
 * Priority:
 *   1. OpenAI Whisper API  (if OPENAI_API_KEY set)
 *   2. Replicate Whisper   (if REPLICATE_API_TOKEN set)
 *   3. Local HuggingFace Whisper via @huggingface/transformers (always available)
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
  private pipeline: any = null;

  private async getLocalPipeline() {
    if (this.pipeline) return this.pipeline;
    console.log("[transcriber] Loading local Whisper model (first run downloads ~40MB)…");
    const { pipeline, env } = await import("@huggingface/transformers");
    // Cache models alongside the bot
    env.cacheDir = "./models";
    this.pipeline = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en");
    console.log("[transcriber] Whisper model ready.");
    return this.pipeline;
  }

  /**
   * Transcribe a single speaker's audio.
   * @param mono16k - Float32Array mono 16kHz PCM
   */
  async transcribe(mono16k: Float32Array): Promise<string> {
    if (mono16k.length < 1600) return ""; // < 0.1s — skip

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
        console.warn("[transcriber] Replicate failed, falling back:", e);
      }
    }

    // --- Local Whisper (always available) ---
    return await this.transcribeLocal(mono16k);
  }

  private async transcribeLocal(mono16k: Float32Array): Promise<string> {
    const pipe = await this.getLocalPipeline();
    const result = await pipe(mono16k, { language: "english" });
    return (result as any).text?.trim() ?? "";
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
        input: { audio: dataUri, language: "en" },
      }),
    });
    if (!res.ok) throw new Error(await res.text());

    // Poll for result
    let prediction = (await res.json()) as any;
    while (["starting", "processing"].includes(prediction.status)) {
      await new Promise((r) => setTimeout(r, 1500));
      const poll = await fetch(prediction.urls.get, {
        headers: { Authorization: `Token ${process.env.REPLICATE_API_TOKEN}` },
      });
      prediction = await poll.json();
    }
    return (prediction.output?.text ?? prediction.output?.transcription ?? "").trim();
  }
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

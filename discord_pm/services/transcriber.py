"""Audio transcription using Replicate's Whisper model."""

import array
import io
import logging
import wave

import replicate

log = logging.getLogger(__name__)

# vaibhavs10/incredibly-fast-whisper is faster-whisper based and much quicker
# than openai/whisper for long recordings. Swap to "openai/whisper" if needed.
_WHISPER_MODEL = "vaibhavs10/incredibly-fast-whisper"

# Whisper expects mono 16kHz audio. discord.py records stereo 48kHz.
# Downsampling before upload reduces a 30-min recording from ~460 MB (base64)
# to ~77 MB — well within Replicate's payload limits.
_TARGET_RATE = 16000


def _to_mono_16k(wav_bytes: bytes) -> bytes:
    """Convert a WAV file (any channels/rate) to mono 16kHz WAV."""
    buf_in = io.BytesIO(wav_bytes)
    with wave.open(buf_in) as wf:
        nchannels = wf.getnchannels()
        framerate = wf.getframerate()
        pcm = wf.readframes(wf.getnframes())

    samples: array.array = array.array("h")
    samples.frombytes(pcm)

    # Stereo → mono: average L and R samples
    if nchannels == 2:
        mono: array.array = array.array("h")
        for i in range(0, len(samples) - 1, 2):
            mono.append((samples[i] + samples[i + 1]) // 2)
        samples = mono

    # Downsample by integer factor (48kHz → 16kHz = step of 3)
    step = framerate // _TARGET_RATE
    if step > 1:
        samples = array.array("h", samples[::step])

    buf_out = io.BytesIO()
    with wave.open(buf_out, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(_TARGET_RATE)
        wf.writeframes(samples.tobytes())

    return buf_out.getvalue()


class Transcriber:
    def __init__(self, api_token: str):
        self._client = replicate.Client(api_token=api_token)

    async def transcribe(self, audio_bytes: bytes) -> str:
        """Transcribe audio bytes via Replicate Whisper. Returns the transcript text."""
        import base64

        prepared = _to_mono_16k(audio_bytes)
        mb = len(prepared) / 1_048_576
        log.info("Transcribing %.1f MB of audio (mono 16kHz)", mb)

        b64 = base64.b64encode(prepared).decode("utf-8")
        data_uri = f"data:audio/wav;base64,{b64}"

        output = await self._client.async_run(
            _WHISPER_MODEL,
            input={"audio": data_uri, "language": "en"},
        )

        # incredibly-fast-whisper returns {"text": "...", "segments": [...]}
        # openai/whisper returns {"transcription": "..."}
        if isinstance(output, dict):
            return output.get("text") or output.get("transcription") or ""
        return str(output)

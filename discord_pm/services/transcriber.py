"""Audio transcription using Replicate's Whisper model."""

import base64
import replicate


# vaibhavs10/incredibly-fast-whisper is faster-whisper based and much quicker
# than openai/whisper for long recordings. Swap to "openai/whisper" if needed.
_WHISPER_MODEL = "vaibhavs10/incredibly-fast-whisper"


class Transcriber:
    def __init__(self, api_token: str):
        self._client = replicate.Client(api_token=api_token)

    async def transcribe(self, audio_bytes: bytes, filename: str = "recording.wav") -> str:
        """Transcribe audio bytes via Replicate Whisper. Returns the transcript text."""
        # Replicate accepts a base64 data URI for binary inputs
        b64 = base64.b64encode(audio_bytes).decode("utf-8")
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

"""Audio transcription using OpenAI Whisper."""

import io
from openai import AsyncOpenAI


class Transcriber:
    def __init__(self, api_key: str):
        self._client = AsyncOpenAI(api_key=api_key)

    async def transcribe(self, audio_bytes: bytes, filename: str = "recording.wav") -> str:
        """Transcribe audio bytes using Whisper. Returns the transcript text."""
        audio_file = io.BytesIO(audio_bytes)
        audio_file.name = filename

        response = await self._client.audio.transcriptions.create(
            model="whisper-1",
            file=audio_file,
            response_format="text",
        )
        return response

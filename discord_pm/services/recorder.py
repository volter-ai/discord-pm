"""Voice channel recording using discord.py's built-in sink."""

import asyncio
import io
import wave
from datetime import datetime, UTC
from pathlib import Path

import discord
from discord.sinks import WaveSink


class RecordingSession:
    """Tracks state for a single standup recording."""

    def __init__(self, guild_id: int, channel_id: int):
        self.guild_id = guild_id
        self.channel_id = channel_id
        self.started_at = datetime.now(UTC)
        self.ended_at: datetime | None = None
        self.sink: WaveSink | None = None
        self.voice_client: discord.VoiceClient | None = None

    @property
    def is_active(self) -> bool:
        return self.voice_client is not None and self.voice_client.is_connected()


class Recorder:
    """Manages recording sessions across guilds."""

    def __init__(self):
        self._sessions: dict[int, RecordingSession] = {}  # guild_id -> session

    def get_session(self, guild_id: int) -> RecordingSession | None:
        return self._sessions.get(guild_id)

    async def start(
        self,
        voice_channel: discord.VoiceChannel,
        max_duration: int = 3600,
    ) -> RecordingSession:
        guild_id = voice_channel.guild.id
        if guild_id in self._sessions:
            raise RuntimeError("A recording is already active in this server.")

        vc = await voice_channel.connect()
        session = RecordingSession(guild_id=guild_id, channel_id=voice_channel.id)
        session.voice_client = vc
        session.sink = WaveSink()

        self._sessions[guild_id] = session

        vc.start_recording(
            session.sink,
            self._on_recording_complete,
            session,
        )

        # Auto-stop after max_duration
        asyncio.get_event_loop().call_later(max_duration, lambda: asyncio.ensure_future(self.stop(guild_id)))

        return session

    async def stop(self, guild_id: int) -> RecordingSession:
        session = self._sessions.pop(guild_id, None)
        if session is None:
            raise RuntimeError("No active recording found for this server.")

        if session.voice_client and session.voice_client.is_recording():
            session.voice_client.stop_recording()

        if session.voice_client and session.voice_client.is_connected():
            await session.voice_client.disconnect()

        session.ended_at = datetime.now(UTC)
        return session

    @staticmethod
    def _on_recording_complete(sink: WaveSink, session: RecordingSession, *args):
        """Called by discord.py when recording finishes."""
        pass  # Audio is available on sink.audio_data

    @staticmethod
    def merge_audio(sink: WaveSink) -> bytes:
        """Merge all per-user WAV audio into a single mono WAV file."""
        if not sink.audio_data:
            return b""

        # Collect all PCM frames from each speaker
        all_frames: list[bytes] = []
        for user_id, audio in sink.audio_data.items():
            audio.file.seek(0)
            with wave.open(audio.file) as wf:
                all_frames.append(wf.readframes(wf.getnframes()))

        # Simple mix: concatenate (real mixing would interleave by timestamp)
        # For transcription purposes, sequential is good enough to start
        combined = b"".join(all_frames)

        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(2)
            wf.setsampwidth(2)
            wf.setframerate(48000)
            wf.writeframes(combined)

        return buf.getvalue()

"""Voice channel recording using discord.py's built-in sink."""

import array
import asyncio
import io
import struct
import wave
from datetime import datetime, UTC

import discord
from discord.sinks import WaveSink

# discord.py records stereo 48kHz 16-bit PCM
_CHANNELS = 2
_SAMPLE_WIDTH = 2  # bytes (16-bit)
_FRAME_RATE = 48000


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

        loop = asyncio.get_running_loop()
        loop.call_later(max_duration, lambda: asyncio.ensure_future(self.stop(guild_id)))

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
        """Mix all per-user WAV tracks into a single stereo WAV by summing PCM samples.

        discord.py records each speaker independently, time-aligned from the start of
        the session (silence-padded for gaps). Summing samples preserves the natural
        back-and-forth of the conversation, which is essential for accurate transcription.
        """
        if not sink.audio_data:
            return b""

        # Decode each speaker's WAV into a signed-short array
        tracks: list[array.array] = []
        for audio in sink.audio_data.values():
            audio.file.seek(0)
            with wave.open(audio.file) as wf:
                pcm = wf.readframes(wf.getnframes())
            samples: array.array = array.array("h")
            samples.frombytes(pcm)
            tracks.append(samples)

        if not tracks:
            return b""

        # Pad shorter tracks with silence so all are the same length
        max_len = max(len(t) for t in tracks)
        for t in tracks:
            if len(t) < max_len:
                t.extend(array.array("h", [0] * (max_len - len(t))))

        # Sum samples across all speakers, clamping to 16-bit range
        mixed = array.array("h", [0] * max_len)
        for t in tracks:
            for i in range(max_len):
                mixed[i] = max(-32768, min(32767, mixed[i] + t[i]))

        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(_CHANNELS)
            wf.setsampwidth(_SAMPLE_WIDTH)
            wf.setframerate(_FRAME_RATE)
            wf.writeframes(mixed.tobytes())

        return buf.getvalue()

"""Standup slash commands cog."""

from datetime import datetime, UTC

import discord
from discord import app_commands
from discord.ext import commands

from ..config import settings
from ..models.standup import StandupSummary
from ..services import Recorder, Transcriber, Summarizer
from ..services.store import StandupStore


class StandupCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.recorder = Recorder()
        self.transcriber = Transcriber(api_token=settings.replicate_api_token)
        self.summarizer = Summarizer(api_key=settings.anthropic_api_key)
        # Reuse the store initialised on the bot if available, else own instance
        self.store: StandupStore = getattr(bot, "store", StandupStore())

    standup = app_commands.Group(name="standup", description="Standup meeting commands")

    @standup.command(name="start", description="Join your voice channel and start recording the standup")
    async def standup_start(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=False)

        if not isinstance(interaction.user, discord.Member) or interaction.user.voice is None:
            await interaction.followup.send("You must be in a voice channel to start a standup.")
            return

        voice_channel = interaction.user.voice.channel
        assert voice_channel is not None

        try:
            await self.recorder.start(
                voice_channel,
                max_duration=settings.recording_max_duration_seconds,
            )
        except RuntimeError as e:
            await interaction.followup.send(f"Could not start recording: {e}")
            return

        await interaction.followup.send(
            f"Recording standup in **{voice_channel.name}**. Use `/standup stop` when done."
        )

    @standup.command(name="stop", description="Stop recording, transcribe, and post a summary")
    async def standup_stop(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=False)

        guild_id = interaction.guild_id
        if guild_id is None:
            await interaction.followup.send("This command must be used in a server.")
            return

        try:
            session = await self.recorder.stop(guild_id)
        except RuntimeError as e:
            await interaction.followup.send(f"Could not stop recording: {e}")
            return

        await interaction.followup.send("Recording stopped. Transcribing...")

        if session.sink is None or not session.sink.audio_data:
            await interaction.followup.send("No audio was captured.")
            return

        from ..services.recorder import Recorder as R
        audio_bytes = R.merge_audio(session.sink)

        if not audio_bytes:
            await interaction.followup.send("No audio was captured.")
            return

        transcript = await self.transcriber.transcribe(audio_bytes)
        await interaction.followup.send("Transcription complete. Summarizing...")

        participants, summary_text = await self.summarizer.summarize(transcript)

        standup = StandupSummary(
            guild_id=guild_id,
            channel_id=session.channel_id,
            started_at=session.started_at,
            ended_at=session.ended_at or datetime.now(UTC),
            participants=participants,
            raw_transcript=transcript,
            summary_text=summary_text,
        )

        record_id = await self.store.save(standup)
        await self._post_summary(interaction, standup, record_id)

    @standup.command(name="status", description="Show whether a standup is currently being recorded")
    async def standup_status(self, interaction: discord.Interaction):
        guild_id = interaction.guild_id
        session = self.recorder.get_session(guild_id) if guild_id else None
        if session and session.is_active:
            elapsed = (datetime.now(UTC) - session.started_at).seconds
            minutes, seconds = divmod(elapsed, 60)
            await interaction.response.send_message(
                f"Recording in progress — {minutes}m {seconds}s elapsed.", ephemeral=True
            )
        else:
            await interaction.response.send_message("No standup recording in progress.", ephemeral=True)

    @standup.command(name="history", description="Show recent standup summaries for this server")
    @app_commands.describe(count="Number of recent standups to show (default 5, max 10)")
    async def standup_history(self, interaction: discord.Interaction, count: int = 5):
        guild_id = interaction.guild_id
        if guild_id is None:
            await interaction.response.send_message("This command must be used in a server.", ephemeral=True)
            return

        count = max(1, min(count, 10))
        summaries = await self.store.recent(guild_id, limit=count)

        if not summaries:
            await interaction.response.send_message("No standup records found for this server.", ephemeral=True)
            return

        embed = discord.Embed(
            title=f"Last {len(summaries)} Standup(s)",
            color=discord.Color.blurple(),
        )
        for s in summaries:
            date_str = s.started_at.strftime("%Y-%m-%d %H:%M UTC")
            names = ", ".join(p.name for p in s.participants) or "unknown"
            blockers = [b for p in s.participants for b in p.blockers]
            blocker_line = f"\n⚠️ Blockers: {', '.join(blockers)}" if blockers else ""
            embed.add_field(
                name=date_str,
                value=f"{s.summary_text[:200]}{'...' if len(s.summary_text) > 200 else ''}"
                      f"\n👥 {names}{blocker_line}",
                inline=False,
            )

        await interaction.response.send_message(embed=embed, ephemeral=True)

    async def _post_summary(
        self, interaction: discord.Interaction, standup: StandupSummary, record_id: int
    ):
        embed = discord.Embed(
            title="Standup Summary",
            description=standup.summary_text,
            color=discord.Color.green(),
            timestamp=standup.ended_at,
        )

        for p in standup.participants:
            value_lines = []
            if p.did:
                value_lines.append("**Did:**\n" + "\n".join(f"• {item}" for item in p.did))
            if p.will_do:
                value_lines.append("**Will do:**\n" + "\n".join(f"• {item}" for item in p.will_do))
            if p.blockers:
                value_lines.append("**Blockers:**\n" + "\n".join(f"• {item}" for item in p.blockers))
            embed.add_field(name=p.name, value="\n".join(value_lines) or "No updates", inline=False)

        duration = standup.ended_at - standup.started_at
        embed.set_footer(
            text=f"Duration: {int(duration.total_seconds() // 60)}m "
                 f"{int(duration.total_seconds() % 60)}s  •  Record #{record_id}"
        )

        target_channel = interaction.channel
        if settings.summary_channel_id:
            target_channel = interaction.guild.get_channel(settings.summary_channel_id)  # type: ignore[union-attr]

        if target_channel and isinstance(target_channel, discord.TextChannel):
            await target_channel.send(embed=embed)
        else:
            await interaction.followup.send(embed=embed)


async def setup(bot: commands.Bot):
    await bot.add_cog(StandupCog(bot))

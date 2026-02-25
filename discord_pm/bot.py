"""Bot setup and cog loading."""

import logging

import discord
from discord.ext import commands

log = logging.getLogger(__name__)

COGS = [
    "discord_pm.cogs.standup",
]


class PMBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.voice_states = True
        intents.message_content = True
        super().__init__(command_prefix="!", intents=intents)

    async def setup_hook(self):
        for cog in COGS:
            await self.load_extension(cog)
            log.info("Loaded cog: %s", cog)

        await self.tree.sync()
        log.info("Slash commands synced.")

    async def on_ready(self):
        log.info("Logged in as %s (id=%s)", self.user, self.user.id if self.user else "?")

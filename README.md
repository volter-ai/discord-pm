# discord-pm

A Discord bot for project management, starting with standup meeting recording, transcription, and summarization.

## Features

### Current
- **Standup Recording** — Join a voice channel, record the standup, and produce a transcript + summary
- **Transcription** — Uses OpenAI Whisper to convert audio to text
- **Summarization** — Uses an LLM to produce structured standup summaries (what did, what will do, blockers)

### Planned
- Action item extraction and tracking
- Sprint/milestone progress tracking
- Daily digest posting to a designated channel
- Integration with GitHub issues/PRs for context-aware summaries

## Requirements

- Python 3.11+
- A Discord bot token with the following permissions:
  - `GUILD_VOICE_STATES` — to join voice channels
  - `MESSAGE_CONTENT` — to read commands
  - `SEND_MESSAGES`, `EMBED_LINKS` — to post summaries
- An OpenAI API key (for Whisper transcription and GPT summarization)

## Setup

```bash
# Install dependencies
pip install -e ".[dev]"

# Copy and fill in environment variables
cp .env.example .env

# Run the bot
python -m discord_pm
```

## Configuration

Copy `.env.example` to `.env` and fill in the values:

```
DISCORD_TOKEN=your-discord-bot-token
OPENAI_API_KEY=your-openai-api-key
STANDUP_CHANNEL_ID=optional-default-channel-id
SUMMARY_CHANNEL_ID=optional-channel-to-post-summaries
```

## Usage

| Command | Description |
|---------|-------------|
| `/standup start` | Bot joins your voice channel and starts recording |
| `/standup stop` | Stops recording, transcribes, and posts a summary |
| `/standup status` | Shows current recording status |

## Architecture

```
discord_pm/
├── __main__.py          # Entry point
├── bot.py               # Bot setup and cog loading
├── cogs/
│   ├── standup.py       # Standup recording slash commands
│   └── ...              # Future cogs
├── services/
│   ├── recorder.py      # Voice channel recording
│   ├── transcriber.py   # Whisper transcription
│   └── summarizer.py    # LLM summarization
└── models/
    └── standup.py       # Data models for standup records
```

## Contributing

This project is under active development. Open issues or PRs — all welcome.

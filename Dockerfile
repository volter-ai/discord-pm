FROM python:3.12-slim

# System deps for discord.py voice (libopus) and audio processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    libopus0 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so this layer is cached when only source changes
COPY pyproject.toml ./
RUN pip install --no-cache-dir \
    "discord.py[voice]>=2.4" \
    "replicate>=0.34" \
    "anthropic>=0.40" \
    "aiosqlite>=0.20" \
    "pydantic>=2.0" \
    "pydantic-settings>=2.0" \
    "aiofiles>=23.0"

COPY discord_pm ./discord_pm

# Data directory for SQLite DB — mount a volume here to persist across restarts
RUN mkdir -p /app/data
VOLUME ["/app/data"]

CMD ["python", "-m", "discord_pm"]

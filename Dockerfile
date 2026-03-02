FROM oven/bun:1.3.10-debian

# System deps for @discordjs/voice (libopus) and opusscript
RUN apt-get update && apt-get install -y --no-install-recommends \
    libopus0 \
    libopus-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (cached layer)
COPY package.json bun.lock* ./
RUN bun install

# Copy source
COPY src ./src
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Data dir for SQLite — mount a volume here
RUN mkdir -p /app/data

EXPOSE 8080

CMD ["./entrypoint.sh"]

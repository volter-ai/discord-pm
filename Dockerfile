FROM oven/bun:1-debian

# System deps:
#   libopus0/libopus-dev — required by @discordjs/voice for Opus encoding
#   python3 make g++     — required for native addon compilation (onnxruntime-node)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libopus0 libopus-dev python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps before copying source so this layer is cached on source-only changes
COPY package.json ./
RUN bun install

COPY src ./src
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Persistent directories — mount a Fly volume at /app/data
RUN mkdir -p /app/data /app/transcripts /app/models

CMD ["./entrypoint.sh"]

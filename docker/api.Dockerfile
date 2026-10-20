# API + воркери: Node 24 і повна збірка FFmpeg (з libass — знадобиться для рендеру субтитрів).
# Сирці не копіюються — репозиторій монтується в /app (див. docker-compose.yml).
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
ENV PNPM_STORE_DIR=/pnpm-store \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app
ENTRYPOINT ["/app/docker/api-entrypoint.sh"]
CMD ["pnpm", "--filter", "@vf/api", "dev"]

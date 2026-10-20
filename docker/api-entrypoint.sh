#!/bin/sh
# Запускається в контейнері api: ставить залежності (лише якщо змінився lockfile),
# застосовує міграції й виконує команду сервісу.
set -e
cd /app

if [ -z "$SKIP_INSTALL" ]; then
  mkdir -p node_modules
  # flock: dev-API і `docker compose run api pnpm test` можуть стартувати одночасно на тих самих томах
  flock node_modules/.vf-install.lock sh -c '
    hash=$(sha1sum pnpm-lock.yaml | cut -d" " -f1)
    if [ "$(cat node_modules/.vf-lock-hash 2>/dev/null)" != "$hash" ]; then
      echo "[entrypoint] pnpm install…"
      pnpm install --frozen-lockfile --config.confirmModulesPurge=false
      echo "$hash" > node_modules/.vf-lock-hash
    fi
  '
fi

pnpm --silent db:migrate
exec "$@"

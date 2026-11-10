# Railway independent Telegram QA - force fresh Docker build
# Railway QA runtime gate enabled
FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY telegram-info/package*.json ./telegram-info/
RUN npm --prefix telegram-info install --ignore-scripts --no-audit --no-fund --package-lock=false

COPY telegram-control/package*.json ./telegram-control/
RUN npm --prefix telegram-control install --ignore-scripts --no-audit --no-fund --package-lock=false

COPY . .

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "ops/telegram-qa-render/server.mjs"]
